# 🚀 Launch Guide

Step by step, from the zip file to a client demo, to a live shop.

There are four parts. Do **Part 1** and **Part 2** before your first meeting.
Part 3 is for putting it online. Part 4 is the honest list of what must be
finished before a shop takes real money through it.

---

## Part 1 — Get it running on your machine (10 minutes)

### Step 1. Install Node.js

Node is the engine the app runs on. You only do this once.

- Go to **https://nodejs.org**
- Download the **LTS** version (the left-hand button)
- Run the installer and accept the defaults

Check it worked. Open a terminal:

- **Windows** — press `Win`, type `powershell`, press Enter
- **Mac** — press `Cmd+Space`, type `terminal`, press Enter

Type this and press Enter:

```bash
node --version
```

You should see something like `v22.14.0`. Any number 18 or higher is fine. If you
get "command not found", restart the terminal — the installer needs a fresh one.

### Step 2. Unzip the project

Unzip `barberiq.zip` somewhere you can find again:

- **Windows** — `C:\Users\YourName\barberiq`
- **Mac** — `/Users/YourName/barberiq`

### Step 3. Move into the folder

In the terminal, type `cd `, then drag the unzipped folder onto the terminal
window (this pastes the path for you), then press Enter:

```bash
cd /Users/YourName/barberiq
```

Confirm you are in the right place:

```bash
ls          # Mac/Linux
dir         # Windows
```

You should see `package.json`, `server`, `public`.

### Step 4. Install and run

```bash
npm install
npm start
```

`npm install` takes about 30 seconds the first time and prints a few warnings —
that is normal. Then you will see:

```
┌──────────────────────────────────────────────────────────┐
  💈  BarberIQ — Intelligent Barbershop OS
└──────────────────────────────────────────────────────────┘
  Database : /Users/YourName/barberiq/data/barberiq.db
  Seeded   : yes (fresh demo data generated)
  Ready    : http://localhost:3000
```

### Step 5. Open it

Go to **http://localhost:3000** in your browser.

You should land on the Wallet screen with a balance already on it.

**To stop the app**, press `Ctrl+C` in the terminal. To start it again,
`npm start`. The data persists between restarts.

### If something goes wrong

| Problem | Fix |
| --- | --- |
| `command not found: npm` | Node did not install, or the terminal is stale. Reinstall Node, open a new terminal. |
| `EADDRINUSE` / port 3000 in use | Something else is on that port. Run `PORT=4000 npm start` (Windows PowerShell: `$env:PORT=4000; npm start`) and use http://localhost:4000 |
| Blank page | Check the terminal for a red error. Hard-refresh with `Ctrl+Shift+R` / `Cmd+Shift+R`. |
| Numbers look wrong / you broke the data mid-demo | `npm run reseed` |
| `better-sqlite3` install error | You are on an unusual platform. Run `npm install --build-from-source better-sqlite3` (needs Xcode Command Line Tools on Mac, Build Tools on Windows). |

---

## Part 2 — Run a demo that lands

### Before the meeting

```bash
npm run reseed     # fresh, known figures
npm start
```

Open these three tabs in advance so you are not typing during the meeting:

1. `http://localhost:3000/#/dashboard` — the owner console
2. `http://localhost:3000/#/wallet` — the customer app
3. `http://localhost:3000/#/pricing` — the pitch

Turn your phone's hotspot on as a backup. The app works offline, but you want
the fonts to load.

### The 12-minute demo script

Lead with **their money**, not your features.

**Minutes 0–3 · The dashboard (start here)**

Open `#/dashboard`. Do not explain the product yet. Just say:

> "This is what your Monday morning looks like. Today's takings, live. Your five
> barbers ranked. And here —" *(point at the insights panel)* "— the app has
> already worked out what needs your attention today."

Read one insight out loud. The Sofia/Aisha add-on gap one is the strongest:

> "It has spotted that one barber attaches add-ons at 27% and another at 67%.
> That's a 40-point gap on 550 haircuts. That is not a skill problem, it is a
> script problem — and you did not have to go looking for it."

Then scroll to **Top 20 customers** and the **win-back list**:

> "These twelve regulars have gone past their own usual gap. The app knows each
> person's rhythm, not an average. That column is what one recovered visit each
> is worth."

**Minutes 3–6 · The wallet (the cash-flow argument)**

Switch to `#/wallet`.

> "Your customer puts in £50 and gets £55 to spend. You are wondering why you'd
> give away a fiver."

Then answer it before they ask:

> "Three reasons. You have the cash today instead of in six weeks. They are now
> committed to coming back to you rather than the shop across the road. And they
> visit more often — prepaid customers always do. Unlike a 10% discount, you
> still charge full price for every cut."

Click a tier, press **Top up wallet**, and let them watch the balance move.

**Minutes 6–8 · Booking and add-ons (the basket argument)**

Switch to `#/book`. Pick a service, then point at the add-on list:

> "This is not an alphabetical menu. It is ordered by what *this* customer
> usually buys. See the label — 'you add this most visits'. That is the
> difference between a list people skim and a list people tap."

Add one, and show the total change.

**Minutes 8–9 · Reminders**

Switch to `#/reminders`.

> "Most systems text everyone after 30 days. This one measured *this* customer:
> 22 days, give or take three. It nudges two days before they are due, while
> your diary still has good slots."

**Minutes 9–10 · Referral**

Switch to `#/referral`. Point out the qualifying rule:

> "£10 each way — but yours only lands after your friend has actually sat in the
> chair. That's what stops people inventing accounts to farm credit."

**Minutes 10–12 · Price it**

Switch to `#/pricing`. Go to the commission comparison first, not the price:

> "Fresha is free but takes 20% of every new client the marketplace sends you.
> Treatwell takes 5–8% of everything. On a shop your size that is five to nine
> thousand a year. We charge £119 a month and take nothing on your bookings."

Then open the **ROI calculator**, and put *their* numbers in — chairs, cuts per
day, average ticket. Let the tool make the argument.

### Closing

If they hesitate, do not discount. Offer the trial:

> "Take 30 days. No card, no contract. We will load your real services, prices
> and customer list so you are testing it on your own shop. On day 30 I will show
> you what it earned you. If it has not paid for itself, we take it out and you
> owe nothing."

### Handling "how do I know the numbers are real?"

Show them. This is a genuine strength:

```bash
npm run export:sql
```

> "That is your entire database as a plain SQL file. Open it in anything. You are
> never locked in, and nothing about your customers goes to a third party."

---

## Part 3 — Putting it online

For a trial you can genuinely run it on a laptop or a cheap mini PC in the shop.
For anything permanent, host it.

### Option A — On the shop's own computer (simplest, good for a trial)

Run `npm start` on a machine that stays on. Other devices on the same wi-fi reach
it at `http://<that-computer's-IP>:3000`.

Find the IP: `ipconfig` (Windows) or `ifconfig | grep inet` (Mac).

Keep it running after you close the terminal:

```bash
npm install -g pm2
pm2 start server/index.js --name barberiq
pm2 save
pm2 startup        # follow the line it prints, so it survives a reboot
```

**Set up backups on day one.** Add a daily scheduled task running
`npm run backup`. It keeps the last 14 and uses SQLite's proper backup API — do
not just copy the `.db` file while the app is running, that can corrupt the copy.

### Option B — A cloud server (£5/month, recommended for a paying client)

Any small VPS (Hetzner, DigitalOcean, Linode) works. On a fresh Ubuntu box:

```bash
# 1. Install Node
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs nginx

# 2. Upload the project, then
cd /var/www/barberiq
npm install --omit=dev
npm install -g pm2
pm2 start server/index.js --name barberiq
pm2 save && pm2 startup

# 3. Put nginx in front of it
sudo tee /etc/nginx/sites-available/barberiq >/dev/null <<'CONF'
server {
  listen 80;
  server_name booking.theirshop.co.uk;
  client_max_body_size 2m;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
CONF
sudo ln -s /etc/nginx/sites-available/barberiq /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 4. Free HTTPS — do not skip this, customers will enter personal details
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d booking.theirshop.co.uk
```

Point the client's DNS `A` record at the server's IP first, or certbot will fail.

Daily backup via cron:

```bash
crontab -e
# add:
0 3 * * * cd /var/www/barberiq && /usr/bin/npm run backup >> /var/log/barberiq-backup.log 2>&1
```

### Option C — A managed platform

Render, Railway and Fly.io will run this from a Git repository with almost no
setup. **One catch:** most give you an ephemeral filesystem, which means the
SQLite file is wiped on redeploy. Attach a persistent volume and point the app at
it:

```bash
DB_PATH=/data/barberiq.db
```

If you cannot attach a volume, move to Postgres (see Part 4).

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `DB_PATH` | `./data/barberiq.db` | Where the database lives |

---

## Part 4 — Before a shop takes real money (read this)

The demo is fully functional, but four things are deliberately simulated. Be
straight with clients about this — a trial is the right time to fit them.

### 1. Payments are not connected

Top-ups update the ledger without charging a card. **Nothing takes real money
yet.**

To fix: add Stripe. Create a PaymentIntent in `POST /api/wallet/:id/topup`, and
only write the wallet transaction from the `payment_intent.succeeded` webhook —
never from the browser's success callback, or a customer can credit themselves by
replaying the request.

Stripe's UK fee is 1.5% + 20p, which you should factor into the bonus rates
before quoting: the £50 → £55 tier costs you £5 in bonus plus ~£0.95 in fees.

### 2. There is no login

Anyone reaching the URL can view any screen, including the owner dashboard, and
the persona switcher lets you become any customer. **That is a demo feature and a
production hole.**

To fix: add sessions with two roles (customer, owner), require the owner role on
every `/api/dashboard/*` and `/api/admin/*` route, and scope customer routes to
the signed-in user. Delete the persona switcher and `POST /api/admin/reseed`
before going live.

### 3. Reminders are scheduled but not sent

Rows are created and the pipeline works end to end in the UI, but no SMS or email
actually leaves the building. Marking one "sent" is a simulation.

To fix: pick a provider (Twilio, MessageBird, or GOV.UK Notify for the cheapest
UK SMS) and add a scheduled job that queries reminders due today and sends them.
`POST /api/reminders/rebuild` is what a nightly cron should call.

Budget for it: UK SMS is roughly 2–4p. A 600-customer shop sending one nudge per
customer per month is about £15–25/month — which is why SMS is bundled into the
Professional plan at a capped 1,000 messages.

### 4. SQLite has a ceiling

It is genuinely fine for a single shop — comfortably handles hundreds of
thousands of appointments. It is the wrong choice for a multi-site group with
simultaneous writes from several locations.

To migrate: `npm run export:sql`, adjust the DDL for Postgres (`AUTOINCREMENT` →
`GENERATED BY DEFAULT AS IDENTITY`, review the partial index on `appointments`),
and swap `better-sqlite3` for `pg`. The queries are standard SQL and mostly port
unchanged.

### Also worth doing before live

- **GDPR**: add an export-my-data and delete-my-account route. You hold names,
  phone numbers, emails and visit history. A shop taking UK customer data needs a
  privacy policy and a lawful basis for marketing messages — get explicit consent
  for reminders at sign-up. The `notify_*` columns already model consent.
- **Rate limiting**: put `express-rate-limit` on the top-up and invite routes.
- **Change the brand**: "BarberIQ" is a placeholder. Check the name is free with
  the [UK IPO trade mark search](https://www.gov.uk/search-for-trademark) and
  Companies House before you print anything.
- **Wallet terms**: prepaid balances are a liability and in some cases regulated
  as stored value. Get an accountant's view on how to treat the cash, and write
  terms covering refunds and dormant balances.

---

## Everyday commands

```bash
npm start                  # run it
npm run reseed             # fresh demo data
npm test                   # 101 API tests — run after any change
npm run test:ui            # browser tests + screenshots
npm run backup             # safe database backup
npm run export:sql         # portable SQL export
pm2 logs barberiq          # see what the server is doing
pm2 restart barberiq       # restart after a change
```
