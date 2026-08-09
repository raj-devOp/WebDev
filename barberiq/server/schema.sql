-- ============================================================================
-- BarberIQ — Intelligent Barbershop Operating System
-- SQLite schema (portable to Postgres/MySQL with minimal changes)
--
-- Money is stored in PENCE as INTEGER. Never store money as float.
-- Timestamps are ISO-8601 strings in UTC.
-- ============================================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ---------------------------------------------------------------------------
-- Tenancy: one row per barbershop (multi-tenant ready)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shops (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL,
  slug              TEXT    NOT NULL UNIQUE,
  address_line1     TEXT,
  city              TEXT,
  postcode          TEXT,
  phone             TEXT,
  email             TEXT,
  timezone          TEXT    NOT NULL DEFAULT 'Europe/London',
  currency          TEXT    NOT NULL DEFAULT 'GBP',
  -- Commercial: which plan this shop is on, and trial state
  plan_code         TEXT    NOT NULL DEFAULT 'professional',
  trial_ends_at     TEXT,
  subscription_state TEXT   NOT NULL DEFAULT 'trialing'
                            CHECK (subscription_state IN ('trialing','active','past_due','cancelled')),
  opens_at          TEXT    NOT NULL DEFAULT '09:00',
  closes_at         TEXT    NOT NULL DEFAULT '19:00',
  slot_minutes      INTEGER NOT NULL DEFAULT 30,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Staff
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS barbers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id       INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  nickname      TEXT,
  avatar_emoji  TEXT    NOT NULL DEFAULT '💈',
  specialty     TEXT,
  -- commission_bps: basis points of service revenue paid to the barber
  commission_bps INTEGER NOT NULL DEFAULT 4000,
  rating        REAL    NOT NULL DEFAULT 5.0,
  active        INTEGER NOT NULL DEFAULT 1,
  hired_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_barbers_shop ON barbers(shop_id, active);

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id         INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  email           TEXT,
  phone           TEXT,
  avatar_emoji    TEXT    NOT NULL DEFAULT '🙂',
  -- The customer's own referral code. Shareable.
  referral_code   TEXT    NOT NULL UNIQUE,
  -- Who introduced them (nullable). Self-reference.
  referred_by_id  INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  preferred_barber_id INTEGER REFERENCES barbers(id) ON DELETE SET NULL,
  notify_sms      INTEGER NOT NULL DEFAULT 1,
  notify_email    INTEGER NOT NULL DEFAULT 1,
  notify_push     INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_customers_shop ON customers(shop_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email ON customers(shop_id, email);

-- ---------------------------------------------------------------------------
-- Catalogue: core services and add-ons
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS services (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id        INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name           TEXT    NOT NULL,
  description    TEXT,
  price_pence    INTEGER NOT NULL CHECK (price_pence >= 0),
  duration_min   INTEGER NOT NULL DEFAULT 30,
  icon           TEXT    NOT NULL DEFAULT '✂️',
  -- Typical days between visits for this service. Seeds the reminder engine
  -- before we have enough personal history to learn from.
  default_cycle_days INTEGER NOT NULL DEFAULT 28,
  active         INTEGER NOT NULL DEFAULT 1,
  sort_order     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS addons (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id      INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  description  TEXT,
  price_pence  INTEGER NOT NULL CHECK (price_pence >= 0),
  duration_min INTEGER NOT NULL DEFAULT 10,
  icon         TEXT    NOT NULL DEFAULT '✨',
  active       INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- Appointments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS appointments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id         INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id     INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  barber_id       INTEGER NOT NULL REFERENCES barbers(id) ON DELETE RESTRICT,
  service_id      INTEGER NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  starts_at       TEXT    NOT NULL,          -- ISO-8601 UTC
  duration_min    INTEGER NOT NULL DEFAULT 30,
  status          TEXT    NOT NULL DEFAULT 'booked'
                          CHECK (status IN ('booked','completed','cancelled','no_show')),
  -- Money breakdown, all in pence. total = service + addons - discount
  service_pence   INTEGER NOT NULL DEFAULT 0,
  addons_pence    INTEGER NOT NULL DEFAULT 0,
  discount_pence  INTEGER NOT NULL DEFAULT 0,
  total_pence     INTEGER NOT NULL DEFAULT 0,
  paid_with       TEXT    NOT NULL DEFAULT 'unpaid'
                          CHECK (paid_with IN ('unpaid','wallet','card','cash')),
  -- Which channel drove this booking. Lets us prove the reminder engine's ROI.
  source          TEXT    NOT NULL DEFAULT 'app'
                          CHECK (source IN ('app','reminder','walk_in','phone','referral')),
  notes           TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_appt_shop_start   ON appointments(shop_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_appt_customer     ON appointments(customer_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_appt_barber_start ON appointments(barber_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_appt_status       ON appointments(shop_id, status);
-- A barber cannot be double-booked at the same instant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_no_double_book
  ON appointments(barber_id, starts_at)
  WHERE status IN ('booked','completed');

-- Line items: which add-ons were attached to an appointment.
-- Price is copied at time of sale so later price changes don't rewrite history.
CREATE TABLE IF NOT EXISTS appointment_addons (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id  INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  addon_id        INTEGER NOT NULL REFERENCES addons(id) ON DELETE RESTRICT,
  price_pence     INTEGER NOT NULL,
  UNIQUE (appointment_id, addon_id)
);
CREATE INDEX IF NOT EXISTS idx_apptaddon_addon ON appointment_addons(addon_id);

-- ---------------------------------------------------------------------------
-- WALLET — stored value with top-up bonuses
--
-- Design note: we deliberately track `cash_pence` (real money the customer
-- paid) separately from `bonus_pence` (promotional credit we granted).
-- The finance reason: only cash is a refundable liability. Bonus is a
-- marketing cost. Blending them makes your balance sheet a guess.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wallet_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   INTEGER NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
  cash_pence    INTEGER NOT NULL DEFAULT 0 CHECK (cash_pence  >= 0),
  bonus_pence   INTEGER NOT NULL DEFAULT 0 CHECK (bonus_pence >= 0),
  lifetime_topup_pence INTEGER NOT NULL DEFAULT 0,
  lifetime_bonus_pence INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_id      INTEGER NOT NULL REFERENCES wallet_accounts(id) ON DELETE CASCADE,
  -- topup: customer paid in. bonus: we granted promo credit.
  -- spend: consumed at checkout. refund/adjustment: manual corrections.
  kind           TEXT    NOT NULL CHECK (kind IN
                         ('topup','bonus','spend','refund','referral_credit','adjustment','expiry')),
  -- Signed amount: positive increases balance, negative decreases.
  amount_pence   INTEGER NOT NULL,
  -- Which bucket moved, so we can always reconcile cash vs bonus.
  bucket         TEXT    NOT NULL DEFAULT 'cash' CHECK (bucket IN ('cash','bonus','split')),
  cash_delta     INTEGER NOT NULL DEFAULT 0,
  bonus_delta    INTEGER NOT NULL DEFAULT 0,
  balance_after  INTEGER NOT NULL,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  description    TEXT    NOT NULL,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wtx_wallet ON wallet_transactions(wallet_id, created_at DESC);

-- The published top-up ladder. Editable per shop without a code change.
CREATE TABLE IF NOT EXISTS topup_tiers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id         INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  pay_pence       INTEGER NOT NULL,
  bonus_pence     INTEGER NOT NULL,
  label           TEXT,
  is_featured     INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  UNIQUE (shop_id, pay_pence)
);

-- ---------------------------------------------------------------------------
-- REFERRALS — two-sided reward
--
-- Fraud guard: a referral only pays out once the invited customer has
-- COMPLETED (not merely booked) their first appointment. Without this rule
-- a shop can be drained by fake sign-ups. This is the single most important
-- control in the whole referral feature.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS referrals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id           INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  referrer_id       INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  -- Null until the invite is actually claimed by a real sign-up.
  referred_id       INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  code              TEXT    NOT NULL,
  invited_contact   TEXT,
  status            TEXT    NOT NULL DEFAULT 'sent'
                            CHECK (status IN ('sent','signed_up','qualified','rewarded','expired','blocked')),
  reward_pence      INTEGER NOT NULL DEFAULT 1000,
  qualifying_appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  rewarded_at       TEXT,
  -- One payout per invited person, ever.
  UNIQUE (referred_id)
);
CREATE INDEX IF NOT EXISTS idx_ref_referrer ON referrals(referrer_id, status);
CREATE INDEX IF NOT EXISTS idx_ref_code     ON referrals(code);

-- ---------------------------------------------------------------------------
-- REMINDERS — the automatic rebook nudge
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reminders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id        INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id    INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  -- due_date is what the intelligence engine predicted, send_on is when we nudge
  due_date       TEXT    NOT NULL,
  send_on        TEXT    NOT NULL,
  channel        TEXT    NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms','email','push')),
  status         TEXT    NOT NULL DEFAULT 'scheduled'
                         CHECK (status IN ('scheduled','sent','opened','booked','snoozed','dismissed','failed')),
  -- Why we picked this date. Shown in the UI so the owner trusts the machine.
  reason         TEXT,
  predicted_cycle_days INTEGER,
  confidence     REAL,
  message        TEXT,
  sent_at        TEXT,
  resulting_appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rem_send   ON reminders(shop_id, send_on, status);
CREATE INDEX IF NOT EXISTS idx_rem_cust   ON reminders(customer_id, status);

-- ---------------------------------------------------------------------------
-- Commercial: the plans we sell to barbershop owners
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plans (
  code              TEXT PRIMARY KEY,
  name              TEXT    NOT NULL,
  setup_pence       INTEGER NOT NULL,
  monthly_pence     INTEGER NOT NULL,
  max_chairs        INTEGER,
  blurb             TEXT,
  features_json     TEXT    NOT NULL DEFAULT '[]',
  is_featured       INTEGER NOT NULL DEFAULT 0,
  sort_order        INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- Reporting views. Keeping the aggregation in SQL means the dashboard stays
-- fast and the numbers are defined in exactly one place.
-- ---------------------------------------------------------------------------

-- Revenue per completed appointment, with the day bucketed for grouping.
DROP VIEW IF EXISTS v_appointment_revenue;
CREATE VIEW v_appointment_revenue AS
SELECT
  a.id, a.shop_id, a.customer_id, a.barber_id, a.service_id,
  a.starts_at, date(a.starts_at) AS day, a.status, a.source,
  a.service_pence, a.addons_pence, a.discount_pence, a.total_pence,
  CASE WHEN a.addons_pence > 0 THEN 1 ELSE 0 END AS has_addon
FROM appointments a
WHERE a.status = 'completed';

-- Per-barber performance. Utilisation is measured against actual booked
-- minutes rather than a hardcoded shift length.
DROP VIEW IF EXISTS v_barber_performance;
CREATE VIEW v_barber_performance AS
SELECT
  b.id               AS barber_id,
  b.shop_id,
  b.name,
  b.nickname,
  b.avatar_emoji,
  b.specialty,
  b.rating,
  COUNT(r.id)                                   AS cuts,
  COALESCE(SUM(r.total_pence), 0)               AS revenue_pence,
  COALESCE(SUM(r.addons_pence), 0)              AS addon_revenue_pence,
  CAST(COALESCE(AVG(r.total_pence), 0) AS INTEGER) AS avg_ticket_pence,
  ROUND(100.0 * COALESCE(SUM(r.has_addon), 0) / NULLIF(COUNT(r.id), 0), 1) AS addon_attach_pct,
  COALESCE(SUM(r.total_pence) * b.commission_bps / 10000, 0) AS commission_pence
FROM barbers b
LEFT JOIN v_appointment_revenue r ON r.barber_id = b.id
GROUP BY b.id;

-- Customer lifetime value plus the raw signals the churn model needs.
DROP VIEW IF EXISTS v_customer_value;
CREATE VIEW v_customer_value AS
SELECT
  c.id            AS customer_id,
  c.shop_id,
  c.name,
  c.avatar_emoji,
  c.email,
  c.phone,
  c.created_at,
  COUNT(r.id)                                      AS visits,
  COALESCE(SUM(r.total_pence), 0)                  AS lifetime_pence,
  CAST(COALESCE(AVG(r.total_pence), 0) AS INTEGER) AS avg_ticket_pence,
  MAX(r.starts_at)                                 AS last_visit_at,
  MIN(r.starts_at)                                 AS first_visit_at,
  CAST(julianday('now') - julianday(MAX(r.starts_at)) AS INTEGER) AS days_since_visit,
  COALESCE(w.cash_pence, 0) + COALESCE(w.bonus_pence, 0) AS wallet_balance_pence,
  (SELECT COUNT(*) FROM referrals rf
     WHERE rf.referrer_id = c.id AND rf.status = 'rewarded') AS successful_referrals
FROM customers c
LEFT JOIN v_appointment_revenue r ON r.customer_id = c.id
LEFT JOIN wallet_accounts w       ON w.customer_id = c.id
GROUP BY c.id;

-- Outstanding wallet liability, split so finance can see what is genuinely
-- refundable cash versus promotional credit.
DROP VIEW IF EXISTS v_wallet_liability;
CREATE VIEW v_wallet_liability AS
SELECT
  c.shop_id,
  COALESCE(SUM(w.cash_pence), 0)  AS cash_liability_pence,
  COALESCE(SUM(w.bonus_pence), 0) AS bonus_liability_pence,
  COALESCE(SUM(w.cash_pence + w.bonus_pence), 0) AS total_liability_pence,
  COALESCE(SUM(w.lifetime_topup_pence), 0) AS lifetime_topup_pence,
  COALESCE(SUM(w.lifetime_bonus_pence), 0) AS lifetime_bonus_pence
FROM wallet_accounts w
JOIN customers c ON c.id = w.customer_id
GROUP BY c.shop_id;

-- How often each add-on is attached, and what it earns.
--
-- Careful with the join here: putting `a.status = 'completed'` in a LEFT JOIN's
-- ON clause does NOT filter anything — unmatched rows survive with a.id NULL
-- while COUNT(aa.id) still counts them, so add-ons sold on cancelled and
-- no-show appointments inflate both the volume and the revenue. The filter has
-- to happen before the outer join, hence the subquery.
DROP VIEW IF EXISTS v_addon_performance;
CREATE VIEW v_addon_performance AS
SELECT
  ad.id       AS addon_id,
  ad.shop_id,
  ad.name,
  ad.icon,
  ad.price_pence,
  COUNT(sold.id)                          AS times_sold,
  COALESCE(SUM(sold.price_pence), 0)      AS revenue_pence
FROM addons ad
LEFT JOIN (
  SELECT aa.id, aa.addon_id, aa.price_pence
  FROM appointment_addons aa
  JOIN appointments a ON a.id = aa.appointment_id
  WHERE a.status = 'completed'
) AS sold ON sold.addon_id = ad.id
GROUP BY ad.id;
