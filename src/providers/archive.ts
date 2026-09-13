import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';
import { AppError, ProviderUnsupportedError } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import type { RemoteAccount } from '../core/types.js';
import type { FollowingPage, Provider, ProviderCapabilities } from './provider.js';

const log = createLogger('archive');

/**
 * Reads the official "Download your information" export.
 *
 * This is the only source that knows *when* you followed someone, and the only
 * one that touches no Instagram servers at all - so it is the default. It is a
 * point-in-time snapshot: re-export to refresh, and it can never unfollow.
 */
export class ArchiveProvider implements Provider {
  readonly name = 'archive';
  readonly capabilities: ProviderCapabilities = {
    liveSync: false,
    enrich: false,
    followers: true,
    unfollow: false,
    followedAt: true,
  };

  private pending: RemoteAccount[] | null = null;
  private pendingFollowers: RemoteAccount[] | null = null;

  async ensureReady(): Promise<void> {
    if (!this.pending) {
      throw new AppError(
        'No archive loaded. Upload your Instagram data export (.zip or following.json) first.',
        409,
        'not_configured',
      );
    }
  }

  async whoami() {
    return null;
  }

  async listFollowing(cursor: string | null): Promise<FollowingPage> {
    await this.ensureReady();
    if (cursor) return { accounts: [], cursor: null };
    return { accounts: this.pending!, cursor: null };
  }

  async listFollowers(cursor: string | null): Promise<FollowingPage> {
    if (!this.pendingFollowers) return { accounts: [], cursor: null };
    if (cursor) return { accounts: [], cursor: null };
    return { accounts: this.pendingFollowers, cursor: null };
  }

  async unfollow(): Promise<void> {
    throw new ProviderUnsupportedError('unfollow accounts', this.name);
  }

  /** Load an export from a file path (.zip or .json) or from raw bytes. */
  load(input: string | Buffer, filename?: string): { following: number; followers: number } {
    const buffer = typeof input === 'string' ? fs.readFileSync(input) : input;
    const name = filename ?? (typeof input === 'string' ? path.basename(input) : 'upload');

    const isZip = buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
    const { following, followers } = isZip ? readZip(buffer) : readLooseJson(buffer, name);

    if (following.length === 0) {
      throw new AppError(
        'No following list found in that file. Expected the export\'s ' +
          '"connections/followers_and_following/following.json" (or the whole .zip).',
        422,
        'unparseable',
      );
    }

    this.pending = following;
    this.pendingFollowers = followers;
    log.info(`loaded ${following.length} following / ${followers.length} followers from ${name}`);
    return { following: following.length, followers: followers.length };
  }

  get loaded(): boolean {
    return this.pending !== null;
  }
}

function readZip(buffer: Buffer): { following: RemoteAccount[]; followers: RemoteAccount[] } {
  const zip = new AdmZip(buffer);
  const following: RemoteAccount[] = [];
  const followers: RemoteAccount[] = [];

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const lower = entry.entryName.toLowerCase();
    if (!lower.endsWith('.json') && !lower.endsWith('.html')) continue;
    if (!lower.includes('follow')) continue;
    // The export splits large follower lists across followers_1.json, _2.json, ...
    const isFollowing = /following(_\d+)?\.(json|html)$/.test(lower);
    const isFollowers = /followers(_\d+)?\.(json|html)$/.test(lower);
    if (!isFollowing && !isFollowers) continue;

    const text = entry.getData().toString('utf8');
    const parsed = lower.endsWith('.json') ? parseJsonConnections(text) : parseHtmlConnections(text);
    (isFollowing ? following : followers).push(...parsed);
  }

  return { following: dedupe(following), followers: dedupe(followers) };
}

function readLooseJson(buffer: Buffer, name: string): { following: RemoteAccount[]; followers: RemoteAccount[] } {
  const text = buffer.toString('utf8');
  const parsed = name.toLowerCase().endsWith('.html') ? parseHtmlConnections(text) : parseJsonConnections(text);
  const isFollowers = /followers/i.test(name);
  return isFollowers
    ? { following: [], followers: dedupe(parsed) }
    : { following: dedupe(parsed), followers: [] };
}

interface StringListItem {
  href?: string;
  value?: string;
  timestamp?: number;
}

interface ConnectionEntry {
  title?: string;
  string_list_data?: StringListItem[];
}

/**
 * The export has shipped in two shapes over the years: a bare array of entries
 * (following.json) and an object wrapping one (`relationships_following`).
 * Handle both rather than guessing which vintage the user downloaded.
 */
function parseJsonConnections(text: string): RemoteAccount[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }

  let entries: ConnectionEntry[] = [];
  if (Array.isArray(data)) {
    entries = data as ConnectionEntry[];
  } else if (data && typeof data === 'object') {
    for (const value of Object.values(data as Record<string, unknown>)) {
      if (Array.isArray(value)) entries = entries.concat(value as ConnectionEntry[]);
    }
  }

  const out: RemoteAccount[] = [];
  for (const entry of entries) {
    const item = entry?.string_list_data?.[0];
    const username = (item?.value ?? entry?.title ?? '').trim() || usernameFromHref(item?.href);
    if (!username) continue;
    out.push({
      // The export carries no numeric id, so the username is the stable key here.
      // A later live sync upgrades these rows by matching on username.
      pk: `username:${username.toLowerCase()}`,
      username,
      fullName: null,
      profilePicUrl: null,
      isPrivate: false,
      isVerified: false,
      followedAt: typeof item?.timestamp === 'number' && item.timestamp > 0 ? item.timestamp : null,
    });
  }
  return out;
}

/** Older exports (and the "HTML" format option) only give anchors. */
function parseHtmlConnections(text: string): RemoteAccount[] {
  const out: RemoteAccount[] = [];
  const re = /href="https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]+)\/?"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const username = match[1]!;
    out.push({
      pk: `username:${username.toLowerCase()}`,
      username,
      fullName: null,
      profilePicUrl: null,
      isPrivate: false,
      isVerified: false,
      followedAt: null,
    });
  }
  return out;
}

function usernameFromHref(href: string | undefined): string {
  if (!href) return '';
  const m = /instagram\.com\/([A-Za-z0-9._]+)/.exec(href);
  return m?.[1] ?? '';
}

function dedupe(accounts: RemoteAccount[]): RemoteAccount[] {
  const seen = new Map<string, RemoteAccount>();
  for (const a of accounts) {
    const existing = seen.get(a.pk);
    if (!existing) seen.set(a.pk, a);
    else if (a.followedAt && !existing.followedAt) seen.set(a.pk, a);
  }
  return [...seen.values()];
}
