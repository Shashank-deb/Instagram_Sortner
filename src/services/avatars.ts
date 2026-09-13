import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { AppError } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import { getAccount } from '../db/index.js';
import { webProvider } from '../providers/index.js';

const log = createLogger('avatars');

const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const inflight = new Map<string, Promise<CachedAvatar>>();

export interface CachedAvatar {
  body: Buffer;
  contentType: string;
}

/**
 * Instagram's avatar URLs are signed, expire within days, and are served from a
 * CDN that inspects the Referer. Rendering them straight from the browser leaks
 * every account you follow to the CDN and breaks as soon as the signature ages
 * out, so they are fetched server-side and cached on disk instead.
 */
export async function getAvatar(pk: string): Promise<CachedAvatar> {
  const existing = inflight.get(pk);
  if (existing) return existing;

  const task = load(pk).finally(() => inflight.delete(pk));
  inflight.set(pk, task);
  return task;
}

async function load(pk: string): Promise<CachedAvatar> {
  const file = cachePath(pk);

  try {
    const stat = await fs.stat(file);
    if (Date.now() - stat.mtimeMs < MAX_AGE_MS) {
      return { body: await fs.readFile(file), contentType: 'image/jpeg' };
    }
  } catch {
    // Not cached yet.
  }

  const account = getAccount(pk);
  if (!account?.profilePicUrl) throw new AppError('No avatar on file for that account.', 404, 'not_found');

  const fetched = await webProvider.fetchAvatar(account.profilePicUrl);
  try {
    await fs.writeFile(file, fetched.body);
  } catch (err) {
    log.warn(`could not cache avatar for ${pk}: ${(err as Error).message}`);
  }
  return fetched;
}

function cachePath(pk: string): string {
  // pk comes from the database but still gets flattened: never let it walk out
  // of the cache directory.
  const safe = pk.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
  return path.join(config.avatarDir, `${safe}.img`);
}

export async function clearAvatarCache(): Promise<number> {
  const files = await fs.readdir(config.avatarDir).catch(() => [] as string[]);
  let removed = 0;
  for (const file of files) {
    if (!file.endsWith('.img')) continue;
    await fs.unlink(path.join(config.avatarDir, file)).catch(() => undefined);
    removed += 1;
  }
  return removed;
}
