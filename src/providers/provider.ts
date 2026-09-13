import type { ProfileDetails, RemoteAccount } from '../core/types.js';

export interface ProviderCapabilities {
  /** Can refresh the following list on demand. */
  liveSync: boolean;
  /** Can fetch follower/following counts per account. */
  enrich: boolean;
  /** Can tell whether each account follows you back. */
  followers: boolean;
  /** Can actually unfollow. */
  unfollow: boolean;
  /** Knows the date you followed each account. */
  followedAt: boolean;
}

export interface FollowingPage {
  accounts: RemoteAccount[];
  cursor: string | null;
}

export interface Provider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  /** Throws NotConfiguredError / AuthExpiredError when the provider cannot run. */
  ensureReady(): Promise<void>;

  /** The signed-in account, when the provider knows it. */
  whoami(): Promise<{ pk: string; username: string } | null>;

  listFollowing(cursor: string | null): Promise<FollowingPage>;

  listFollowers?(cursor: string | null): Promise<FollowingPage>;

  getProfile?(username: string): Promise<ProfileDetails>;

  unfollow?(pk: string, username: string): Promise<void>;

  /** Raw bytes of an avatar, proxied so the CDN never sees the browser. */
  fetchAvatar?(url: string): Promise<{ body: Buffer; contentType: string }>;
}
