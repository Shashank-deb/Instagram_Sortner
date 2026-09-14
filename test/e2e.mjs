/**
 * End-to-end check of the whole stack: a stand-in for instagram.com, the real
 * server, and the real dashboard driven in a real browser.
 *
 *   npm run test:e2e            # screenshots land in a temp dir
 *   npm run test:e2e -- ./shots # ...or wherever you point it
 *
 * Requires Playwright and a Chromium build (`npx playwright install chromium`).
 * Nothing here touches a real Instagram account.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const S = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sortner-shots-'));
const users = Array.from({ length: 5 }, (_, i) => ({
  pk: String(2000 + i), username: `demo_user_${i}`, full_name: `Demo Person ${i}`,
  profile_pic_url: '', is_private: i % 2 === 0, is_verified: i === 1,
}));
const unfollowed = [];

// --- mock instagram --------------------------------------------------------
const ig = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (/friendships\/\d+\/following\//.test(url.pathname)) return json(200, { users, next_max_id: null, status: 'ok' });
  if (/friendships\/\d+\/followers\//.test(url.pathname)) return json(200, { users: users.slice(0, 2), next_max_id: null, status: 'ok' });
  const d = /friendships\/destroy\/([^/]+)\//.exec(url.pathname);
  if (d) { unfollowed.push(d[1]); return json(200, { status: 'ok', friendship_status: { following: false } }); }
  if (url.pathname.includes('web_profile_info')) {
    const u = url.searchParams.get('username');
    return json(200, { data: { user: { full_name: `Demo ${u}`, profile_pic_url: '', edge_followed_by: { count: 4321 }, edge_follow: { count: 87 } } } });
  }
  if (/users\/\d+\/info\//.test(url.pathname)) return json(200, { user: { username: 'demo_me' } });
  json(404, {});
});
await new Promise((r) => ig.listen(0, '127.0.0.1', r));
const igUrl = `http://127.0.0.1:${ig.address().port}`;

// --- app server ------------------------------------------------------------
/** Ask the OS for a free port rather than hardcoding one that a stale run may hold. */
async function freePort() {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

const appPort = await freePort();
const appUrl = `http://127.0.0.1:${appPort}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sortner-e2e-'));
// process.execPath + the tsx loader, rather than `npx`: on Windows npx is a
// .cmd file that spawn() cannot execute without a shell.
const app = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
  env: { ...process.env, DATA_DIR: dataDir, PORT: String(appPort), PROVIDER: 'web', IG_BASE_URL: igUrl,
    IG_SESSIONID: 'x'.repeat(20), IG_DS_USER_ID: '99', IG_CSRFTOKEN: 'csrf',
    READ_MIN_GAP_MS: '0', UNFOLLOW_MIN_GAP_MS: '0', UNFOLLOW_MAX_GAP_MS: '0', LOG_LEVEL: 'error' },
  stdio: 'inherit',
});

const waitFor = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 200)); }
  throw new Error('timeout');
};
await waitFor(async () => fetch(`${appUrl}/api/health`).then((r) => r.ok).catch(() => false));

// --- drive the UI ----------------------------------------------------------
// PW_CHROMIUM_PATH lets CI point at a preinstalled browser instead of downloading one.
const launchOptions = process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {};
const browser = await chromium.launch(launchOptions);
const problems = [];
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });

await page.goto(appUrl, { waitUntil: 'networkidle' });

// Sync pulls the list from the mock.
await page.click('#btn-sync');
await page.waitForSelector('.row', { timeout: 15000 });
await waitFor(async () => (await page.locator('.row').count()) === users.length);
console.log(`✓ sync populated ${await page.locator('.row').count()} rows through the UI`);

// Enriched counts should be visible now.
const firstMeta = await page.locator('.row').first().locator('.meta b').first().textContent();
console.log(`✓ follower count rendered: ${firstMeta}`);

// Unfollow the second row, confirming in the dialog.
const target = page.locator('.row').nth(1);
const handle = (await target.locator('.handle a').textContent()).replace('@', '');
await target.getByRole('button', { name: 'Unfollow' }).click();
await page.waitForSelector('#confirm[open]');
await page.screenshot({ path: `${S}/confirm.png` });
const confirmText = await page.locator('#confirm-text').textContent();
if (!confirmText.includes(handle)) problems.push(`confirm dialog named the wrong account: ${confirmText}`);
await page.click('#confirm-go');

await waitFor(() => unfollowed.length === 1);
console.log(`✓ unfollow reached Instagram for ${handle} (pk ${unfollowed[0]})`);

// It must drop out of the "Following" view on its own, with no manual reload.
await waitFor(async () => {
  const shown = await page.locator('.row .handle a').allTextContents();
  return !shown.includes(`@${handle}`);
}, 20000);
const remaining = await page.locator('.row .handle a').allTextContents();
console.log(`✓ Following list refreshed itself to ${remaining.length} accounts`);
await page.screenshot({ path: `${S}/after-unfollow.png` });

// ...and show up under "Unfollowed" with the right tag.
await page.selectOption('#status', 'unfollowed');
await waitFor(async () => (await page.locator('.tag--done').count()) === 1, 10000);
const unfollowedShown = await page.locator('.row .handle a').allTextContents();
if (!unfollowedShown.includes(`@${handle}`)) problems.push('unfollowed account missing from the Unfollowed view');
console.log('✓ account appears under Unfollowed with a done tag');
await page.screenshot({ path: `${S}/unfollowed-view.png` });
await page.selectOption('#status', 'following');
await page.waitForTimeout(700);

// --- per-row cancel --------------------------------------------------------
// Pause the queue so a queued action stays cancellable long enough to click.
await fetch(`${appUrl}/api/queue/pause`, { method: 'POST' });
const cancelRow = page.locator('.row').first();
const cancelHandle = (await cancelRow.locator('.handle a').textContent()).replace('@', '');
await cancelRow.getByRole('button', { name: 'Unfollow' }).click();
await page.waitForSelector('#confirm[open]');
await page.click('#confirm-go');

await page.waitForSelector('.pending-cell .btn');
await page.screenshot({ path: `${S}/queued-cancel.png` });
await page.locator('.pending-cell .btn').first().click();
await waitFor(async () => (await page.locator('.pending-cell').count()) === 0, 10000);
const sentAfterCancel = unfollowed.length;
await fetch(`${appUrl}/api/queue/resume`, { method: 'POST' });
await page.waitForTimeout(1500);
if (unfollowed.length !== sentAfterCancel) problems.push('a cancelled action was still sent after resuming');
if (unfollowed.includes(cancelHandle)) problems.push('cancelled account was unfollowed anyway');
console.log('✓ per-row cancel stops a queued unfollow from ever being sent');

// --- dry run ---------------------------------------------------------------
await page.click('#btn-settings');
await page.check('#dry-run');
await page.waitForTimeout(500);
await page.click('#settings button[data-close]');
await waitFor(async () => (await page.locator('#mode').textContent()) === 'Dry run', 8000);

const sentBeforeDryRun = unfollowed.length;
const dryRow = page.locator('.row').first();
const dryHandle = (await dryRow.locator('.handle a').textContent()).replace('@', '');
await dryRow.getByRole('button', { name: 'Unfollow' }).click();
await page.waitForSelector('#confirm[open]');
const dryTitle = await page.locator('#confirm-title').textContent();
if (!/simulate/i.test(dryTitle)) problems.push(`dry-run dialog still says "${dryTitle}"`);
await page.screenshot({ path: `${S}/dry-run-confirm.png` });
await page.click('#confirm-go');
await page.waitForTimeout(2500);

if (unfollowed.length !== sentBeforeDryRun) problems.push('DRY RUN SENT A REAL UNFOLLOW');
const stillListed = await page.locator('.row .handle a').allTextContents();
if (!stillListed.includes(`@${dryHandle}`)) problems.push('dry run removed the account from Following');
await page.screenshot({ path: `${S}/dry-run-after.png` });
console.log(`✓ dry run sent nothing and left @${dryHandle} followed`);

await page.click('#btn-settings');
await page.uncheck('#dry-run');
await page.waitForTimeout(500);
await page.click('#settings button[data-close]');
await waitFor(async () => (await page.locator('#mode').textContent()) === 'Live', 8000);
console.log('✓ mode indicator tracks dry run / live');

// Refusing at the dialog must not queue anything.
await page.locator('.row').first().getByRole('button', { name: 'Unfollow' }).click();
await page.waitForSelector('#confirm[open]');
await page.click('#confirm button[data-close]');
await page.waitForTimeout(1200);
if (unfollowed.length !== 1) problems.push('cancelling the confirmation still sent an unfollow');
console.log('✓ cancelling the confirmation sends nothing');

await browser.close();
app.kill('SIGTERM');
ig.close();
fs.rmSync(dataDir, { recursive: true, force: true });

if (problems.length) { console.error('PROBLEMS:\n' + problems.join('\n')); process.exit(1); }
console.log('\nend-to-end unfollow flow verified');
process.exit(0);
