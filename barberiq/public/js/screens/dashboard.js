/**
 * E. OWNER DASHBOARD
 *
 * This is the screen that sells the product, so it is built around the four
 * questions an owner actually asks: what did I take, who is performing, who is
 * about to stop coming, and what should I do about it today.
 *
 * The insights panel sits high on the page because a dashboard that only
 * reports is a dashboard that gets checked once a week. One that tells you
 * what to do gets opened every morning.
 */
import { api, state } from '../api.js';
import {
  el, clear, money, moneyShort, pct, toast, areaChart, barChart, donut,
  trendPill, riskBadge, skeletonCards, skeletonLines, empty,
  fmtTime, fmtDate, relDays,
} from '../ui.js';

let currentRange = 'today';

const SOURCE_META = {
  app:      { label: 'In-app booking', color: 'var(--brass)' },
  reminder: { label: 'Rebook reminder', color: 'var(--success)' },
  referral: { label: 'Referral',        color: 'var(--info)' },
  walk_in:  { label: 'Walk-in',         color: 'var(--warn)' },
  phone:    { label: 'Phone',           color: 'var(--fg-subtle)' },
};

export async function render(host) {
  clear(host);
  host.append(el('div', { class: 'stack' }, skeletonCards(4), skeletonLines(6)));

  let dash, barbers, top20, insights, addonPerf, winback;
  try {
    [dash, barbers, top20, insights, addonPerf, winback] = await Promise.all([
      api.dashboard(currentRange),
      api.dashBarbers(),
      api.dashCustomers(20),
      api.dashInsights(),
      api.dashAddons(),
      api.dashWinback(),
    ]);
  } catch (e) {
    clear(host);
    host.append(empty('⚠️', 'Could not load the dashboard', e.message));
    return;
  }

  clear(host);
  const t = dash.totals;

  // ------------------------------------------------------------ range switch
  const rangeLabel = { today: 'Today', week: 'Last 7 days', month: 'Last 30 days', year: 'Last 12 months' };
  const seg = el('div', { class: 'segmented' },
    ...Object.entries(rangeLabel).map(([k, label]) => el('button', {
      class: currentRange === k ? 'active' : '',
      onclick: () => { currentRange = k; render(host); },
    }, label)));

  // ---------------------------------------------------------------- KPI tiles
  const kpis = el('div', { class: 'grid g4' },
    el('div', { class: 'stat featured' },
      el('span', { class: 'stat-accent' }),
      el('span', { class: 'stat-label' }, currentRange === 'today' ? "Today's earnings" : 'Revenue'),
      el('span', { class: 'stat-value' }, money(t.revenue_pence)),
      el('span', { class: 'stat-foot' },
        trendPill(dash.trend.revenue_pct),
        el('span', { class: 'subtle' }, `vs ${money(dash.trend.prev_revenue_pence)} prior`)),
    ),
    statTile('Cuts completed', String(t.cuts),
      el('span', { class: 'stat-foot' },
        trendPill(dash.trend.cuts_pct),
        el('span', { class: 'subtle' }, `${t.booked_ahead} still booked`))),
    statTile('Average ticket', money(t.avg_ticket_pence),
      el('span', { class: 'stat-foot subtle' },
        `${money(t.addons_pence)} of that from add-ons`)),
    statTile('Add-on attach rate', pct(t.addon_attach_pct, 1),
      el('span', { class: 'stat-foot subtle' },
        `${t.with_addons} of ${t.cuts} baskets`)),
  );

  function statTile(label, value, foot) {
    return el('div', { class: 'stat' },
      el('span', { class: 'stat-label' }, label),
      el('span', { class: 'stat-value' }, value),
      foot);
  }

  // Second row: the numbers a CFO cares about.
  const kpis2 = el('div', { class: 'grid g4' },
    statTile('Wallet cash held', money(dash.wallet.cash_liability_pence),
      el('span', { class: 'stat-foot subtle' }, 'customer money — a real liability')),
    statTile('Bonus credit outstanding', money(dash.wallet.bonus_liability_pence),
      el('span', { class: 'stat-foot subtle' }, 'marketing cost already spent')),
    statTile('Prepaid all-time', money(dash.wallet.lifetime_topup_pence),
      el('span', { class: 'stat-foot subtle' }, 'cash collected before service')),
    statTile('Customer retention', pct(dash.retention.pct, 1),
      el('span', { class: 'stat-foot subtle' },
        `${dash.retention.one_and_done} of ${dash.retention.ever_visited} never came back`)),
    statTile('No-shows', String(t.no_shows),
      el('span', { class: 'stat-foot subtle' },
        t.no_shows > 0 ? 'chairs that could not be resold' : 'clean sheet')),
  );

  // ------------------------------------------------------------- insights
  const insightCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', {},
        el('h3', {}, '🧠 What needs your attention'),
        el('div', { class: 'sub' }, 'Generated from your own trading data, ranked by what it is worth.'))),
    insights.insights.length
      ? el('div', { class: 'stack-sm' },
        ...insights.insights.map((i) => el('div', { class: `insight ${i.severity}` },
          el('div', { class: 'insight-ico' }, i.icon),
          el('div', { style: { minWidth: 0 } },
            el('div', { class: 'bold small' }, i.title),
            el('div', { class: 'tiny muted', style: { marginTop: '3px' } }, i.detail)))))
      : empty('✅', 'Nothing urgent', 'Everything is tracking normally.'),
  );

  // ---------------------------------------------------------------- charts
  const chartCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', {},
        el('h3', {}, 'Revenue trend'),
        el('div', { class: 'sub' }, 'Hover any point for the day’s takings.'))),
    el('div', { style: { overflow: 'hidden' } }, areaChart(dash.series, { height: 200 })),
  );

  const hourCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', {},
        el('h3', {}, 'Busiest hours'),
        el('div', { class: 'sub' }, 'Last 90 days. The amber bar is your quietest hour — that is the one to fill.'))),
    el('div', { style: { overflow: 'hidden' } },
      barChart(dash.by_hour, { height: 150, valueKey: 'cuts', labelKey: 'hour' })),
  );

  // Booking source mix — proves which channel earns its keep.
  const segments = dash.source_mix.map((s) => ({
    label: SOURCE_META[s.source]?.label || s.source,
    value: s.n,
    color: SOURCE_META[s.source]?.color || 'var(--fg-subtle)',
  }));
  const sourceCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('div', {},
      el('h3', {}, 'Where bookings came from'),
      el('div', { class: 'sub' },
        'Last 90 days. Reminder-driven bookings are revenue the shop would otherwise have missed.'))),
    segments.length
      ? el('div', { class: 'row wrap', style: { gap: '18px' } },
        donut(segments, { size: 124, thickness: 16 }),
        el('div', { class: 'stack-sm', style: { flex: '1 1 150px' } },
          ...dash.source_mix.map((s) => el('div', { class: 'row', style: { gap: '8px' } },
            el('span', {
              style: {
                width: '9px', height: '9px', borderRadius: '3px', flex: '0 0 auto',
                background: SOURCE_META[s.source]?.color || 'var(--fg-subtle)',
              },
            }),
            el('span', { class: 'small' }, SOURCE_META[s.source]?.label || s.source),
            el('span', { class: 'spacer' }),
            el('span', { class: 'mono small bold' }, String(s.n)),
            el('span', { class: 'mono tiny subtle' }, moneyShort(s.revenue_pence))))))
      : empty('📊', 'No completed bookings in this period', 'Try a wider date range.'),
  );

  // --------------------------------------------------------- barber table
  const maxBarberRev = Math.max(...barbers.barbers.map((b) => b.revenue_pence), 1);
  const barberCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', {},
        el('h3', {}, 'Barber performance'),
        // "Return ≤45d" rather than "Rebook %": this is measured per visit, so
        // loyal regulars dominate the denominator and it runs much higher than
        // the industry "rebook rate" (which counts clients, not visits).
        // Naming it precisely stops an owner comparing it to the wrong figure.
        el('div', { class: 'sub' },
          'All-time revenue with last-30-day form. “Return ≤45d” is the share of this '
          + 'barber’s visits followed by another visit within 45 days.'))),
    el('div', { class: 'table-wrap' },
      el('table', { class: 'data' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'Barber'), el('th', {}, 'Share'),
          el('th', { class: 'num' }, 'Cuts'), el('th', { class: 'num' }, 'Revenue'),
          el('th', { class: 'num' }, 'Avg ticket'), el('th', { class: 'num' }, 'Add-on %'),
          el('th', { class: 'num' }, 'Return ≤45d'), el('th', { class: 'num' }, '30-day'),
          el('th', { class: 'num' }, 'Commission'))),
        el('tbody', {}, ...barbers.barbers.map((b) => el('tr', {},
          el('td', {}, el('div', { class: 'row', style: { gap: '9px' } },
            el('div', { class: 'avatar' }, b.avatar_emoji),
            el('div', { style: { minWidth: 0 } },
              el('div', { class: 'bold small' }, b.nickname || b.name),
              el('div', { class: 'tiny subtle truncate' }, b.specialty || '')))),
          el('td', {}, el('div', { class: 'bar-track' },
            el('span', { style: { width: `${(100 * b.revenue_pence / maxBarberRev).toFixed(1)}%` } }))),
          el('td', { class: 'num' }, String(b.cuts)),
          el('td', { class: 'num bold' }, money(b.revenue_pence)),
          el('td', { class: 'num' }, money(b.avg_ticket_pence)),
          el('td', { class: 'num' }, pct(b.addon_attach_pct, 1)),
          el('td', { class: 'num' }, pct(b.rebook_pct, 1)),
          el('td', { class: 'num subtle' }, moneyShort(b.recent_revenue_pence)),
          el('td', { class: 'num' }, money(b.commission_pence)),
        ))),
      ),
    ),
  );

  // ------------------------------------------------------- top 20 customers
  const top20Card = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', {},
        el('h3', {}, 'Top 20 customers'),
        el('div', { class: 'sub' }, 'By lifetime spend, with each one’s predicted return cycle and risk.'))),
    el('div', { class: 'table-wrap' },
      el('table', { class: 'data' },
        el('thead', {}, el('tr', {},
          el('th', {}, '#'), el('th', {}, 'Customer'),
          el('th', { class: 'num' }, 'Visits'), el('th', { class: 'num' }, 'Lifetime'),
          el('th', { class: 'num' }, 'Avg'), el('th', { class: 'num' }, 'Cycle'),
          el('th', { class: 'num' }, 'Last seen'), el('th', {}, 'Status'),
          el('th', { class: 'num' }, 'Wallet'), el('th', { class: 'num' }, 'Refs'))),
        el('tbody', {}, ...top20.customers.map((c) => el('tr', {},
          el('td', { class: 'mono subtle' }, String(c.rank)),
          el('td', {}, el('div', { class: 'row', style: { gap: '9px' } },
            el('div', { class: 'avatar' }, c.avatar_emoji),
            el('div', { class: 'bold small truncate' }, c.name))),
          el('td', { class: 'num' }, String(c.visits)),
          el('td', { class: 'num bold' }, money(c.lifetime_pence)),
          el('td', { class: 'num' }, money(c.avg_ticket_pence)),
          el('td', { class: 'num' }, `${c.cycle_days}d`),
          el('td', { class: 'num' }, `${c.days_since_visit}d`),
          el('td', {}, riskBadge(c.risk_band, c.risk_label)),
          el('td', { class: 'num' }, c.wallet_balance_pence > 0 ? money(c.wallet_balance_pence) : '—'),
          el('td', { class: 'num' }, c.successful_referrals > 0 ? `🤝 ${c.successful_referrals}` : '—'),
        ))),
      ),
    ),
  );

  // ------------------------------------------------------------- win-back
  const wbCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', {},
        el('h3', {}, '🎯 Win-back list'),
        el('div', { class: 'sub' }, 'Past their own cycle, ranked by what one recovered visit is worth.')),
      el('div', { class: 'card-head-actions' },
        el('span', { class: 'badge badge-warn' },
          `${money(winback.total_opportunity_pence)} at stake`))),
    winback.customers.length
      ? el('div', { class: 'table-wrap' },
        el('table', { class: 'data' },
          el('thead', {}, el('tr', {},
            el('th', {}, 'Customer'), el('th', { class: 'num' }, 'Visits'),
            el('th', { class: 'num' }, 'Avg ticket'), el('th', { class: 'num' }, 'Cycle'),
            el('th', { class: 'num' }, 'Overdue'), el('th', {}, 'Risk'), el('th', {}, ''))),
          el('tbody', {}, ...winback.customers.slice(0, 12).map((c) => el('tr', {},
            el('td', {}, el('div', { class: 'row', style: { gap: '9px' } },
              el('div', { class: 'avatar' }, c.avatar_emoji),
              el('div', { style: { minWidth: 0 } },
                el('div', { class: 'bold small truncate' }, c.name),
                el('div', { class: 'tiny subtle' }, c.phone || c.email || '')))),
            el('td', { class: 'num' }, String(c.visits)),
            el('td', { class: 'num' }, money(c.avg_ticket_pence)),
            el('td', { class: 'num' }, `${c.cycle_days}d`),
            el('td', { class: 'num neg bold' }, `${c.days_since_visit}d`),
            el('td', {}, riskBadge(c.risk_band, c.risk_label)),
            el('td', {}, el('button', {
              class: 'btn btn-ghost btn-sm',
              onclick: () => toast(`Win-back offer queued for ${c.name.split(' ')[0]}.`, 'success'),
            }, 'Send offer')),
          ))),
        ))
      : empty('✅', 'Nobody overdue', 'Every regular is on track.'),
  );

  // ------------------------------------------------------------- add-ons
  const maxAddon = Math.max(...addonPerf.addons.map((a) => a.revenue_pence), 1);
  const addonCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', {},
        el('h3', {}, 'Add-on performance'),
        el('div', { class: 'sub' }, 'Which extras actually sell, and what they bring in.'))),
    el('div', { class: 'stack-sm' },
      ...addonPerf.addons.slice(0, 8).map((a) => el('div', { class: 'row', style: { gap: '11px' } },
        el('span', { style: { fontSize: '17px', width: '22px' } }, a.icon),
        el('div', { style: { minWidth: 0, flex: '1 1 auto' } },
          el('div', { class: 'row-between' },
            el('span', { class: 'small bold truncate' }, a.name),
            el('span', { class: 'mono small' }, money(a.revenue_pence))),
          el('div', { class: 'bar-track', style: { marginTop: '4px' } },
            el('span', { style: { width: `${(100 * a.revenue_pence / maxAddon).toFixed(1)}%` } })),
          el('div', { class: 'tiny subtle', style: { marginTop: '2px' } },
            `${a.times_sold} sold · attached to ${pct(a.attach_pct, 1)} of visits`)),
      ))),
  );

  // ------------------------------------------------------------ today's diary
  const diaryCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', {},
        el('h3', {}, "Today's diary"),
        el('div', { class: 'sub' }, `${dash.today.length} appointments on the book.`))),
    dash.today.length
      ? el('div', { class: 'stack-sm', style: { maxHeight: '420px', overflowY: 'auto' } },
        ...dash.today.map((a) => el('div', {
          class: 'row', style: {
            gap: '11px', padding: '9px 11px', borderRadius: '10px',
            background: a.status === 'completed' ? 'var(--success-soft)'
              : a.status === 'no_show' ? 'var(--danger-soft)' : 'var(--surface-2)',
          },
        },
          el('span', { class: 'mono bold small', style: { width: '42px', flex: '0 0 auto' } },
            fmtTime(a.starts_at)),
          el('div', { class: 'avatar' }, a.customer_emoji),
          el('div', { style: { minWidth: 0, flex: '1 1 auto' } },
            el('div', { class: 'bold small truncate' }, a.customer_name),
            el('div', { class: 'tiny subtle truncate' },
              `${a.service_icon} ${a.service_name} · ${a.barber_name}`)),
          el('div', { class: 'col', style: { alignItems: 'flex-end', flex: '0 0 auto' } },
            el('span', { class: 'mono small bold' }, money(a.total_pence)),
            el('span', {
              class: `badge ${a.status === 'completed' ? 'badge-success'
                : a.status === 'no_show' ? 'badge-danger'
                  : a.status === 'cancelled' ? 'badge' : 'badge-info'}`,
              style: { marginTop: '3px' },
            }, a.status === 'completed' ? 'Done'
              : a.status === 'no_show' ? 'No-show'
                : a.status === 'cancelled' ? 'Cancelled' : 'Booked')),
        )))
      : empty('📅', 'Nothing booked today', 'The diary is clear.'),
  );

  // ------------------------------------------------------------------ layout
  const twoCol = (a, b, ratio = '1.35fr') => {
    const node = el('div', { class: 'grid', style: { gridTemplateColumns: `minmax(0,${ratio}) minmax(0,1fr)` } }, a, b);
    const apply = () => {
      node.style.gridTemplateColumns = window.innerWidth < 1000 ? 'minmax(0,1fr)' : `minmax(0,${ratio}) minmax(0,1fr)`;
    };
    apply();
    window.addEventListener('resize', apply);
    return node;
  };

  host.append(el('div', { class: 'stack-lg' },
    el('div', { class: 'row-between wrap' },
      el('div', {},
        el('h2', { style: { fontSize: '20px' } }, `${state.shop?.name || 'Your shop'} — owner console`),
        el('div', { class: 'small subtle' },
          `${rangeLabel[currentRange]} · ${state.customers.length} customers on the books`)),
      seg),
    kpis,
    insightCard,
    twoCol(chartCard, sourceCard),
    hourCard,
    // The barber, top-20 and win-back tables run full width. Nested in a
    // narrow grid column they clipped their right-hand columns (commission,
    // the win-back action button) behind an overflow scroll a client would
    // never think to look for.
    barberCard,
    twoCol(diaryCard, addonCard),
    kpis2,
    top20Card,
    wbCard,
  ));
}
