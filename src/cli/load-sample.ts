/**
 * `npm run sample` - load the bundled demo export so you can see the dashboard
 * working without waiting days for Instagram to produce your real one.
 *
 * The files in samples/ are in the exact shape Instagram ships, and they are
 * zipped in memory here so this runs through the same code path as a real
 * export rather than a special-cased shortcut. The accounts are invented.
 */
import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { clearAllAccounts, getStats } from '../db/index.js';
import { archiveProvider } from '../providers/index.js';
import { syncService } from '../services/sync.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const samplesDir = path.resolve(here, '..', '..', 'samples');
const force = process.argv.includes('--force');

if (process.argv.includes('--clear')) {
  const removed = clearAllAccounts();
  console.log(`Cleared ${removed.accounts} account(s) and ${removed.actions} queued/past action(s).`);
  console.log(`Database: ${config.dbPath}`);
  console.log('Your stored session, if any, was left untouched.');
  process.exit(0);
}

const stats = getStats();
const existing = stats.following + stats.unfollowed + stats.gone;

if (existing > 0 && !force) {
  console.error(`This database already holds ${existing} account(s): ${config.dbPath}`);
  console.error('');
  console.error('Loading the sample would mix demo accounts into it and mark your real ones as');
  console.error('no longer followed. Pick one:');
  console.error('');
  console.error('  - Try the sample somewhere separate (recommended):');
  console.error('      DATA_DIR=./data-demo npm run sample        (macOS/Linux)');
  console.error('      $env:DATA_DIR="./data-demo"; npm run sample  (PowerShell)');
  console.error('    ...then start the app the same way, and delete the folder when done.');
  console.error('');
  console.error('  - Or overwrite what is stored here: npm run sample -- --force');
  process.exit(1);
}

const zip = new AdmZip();
for (const file of ['following.json', 'followers_1.json']) {
  const source = path.join(samplesDir, file);
  if (!fs.existsSync(source)) {
    console.error(`Missing ${source}. Re-clone or restore the samples/ folder.`);
    process.exit(1);
  }
  zip.addFile(`connections/followers_and_following/${file}`, fs.readFileSync(source));
}

const counts = archiveProvider.load(zip.toBuffer(), 'sample-export.zip');
const progress = await syncService.run(archiveProvider);
const after = getStats();

console.log('');
console.log(`Loaded the demo export: ${counts.following} following, ${counts.followers} followers.`);
console.log(`  ${progress.added} added, ${progress.updated} updated, ${progress.removed} marked no longer followed.`);
console.log(`  ${after.nonFollowers} of them do not follow you back.`);
console.log('');
console.log(`Start the app with "npm run dev" and open http://${config.host}:${config.port}`);
console.log('Try: search "the", the "Doesn\'t follow back" chip, and sort by Date followed.');
console.log('');
console.log('This is invented data. To clear it: npm run sample -- --clear');
process.exit(0);
