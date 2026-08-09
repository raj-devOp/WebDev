/**
 * Browser test: drives every screen with a real Chromium instance, asserts the
 * key numbers actually render, exercises the main interactions, and captures
 * screenshots at desktop and mobile widths.
 *
 * Run with the server up:  node test/ui-test.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = process.env.SHOT_DIR || path.join(__dirname, '..', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const log = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; log.push(`  ✓ ${name}`); }
  else { fail++; log.push(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const OWNER_PASS = process.env.OWNER_PASS || '';

/**
 * Wait until a page has settled: either the screen painted real content, or a
 * dialog is up. The owner-password gate renders a deliberately short empty
 * state, so a pure "lots of text" check would time out waiting for a login box.
 */
async function settle(pg, timeout = 15000) {
  await pg.waitForFunction(
    () => {
      if (document.querySelector('.modal')) return true;
      const v = document.querySelector('#view');
      return v && v.textContent.trim().length > 120;
    },
    undefined,
    { timeout },
  );
}

/** Sign in as owner if the password gate is showing. Returns true if it did. */
async function signInIfPrompted(pg) {
  if (!OWNER_PASS) return false;
  if (!(await pg.locator('.modal input[type=password]').count())) return false;
  await pg.locator('.modal input[type=password]').fill(OWNER_PASS);
  await pg.locator('.modal').getByRole('button', { name: 'Sign in', exact: true }).click();
  await pg.waitForTimeout(3200);
  return true;
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  const goto = async (hash) => {
    await page.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' });
    // Wait for the screen to actually paint content, not just for the shell.
    // waitForFunction(fn, arg, options) — options is the THIRD parameter, so
    // the arg slot must be passed explicitly or the timeout is ignored.
    await settle(page);
    await page.waitForTimeout(450); // let charts settle
  };

  console.log('\nBarberIQ UI test\n' + '─'.repeat(52));

  // ------------------------------------------------------------------ WALLET
  await goto('#/wallet');
  check('wallet screen renders', await page.locator('.wallet-balance').isVisible());
  const balText = await page.locator('.wallet-balance').textContent();
  check('wallet shows a £ balance', /£[\d,]+\.\d{2}/.test(balText), balText);
  const tiers = await page.locator('.tier').count();
  check('top-up tiers rendered', tiers >= 4, `got ${tiers}`);
  const tierText = await page.locator('.tier-grid').textContent();
  check('£50 → £55 tier visible on screen', /£50/.test(tierText) && /£55/.test(tierText), tierText.slice(0, 120));
  check('statement/ledger present', await page.locator('.ledger-item').count() > 0);
  await page.screenshot({ path: path.join(OUT, '01-wallet-dark.png'), fullPage: true });

  // Perform a real top-up through the UI and confirm the balance moves.
  const before = await page.locator('.wallet-balance').textContent();
  await page.locator('.tier').nth(2).click();
  await page.getByRole('button', { name: /^Top up wallet$/ }).click();
  await page.waitForTimeout(1400);
  const after = await page.locator('.wallet-balance').textContent();
  check('top-up through the UI changes the balance', before !== after, `${before} → ${after}`);
  check('a success toast appeared', await page.locator('.toast').count() > 0);

  // -------------------------------------------------------------------- BOOK
  await goto('#/book');
  check('booking screen renders', await page.locator('.pick').count() > 5);
  check('add-on list rendered', await page.locator('.addon').count() >= 8,
    `got ${await page.locator('.addon').count()}`);
  check('at least one add-on flagged as recommended',
    await page.locator('.addon.recommended').count() > 0);
  const addonText = await page.locator('.addon').first().textContent();
  check('add-ons show a price', /£\d/.test(addonText), addonText.slice(0, 80));
  check('recommendation reason shown on screen',
    /history|most visits|Popular|before|favourite|Pairs/i.test(
      await page.locator('.addon.recommended').first().textContent()));
  check('basket visible', await page.locator('.basket').isVisible());
  check('slot grid rendered', await page.locator('.slot-grid .slot').count() > 5);

  // Add an add-on and confirm the basket total updates.
  const totalBefore = await page.locator('.basket-total').textContent();
  await page.locator('.addon').first().click();
  await page.waitForTimeout(280);
  const totalAfter = await page.locator('.basket-total').textContent();
  check('selecting an add-on updates the basket total', totalBefore !== totalAfter,
    `${totalBefore} → ${totalAfter}`);
  check('add-on row shows as selected', await page.locator('.addon.selected').count() > 0);
  await page.screenshot({ path: path.join(OUT, '02-booking-addons.png'), fullPage: true });

  // Book a real appointment end-to-end.
  const freeSlot = page.locator('.slot-grid .slot:not(:disabled)').first();
  if (await freeSlot.count()) {
    await freeSlot.click();
    await page.waitForTimeout(320);
    const confirm = page.locator('[data-action="confirm-booking"]');
    const label = await confirm.textContent();
    check('confirm button shows the price', /£\d/.test(label), label);
    await confirm.click();
    await page.waitForTimeout(1800);
    const toastText = await page.locator('.toast').first().textContent().catch(() => '');
    check('booking completed through the UI', /Booked|booked/.test(toastText), toastText.slice(0, 110));
  } else {
    check('a bookable slot was available', false, 'no free slot found');
  }

  // --------------------------------------------------------------- REMINDERS
  await goto('#/reminders');
  check('reminder screen renders', await page.locator('.cycle-ring').isVisible());
  const cycleText = await page.locator('#view').textContent();
  check('predicted cycle in days is shown', /\d+\s*days/.test(cycleText));
  check('the prediction explains itself',
    /Learned from|typical cycle|visit history|irregular/i.test(cycleText));
  check('contact preference switches rendered', await page.locator('.switch').count() >= 3);
  check('visit history timeline present', await page.locator('.timeline-item').count() > 0
    || /No visits yet/.test(cycleText));
  await page.screenshot({ path: path.join(OUT, '03-reminders.png'), fullPage: true });

  // ---------------------------------------------------------------- REFERRAL
  await goto('#/referral');
  check('referral screen renders', await page.locator('.code-value').isVisible());
  const code = (await page.locator('.code-value').textContent()).trim();
  check('referral code looks valid', /^[A-Z0-9]{5,8}$/.test(code), code);
  const refText = await page.locator('#view').textContent();
  check('£10 / £10 offer stated', /£10/.test(refText));
  check('qualifying rule is spelled out',
    /first (completed |paid )?visit|had their first/i.test(refText));
  check('stat tiles rendered', await page.locator('.stat').count() >= 4);
  check('leaderboard rendered', await page.locator('.lb-row').count() > 0);
  await page.screenshot({ path: path.join(OUT, '04-referral.png'), fullPage: true });

  // --------------------------------------------------------------- DASHBOARD
  await goto('#/dashboard');

  // The PHP build protects the dashboard with an owner password. If the gate is
  // on, sign in — that way we exercise the real shipping configuration rather
  // than only the unprotected variant.
  if (await signInIfPrompted(page)) {
    check('owner login prompt appears on protected dashboard', true);
    check('owner login unlocks the dashboard', await page.locator('.stat').count() >= 4,
      `got ${await page.locator('.stat').count()} stat tiles`);
  }
  check('dashboard renders', await page.locator('.stat').count() >= 4);
  const dashText = await page.locator('#view').textContent();
  check("today's earnings tile present", /earnings|Revenue/i.test(dashText));
  check('a money figure is displayed', /£[\d,]+/.test(dashText));
  check('insights panel rendered', await page.locator('.insight').count() > 0,
    `got ${await page.locator('.insight').count()}`);
  check('revenue chart drawn', await page.locator('svg.chart').count() >= 2);
  check('barber performance table rendered', await page.locator('table.data').count() >= 2);

  const tableText = await page.locator('table.data').first().textContent();
  check('barber table shows commission', /Commission/i.test(
    await page.locator('table.data').first().locator('thead').textContent()));
  const rows = await page.locator('table.data').nth(1).locator('tbody tr').count();
  check('top-20 customers table has 20 rows', rows === 20, `got ${rows}`);
  check('win-back list present', /Win-back/i.test(dashText));
  check('wallet liability split shown', /liability|customer money/i.test(dashText));
  await page.screenshot({ path: path.join(OUT, '05-dashboard-dark.png'), fullPage: true });

  // Range switching must actually change the figures.
  const revBefore = await page.locator('.stat-value').first().textContent();
  await page.getByRole('button', { name: 'Last 30 days' }).click();
  await page.waitForTimeout(1500);
  const revAfter = await page.locator('.stat-value').first().textContent();
  check('switching date range changes revenue', revBefore !== revAfter, `${revBefore} → ${revAfter}`);

  // ----------------------------------------------------------------- PRICING
  await goto('#/pricing');
  check('pricing screen renders', await page.locator('.price-card').count() === 3,
    `got ${await page.locator('.price-card').count()}`);
  const priceText = await page.locator('#view').textContent();
  check('all three price points shown',
    /£59/.test(priceText) && /£119/.test(priceText) && /£249/.test(priceText));
  check('30-day free trial offered', /30[- ]day/i.test(priceText));
  check('commission comparison present', /commission/i.test(priceText));
  check('competitors named for context', /Fresha|Treatwell|Booksy/i.test(priceText));
  await page.screenshot({ path: path.join(OUT, '06-pricing.png'), fullPage: true });

  // ROI calculator
  await page.getByRole('button', { name: /Calculate my return/i }).click();
  await page.waitForTimeout(650);
  check('ROI modal opens', await page.locator('.modal').isVisible());
  const roiText = await page.locator('.modal').textContent();
  check('ROI shows a net figure', /Net gain/i.test(roiText));
  check('ROI shows payback period', /Pays for itself/i.test(roiText));
  check('ROI is labelled as a model, not a promise', /model, not a promise/i.test(roiText));
  await page.screenshot({ path: path.join(OUT, '07-roi-calculator.png') });
  await page.keyboard.press('Escape');

  // -------------------------------------------------------------- LIGHT MODE
  await goto('#/dashboard');
  await page.locator('.topbar-actions button').last().click();
  await page.waitForTimeout(700);
  const theme = await page.getAttribute('html', 'data-theme');
  check('theme toggles to light', theme === 'light', `got ${theme}`);
  await page.screenshot({ path: path.join(OUT, '08-dashboard-light.png'), fullPage: true });
  // back to dark
  await page.locator('.topbar-actions button').last().click();
  await page.waitForTimeout(400);

  // ---------------------------------------------------------- PERSONA SWITCH
  await goto('#/wallet');
  await page.locator('.persona').first().click();
  await page.waitForTimeout(550);
  check('persona picker opens', await page.locator('.modal').isVisible());
  const personaCount = await page.locator('.modal .persona').count();
  check('persona list populated', personaCount > 5, `got ${personaCount}`);
  await page.locator('.modal .persona').nth(2).click();
  await page.waitForTimeout(1300);
  check('switching persona re-renders the wallet',
    await page.locator('.wallet-balance').isVisible());

  // ------------------------------------------------------------- RESPONSIVE
  const mob = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  const mp = await mob.newPage();
  mp.on('pageerror', (e) => errors.push('mobile: ' + String(e)));

  for (const [hash, name] of [
    ['#/wallet', '09-mobile-wallet'],
    ['#/book', '10-mobile-booking'],
    ['#/dashboard', '11-mobile-dashboard'],
  ]) {
    await mp.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' });
    await settle(mp);
    // Fresh context, so no owner cookie — sign in if the gate is up, otherwise
    // the mobile dashboard screenshot is just a password box.
    await signInIfPrompted(mp);
    await mp.waitForTimeout(600);
    await mp.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  }

  check('mobile bottom nav visible', await mp.locator('.mobile-nav').isVisible());
  check('sidebar hidden on mobile', !(await mp.locator('.sidebar').isVisible()));

  // No horizontal overflow — the classic responsive failure.
  const overflow = await mp.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('no horizontal scroll on mobile', overflow <= 1, `overflow ${overflow}px`);

  // Tap targets big enough to use with a thumb.
  const smallTargets = await mp.evaluate(() => {
    const els = Array.from(document.querySelectorAll('.mobile-nav a, .btn'));
    return els.filter((e) => { const r = e.getBoundingClientRect(); return r.height > 0 && r.height < 32; }).length;
  });
  check('tap targets are at least 32px tall', smallTargets === 0, `${smallTargets} too small`);

  // Tablet width
  const tab = await browser.newContext({ viewport: { width: 834, height: 1112 } });
  const tp = await tab.newPage();
  await tp.goto(`${BASE}/#/dashboard`, { waitUntil: 'domcontentloaded' });
  await settle(tp);
  await signInIfPrompted(tp);
  await tp.waitForTimeout(600);
  await tp.screenshot({ path: path.join(OUT, '12-tablet-dashboard.png'), fullPage: true });
  const tabOverflow = await tp.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('no horizontal scroll on tablet', tabOverflow <= 1, `overflow ${tabOverflow}px`);

  // ------------------------------------------------------------ console clean
  // A 401 before sign-in is the owner-password gate working as designed, not a
  // fault — the browser logs every non-2xx response regardless.
  const real = errors.filter((e) =>
    !/favicon|fonts\.googleapis|fonts\.gstatic|ERR_NAME|net::/i.test(e)
    && !/401 \(Unauthorized\)/i.test(e));
  check('no JavaScript errors in console', real.length === 0, real.slice(0, 3).join(' | '));

  await browser.close();

  console.log(log.join('\n'));
  console.log('─'.repeat(52));
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log(`  screenshots → ${OUT}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nUI harness crashed:', e); process.exit(1); });
