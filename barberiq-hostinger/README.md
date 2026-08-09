# 💈 BarberIQ — Hostinger edition (PHP + MySQL)

The same barbershop application, rebuilt to run on Hostinger shared hosting.
Upload, run a wizard, done — no Node.js, no terminal, no build step.

**Start here: [HOSTINGER-DEPLOY.md](HOSTINGER-DEPLOY.md)**

---

## Why this build exists

Hostinger's Premium / Business / Cloud plans run PHP and MySQL. They cannot run
Node.js, so the original Express backend would not start there. This is a full
port of the backend to PHP with the identical REST API, so the frontend is
byte-for-byte the same code.

| | Node edition | **Hostinger edition** |
|---|---|---|
| Backend | Express | PHP 8 |
| Database | SQLite file | MySQL / MariaDB |
| Runs on | VPS, local, Render | **Hostinger shared hosting**, VPS, any PHP host |
| Setup | `npm install && npm start` | Upload + `/install/` wizard |
| Frontend | identical | identical |
| Owner login | none (localhost only) | password-protected |

Both are verified against the same test suites — 101 API assertions and 59
browser assertions, all passing on each.

---

## The five screens

| Screen | What it does |
|---|---|
| **Wallet** | Prepaid balance with bonus tiers — pay £50, spend £55. Cash and bonus tracked separately. |
| **Book & add-ons** | Add-ons ranked by what *this* customer is likely to want, each with its reason shown. |
| **Reminders** | Learns each customer's own haircut cycle instead of a fixed 30 days. |
| **Refer a friend** | £10 each way, paid only after the invited friend actually gets a cut. |
| **Owner dashboard** | Today's earnings, barber league table, top 20 customers, win-back list, ranked insights. |
| **Plans & pricing** | The sales screen: competitor comparison, live ROI calculator, 30-day trial. |

---

## Layout

```
public_html/
├── index.html
├── css/app.css
├── js/
│   ├── app.js            router + shell
│   ├── api.js            API client, transport fallback, owner login
│   ├── ui.js             formatting, DOM helpers, hand-rolled SVG charts
│   └── screens/          one module per screen
├── api/
│   ├── index.php         front controller / router
│   ├── config.php        written by the installer (DB password lives here)
│   ├── lib/
│   │   ├── db.php        PDO connection + transaction helper
│   │   ├── helpers.php   JSON output, validation, money
│   │   ├── auth.php      owner password gate
│   │   ├── intelligence.php  the prediction models
│   │   └── seed.php      demo data generator
│   └── routes/           wallet, booking, reminders, referral, dashboard, admin
├── install/
│   ├── index.php         setup wizard — DELETE after use
│   └── schema.sql        MySQL DDL, importable via phpMyAdmin
└── .htaccess             routing + security headers
```

---

## Notes on the port

Things that needed real thought rather than a find-and-replace:

**No partial indexes in MySQL.** SQLite stopped double-booking with a filtered
unique index. MySQL has no equivalent, so `appointments` carries a STORED
generated column that is `NULL` unless the appointment is live. MySQL allows
unlimited `NULL`s in a unique index, so cancelled slots free up automatically
while active ones stay locked. Verified: a duplicate is rejected, and the slot
becomes bookable again after a cancellation.

**Date functions.** `julianday()`, `strftime()` and `date(...,'-N day')` became
`DATEDIFF`, `HOUR()`, `DATE_FORMAT` and `DATE_SUB`. The session runs at UTC
(`SET time_zone = '+00:00'`) so stored datetimes and `NOW()` always agree.

**Emulated prepares are off.** With PDO's default emulation MySQL returns every
column as a string, which silently turns integer pence into `"2200"` and breaks
arithmetic in the models.

**Seeding runs in one transaction.** In autocommit each of ~15,000 inserts is a
durable write — around 60 seconds, and shared hosting usually kills a request at
30. Batched, it is about 2 seconds.

**Output buffering guards the JSON.** Shared hosting often has `display_errors`
on, and a single PHP notice printed before the body makes a response
unparseable — the symptom is "failed to load" with a perfectly healthy server.
`biq_json()` discards stray output and logs it instead.

**Transport fallback.** Pretty URLs (`/api/wallet/12`) need `mod_rewrite`. If it
is missing, `js/api.js` detects the failure once and switches to
`/api/index.php?route=...` for the session. Nobody has to edit a config file to
make the app work.

---

## What is intelligent about it

Statistical modelling over the shop's own data — not a large language model, and
no API key or external service. Worth being precise about, because you will be
asked:

1. **Rebook cycle prediction** — measures each customer's visit gaps, weights
   recent ones more heavily (exponential decay, ~4-visit half-life), blends
   weighted mean with median for robustness, and reports a confidence score from
   the coefficient of variation.
2. **Churn risk** — bands customers on how far past *their own* cycle they have
   drifted, not a global "90 days = lapsed" rule.
3. **Add-on affinity** — market-basket scoring: personal attach rate (50%),
   affinity with the chosen service (28%), shop-wide popularity (22%), plus a
   discovery bonus for popular things they have not tried.
4. **No-show risk** — Laplace-smoothed rate over booking history.

Every prediction carries a reason string, so the owner can see *why* someone is
flagged. See `api/lib/intelligence.php`.

---

## Commercial material

Pricing, the 2026 competitor research behind it, trial terms, unit economics, the
demo script and objection handling are all in **COMMERCIAL-PACK.md**.

Headline: **£119/month + £1,499 setup** for the Professional plan, with **zero
commission** as the selling point — Fresha takes 20% of new marketplace clients
and Treatwell 5–8% of everything, which on a £120k shop is £5,400–£9,750 a year.

---

## Local development (optional)

If you want to change things before uploading, and you have PHP and MySQL:

```bash
# point api/config.php at your local database, then:
php -S localhost:8080 -t public_html router.php
```

`router.php` emulates the `.htaccess` rewrite so URLs behave as they will on
Hostinger. It is not needed on the server — Apache handles that.
