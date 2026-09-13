import { config } from '../config.js';
import { AppError, ProviderUnsupportedError, ThrottledError } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import { sleep } from '../core/ratelimit.js';
import {
  cancelAction,
  cancelAllQueued,
  claimNextAction,
  completeAction,
  enqueueAction,
  getAccount,
  listActions,
  markUnfollowed,
  pendingActionsByPk,
  recoverStaleActions,
  releaseAction,
} from '../db/index.js';
import { activeProvider, unfollowLimiter } from '../providers/index.js';
import type { UnfollowAction } from '../core/types.js';

const log = createLogger('unfollow');

export interface QueueState {
  running: boolean;
  paused: boolean;
  pausedReason: string | null;
  current: { id: number; username: string } | null;
  queued: number;
  consecutiveFailures: number;
  limits: ReturnType<typeof unfollowLimiter.usage>;
  nextEligibleInMs: number;
}

/**
 * Serial, persistent, rate-limited unfollow queue.
 *
 * Serial on purpose: parallel unfollows are the single fastest way to get an
 * account action-blocked. The queue is stored in SQLite so a restart resumes
 * exactly where it left off without re-issuing a request that already landed.
 */
class UnfollowQueue {
  private running = false;
  private paused = false;
  private pausedReason: string | null = null;
  private current: { id: number; username: string } | null = null;
  private consecutiveFailures = 0;
  private loopHandle: Promise<void> | null = null;

  start(): void {
    const recovered = recoverStaleActions();
    if (recovered > 0) log.warn(`requeued ${recovered} action(s) left running by a previous process`);
    if (!this.loopHandle) this.loopHandle = this.loop();
  }

  get state(): QueueState {
    return {
      running: this.running,
      paused: this.paused,
      pausedReason: this.pausedReason,
      current: this.current,
      queued: listActions(['queued']).length,
      consecutiveFailures: this.consecutiveFailures,
      limits: unfollowLimiter.usage(),
      nextEligibleInMs: this.paused ? -1 : unfollowLimiter.check().waitMs,
    };
  }

  pause(reason: string): void {
    this.paused = true;
    this.pausedReason = reason;
    log.warn(`queue paused: ${reason}`);
  }

  resume(): void {
    this.paused = false;
    this.pausedReason = null;
    this.consecutiveFailures = 0;
    unfollowLimiter.clearCooldown();
    log.info('queue resumed');
  }

  /** Queue an unfollow. Returns null when one is already pending for this account. */
  enqueue(pk: string): { action: UnfollowAction } {
    const provider = activeProvider();
    if (!provider.capabilities.unfollow) {
      throw new ProviderUnsupportedError('unfollow accounts', provider.name);
    }
    const account = getAccount(pk);
    if (!account) throw new AppError('Unknown account.', 404, 'not_found');
    if (account.status !== 'following') {
      throw new AppError(`@${account.username} is not in your following list.`, 409, 'not_following');
    }
    if (pk.startsWith('username:')) {
      throw new AppError(
        `@${account.username} came from a data export, which carries no account id. ` +
          'Run a live sync first so the app can resolve it.',
        409,
        'needs_sync',
      );
    }
    const action = enqueueAction(pk, account.username);
    if (!action) throw new AppError(`An unfollow for @${account.username} is already queued.`, 409, 'duplicate');
    log.info(`queued unfollow for @${account.username}`);
    return { action };
  }

  cancel(id: number): boolean {
    return cancelAction(id);
  }

  cancelAll(): number {
    return cancelAllQueued();
  }

  pending(): Map<string, UnfollowAction> {
    return pendingActionsByPk();
  }

  history(limit = 50): UnfollowAction[] {
    return listActions(['done', 'failed', 'canceled'], limit);
  }

  private async loop(): Promise<void> {
    for (;;) {
      if (this.paused) {
        await sleep(1000, { unref: true });
        continue;
      }

      const action = claimNextAction();
      if (!action) {
        this.running = false;
        this.current = null;
        await sleep(1000, { unref: true });
        continue;
      }

      this.running = true;
      this.current = { id: action.id, username: action.username };

      try {
        // Wait for a slot first, then re-check we were not paused during the wait.
        await this.waitForSlot();
        if (this.paused) {
          releaseAction(action.id);
          this.current = null;
          continue;
        }

        const provider = activeProvider();
        await provider.unfollow!(action.accountPk, action.username);

        markUnfollowed(action.accountPk);
        completeAction(action.id, 'done', null);
        this.consecutiveFailures = 0;
      } catch (err) {
        const message = (err as Error).message;
        completeAction(action.id, 'failed', message);
        this.consecutiveFailures += 1;
        log.error(`unfollow @${action.username} failed: ${message}`);

        if (err instanceof ThrottledError) {
          // A checkpoint means stop entirely; a plain 429 means back off and let
          // the limiter's cooldown hold the line.
          this.pause(
            err.hard
              ? 'Instagram raised a checkpoint. Resolve it in the app, then resume.'
              : 'Instagram rate-limited the session. Resume once it has cooled off.',
          );
          this.cancelAll();
        } else if (this.consecutiveFailures >= config.limits.circuitBreakerFailures) {
          this.pause(`${this.consecutiveFailures} consecutive failures. Last error: ${message}`);
        }
      } finally {
        this.current = null;
      }
    }
  }

  private async waitForSlot(): Promise<void> {
    for (;;) {
      if (this.paused) return;
      const verdict = unfollowLimiter.check();
      if (verdict.allowed) {
        unfollowLimiter.consume();
        return;
      }
      await sleep(Math.min(verdict.waitMs, 1000), { unref: true });
    }
  }
}

export const unfollowQueue = new UnfollowQueue();
