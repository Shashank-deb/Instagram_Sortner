/**
 * `npm run import -- path/to/instagram-export.zip`
 *
 * Loads a data export into the local database without starting the server.
 */
import { archiveProvider } from '../providers/index.js';
import { syncService } from '../services/sync.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run import -- <path to export .zip or following.json>');
  process.exit(1);
}

const counts = archiveProvider.load(file);
console.log(`Parsed ${counts.following} following and ${counts.followers} followers.`);

const progress = await syncService.run(archiveProvider);
console.log(
  `Imported: ${progress.added} new, ${progress.updated} updated, ${progress.removed} no longer followed.`,
);
process.exit(0);
