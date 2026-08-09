-- ============================================================================
-- BarberIQ — MySQL / MariaDB schema for Hostinger shared hosting
--
-- Written to run on both MySQL 5.7+ and MariaDB 10.2+, which covers every
-- Hostinger plan. Import via hPanel → phpMyAdmin → Import, or let
-- install/index.php do it for you.
--
-- Money is stored in PENCE as INT. Never store money as a float.
-- Timestamps are DATETIME in UTC.
-- ============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS `shops`;
CREATE TABLE `shops` (
  `id`                 INT AUTO_INCREMENT PRIMARY KEY,
  `name`               VARCHAR(160) NOT NULL,
  `slug`               VARCHAR(160) NOT NULL,
  `address_line1`      VARCHAR(200) NULL,
  `city`               VARCHAR(100) NULL,
  `postcode`           VARCHAR(20)  NULL,
  `phone`              VARCHAR(40)  NULL,
  `email`              VARCHAR(190) NULL,
  `timezone`           VARCHAR(64)  NOT NULL DEFAULT 'Europe/London',
  `currency`           CHAR(3)      NOT NULL DEFAULT 'GBP',
  `plan_code`          VARCHAR(32)  NOT NULL DEFAULT 'professional',
  `trial_ends_at`      DATETIME     NULL,
  `subscription_state` ENUM('trialing','active','past_due','cancelled') NOT NULL DEFAULT 'trialing',
  `opens_at`           TIME         NOT NULL DEFAULT '09:00:00',
  `closes_at`          TIME         NOT NULL DEFAULT '19:00:00',
  `slot_minutes`       INT          NOT NULL DEFAULT 30,
  `created_at`         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_shops_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Staff
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS `barbers`;
CREATE TABLE `barbers` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `shop_id`        INT NOT NULL,
  `name`           VARCHAR(160) NOT NULL,
  `nickname`       VARCHAR(60)  NULL,
  `avatar_emoji`   VARCHAR(16)  NOT NULL DEFAULT '💈',
  `specialty`      VARCHAR(190) NULL,
  -- basis points of service revenue paid to the barber (4000 = 40%)
  `commission_bps` INT     NOT NULL DEFAULT 4000,
  `rating`         DECIMAL(2,1) NOT NULL DEFAULT 5.0,
  `active`         TINYINT(1)   NOT NULL DEFAULT 1,
  `hired_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_barbers_shop` (`shop_id`, `active`),
  CONSTRAINT `fk_barbers_shop` FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS `customers`;
CREATE TABLE `customers` (
  `id`                  INT AUTO_INCREMENT PRIMARY KEY,
  `shop_id`             INT NOT NULL,
  `name`                VARCHAR(160) NOT NULL,
  `email`               VARCHAR(190) NULL,
  `phone`               VARCHAR(40)  NULL,
  `avatar_emoji`        VARCHAR(16)  NOT NULL DEFAULT '🙂',
  `referral_code`       VARCHAR(16)  NOT NULL,
  `referred_by_id`      INT NULL,
  `preferred_barber_id` INT NULL,
  `notify_sms`          TINYINT(1) NOT NULL DEFAULT 1,
  `notify_email`        TINYINT(1) NOT NULL DEFAULT 1,
  `notify_push`         TINYINT(1) NOT NULL DEFAULT 1,
  `created_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_customers_code` (`referral_code`),
  UNIQUE KEY `uq_customers_email` (`shop_id`, `email`),
  KEY `idx_customers_shop` (`shop_id`),
  CONSTRAINT `fk_customers_shop`   FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_customers_ref`    FOREIGN KEY (`referred_by_id`) REFERENCES `customers`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_customers_barber` FOREIGN KEY (`preferred_barber_id`) REFERENCES `barbers`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS `services`;
CREATE TABLE `services` (
  `id`                 INT AUTO_INCREMENT PRIMARY KEY,
  `shop_id`            INT NOT NULL,
  `name`               VARCHAR(160) NOT NULL,
  `description`        VARCHAR(500) NULL,
  `price_pence`        INT NOT NULL,
  `duration_min`       INT NOT NULL DEFAULT 30,
  `icon`               VARCHAR(16) NOT NULL DEFAULT '✂️',
  -- Typical days between visits, used by the reminder engine before there is
  -- enough personal history to learn from.
  `default_cycle_days` INT NOT NULL DEFAULT 28,
  `active`             TINYINT(1) NOT NULL DEFAULT 1,
  `sort_order`         INT NOT NULL DEFAULT 0,
  KEY `idx_services_shop` (`shop_id`, `active`),
  CONSTRAINT `fk_services_shop` FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE CASCADE,
  CONSTRAINT `chk_services_price` CHECK (`price_pence` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `addons`;
CREATE TABLE `addons` (
  `id`           INT AUTO_INCREMENT PRIMARY KEY,
  `shop_id`      INT NOT NULL,
  `name`         VARCHAR(160) NOT NULL,
  `description`  VARCHAR(500) NULL,
  `price_pence`  INT NOT NULL,
  `duration_min` INT NOT NULL DEFAULT 10,
  `icon`         VARCHAR(16) NOT NULL DEFAULT '✨',
  `active`       TINYINT(1) NOT NULL DEFAULT 1,
  `sort_order`   INT NOT NULL DEFAULT 0,
  KEY `idx_addons_shop` (`shop_id`, `active`),
  CONSTRAINT `fk_addons_shop` FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE CASCADE,
  CONSTRAINT `chk_addons_price` CHECK (`price_pence` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Appointments
--
-- MySQL has no partial (filtered) unique index, which is how the SQLite build
-- stopped a barber being double-booked. The equivalent here is a STORED
-- generated column that is NULL unless the appointment is live — MySQL permits
-- unlimited NULLs in a unique index, so cancelled slots free up automatically
-- while active ones stay locked.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS `appointments`;
CREATE TABLE `appointments` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `shop_id`        INT NOT NULL,
  `customer_id`    INT NOT NULL,
  `barber_id`      INT NOT NULL,
  `service_id`     INT NOT NULL,
  `starts_at`      DATETIME NOT NULL,
  `duration_min`   INT NOT NULL DEFAULT 30,
  `status`         ENUM('booked','completed','cancelled','no_show') NOT NULL DEFAULT 'booked',
  `service_pence`  INT NOT NULL DEFAULT 0,
  `addons_pence`   INT NOT NULL DEFAULT 0,
  `discount_pence` INT NOT NULL DEFAULT 0,
  `total_pence`    INT NOT NULL DEFAULT 0,
  `paid_with`      ENUM('unpaid','wallet','card','cash') NOT NULL DEFAULT 'unpaid',
  `source`         ENUM('app','reminder','walk_in','phone','referral') NOT NULL DEFAULT 'app',
  `notes`          VARCHAR(500) NULL,
  `created_at`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `active_slot`    VARCHAR(48) AS (
                     CASE WHEN `status` IN ('booked','completed')
                          THEN CONCAT(`barber_id`, '@', `starts_at`)
                          ELSE NULL END
                   ) STORED,
  UNIQUE KEY `uq_appt_active_slot` (`active_slot`),
  KEY `idx_appt_shop_start`   (`shop_id`, `starts_at`),
  KEY `idx_appt_customer`     (`customer_id`, `starts_at`),
  KEY `idx_appt_barber_start` (`barber_id`, `starts_at`),
  KEY `idx_appt_status`       (`shop_id`, `status`),
  CONSTRAINT `fk_appt_shop`     FOREIGN KEY (`shop_id`)     REFERENCES `shops`(`id`)     ON DELETE CASCADE,
  CONSTRAINT `fk_appt_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_appt_barber`   FOREIGN KEY (`barber_id`)   REFERENCES `barbers`(`id`)   ON DELETE RESTRICT,
  CONSTRAINT `fk_appt_service`  FOREIGN KEY (`service_id`)  REFERENCES `services`(`id`)  ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `appointment_addons`;
CREATE TABLE `appointment_addons` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `appointment_id` INT NOT NULL,
  `addon_id`       INT NOT NULL,
  -- price copied at time of sale so later price changes don't rewrite history
  `price_pence`    INT NOT NULL,
  UNIQUE KEY `uq_appt_addon` (`appointment_id`, `addon_id`),
  KEY `idx_apptaddon_addon` (`addon_id`),
  CONSTRAINT `fk_aa_appt`  FOREIGN KEY (`appointment_id`) REFERENCES `appointments`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_aa_addon` FOREIGN KEY (`addon_id`)       REFERENCES `addons`(`id`)       ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- WALLET
--
-- cash_pence is money the customer actually paid — a refundable liability.
-- bonus_pence is promotional credit — a marketing cost already incurred.
-- They are kept apart because blending them makes the balance sheet a guess.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS `wallet_accounts`;
CREATE TABLE `wallet_accounts` (
  `id`                   INT AUTO_INCREMENT PRIMARY KEY,
  `customer_id`          INT NOT NULL,
  `cash_pence`           INT NOT NULL DEFAULT 0,
  `bonus_pence`          INT NOT NULL DEFAULT 0,
  `lifetime_topup_pence` INT NOT NULL DEFAULT 0,
  `lifetime_bonus_pence` INT NOT NULL DEFAULT 0,
  `created_at`           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_wallet_customer` (`customer_id`),
  CONSTRAINT `fk_wallet_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  CONSTRAINT `chk_wallet_cash`  CHECK (`cash_pence`  >= 0),
  CONSTRAINT `chk_wallet_bonus` CHECK (`bonus_pence` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `wallet_transactions`;
CREATE TABLE `wallet_transactions` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `wallet_id`      INT NOT NULL,
  `kind`           ENUM('topup','bonus','spend','refund','referral_credit','adjustment','expiry') NOT NULL,
  -- signed: positive increases balance, negative decreases
  `amount_pence`   INT NOT NULL,
  `bucket`         ENUM('cash','bonus','split') NOT NULL DEFAULT 'cash',
  `cash_delta`     INT NOT NULL DEFAULT 0,
  `bonus_delta`    INT NOT NULL DEFAULT 0,
  `balance_after`  INT NOT NULL,
  `appointment_id` INT NULL,
  `description`    VARCHAR(255) NOT NULL,
  `created_at`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_wtx_wallet` (`wallet_id`, `created_at`),
  CONSTRAINT `fk_wtx_wallet` FOREIGN KEY (`wallet_id`)      REFERENCES `wallet_accounts`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_wtx_appt`   FOREIGN KEY (`appointment_id`) REFERENCES `appointments`(`id`)    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `topup_tiers`;
CREATE TABLE `topup_tiers` (
  `id`          INT AUTO_INCREMENT PRIMARY KEY,
  `shop_id`     INT NOT NULL,
  `pay_pence`   INT NOT NULL,
  `bonus_pence` INT NOT NULL,
  `label`       VARCHAR(80) NULL,
  `is_featured` TINYINT(1) NOT NULL DEFAULT 0,
  `active`      TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY `uq_tier` (`shop_id`, `pay_pence`),
  CONSTRAINT `fk_tier_shop` FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- REFERRALS
--
-- Fraud guard: a referral only pays out once the invited customer has
-- COMPLETED their first appointment, never on sign-up. Without this a shop can
-- be drained by fake accounts. UNIQUE on referred_id enforces one payout per
-- new customer, ever.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS `referrals`;
CREATE TABLE `referrals` (
  `id`                        INT AUTO_INCREMENT PRIMARY KEY,
  `shop_id`                   INT NOT NULL,
  `referrer_id`               INT NOT NULL,
  `referred_id`               INT NULL,
  `code`                      VARCHAR(16) NOT NULL,
  `invited_contact`           VARCHAR(190) NULL,
  `status`                    ENUM('sent','signed_up','qualified','rewarded','expired','blocked') NOT NULL DEFAULT 'sent',
  `reward_pence`              INT NOT NULL DEFAULT 1000,
  `qualifying_appointment_id` INT NULL,
  `created_at`                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `rewarded_at`               DATETIME NULL,
  UNIQUE KEY `uq_ref_referred` (`referred_id`),
  KEY `idx_ref_referrer` (`referrer_id`, `status`),
  KEY `idx_ref_code` (`code`),
  CONSTRAINT `fk_ref_shop`     FOREIGN KEY (`shop_id`)     REFERENCES `shops`(`id`)     ON DELETE CASCADE,
  CONSTRAINT `fk_ref_referrer` FOREIGN KEY (`referrer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_ref_referred` FOREIGN KEY (`referred_id`) REFERENCES `customers`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_ref_appt`     FOREIGN KEY (`qualifying_appointment_id`) REFERENCES `appointments`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- REMINDERS
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS `reminders`;
CREATE TABLE `reminders` (
  `id`                       INT AUTO_INCREMENT PRIMARY KEY,
  `shop_id`                  INT NOT NULL,
  `customer_id`              INT NOT NULL,
  `due_date`                 DATETIME NOT NULL,
  `send_on`                  DATETIME NOT NULL,
  `channel`                  ENUM('sms','email','push') NOT NULL DEFAULT 'sms',
  `status`                   ENUM('scheduled','sent','opened','booked','snoozed','dismissed','failed') NOT NULL DEFAULT 'scheduled',
  -- Why we picked this date. Shown in the UI so the owner trusts the machine.
  `reason`                   VARCHAR(255) NULL,
  `predicted_cycle_days`     INT NULL,
  `confidence`               DECIMAL(3,2) NULL,
  `message`                  VARCHAR(500) NULL,
  `sent_at`                  DATETIME NULL,
  `resulting_appointment_id` INT NULL,
  `created_at`               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_rem_send` (`shop_id`, `send_on`, `status`),
  KEY `idx_rem_cust` (`customer_id`, `status`),
  CONSTRAINT `fk_rem_shop`     FOREIGN KEY (`shop_id`)     REFERENCES `shops`(`id`)     ON DELETE CASCADE,
  CONSTRAINT `fk_rem_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_rem_appt`     FOREIGN KEY (`resulting_appointment_id`) REFERENCES `appointments`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Commercial plans
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS `plans`;
CREATE TABLE `plans` (
  `code`          VARCHAR(32) PRIMARY KEY,
  `name`          VARCHAR(80) NOT NULL,
  `setup_pence`   INT NOT NULL,
  `monthly_pence` INT NOT NULL,
  `max_chairs`    INT NULL,
  `blurb`         VARCHAR(255) NULL,
  `features_json` TEXT NOT NULL,
  `is_featured`   TINYINT(1) NOT NULL DEFAULT 0,
  `sort_order`    INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;

-- ============================================================================
-- Reporting views
--
-- Aggregation lives in SQL so each metric is defined in exactly one place.
-- SQLite's julianday()/strftime()/date(...,'-N day') are replaced with
-- DATEDIFF/HOUR/DATE_SUB, which behave identically for our purposes.
-- ============================================================================

DROP VIEW IF EXISTS `v_appointment_revenue`;
CREATE VIEW `v_appointment_revenue` AS
SELECT
  a.id, a.shop_id, a.customer_id, a.barber_id, a.service_id,
  a.starts_at, DATE(a.starts_at) AS `day`, a.status, a.source,
  a.service_pence, a.addons_pence, a.discount_pence, a.total_pence,
  CASE WHEN a.addons_pence > 0 THEN 1 ELSE 0 END AS has_addon
FROM appointments a
WHERE a.status = 'completed';

DROP VIEW IF EXISTS `v_barber_performance`;
CREATE VIEW `v_barber_performance` AS
SELECT
  b.id AS barber_id, b.shop_id, b.name, b.nickname, b.avatar_emoji,
  b.specialty, b.rating,
  COUNT(r.id)                                     AS cuts,
  COALESCE(SUM(r.total_pence), 0)                 AS revenue_pence,
  COALESCE(SUM(r.addons_pence), 0)                AS addon_revenue_pence,
  CAST(COALESCE(AVG(r.total_pence), 0) AS SIGNED) AS avg_ticket_pence,
  ROUND(100.0 * COALESCE(SUM(r.has_addon), 0) / NULLIF(COUNT(r.id), 0), 1) AS addon_attach_pct,
  COALESCE(FLOOR(SUM(r.total_pence) * b.commission_bps / 10000), 0) AS commission_pence
FROM barbers b
LEFT JOIN v_appointment_revenue r ON r.barber_id = b.id
GROUP BY b.id, b.shop_id, b.name, b.nickname, b.avatar_emoji, b.specialty,
         b.rating, b.commission_bps;

DROP VIEW IF EXISTS `v_customer_value`;
CREATE VIEW `v_customer_value` AS
SELECT
  c.id AS customer_id, c.shop_id, c.name, c.avatar_emoji, c.email, c.phone,
  c.created_at,
  COUNT(r.id)                                     AS visits,
  COALESCE(SUM(r.total_pence), 0)                 AS lifetime_pence,
  CAST(COALESCE(AVG(r.total_pence), 0) AS SIGNED) AS avg_ticket_pence,
  MAX(r.starts_at)                                AS last_visit_at,
  MIN(r.starts_at)                                AS first_visit_at,
  DATEDIFF(NOW(), MAX(r.starts_at))               AS days_since_visit,
  COALESCE(w.cash_pence, 0) + COALESCE(w.bonus_pence, 0) AS wallet_balance_pence,
  (SELECT COUNT(*) FROM referrals rf
     WHERE rf.referrer_id = c.id AND rf.status = 'rewarded') AS successful_referrals
FROM customers c
LEFT JOIN v_appointment_revenue r ON r.customer_id = c.id
LEFT JOIN wallet_accounts w       ON w.customer_id = c.id
GROUP BY c.id, c.shop_id, c.name, c.avatar_emoji, c.email, c.phone,
         c.created_at, w.cash_pence, w.bonus_pence;

DROP VIEW IF EXISTS `v_wallet_liability`;
CREATE VIEW `v_wallet_liability` AS
SELECT
  c.shop_id,
  COALESCE(SUM(w.cash_pence), 0)                 AS cash_liability_pence,
  COALESCE(SUM(w.bonus_pence), 0)                AS bonus_liability_pence,
  COALESCE(SUM(w.cash_pence + w.bonus_pence), 0) AS total_liability_pence,
  COALESCE(SUM(w.lifetime_topup_pence), 0)       AS lifetime_topup_pence,
  COALESCE(SUM(w.lifetime_bonus_pence), 0)       AS lifetime_bonus_pence
FROM wallet_accounts w
JOIN customers c ON c.id = w.customer_id
GROUP BY c.shop_id;

-- Note the subquery: putting `a.status='completed'` in a LEFT JOIN's ON clause
-- does NOT filter — unmatched rows survive and COUNT still counts them, so
-- add-ons sold on cancelled and no-show appointments would inflate both volume
-- and revenue. The filter has to happen before the outer join.
DROP VIEW IF EXISTS `v_addon_performance`;
CREATE VIEW `v_addon_performance` AS
SELECT
  ad.id AS addon_id, ad.shop_id, ad.name, ad.icon, ad.price_pence,
  COUNT(sold.id)                     AS times_sold,
  COALESCE(SUM(sold.price_pence), 0) AS revenue_pence
FROM addons ad
LEFT JOIN (
  SELECT aa.id, aa.addon_id, aa.price_pence
  FROM appointment_addons aa
  JOIN appointments a ON a.id = aa.appointment_id
  WHERE a.status = 'completed'
) AS sold ON sold.addon_id = ad.id
GROUP BY ad.id, ad.shop_id, ad.name, ad.icon, ad.price_pence;
