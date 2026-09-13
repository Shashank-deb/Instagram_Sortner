import { countRateEvents, lastRateEvent, pruneRateEvents, recordRateEvent } from '../db/index.js';
import { createLogger } from './logger.js';

const log = createLogger('ratelimit');

export interface RateLimitOptions {
  bucket: string;
  maxPerHour: number;
  /** 0 disables the daily cap. */
  maxPerDay?: number;
  minGapMs: number;
  /** When set, the gap is drawn uniformly from [minGapMs, maxGapMs]. */
  maxGapMs?: number;
}

export interface Verdict {
  allowed: boolean;
  /** How long to wait before the next attempt would be allowed. */
  waitMs: number;
  reason: 'ok' | 'hourly-cap' | 'daily-cap' | 'min-gap' | 'cooldown';
}

const HOUR = 3600;
const DAY = 86_400;

/**
 * Quota keeper for outbound Instagram calls.
 *
 * Every consumed slot is written to SQLite, so the hourly and daily ceilings
 * hold across restarts - the thing a purely in-memory limiter gets wrong, and
 * exactly the case (crash, restart, resume) where an account gets flagged.
 */
export class RateLimiter {
  private cooldownUntilMs = 0;
  private cooldownReason = '';

  constructor(private readonly opts: RateLimitOptions) {}

  /** Force a pause, e.g. after Instagram returned 429 or a challenge. */
  cooldown(ms: number, reason: string): void {
    this.cooldownUntilMs = Math.max(this.cooldownUntilMs, Date.now() + ms);
    this.cooldownReason = reason;
    log.warn(`${this.opts.bucket}: cooling down ${Math.round(ms / 1000)}s - ${reason}`);
  }

  clearCooldown(): void {
    this.cooldownUntilMs = 0;
    this.cooldownReason = '';
  }

  check(nowMs = Date.now()): Verdict {
    const nowSec = Math.floor(nowMs / 1000);

    if (nowMs < this.cooldownUntilMs) {
      return { allowed: false, waitMs: this.cooldownUntilMs - nowMs, reason: 'cooldown' };
    }

    const perDay = this.opts.maxPerDay ?? 0;
    if (perDay > 0 && countRateEvents(this.opts.bucket, nowSec - DAY) >= perDay) {
      return { allowed: false, waitMs: DAY * 1000, reason: 'daily-cap' };
    }

    if (countRateEvents(this.opts.bucket, nowSec - HOUR) >= this.opts.maxPerHour) {
      return { allowed: false, waitMs: HOUR * 1000, reason: 'hourly-cap' };
    }

    const last = lastRateEvent(this.opts.bucket);
    if (last !== null) {
      const elapsed = nowMs - last * 1000;
      const gap = this.nextGapMs();
      if (elapsed < gap) {
        return { allowed: false, waitMs: gap - elapsed, reason: 'min-gap' };
      }
    }

    return { allowed: true, waitMs: 0, reason: 'ok' };
  }

  /** Consume a slot. Call this immediately before the outbound request. */
  consume(nowMs = Date.now()): void {
    recordRateEvent(this.opts.bucket, Math.floor(nowMs / 1000));
  }

  /** Block until a slot is free, then consume it. */
  async acquire(signal?: { aborted: boolean }): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new Error('aborted');
      const verdict = this.check();
      if (verdict.allowed) {
        this.consume();
        return;
      }
      // Re-check at least once a second so a cooldown clear or a cancel is picked
      // up promptly instead of sleeping out a full hourly window.
      await sleep(Math.min(verdict.waitMs, 1000));
    }
  }

  usage(nowMs = Date.now()) {
    const nowSec = Math.floor(nowMs / 1000);
    return {
      bucket: this.opts.bucket,
      lastHour: countRateEvents(this.opts.bucket, nowSec - HOUR),
      maxPerHour: this.opts.maxPerHour,
      lastDay: countRateEvents(this.opts.bucket, nowSec - DAY),
      maxPerDay: this.opts.maxPerDay ?? null,
      cooldownMsRemaining: Math.max(0, this.cooldownUntilMs - nowMs),
      cooldownReason: this.cooldownReason || null,
    };
  }

  /** Randomised so the request cadence is not a metronome. */
  private nextGapMs(): number {
    const { minGapMs, maxGapMs } = this.opts;
    if (!maxGapMs || maxGapMs <= minGapMs) return minGapMs;
    return minGapMs + Math.floor(Math.random() * (maxGapMs - minGapMs + 1));
  }
}

/**
 * `unref` keeps a forever-polling loop from holding the process open by itself:
 * in the server the HTTP listener is what should keep Node alive, and in a test
 * run nothing should.
 */
export function sleep(ms: number, options: { unref?: boolean } = {}): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    if (options.unref) timer.unref();
  });
}

/** Drop ledger rows older than two days; nothing reads beyond a 24h window. */
export function startRateEventPruner(): NodeJS.Timeout {
  const prune = () => pruneRateEvents(Math.floor(Date.now() / 1000) - 2 * DAY);
  prune();
  const timer = setInterval(prune, 6 * 3600 * 1000);
  timer.unref();
  return timer;
}
