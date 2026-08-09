/**
 * A. WALLET
 *
 * The commercial job of this screen is to make topping up feel like the
 * obviously smart choice. So the bonus is never buried in small print — the
 * "pay £50, get £55" arithmetic is the largest thing on each tier, and the
 * running total of bonus already earned sits at the top.
 */
import { api, state } from '../api.js';
import {
  el, clear, money, moneyShort, toast, modal, skeletonLines,
  fmtDateTime, empty, relDays,
} from '../ui.js';

const KIND_META = {
  topup:            { icon: '＋', label: 'Top-up' },
  bonus:            { icon: '🎁', label: 'Bonus credit' },
  spend:            { icon: '✂️', label: 'Spent' },
  refund:           { icon: '↩︎', label: 'Refund' },
  referral_credit:  { icon: '🤝', label: 'Referral reward' },
  adjustment:       { icon: '⚙︎', label: 'Adjustment' },
  expiry:           { icon: '⌛', label: 'Expired' },
};

export async function render(host) {
  clear(host);
  host.append(el('div', { class: 'stack' }, skeletonLines(6)));

  let data;
  try {
    data = await api.wallet(state.customerId);
  } catch (e) {
    // An auth error is not a load failure — let app.js show the
    // owner login prompt rather than a dead end here.
    if (e?.authRequired) throw e;
    clear(host);
    host.append(empty('⚠️', 'Could not load the wallet', e.message));
    return;
  }

  const { wallet, tiers, transactions, insight } = data;
  clear(host);

  let selectedTier = tiers.find((t) => t.is_featured) || tiers[Math.floor(tiers.length / 2)];

  // ------------------------------------------------------------------ hero
  const hero = el('div', { class: 'wallet-hero' },
    el('div', { class: 'row-between wrap', style: { marginBottom: '6px' } },
      el('div', { class: 'up subtle' }, 'Wallet balance'),
      el('span', { class: 'badge badge-brass' }, '🎁 Bonus credit never expires'),
    ),
    el('div', { class: 'wallet-balance' }, money(wallet.balance_pence)),
    el('div', { class: 'wallet-split', style: { marginTop: '16px' } },
      el('div', { class: 'wallet-split-item' },
        el('span', { class: 'tiny subtle' }, 'Your money'),
        el('span', { class: 'mono bold' }, money(wallet.cash_pence))),
      el('div', { class: 'wallet-split-item' },
        el('span', { class: 'tiny subtle' }, 'Bonus credit'),
        el('span', { class: 'mono bold pos' }, money(wallet.bonus_pence))),
      el('div', { class: 'wallet-split-item' },
        el('span', { class: 'tiny subtle' }, 'Bonus earned all-time'),
        el('span', { class: 'mono bold' }, money(wallet.lifetime_bonus_pence))),
    ),
  );

  // ------------------------------------------------------- value explainer
  const insightCard = el('div', { class: 'card', style: { borderColor: 'var(--brass-ring)' } },
    el('div', { class: 'row', style: { alignItems: 'flex-start', gap: '12px' } },
      el('div', { style: { fontSize: '22px' } }, '💡'),
      el('div', {},
        el('div', { class: 'bold' }, insight.headline),
        el('div', { class: 'small muted', style: { marginTop: '3px' } }, insight.subline)),
    ),
  );

  // ---------------------------------------------------------- top-up tiers
  const tierGrid = el('div', { class: 'tier-grid' });
  const summary = el('div', { class: 'card', style: { background: 'var(--surface-2)' } });

  function paintSummary() {
    clear(summary);
    const t = selectedTier;
    const total = t.pay_pence + t.bonus_pence;
    const rate = t.pay_pence ? (100 * t.bonus_pence / t.pay_pence) : 0;
    summary.append(
      el('div', { class: 'row-between wrap', style: { gap: '16px' } },
        el('div', {},
          el('div', { class: 'up subtle' }, 'You pay'),
          el('div', { class: 'mono bold', style: { fontSize: '26px' } }, money(t.pay_pence))),
        el('div', { style: { fontSize: '20px', color: 'var(--fg-subtle)' } }, '→'),
        el('div', {},
          el('div', { class: 'up subtle' }, 'You get to spend'),
          el('div', { class: 'mono bold pos', style: { fontSize: '26px' } }, money(total))),
        el('div', { class: 'spacer' }),
        el('div', { class: 'center' },
          el('div', { class: 'badge badge-success', style: { fontSize: '13px' } },
            `+${money(t.bonus_pence)} free`),
          el('div', { class: 'tiny subtle', style: { marginTop: '4px' } }, `${rate.toFixed(0)}% bonus`)),
      ),
    );
  }

  function paintTiers() {
    clear(tierGrid);
    for (const t of tiers) {
      const rate = t.pay_pence ? (100 * t.bonus_pence / t.pay_pence) : 0;
      const node = el('button', {
        class: `tier${selectedTier?.id === t.id ? ' selected' : ''}`,
        onclick: () => { selectedTier = t; paintTiers(); paintSummary(); },
        'aria-pressed': selectedTier?.id === t.id,
      },
        // Coerce with !! — SQLite returns 0/1 for booleans, and `0 && node`
        // evaluates to the number 0, which renders as a stray "0" on screen.
        !!t.is_featured && el('span', { class: 'tier-flag' }, 'Most popular'),
        el('div', { class: 'tier-pay' }, money(t.pay_pence, { whole: true })),
        el('div', { class: 'tier-get' }, `get ${money(t.pay_pence + t.bonus_pence, { whole: true })}`),
        el('div', { class: 'tiny subtle', style: { marginTop: '5px' } }, `${rate.toFixed(0)}% bonus`),
      );
      tierGrid.append(node);
    }
  }
  paintTiers();
  paintSummary();

  const topUpBtn = el('button', { class: 'btn btn-primary btn-lg btn-block' }, 'Top up wallet');
  topUpBtn.addEventListener('click', async () => {
    topUpBtn.disabled = true;
    topUpBtn.textContent = 'Processing…';
    try {
      const res = await api.topup(state.customerId, { tier_id: selectedTier.id });
      toast(res.message, 'success');
      await state.refreshCustomers();
      render(host);
    } catch (e) {
      toast(e.message, 'error');
      topUpBtn.disabled = false;
      topUpBtn.textContent = 'Top up wallet';
    }
  });

  const customBtn = el('button', { class: 'btn btn-ghost btn-block' }, 'Enter a custom amount');
  customBtn.addEventListener('click', () => {
    const input = el('input', {
      class: 'input', type: 'number', min: '5', max: '1000', step: '5',
      placeholder: 'e.g. 75', inputmode: 'decimal',
    });
    const preview = el('div', { class: 'small muted', style: { minHeight: '20px' } },
      'Bonus is applied at the rate of the highest tier your amount reaches.');
    input.addEventListener('input', () => {
      const v = Number(input.value);
      if (!v || v < 5) { preview.textContent = 'Minimum top-up is £5.00.'; return; }
      const tier = [...tiers].reverse().find((t) => t.pay_pence <= v * 100);
      const rate = tier ? tier.bonus_pence / tier.pay_pence : 0;
      const bonus = Math.round(v * 100 * rate);
      preview.innerHTML = `Pay <strong>${money(v * 100)}</strong> → spend `
        + `<strong class="pos">${money(v * 100 + bonus)}</strong> (+${money(bonus)} bonus)`;
    });

    modal({
      title: 'Custom top-up',
      body: el('div', { class: 'stack' },
        el('div', { class: 'field' }, el('label', {}, 'Amount in £'), input), preview),
      actions: [
        { label: 'Cancel', class: 'btn-ghost' },
        {
          label: 'Top up', class: 'btn-primary',
          onClick: async () => {
            const v = Number(input.value);
            if (!v || v < 5) { toast('Minimum top-up is £5.00.', 'error'); return false; }
            try {
              const res = await api.topup(state.customerId, { pay_pence: Math.round(v * 100) });
              toast(res.message, 'success');
              await state.refreshCustomers();
              render(host);
            } catch (e) { toast(e.message, 'error'); }
          },
        },
      ],
    });
  });

  const topupCard = el('div', { class: 'card card-pad-lg' },
    el('div', { class: 'card-head' },
      el('div', {},
        el('h3', {}, 'Add money, get more back'),
        el('div', { class: 'sub' }, 'The bigger the top-up, the bigger the bonus. Credit works on any service or add-on.'))),
    el('div', { class: 'stack' }, tierGrid, summary, topUpBtn, customBtn),
  );

  // -------------------------------------------------------------- ledger
  // Capped with internal scroll: an uncapped 40-row statement stretched the
  // page to ~3,400px and left a dead column of whitespace beside it.
  const ledger = el('div', {
    class: 'ledger',
    style: { maxHeight: '520px', overflowY: 'auto', paddingRight: '4px' },
  });
  if (!transactions.length) {
    ledger.append(empty('🧾', 'No transactions yet', 'Your first top-up will appear here.'));
  } else {
    for (const tx of transactions) {
      const meta = KIND_META[tx.kind] || { icon: '•', label: tx.kind };
      const positive = tx.amount_pence > 0;
      ledger.append(el('div', { class: 'ledger-item' },
        el('div', { class: 'ledger-ico' }, meta.icon),
        el('div', { style: { minWidth: 0 } },
          el('div', { class: 'bold small truncate' }, tx.description),
          el('div', { class: 'tiny subtle' },
            `${meta.label} · ${fmtDateTime(tx.created_at)}`)),
        el('div', { class: 'ledger-amount' },
          el('div', { class: positive ? 'pos' : '' },
            `${positive ? '+' : '−'}${money(Math.abs(tx.amount_pence))}`),
          el('div', { class: 'tiny subtle' }, `bal ${moneyShort(tx.balance_after)}`)),
      ));
    }
  }

  const ledgerCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', {},
        el('h3', {}, 'Statement'),
        el('div', { class: 'sub' }, 'Every movement in and out, most recent first.')),
      el('div', { class: 'card-head-actions' },
        el('span', { class: 'badge' }, `${transactions.length} entries`))),
    ledger,
  );

  // ------------------------------------------------------- how it works
  const howCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('div', {}, el('h3', {}, 'How the wallet works'))),
    el('ul', { class: 'feature-list' },
      ...[
        'Top up once, then walk in and out without touching your card.',
        'Bonus credit is spent first, so your own money lasts longer.',
        'Balance never expires and covers services, add-ons and products.',
        'Cancel a booking and the exact amount returns to your wallet.',
      ].map((t) => el('li', {}, el('span', { class: 'tick' }, '✓'), el('span', {}, t))),
    ),
  );

  host.append(el('div', { class: 'stack-lg' },
    hero,
    insightCard,
    el('div', { class: 'grid', style: { gridTemplateColumns: 'minmax(0,1.15fr) minmax(0,1fr)' } },
      topupCard,
      el('div', { class: 'stack' }, ledgerCard, howCard)),
  ));

  // Collapse the two-column split on narrow screens.
  const gridNode = host.querySelector('.grid');
  const applyCols = () => {
    gridNode.style.gridTemplateColumns = window.innerWidth < 960
      ? 'minmax(0,1fr)' : 'minmax(0,1.15fr) minmax(0,1fr)';
  };
  applyCols();
  window.addEventListener('resize', applyCols, { once: true });
}
