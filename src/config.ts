import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid ${name}=${raw}: expected a non-negative integer`);
  }
  return n;
}

function str(name: string, fallback = ''): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

export type ProviderName = 'archive' | 'web';

const providerRaw = str('PROVIDER', 'archive');
if (providerRaw !== 'archive' && providerRaw !== 'web') {
  throw new Error(`Invalid PROVIDER=${providerRaw}: expected "archive" or "web"`);
}

const dataDir = path.resolve(str('DATA_DIR', './data'));
fs.mkdirSync(dataDir, { recursive: true });

export const config = {
  host: str('HOST', '127.0.0.1'),
  port: int('PORT', 4317),
  appToken: str('APP_TOKEN'),

  dataDir,
  dbPath: path.join(dataDir, 'sortner.sqlite'),
  avatarDir: path.join(dataDir, 'avatars'),
  browserProfileDir: path.join(dataDir, 'browser-profile'),

  provider: providerRaw as ProviderName,
  /**
   * Instagram's origin. Overridable only so the integration tests can point the
   * web provider at a local stand-in; there is no reason to set it in practice.
   */
  igBaseUrl: str('IG_BASE_URL', 'https://www.instagram.com').replace(/\/$/, ''),
  session: {
    sessionid: str('IG_SESSIONID'),
    dsUserId: str('IG_DS_USER_ID'),
    csrftoken: str('IG_CSRFTOKEN'),
  },

  limits: {
    readMaxPerHour: int('READ_MAX_PER_HOUR', 180),
    readMinGapMs: int('READ_MIN_GAP_MS', 1200),
    unfollowMaxPerHour: int('UNFOLLOW_MAX_PER_HOUR', 15),
    unfollowMaxPerDay: int('UNFOLLOW_MAX_PER_DAY', 60),
    unfollowMinGapMs: int('UNFOLLOW_MIN_GAP_MS', 25_000),
    unfollowMaxGapMs: int('UNFOLLOW_MAX_GAP_MS', 70_000),
    circuitBreakerFailures: int('CIRCUIT_BREAKER_FAILURES', 3),
  },
} as const;

if (config.limits.unfollowMaxGapMs < config.limits.unfollowMinGapMs) {
  throw new Error('UNFOLLOW_MAX_GAP_MS must be >= UNFOLLOW_MIN_GAP_MS');
}

fs.mkdirSync(config.avatarDir, { recursive: true });
