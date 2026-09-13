import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { makeUsers, startMockInstagram, type MockServer } from './mock-instagram.js';

/**
 * These run the real client, sync service and unfollow queue against a local
 * stand-in for instagram.com. Config is read at import time, so the mock has to
 * be up and the environment set before anything from src/ is imported.
 */

let mock: MockServer;
let dataDir: string;
let mod: {
  db: typeof import('../src/db/index.js');
  sync: typeof import('../src/services/sync.js');
  providers: typeof import('../src/providers/index.js');
  queue: typeof import('../src/services/unfollow.js');
  ratelimit: typeof import('../src/core/ratelimit.js');
};

const following = makeUsers(7);
const followers = following.slice(0, 3);

before(async () => {
  mock = await startMockInstagram({ following, followers, pageSize: 3 });
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sortner-test-'));

  Object.assign(process.env, {
    DATA_DIR: dataDir,
    PROVIDER: 'web',
    IG_BASE_URL: mock.url,
    IG_SESSIONID: 'test-session-cookie',
    IG_DS_USER_ID: '42',
    IG_CSRFTOKEN: 'test-csrf',
    READ_MIN_GAP_MS: '0',
    READ_MAX_PER_HOUR: '10000',
    UNFOLLOW_MIN_GAP_MS: '0',
    UNFOLLOW_MAX_GAP_MS: '0',
    UNFOLLOW_MAX_PER_HOUR: '100',
    UNFOLLOW_MAX_PER_DAY: '100',
    CIRCUIT_BREAKER_FAILURES: '2',
    LOG_LEVEL: 'error',
  });

  mod = {
    db: await import('../src/db/index.js'),
    sync: await import('../src/services/sync.js'),
    providers: await import('../src/providers/index.js'),
    queue: await import('../src/services/unfollow.js'),
    ratelimit: await import('../src/core/ratelimit.js'),
  };
});

after(async () => {
  await mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await mod.ratelimit.sleep(25);
  }
  throw new Error('timed out waiting for condition');
}

describe('sync', () => {
  it('pages through the whole following list and records follow-back state', async () => {
    const progress = await mod.sync.syncService.run(mod.providers.webProvider, { enrich: true, enrichLimit: 3 });

    assert.equal(progress.fetched, following.length);
    assert.equal(progress.added, following.length);
    assert.equal(progress.error, null);

    const stats = mod.db.getStats();
    assert.equal(stats.following, following.length);
    // 7 followed, 3 follow back -> 4 non-followers.
    assert.equal(stats.nonFollowers, following.length - followers.length);
    assert.equal(stats.enriched, 3, 'enrichment should stop at the requested limit');

    const enriched = mod.db.getAccount('1000');
    assert.equal(enriched?.username, 'user0');
    assert.equal(enriched?.followerCount, 'user0'.length * 1000);
  });

  it('marks accounts that vanished from the list as gone rather than deleting them', async () => {
    mock.options.following = following.slice(0, 5);
    // Deliberately back to back: two syncs inside one wall-clock second must
    // still be told apart, which a second-precision `last_seen_at` cannot do.
    const startedSameSecond = Math.floor(Date.now() / 1000);
    const progress = await mod.sync.syncService.run(mod.providers.webProvider);
    assert.equal(Math.floor(Date.now() / 1000) - startedSameSecond, 0, 'this test is only meaningful if it is fast');

    assert.equal(progress.removed, 2);
    assert.equal(mod.db.getAccount('1005')?.status, 'gone');
    assert.equal(mod.db.getStats().following, 5);

    mock.options.following = following;
    await mod.sync.syncService.run(mod.providers.webProvider);
    assert.equal(mod.db.getAccount('1005')?.status, 'following', 'a returning account comes back');
  });

  it('does not let an archive import declare live rows gone', async () => {
    const before = mod.db.getStats().following;
    const { ArchiveProvider } = await import('../src/providers/archive.js');
    const archive = new ArchiveProvider();
    archive.load(
      Buffer.from(
        JSON.stringify([
          { string_list_data: [{ href: 'https://www.instagram.com/someone_else', value: 'someone_else', timestamp: 1_600_000_000 }] },
        ]),
      ),
      'following.json',
    );

    await mod.sync.syncService.run(archive);

    // The archive knew about exactly one account, and none of the live ones.
    assert.equal(mod.db.getStats().following, before + 1);
    assert.equal(mod.db.getAccount('1000')?.status, 'following');
    assert.equal(mod.db.getAccount('username:someone_else')?.followedAt, 1_600_000_000);
  });

  it('adopts an archive row when a live sync later resolves the same username', async () => {
    const archiveDate = 1_600_000_000;
    const { ArchiveProvider } = await import('../src/providers/archive.js');
    const archive = new ArchiveProvider();
    archive.load(
      Buffer.from(
        JSON.stringify([
          { string_list_data: [{ href: 'https://www.instagram.com/user2', value: 'user2', timestamp: archiveDate }] },
        ]),
      ),
      'following.json',
    );
    await mod.sync.syncService.run(archive);
    assert.ok(mod.db.getAccount('username:user2'), 'placeholder exists before the live sync');

    await mod.sync.syncService.run(mod.providers.webProvider);

    assert.equal(mod.db.getAccount('username:user2'), null, 'placeholder is consumed, not duplicated');
    assert.equal(mod.db.getAccount('1002')?.followedAt, archiveDate, 'the live row adopts the follow date');
  });
});

describe('unfollow queue', () => {
  before(() => mod.queue.unfollowQueue.start());

  it('executes a queued unfollow and reflects it in the database', async () => {
    const { action } = mod.queue.unfollowQueue.enqueue('1001');
    assert.equal(action.status, 'queued');

    await waitFor(() => mod.db.getAction(action.id)?.status === 'done');

    assert.deepEqual(mock.unfollowed, ['1001']);
    assert.equal(mod.db.getAccount('1001')?.status, 'unfollowed');
    assert.equal(mod.db.getStats().unfollowed, 1);
  });

  it('refuses a second unfollow for an account already in flight', () => {
    mod.queue.unfollowQueue.pause('test hold');
    try {
      mod.queue.unfollowQueue.enqueue('1002');
      assert.throws(() => mod.queue.unfollowQueue.enqueue('1002'), /already queued/);
    } finally {
      mod.queue.unfollowQueue.cancelAll();
      mod.queue.unfollowQueue.resume();
    }
  });

  it('refuses to unfollow an account that is not currently followed', () => {
    assert.throws(() => mod.queue.unfollowQueue.enqueue('1001'), /not in your following list/);
  });

  it('sends nothing to Instagram in dry run, and leaves the account untouched', async () => {
    const sentBefore = mock.unfollowed.length;
    const requestsBefore = mock.requests.length;
    const quotaBefore = mod.providers.unfollowLimiter.usage().lastDay;

    mod.queue.unfollowQueue.setDryRun(true);
    try {
      const { action } = mod.queue.unfollowQueue.enqueue('1005');
      assert.equal(action.dryRun, true);

      await waitFor(() => mod.db.getAction(action.id)?.status === 'done');

      assert.equal(mock.unfollowed.length, sentBefore, 'no unfollow may reach Instagram');
      assert.equal(mock.requests.length, requestsBefore, 'no request at all may reach Instagram');
      assert.equal(
        mod.db.getAccount('1005')?.status,
        'following',
        'a simulated unfollow must not claim the account was unfollowed',
      );
      assert.equal(
        mod.providers.unfollowLimiter.usage().lastDay,
        quotaBefore,
        'a simulated action consumes no real quota',
      );
    } finally {
      mod.queue.unfollowQueue.setDryRun(false);
    }
  });

  it('really does send the unfollow once dry run is off again', async () => {
    const { action } = mod.queue.unfollowQueue.enqueue('1005');
    assert.equal(action.dryRun, false);
    await waitFor(() => mod.db.getAction(action.id)?.status === 'done');
    assert.ok(mock.unfollowed.includes('1005'), 'the real request must go out');
    assert.equal(mod.db.getAccount('1005')?.status, 'unfollowed');
  });

  it('cancels a queued action so it never runs', async () => {
    // Hold the worker so the action cannot start before we cancel it.
    mod.queue.unfollowQueue.pause('holding so the action cannot start');
    const { action } = mod.queue.unfollowQueue.enqueue('1006');
    try {
      assert.equal(mod.queue.unfollowQueue.cancel(action.id), true);
      assert.equal(mod.db.getAction(action.id)?.status, 'canceled');
      // Cancelling twice is not an error; the second call simply does nothing.
      assert.equal(mod.queue.unfollowQueue.cancel(action.id), false);
    } finally {
      mod.queue.unfollowQueue.resume();
    }

    await mod.ratelimit.sleep(300);
    assert.equal(mod.db.getAction(action.id)?.status, 'canceled', 'a cancelled action must never run');
    assert.equal(mod.db.getAccount('1006')?.status, 'following');
    assert.ok(!mock.unfollowed.includes('1006'));
  });

  it('rejects a session that cannot sign writes, naming the missing cookie', async () => {
    const { assertWritableSession } = await import('../src/providers/web.js');
    assert.throws(
      () => assertWritableSession({ sessionid: 'abc', dsUserId: '42', csrftoken: '', savedAt: 0 }),
      /csrftoken/,
    );
    assert.doesNotThrow(() =>
      assertWritableSession({ sessionid: 'abc', dsUserId: '42', csrftoken: 'token', savedAt: 0 }),
    );
  });

  it('stops the queue and drops pending work when Instagram raises a checkpoint', async () => {
    mock.options.fail = { times: 1, status: 400, body: '{"message":"checkpoint_required"}' };

    const { action } = mod.queue.unfollowQueue.enqueue('1003');
    mod.queue.unfollowQueue.enqueue('1004');

    await waitFor(() => mod.db.getAction(action.id)?.status === 'failed');
    await waitFor(() => mod.queue.unfollowQueue.state.paused);

    const state = mod.queue.unfollowQueue.state;
    assert.equal(state.paused, true);
    assert.match(state.pausedReason ?? '', /checkpoint/i);
    assert.equal(state.queued, 0, 'a checkpoint must clear the rest of the queue, not keep hammering');
    assert.equal(mod.db.getAccount('1003')?.status, 'following', 'a failed unfollow must not be recorded as done');

    mod.providers.readLimiter.clearCooldown();
    mod.queue.unfollowQueue.resume();
  });
});

describe('rate limiter', () => {
  it('enforces the daily cap across restarts by reading from the database', () => {
    const limiter = new mod.ratelimit.RateLimiter({
      bucket: `test-daily-${Date.now()}`,
      maxPerHour: 100,
      maxPerDay: 2,
      minGapMs: 0,
    });

    assert.equal(limiter.check().allowed, true);
    limiter.consume();
    limiter.consume();

    const verdict = limiter.check();
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, 'daily-cap');
  });

  it('holds the minimum gap between consecutive calls', () => {
    const bucket = `test-gap-${Date.now()}`;
    const limiter = new mod.ratelimit.RateLimiter({ bucket, maxPerHour: 100, minGapMs: 60_000 });

    limiter.consume();
    const verdict = limiter.check();
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, 'min-gap');
    assert.ok(verdict.waitMs > 0 && verdict.waitMs <= 60_000);
  });

  it('respects a cooldown regardless of remaining quota', () => {
    const limiter = new mod.ratelimit.RateLimiter({ bucket: `test-cool-${Date.now()}`, maxPerHour: 100, minGapMs: 0 });
    limiter.cooldown(30_000, 'test');
    assert.equal(limiter.check().reason, 'cooldown');
    limiter.clearCooldown();
    assert.equal(limiter.check().allowed, true);
  });
});
