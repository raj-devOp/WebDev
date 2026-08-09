/**
 * SALES SCREEN
 *
 * Shown to the barbershop owner, not the customer. Its job is to answer the
 * three objections that kill these deals, in order:
 *
 *   1. "It's too expensive"    → the commission comparison. Fresha takes 20% of
 *                                new marketplace clients and Treatwell 5-8% of
 *                                everything. We take £0. On a £120k shop that
 *                                difference dwarfs the subscription.
 *   2. "I'm not technical"     → setup is done for them, 30-day trial, no card.
 *   3. "I need to think"       → the trial IS the answer to that, so it is a
 *                                first-class button rather than a footnote.
 *
 * The ROI figures are clearly labelled as a model with editable inputs. Passing
 * assumptions off as guarantees is how you win a deal and lose a client.
 */
import { api, state } from '../api.js';
import { el, clear, money, moneyShort, toast, modal, pct } from '../ui.js';

export async function render(host) {
  clear(host);

  const plans = state.plans;
  const shop = state.shop;

  // ------------------------------------------------------------------- hero
  const hero = el('div', { class: 'wallet-hero', style: { textAlign: 'center' } },
    el('span', { class: 'badge badge-brass' }, `💈 ${shop?.name || 'Your shop'} · 30-day free trial`),
    el('h1', {
      style: { fontSize: 'clamp(27px,5vw,44px)', margin: '14px auto 10px', maxWidth: '22ch' },
    }, 'Turn one-off haircuts into predictable monthly revenue'),
    el('p', {
      class: 'muted',
      style: { maxWidth: '58ch', margin: '0 auto', fontSize: '15.5px' },
    }, 'Prepaid wallets bring cash in before the cut. Learned rebook reminders bring '
      + 'customers back on their own rhythm. Add-on prompts lift every basket. '
      + 'And we never take a cut of your takings.'),
    el('div', { class: 'row wrap', style: { gap: '10px', justifyContent: 'center', marginTop: '20px' } },
      el('button', { class: 'btn btn-primary btn-lg', onclick: startTrial },
        'Start 30-day free trial'),
      el('button', { class: 'btn btn-ghost btn-lg', onclick: () => openRoi() },
        '📊 Calculate my return')),
    el('div', { class: 'tiny subtle', style: { marginTop: '11px' } },
      'No card required · Cancel any time in the first 30 days at no cost'),
  );

  // -------------------------------------------------- the commission argument
  // This is the single strongest commercial point, so it sits above pricing.
  const commissionCard = el('div', { class: 'card card-pad-lg', style: { borderColor: 'var(--brass-ring)' } },
    el('div', { class: 'card-head' },
      el('div', {},
        el('h3', {}, 'Why the sticker price is not the real cost'),
        el('div', { class: 'sub' },
          'Modelled on a shop turning over £120,000 a year. Competitor rates are their published 2026 pricing.'))),
    el('div', { class: 'stack-sm' },
      ...[
        { name: 'Fresha', sub: 'Free software, 20% commission on new marketplace clients',
          annual: 600000, note: 'assumes 25% of revenue from new marketplace clients' },
        { name: 'Treatwell', sub: '5–8% commission on bookings', annual: 780000,
          note: 'modelled at 6.5% of total revenue' },
        { name: 'Phorest', sub: '£100–400/mo subscription', annual: 300000, note: 'mid-tier estimate' },
        { name: 'Booksy / Squire', sub: '~£24/mo + ~£16 per extra chair', annual: 115200,
          note: '5 chairs' },
        { name: 'BarberIQ Professional', sub: '£119/mo flat · £0 commission, ever',
          annual: 142800, note: 'plus one-off setup', us: true },
      ].map((r) => el('div', {
        class: 'compare-row',
        style: r.us ? { background: 'var(--brass-soft)', borderRadius: '10px', padding: '11px 12px' } : {},
      },
        el('div', { style: { minWidth: 0, flex: '1 1 auto' } },
          el('div', { class: 'bold small' }, r.us ? `⭐ ${r.name}` : r.name),
          el('div', { class: 'tiny subtle' }, r.sub)),
        el('div', { class: 'col', style: { alignItems: 'flex-end', flex: '0 0 auto' } },
          el('div', { class: `mono bold ${r.us ? 'pos' : ''}` }, `${money(r.annual, { whole: true })}/yr`),
          el('div', { class: 'tiny subtle' }, r.note)),
      ))),
    el('div', {
      class: 'small', style: {
        marginTop: '14px', padding: '13px', borderRadius: '10px',
        background: 'var(--success-soft)', color: 'var(--success)',
      },
    }, '→ On a £120k shop, moving off commission-based booking saves roughly '
      + '£4,500–£6,400 a year. The subscription pays for itself before you count '
      + 'a single extra add-on.'),
    el('div', { class: 'tiny subtle', style: { marginTop: '9px' } },
      'Competitor figures are modelled from published list pricing in 2026 and will vary with '
      + 'your mix of new versus repeat clients. We are happy to run the numbers on your actual takings.'),
  );

  // ---------------------------------------------------------------- plan cards
  const planGrid = el('div', { class: 'price-grid' },
    ...plans.map((p) => el('div', { class: `price-card${p.is_featured ? ' featured' : ''}` },
      // !! because SQLite booleans arrive as 0/1 and `0 && node` renders "0".
      !!p.is_featured && el('span', { class: 'price-flag' }, 'Most shops choose this'),
      el('div', {},
        el('div', { class: 'up subtle' }, p.name),
        el('div', { class: 'row', style: { gap: '6px', alignItems: 'baseline', marginTop: '5px' } },
          el('span', { class: 'price-amount' }, money(p.monthly_pence, { whole: true })),
          el('span', { class: 'muted' }, '/month')),
        el('div', { class: 'small muted', style: { marginTop: '4px' } },
          `+ ${money(p.setup_pence, { whole: true })} one-off setup & data migration`),
        el('div', { class: 'small', style: { marginTop: '9px' } }, p.blurb),
        el('div', { class: 'badge', style: { marginTop: '9px' } },
          p.max_chairs ? `Up to ${p.max_chairs} chairs` : 'Unlimited chairs')),
      el('div', { class: 'divider' }),
      el('ul', { class: 'feature-list' },
        ...p.features.map((f) => el('li', {},
          el('span', { class: 'tick' }, '✓'), el('span', {}, f)))),
      el('div', { class: 'mt-auto', style: { paddingTop: '14px' } },
        el('button', {
          class: `btn btn-block ${p.is_featured ? 'btn-primary' : 'btn-outline'}`,
          onclick: () => startTrial(p.code),
        }, 'Start free trial'),
        el('button', {
          class: 'btn btn-ghost btn-block btn-sm',
          style: { marginTop: '7px' },
          onclick: () => openRoi(p),
        }, 'See the numbers')),
    )));

  // --------------------------------------------------------- objection handling
  const faq = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('div', {}, el('h3', {}, 'The questions every owner asks'))),
    el('div', { class: 'stack' },
      ...[
        ['“I want to think about it.”',
          'Then take the 30 days. No card, no contract, and we load your existing customer list '
          + 'for you so you are testing it on your own shop rather than a demo. If it has not paid '
          + 'for itself by day 30, walk away and owe nothing.'],
        ['“Is my data safe, and where does it live?”',
          'The intelligence runs on your own database — no customer records are sent to a third-party '
          + 'AI service. You can export everything as SQL or CSV at any time, and deletion requests '
          + 'are handled in-app for GDPR.'],
        ['“What if I already use Booksy or Fresha?”',
          'Run both for the trial month. Keep taking bookings where you do now, and use us for the '
          + 'wallet, reminders and add-ons. Compare the two at the end and decide with evidence.'],
        ['“Do I need to be technical?”',
          'No. Setup covers install, your services and prices, staff accounts and importing '
          + 'customers. You get a one-hour handover and your team learns it in an afternoon.'],
        ['“Giving customers £55 for £50 — am I not losing money?”',
          'You are buying three things with that £5: cash upfront, a customer who is now committed '
          + 'to returning, and a materially higher visit frequency. Breakage and the extra visits '
          + 'more than cover the bonus — and unlike a discount, you keep the full ticket price.'],
      ].map(([q, a]) => el('div', {},
        el('div', { class: 'bold small' }, q),
        el('div', { class: 'small muted', style: { marginTop: '3px' } }, a)))),
  );

  // ------------------------------------------------------------ trial banner
  const trialCard = el('div', { class: 'card card-pad-lg', style: { textAlign: 'center' } },
    el('div', { style: { fontSize: '30px' } }, '🎁'),
    el('h3', { style: { marginTop: '7px' } }, '30 days, free, no card'),
    el('p', { class: 'muted', style: { maxWidth: '48ch', margin: '7px auto 0' } },
      'We set it up with your real services, prices and customers. Use it for a month. '
      + 'If it works, we invoice for the setup and start the subscription. If it does not, '
      + 'we remove it and you owe nothing.'),
    shop?.trial_days_left != null && el('div', { class: 'badge badge-brass', style: { marginTop: '13px' } },
      `This demo account has ${shop.trial_days_left} days left on trial`),
    el('div', { class: 'row', style: { justifyContent: 'center', marginTop: '16px' } },
      el('button', { class: 'btn btn-primary btn-lg', onclick: startTrial }, 'Activate the trial')),
  );

  // ---------------------------------------------------------------- ROI model
  function openRoi(plan = plans.find((p) => p.is_featured) || plans[1]) {
    // Defaults reflect the seeded demo shop so the numbers feel grounded.
    const inputs = {
      chairs: 5, cutsPerChairPerDay: 8, daysOpen: 6,
      avgTicket: 27, currentAttach: 30, currentRebook: 45,
    };

    const out = el('div', { class: 'stack' });

    function calc() {
      const cutsPerWeek = inputs.chairs * inputs.cutsPerChairPerDay * inputs.daysOpen;
      const cutsPerYear = cutsPerWeek * 52;
      const baseRevenue = cutsPerYear * inputs.avgTicket;

      // Modelled uplifts. Conservative, and each one is stated separately so an
      // owner can argue with any single line rather than the whole number.
      const attachGain = Math.max(0, 52 - inputs.currentAttach) / 100;   // → ~52% attach
      const addonUplift = cutsPerYear * attachGain * 7.5;                 // avg add-on ~£7.50
      const rebookGain = Math.max(0, 60 - inputs.currentRebook) / 100;    // → ~60% rebook
      const extraVisits = cutsPerYear * rebookGain * 0.35;                // 35% of the gap converts
      const rebookUplift = extraVisits * inputs.avgTicket;
      const walletBonusCost = baseRevenue * 0.35 * 0.11;                  // 35% prepaid at ~11% bonus
      const commissionSaved = baseRevenue * 0.045;                        // vs a commission platform

      const annualCost = (plan.monthly_pence / 100) * 12;
      const setup = plan.setup_pence / 100;
      const gross = addonUplift + rebookUplift + commissionSaved;
      const net = gross - walletBonusCost - annualCost - setup;
      const roi = (annualCost + setup) > 0 ? (net / (annualCost + setup)) * 100 : 0;
      const payback = gross > 0 ? Math.max(0.1, (annualCost + setup) / (gross / 12)) : Infinity;

      clear(out);
      out.append(
        el('div', { class: 'grid g2', style: { gap: '11px' } },
          ...[
            ['Chairs', 'chairs', 1, 20],
            ['Cuts per chair per day', 'cutsPerChairPerDay', 1, 20],
            ['Days open per week', 'daysOpen', 1, 7],
            ['Average ticket (£)', 'avgTicket', 5, 100],
            ['Current add-on attach (%)', 'currentAttach', 0, 100],
            ['Current rebook rate (%)', 'currentRebook', 0, 100],
          ].map(([label, key, min, max]) => {
            const input = el('input', {
              class: 'input', type: 'number', value: inputs[key], min, max,
            });
            input.addEventListener('input', () => {
              const v = Number(input.value);
              if (Number.isFinite(v)) { inputs[key] = Math.max(min, Math.min(max, v)); calc(); }
            });
            return el('div', { class: 'field' }, el('label', {}, label), input);
          })),
        el('div', { class: 'divider' }),
        el('div', { class: 'stack-sm' },
          line('Your modelled turnover', `£${Math.round(baseRevenue).toLocaleString()}`, true),
          line('Extra add-on revenue', `+£${Math.round(addonUplift).toLocaleString()}`, false, 'pos'),
          line('Extra visits from reminders', `+£${Math.round(rebookUplift).toLocaleString()}`, false, 'pos'),
          line('Commission you stop paying', `+£${Math.round(commissionSaved).toLocaleString()}`, false, 'pos'),
          line('Cost of wallet bonuses', `−£${Math.round(walletBonusCost).toLocaleString()}`, false, 'neg'),
          line('BarberIQ year one (setup + subscription)',
            `−£${Math.round(annualCost + setup).toLocaleString()}`, false, 'neg'),
        ),
        el('div', {
          style: {
            marginTop: '14px', padding: '15px', borderRadius: '12px',
            background: net > 0 ? 'var(--success-soft)' : 'var(--danger-soft)',
          },
        },
          el('div', { class: 'row-between' },
            el('span', { class: 'bold' }, 'Net gain in year one'),
            el('span', {
              class: `mono bold ${net > 0 ? 'pos' : 'neg'}`, style: { fontSize: '21px' },
            }, `${net >= 0 ? '+' : '−'}£${Math.abs(Math.round(net)).toLocaleString()}`)),
          el('div', { class: 'row-between small', style: { marginTop: '5px' } },
            el('span', { class: 'muted' }, 'Return on investment'),
            el('span', { class: 'mono bold' }, `${Math.round(roi)}%`)),
          el('div', { class: 'row-between small' },
            el('span', { class: 'muted' }, 'Pays for itself in'),
            el('span', { class: 'mono bold' },
              Number.isFinite(payback) ? `${payback.toFixed(1)} months` : '—')),
        ),
        el('div', { class: 'tiny subtle', style: { marginTop: '11px' } },
          'This is a model, not a promise. It assumes add-on attach reaching ~52% and rebook '
          + 'rate reaching ~60% — both of which we measure for you during the trial, so by day 30 '
          + 'you can replace every assumption here with your own figures.'),
      );
    }

    function line(label, value, bold, cls = '') {
      return el('div', { class: 'row-between small' },
        el('span', { class: bold ? 'bold' : 'muted' }, label),
        el('span', { class: `mono ${bold ? 'bold' : ''} ${cls}` }, value));
    }

    calc();
    modal({ title: `Return on investment — ${plan.name}`, body: out, actions: [
      { label: 'Close', class: 'btn-ghost' },
      { label: 'Start free trial', class: 'btn-primary', onClick: () => startTrial(plan.code) },
    ] });
  }

  function startTrial(planCode) {
    const plan = plans.find((p) => p.code === planCode) || plans.find((p) => p.is_featured);
    modal({
      title: 'Start your 30-day trial',
      body: el('div', { class: 'stack' },
        el('div', { class: 'card', style: { background: 'var(--surface-2)' } },
          el('div', { class: 'row-between' },
            el('span', { class: 'bold' }, plan?.name || 'Professional'),
            el('span', { class: 'mono bold' }, `${money(plan?.monthly_pence || 11900)}/mo`)),
          el('div', { class: 'tiny subtle', style: { marginTop: '4px' } },
            'Billing starts on day 31. Nothing is charged before then.')),
        el('div', { class: 'stack-sm' },
          ...['We import your services, prices and staff',
            'We load your existing customer list',
            'One hour of handover training for the team',
            'Day 30: we show you the numbers and you decide',
          ].map((s, i) => el('div', { class: 'funnel-step' },
            el('div', { class: 'funnel-num' }, String(i + 1)),
            el('div', { class: 'small' }, s)))),
        el('div', { class: 'field' },
          el('label', {}, 'Shop name'),
          el('input', { class: 'input', value: shop?.name || '', placeholder: 'Your shop' })),
        el('div', { class: 'field' },
          el('label', {}, 'Contact email'),
          el('input', { class: 'input', type: 'email', placeholder: 'you@yourshop.co.uk' })),
      ),
      actions: [
        { label: 'Not yet', class: 'btn-ghost' },
        {
          label: 'Activate trial', class: 'btn-primary',
          onClick: () => toast('Trial activated — this is where your onboarding flow would fire.', 'success'),
        },
      ],
    });
  }

  host.append(el('div', { class: 'stack-lg' },
    hero,
    commissionCard,
    el('div', {},
      el('h3', { style: { marginBottom: '4px' } }, 'Straightforward pricing'),
      el('p', { class: 'small muted', style: { marginBottom: '16px' } },
        'One monthly fee. No commission on bookings, no charge per SMS tier, no surprise add-ons.'),
      planGrid),
    trialCard,
    faq,
  ));
}
