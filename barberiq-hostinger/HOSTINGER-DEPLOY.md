# 🚀 Launch on Hostinger — step by step

For Hostinger **Premium / Business / Cloud** shared hosting (the hPanel one).
No Node.js, no terminal, no command line. Upload, click through an installer,
done in about 15 minutes.

> **Already have a Hostinger VPS?** You don't need this build. Use the Node
> version in `barberiq-v1.0.zip` instead — it is the same app with a faster
> backend, and Part 3 of its LAUNCH-GUIDE.md covers VPS deployment.

---

## What you're uploading

```
public_html/            ← everything in here goes to your Hostinger public_html
├── index.html          the app
├── css/  js/           interface
├── api/                PHP backend (the part that talks to MySQL)
├── install/            one-time setup wizard — DELETE after use
└── .htaccess           URL routing + security rules
```

---

## Step 1 — Create the database (3 minutes)

1. Log in to **hpanel.hostinger.com**
2. Pick your website → **Databases → Management**
3. Under *Create a New MySQL Database*, fill in:
   - **Database name:** `barberiq`
   - **Database username:** `barberiq`
   - **Password:** click *Generate* and **copy it somewhere safe now** — Hostinger
     will not show it again
4. Click **Create**

Hostinger prefixes both names with your account ID, so you end up with something
like `u123456789_barberiq`. **Write down all four values** — you need them in
Step 3:

| | Your value |
|---|---|
| Host | `localhost` |
| Database name | `u________barberiq` |
| Username | `u________barberiq` |
| Password | (the generated one) |

---

## Step 2 — Upload the files (5 minutes)

**Option A — File Manager (easiest)**

1. hPanel → **Files → File Manager**
2. Open the **`public_html`** folder
3. If there is a `default.php` or Hostinger placeholder `index.html` in there,
   delete it — otherwise it will show instead of your app
4. Click **Upload** (arrow icon, top right) and upload `barberiq-hostinger.zip`
5. Right-click the uploaded zip → **Extract**
6. Extract puts everything inside a `public_html` sub-folder. **Move the contents
   up one level** so the structure is:

   ```
   public_html/index.html        ✅ correct
   public_html/api/
   public_html/install/

   public_html/public_html/...   ❌ wrong — move things up
   ```

7. Delete the now-empty inner folder and the zip

**Option B — FTP**

Use FileZilla with the credentials from hPanel → **Files → FTP Accounts**.
Upload the *contents* of the `public_html` folder from the zip into the
`public_html` folder on the server.

### Check `.htaccess` made it

`.htaccess` starts with a dot, so File Manager may hide it. In File Manager,
click **Settings** (gear) → tick **Show hidden files**. If it is missing, the app
still works (it falls back automatically), but re-upload it if you can — it adds
the security rules.

---

## Step 3 — Run the installer (3 minutes)

Open in your browser:

```
https://yourdomain.com/install/
```

**Screen 1 — Server check.** Every row should be green. If PHP is below 8.0, go
to hPanel → **Advanced → PHP Configuration** and set it to 8.1 or newer.

**Screen 2 — Database details.** Enter the four values from Step 1.

Also set an **owner dashboard password** here. Do not skip it: without one,
anybody who finds the URL can read your takings, customer names and phone
numbers. Minimum 8 characters.

**Screen 3 — Install.** Click *Create tables & demo data*. It takes a few
seconds and generates a full year of realistic trading history — around 620
customers, 5,000 appointments and £130,000 of revenue, all dated relative to
today so "today's earnings" is always live.

---

## Step 4 — Delete the installer (30 seconds, do not skip)

The installer can **wipe your database**. Leaving it online is a real risk.

1. hPanel → **File Manager → public_html**
2. Delete the entire **`install`** folder

---

## Step 5 — Turn on HTTPS

hPanel → **Security → SSL**. Hostinger includes a free certificate. Install it
and enable **Force HTTPS**.

Customers enter names and phone numbers, so this is not optional. It also makes
the "copy referral link" button work — the browser clipboard API is blocked on
plain HTTP.

---

## You're live

| Screen | URL |
|---|---|
| Customer app | `https://yourdomain.com/` |
| Owner dashboard | `https://yourdomain.com/#/dashboard` |
| Pricing / sales | `https://yourdomain.com/#/pricing` |

Bookmark the dashboard on your phone — that's the one you demo from.

---

## Step 6 — Automatic reminders (optional, 2 minutes)

The reminder schedule needs rebuilding nightly as visit history changes.

hPanel → **Advanced → Cron Jobs** → *Create New Cron Job*:

- **Type:** Custom
- **Command:**
  ```
  curl -s -X POST https://yourdomain.com/api/reminders/rebuild
  ```
- **Schedule:** Once a day, 03:00

Without this the app still works — reminders are generated at install and
whenever you press *Reset demo data* — they just won't refresh on their own.

> Reminders are **scheduled but not actually sent**. See "Before a real shop
> uses this" below.

---

## Troubleshooting

| What you see | Fix |
|---|---|
| Hostinger's default page | A placeholder `index.html`/`default.php` is still in `public_html`. Delete it. |
| "Not installed yet" | Open `/install/`. If you already deleted it, re-upload just that folder, run it, delete again. |
| "Cannot connect to the database" | The four values are wrong. Host is `localhost`, and the names include the `u123456789_` prefix. Reset the password in hPanel if unsure. |
| Blank white page | hPanel → Advanced → PHP Configuration → set PHP 8.1+. Then hard-refresh with `Ctrl+Shift+R`. |
| Everything loads but no data | Installer did not finish. Re-run `/install/`. |
| Dashboard asks for a password | Correct — that's the password you set in Step 3. Forgot it? See below. |
| Styling missing / raw text | The `css` and `js` folders did not upload, or are nested one level too deep. |
| 404 on every API call | `.htaccess` is missing. The app auto-falls-back, so hard-refresh once; re-upload `.htaccess` when you can. |

### Reset a forgotten owner password

Edit `api/config.php` in File Manager and set:

```php
'owner_password_hash' => '',
```

That disables the password. Re-run `/install/` (or generate a new hash) to set a
new one, and don't leave it blank on a live site.

---

## Keeping backups

hPanel → **Files → Backups** covers files and database, but check it is enabled
for your plan. Before any change, take a manual database export:

hPanel → **Databases → phpMyAdmin** → select your database → **Export → Go**.
That `.sql` file is your safety net, and it is also what you hand a client who
asks "is my data locked in?".

---

## Before a real shop uses this

The app is fully functional as a demo, but four things are deliberately
simulated. Be straight with clients — a trial is the right time to fit them.

**1. Payments are not connected.** Top-ups update the ledger without charging a
card. Nothing takes real money. Add Stripe, and credit the wallet from the
webhook only — never from the browser callback, or a customer can credit
themselves by replaying the request.

**2. Customers have no login.** The owner dashboard is password-protected, but
the customer screens are not, and the persona switcher lets anyone view any
customer's wallet. Before a real shop goes live, edit `api/config.php`:

```php
'demo_mode' => false,
```

That removes the persona switcher and stops the API returning the customer
roster. You still need proper customer accounts before taking real money.

**3. Reminders are scheduled, not sent.** No SMS or email leaves the server.
Add a provider (Twilio, or GOV.UK Notify for the cheapest UK SMS). Budget
2–4p per message: a 600-customer shop is roughly £15–25/month.

**4. GDPR.** You are holding names, phone numbers, emails and visit history. You
need a privacy policy, a lawful basis for marketing messages, and an
export/delete route. The `notify_sms` / `notify_email` / `notify_push` columns
already model consent — get it explicitly at sign-up.

Also: **"BarberIQ" is a placeholder name.** Check it against the
[UK IPO trade mark search](https://www.gov.uk/search-for-trademark) before you
print anything.

---

## Updating later

Upload the changed files over the old ones via File Manager. Two rules:

- **Never overwrite `api/config.php`** — it holds your database password.
- **Never re-upload `install/`** unless you intend to wipe and rebuild.

Then hard-refresh (`Ctrl+Shift+R`) so the browser picks up new CSS and JS.
