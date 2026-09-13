import { config } from '../config.js';
import { AppError, AuthExpiredError, NotConfiguredError, ThrottledError } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import { RateLimiter } from '../core/ratelimit.js';
import type { ProfileDetails, RemoteAccount } from '../core/types.js';
import { loadSession, type IgSession } from '../session/store.js';
import type { FollowingPage, Provider, ProviderCapabilities } from './provider.js';

const log = createLogger('web');

const ORIGIN = config.igBaseUrl;
/** The public web app's own client id. Sent by instagram.com on every XHR. */
const IG_APP_ID = '936619743392459';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';
const PAGE_SIZE = 50;

interface IgUser {
  pk?: string | number;
  id?: string | number;
  username?: string;
  full_name?: string;
  profile_pic_url?: string;
  is_private?: boolean;
  is_verified?: boolean;
}

interface FriendshipsResponse {
  users?: IgUser[];
  next_max_id?: string | number | null;
  big_list?: boolean;
  status?: string;
  message?: string;
}

/**
 * Talks to the same private endpoints instagram.com's own web client uses,
 * authenticated with cookies from a session the user established themselves.
 *
 * This is not a supported API. It can change without notice, it is against
 * Instagram's Terms of Use, and every call counts against invisible limits -
 * hence the conservative pacing here and in docs/LIMITS.md.
 */
export class WebProvider implements Provider {
  readonly name = 'web';
  readonly capabilities: ProviderCapabilities = {
    liveSync: true,
    enrich: true,
    followers: true,
    unfollow: true,
    followedAt: false,
  };

  private session: IgSession | null = null;

  constructor(private readonly reads: RateLimiter) {}

  /** Re-read cookies from disk; called after a login refreshes them. */
  refresh(): void {
    this.session = null;
  }

  private requireSession(): IgSession {
    if (!this.session) this.session = loadSession();
    if (!this.session) {
      throw new NotConfiguredError(
        'No Instagram session stored. Run `npm run login` or paste cookies in Settings.',
      );
    }
    return this.session;
  }

  async ensureReady(): Promise<void> {
    this.requireSession();
  }

  async whoami(): Promise<{ pk: string; username: string } | null> {
    const session = this.requireSession();
    const data = await this.request<{ user?: IgUser }>(`/api/v1/users/${session.dsUserId}/info/`);
    const user = data.user;
    if (!user?.username) return { pk: session.dsUserId, username: '' };
    return { pk: session.dsUserId, username: user.username };
  }

  async listFollowing(cursor: string | null): Promise<FollowingPage> {
    return this.listFriendships('following', cursor);
  }

  async listFollowers(cursor: string | null): Promise<FollowingPage> {
    return this.listFriendships('followers', cursor);
  }

  private async listFriendships(kind: 'following' | 'followers', cursor: string | null): Promise<FollowingPage> {
    const session = this.requireSession();
    const params = new URLSearchParams({ count: String(PAGE_SIZE) });
    if (cursor) params.set('max_id', cursor);
    const data = await this.request<FriendshipsResponse>(
      `/api/v1/friendships/${session.dsUserId}/${kind}/?${params.toString()}`,
    );

    const accounts: RemoteAccount[] = [];
    for (const user of data.users ?? []) {
      const pk = user.pk ?? user.id;
      if (pk === undefined || !user.username) continue;
      accounts.push({
        pk: String(pk),
        username: user.username,
        fullName: user.full_name?.trim() || null,
        profilePicUrl: user.profile_pic_url ?? null,
        isPrivate: Boolean(user.is_private),
        isVerified: Boolean(user.is_verified),
      });
    }

    const next = data.next_max_id;
    return {
      accounts,
      cursor: next === null || next === undefined || next === '' ? null : String(next),
    };
  }

  async getProfile(username: string): Promise<ProfileDetails> {
    const data = await this.request<{
      data?: {
        user?: {
          full_name?: string;
          profile_pic_url?: string;
          edge_followed_by?: { count?: number };
          edge_follow?: { count?: number };
        };
      };
    }>(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`);

    const user = data.data?.user;
    return {
      followerCount: user?.edge_followed_by?.count ?? null,
      followingCount: user?.edge_follow?.count ?? null,
      fullName: user?.full_name?.trim() || null,
      profilePicUrl: user?.profile_pic_url ?? null,
    };
  }

  async unfollow(pk: string, username: string): Promise<void> {
    const data = await this.request<{ status?: string; friendship_status?: { following?: boolean } }>(
      `/api/v1/friendships/destroy/${encodeURIComponent(pk)}/`,
      { method: 'POST', body: new URLSearchParams({ user_id: pk }).toString() },
    );
    if (data.status && data.status !== 'ok') {
      throw new AppError(`Instagram refused the unfollow for @${username}: ${data.status}`, 502, 'upstream');
    }
    if (data.friendship_status?.following === true) {
      throw new AppError(`Instagram still reports you as following @${username}.`, 502, 'upstream');
    }
    log.info(`unfollowed @${username} (${pk})`);
  }

  async fetchAvatar(url: string): Promise<{ body: Buffer; contentType: string }> {
    const parsed = new URL(url);
    // Only ever proxy Instagram's own CDN: this endpoint takes a URL from the
    // database and would otherwise be a server-side request forgery gadget.
    if (!/(^|\.)(cdninstagram\.com|fbcdn\.net)$/.test(parsed.hostname)) {
      throw new AppError('Refusing to proxy a non-Instagram avatar host.', 400, 'bad_host');
    }
    const res = await fetch(parsed.toString(), {
      headers: { 'User-Agent': USER_AGENT, Referer: `${ORIGIN}/` },
    });
    if (!res.ok) throw new AppError(`Avatar fetch failed with ${res.status}`, 502, 'upstream');
    const contentType = res.headers.get('content-type') ?? 'image/jpeg';
    if (!contentType.startsWith('image/')) throw new AppError('Avatar host returned a non-image.', 502, 'upstream');
    return { body: Buffer.from(await res.arrayBuffer()), contentType };
  }

  // --- transport ----------------------------------------------------------

  private async request<T>(pathname: string, init: { method?: string; body?: string } = {}): Promise<T> {
    const session = this.requireSession();
    await this.reads.acquire();

    const method = init.method ?? 'GET';
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      'X-IG-App-ID': IG_APP_ID,
      'X-Requested-With': 'XMLHttpRequest',
      'X-CSRFToken': session.csrftoken,
      Referer: `${ORIGIN}/`,
      Origin: ORIGIN,
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: cookieHeader(session),
    };
    if (init.body !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded';

    let res: Response;
    try {
      res = await fetch(`${ORIGIN}${pathname}`, { method, headers, body: init.body, redirect: 'manual' });
    } catch (err) {
      throw new AppError(`Network error talking to Instagram: ${(err as Error).message}`, 502, 'network');
    }

    const text = await res.text();
    this.assertHealthy(res, text);

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AppError(
        'Instagram returned a non-JSON response (usually a login wall or a challenge page).',
        502,
        'upstream',
      );
    }
  }

  /**
   * Map Instagram's responses onto the two outcomes that matter: "your session
   * is dead" and "stop making requests right now". Everything else is a plain
   * upstream error.
   */
  private assertHealthy(res: Response, body: string): void {
    const lower = body.slice(0, 2000).toLowerCase();

    if (lower.includes('checkpoint_required') || lower.includes('challenge_required')) {
      const err = new ThrottledError(
        'Instagram raised a checkpoint. Open instagram.com in a browser, clear the challenge, ' +
          'then log in again. Do not retry automatically.',
        6 * 3600 * 1000,
        true,
      );
      this.reads.cooldown(err.retryAfterMs!, 'checkpoint');
      throw err;
    }

    if (res.status === 429 || lower.includes('please wait a few minutes')) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 15 * 60 * 1000;
      this.reads.cooldown(waitMs, 'instagram returned 429');
      throw new ThrottledError('Instagram rate-limited this session. Backing off.', waitMs);
    }

    if (res.status === 401 || lower.includes('login_required')) {
      throw new AuthExpiredError();
    }

    if (res.status === 302 || res.status === 301) {
      throw new AuthExpiredError('Instagram redirected to the login page; the session cookie is no longer valid.');
    }

    if (res.status === 403) {
      throw new AuthExpiredError(
        'Instagram returned 403. The CSRF token or session cookie is stale - log in again.',
      );
    }

    if (!res.ok) {
      throw new AppError(`Instagram returned HTTP ${res.status}.`, 502, 'upstream');
    }
  }
}

function cookieHeader(session: IgSession): string {
  const parts = [`sessionid=${session.sessionid}`, `ds_user_id=${session.dsUserId}`];
  if (session.csrftoken) parts.push(`csrftoken=${session.csrftoken}`);
  return parts.join('; ');
}

export { IG_APP_ID, ORIGIN, USER_AGENT };
