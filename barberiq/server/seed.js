/**
 * Demo data generator.
 *
 * Produces ~12 months of trading history for a 5-chair shop. The numbers are
 * generated from per-customer behavioural profiles rather than uniform random
 * noise, because the intelligence engine is only convincing if the underlying
 * data has real structure to find:
 *
 *   - loyal customers return on a tight cycle (low variance)
 *   - drifters have a widening gap between visits
 *   - lapsed customers stop entirely part-way through the year
 *
 * That structure is what makes the churn scores and cycle predictions in the
 * dashboard land as insight rather than decoration.
 */

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) so every demo looks identical. A sales demo
// that shows different figures each launch is impossible to rehearse against.
// ---------------------------------------------------------------------------
function rng(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260809);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
// Box-Muller: gives us a believable bell curve of visit gaps.
function gauss(mean, sd) {
  const u = Math.max(rand(), 1e-9), v = Math.max(rand(), 1e-9);
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const iso = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

const FIRST_NAMES = ['James','Mohammed','Oliver','Harry','Jack','Charlie','Leo','Noah','Arthur','Alfie',
  'Tommy','Reece','Dev','Amir','Kwame','Luca','Ethan','Mason','Finlay','Rory','Sam','Zain','Kai','Elliot',
  'Marcus','Dominic','Jude','Theo','Isaac','Ryan','Callum','Owen','Nathan','Aaron','Josh','Liam','Connor',
  'Bilal','Omar','Tyrone','Andre','Sean','Declan','Craig','Wesley','Hugo','Felix','Max','Toby','Joel',
  'Yusuf','Ravi','Sanjay','Curtis','Damian','Elijah','Freddie','Gabriel','Henry','Ibrahim','Jamal','Kieran'];
const LAST_NAMES = ['Smith','Patel','Jones','Williams','Brown','Taylor','Davies','Wilson','Evans','Khan',
  'Thomas','Roberts','Johnson','Lewis','Walker','Robinson','Wood','Thompson','White','Hughes','Green',
  'Hall','Edwards','Turner','Clarke','Ward','Baker','Harris','Cooper','Morris','Ali','Begum','Osei',
  'Mensah','Okafor','Nowak','Kowalski','Silva','Costa','Rossi','Murphy','Kelly','Byrne','Ahmed','Hussain'];
const AVATARS = ['🙂','😎','🧔','👨','🧑','👦','🤠','😃','🙃','😌','🥸','🤓','😁','👨‍🦱','👨‍🦰','🧑‍🦲'];

function code(n = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 — read aloud safely
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return s;
}

function seed(db) {
  const now = new Date();

  // -------------------------------------------------------------------------
  // Commercial plans. Pricing derived from 2026 market research — see
  // COMMERCIAL-PACK.md for the competitor analysis behind these numbers.
  // -------------------------------------------------------------------------
  const insertPlan = db.prepare(`
    INSERT INTO plans (code,name,setup_pence,monthly_pence,max_chairs,blurb,features_json,is_featured,sort_order)
    VALUES (@code,@name,@setup,@monthly,@chairs,@blurb,@features,@featured,@sort)`);

  insertPlan.run({
    code: 'starter', name: 'Starter', setup: 49900, monthly: 5900, chairs: 2,
    blurb: 'Solo barbers and two-chair shops finding their feet.',
    featured: 0, sort: 1,
    features: JSON.stringify([
      'Online booking + add-ons', 'Prepaid wallet with bonus tiers',
      'Automatic rebook reminders', 'Referral programme',
      'Owner dashboard', 'Up to 2 chairs', 'Email support',
    ]),
  });
  insertPlan.run({
    code: 'professional', name: 'Professional', setup: 149900, monthly: 11900, chairs: 6,
    blurb: 'The workhorse plan for a busy high-street shop.',
    featured: 1, sort: 2,
    features: JSON.stringify([
      'Everything in Starter', 'AI rebook prediction (per-customer cycles)',
      'Add-on recommendation engine', 'Churn-risk & win-back lists',
      'Barber performance & commission reports', 'Top-20 customer intelligence',
      'Up to 6 chairs', 'SMS reminders included (1,000/mo)',
      'Priority support + quarterly review',
    ]),
  });
  insertPlan.run({
    code: 'multisite', name: 'Multi-Site', setup: 349900, monthly: 24900, chairs: null,
    blurb: 'Groups running more than one location.',
    featured: 0, sort: 3,
    features: JSON.stringify([
      'Everything in Professional', 'Unlimited chairs',
      'Multi-location roll-up reporting', 'Cross-site wallet (spend anywhere)',
      'Staff league tables across sites', 'White-label branding + own domain',
      'API access & data export', 'Named account manager',
    ]),
  });

  // -------------------------------------------------------------------------
  // Shop
  // -------------------------------------------------------------------------
  const trialEnds = addDays(now, 30);
  const shopId = db.prepare(`
    INSERT INTO shops (name,slug,address_line1,city,postcode,phone,email,plan_code,
                       trial_ends_at,subscription_state,opens_at,closes_at,slot_minutes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'Sharp & Co. Barbers', 'sharp-and-co', '42 Deansgate', 'Manchester', 'M3 2AY',
    '0161 496 0142', 'hello@sharpandco.example', 'professional',
    iso(trialEnds), 'trialing', '09:00', '19:00', 30,
  ).lastInsertRowid;

  // -------------------------------------------------------------------------
  // Barbers. Skill levels differ so the league table has a real story.
  // -------------------------------------------------------------------------
  // `demand` weights how often a barber gets picked (the busy chair versus the
  // quiet one) and `upsell` scales how often they attach an add-on.
  //
  // These two numbers are what give the barber league table a story. Assign
  // work uniformly and every barber lands within a couple of percent of the
  // others, the ranking becomes noise, and the "coach your weakest upseller"
  // insight has nothing to find — which is precisely the insight that sells
  // the dashboard.
  const barberSpec = [
    { name: 'Aisha Rahman',   nick: 'Aisha',  emoji: '✂️', spec: 'Fades & skin tapers',         comm: 4200, rating: 4.9, demand: 1.45, upsell: 1.55 },
    { name: 'Tony Marino',    nick: 'Tony',   emoji: '💈', spec: 'Scissor work & classic cuts', comm: 4500, rating: 4.8, demand: 1.20, upsell: 1.20 },
    { name: 'Kwame Osei',     nick: 'Kwame',  emoji: '🧑‍🎤', spec: 'Textured & afro hair',      comm: 4000, rating: 4.8, demand: 1.05, upsell: 0.95 },
    { name: 'Declan Byrne',   nick: 'Dec',    emoji: '🪒', spec: 'Beard sculpting & hot towel', comm: 4000, rating: 4.6, demand: 0.80, upsell: 0.70 },
    { name: 'Sofia Toma',     nick: 'Sofia',  emoji: '💫', spec: 'Kids & family cuts',          comm: 3800, rating: 4.5, demand: 0.55, upsell: 0.42 },
  ];
  const insBarber = db.prepare(`
    INSERT INTO barbers (shop_id,name,nickname,avatar_emoji,specialty,commission_bps,rating,hired_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  const barbers = barberSpec.map((b, i) => ({
    ...b,
    id: insBarber.run(shopId, b.name, b.nick, b.emoji, b.spec, b.comm, b.rating,
      iso(addDays(now, -randInt(400, 1500)))).lastInsertRowid,
  }));

  // Weighted pick so busy chairs stay busy.
  const demandTotal = barbers.reduce((s, b) => s + b.demand, 0);
  function pickBarber() {
    let r = rand() * demandTotal;
    for (const b of barbers) { r -= b.demand; if (r <= 0) return b; }
    return barbers[barbers.length - 1];
  }

  // -------------------------------------------------------------------------
  // Services & add-ons (UK high-street pricing)
  // -------------------------------------------------------------------------
  const insService = db.prepare(`
    INSERT INTO services (shop_id,name,description,price_pence,duration_min,icon,default_cycle_days,sort_order)
    VALUES (?,?,?,?,?,?,?,?)`);
  const serviceSpec = [
    ['Skin Fade',        'Sharp fade blended to the skin, finished with a line-up.', 2200, 40, '💈', 21, 1],
    ['Classic Cut',      'Scissor cut, tapered and styled to your preference.',      1800, 30, '✂️', 28, 2],
    ['Buzz Cut',         'Single-length clipper cut, quick and clean.',              1200, 20, '⚡', 21, 3],
    ['Cut & Beard',      'Full haircut plus beard shape-up in one sitting.',         2800, 50, '🧔', 25, 4],
    ['Kids Cut',         'Under-12s, patient and unhurried.',                       1400, 25, '🧒', 35, 5],
    ['Restyle',          'Consultation plus a full change of direction.',           3200, 60, '🌟', 42, 6],
  ];
  const services = serviceSpec.map((s) => ({
    name: s[0], price: s[2], duration: s[3], cycle: s[6],
    id: insService.run(shopId, s[0], s[1], s[2], s[3], s[4], s[5], s[6]).lastInsertRowid,
  }));

  const insAddon = db.prepare(`
    INSERT INTO addons (shop_id,name,description,price_pence,duration_min,icon,sort_order)
    VALUES (?,?,?,?,?,?,?)`);
  // The final column is the shop-wide attach rate for that add-on. These are
  // scaled so a typical appointment carries ~0.8 add-ons and just over half of
  // visits have at least one — where a shop actively recommending add-ons
  // lands. Do not inflate these: the demo becomes indefensible the moment an
  // owner compares it against their own till roll.
  const addonSpec = [
    ['Beard Trim',      'Shape, line up and condition the beard.',            800, 15, '🧔', 1, 0.110],
    ['Hot Towel Shave', 'Traditional straight-razor finish with hot towels.', 1500, 25, '🪒', 2, 0.038],
    ['Head Massage',    'Five minutes of pressure-point relief.',             600, 10, '💆', 3, 0.090],
    ['Hair Wash',       'Shampoo, condition and blow dry.',                  500,  10, '🚿', 4, 0.100],
    ['Eyebrow Tidy',    'Neaten and shape the brow line.',                   400,  8,  '👁️', 5, 0.045],
    ['Grey Blending',   'Softens grey without a harsh block colour.',        1800, 30, '🎨', 6, 0.022],
    ['Nose & Ear Wax',  'Quick, thorough and less painful than you fear.',    700, 10, '👂', 7, 0.029],
    ['Styling & Wax',   'Product applied and styled to hold all day.',        350, 5,  '💧', 8, 0.070],
    ['Line-Up Only',    'Sharpen the hairline between full cuts.',            600, 10, '📐', 9, 0.035],
    ['Face Mask',       'Charcoal mask to clear and calm the skin.',          900, 15, '🧖', 10, 0.019],
  ];
  const addons = addonSpec.map((a) => ({
    name: a[0], price: a[2], baseRate: a[6],
    id: insAddon.run(shopId, a[0], a[1], a[2], a[3], a[4], a[5]).lastInsertRowid,
  }));

  // -------------------------------------------------------------------------
  // Top-up ladder. Bonus % rises with size to pull customers up the rungs.
  // -------------------------------------------------------------------------
  const insTier = db.prepare(`
    INSERT INTO topup_tiers (shop_id,pay_pence,bonus_pence,label,is_featured)
    VALUES (?,?,?,?,?)`);
  const tiers = [
    [2000,  100,  'Get started',           0],
    [3000,  300,  '10% bonus',             0],
    [5000,  500,  '10% bonus',             1],  // the £50 → £55 the brief asked for
    [10000, 1500, '15% bonus · popular',   0],
    [20000, 4000, '20% bonus · best value',0],
  ];
  tiers.forEach((t) => insTier.run(shopId, t[0], t[1], t[2], t[3]));

  // -------------------------------------------------------------------------
  // Customers with behavioural archetypes
  // -------------------------------------------------------------------------
  // Behavioural archetypes.
  //
  // The `one_off` and `tried_twice` groups carry deliberately heavy weight.
  // Every real barbershop has a long tail of people who came once or twice and
  // never returned — and without them the rebook rate computes to ~90%, which
  // is a figure no owner will believe for a second. Modelling churn honestly is
  // what makes the retention features look valuable rather than redundant.
  const PROFILES = [
    // w = relative weight; maxVisits caps a customer's lifetime visit count
    { w: 20, kind: 'loyal',       cycleMean: 22, cycleSd: 3,  addon: 1.5, wallet: 0.75, stopsAfterMonth: null },
    { w: 18, kind: 'regular',     cycleMean: 29, cycleSd: 5,  addon: 1.0, wallet: 0.40, stopsAfterMonth: null },
    { w: 22, kind: 'one_off',     cycleMean: 30, cycleSd: 10, addon: 0.6, wallet: 0.03, maxVisits: 1 },
    { w: 14, kind: 'tried_twice', cycleMean: 34, cycleSd: 12, addon: 0.7, wallet: 0.08, maxVisits: 2 },
    { w: 11, kind: 'casual',      cycleMean: 48, cycleSd: 14, addon: 0.7, wallet: 0.15, stopsAfterMonth: null },
    { w: 10, kind: 'drifting',    cycleMean: 34, cycleSd: 9,  addon: 0.8, wallet: 0.25, stopsAfterMonth: null, drift: 1.6 },
    { w: 9,  kind: 'lapsed',      cycleMean: 28, cycleSd: 6,  addon: 0.9, wallet: 0.30, stopsAfterMonth: 6 },
    { w: 7,  kind: 'new',         cycleMean: 26, cycleSd: 5,  addon: 1.2, wallet: 0.45, startsAfterMonth: 9 },
    { w: 6,  kind: 'vip',         cycleMean: 17, cycleSd: 2,  addon: 2.2, wallet: 0.90, stopsAfterMonth: null },
  ];
  const profilePool = PROFILES.flatMap((p) => Array(p.w).fill(p));

  const insCustomer = db.prepare(`
    INSERT INTO customers (shop_id,name,email,phone,avatar_emoji,referral_code,
                           preferred_barber_id,created_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  const insWallet = db.prepare(
    'INSERT INTO wallet_accounts (customer_id,cash_pence,bonus_pence) VALUES (?,0,0)');

  // A five-chair high-street shop carries roughly 400-600 customers on the
  // books. Seeding too few produces a dashboard showing three cuts a week,
  // which reads as a broken product rather than a quiet shop.
  // Raised to absorb the one-off/tried-twice tail, which contributes few
  // appointments each, so total volume still reads like a busy five-chair shop.
  const CUSTOMER_COUNT = 620;
  const usedNames = new Set();
  const customers = [];

  for (let i = 0; i < CUSTOMER_COUNT; i++) {
    let name;
    do { name = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`; } while (usedNames.has(name));
    usedNames.add(name);

    const profile = profilePool[i % profilePool.length];
    const startMonth = profile.startsAfterMonth ?? 0;
    // Short-lifetime customers arrive steadily across the year rather than all
    // at the start — otherwise every one-off shows up as lapsed 11 months ago
    // and the churn picture is a cliff instead of a trickle.
    const joined = profile.maxVisits
      ? addDays(now, -randInt(10, 360))
      : addDays(now, -Math.round((12 - startMonth) * 30.4) + randInt(0, 12));
    const handle = name.toLowerCase().replace(/[^a-z]+/g, '.');

    // 70% have a favourite barber; the rest take whoever is free. Favourites
    // follow demand too — the popular chair accumulates the regulars.
    const preferredBarber = rand() < 0.7 ? pickBarber() : null;

    const id = insCustomer.run(
      shopId, name, `${handle}@example.com`,
      `07${randInt(100, 999)} ${randInt(100000, 999999)}`,
      pick(AVATARS), code(6),
      preferredBarber ? preferredBarber.id : null,
      iso(joined),
    ).lastInsertRowid;
    insWallet.run(id);
    customers.push({ id, name, profile, joined, preferredBarber });
  }

  // -------------------------------------------------------------------------
  // Appointment history
  // -------------------------------------------------------------------------
  const insAppt = db.prepare(`
    INSERT INTO appointments (shop_id,customer_id,barber_id,service_id,starts_at,duration_min,
      status,service_pence,addons_pence,discount_pence,total_pence,paid_with,source,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insApptAddon = db.prepare(`
    INSERT OR IGNORE INTO appointment_addons (appointment_id,addon_id,price_pence) VALUES (?,?,?)`);

  // Track which barber/slot pairs are taken so the unique index never trips.
  const taken = new Set();
  function freeSlot(barberId, date) {
    // Snap to a 30-minute grid within opening hours.
    for (let attempt = 0; attempt < 40; attempt++) {
      const hour = randInt(9, 18);
      const minute = pick([0, 30]);
      const d = new Date(date);
      d.setUTCHours(hour, minute, 0, 0);
      const key = `${barberId}|${iso(d)}`;
      if (!taken.has(key)) { taken.add(key); return d; }
    }
    return null;
  }

  const completedByCustomer = new Map();

  for (const cust of customers) {
    const p = cust.profile;
    let cursor = new Date(cust.joined);
    let visitIndex = 0;
    const stopAt = p.stopsAfterMonth != null
      ? addDays(now, -Math.round((12 - p.stopsAfterMonth) * 30.4))
      : null;

    const visitCap = p.maxVisits ?? Infinity;

    while (cursor < now) {
      if (visitIndex >= visitCap) break;
      // Drifting customers stretch their gap a little on each visit.
      const driftFactor = p.drift ? 1 + (visitIndex * (p.drift - 1)) / 12 : 1;
      const gap = Math.max(8, Math.round(gauss(p.cycleMean * driftFactor, p.cycleSd)));
      cursor = addDays(cursor, gap);
      if (cursor >= now) break;
      if (stopAt && cursor > stopAt) break;
      // The shop trades seven days with lighter weekend cover. This is a
      // deliberate demo decision: if we close a day, then demoing on that day
      // shows the owner a dashboard reading £0 today, and the product looks
      // broken rather than the shop looking shut.
      if (cursor.getUTCDay() === 0 && rand() < 0.45) cursor = addDays(cursor, 1);

      // Customers with a favourite mostly stick with them; otherwise the
      // busier chairs win.
      const barber = (cust.preferredBarber && rand() < 0.72)
        ? cust.preferredBarber : pickBarber();
      const slot = freeSlot(barber.id, cursor);
      if (!slot) continue;

      const service = p.kind === 'vip'
        ? pick([services[0], services[3], services[5]])
        : pick(services);

      // Status: mostly completed, with a realistic sprinkle of no-shows.
      const roll = rand();
      let status = 'completed';
      if (roll > 0.965) status = 'no_show';
      else if (roll > 0.94) status = 'cancelled';

      // Add-ons, weighted by the customer's appetite and the add-on's base rate.
      // Attach probability blends the add-on's own popularity, the customer's
      // appetite, and how good this barber is at asking.
      const chosen = [];
      if (status === 'completed') {
        for (const a of addons) {
          if (rand() < Math.min(0.85, a.baseRate * p.addon * barber.upsell)) chosen.push(a);
        }
        // Beard trim and hot towel are near-substitutes; rarely both.
        if (chosen.some((a) => a.name === 'Hot Towel Shave') && rand() < 0.7) {
          const i = chosen.findIndex((a) => a.name === 'Beard Trim');
          if (i >= 0) chosen.splice(i, 1);
        }
      }
      const addonsPence = chosen.reduce((s, a) => s + a.price, 0);
      const servicePence = status === 'completed' ? service.price : 0;
      const total = servicePence + addonsPence;

      const paid = status !== 'completed' ? 'unpaid'
        : rand() < p.wallet ? 'wallet' : (rand() < 0.75 ? 'card' : 'cash');
      const source = visitIndex === 0 ? (rand() < 0.3 ? 'referral' : 'app')
        : rand() < 0.42 ? 'reminder' : (rand() < 0.85 ? 'app' : 'walk_in');

      const apptId = insAppt.run(
        shopId, cust.id, barber.id, service.id, iso(slot), service.duration,
        status, servicePence, addonsPence, 0, total, paid, source,
        iso(addDays(slot, -randInt(1, 9))),
      ).lastInsertRowid;

      for (const a of chosen) insApptAddon.run(apptId, a.id, a.price);

      if (status === 'completed') {
        if (!completedByCustomer.has(cust.id)) completedByCustomer.set(cust.id, []);
        completedByCustomer.get(cust.id).push({ apptId, at: slot, total });
      }
      visitIndex++;
    }
  }

  // -------------------------------------------------------------------------
  // Upcoming bookings so "today" and the week ahead aren't empty on screen.
  // -------------------------------------------------------------------------
  const activeCustomers = customers.filter(
    (c) => c.profile.stopsAfterMonth == null && completedByCustomer.has(c.id));
  for (let day = 0; day <= 6; day++) {
    const date = addDays(now, day);
    // Sundays run a reduced rota rather than closing (see note above).
    const sunday = date.getUTCDay() === 0;
    const count = day === 0
      ? (sunday ? randInt(11, 16) : randInt(19, 27))
      : (sunday ? randInt(8, 13)  : randInt(13, 23));
    for (let i = 0; i < count; i++) {
      const cust = pick(activeCustomers);
      const barber = (cust.preferredBarber && rand() < 0.72)
        ? cust.preferredBarber : pickBarber();
      const slot = freeSlot(barber.id, date);
      if (!slot) continue;
      const service = pick(services);
      // Today's earlier appointments are already done; later ones still booked.
      const isPast = day === 0 && slot < now;
      const chosen = addons.filter((a) => rand() < a.baseRate * 1.6 * barber.upsell);
      const addonsPence = chosen.reduce((s, a) => s + a.price, 0);
      const total = service.price + addonsPence;
      const apptId = insAppt.run(
        shopId, cust.id, barber.id, service.id, iso(slot), service.duration,
        isPast ? 'completed' : 'booked',
        service.price, addonsPence, 0, total,
        isPast ? (rand() < 0.5 ? 'wallet' : 'card') : 'unpaid',
        rand() < 0.4 ? 'reminder' : 'app',
        iso(addDays(slot, -randInt(1, 6))),
      ).lastInsertRowid;
      for (const a of chosen) insApptAddon.run(apptId, a.id, a.price);
      if (isPast) {
        if (!completedByCustomer.has(cust.id)) completedByCustomer.set(cust.id, []);
        completedByCustomer.get(cust.id).push({ apptId, at: slot, total });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Wallet history. Replayed chronologically so balance_after is truthful.
  // -------------------------------------------------------------------------
  const walletRow = db.prepare('SELECT id FROM wallet_accounts WHERE customer_id = ?');
  const insTx = db.prepare(`
    INSERT INTO wallet_transactions (wallet_id,kind,amount_pence,bucket,cash_delta,bonus_delta,
      balance_after,appointment_id,description,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const updWallet = db.prepare(`
    UPDATE wallet_accounts SET cash_pence=?, bonus_pence=?,
      lifetime_topup_pence=?, lifetime_bonus_pence=? WHERE id=?`);

  for (const cust of customers) {
    const wallet = walletRow.get(cust.id);
    const visits = (completedByCustomer.get(cust.id) || [])
      .filter((v) => true).sort((a, b) => a.at - b.at);
    const walletVisits = visits.filter(() => rand() < cust.profile.wallet);
    if (walletVisits.length === 0 && cust.profile.wallet < 0.5) continue;

    let cash = 0, bonus = 0, lifeTopup = 0, lifeBonus = 0;
    const events = [];

    // Top up when the balance would not cover the next visit, choosing the
    // smallest tier that covers the next few visits. Picking tiers at random
    // produces customers sitting on £300 of credit, which inflates the wallet
    // liability into something no owner would recognise.
    let projected = 0;
    for (let i = 0; i < walletVisits.length; i++) {
      const v = walletVisits[i];
      if (projected < v.total) {
        // Cover the next 2-4 visits.
        const horizon = walletVisits.slice(i, i + randInt(2, 4));
        const needed = horizon.reduce((s, x) => s + x.total, 0);
        const tier = tiers.find((t) => t[0] + t[1] >= needed) || tiers[tiers.length - 1];
        events.push({ type: 'topup', at: addDays(v.at, -randInt(0, 2)), tier });
        projected += tier[0] + tier[1];
      }
      events.push({ type: 'spend', at: v.at, amount: v.total, apptId: v.apptId });
      projected -= v.total;
    }
    events.sort((a, b) => a.at - b.at);

    for (const e of events) {
      if (e.type === 'topup') {
        const [pay, bns] = [e.tier[0], e.tier[1]];
        cash += pay; bonus += bns; lifeTopup += pay; lifeBonus += bns;
        insTx.run(wallet.id, 'topup', pay, 'cash', pay, 0, cash + bonus, null,
          `Top-up £${(pay / 100).toFixed(2)}`, iso(e.at));
        insTx.run(wallet.id, 'bonus', bns, 'bonus', 0, bns, cash + bonus, null,
          `Bonus credit £${(bns / 100).toFixed(2)}`, iso(e.at));
      } else {
        // Spend bonus first — it protects refundable cash and burns the
        // promotional liability off the books sooner.
        const fromBonus = Math.min(bonus, e.amount);
        const fromCash = Math.min(cash, e.amount - fromBonus);
        const spent = fromBonus + fromCash;
        if (spent <= 0) continue;
        bonus -= fromBonus; cash -= fromCash;
        insTx.run(wallet.id, 'spend', -spent, 'split', -fromCash, -fromBonus,
          cash + bonus, e.apptId, 'Paid for appointment', iso(e.at));
      }
    }
    updWallet.run(cash, bonus, lifeTopup, lifeBonus, wallet.id);
  }

  // -------------------------------------------------------------------------
  // Referrals. Chains build from customers who already have history.
  // -------------------------------------------------------------------------
  const custCode = db.prepare('SELECT referral_code FROM customers WHERE id = ?');
  const insRef = db.prepare(`
    INSERT OR IGNORE INTO referrals (shop_id,referrer_id,referred_id,code,invited_contact,
      status,reward_pence,qualifying_appointment_id,created_at,rewarded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const setReferredBy = db.prepare('UPDATE customers SET referred_by_id = ? WHERE id = ?');

  const established = customers.filter((c) => (completedByCustomer.get(c.id) || []).length >= 3);
  const newcomers = customers.filter((c) => c.profile.kind === 'new' || c.profile.kind === 'casual');
  let refPairs = 0;

  for (const invited of newcomers) {
    if (rand() > 0.55) continue;
    const referrer = pick(established);
    if (referrer.id === invited.id) continue;
    const visits = completedByCustomer.get(invited.id) || [];
    const qualifying = visits[0];
    // Reward only once the invited customer has actually been in the chair.
    const status = qualifying ? 'rewarded' : 'signed_up';
    const ok = insRef.run(
      shopId, referrer.id, invited.id, custCode.get(referrer.id).referral_code,
      null, status, 1000, qualifying ? qualifying.apptId : null,
      iso(addDays(invited.joined, -randInt(1, 5))),
      qualifying ? iso(qualifying.at) : null,
    );
    if (ok.changes) {
      setReferredBy.run(referrer.id, invited.id);
      refPairs++;
      // Credit both sides for rewarded referrals.
      if (status === 'rewarded') {
        for (const side of [referrer.id, invited.id]) {
          const w = walletRow.get(side);
          const cur = db.prepare(
            'SELECT cash_pence, bonus_pence FROM wallet_accounts WHERE id = ?').get(w.id);
          const nb = cur.bonus_pence + 1000;
          db.prepare('UPDATE wallet_accounts SET bonus_pence = ? WHERE id = ?').run(nb, w.id);
          insTx.run(w.id, 'referral_credit', 1000, 'bonus', 0, 1000,
            cur.cash_pence + nb, null, 'Referral reward £10.00', iso(qualifying.at));
        }
      }
    }
  }

  // Some invitations sent but never claimed — realistic funnel leakage.
  for (const referrer of established.slice(0, 14)) {
    const n = randInt(1, 3);
    for (let i = 0; i < n; i++) {
      db.prepare(`INSERT INTO referrals (shop_id,referrer_id,referred_id,code,invited_contact,
        status,reward_pence,created_at) VALUES (?,?,NULL,?,?,?,?,?)`).run(
        shopId, referrer.id, custCode.get(referrer.id).referral_code,
        `07${randInt(100, 999)}${randInt(100000, 999999)}`,
        rand() < 0.3 ? 'expired' : 'sent', 1000,
        iso(addDays(now, -randInt(5, 120))));
    }
  }

  // -------------------------------------------------------------------------
  // Reminders. Generated by the same engine the app uses at runtime, so the
  // seeded state and live behaviour cannot drift apart.
  // -------------------------------------------------------------------------
  const { rebuildReminders } = require('./intelligence');
  const reminderCount = rebuildReminders(db, shopId);

  const counts = {
    shop: 'Sharp & Co. Barbers',
    barbers: barbers.length,
    customers: customers.length,
    services: services.length,
    addons: addons.length,
    appointments: db.prepare('SELECT COUNT(*) n FROM appointments').get().n,
    completed: db.prepare("SELECT COUNT(*) n FROM appointments WHERE status='completed'").get().n,
    walletTx: db.prepare('SELECT COUNT(*) n FROM wallet_transactions').get().n,
    referrals: db.prepare('SELECT COUNT(*) n FROM referrals').get().n,
    reminders: reminderCount,
  };
  return counts;
}

module.exports = { seed };
