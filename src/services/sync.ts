import { AppError } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import { sleep } from '../core/ratelimit.js';
import type { RemoteAccount } from '../core/types.js';
import {
  accountsNeedingEnrichment,
  finishSyncRun,
  markMissingAsGone,
  now,
  saveEnrichment,
  setFollowsBack,
  setMeta,
  startSyncRun,
  takeArchivePlaceholder,
  upsertAccounts,
} from '../db/index.js';
import type { Provider } from '../providers/provider.js';

const log = createLogger('sync');

export interface SyncProgress {
  running: boolean;
  phase: 'idle' | 'following' | 'followers' | 'enriching' | 'done' | 'error';
  fetched: number;
  added: number;
  updated: number;
  removed: number;
  enriched: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
}

const MAX_PAGES = 400; // 400 * 50 = 20k accounts; far beyond Instagram's follow ceiling.

/** One sync at a time, process-wide: concurrent syncs would double the request rate. */
class SyncService {
  private progress: SyncProgress = emptyProgress();
  private inflight: Promise<SyncProgress> | null = null;
  private abort = { aborted: false };

  get status(): SyncProgress {
    return { ...this.progress };
  }

  cancel(): boolean {
    if (!this.inflight) return false;
    this.abort.aborted = true;
    return true;
  }

  run(provider: Provider, options: { enrich?: boolean; enrichLimit?: number } = {}): Promise<SyncProgress> {
    if (this.inflight) return this.inflight;
    this.abort = { aborted: false };
    // Flip to "running" synchronously so a status poll racing the POST that
    // started this sync cannot report the run as already finished.
    this.progress = { ...emptyProgress(), running: true, phase: 'following', startedAt: now() };
    this.inflight = this.execute(provider, options).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async execute(
    provider: Provider,
    options: { enrich?: boolean; enrichLimit?: number },
  ): Promise<SyncProgress> {
    const runId = startSyncRun(provider.name);
    const startedAtSec = now();
    this.progress = { ...this.progress, running: true, phase: 'following', startedAt: startedAtSec };

    try {
      // Inside the try: a provider that is not configured must still clear the
      // running flag, or the dashboard's Sync button stays disabled forever.
      await provider.ensureReady();

      const who = await provider.whoami().catch(() => null);
      if (who?.username) setMeta('self_username', who.username);
      if (who?.pk) setMeta('self_pk', who.pk);

      // --- following ------------------------------------------------------
      let cursor: string | null = null;
      let pages = 0;
      do {
        this.assertNotAborted();
        const page = await provider.listFollowing(cursor);
        const batch = this.adoptArchiveDates(page.accounts);
        const result = upsertAccounts(batch, startedAtSec, runId);
        this.progress.fetched += batch.length;
        this.progress.added += result.added;
        this.progress.updated += result.updated;
        cursor = page.cursor;
        pages += 1;
        if (pages >= MAX_PAGES) {
          log.warn(`stopping after ${MAX_PAGES} pages; cursor still open`);
          break;
        }
      } while (cursor);

      this.progress.removed = markMissingAsGone(runId, provider.capabilities.liveSync ? 'live' : 'archive');

      // --- followers (to compute "follows you back") ----------------------
      if (provider.listFollowers && provider.capabilities.followers) {
        this.progress.phase = 'followers';
        const followerPks = new Set<string>();
        let fCursor: string | null = null;
        let fPages = 0;
        do {
          this.assertNotAborted();
          const page: { accounts: RemoteAccount[]; cursor: string | null } =
            await provider.listFollowers(fCursor);
          for (const a of page.accounts) {
            followerPks.add(a.pk);
            // Archive followers are username-keyed; match live rows by username too.
            followerPks.add(`username:${a.username.toLowerCase()}`);
          }
          fCursor = page.cursor;
          fPages += 1;
        } while (fCursor && fPages < MAX_PAGES);
        if (followerPks.size > 0) setFollowsBack(followerPks);
      }

      // --- optional per-profile enrichment --------------------------------
      if (options.enrich && provider.getProfile && provider.capabilities.enrich) {
        this.progress.phase = 'enriching';
        const targets = accountsNeedingEnrichment(options.enrichLimit ?? 25);
        for (const account of targets) {
          this.assertNotAborted();
          try {
            const details = await provider.getProfile(account.username);
            saveEnrichment(account.pk, details, now());
            this.progress.enriched += 1;
          } catch (err) {
            // One private/deleted profile must not abort the whole run, but a
            // throttle must: rethrow anything that is not a plain 4xx.
            const status = (err as AppError).statusCode ?? 500;
            if (status === 429 || status === 401) throw err;
            log.warn(`enrich @${account.username} failed: ${(err as Error).message}`);
          }
          await sleep(50);
        }
      }

      this.progress.phase = 'done';
      this.progress.running = false;
      this.progress.finishedAt = now();
      finishSyncRun(runId, {
        ok: true,
        added: this.progress.added,
        updated: this.progress.updated,
        removed: this.progress.removed,
      });
      setMeta('last_sync_at', String(this.progress.finishedAt));
      log.info(
        `sync done: +${this.progress.added} ~${this.progress.updated} -${this.progress.removed} ` +
          `(${this.progress.fetched} fetched)`,
      );
    } catch (err) {
      const message = (err as Error).message;
      this.progress.phase = 'error';
      this.progress.running = false;
      this.progress.finishedAt = now();
      this.progress.error = message;
      finishSyncRun(runId, {
        ok: false,
        added: this.progress.added,
        updated: this.progress.updated,
        removed: this.progress.removed,
        error: message,
      });
      log.error(`sync failed: ${message}`);
      throw err;
    }

    return this.status;
  }

  /** Carry follow dates from an imported archive onto freshly-synced live rows. */
  private adoptArchiveDates(accounts: RemoteAccount[]): RemoteAccount[] {
    return accounts.map((a) => {
      if (a.pk.startsWith('username:') || a.followedAt) return a;
      const followedAt = takeArchivePlaceholder(a.username);
      return followedAt ? { ...a, followedAt } : a;
    });
  }

  private assertNotAborted(): void {
    if (this.abort.aborted) throw new AppError('Sync canceled.', 499, 'canceled');
  }
}

function emptyProgress(): SyncProgress {
  return {
    running: false,
    phase: 'idle',
    fetched: 0,
    added: 0,
    updated: 0,
    removed: 0,
    enriched: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}

export const syncService = new SyncService();
