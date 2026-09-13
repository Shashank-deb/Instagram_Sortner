import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import AdmZip from 'adm-zip';

let dataDir: string;
let ArchiveProvider: typeof import('../src/providers/archive.js').ArchiveProvider;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sortner-archive-'));
  process.env['DATA_DIR'] = dataDir;
  process.env['LOG_LEVEL'] = 'error';
  ({ ArchiveProvider } = await import('../src/providers/archive.js'));
});

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function entry(username: string, timestamp: number) {
  return { title: '', string_list_data: [{ href: `https://www.instagram.com/${username}`, value: username, timestamp }] };
}

describe('archive importer', () => {
  it('reads the wrapped-object export shape and keeps follow timestamps', async () => {
    const zip = new AdmZip();
    zip.addFile(
      'connections/followers_and_following/following.json',
      Buffer.from(JSON.stringify({ relationships_following: [entry('alice', 1_600_000_000), entry('bob', 1_700_000_000)] })),
    );
    zip.addFile(
      'connections/followers_and_following/followers_1.json',
      Buffer.from(JSON.stringify([entry('alice', 1_500_000_000)])),
    );

    const provider = new ArchiveProvider();
    const counts = provider.load(zip.toBuffer(), 'export.zip');
    assert.equal(counts.following, 2);
    assert.equal(counts.followers, 1);

    const page = await provider.listFollowing(null);
    assert.equal(page.cursor, null);
    assert.deepEqual(
      page.accounts.map((a) => [a.username, a.followedAt]),
      [
        ['alice', 1_600_000_000],
        ['bob', 1_700_000_000],
      ],
    );
    // No numeric id in the export, so rows are keyed by username until a sync.
    assert.equal(page.accounts[0]!.pk, 'username:alice');
  });

  it('reads the bare-array export shape', async () => {
    const provider = new ArchiveProvider();
    provider.load(Buffer.from(JSON.stringify([entry('carol', 1_650_000_000)])), 'following.json');
    const page = await provider.listFollowing(null);
    assert.equal(page.accounts.length, 1);
    assert.equal(page.accounts[0]!.username, 'carol');
  });

  it('falls back to anchor scraping for the HTML export', async () => {
    const html = '<a href="https://www.instagram.com/dave/">dave</a><a href="https://www.instagram.com/erin">erin</a>';
    const provider = new ArchiveProvider();
    provider.load(Buffer.from(html), 'following.html');
    const page = await provider.listFollowing(null);
    assert.deepEqual(page.accounts.map((a) => a.username), ['dave', 'erin']);
  });

  it('rejects a file with no following list instead of silently importing nothing', () => {
    const provider = new ArchiveProvider();
    assert.throws(() => provider.load(Buffer.from('{"unrelated":[]}'), 'random.json'), /No following list found/);
  });

  it('never claims it can unfollow', async () => {
    const provider = new ArchiveProvider();
    assert.equal(provider.capabilities.unfollow, false);
    await assert.rejects(() => provider.unfollow(), /cannot unfollow/);
  });
});
