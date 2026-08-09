# 💈 BarberIQ — Intelligent Barbershop OS

A complete, working barbershop application built to be demonstrated to shop
owners and sold on a monthly subscription.

Five screens, all functional against a real SQL database:

| Screen | What it does |
| --- | --- |
| **Wallet** | Prepaid balance with bonus tiers — pay £50, spend £55. Cash and bonus tracked separately. |
| **Book & add-ons** | Booking flow where add-ons are ranked by what *this* customer is likely to want. |
| **Reminders** | Learns each customer's own haircut cycle and nudges before they are due. |
| **Refer a friend** | £10 each way, paid only after the invited friend actually gets a cut. |
| **Owner dashboard** | Today's earnings, barber league table, top 20 customers, win-back list, AI insights. |
| **Plans & pricing** | The sales screen: pricing, competitor comparison, ROI calculator, 30-day trial. |

---

## Quick start

You need [Node.js](https://nodejs.org) 18 or newer. Nothing else — no database
server, no build step.

```bash
npm install
npm start
```

Then open **http://localhost:3000**

That's it. The database is created and filled with a year of realistic demo
trading data on first run (about one second).

### Useful commands

```bash
npm start            # run the app
npm run dev          # run with auto-restart while editing
npm run reseed       # rebuild demo data (do this before a client meeting)
npm test             # 101 API tests
npm run test:ui      # 59 browser tests + screenshots (needs: npm i -D playwright)
npm run backup       # safe backup of the live database
npm run export:sql   # export everything as portable SQL
```

---

## What makes it "intelligent"

Worth being precise, because you will be asked in a meeting.

This is **statistical modelling over the shop's own data**, not a large language
model. That is a deliberate choice:

- **It explains itself.** Every prediction carries a reason string, so the owner
  sees *why* a customer is flagged. "Trust me, the AI said so" loses deals.
- **No data leaves the building.** No third-party AI service, no API key, no
  per-call cost. That is also the honest answer to the GDPR question.
- **It runs in milliseconds** and gets sharper as the shop's own history grows.

The four models:

1. **Rebook cycle prediction** — measures the gap between each customer's visits,
   weights recent gaps more heavily (exponential decay, ~4-visit half-life),
   blends weighted mean with median for robustness, and reports a confidence
   score derived from the coefficient of variation. A fixed "remind after 30
   days" is why most reminder features get ignored: a skin fade needs 2–3 weeks,
   a restyle needs 6.
2. **Churn risk** — bands customers on how far past *their own* cycle they have
   drifted, not a global "90 days = lapsed" rule.
3. **Add-on affinity** — market-basket scoring blending the customer's personal
   attach rate (50%), affinity with the chosen service (28%), and shop-wide
   popularity (22%), plus a discovery bonus for popular things they have not
   tried.
4. **No-show risk** — Laplace-smoothed rate over booking history, used to decide
   who should be asked to prepay.

See `server/intelligence.js`.

---

## Architecture

```
barberiq/
├── server/
│   ├── index.js          Express entry point
│   ├── db.js             SQLite connection, migration, seeding
│   ├── schema.sql         Tables, indexes, reporting views  ← the SQL
│   ├── seed.js            Generates a year of realistic trading data
│   ├── intelligence.js    Prediction models
│   └── routes.js           REST API
├── public/                 Front end (no build step)
│   ├── index.html
│   ├── css/app.css
│   └── js/
│       ├── app.js          Router + shell
│       ├── api.js          API client + app state
│       ├── ui.js           Formatting, DOM helpers, hand-rolled SVG charts
│       └── screens/        One module per screen
├── scripts/                reseed, backup, export-sql
├── test/
│   ├── api-test.js         101 assertions
│   └── ui-test.js          59 browser assertions + screenshots
└── data/barberiq.db        Created on first run
```

**Deliberate technology choices:**

- **SQLite via `better-sqlite3`** — real SQL in a single file, installs from a
  prebuilt binary (no compiler needed), and the shop's data is a file they can
  copy. The schema ports to Postgres with minimal change when a group outgrows it.
- **No frontend framework, no build step** — `npm install && npm start` is the
  whole setup. There is no bundler to break at a client site on bad wi-fi, and
  the charts are hand-rolled SVG rather than a 300 kB charting library.
- **Money is stored in pence as integers.** Never floats.
- **Fonts load from Google Fonts but degrade to a system stack**, so the app
  still looks right with no connection.

---

## Data model notes

Two design decisions in `schema.sql` are worth understanding because they are
commercially load-bearing:

**Wallet cash and bonus are separate columns.** `wallet_accounts.cash_pence` is
money the customer actually paid — a refundable liability. `bonus_pence` is
promotional credit — a marketing cost already incurred. Blending them makes the
balance sheet a guess. Bonus is always spent first, which retires promotional
liability before touching refundable cash.

**Referrals only pay out on a completed appointment.** The `referrals.status`
flow is `sent → signed_up → rewarded`, and the jump to `rewarded` happens in
`POST /api/bookings/:id/complete`, never on sign-up. Without that rule a shop
can be drained by fake accounts. It is the single most important control in the
whole feature, and the test suite asserts it explicitly.

### Reporting views

Aggregation lives in SQL so the numbers are defined in exactly one place:
`v_appointment_revenue`, `v_barber_performance`, `v_customer_value`,
`v_wallet_liability`, `v_addon_performance`.

---

## Demo controls

Built in for presenting:

- **Persona switcher** (sidebar, or press `P`) — view the customer screens as any
  of the 600+ seeded customers. Switch to a loyal regular to show a tight rebook
  cycle, then a lapsed one to show the win-back.
- **Keyboard shortcuts** `1`–`6` jump between screens.
- **Reset demo data** (sidebar) — clean slate mid-meeting.
- **Simulate referral sign-up** — on the referral screen, walk an invite through
  to payout so the client watches both £10 credits land.
- **Light/dark toggle** — some owners will ask.

Demo data is generated from a fixed random seed, so the figures are identical
every time you launch. You can rehearse against them.

---

## Deploying for a real client

See **LAUNCH-GUIDE.md** for step-by-step instructions, including running it on a
shop's own machine, hosting it, HTTPS, backups, and what to change before going
live (there is a short list — real payments, SMS sending and authentication are
stubbed for the demo, and the guide is explicit about it).

Commercial material — pricing, the competitor analysis behind it, trial terms,
demo script and objection handling — is in **COMMERCIAL-PACK.md**.

---

## Test status

Both suites pass against the current build:

```
API   101 passed, 0 failed
UI     59 passed, 0 failed
```

The API suite covers the money paths specifically: a top-up credits pay + bonus
and nothing else, a wallet booking debits exactly the basket total, bonus is
consumed before cash, a cancellation refunds the exact split that was taken,
double-booking a barber is refused by a database constraint, and a referral pays
out only after completion.
