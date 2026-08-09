/**
 * Database bootstrap.
 *
 * Opens (or creates) the SQLite file, applies schema.sql, and seeds demo data
 * the first time it runs. Safe to call repeatedly — schema.sql is idempotent
 * and seeding is skipped once a shop exists.
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'barberiq.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
}

function isSeeded() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM shops').get();
  return row.n > 0;
}

function init({ force = false } = {}) {
  migrate();
  if (force || !isSeeded()) {
    if (force) wipe();
    require('./seed').seed(db);
    return { seeded: true };
  }
  return { seeded: false };
}

function wipe() {
  // Order matters: children before parents.
  const tables = [
    'wallet_transactions', 'wallet_accounts', 'appointment_addons',
    'reminders', 'referrals', 'appointments', 'addons', 'services',
    'topup_tiers', 'customers', 'barbers', 'shops', 'plans',
  ];
  db.pragma('foreign_keys = OFF');
  for (const t of tables) db.exec(`DELETE FROM ${t}`);
  db.exec("DELETE FROM sqlite_sequence");
  db.pragma('foreign_keys = ON');
}

module.exports = { db, init, wipe, DB_PATH };
