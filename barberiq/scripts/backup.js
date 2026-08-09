/**
 * Take a consistent backup of the live database.
 *
 * Uses SQLite's online backup API rather than copying the file, because a
 * plain `cp` of a database with active WAL writes can produce a corrupt copy.
 *
 *   npm run backup
 */
const fs = require('fs');
const path = require('path');
const { db, DB_PATH } = require('../server/db');

const dir = path.join(__dirname, '..', 'backups');
fs.mkdirSync(dir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = path.join(dir, `barberiq-${stamp}.db`);

db.backup(out)
  .then(() => {
    const mb = (fs.statSync(out).size / 1048576).toFixed(2);
    console.log(`Backed up ${DB_PATH}`);
    console.log(`  → ${out} (${mb} MB)`);

    // Keep the last 14 backups; beyond that they are just disk.
    const files = fs.readdirSync(dir)
      .filter((f) => f.startsWith('barberiq-') && f.endsWith('.db'))
      .sort()
      .reverse();
    const stale = files.slice(14);
    for (const f of stale) fs.unlinkSync(path.join(dir, f));
    if (stale.length) console.log(`  Pruned ${stale.length} old backup(s)`);
  })
  .catch((e) => {
    console.error('Backup failed:', e.message);
    process.exit(1);
  });
