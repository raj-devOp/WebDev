/**
 * Export the whole database as portable SQL.
 *
 * Two reasons this exists, and both come up in sales conversations:
 *
 *  1. "Is my data locked in?" — no. This produces a plain .sql file the client
 *     owns and can load into SQLite, Postgres or MySQL. Being able to say that
 *     and then actually do it in front of them removes a real objection.
 *  2. It is the migration path when a shop outgrows SQLite.
 *
 *   npm run export:sql            → exports to ./exports/barberiq-<date>.sql
 *   npm run export:sql -- out.sql → exports to a path you choose
 */
const fs = require('fs');
const path = require('path');
const { db, DB_PATH } = require('../server/db');

const arg = process.argv[2];
const outPath = arg
  ? path.resolve(arg)
  : path.join(__dirname, '..', 'exports',
    `barberiq-${new Date().toISOString().slice(0, 10)}.sql`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

const lines = [
  '-- BarberIQ data export',
  `-- Generated ${new Date().toISOString()}`,
  `-- Source: ${DB_PATH}`,
  '--',
  '-- Load into SQLite with:  sqlite3 new.db < this-file.sql',
  '-- For Postgres/MySQL the INSERTs port directly; review the DDL for',
  '-- dialect differences (AUTOINCREMENT, partial indexes).',
  '',
  '-- Foreign keys are disabled for the load. customers.referred_by_id is a',
  '-- self-reference, so a row can legitimately point at a customer that has',
  '-- not been inserted yet — with enforcement on, the reload aborts. This must',
  '-- sit OUTSIDE the transaction: PRAGMA foreign_keys is a no-op inside one.',
  'PRAGMA foreign_keys=OFF;',
  '',
  'BEGIN TRANSACTION;',
  '',
];

// Schema first, in creation order so foreign keys resolve.
const objects = db.prepare(`
  SELECT type, name, sql FROM sqlite_master
  WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
  ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END`).all();

for (const o of objects) lines.push(`${o.sql};`);
lines.push('');

const quote = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (Buffer.isBuffer(v)) return `X'${v.toString('hex')}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
};

const tables = db.prepare(`
  SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
  ORDER BY name`).all().map((r) => r.name);

// Parents before children so the foreign keys hold on reload.
const ORDER = [
  'plans', 'shops', 'barbers', 'customers', 'services', 'addons', 'topup_tiers',
  'appointments', 'appointment_addons', 'wallet_accounts', 'wallet_transactions',
  'referrals', 'reminders',
];
const ordered = [...ORDER.filter((t) => tables.includes(t)),
  ...tables.filter((t) => !ORDER.includes(t))];

let totalRows = 0;
for (const table of ordered) {
  const rows = db.prepare(`SELECT * FROM ${table}`).all();
  if (!rows.length) continue;
  lines.push(`-- ${table}: ${rows.length} rows`);
  const cols = Object.keys(rows[0]);
  // Batch inserts keep the file readable and load quickly.
  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const values = chunk.map((r) => `  (${cols.map((c) => quote(r[c])).join(', ')})`);
    lines.push(`INSERT INTO ${table} (${cols.join(', ')}) VALUES`);
    lines.push(`${values.join(',\n')};`);
  }
  lines.push('');
  totalRows += rows.length;
}

lines.push('COMMIT;');
lines.push('');
lines.push('PRAGMA foreign_keys=ON;');
lines.push('-- Confirm nothing was left dangling by the load:');
lines.push('-- PRAGMA foreign_key_check;');
fs.writeFileSync(outPath, lines.join('\n'), 'utf8');

const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
console.log(`Exported ${totalRows.toLocaleString()} rows across ${ordered.length} tables`);
console.log(`  → ${outPath} (${kb} KB)`);
console.log('\nVerify the export loads cleanly:');
console.log(`  sqlite3 /tmp/verify.db < "${outPath}" && echo OK`);
