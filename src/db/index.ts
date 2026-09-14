import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { createLogger } from '../core/logger.js';
import type { Account, AccountStatus, RemoteAccount, SyncRun, UnfollowAction } from '../core/types.js';

const log = createLogger('db');
const here = path.dirname(fileURLToPath(import.meta.url));

function readSchema(): string {
  // Works both from src (tsx) and dist (tsc output copies the .sql next to it).
  for (const candidate of [path.join(here, 'schema.sql'), path.join(here, '..', '..', 'src', 'db', 'schema.sql')]) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8');
  }
  throw new Error('schema.sql not found');
}

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(readSchema());
migrate();

// The database holds live session cookies. Keep it owner-readable only.
try {
  fs.chmodSync(config.dbPath, 0o600);
} catch (err) {
  log.warn(`could not chmod 600 the database file: ${(err as Error).message}`);
}

/** Additive migrations for databases created by an earlier version. */
function migrate(): void {
  const columnsOf = (table: string) =>
    db
      .prepare<[string], { name: string }>('SELECT name FROM pragma_table_info(?)')
      .all(table)
      .map((row) => row.name);

  if (!columnsOf('accounts').includes('last_seen_run')) {
    log.info('migrating: adding accounts.last_seen_run');
    db.exec('ALTER TABLE accounts ADD COLUMN last_seen_run INTEGER');
  }
  if (!columnsOf('actions').includes('dry_run')) {
    log.info('migrating: adding actions.dry_run');
    db.exec('ALTER TABLE actions ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 0');
  }
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Release the database file. Windows refuses to delete a file that still has an
 * open handle, so anything that creates a throwaway database - the tests, above
 * all - has to close it before cleaning up. Stop the unfollow queue first: it
 * polls the database once a second and would throw on a closed handle.
 */
export function closeDatabase(): void {
  if (db.open) db.close();
}

// --- meta -----------------------------------------------------------------

const getMetaStmt = db.prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?');
const setMetaStmt = db.prepare(
  'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
);
const delMetaStmt = db.prepare('DELETE FROM meta WHERE key = ?');

export function getMeta(key: string): string | null {
  return getMetaStmt.get(key)?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  setMetaStmt.run(key, value);
}

export function deleteMeta(key: string): void {
  delMetaStmt.run(key);
}

// --- accounts -------------------------------------------------------------

interface AccountRow {
  pk: string;
  username: string;
  full_name: string | null;
  profile_pic_url: string | null;
  is_private: number;
  is_verified: number;
  follower_count: number | null;
  following_count: number | null;
  follows_back: number | null;
  followed_at: number | null;
  first_seen_at: number;
  last_seen_at: number;
  last_seen_run: number | null;
  enriched_at: number | null;
  status: AccountStatus;
}

function toAccount(row: AccountRow): Account {
  return {
    pk: row.pk,
    username: row.username,
    fullName: row.full_name,
    profilePicUrl: row.profile_pic_url,
    isPrivate: row.is_private === 1,
    isVerified: row.is_verified === 1,
    followerCount: row.follower_count,
    followingCount: row.following_count,
    followsBack: row.follows_back === null ? null : row.follows_back === 1,
    followedAt: row.followed_at,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    enrichedAt: row.enriched_at,
    status: row.status,
  };
}

/**
 * Insert or refresh an account seen in a sync.
 *
 * COALESCE is deliberate on the nullable columns: an archive import knows
 * `followed_at` but not follower counts, a live sync knows the opposite, and a
 * later run of either must never blank out what the other one learned.
 */
const upsertAccountStmt = db.prepare(`
  INSERT INTO accounts (
    pk, username, full_name, profile_pic_url, is_private, is_verified,
    follower_count, following_count, followed_at,
    first_seen_at, last_seen_at, last_seen_run, status
  ) VALUES (
    @pk, @username, @full_name, @profile_pic_url, @is_private, @is_verified,
    @follower_count, @following_count, @followed_at,
    @seen, @seen, @run_id, 'following'
  )
  ON CONFLICT(pk) DO UPDATE SET
    username        = excluded.username,
    full_name       = COALESCE(excluded.full_name, accounts.full_name),
    profile_pic_url = COALESCE(excluded.profile_pic_url, accounts.profile_pic_url),
    is_private      = excluded.is_private,
    is_verified     = excluded.is_verified,
    follower_count  = COALESCE(excluded.follower_count, accounts.follower_count),
    following_count = COALESCE(excluded.following_count, accounts.following_count),
    followed_at     = COALESCE(accounts.followed_at, excluded.followed_at),
    last_seen_at    = excluded.last_seen_at,
    last_seen_run   = excluded.last_seen_run,
    status          = 'following'
`);

const existsStmt = db.prepare<[string], { pk: string }>('SELECT pk FROM accounts WHERE pk = ?');

export interface UpsertResult {
  added: number;
  updated: number;
}

export function upsertAccounts(accounts: RemoteAccount[], seen: number, runId: number): UpsertResult {
  let added = 0;
  let updated = 0;
  const run = db.transaction((rows: RemoteAccount[]) => {
    for (const a of rows) {
      if (existsStmt.get(a.pk)) updated += 1;
      else added += 1;
      upsertAccountStmt.run({
        pk: a.pk,
        username: a.username,
        full_name: a.fullName,
        profile_pic_url: a.profilePicUrl,
        is_private: a.isPrivate ? 1 : 0,
        is_verified: a.isVerified ? 1 : 0,
        follower_count: a.followerCount ?? null,
        following_count: a.followingCount ?? null,
        followed_at: a.followedAt ?? null,
        seen,
        run_id: runId,
      });
    }
  });
  run(accounts);
  return { added, updated };
}

/**
 * Anything still marked `following` that this sync did not touch is no longer
 * followed. We never delete: the history of who dropped off is the interesting
 * part. Rows we unfollowed ourselves keep their `unfollowed` status.
 *
 * Matching on the sync's run id rather than on `last_seen_at` matters: two syncs
 * inside the same wall-clock second are indistinguishable by a second-precision
 * timestamp, and departures would be silently missed.
 *
 * The scope guard matters too. Archive rows are username-keyed and live rows are
 * id-keyed, so a sync from one source must never declare the other source's rows
 * gone just because it could not have seen them.
 */
const markGoneStmts = {
  archive: db.prepare(
    `UPDATE accounts SET status = 'gone'
      WHERE status = 'following' AND pk LIKE 'username:%'
        AND (last_seen_run IS NULL OR last_seen_run != ?)`,
  ),
  live: db.prepare(
    `UPDATE accounts SET status = 'gone'
      WHERE status = 'following' AND pk NOT LIKE 'username:%'
        AND (last_seen_run IS NULL OR last_seen_run != ?)`,
  ),
};

export function markMissingAsGone(runId: number, scope: 'archive' | 'live'): number {
  return markGoneStmts[scope].run(runId).changes;
}

export function setFollowsBack(pks: Set<string>): void {
  const clear = db.prepare('UPDATE accounts SET follows_back = 0');
  const set = db.prepare('UPDATE accounts SET follows_back = 1 WHERE pk = ?');
  db.transaction(() => {
    clear.run();
    for (const pk of pks) set.run(pk);
  })();
}

const markUnfollowedStmt = db.prepare(
  `UPDATE accounts SET status = 'unfollowed' WHERE pk = ?`,
);

export function markUnfollowed(pk: string): void {
  markUnfollowedStmt.run(pk);
}

const enrichStmt = db.prepare(`
  UPDATE accounts
     SET follower_count  = COALESCE(@follower_count, follower_count),
         following_count = COALESCE(@following_count, following_count),
         full_name       = COALESCE(@full_name, full_name),
         profile_pic_url = COALESCE(@profile_pic_url, profile_pic_url),
         enriched_at     = @at
   WHERE pk = @pk
`);

export function saveEnrichment(
  pk: string,
  details: { followerCount: number | null; followingCount: number | null; fullName: string | null; profilePicUrl: string | null },
  at: number,
): void {
  enrichStmt.run({
    pk,
    follower_count: details.followerCount,
    following_count: details.followingCount,
    full_name: details.fullName,
    profile_pic_url: details.profilePicUrl,
    at,
  });
}

export function getAccount(pk: string): Account | null {
  const row = db.prepare<[string], AccountRow>('SELECT * FROM accounts WHERE pk = ?').get(pk);
  return row ? toAccount(row) : null;
}

export type SortKey =
  | 'username'
  | 'full_name'
  | 'follower_count'
  | 'following_count'
  | 'followed_at'
  | 'first_seen_at';

export interface ListQuery {
  search?: string;
  status?: AccountStatus | 'all';
  onlyNonFollowers?: boolean;
  onlyPrivate?: boolean;
  onlyVerified?: boolean;
  sort?: SortKey;
  direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

const SORTABLE: Record<SortKey, string> = {
  username: 'username COLLATE NOCASE',
  full_name: 'full_name COLLATE NOCASE',
  follower_count: 'follower_count',
  following_count: 'following_count',
  followed_at: 'followed_at',
  first_seen_at: 'first_seen_at',
};

export interface ListResult {
  items: Account[];
  total: number;
}

export function listAccounts(query: ListQuery): ListResult {
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  const status = query.status ?? 'following';
  if (status !== 'all') {
    where.push('status = @status');
    params['status'] = status;
  }
  if (query.search) {
    where.push('(username LIKE @search COLLATE NOCASE OR full_name LIKE @search COLLATE NOCASE)');
    params['search'] = `%${query.search.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  }
  if (query.onlyNonFollowers) where.push('follows_back = 0');
  if (query.onlyPrivate) where.push('is_private = 1');
  if (query.onlyVerified) where.push('is_verified = 1');

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sortKey = query.sort && query.sort in SORTABLE ? query.sort : 'username';
  const dir = query.direction === 'desc' ? 'DESC' : 'ASC';
  // NULLs always sort last, whichever direction is asked for: an account with an
  // unknown follower count is not "the smallest", it is unknown.
  const orderBy = `ORDER BY (${SORTABLE[sortKey]} IS NULL), ${SORTABLE[sortKey]} ${dir}, username COLLATE NOCASE ASC`;

  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  const offset = Math.max(query.offset ?? 0, 0);

  const total = db
    .prepare<Record<string, unknown>, { n: number }>(`SELECT COUNT(*) AS n FROM accounts ${clause}`)
    .get(params)!.n;

  const rows = db
    .prepare<Record<string, unknown>, AccountRow>(
      `SELECT * FROM accounts ${clause} ${orderBy} LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset });

  return { items: rows.map(toAccount), total };
}

export interface Stats {
  following: number;
  unfollowed: number;
  gone: number;
  nonFollowers: number;
  private: number;
  verified: number;
  withFollowedAt: number;
  enriched: number;
}

export function getStats(): Stats {
  const row = db
    .prepare<[], Record<string, number>>(
      `SELECT
         SUM(status = 'following')                       AS following,
         SUM(status = 'unfollowed')                      AS unfollowed,
         SUM(status = 'gone')                            AS gone,
         SUM(status = 'following' AND follows_back = 0)  AS nonFollowers,
         SUM(status = 'following' AND is_private = 1)    AS priv,
         SUM(status = 'following' AND is_verified = 1)   AS verified,
         SUM(status = 'following' AND followed_at IS NOT NULL) AS withFollowedAt,
         SUM(status = 'following' AND enriched_at IS NOT NULL) AS enriched
       FROM accounts`,
    )
    .get()!;
  return {
    following: row['following'] ?? 0,
    unfollowed: row['unfollowed'] ?? 0,
    gone: row['gone'] ?? 0,
    nonFollowers: row['nonFollowers'] ?? 0,
    private: row['priv'] ?? 0,
    verified: row['verified'] ?? 0,
    withFollowedAt: row['withFollowedAt'] ?? 0,
    enriched: row['enriched'] ?? 0,
  };
}

/** Accounts that still need follower/following counts, oldest data first. */
export function accountsNeedingEnrichment(limit: number): Account[] {
  const rows = db
    .prepare<[number], AccountRow>(
      `SELECT * FROM accounts
        WHERE status = 'following' AND enriched_at IS NULL
        ORDER BY username COLLATE NOCASE
        LIMIT ?`,
    )
    .all(limit);
  return rows.map(toAccount);
}

// --- actions --------------------------------------------------------------

interface ActionRow {
  id: number;
  account_pk: string;
  username: string;
  status: UnfollowAction['status'];
  requested_at: number;
  executed_at: number | null;
  attempts: number;
  error: string | null;
  dry_run: number;
}

function toAction(row: ActionRow): UnfollowAction {
  return {
    id: row.id,
    accountPk: row.account_pk,
    username: row.username,
    status: row.status,
    requestedAt: row.requested_at,
    executedAt: row.executed_at,
    attempts: row.attempts,
    error: row.error,
    dryRun: row.dry_run === 1,
  };
}

export function enqueueAction(accountPk: string, username: string, dryRun: boolean): UnfollowAction | null {
  try {
    const info = db
      .prepare(
        'INSERT INTO actions (account_pk, username, status, requested_at, dry_run) VALUES (?, ?, ?, ?, ?)',
      )
      .run(accountPk, username, 'queued', now(), dryRun ? 1 : 0);
    return getAction(Number(info.lastInsertRowid));
  } catch (err) {
    // Unique partial index: an action for this account is already in flight.
    if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return null;
    throw err;
  }
}

export function getAction(id: number): UnfollowAction | null {
  const row = db.prepare<[number], ActionRow>('SELECT * FROM actions WHERE id = ?').get(id);
  return row ? toAction(row) : null;
}

export function claimNextAction(): UnfollowAction | null {
  const row = db
    .prepare<[], ActionRow>(`SELECT * FROM actions WHERE status = 'queued' ORDER BY id LIMIT 1`)
    .get();
  if (!row) return null;
  db.prepare(`UPDATE actions SET status = 'running', attempts = attempts + 1 WHERE id = ?`).run(row.id);
  return getAction(row.id);
}

export function completeAction(id: number, status: UnfollowAction['status'], error: string | null): void {
  db.prepare(`UPDATE actions SET status = ?, executed_at = ?, error = ? WHERE id = ?`).run(
    status,
    now(),
    error,
    id,
  );
}

/** Put a claimed-but-unrun action back in the queue (e.g. the worker paused). */
export function releaseAction(id: number): void {
  db.prepare(`UPDATE actions SET status = 'queued' WHERE id = ? AND status = 'running'`).run(id);
}

export function cancelAction(id: number): boolean {
  return (
    db.prepare(`UPDATE actions SET status = 'canceled', executed_at = ? WHERE id = ? AND status = 'queued'`).run(
      now(),
      id,
    ).changes > 0
  );
}

export function cancelAllQueued(): number {
  return db.prepare(`UPDATE actions SET status = 'canceled', executed_at = ? WHERE status = 'queued'`).run(now())
    .changes;
}

export function listActions(statuses: UnfollowAction['status'][], limit = 100): UnfollowAction[] {
  const placeholders = statuses.map(() => '?').join(', ');
  const rows = db
    .prepare<unknown[], ActionRow>(
      `SELECT * FROM actions WHERE status IN (${placeholders}) ORDER BY id DESC LIMIT ?`,
    )
    .all(...statuses, limit);
  return rows.map(toAction);
}

export function pendingActionsByPk(): Map<string, UnfollowAction> {
  const rows = db
    .prepare<[], ActionRow>(`SELECT * FROM actions WHERE status IN ('queued', 'running') ORDER BY id`)
    .all();
  return new Map(rows.map((r) => [r.account_pk, toAction(r)]));
}

/** Anything left 'running' from a previous process crashed mid-flight. */
export function recoverStaleActions(): number {
  return db
    .prepare(`UPDATE actions SET status = 'queued' WHERE status = 'running'`)
    .run().changes;
}

// --- sync runs ------------------------------------------------------------

export function startSyncRun(source: string): number {
  return Number(
    db.prepare('INSERT INTO sync_runs (source, started_at) VALUES (?, ?)').run(source, now()).lastInsertRowid,
  );
}

export function finishSyncRun(
  id: number,
  result: { ok: boolean; added: number; updated: number; removed: number; error?: string | null },
): void {
  db.prepare(
    `UPDATE sync_runs SET finished_at = ?, ok = ?, added = ?, updated = ?, removed = ?, error = ? WHERE id = ?`,
  ).run(now(), result.ok ? 1 : 0, result.added, result.updated, result.removed, result.error ?? null, id);
}

export function lastSyncRun(): SyncRun | null {
  const row = db
    .prepare<[], {
      id: number;
      source: string;
      started_at: number;
      finished_at: number | null;
      ok: number | null;
      added: number;
      updated: number;
      removed: number;
      error: string | null;
    }>('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1')
    .get();
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    ok: row.ok === null ? null : row.ok === 1,
    added: row.added,
    updated: row.updated,
    removed: row.removed,
    error: row.error,
  };
}

// --- rate events ----------------------------------------------------------

export function recordRateEvent(bucket: string, at: number): void {
  db.prepare('INSERT INTO rate_events (bucket, at) VALUES (?, ?)').run(bucket, at);
}

export function countRateEvents(bucket: string, since: number): number {
  return db
    .prepare<[string, number], { n: number }>('SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ? AND at >= ?')
    .get(bucket, since)!.n;
}

export function lastRateEvent(bucket: string): number | null {
  return (
    db
      .prepare<[string], { at: number }>('SELECT at FROM rate_events WHERE bucket = ? ORDER BY at DESC LIMIT 1')
      .get(bucket)?.at ?? null
  );
}

export function pruneRateEvents(olderThan: number): void {
  db.prepare('DELETE FROM rate_events WHERE at < ?').run(olderThan);
}

// --- archive/live reconciliation -----------------------------------------

/**
 * The data export has no numeric ids, so archive rows are keyed
 * `username:<lowercase>`. The first live sync that sees the same username
 * adopts that row's `followed_at` and drops the placeholder, so a user who
 * imports an archive and then connects a session keeps their follow dates and
 * does not end up with the account listed twice.
 */
export function takeArchivePlaceholder(username: string): number | null {
  const key = `username:${username.toLowerCase()}`;
  const row = db
    .prepare<[string], { followed_at: number | null }>('SELECT followed_at FROM accounts WHERE pk = ?')
    .get(key);
  if (!row) return null;
  db.prepare('DELETE FROM accounts WHERE pk = ?').run(key);
  return row.followed_at;
}

/**
 * Wipe every stored account and action. Used by `npm run sample -- --clear` to
 * remove demo data; the session and rate-limit ledger are deliberately left
 * alone, since neither is part of what the sample loaded.
 */
export function clearAllAccounts(): { accounts: number; actions: number } {
  const accounts = db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number };
  const actions = db.prepare('SELECT COUNT(*) AS n FROM actions').get() as { n: number };
  db.transaction(() => {
    db.prepare('DELETE FROM accounts').run();
    db.prepare('DELETE FROM actions').run();
    db.prepare('DELETE FROM sync_runs').run();
    delMetaStmt.run('last_sync_at');
  })();
  return { accounts: accounts.n, actions: actions.n };
}

export function countArchivePlaceholders(): number {
  return db
    .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM accounts WHERE pk LIKE 'username:%'`)
    .get()!.n;
}
