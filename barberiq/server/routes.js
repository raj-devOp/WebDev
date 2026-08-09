/**
 * REST API.
 *
 * Conventions:
 *  - All money in and out of this API is in PENCE (integers).
 *  - Anything that moves money runs inside a SQLite transaction. Wallet spend
 *    and booking creation are a single unit of work: if the slot turns out to
 *    be taken, the debit must not survive.
 *  - Validation happens before the transaction opens, so we fail with a clean
 *    400 rather than a rolled-back half-action.
 */
const express = require('express');
const { db } = require('./db');
const AI = require('./intelligence');

const router = express.Router();
const SHOP_ID = 1; // single-tenant demo; the schema is already multi-tenant

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const asInt = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : NaN);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

function requireCustomer(req, res, next) {
  const id = asInt(req.params.customerId ?? req.body.customer_id);
  if (!Number.isFinite(id)) return bad(res, 'A valid customer id is required.');
  const c = db.prepare('SELECT * FROM customers WHERE id=? AND shop_id=?').get(id, SHOP_ID);
  if (!c) return bad(res, 'Customer not found.', 404);
  req.customer = c;
  next();
}

function walletOf(customerId) {
  let w = db.prepare('SELECT * FROM wallet_accounts WHERE customer_id=?').get(customerId);
  if (!w) {
    const id = db.prepare(
      'INSERT INTO wallet_accounts (customer_id) VALUES (?)').run(customerId).lastInsertRowid;
    w = db.prepare('SELECT * FROM wallet_accounts WHERE id=?').get(id);
  }
  return w;
}

// ===========================================================================
// BOOTSTRAP — everything the client needs on first paint
// ===========================================================================
router.get('/bootstrap', (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(SHOP_ID);
  const plans = db.prepare('SELECT * FROM plans ORDER BY sort_order').all()
    .map((p) => ({ ...p, features: JSON.parse(p.features_json) }));

  const customers = db.prepare(`
    SELECT c.id, c.name, c.avatar_emoji, c.email,
           COALESCE(w.cash_pence,0)+COALESCE(w.bonus_pence,0) AS wallet_balance_pence,
           (SELECT COUNT(*) FROM appointments a
              WHERE a.customer_id=c.id AND a.status='completed') AS visits
    FROM customers c LEFT JOIN wallet_accounts w ON w.customer_id=c.id
    WHERE c.shop_id=? ORDER BY visits DESC, c.name`).all(SHOP_ID);

  const trialDaysLeft = shop.trial_ends_at
    ? Math.max(0, Math.ceil((AI.toDate(shop.trial_ends_at) - Date.now()) / 86400000))
    : null;

  res.json({ shop: { ...shop, trial_days_left: trialDaysLeft }, plans, customers });
});

// ===========================================================================
// A. WALLET
// ===========================================================================
router.get('/wallet/:customerId', requireCustomer, (req, res) => {
  const w = walletOf(req.customer.id);
  const tiers = db.prepare(
    'SELECT * FROM topup_tiers WHERE shop_id=? AND active=1 ORDER BY pay_pence').all(SHOP_ID);
  const tx = db.prepare(`
    SELECT * FROM wallet_transactions WHERE wallet_id=? ORDER BY created_at DESC, id DESC LIMIT 40`
  ).all(w.id);

  // How much they have actually gained by using the wallet rather than paying
  // per visit. This one number is what drives top-up adoption.
  const saved = w.lifetime_bonus_pence;
  const cycle = AI.predictCycle(db, req.customer.id);
  const avg = db.prepare(`
    SELECT CAST(COALESCE(AVG(total_pence),0) AS INTEGER) v FROM appointments
    WHERE customer_id=? AND status='completed'`).get(req.customer.id).v;

  // Projected annual benefit at their observed visit rate and best tier bonus.
  const visitsPerYear = cycle.cycleDays ? Math.round(365 / cycle.cycleDays) : 12;
  const bestTier = tiers.reduce((b, t) =>
    (t.bonus_pence / t.pay_pence > (b ? b.bonus_pence / b.pay_pence : 0) ? t : b), null);
  const bonusRate = bestTier ? bestTier.bonus_pence / bestTier.pay_pence : 0.1;
  const projected = Math.round(avg * visitsPerYear * bonusRate);

  res.json({
    wallet: {
      cash_pence: w.cash_pence,
      bonus_pence: w.bonus_pence,
      balance_pence: w.cash_pence + w.bonus_pence,
      lifetime_topup_pence: w.lifetime_topup_pence,
      lifetime_bonus_pence: w.lifetime_bonus_pence,
    },
    tiers,
    transactions: tx,
    insight: {
      saved_pence: saved,
      avg_ticket_pence: avg,
      visits_per_year: visitsPerYear,
      projected_annual_bonus_pence: projected,
      headline: saved > 0
        ? `You've earned ${fmt(saved)} in bonus credit so far.`
        : `Top up £50 and you'll walk out with £55 to spend.`,
      subline: avg > 0
        ? `At your rate of about ${visitsPerYear} visits a year, topping up in `
          + `${bestTier ? fmt(bestTier.pay_pence) : '£100'} blocks is worth roughly `
          + `${fmt(projected)} a year in free credit.`
        : `Bonus credit never expires and can be spent on any service or add-on.`,
    },
  });
});

function fmt(p) { return `£${(p / 100).toFixed(2)}`; }

router.post('/wallet/:customerId/topup', requireCustomer, (req, res) => {
  const tierId = asInt(req.body.tier_id);
  let pay, bonus, label;

  if (Number.isFinite(tierId)) {
    const t = db.prepare('SELECT * FROM topup_tiers WHERE id=? AND shop_id=?').get(tierId, SHOP_ID);
    if (!t) return bad(res, 'Unknown top-up tier.');
    pay = t.pay_pence; bonus = t.bonus_pence; label = t.label;
  } else {
    pay = asInt(req.body.pay_pence);
    if (!Number.isFinite(pay) || pay < 500) return bad(res, 'Minimum top-up is £5.00.');
    if (pay > 100000) return bad(res, 'Maximum single top-up is £1,000.00.');
    // Custom amounts earn the bonus of the highest tier they clear.
    const t = db.prepare(`
      SELECT * FROM topup_tiers WHERE shop_id=? AND active=1 AND pay_pence<=?
      ORDER BY pay_pence DESC LIMIT 1`).get(SHOP_ID, pay);
    const rate = t ? t.bonus_pence / t.pay_pence : 0;
    bonus = Math.round(pay * rate);
    label = t ? `${Math.round(rate * 100)}% bonus` : 'Top-up';
  }

  const w = walletOf(req.customer.id);

  const run = db.transaction(() => {
    const cash = w.cash_pence + pay;
    const bns = w.bonus_pence + bonus;
    db.prepare(`UPDATE wallet_accounts SET cash_pence=?, bonus_pence=?,
        lifetime_topup_pence=lifetime_topup_pence+?, lifetime_bonus_pence=lifetime_bonus_pence+?
        WHERE id=?`).run(cash, bns, pay, bonus, w.id);

    const insTx = db.prepare(`
      INSERT INTO wallet_transactions (wallet_id,kind,amount_pence,bucket,cash_delta,bonus_delta,
        balance_after,description) VALUES (?,?,?,?,?,?,?,?)`);
    insTx.run(w.id, 'topup', pay, 'cash', pay, 0, cash + bns, `Top-up ${fmt(pay)}`);
    if (bonus > 0) {
      insTx.run(w.id, 'bonus', bonus, 'bonus', 0, bonus, cash + bns,
        `Bonus credit ${fmt(bonus)}${label ? ` · ${label}` : ''}`);
    }
    return { cash, bonus: bns };
  });

  const out = run();
  res.status(201).json({
    ok: true,
    paid_pence: pay,
    bonus_pence: bonus,
    credited_pence: pay + bonus,
    balance_pence: out.cash + out.bonus,
    message: bonus > 0
      ? `Paid ${fmt(pay)} — ${fmt(pay + bonus)} added to your wallet.`
      : `${fmt(pay)} added to your wallet.`,
  });
});

// ===========================================================================
// B. REMINDERS
// ===========================================================================
router.get('/reminders/:customerId', requireCustomer, (req, res) => {
  const cycle = AI.predictCycle(db, req.customer.id);
  const risk = AI.churnRisk(db, req.customer.id, cycle);
  const rows = db.prepare(`
    SELECT r.*, (SELECT COUNT(*) FROM appointments a
                   WHERE a.customer_id=r.customer_id AND a.status='booked'
                     AND a.starts_at > datetime('now')) AS has_upcoming
    FROM reminders r WHERE r.customer_id=? ORDER BY r.send_on ASC`).all(req.customer.id);

  const upcoming = db.prepare(`
    SELECT a.*, s.name AS service_name, s.icon AS service_icon, b.name AS barber_name,
           b.avatar_emoji AS barber_emoji
    FROM appointments a
    JOIN services s ON s.id=a.service_id JOIN barbers b ON b.id=a.barber_id
    WHERE a.customer_id=? AND a.status='booked' AND a.starts_at > datetime('now')
    ORDER BY a.starts_at ASC`).all(req.customer.id);

  const history = db.prepare(`
    SELECT a.starts_at, a.total_pence, s.name AS service_name, s.icon AS service_icon,
           b.nickname AS barber_name
    FROM appointments a
    JOIN services s ON s.id=a.service_id JOIN barbers b ON b.id=a.barber_id
    WHERE a.customer_id=? AND a.status='completed'
    ORDER BY a.starts_at DESC LIMIT 8`).all(req.customer.id);

  res.json({ cycle, risk, reminders: rows, upcoming, history,
             preferences: {
               sms: !!req.customer.notify_sms,
               email: !!req.customer.notify_email,
               push: !!req.customer.notify_push,
             } });
});

router.post('/reminders/:id/action', (req, res) => {
  const id = asInt(req.params.id);
  const action = String(req.body.action || '');
  const r = db.prepare('SELECT * FROM reminders WHERE id=?').get(id);
  if (!r) return bad(res, 'Reminder not found.', 404);

  if (action === 'snooze') {
    const days = Math.min(30, Math.max(1, asInt(req.body.days) || 7));
    const next = AI.iso(AI.addDays(new Date(), days));
    db.prepare("UPDATE reminders SET status='snoozed', send_on=? WHERE id=?").run(next, id);
    return res.json({ ok: true, status: 'snoozed', send_on: next });
  }
  if (action === 'dismiss') {
    db.prepare("UPDATE reminders SET status='dismissed' WHERE id=?").run(id);
    return res.json({ ok: true, status: 'dismissed' });
  }
  if (action === 'send') {
    // In production this hands off to an SMS/email provider. Here we mark it
    // sent so the owner can see the pipeline working end to end.
    db.prepare("UPDATE reminders SET status='sent', sent_at=datetime('now') WHERE id=?").run(id);
    return res.json({ ok: true, status: 'sent' });
  }
  return bad(res, "action must be one of: snooze, dismiss, send.");
});

router.put('/reminders/:customerId/preferences', requireCustomer, (req, res) => {
  const b = (v) => (v ? 1 : 0);
  db.prepare('UPDATE customers SET notify_sms=?, notify_email=?, notify_push=? WHERE id=?')
    .run(b(req.body.sms), b(req.body.email), b(req.body.push), req.customer.id);
  res.json({ ok: true });
});

// Rebuild the whole reminder schedule (what a nightly cron would call).
router.post('/reminders/rebuild', (req, res) => {
  const n = AI.rebuildReminders(db, SHOP_ID);
  res.json({ ok: true, scheduled: n });
});

// ===========================================================================
// C. BOOKING + ADD-ONS
// ===========================================================================
router.get('/catalogue', (req, res) => {
  const services = db.prepare(
    'SELECT * FROM services WHERE shop_id=? AND active=1 ORDER BY sort_order').all(SHOP_ID);
  const barbers = db.prepare(
    'SELECT * FROM barbers WHERE shop_id=? AND active=1 ORDER BY name').all(SHOP_ID);
  res.json({ services, barbers });
});

router.get('/addons/recommend', (req, res) => {
  const customerId = asInt(req.query.customer_id);
  const serviceId = asInt(req.query.service_id);
  const addons = AI.recommendAddons(db, {
    shopId: SHOP_ID,
    customerId: Number.isFinite(customerId) ? customerId : null,
    serviceId: Number.isFinite(serviceId) ? serviceId : null,
  });
  res.json({ addons });
});

// Free slots for a given date, per barber.
router.get('/slots', (req, res) => {
  const date = String(req.query.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad(res, 'date must be YYYY-MM-DD.');
  const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(SHOP_ID);
  const barbers = db.prepare(
    'SELECT id,name,nickname,avatar_emoji FROM barbers WHERE shop_id=? AND active=1').all(SHOP_ID);

  const busy = new Set(db.prepare(`
    SELECT barber_id, starts_at FROM appointments
    WHERE shop_id=? AND date(starts_at)=? AND status IN ('booked','completed')`)
    .all(SHOP_ID, date).map((r) => `${r.barber_id}|${String(r.starts_at).slice(11, 16)}`));

  const [oh, om] = shop.opens_at.split(':').map(Number);
  const [ch] = shop.closes_at.split(':').map(Number);
  const step = shop.slot_minutes;
  const now = new Date();

  const slots = [];
  for (let mins = oh * 60 + om; mins < ch * 60; mins += step) {
    const hh = String(Math.floor(mins / 60)).padStart(2, '0');
    const mm = String(mins % 60).padStart(2, '0');
    const time = `${hh}:${mm}`;
    const when = new Date(`${date}T${time}:00Z`);
    const free = barbers.filter((b) => !busy.has(`${b.id}|${time}`));
    slots.push({
      time,
      in_past: when < now,
      available_barbers: free.map((b) => ({ id: b.id, name: b.nickname || b.name, emoji: b.avatar_emoji })),
    });
  }
  res.json({ date, closed: new Date(`${date}T12:00:00Z`).getUTCDay() === 0, slots });
});

router.post('/bookings', (req, res) => {
  const customerId = asInt(req.body.customer_id);
  const barberId = asInt(req.body.barber_id);
  const serviceId = asInt(req.body.service_id);
  const startsAt = String(req.body.starts_at || '').trim();
  const addonIds = Array.isArray(req.body.addon_ids) ? req.body.addon_ids.map(asInt).filter(Number.isFinite) : [];
  const payWithWallet = !!req.body.pay_with_wallet;

  const customer = db.prepare('SELECT * FROM customers WHERE id=? AND shop_id=?').get(customerId, SHOP_ID);
  if (!customer) return bad(res, 'Customer not found.', 404);
  const service = db.prepare('SELECT * FROM services WHERE id=? AND shop_id=?').get(serviceId, SHOP_ID);
  if (!service) return bad(res, 'Service not found.', 404);
  const barber = db.prepare('SELECT * FROM barbers WHERE id=? AND shop_id=?').get(barberId, SHOP_ID);
  if (!barber) return bad(res, 'Barber not found.', 404);
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(startsAt)) {
    return bad(res, 'starts_at must look like YYYY-MM-DD HH:MM.');
  }
  const normalised = startsAt.replace('T', ' ').slice(0, 19).padEnd(19, ':00').slice(0, 19);
  if (AI.toDate(normalised) < new Date(Date.now() - 60000)) {
    return bad(res, 'That slot is in the past.');
  }

  const clash = db.prepare(`
    SELECT id FROM appointments WHERE barber_id=? AND starts_at=? AND status IN ('booked','completed')`
  ).get(barberId, normalised);
  if (clash) return bad(res, `${barber.nickname || barber.name} is already booked at that time.`, 409);

  const chosenAddons = addonIds.length
    ? db.prepare(`SELECT * FROM addons WHERE shop_id=? AND active=1 AND id IN (${
        addonIds.map(() => '?').join(',')})`).all(SHOP_ID, ...addonIds)
    : [];

  const addonsPence = chosenAddons.reduce((s, a) => s + a.price_pence, 0);
  const servicePence = service.price_pence;
  const duration = service.duration_min + chosenAddons.reduce((s, a) => s + a.duration_min, 0);
  const total = servicePence + addonsPence;

  const w = walletOf(customerId);
  const available = w.cash_pence + w.bonus_pence;
  if (payWithWallet && available < total) {
    return bad(res, `Wallet balance is ${fmt(available)} — ${fmt(total - available)} short. `
      + `Top up or pay in the chair.`);
  }

  const run = db.transaction(() => {
    const apptId = db.prepare(`
      INSERT INTO appointments (shop_id,customer_id,barber_id,service_id,starts_at,duration_min,
        status,service_pence,addons_pence,discount_pence,total_pence,paid_with,source)
      VALUES (?,?,?,?,?,?,'booked',?,?,0,?,?,?)`).run(
      SHOP_ID, customerId, barberId, serviceId, normalised, duration,
      servicePence, addonsPence, total,
      payWithWallet ? 'wallet' : 'unpaid',
      String(req.body.source || 'app'),
    ).lastInsertRowid;

    const insAA = db.prepare(
      'INSERT INTO appointment_addons (appointment_id,addon_id,price_pence) VALUES (?,?,?)');
    for (const a of chosenAddons) insAA.run(apptId, a.id, a.price_pence);

    if (payWithWallet && total > 0) {
      // Bonus credit is consumed before cash: it retires promotional liability
      // first and keeps genuinely refundable cash on the account longer.
      const fromBonus = Math.min(w.bonus_pence, total);
      const fromCash = total - fromBonus;
      const newBonus = w.bonus_pence - fromBonus;
      const newCash = w.cash_pence - fromCash;
      db.prepare('UPDATE wallet_accounts SET cash_pence=?, bonus_pence=? WHERE id=?')
        .run(newCash, newBonus, w.id);
      db.prepare(`INSERT INTO wallet_transactions (wallet_id,kind,amount_pence,bucket,
        cash_delta,bonus_delta,balance_after,appointment_id,description)
        VALUES (?,'spend',?,'split',?,?,?,?,?)`).run(
        w.id, -total, -fromCash, -fromBonus, newCash + newBonus, apptId,
        `${service.name}${chosenAddons.length ? ` + ${chosenAddons.length} add-on(s)` : ''}`);
    }

    // Any scheduled reminder for this customer has done its job.
    db.prepare(`UPDATE reminders SET status='booked', resulting_appointment_id=?
      WHERE customer_id=? AND status IN ('scheduled','sent','snoozed')`).run(apptId, customerId);

    return apptId;
  });

  const apptId = run();
  const appt = db.prepare(`
    SELECT a.*, s.name AS service_name, s.icon AS service_icon,
           b.name AS barber_name, b.nickname AS barber_nickname, b.avatar_emoji AS barber_emoji
    FROM appointments a JOIN services s ON s.id=a.service_id JOIN barbers b ON b.id=a.barber_id
    WHERE a.id=?`).get(apptId);

  res.status(201).json({
    ok: true,
    appointment: { ...appt, addons: chosenAddons },
    charged_to_wallet: payWithWallet ? total : 0,
    wallet_balance_pence: (() => { const x = walletOf(customerId); return x.cash_pence + x.bonus_pence; })(),
  });
});

router.get('/bookings/:customerId', requireCustomer, (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, s.name AS service_name, s.icon AS service_icon,
           b.nickname AS barber_name, b.avatar_emoji AS barber_emoji
    FROM appointments a JOIN services s ON s.id=a.service_id JOIN barbers b ON b.id=a.barber_id
    WHERE a.customer_id=? ORDER BY a.starts_at DESC LIMIT 30`).all(req.customer.id);
  const withAddons = rows.map((r) => ({
    ...r,
    addons: db.prepare(`SELECT ad.name, ad.icon, aa.price_pence FROM appointment_addons aa
      JOIN addons ad ON ad.id=aa.addon_id WHERE aa.appointment_id=?`).all(r.id),
  }));
  res.json({ appointments: withAddons });
});

router.post('/bookings/:id/cancel', (req, res) => {
  const id = asInt(req.params.id);
  const appt = db.prepare("SELECT * FROM appointments WHERE id=? AND status='booked'").get(id);
  if (!appt) return bad(res, 'No open booking with that id.', 404);

  const run = db.transaction(() => {
    db.prepare("UPDATE appointments SET status='cancelled' WHERE id=?").run(id);
    // Refund to the wallet if it was prepaid, reversing the exact split taken.
    if (appt.paid_with === 'wallet' && appt.total_pence > 0) {
      const spend = db.prepare(`SELECT * FROM wallet_transactions
        WHERE appointment_id=? AND kind='spend' ORDER BY id DESC LIMIT 1`).get(id);
      const w = walletOf(appt.customer_id);
      const cashBack = spend ? -spend.cash_delta : appt.total_pence;
      const bonusBack = spend ? -spend.bonus_delta : 0;
      const newCash = w.cash_pence + cashBack;
      const newBonus = w.bonus_pence + bonusBack;
      db.prepare('UPDATE wallet_accounts SET cash_pence=?, bonus_pence=? WHERE id=?')
        .run(newCash, newBonus, w.id);
      db.prepare(`INSERT INTO wallet_transactions (wallet_id,kind,amount_pence,bucket,
        cash_delta,bonus_delta,balance_after,appointment_id,description)
        VALUES (?,'refund',?,'split',?,?,?,?,'Cancelled booking refunded')`).run(
        w.id, appt.total_pence, cashBack, bonusBack, newCash + newBonus, id);
    }
  });
  run();
  res.json({ ok: true });
});

// Mark an appointment done. This is the trigger that qualifies a referral —
// deliberately NOT on booking, so fake sign-ups cannot mint credit.
router.post('/bookings/:id/complete', (req, res) => {
  const id = asInt(req.params.id);
  const appt = db.prepare("SELECT * FROM appointments WHERE id=? AND status='booked'").get(id);
  if (!appt) return bad(res, 'No open booking with that id.', 404);

  const rewarded = [];
  const run = db.transaction(() => {
    db.prepare("UPDATE appointments SET status='completed' WHERE id=?").run(id);

    const pending = db.prepare(`
      SELECT * FROM referrals
      WHERE referred_id=? AND status IN ('signed_up','sent') AND shop_id=?`)
      .get(appt.customer_id, SHOP_ID);

    if (pending) {
      const isFirst = db.prepare(`
        SELECT COUNT(*) n FROM appointments
        WHERE customer_id=? AND status='completed'`).get(appt.customer_id).n;
      if (isFirst === 1) {
        db.prepare(`UPDATE referrals SET status='rewarded',
          qualifying_appointment_id=?, rewarded_at=datetime('now') WHERE id=?`).run(id, pending.id);
        for (const side of [pending.referrer_id, pending.referred_id]) {
          const w = walletOf(side);
          const nb = w.bonus_pence + pending.reward_pence;
          db.prepare('UPDATE wallet_accounts SET bonus_pence=? WHERE id=?').run(nb, w.id);
          db.prepare(`INSERT INTO wallet_transactions (wallet_id,kind,amount_pence,bucket,
            cash_delta,bonus_delta,balance_after,description)
            VALUES (?,'referral_credit',?,'bonus',0,?,?,?)`).run(
            w.id, pending.reward_pence, pending.reward_pence,
            w.cash_pence + nb, `Referral reward ${fmt(pending.reward_pence)}`);
          rewarded.push(side);
        }
      }
    }
  });
  run();
  res.json({ ok: true, referral_rewarded_customer_ids: rewarded });
});

// ===========================================================================
// D. REFERRAL
// ===========================================================================
router.get('/referral/:customerId', requireCustomer, (req, res) => {
  const c = req.customer;
  const rows = db.prepare(`
    SELECT r.*, cu.name AS referred_name, cu.avatar_emoji AS referred_emoji
    FROM referrals r LEFT JOIN customers cu ON cu.id=r.referred_id
    WHERE r.referrer_id=? ORDER BY r.created_at DESC`).all(c.id);

  const earned = rows.filter((r) => r.status === 'rewarded')
    .reduce((s, r) => s + r.reward_pence, 0);
  const pending = rows.filter((r) => ['sent', 'signed_up'].includes(r.status)).length;

  // Shop-wide leaderboard: social proof is what makes a referral scheme spread.
  const leaderboard = db.prepare(`
    SELECT c.id, c.name, c.avatar_emoji,
           COUNT(r.id) AS rewarded,
           COUNT(r.id) * 1000 AS earned_pence
    FROM customers c JOIN referrals r ON r.referrer_id=c.id AND r.status='rewarded'
    WHERE c.shop_id=? GROUP BY c.id ORDER BY rewarded DESC, c.name LIMIT 8`).all(SHOP_ID);

  const myRank = db.prepare(`
    SELECT COUNT(*)+1 AS rank FROM (
      SELECT referrer_id, COUNT(*) n FROM referrals
      WHERE shop_id=? AND status='rewarded' GROUP BY referrer_id HAVING n > (
        SELECT COUNT(*) FROM referrals WHERE referrer_id=? AND status='rewarded'))`)
    .get(SHOP_ID, c.id).rank;

  res.json({
    code: c.referral_code,
    share_url: `${req.protocol}://${req.get('host')}/?ref=${c.referral_code}`,
    reward_pence: 1000,
    referrals: rows,
    stats: {
      total: rows.length,
      rewarded: rows.filter((r) => r.status === 'rewarded').length,
      pending,
      earned_pence: earned,
      rank: myRank,
    },
    leaderboard,
    terms: [
      'Your friend gets £10 credit when they sign up with your code.',
      'You get £10 credit once they have completed their first paid visit.',
      'Credit lands in both wallets automatically — nothing to claim.',
      'One reward per new customer. Existing customers do not qualify.',
    ],
  });
});

router.post('/referral/:customerId/invite', requireCustomer, (req, res) => {
  const contact = String(req.body.contact || '').trim();
  if (contact.length < 5) return bad(res, 'Enter a mobile number or email address.');

  // Do not let someone invite a contact that is already a customer here.
  const existing = db.prepare(
    'SELECT id FROM customers WHERE shop_id=? AND (email=? OR phone=?)').get(SHOP_ID, contact, contact);
  if (existing) return bad(res, 'That person is already a customer, so the invite would not qualify.');

  const dupe = db.prepare(`
    SELECT id FROM referrals WHERE referrer_id=? AND invited_contact=? AND status IN ('sent','signed_up')`
  ).get(req.customer.id, contact);
  if (dupe) return bad(res, 'You have already invited that contact.');

  const id = db.prepare(`
    INSERT INTO referrals (shop_id,referrer_id,code,invited_contact,status,reward_pence)
    VALUES (?,?,?,?,'sent',1000)`).run(SHOP_ID, req.customer.id, req.customer.referral_code, contact)
    .lastInsertRowid;

  res.status(201).json({
    ok: true, referral_id: id,
    message: `Invite sent to ${contact}. You'll both get £10 once they've had their first cut.`,
  });
});

// Simulate the invited friend signing up and coming in — this is the demo
// button that proves the two-sided reward actually pays out.
router.post('/referral/:id/simulate-signup', (req, res) => {
  const id = asInt(req.params.id);
  const ref = db.prepare("SELECT * FROM referrals WHERE id=? AND status='sent'").get(id);
  if (!ref) return bad(res, 'No open invitation with that id.', 404);

  const name = String(req.body.name || 'New Friend').trim().slice(0, 60) || 'New Friend';
  const out = db.transaction(() => {
    const code = 'R' + Math.random().toString(36).slice(2, 7).toUpperCase();
    const newId = db.prepare(`
      INSERT INTO customers (shop_id,name,email,phone,avatar_emoji,referral_code,referred_by_id)
      VALUES (?,?,?,?,?,?,?)`).run(
      SHOP_ID, name, `${name.toLowerCase().replace(/[^a-z]+/g, '.')}.${Date.now()}@example.com`,
      ref.invited_contact, '🆕', code, ref.referrer_id).lastInsertRowid;
    db.prepare('INSERT INTO wallet_accounts (customer_id) VALUES (?)').run(newId);
    db.prepare("UPDATE referrals SET referred_id=?, status='signed_up' WHERE id=?").run(newId, id);
    return newId;
  })();

  res.status(201).json({
    ok: true, customer_id: out,
    message: `${name} signed up. Reward unlocks after their first completed visit — `
      + `book and complete one to release both £10 credits.`,
  });
});

// ===========================================================================
// E. OWNER DASHBOARD
// ===========================================================================
function rangeClause(range) {
  switch (range) {
    case 'today': return "date(a.starts_at) = date('now')";
    case 'week':  return "a.starts_at >= date('now','-6 day')";
    case 'month': return "a.starts_at >= date('now','-29 day')";
    case 'year':  return "a.starts_at >= date('now','-364 day')";
    default:      return "date(a.starts_at) = date('now')";
  }
}

router.get('/dashboard', (req, res) => {
  const range = ['today', 'week', 'month', 'year'].includes(req.query.range) ? req.query.range : 'today';
  const where = rangeClause(range);

  const totals = db.prepare(`
    SELECT
      COUNT(*) AS cuts,
      COALESCE(SUM(a.total_pence),0)   AS revenue_pence,
      COALESCE(SUM(a.service_pence),0) AS service_pence,
      COALESCE(SUM(a.addons_pence),0)  AS addons_pence,
      CAST(COALESCE(AVG(a.total_pence),0) AS INTEGER) AS avg_ticket_pence,
      SUM(CASE WHEN a.addons_pence>0 THEN 1 ELSE 0 END) AS with_addons
    FROM appointments a
    WHERE a.shop_id=? AND a.status='completed' AND ${where}`).get(SHOP_ID);

  const booked = db.prepare(`
    SELECT COUNT(*) n FROM appointments a
    WHERE a.shop_id=? AND a.status='booked' AND ${where}`).get(SHOP_ID).n;

  const noShows = db.prepare(`
    SELECT COUNT(*) n FROM appointments a
    WHERE a.shop_id=? AND a.status='no_show' AND ${where}`).get(SHOP_ID).n;

  // Previous equivalent period, for the trend arrows.
  const prevWhere = {
    today: "date(a.starts_at) = date('now','-1 day')",
    week:  "a.starts_at >= date('now','-13 day') AND a.starts_at < date('now','-6 day')",
    month: "a.starts_at >= date('now','-59 day') AND a.starts_at < date('now','-29 day')",
    year:  "a.starts_at >= date('now','-729 day') AND a.starts_at < date('now','-364 day')",
  }[range];
  const prev = db.prepare(`
    SELECT COUNT(*) AS cuts, COALESCE(SUM(a.total_pence),0) AS revenue_pence
    FROM appointments a WHERE a.shop_id=? AND a.status='completed' AND ${prevWhere}`).get(SHOP_ID);

  const wallet = db.prepare('SELECT * FROM v_wallet_liability WHERE shop_id=?').get(SHOP_ID)
    || { cash_liability_pence: 0, bonus_liability_pence: 0, total_liability_pence: 0,
         lifetime_topup_pence: 0, lifetime_bonus_pence: 0 };

  // Daily revenue series for the chart.
  const days = range === 'today' ? 14 : range === 'week' ? 14 : range === 'month' ? 30 : 52;
  const series = range === 'year'
    ? db.prepare(`
        SELECT strftime('%Y-W%W', starts_at) AS bucket,
               COALESCE(SUM(total_pence),0) AS revenue_pence, COUNT(*) AS cuts
        FROM appointments WHERE shop_id=? AND status='completed'
          AND starts_at >= date('now','-364 day')
        GROUP BY bucket ORDER BY bucket`).all(SHOP_ID)
    : db.prepare(`
        SELECT date(starts_at) AS bucket,
               COALESCE(SUM(total_pence),0) AS revenue_pence, COUNT(*) AS cuts
        FROM appointments WHERE shop_id=? AND status='completed'
          AND starts_at >= date('now', ?)
        GROUP BY bucket ORDER BY bucket`).all(SHOP_ID, `-${days - 1} day`);

  const byHour = db.prepare(`
    SELECT CAST(strftime('%H', starts_at) AS INTEGER) AS hour, COUNT(*) AS cuts,
           COALESCE(SUM(total_pence),0) AS revenue_pence
    FROM appointments WHERE shop_id=? AND status='completed'
      AND starts_at >= date('now','-89 day')
    GROUP BY hour ORDER BY hour`).all(SHOP_ID);

  // Channel mix is deliberately NOT filtered by the selected range. It answers
  // a structural question ("which channel earns its keep") and on a quiet
  // "today" the chart would collapse to a single segment and look broken.
  const sourceMix = db.prepare(`
    SELECT source, COUNT(*) AS n, COALESCE(SUM(total_pence),0) AS revenue_pence
    FROM appointments a
    WHERE a.shop_id=? AND a.status='completed' AND a.starts_at >= date('now','-89 day')
    GROUP BY source ORDER BY n DESC`).all(SHOP_ID);

  const todayList = db.prepare(`
    SELECT a.id, a.starts_at, a.status, a.total_pence, a.paid_with,
           c.name AS customer_name, c.avatar_emoji AS customer_emoji,
           s.name AS service_name, s.icon AS service_icon,
           b.nickname AS barber_name, b.avatar_emoji AS barber_emoji
    FROM appointments a
    JOIN customers c ON c.id=a.customer_id
    JOIN services s  ON s.id=a.service_id
    JOIN barbers b   ON b.id=a.barber_id
    WHERE a.shop_id=? AND date(a.starts_at)=date('now')
    ORDER BY a.starts_at`).all(SHOP_ID);

  // Client-level retention: of everyone who has ever had a first visit, what
  // share came back at all. This is the number owners mean by "retention", and
  // it is deliberately separate from the per-visit "return within 45 days"
  // figure on the barber table — they answer different questions and conflating
  // them is how dashboards end up lying.
  const retention = db.prepare(`
    SELECT
      COUNT(*) AS ever,
      SUM(CASE WHEN visits >= 2 THEN 1 ELSE 0 END) AS returned
    FROM (
      SELECT customer_id, COUNT(*) AS visits
      FROM appointments WHERE shop_id=? AND status='completed'
      GROUP BY customer_id
    )`).get(SHOP_ID);
  const retentionPct = retention.ever
    ? Number((100 * retention.returned / retention.ever).toFixed(1)) : 0;

  const attachPct = totals.cuts ? Number((100 * totals.with_addons / totals.cuts).toFixed(1)) : 0;
  const pct = (cur, before) => (before > 0 ? Number((100 * (cur - before) / before).toFixed(1)) : null);

  res.json({
    range,
    totals: { ...totals, booked_ahead: booked, no_shows: noShows, addon_attach_pct: attachPct },
    retention: {
      ever_visited: retention.ever,
      returned_at_least_once: retention.returned,
      pct: retentionPct,
      one_and_done: retention.ever - retention.returned,
    },
    trend: {
      revenue_pct: pct(totals.revenue_pence, prev.revenue_pence),
      cuts_pct: pct(totals.cuts, prev.cuts),
      prev_revenue_pence: prev.revenue_pence,
      prev_cuts: prev.cuts,
    },
    wallet,
    series,
    by_hour: byHour,
    source_mix: sourceMix,
    today: todayList,
  });
});

router.get('/dashboard/barbers', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM v_barber_performance WHERE shop_id=? ORDER BY revenue_pence DESC').all(SHOP_ID);

  // Rebook rate: of this barber's completed visits, what share were followed by
  // another visit within 45 days.
  //
  // This must use EXISTS, not a LEFT JOIN. A join against "any later
  // appointment" emits one row per follow-up, so customers who return often
  // are counted many times and the ratio drifts towards 100% — which is how
  // you end up publishing a 93% rebook rate that no barber believes.
  const rebook = db.prepare(`
    SELECT b.id AS barber_id,
      ROUND(100.0 * SUM(
        CASE WHEN EXISTS (
          SELECT 1 FROM appointments nxt
          WHERE nxt.customer_id = a.customer_id
            AND nxt.status = 'completed'
            AND nxt.starts_at > a.starts_at
            AND nxt.starts_at <= datetime(a.starts_at, '+45 day')
        ) THEN 1 ELSE 0 END
      ) / NULLIF(COUNT(a.id), 0), 1) AS rebook_pct
    FROM barbers b
    JOIN appointments a ON a.barber_id = b.id AND a.status = 'completed'
      AND a.starts_at < date('now','-45 day')
    WHERE b.shop_id = ? GROUP BY b.id`).all(SHOP_ID);
  const rbMap = new Map(rebook.map((r) => [r.barber_id, r.rebook_pct]));

  // Revenue over the last 30 days, so the table reflects current form.
  const recent = db.prepare(`
    SELECT barber_id, COUNT(*) AS cuts, COALESCE(SUM(total_pence),0) AS revenue_pence
    FROM appointments WHERE shop_id=? AND status='completed'
      AND starts_at >= date('now','-29 day') GROUP BY barber_id`).all(SHOP_ID);
  const recMap = new Map(recent.map((r) => [r.barber_id, r]));

  res.json({
    barbers: rows.map((b) => ({
      ...b,
      rebook_pct: rbMap.get(b.barber_id) ?? null,
      recent_cuts: recMap.get(b.barber_id)?.cuts ?? 0,
      recent_revenue_pence: recMap.get(b.barber_id)?.revenue_pence ?? 0,
    })),
  });
});

router.get('/dashboard/customers', (req, res) => {
  const limit = Math.min(100, Math.max(1, asInt(req.query.limit) || 20));
  const rows = db.prepare(`
    SELECT * FROM v_customer_value WHERE shop_id=? AND visits > 0
    ORDER BY lifetime_pence DESC LIMIT ?`).all(SHOP_ID, limit);

  res.json({
    customers: rows.map((c, i) => {
      const cycle = AI.predictCycle(db, c.customer_id);
      const risk = AI.churnRisk(db, c.customer_id, cycle);
      return { ...c, rank: i + 1, cycle_days: cycle.cycleDays,
               cycle_confidence: cycle.confidence, risk_band: risk.band,
               risk_label: risk.label, risk_score: risk.score };
    }),
  });
});

// The win-back list: overdue customers ranked by what they are worth.
router.get('/dashboard/winback', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM v_customer_value
    WHERE shop_id=? AND visits >= 2 AND last_visit_at IS NOT NULL`).all(SHOP_ID);
  const scored = rows.map((c) => {
    const cycle = AI.predictCycle(db, c.customer_id);
    const risk = AI.churnRisk(db, c.customer_id, cycle);
    return { ...c, cycle_days: cycle.cycleDays, risk_band: risk.band,
             risk_label: risk.label, risk_score: risk.score, risk_reason: risk.reason,
             opportunity_pence: Math.round(c.avg_ticket_pence * risk.score) };
  }).filter((c) => ['overdue', 'at_risk', 'lost'].includes(c.risk_band))
    .sort((a, b) => (b.risk_score * b.avg_ticket_pence) - (a.risk_score * a.avg_ticket_pence));

  res.json({
    customers: scored.slice(0, 40),
    total_opportunity_pence: scored.reduce((s, c) => s + c.avg_ticket_pence, 0),
  });
});

router.get('/dashboard/addons', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM v_addon_performance WHERE shop_id=? ORDER BY revenue_pence DESC').all(SHOP_ID);
  const completed = db.prepare(
    "SELECT COUNT(*) n FROM appointments WHERE shop_id=? AND status='completed'").get(SHOP_ID).n || 1;
  res.json({
    addons: rows.map((a) => ({ ...a, attach_pct: Number((100 * a.times_sold / completed).toFixed(1)) })),
    completed_appointments: completed,
  });
});

router.get('/dashboard/insights', (req, res) => {
  res.json({ insights: AI.ownerInsights(db, SHOP_ID) });
});

// ===========================================================================
// ADMIN / DEMO CONTROLS
// ===========================================================================
router.post('/admin/reseed', (req, res) => {
  const { init } = require('./db');
  init({ force: true });
  res.json({ ok: true, message: 'Demo data regenerated.' });
});

router.get('/admin/health', (req, res) => {
  const counts = {};
  for (const t of ['shops', 'barbers', 'customers', 'services', 'addons', 'appointments',
    'appointment_addons', 'wallet_accounts', 'wallet_transactions', 'referrals', 'reminders']) {
    counts[t] = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  }
  res.json({ ok: true, counts });
});

module.exports = router;
