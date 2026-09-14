/**
 * `npm run doctor` - answer "is this working?" without guesswork.
 *
 * Checks the environment, the database, the configured provider and the stored
 * session, then says in plain words what the app can and cannot do right now,
 * and what to do next. Safe to run at any time: it reads, it never writes to
 * Instagram, and it does not need the server to be running.
 */
import fs from 'node:fs';
import process from 'node:process';
import { config } from '../config.js';

type Level = 'ok' | 'warn' | 'fail' | 'info';

const MARKS: Record<Level, string> = { ok: '  OK  ', warn: ' WARN ', fail: ' FAIL ', info: ' INFO ' };
const COLORS: Record<Level, string> = { ok: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m', info: '\x1b[36m' };
const RESET = '\x1b[0m';
const useColor = process.stdout.isTTY && !process.env['NO_COLOR'];

const results: Level[] = [];

function line(level: Level, label: string, detail = ''): void {
  results.push(level);
  const mark = useColor ? `${COLORS[level]}[${MARKS[level]}]${RESET}` : `[${MARKS[level]}]`;
  console.log(`${mark} ${label}${detail ? `\n         ${detail}` : ''}`);
}

function heading(text: string): void {
  console.log(`\n${useColor ? '\x1b[1m' : ''}${text}${useColor ? RESET : ''}`);
}

// --- 1. environment --------------------------------------------------------

heading('Environment');

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major > 20 || (major === 20 && minor >= 11)) {
  line('ok', `Node ${process.versions.node}`);
} else {
  line('fail', `Node ${process.versions.node} is too old`, 'Install Node 20.11 or newer, then run npm install again.');
}

if (fs.existsSync('node_modules')) {
  line('ok', 'Dependencies installed');
} else {
  line('fail', 'node_modules is missing', 'Run: npm install');
}

// better-sqlite3 is a native module: it is the one dependency that can install
// and still fail to load, so prove it actually loads rather than assuming.
let dbModuleOk = false;
try {
  await import('better-sqlite3');
  dbModuleOk = true;
  line('ok', 'SQLite driver loads');
} catch (err) {
  line('fail', 'SQLite driver failed to load', `${(err as Error).message}\n         Try: npm rebuild better-sqlite3`);
}

line(fs.existsSync('.env') ? 'ok' : 'info', fs.existsSync('.env') ? 'Reading .env' : 'No .env file (using defaults)');

// --- 2. storage ------------------------------------------------------------

heading('Storage');

if (!dbModuleOk) {
  line('fail', 'Skipping database checks', 'The SQLite driver did not load.');
  summarise();
}

const db = await import('../db/index.js');
line('ok', 'Database opened', config.dbPath);

try {
  fs.accessSync(config.dataDir, fs.constants.W_OK);
  line('ok', 'Data directory is writable', config.dataDir);
} catch {
  line('fail', 'Data directory is not writable', config.dataDir);
}

const mode = (fs.statSync(config.dbPath).mode & 0o777).toString(8);
line(
  mode === '600' ? 'ok' : 'warn',
  `Database file permissions: ${mode}`,
  mode === '600' ? 'Only your user can read the stored session.' : 'Expected 600. The database holds session cookies.',
);

// --- 3. data ---------------------------------------------------------------

heading('Data');

const stats = db.getStats();
const lastSync = db.lastSyncRun();

if (stats.following === 0) {
  line('warn', 'No accounts stored yet', 'Import an export (npm run import -- FILE) or press Sync in live mode.');
} else {
  line('ok', `${stats.following} accounts you follow`, `${stats.nonFollowers} do not follow you back, ${stats.unfollowed} unfollowed via this app`);
}

if (lastSync) {
  const when = new Date(lastSync.startedAt * 1000).toLocaleString();
  if (lastSync.ok === false) {
    line('warn', `Last sync failed (${when})`, lastSync.error ?? 'no error recorded');
  } else {
    line('ok', `Last sync ${when}`, `+${lastSync.added} new, ${lastSync.removed} no longer followed`);
  }
} else {
  line('info', 'No sync has run yet');
}

if (stats.withFollowedAt === 0 && stats.following > 0) {
  line('info', 'No follow dates', 'Only the Instagram data export carries these. Import one to get the "followed" column.');
}

// --- 4. mode ---------------------------------------------------------------

heading('Mode');

const providers = await import('../providers/index.js');
const provider = providers.activeProvider();
line('info', `Provider: ${provider.name}`, provider.name === 'archive' ? 'Reads a data export. Never contacts Instagram.' : "Uses your session against instagram.com's private endpoints.");

const { loadSession } = await import('../session/store.js');
const session = loadSession();

if (config.provider === 'archive') {
  line('ok', 'Read-only: this app cannot change your Instagram account');
} else if (!session) {
  line('fail', 'PROVIDER=web but no session is stored', 'Run: npm run login   (or paste cookies in Settings)');
} else if (!session.csrftoken) {
  line('fail', 'Session has no csrftoken', 'Instagram rejects every unfollow without it. Run npm run login again.');
} else {
  line('ok', `Session stored for ds_user_id ${session.dsUserId}`, 'Unfollowing is possible. Verify it is still valid with: npm run doctor -- --verify');
}

if (config.dryRun) {
  line('ok', 'DRY RUN is on and locked', 'Unfollow buttons send nothing to Instagram. Unset DRY_RUN in .env to allow real unfollows.');
} else if (config.provider === 'web') {
  line('warn', 'Dry run is off', 'Confirmed unfollows are real and permanent. Toggle it in Settings, or set DRY_RUN=true in .env.');
}

// --- 5. safety budget ------------------------------------------------------

heading('Rate limits');

const usage = providers.unfollowLimiter.usage();
line(
  usage.lastDay >= (usage.maxPerDay ?? Infinity) ? 'warn' : 'ok',
  `Unfollows used: ${usage.lastHour}/${usage.maxPerHour} this hour, ${usage.lastDay}/${usage.maxPerDay ?? '∞'} today`,
);
if (usage.cooldownMsRemaining > 0) {
  line('warn', `Cooling down for ${Math.ceil(usage.cooldownMsRemaining / 1000)}s`, usage.cooldownReason ?? '');
}

// --- 6. optional: is the server up? ---------------------------------------

heading('Server');

const base = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`;
try {
  const res = await fetch(`${base}/api/health`, {
    signal: AbortSignal.timeout(2000),
    headers: config.appToken ? { 'x-app-token': config.appToken } : {},
  });
  line(res.ok ? 'ok' : 'warn', `Server responded ${res.status}`, `${base} - open this in a browser`);
} catch {
  line('info', 'Server is not running', `Start it with: npm run dev   then open ${base}`);
}

if (config.host !== '127.0.0.1' && config.host !== 'localhost' && !config.appToken) {
  line('fail', 'Exposed without a token', `HOST=${config.host} and APP_TOKEN is empty: anyone who reaches this port controls your account.`);
}

// --- 7. optional live verification ----------------------------------------

if (process.argv.includes('--verify') && config.provider === 'web' && session) {
  heading('Live check');
  try {
    const who = await providers.webProvider.whoami();
    line('ok', `Instagram accepted the session${who?.username ? ` (@${who.username})` : ''}`);
  } catch (err) {
    line('fail', 'Instagram rejected the session', (err as Error).message);
  }
}

summarise();

function summarise(): never {
  const failed = results.filter((r) => r === 'fail').length;
  const warned = results.filter((r) => r === 'warn').length;

  heading('Summary');
  if (failed > 0) {
    console.log(`${failed} problem(s) to fix${warned ? `, ${warned} warning(s)` : ''}. Work through the FAIL lines above.`);
  } else if (warned > 0) {
    console.log(`Everything essential works. ${warned} thing(s) worth a look above.`);
  } else {
    console.log('Everything checks out.');
  }
  process.exit(failed > 0 ? 1 : 0);
}
