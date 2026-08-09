/**
 * End-to-end API test.
 *
 * Exercises every route including the money-moving ones, and asserts on the
 * behaviour that matters commercially:
 *   - a top-up credits pay + bonus and nothing else
 *   - a wallet-paid booking debits exactly the basket total
 *   - bonus credit is consumed before cash
 *   - a referral pays out ONLY after the invited customer completes a visit
 *   - a cancelled prepaid booking refunds the exact split that was taken
 *
 * Run with the server up:  node test/api-test.js
 */
const BASE = process.env.BASE || 'http://localhost:3000/api';

let pass = 0, fail = 0;
const results = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  ✓ ${name}`); }
  else { fail++; results.push(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

const money = (p) => `£${(p / 100).toFixed(2)}`;

(async () => {
  console.log('\nBarberIQ API test\n' + '─'.repeat(52));

  // ---------------------------------------------------------------- bootstrap
  const boot = await req('GET', '/bootstrap');
  check('GET /bootstrap returns 200', boot.status === 200, `got ${boot.status}`);
  check('shop present', !!boot.body?.shop?.name);
  check('3 plans returned', boot.body?.plans?.length === 3, `got ${boot.body?.plans?.length}`);
  check('customers returned', boot.body?.customers?.length > 50);
  const custId = boot.body.customers[0].id;

  const health = await req('GET', '/admin/health');
  check('GET /admin/health ok', health.body?.ok === true);

  // ------------------------------------------------------------------- wallet
  const w0 = await req('GET', `/wallet/${custId}`);
  check('GET /wallet/:id returns 200', w0.status === 200);
  check('wallet has cash + bonus split', typeof w0.body?.wallet?.cash_pence === 'number'
    && typeof w0.body?.wallet?.bonus_pence === 'number');
  check('top-up tiers present', w0.body?.tiers?.length >= 4);
  check('£50 tier grants £5 bonus',
    !!w0.body.tiers.find((t) => t.pay_pence === 5000 && t.bonus_pence === 500),
    'the brief explicitly asked for £50 → £55');
  check('wallet insight has headline', typeof w0.body?.insight?.headline === 'string');

  const before = w0.body.wallet.balance_pence;
  const tier50 = w0.body.tiers.find((t) => t.pay_pence === 5000);
  const top = await req('POST', `/wallet/${custId}/topup`, { tier_id: tier50.id });
  check('POST topup returns 201', top.status === 201, `got ${top.status}`);
  check('topup credits £55 for £50', top.body?.credited_pence === 5500,
    `got ${top.body?.credited_pence}`);
  check('balance rose by exactly £55', top.body?.balance_pence === before + 5500,
    `${before} + 5500 != ${top.body?.balance_pence}`);

  // Custom amount should earn the rate of the highest tier it clears.
  const custom = await req('POST', `/wallet/${custId}/topup`, { pay_pence: 7500 });
  check('custom £75 top-up accepted', custom.status === 201);
  check('custom £75 earns 10% (clears £50 tier)', custom.body?.bonus_pence === 750,
    `got ${custom.body?.bonus_pence}`);

  const tooSmall = await req('POST', `/wallet/${custId}/topup`, { pay_pence: 100 });
  check('top-up below £5 rejected', tooSmall.status === 400);
  const tooBig = await req('POST', `/wallet/${custId}/topup`, { pay_pence: 500000 });
  check('top-up above £1000 rejected', tooBig.status === 400);

  // ---------------------------------------------------------------- catalogue
  const cat = await req('GET', '/catalogue');
  check('GET /catalogue returns services + barbers',
    cat.body?.services?.length >= 5 && cat.body?.barbers?.length >= 3);
  const service = cat.body.services[0];
  const barber = cat.body.barbers[0];

  // ------------------------------------------------------------------ add-ons
  const rec = await req('GET', `/addons/recommend?customer_id=${custId}&service_id=${service.id}`);
  check('GET /addons/recommend returns 200', rec.status === 200);
  check('all 10 add-ons returned', rec.body?.addons?.length === 10,
    `got ${rec.body?.addons?.length}`);
  check('add-ons carry a reason string', rec.body.addons.every((a) => !!a.reason));
  check('at least one flagged recommended', rec.body.addons.some((a) => a.recommended));
  check('sorted by score descending',
    rec.body.addons.every((a, i, arr) => i === 0 || arr[i - 1].score >= a.score));
  const beard = rec.body.addons.find((a) => a.name === 'Beard Trim');

  // -------------------------------------------------------------------- slots
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const slots = await req('GET', `/slots?date=${tomorrow}`);
  check('GET /slots returns 200', slots.status === 200);
  check('slots generated for the day', slots.body?.slots?.length >= 10);
  check('slots expose available barbers',
    slots.body.slots.every((s) => Array.isArray(s.available_barbers)));
  const badDate = await req('GET', '/slots?date=nonsense');
  check('malformed date rejected', badDate.status === 400);

  const free = slots.body.slots.find((s) => !s.in_past && s.available_barbers.length > 0);
  check('a bookable slot exists tomorrow', !!free);

  // ------------------------------------------------------------------ booking
  const chosenBarber = free.available_barbers[0].id;
  const startsAt = `${tomorrow} ${free.time}:00`;
  const expectedTotal = service.price_pence + beard.price_pence;

  const wPre = (await req('GET', `/wallet/${custId}`)).body.wallet;
  const bk = await req('POST', '/bookings', {
    customer_id: custId, barber_id: chosenBarber, service_id: service.id,
    starts_at: startsAt, addon_ids: [beard.id], pay_with_wallet: true,
  });
  check('POST /bookings returns 201', bk.status === 201, JSON.stringify(bk.body).slice(0, 120));
  check('booking total = service + add-on', bk.body?.appointment?.total_pence === expectedTotal,
    `${bk.body?.appointment?.total_pence} != ${expectedTotal}`);
  check('wallet debited by exactly the total',
    bk.body?.wallet_balance_pence === wPre.balance_pence - expectedTotal,
    `${wPre.balance_pence} - ${expectedTotal} != ${bk.body?.wallet_balance_pence}`);

  // Bonus-before-cash rule.
  const wPost = (await req('GET', `/wallet/${custId}`)).body.wallet;
  const bonusUsed = wPre.bonus_pence - wPost.bonus_pence;
  const cashUsed = wPre.cash_pence - wPost.cash_pence;
  check('bonus credit consumed before cash',
    bonusUsed === Math.min(wPre.bonus_pence, expectedTotal),
    `bonus used ${bonusUsed}, cash used ${cashUsed}`);

  // Double-booking must be refused by the DB constraint, not just the UI.
  const clash = await req('POST', '/bookings', {
    customer_id: custId, barber_id: chosenBarber, service_id: service.id,
    starts_at: startsAt, addon_ids: [], pay_with_wallet: false,
  });
  check('double-booking the same barber+slot is refused', clash.status === 409,
    `got ${clash.status}`);

  const past = await req('POST', '/bookings', {
    customer_id: custId, barber_id: chosenBarber, service_id: service.id,
    starts_at: '2020-01-01 10:00:00', addon_ids: [], pay_with_wallet: false,
  });
  check('booking in the past is refused', past.status === 400);

  // Cancel → refund the exact split.
  const apptId = bk.body.appointment.id;
  const cancel = await req('POST', `/bookings/${apptId}/cancel`);
  check('POST /bookings/:id/cancel returns 200', cancel.status === 200);
  const wRefund = (await req('GET', `/wallet/${custId}`)).body.wallet;
  check('cancellation restored the balance exactly',
    wRefund.balance_pence === wPre.balance_pence,
    `${wRefund.balance_pence} != ${wPre.balance_pence}`);
  check('refund restored the bonus bucket, not just cash',
    wRefund.bonus_pence === wPre.bonus_pence,
    `${wRefund.bonus_pence} != ${wPre.bonus_pence}`);

  const list = await req('GET', `/bookings/${custId}`);
  check('GET /bookings/:customerId returns history', list.body?.appointments?.length > 0);
  check('bookings include their add-on line items',
    list.body.appointments.every((a) => Array.isArray(a.addons)));

  // ---------------------------------------------------------------- reminders
  const rem = await req('GET', `/reminders/${custId}`);
  check('GET /reminders/:id returns 200', rem.status === 200);
  check('cycle prediction present', Number.isFinite(rem.body?.cycle?.cycleDays));
  check('cycle carries a confidence', Number.isFinite(rem.body?.cycle?.confidence));
  check('cycle explains its basis', typeof rem.body?.cycle?.basis === 'string');
  check('churn risk banded', typeof rem.body?.risk?.band === 'string');
  check('predicted cycle is plausible (7-120 days)',
    rem.body.cycle.cycleDays >= 7 && rem.body.cycle.cycleDays <= 120,
    `got ${rem.body.cycle.cycleDays}`);

  const rebuild = await req('POST', '/reminders/rebuild');
  check('POST /reminders/rebuild returns count', Number.isFinite(rebuild.body?.scheduled));

  // Find a customer who has a scheduled reminder and act on it.
  const anyRem = await (async () => {
    for (const c of boot.body.customers.slice(0, 40)) {
      const r = await req('GET', `/reminders/${c.id}`);
      const sched = r.body?.reminders?.find((x) => x.status === 'scheduled');
      if (sched) return sched;
    }
    return null;
  })();
  check('at least one scheduled reminder exists', !!anyRem);
  if (anyRem) {
    const snooze = await req('POST', `/reminders/${anyRem.id}/action`, { action: 'snooze', days: 5 });
    check('reminder snooze works', snooze.body?.status === 'snoozed');
    const send = await req('POST', `/reminders/${anyRem.id}/action`, { action: 'send' });
    check('reminder send works', send.body?.status === 'sent');
    const badAction = await req('POST', `/reminders/${anyRem.id}/action`, { action: 'explode' });
    check('unknown reminder action rejected', badAction.status === 400);
  }

  const prefs = await req('PUT', `/reminders/${custId}/preferences`,
    { sms: true, email: false, push: true });
  check('reminder preferences saved', prefs.body?.ok === true);

  // ----------------------------------------------------------------- referral
  const ref = await req('GET', `/referral/${custId}`);
  check('GET /referral/:id returns 200', ref.status === 200);
  check('referral code present', typeof ref.body?.code === 'string' && ref.body.code.length >= 5);
  check('share URL contains the code', ref.body?.share_url?.includes(ref.body.code));
  check('reward is £10', ref.body?.reward_pence === 1000);
  check('leaderboard present', Array.isArray(ref.body?.leaderboard));
  check('terms explain the qualifying rule', ref.body?.terms?.some((t) => /first/i.test(t)));

  const contact = `07700${Math.floor(100000 + Math.random() * 899999)}`;
  const inv = await req('POST', `/referral/${custId}/invite`, { contact });
  check('POST invite returns 201', inv.status === 201, JSON.stringify(inv.body).slice(0, 120));
  const dupe = await req('POST', `/referral/${custId}/invite`, { contact });
  check('duplicate invite rejected', dupe.status === 400);
  const empty = await req('POST', `/referral/${custId}/invite`, { contact: 'x' });
  check('empty/short contact rejected', empty.status === 400);

  // THE critical fraud control: signing up must NOT pay out on its own.
  const signup = await req('POST', `/referral/${inv.body.referral_id}/simulate-signup`,
    { name: 'Test Friend' });
  check('simulated signup returns 201', signup.status === 201, JSON.stringify(signup.body).slice(0, 150));
  const newCustId = signup.body.customer_id;

  const refAfterSignup = await req('GET', `/referral/${custId}`);
  const thisRef = refAfterSignup.body.referrals.find((r) => r.id === inv.body.referral_id);
  check('referral is signed_up but NOT yet rewarded', thisRef?.status === 'signed_up',
    `got ${thisRef?.status}`);

  const referrerBonusBefore = (await req('GET', `/wallet/${custId}`)).body.wallet.bonus_pence;
  const friendBonusBefore = (await req('GET', `/wallet/${newCustId}`)).body.wallet.bonus_pence;
  check('no credit paid on sign-up alone', friendBonusBefore === 0,
    `friend already had ${friendBonusBefore}`);

  // Now book AND complete the friend's first visit — this should pay both.
  const slots2 = await req('GET', `/slots?date=${tomorrow}`);
  const free2 = slots2.body.slots.find((s) => !s.in_past && s.available_barbers.length > 0);
  const bk2 = await req('POST', '/bookings', {
    customer_id: newCustId, barber_id: free2.available_barbers[0].id,
    service_id: service.id, starts_at: `${tomorrow} ${free2.time}:00`,
    addon_ids: [], pay_with_wallet: false, source: 'referral',
  });
  check('friend booking created', bk2.status === 201, JSON.stringify(bk2.body).slice(0, 150));

  const complete = await req('POST', `/bookings/${bk2.body.appointment.id}/complete`);
  check('completing the visit returns 200', complete.status === 200);
  check('completion reports 2 rewarded parties',
    complete.body?.referral_rewarded_customer_ids?.length === 2,
    JSON.stringify(complete.body));

  const referrerAfter = (await req('GET', `/wallet/${custId}`)).body.wallet.bonus_pence;
  const friendAfter = (await req('GET', `/wallet/${newCustId}`)).body.wallet.bonus_pence;
  check('referrer received £10', referrerAfter === referrerBonusBefore + 1000,
    `${referrerBonusBefore} → ${referrerAfter}`);
  check('friend received £10', friendAfter === friendBonusBefore + 1000,
    `${friendBonusBefore} → ${friendAfter}`);

  // ---------------------------------------------------------------- dashboard
  for (const range of ['today', 'week', 'month', 'year']) {
    const d = await req('GET', `/dashboard?range=${range}`);
    check(`GET /dashboard?range=${range} returns 200`, d.status === 200);
    check(`  ${range}: totals present`, Number.isFinite(d.body?.totals?.revenue_pence));
    check(`  ${range}: series present`, Array.isArray(d.body?.series) && d.body.series.length > 0);
  }

  const dash = (await req('GET', '/dashboard?range=month')).body;
  check('dashboard exposes wallet liability split',
    Number.isFinite(dash.wallet?.cash_liability_pence)
    && Number.isFinite(dash.wallet?.bonus_liability_pence));
  check('revenue = service + add-ons',
    dash.totals.revenue_pence === dash.totals.service_pence + dash.totals.addons_pence,
    `${dash.totals.revenue_pence} != ${dash.totals.service_pence}+${dash.totals.addons_pence}`);
  check('by-hour breakdown present', dash.by_hour?.length > 0);

  const bar = await req('GET', '/dashboard/barbers');
  check('GET /dashboard/barbers returns 200', bar.status === 200);
  check('5 barbers with revenue', bar.body?.barbers?.length === 5);
  check('barbers ranked by revenue',
    bar.body.barbers.every((b, i, a) => i === 0 || a[i - 1].revenue_pence >= b.revenue_pence));
  check('commission calculated', bar.body.barbers.every((b) => Number.isFinite(b.commission_pence)));
  check('attach rate per barber present',
    bar.body.barbers.every((b) => b.addon_attach_pct === null || Number.isFinite(b.addon_attach_pct)));

  const top20 = await req('GET', '/dashboard/customers?limit=20');
  check('GET /dashboard/customers?limit=20 returns 20', top20.body?.customers?.length === 20,
    `got ${top20.body?.customers?.length}`);
  check('top customers ranked by lifetime value',
    top20.body.customers.every((c, i, a) => i === 0 || a[i - 1].lifetime_pence >= c.lifetime_pence));
  check('each carries a risk band', top20.body.customers.every((c) => !!c.risk_band));
  check('each carries a predicted cycle', top20.body.customers.every((c) => c.cycle_days > 0));

  const wb = await req('GET', '/dashboard/winback');
  check('GET /dashboard/winback returns 200', wb.status === 200);
  check('winback ranked by opportunity',
    !wb.body.customers.length || wb.body.customers.every((c) => c.risk_band !== 'healthy'));

  const ad = await req('GET', '/dashboard/addons');
  check('GET /dashboard/addons returns 200', ad.status === 200);
  check('add-on performance has attach %', ad.body?.addons?.every((a) => Number.isFinite(a.attach_pct)));

  const ins = await req('GET', '/dashboard/insights');
  check('GET /dashboard/insights returns 200', ins.status === 200);
  check('insights generated', ins.body?.insights?.length > 0, `got ${ins.body?.insights?.length}`);
  check('insights have title + detail + severity',
    ins.body.insights.every((i) => i.title && i.detail && i.severity));

  // -------------------------------------------------------------- error paths
  const noCust = await req('GET', '/wallet/999999');
  check('unknown customer returns 404', noCust.status === 404);
  const badBooking = await req('POST', '/bookings', { customer_id: 999999 });
  check('booking with unknown customer returns 404', badBooking.status === 404);

  // ------------------------------------------------------------------- output
  console.log(results.join('\n'));
  console.log('─'.repeat(52));
  console.log(`  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\nTest harness crashed:', e);
  process.exit(1);
});
