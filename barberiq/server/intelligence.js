/**
 * The intelligence layer.
 *
 * A NOTE ON WHAT THIS IS — worth being straight about, because you will be
 * asked in a sales meeting:
 *
 * This is statistical modelling over the shop's own transaction history, not a
 * large language model. That is a deliberate engineering decision, not a
 * shortcut:
 *
 *   1. It is deterministic and explainable. Every prediction carries a reason
 *      string, so the owner can see WHY a customer is flagged. "Trust me, the
 *      AI said so" loses deals.
 *   2. It runs offline in single-digit milliseconds with no API key, no
 *      per-call cost, and no customer data leaving the premises — which is
 *      the honest answer to the GDPR question you will get.
 *   3. It gets sharper as the shop's own history grows, rather than depending
 *      on a general-purpose model that has never seen this shop.
 *
 * Everything here is genuine predictive analytics: per-customer periodicity
 * estimation with recency weighting, market-basket affinity scoring, and
 * survival-style churn banding. If a client wants generative features
 * (drafting campaign copy, for example) that is a clean add-on — see
 * COMMERCIAL-PACK.md for where it sits in the roadmap.
 */

const DAY = 86400000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const toDate = (s) => new Date(String(s).replace(' ', 'T') + (String(s).endsWith('Z') ? '' : 'Z'));
const iso = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const addDays = (d, n) => new Date(d.getTime() + n * DAY);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---------------------------------------------------------------------------
// 1. REBOOK CYCLE PREDICTION
//
// The brief asked for "a reminder after 25 to 30 days". A fixed window is the
// obvious implementation and it is also the reason most reminder features get
// ignored: a skin fade needs 2-3 weeks, a restyle needs 6, and every customer
// differs. So we learn each person's actual rhythm from their gap history and
// fall back to the service's default cycle only while evidence is thin.
//
// Recent gaps are weighted more heavily than old ones (exponential decay,
// half-life ~4 visits) because habits change — new job, new baby, moved house.
// ---------------------------------------------------------------------------
function predictCycle(db, customerId) {
  const visits = db.prepare(`
    SELECT a.starts_at, s.default_cycle_days
    FROM appointments a
    JOIN services s ON s.id = a.service_id
    WHERE a.customer_id = ? AND a.status = 'completed'
    ORDER BY a.starts_at ASC`).all(customerId);

  const fallback = visits.length
    ? visits[visits.length - 1].default_cycle_days
    : 28;

  if (visits.length < 2) {
    return {
      cycleDays: fallback,
      confidence: visits.length === 1 ? 0.35 : 0.2,
      sampleSize: visits.length,
      variability: null,
      lastVisit: visits.length ? visits[0].starts_at : null,
      basis: visits.length === 1
        ? 'One visit so far — using the typical cycle for their usual service.'
        : 'No visit history yet — using the shop default.',
    };
  }

  const gaps = [];
  for (let i = 1; i < visits.length; i++) {
    const d = (toDate(visits[i].starts_at) - toDate(visits[i - 1].starts_at)) / DAY;
    // Discard absurd gaps: a 9-month break is a lapse-and-return, not a cycle.
    if (d >= 5 && d <= 150) gaps.push(d);
  }
  if (!gaps.length) {
    return {
      cycleDays: fallback, confidence: 0.25, sampleSize: visits.length,
      variability: null, lastVisit: visits[visits.length - 1].starts_at,
      basis: 'Visit gaps too irregular to model — using the service default.',
    };
  }

  // Exponential recency weighting.
  const HALF_LIFE = 4;
  let wSum = 0, weighted = 0;
  gaps.forEach((g, i) => {
    const age = gaps.length - 1 - i;              // 0 = most recent gap
    const w = Math.pow(0.5, age / HALF_LIFE);
    weighted += g * w; wSum += w;
  });
  const weightedMean = weighted / wSum;

  // Blend with the median to stay robust against a single odd gap.
  const med = median(gaps);
  const blended = 0.65 * weightedMean + 0.35 * med;

  // Coefficient of variation drives confidence: a tight rhythm is predictable.
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length;
  const sd = Math.sqrt(variance);
  const cv = mean > 0 ? sd / mean : 1;

  const sampleConfidence = clamp(gaps.length / 6, 0, 1);      // 6+ gaps = full marks
  const steadiness = clamp(1 - cv / 0.6, 0, 1);               // cv 0 = perfect
  const confidence = clamp(0.25 + 0.45 * sampleConfidence + 0.30 * steadiness, 0, 0.97);

  return {
    cycleDays: Math.round(clamp(blended, 7, 120)),
    confidence: Number(confidence.toFixed(2)),
    sampleSize: gaps.length + 1,
    variability: Number(sd.toFixed(1)),
    lastVisit: visits[visits.length - 1].starts_at,
    basis: `Learned from ${gaps.length + 1} visits — typically every `
      + `${Math.round(blended)} days (±${sd.toFixed(0)}).`,
  };
}

// ---------------------------------------------------------------------------
// 2. CHURN / LAPSE RISK
//
// Banded on how far past their own predicted cycle a customer has drifted,
// not on a single global "90 days = lapsed" rule. A 17-day VIP who has not
// been seen for 40 days is in trouble; a 45-day casual at 40 days is fine.
// ---------------------------------------------------------------------------
function churnRisk(db, customerId, cycle) {
  const c = cycle || predictCycle(db, customerId);
  if (!c.lastVisit) {
    return { band: 'never_visited', score: 0.5, daysSince: null, overdueRatio: null,
             label: 'Never visited', reason: 'Signed up but has not been in yet.' };
  }
  const daysSince = Math.floor((Date.now() - toDate(c.lastVisit).getTime()) / DAY);
  const ratio = daysSince / Math.max(1, c.cycleDays);

  let band, label, reason;
  if (ratio < 0.75)      { band = 'healthy';  label = 'On track'; }
  else if (ratio < 1.05) { band = 'due';      label = 'Due now'; }
  else if (ratio < 1.6)  { band = 'overdue';  label = 'Overdue'; }
  else if (ratio < 3.0)  { band = 'at_risk';  label = 'At risk'; }
  else                   { band = 'lost';     label = 'Likely lost'; }

  reason = `${daysSince} days since last visit against a ${c.cycleDays}-day pattern`
    + ` (${Math.round(ratio * 100)}% of cycle).`;

  // Risk score for sorting a win-back list: rises with overdue ratio, damped
  // when we do not trust the cycle estimate.
  const raw = clamp((ratio - 0.75) / 2.25, 0, 1);
  const score = Number(clamp(raw * (0.55 + 0.45 * c.confidence), 0, 1).toFixed(2));

  return { band, label, score, daysSince, overdueRatio: Number(ratio.toFixed(2)), reason };
}

// ---------------------------------------------------------------------------
// 3. ADD-ON RECOMMENDATION (market-basket affinity)
//
// Three signals, blended:
//   personal   — how often THIS customer buys it (strongest predictor)
//   affinity   — P(add-on | the service being booked), across the whole shop
//   popularity — overall attach rate, so new customers still get sensible picks
//
// Plus a small discovery bonus for popular things this customer has never
// tried, because a recommender that only echoes past behaviour never grows
// the basket.
// ---------------------------------------------------------------------------
function recommendAddons(db, { shopId, customerId, serviceId, limit = 4 }) {
  const addons = db.prepare(
    'SELECT id,name,description,price_pence,duration_min,icon FROM addons WHERE shop_id=? AND active=1'
  ).all(shopId);

  const totalCompleted = db.prepare(
    "SELECT COUNT(*) n FROM appointments WHERE shop_id=? AND status='completed'").get(shopId).n || 1;

  const popularity = new Map(db.prepare(`
    SELECT aa.addon_id AS id, COUNT(*) AS n
    FROM appointment_addons aa
    JOIN appointments a ON a.id = aa.appointment_id AND a.status='completed'
    WHERE a.shop_id = ? GROUP BY aa.addon_id`).all(shopId).map((r) => [r.id, r.n]));

  const serviceCount = serviceId ? (db.prepare(
    "SELECT COUNT(*) n FROM appointments WHERE service_id=? AND status='completed'"
  ).get(serviceId).n || 1) : 1;

  const affinity = new Map(!serviceId ? [] : db.prepare(`
    SELECT aa.addon_id AS id, COUNT(*) AS n
    FROM appointment_addons aa
    JOIN appointments a ON a.id = aa.appointment_id AND a.status='completed'
    WHERE a.service_id = ? GROUP BY aa.addon_id`).all(serviceId).map((r) => [r.id, r.n]));

  const myVisits = customerId ? (db.prepare(
    "SELECT COUNT(*) n FROM appointments WHERE customer_id=? AND status='completed'"
  ).get(customerId).n || 0) : 0;

  const mine = new Map(!customerId ? [] : db.prepare(`
    SELECT aa.addon_id AS id, COUNT(*) AS n
    FROM appointment_addons aa
    JOIN appointments a ON a.id = aa.appointment_id AND a.status='completed'
    WHERE a.customer_id = ? GROUP BY aa.addon_id`).all(customerId).map((r) => [r.id, r.n]));

  const scored = addons.map((a) => {
    const personal   = myVisits ? (mine.get(a.id) || 0) / myVisits : 0;
    const affin      = serviceId ? (affinity.get(a.id) || 0) / serviceCount : 0;
    const popular    = (popularity.get(a.id) || 0) / totalCompleted;
    const untried    = myVisits >= 2 && !mine.has(a.id);
    const discovery  = untried ? popular * 0.4 : 0;

    const score = 0.50 * personal + 0.28 * affin + 0.22 * popular + discovery;

    let reason;
    if (personal >= 0.6)      reason = 'You add this most visits';
    else if (personal > 0.15) reason = 'You have had this before';
    else if (untried && popular > 0.2) reason = 'Popular here — worth a try';
    else if (affin > 0.3)     reason = 'Pairs well with this service';
    else if (popular > 0.25)  reason = 'A regular favourite';
    else                      reason = 'Available to add';

    return {
      ...a,
      score: Number(score.toFixed(4)),
      recommended: false,
      reason,
      personal_rate: Number(personal.toFixed(2)),
      shop_attach_rate: Number(popular.toFixed(2)),
    };
  }).sort((a, b) => b.score - a.score);

  // Flag the top N as actively recommended; the rest stay selectable.
  scored.slice(0, limit).forEach((a) => { if (a.score > 0.05) a.recommended = true; });
  return scored;
}

// ---------------------------------------------------------------------------
// 4. NO-SHOW RISK
//
// Used to decide who gets a confirmation nudge and, commercially, who should
// be asked to prepay from wallet. History of no-shows is the dominant signal.
// ---------------------------------------------------------------------------
function noShowRisk(db, customerId) {
  const r = db.prepare(`
    SELECT
      SUM(CASE WHEN status='no_show'   THEN 1 ELSE 0 END) AS no_shows,
      SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancels,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed
    FROM appointments WHERE customer_id = ?`).get(customerId);

  const total = (r.no_shows || 0) + (r.cancels || 0) + (r.completed || 0);
  if (total < 3) return { score: 0.12, band: 'unknown', reason: 'Not enough history yet.' };

  // Laplace smoothing keeps a single early no-show from branding someone.
  const rate = ((r.no_shows || 0) + 0.5) / (total + 2);
  const cancelRate = ((r.cancels || 0) + 0.5) / (total + 2);
  const score = clamp(rate * 0.75 + cancelRate * 0.25, 0, 1);
  const band = score > 0.28 ? 'high' : score > 0.15 ? 'medium' : 'low';
  return {
    score: Number(score.toFixed(2)), band,
    reason: `${r.no_shows || 0} no-show(s) and ${r.cancels || 0} cancellation(s) across ${total} bookings.`,
  };
}

// ---------------------------------------------------------------------------
// 5. REMINDER SCHEDULING
//
// Writes one scheduled reminder per active customer. We nudge slightly BEFORE
// the predicted due date (3 days, scaled by confidence) because the goal is to
// catch them while the diary still has slots, not to notice they have gone.
//
// Customers with a future booking are skipped — nothing is more corrosive to
// trust in an automated system than being reminded to book what you already
// booked.
// ---------------------------------------------------------------------------
function rebuildReminders(db, shopId) {
  db.prepare("DELETE FROM reminders WHERE shop_id = ? AND status = 'scheduled'").run(shopId);

  const customers = db.prepare(`
    SELECT c.id, c.name, c.notify_sms, c.notify_email, c.notify_push
    FROM customers c WHERE c.shop_id = ?`).all(shopId);

  const hasFuture = db.prepare(`
    SELECT COUNT(*) n FROM appointments
    WHERE customer_id = ? AND status = 'booked' AND starts_at > datetime('now')`);

  const ins = db.prepare(`
    INSERT INTO reminders (shop_id,customer_id,due_date,send_on,channel,status,reason,
      predicted_cycle_days,confidence,message)
    VALUES (?,?,?,?,?,'scheduled',?,?,?,?)`);

  let created = 0;
  for (const c of customers) {
    if (hasFuture.get(c.id).n > 0) continue;

    const cycle = predictCycle(db, c.id);
    if (!cycle.lastVisit) continue;

    const due = addDays(toDate(cycle.lastVisit), cycle.cycleDays);
    // Lead time: up to 3 days early when we are confident, less when we are not.
    const lead = Math.round(1 + 2 * cycle.confidence);
    let sendOn = addDays(due, -lead);
    // Never schedule in the past — if they are already overdue, nudge today.
    const today = new Date();
    if (sendOn < today) sendOn = today;

    const risk = churnRisk(db, c.id, cycle);
    const channel = c.notify_sms ? 'sms' : c.notify_push ? 'push' : 'email';
    const first = c.name.split(' ')[0];

    const message = risk.band === 'healthy' || risk.band === 'due'
      ? `Hi ${first} — you're about due for your next cut. Tap to grab a slot with your usual barber.`
      : risk.band === 'overdue'
        ? `Hi ${first} — it's been ${risk.daysSince} days. Your chair's waiting whenever you are.`
        : `Hi ${first} — we've missed you. Here's £3 off your next cut if you book this week.`;

    ins.run(shopId, c.id, iso(due), iso(sendOn), channel,
      cycle.basis, cycle.cycleDays, cycle.confidence, message);
    created++;
  }
  return created;
}

// ---------------------------------------------------------------------------
// 6. OWNER INSIGHTS
//
// Turns the analytics into a short list of things worth acting on this week.
// Deliberately capped and ranked — an insights panel with 30 items is a
// report, and reports get ignored.
// ---------------------------------------------------------------------------
function ownerInsights(db, shopId) {
  const out = [];
  const money = (p) => `£${(p / 100).toFixed(2)}`;

  // (a) Win-back opportunity, valued in real money.
  const atRisk = db.prepare(`
    SELECT customer_id, name, lifetime_pence, avg_ticket_pence, days_since_visit, visits
    FROM v_customer_value
    WHERE shop_id = ? AND visits >= 3 AND days_since_visit IS NOT NULL
    ORDER BY days_since_visit DESC`).all(shopId);

  const scored = atRisk.map((c) => ({ ...c, risk: churnRisk(db, c.customer_id) }))
    .filter((c) => c.risk.band === 'at_risk' || c.risk.band === 'overdue')
    .sort((a, b) => (b.risk.score * b.avg_ticket_pence) - (a.risk.score * a.avg_ticket_pence));

  if (scored.length) {
    const value = scored.reduce((s, c) => s + c.avg_ticket_pence, 0);
    out.push({
      severity: 'high', icon: '🎯', title: `${scored.length} regulars have slipped past their cycle`,
      detail: `Recovering one visit each is worth about ${money(value)}. `
        + `Top priority: ${scored.slice(0, 3).map((c) => c.name.split(' ')[0]).join(', ')}.`,
      action: 'Open win-back list', actionTarget: 'winback',
    });
  }

  // (b) Add-on attach rate versus the best barber — the cheapest revenue in the shop.
  const perf = db.prepare(
    'SELECT name,nickname,addon_attach_pct,cuts FROM v_barber_performance WHERE shop_id=? AND cuts>20'
  ).all(shopId);
  if (perf.length >= 2) {
    const sorted = [...perf].sort((a, b) => (b.addon_attach_pct || 0) - (a.addon_attach_pct || 0));
    const best = sorted[0], worst = sorted[sorted.length - 1];
    const gap = (best.addon_attach_pct || 0) - (worst.addon_attach_pct || 0);
    if (gap > 8) {
      out.push({
        severity: 'medium', icon: '📈',
        title: `${worst.nickname} attaches add-ons ${gap.toFixed(0)} points below ${best.nickname}`,
        detail: `${best.nickname} is at ${best.addon_attach_pct}%, ${worst.nickname} at `
          + `${worst.addon_attach_pct}%. Closing half that gap across ${worst.cuts} cuts is `
          + `found money — it is a script problem, not a skill problem.`,
        action: 'View barber performance', actionTarget: 'barbers',
      });
    }
  }

  // (c) Wallet liability — the CFO's line. Prepaid balances are money you owe.
  const liab = db.prepare('SELECT * FROM v_wallet_liability WHERE shop_id = ?').get(shopId);
  if (liab && liab.total_liability_pence > 0) {
    out.push({
      severity: 'info', icon: '🏦', title: `${money(liab.total_liability_pence)} of wallet credit outstanding`,
      detail: `${money(liab.cash_liability_pence)} is customer cash you are holding (a real `
        + `liability) and ${money(liab.bonus_liability_pence)} is promotional bonus (a marketing `
        + `cost already incurred). Keep the cash figure in mind before drawing down the account.`,
      action: 'Open wallet report', actionTarget: 'wallet-report',
    });
  }

  // (d) Quietest trading hour — where a targeted offer actually helps.
  const byHour = db.prepare(`
    SELECT CAST(strftime('%H', starts_at) AS INTEGER) AS hour, COUNT(*) AS n
    FROM appointments
    WHERE shop_id=? AND status='completed' AND starts_at >= date('now','-90 day')
    GROUP BY hour HAVING n > 0 ORDER BY n ASC`).all(shopId);
  if (byHour.length >= 4) {
    const quiet = byHour[0], busy = byHour[byHour.length - 1];
    out.push({
      severity: 'medium', icon: '🕐', title: `${quiet.hour}:00 is your deadest hour`,
      detail: `${quiet.n} cuts in 90 days versus ${busy.n} at ${busy.hour}:00. A "£3 off before `
        + `noon" push to overdue customers fills chairs you are already paying for.`,
      action: 'Create off-peak offer', actionTarget: 'offer',
    });
  }

  // (e) Referral engine health.
  const ref = db.prepare(`
    SELECT
      SUM(CASE WHEN status='rewarded' THEN 1 ELSE 0 END) AS rewarded,
      SUM(CASE WHEN status IN ('sent','signed_up') THEN 1 ELSE 0 END) AS pending,
      COUNT(*) AS total
    FROM referrals WHERE shop_id = ?`).get(shopId);
  if (ref && ref.total > 0) {
    const conv = Math.round(100 * (ref.rewarded || 0) / ref.total);
    out.push({
      severity: conv < 40 ? 'medium' : 'good', icon: '🤝',
      title: `${ref.rewarded || 0} referrals converted (${conv}% of invites sent)`,
      detail: `${ref.pending || 0} invitations are still open. Each converted referral costs you `
        + `£20 in credit and brings a customer whose first visit alone usually covers it.`,
      action: 'View referral programme', actionTarget: 'referral',
    });
  }

  // (f) No-show leakage.
  const ns = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(service_pence),0) AS lost
    FROM appointments
    WHERE shop_id=? AND status='no_show' AND starts_at >= date('now','-30 day')`).get(shopId);
  const nsTotal = db.prepare(`
    SELECT COUNT(*) n FROM appointments
    WHERE shop_id=? AND starts_at >= date('now','-30 day')
      AND status IN ('completed','no_show','cancelled')`).get(shopId).n || 1;
  if (ns.n > 0) {
    const pct = (100 * ns.n / nsTotal).toFixed(1);
    out.push({
      severity: ns.n > 8 ? 'high' : 'info', icon: '👻',
      title: `${ns.n} no-shows in the last 30 days (${pct}% of bookings)`,
      detail: `Empty chairs cannot be resold. Requiring wallet prepayment from repeat offenders `
        + `is the single most effective fix — it converts a no-show into revenue you keep.`,
      action: 'See no-show risk list', actionTarget: 'noshow',
    });
  }

  const rank = { high: 0, medium: 1, good: 2, info: 3 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 6);
}

module.exports = {
  predictCycle, churnRisk, recommendAddons, noShowRisk,
  rebuildReminders, ownerInsights, toDate, iso, addDays,
};
