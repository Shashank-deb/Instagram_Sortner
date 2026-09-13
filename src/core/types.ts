/** An account you follow, as stored locally. */
export interface Account {
  /** Instagram's numeric user id ("pk"), as a string. Stable across renames. */
  pk: string;
  username: string;
  fullName: string | null;
  profilePicUrl: string | null;
  isPrivate: boolean;
  isVerified: boolean;
  /** Null until the row has been enriched; the list endpoint does not return counts. */
  followerCount: number | null;
  followingCount: number | null;
  /** Do they follow you back? Null when unknown (needs a followers sync). */
  followsBack: boolean | null;
  /**
   * When you followed them, epoch seconds. Only the data-export archive knows
   * this; live syncing cannot recover it. Null means "unknown".
   */
  followedAt: number | null;
  /** First/last time this account appeared in a local sync, epoch seconds. */
  firstSeenAt: number;
  lastSeenAt: number;
  enrichedAt: number | null;
  status: AccountStatus;
}

export type AccountStatus =
  /** Currently in your following list. */
  | 'following'
  /** Unfollowed through this app. */
  | 'unfollowed'
  /** Disappeared from your following list without us doing it (they blocked you,
   *  deactivated, or you unfollowed elsewhere). */
  | 'gone';

/** A row as returned by a provider's listFollowing(). */
export interface RemoteAccount {
  pk: string;
  username: string;
  fullName: string | null;
  profilePicUrl: string | null;
  isPrivate: boolean;
  isVerified: boolean;
  followedAt?: number | null;
  followerCount?: number | null;
  followingCount?: number | null;
}

export interface ProfileDetails {
  followerCount: number | null;
  followingCount: number | null;
  fullName: string | null;
  profilePicUrl: string | null;
}

export type ActionStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled';

export interface UnfollowAction {
  id: number;
  accountPk: string;
  username: string;
  status: ActionStatus;
  requestedAt: number;
  executedAt: number | null;
  attempts: number;
  error: string | null;
  /** True when this action was simulated and never sent to Instagram. */
  dryRun: boolean;
}

export interface SyncRun {
  id: number;
  source: string;
  startedAt: number;
  finishedAt: number | null;
  ok: boolean | null;
  added: number;
  updated: number;
  removed: number;
  error: string | null;
}
