import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * Shutdown order. This exists because of a Windows-only failure: the test suite
 * could not delete its own temp directory, since the queue worker still held the
 * database open and Windows refuses to unlink a file with a live handle.
 *
 * The assertions here are platform-independent - the handle is either released
 * or it is not - so this guards the behaviour everywhere, not just where it
 * happened to break.
 */

let dataDir: string;
let db: typeof import('../src/db/index.js');
let queue: typeof import('../src/services/unfollow.js');

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sortner-shutdown-'));
  Object.assign(process.env, { DATA_DIR: dataDir, PROVIDER: 'archive', LOG_LEVEL: 'error' });
  db = await import('../src/db/index.js');
  queue = await import('../src/services/unfollow.js');
});

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('shutdown', () => {
  it('stops the worker promptly, even while it is paused', async () => {
    queue.unfollowQueue.start();
    queue.unfollowQueue.pause('paused on purpose');

    const startedAt = Date.now();
    await queue.unfollowQueue.stop();
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 3000, `stop() took ${elapsed}ms; it must not wait out a poll or a rate-limit window`);
  });

  it('is safe to call stop twice', async () => {
    await queue.unfollowQueue.stop();
    await queue.unfollowQueue.stop();
  });

  it('releases the database file, so the directory can be deleted', () => {
    const dbFile = path.join(dataDir, 'sortner.sqlite');
    assert.ok(fs.existsSync(dbFile), 'the database should exist before we close it');

    db.closeDatabase();
    assert.equal(db.db.open, false, 'the handle must actually be released, not just flushed');

    // The real assertion: on Windows this throws EBUSY while a handle is open.
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    assert.equal(fs.existsSync(dataDir), false);

    fs.mkdirSync(dataDir, { recursive: true });
  });

  it('is safe to close the database twice', () => {
    db.closeDatabase();
  });
});
