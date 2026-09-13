import { config } from '../config.js';
import { RateLimiter } from '../core/ratelimit.js';
import { ArchiveProvider } from './archive.js';
import type { Provider } from './provider.js';
import { WebProvider } from './web.js';

export const readLimiter = new RateLimiter({
  bucket: 'read',
  maxPerHour: config.limits.readMaxPerHour,
  minGapMs: config.limits.readMinGapMs,
  maxGapMs: Math.round(config.limits.readMinGapMs * 2.5),
});

export const unfollowLimiter = new RateLimiter({
  bucket: 'unfollow',
  maxPerHour: config.limits.unfollowMaxPerHour,
  maxPerDay: config.limits.unfollowMaxPerDay,
  minGapMs: config.limits.unfollowMinGapMs,
  maxGapMs: config.limits.unfollowMaxGapMs,
});

export const archiveProvider = new ArchiveProvider();
export const webProvider = new WebProvider(readLimiter);

/** The provider used for live operations (sync, enrich, unfollow). */
export function activeProvider(): Provider {
  return config.provider === 'web' ? webProvider : archiveProvider;
}

export { ArchiveProvider, WebProvider };
export type { Provider };
