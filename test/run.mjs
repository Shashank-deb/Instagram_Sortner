/**
 * Cross-platform test runner.
 *
 * `node --test test/*.test.ts` only works where the *shell* expands the glob.
 * PowerShell and cmd.exe do not, so Node would receive the literal string and
 * report "Could not find test\*.test.ts". Node can expand a quoted pattern
 * itself, but only on newer versions than this project's engines field allows.
 *
 * So: discover the files here and hand Node an explicit list. Works on every
 * supported Node and every shell, and picks up new test files automatically.
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => path.join(testDir, name));

if (files.length === 0) {
  console.error(`No *.test.ts files found in ${testDir}`);
  process.exit(1);
}

// process.execPath is the running node binary: no PATH lookup, and no
// npx/npx.cmd difference between platforms.
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: path.join(testDir, '..'),
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
