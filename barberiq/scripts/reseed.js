/**
 * Rebuild the demo database from scratch.
 *
 * Run this before a client meeting so the figures are the ones you rehearsed
 * with. Safe to run any time — it only touches the local SQLite file.
 *
 *   npm run reseed
 */
const { init, DB_PATH } = require('../server/db');

console.log('Rebuilding demo data…');
const t = Date.now();
init({ force: true });

const { db } = require('../server/db');
const q = (sql) => db.prepare(sql).get();

const completed = q("SELECT COUNT(*) n, COALESCE(SUM(total_pence),0) rev FROM appointments WHERE status='completed'");
const money = (p) => `£${(p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2 })}`;

console.log(`Done in ${Date.now() - t}ms\n`);
console.log(`  Database        ${DB_PATH}`);
console.log(`  Customers       ${q('SELECT COUNT(*) n FROM customers').n}`);
console.log(`  Barbers         ${q('SELECT COUNT(*) n FROM barbers').n}`);
console.log(`  Appointments    ${q('SELECT COUNT(*) n FROM appointments').n} (${completed.n} completed)`);
console.log(`  Revenue (12mo)  ${money(completed.rev)}`);
console.log(`  Wallet txns     ${q('SELECT COUNT(*) n FROM wallet_transactions').n}`);
console.log(`  Referrals       ${q('SELECT COUNT(*) n FROM referrals').n}`);
console.log(`  Reminders       ${q('SELECT COUNT(*) n FROM reminders').n}`);
console.log('\nStart the app with:  npm start');
