/**
 * Build the distributable zip.
 *
 * The zip is a build artifact, deliberately not committed to git — it is fully
 * derived from the source alongside it, and a committed copy goes stale the
 * moment anyone edits a file. This script regenerates it on demand instead.
 *
 * node_modules is excluded: the recipient runs `npm install`, which is both
 * smaller to send and correct for their platform (better-sqlite3 ships a
 * native binary, so bundling ours would break on a different OS).
 *
 *   npm run package
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const parent = path.dirname(root);
const folder = path.basename(root);
const version = require(path.join(root, 'package.json')).version;
const outPath = path.join(parent, `${folder}-v${version}.zip`);

const EXCLUDE = [
  `${folder}/node_modules/*`,
  `${folder}/data/*`,
  `${folder}/backups/*`,
  `${folder}/exports/*`,
  `${folder}/.git/*`,
  `${folder}/*.log`,
  `${folder}/**/__pycache__/*`,
];

fs.rmSync(outPath, { force: true });

const args = ['-rq', outPath, folder];
for (const e of EXCLUDE) args.push('-x', e);

try {
  execFileSync('zip', args, { cwd: parent, stdio: 'inherit' });
} catch (e) {
  console.error('\nCould not run `zip`. Install it, or archive the folder by hand,');
  console.error('excluding node_modules, data, backups and exports.');
  process.exit(1);
}

const mb = (fs.statSync(outPath).size / 1048576).toFixed(1);
const count = execFileSync('unzip', ['-l', outPath], { encoding: 'utf8' })
  .trim().split('\n').pop().trim().split(/\s+/).slice(-2, -1)[0];

console.log(`Packaged ${count} files → ${outPath} (${mb} MB)`);
console.log('\nThe recipient runs:');
console.log('  npm install');
console.log('  npm start');
