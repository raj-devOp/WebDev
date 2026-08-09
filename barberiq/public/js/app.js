/**
 * App shell: routing, navigation, persona switching and theme.
 *
 * Hash routing rather than the History API — it means the app also works when
 * opened from a file path or behind an odd reverse proxy, which removes one
 * more thing that can embarrass you during a demo.
 */
import { api, state } from './api.js';
import { el, clear, money, toast, modal, empty, confirmDialog } from './ui.js';

import * as wallet from './screens/wallet.js';
import * as reminders from './screens/reminders.js';
import * as booking from './screens/booking.js';
import * as referral from './screens/referral.js';
import * as dashboard from './screens/dashboard.js';
import * as pricing from './screens/pricing.js';

const ROUTES = {
  '/wallet':    { title: 'Wallet',          sub: 'Top up once, spend all month',            icon: '👛', mod: wallet,     audience: 'customer' },
  '/book':      { title: 'Book & add-ons',  sub: 'Pick a cut, add the extras',              icon: '✂️', mod: booking,    audience: 'customer' },
  '/reminders': { title: 'Reminders',       sub: 'Timed to your own haircut rhythm',        icon: '🔔', mod: reminders,  audience: 'customer' },
  '/referral':  { title: 'Refer a friend',  sub: 'Give £10, get £10',                       icon: '🤝', mod: referral,   audience: 'customer' },
  '/dashboard': { title: 'Owner dashboard', sub: 'Earnings, staff and customer intelligence', icon: '📊', mod: dashboard, audience: 'owner' },
  '/pricing':   { title: 'Plans & pricing', sub: 'What this costs and what it returns',     icon: '💷', mod: pricing,    audience: 'owner' },
};
const DEFAULT_ROUTE = '/wallet';

const routeOf = () => {
  const raw = (location.hash || '').replace(/^#/, '');
  return ROUTES[raw] ? raw : DEFAULT_ROUTE;
};

// ---------------------------------------------------------------------- shell
const contentHost = el('div', { class: 'content', id: 'view' });
const titleNode = el('h1', {});
const subNode = el('div', { class: 'topbar-sub' });
const navHost = el('div', {});
const mobileNav = el('nav', { class: 'mobile-nav', 'aria-label': 'Main navigation' });
const personaHost = el('div', {});

function buildSidebar() {
  const sidebar = el('aside', { class: 'sidebar' },
    el('div', { class: 'brand' },
      el('div', { class: 'brand-mark' }, '💈'),
      el('div', { style: { minWidth: 0 } },
        el('div', { class: 'brand-name' }, 'BarberIQ'),
        el('div', { class: 'brand-sub' }, 'Barbershop OS'))),
    navHost,
    el('div', { class: 'sidebar-foot' }, personaHost, buildFooterActions()),
  );
  return sidebar;
}

function buildFooterActions() {
  return el('div', { class: 'stack-sm' },
    el('button', {
      class: 'nav-item',
      onclick: () => { state.toggleTheme(); paintNav(); },
    }, el('span', { class: 'ico' }, state.theme === 'dark' ? '☀️' : '🌙'),
      el('span', {}, state.theme === 'dark' ? 'Light mode' : 'Dark mode')),
    el('button', {
      class: 'nav-item',
      onclick: async () => {
        if (!(await confirmDialog('Regenerate demo data?',
          'This rebuilds the whole demo database from scratch — a clean slate before a client '
          + 'meeting. Any bookings or top-ups you made during this session are discarded.',
          'Regenerate'))) return;
        toast('Rebuilding demo data…');
        try {
          await api.reseed();
          await state.load();
          toast('Fresh demo data ready.', 'success');
          paintNav(); paintPersona(); await renderRoute();
        } catch (e) { toast(e.message, 'error'); }
      },
    }, el('span', { class: 'ico' }, '♻️'), el('span', {}, 'Reset demo data')),
  );
}

function paintNav() {
  const current = routeOf();
  clear(navHost);
  clear(mobileNav);

  for (const [group, label] of [['customer', 'Customer app'], ['owner', 'Shop owner']]) {
    const g = el('div', { class: 'nav-group' }, el('div', { class: 'nav-label' }, label));
    for (const [path, r] of Object.entries(ROUTES)) {
      if (r.audience !== group) continue;
      g.append(el('a', {
        class: `nav-item${current === path ? ' active' : ''}`,
        href: `#${path}`,
      }, el('span', { class: 'ico' }, r.icon), el('span', {}, r.title)));
    }
    navHost.append(g);
  }

  // Mobile bar: the four customer screens plus the dashboard.
  for (const path of ['/wallet', '/book', '/reminders', '/referral', '/dashboard']) {
    const r = ROUTES[path];
    mobileNav.append(el('a', {
      class: current === path ? 'active' : '', href: `#${path}`,
    }, el('span', { class: 'ico' }, r.icon),
      el('span', {}, path === '/dashboard' ? 'Owner' : path === '/book' ? 'Book' : r.title)));
  }

  // Rebuild footer so the theme label stays correct.
  const foot = document.querySelector('.sidebar-foot');
  if (foot) { clear(foot); foot.append(personaHost, buildFooterActions()); }
}

function paintPersona() {
  clear(personaHost);
  const c = state.customer;
  if (!c) return;
  personaHost.append(el('button', {
    class: 'persona', onclick: openPersonaPicker,
    title: 'Switch which customer you are viewing as',
  },
    el('div', { class: 'avatar' }, c.avatar_emoji),
    el('div', { style: { minWidth: 0, textAlign: 'left' } },
      el('div', { class: 'bold small truncate' }, c.name),
      el('div', { class: 'tiny subtle' }, `${money(c.wallet_balance_pence)} · ${c.visits} visits`)),
    el('span', { class: 'subtle' }, '⇄'),
  ));
}

function openPersonaPicker() {
  const search = el('input', { class: 'input', placeholder: 'Search customers…', autocomplete: 'off' });
  const list = el('div', { class: 'stack-sm', style: { maxHeight: '46vh', overflowY: 'auto', marginTop: '11px' } });

  function paint(filter = '') {
    clear(list);
    const f = filter.trim().toLowerCase();
    const rows = state.customers
      .filter((c) => !f || c.name.toLowerCase().includes(f))
      .slice(0, 60);
    if (!rows.length) { list.append(empty('🔍', 'No match', 'Try another name.')); return; }
    for (const c of rows) {
      list.append(el('button', {
        class: 'persona',
        style: c.id === state.customerId ? { borderColor: 'var(--brass)' } : {},
        onclick: () => {
          state.setCustomer(c.id);
          paintPersona();
          renderRoute();
          toast(`Now viewing as ${c.name}.`);
          host.close();
        },
      },
        el('div', { class: 'avatar' }, c.avatar_emoji),
        el('div', { style: { minWidth: 0, textAlign: 'left' } },
          el('div', { class: 'bold small truncate' }, c.name),
          el('div', { class: 'tiny subtle' }, `${c.visits} visits · wallet ${money(c.wallet_balance_pence)}`)),
        c.id === state.customerId && el('span', { class: 'badge badge-brass' }, 'current'),
      ));
    }
  }
  search.addEventListener('input', () => paint(search.value));
  paint();

  const host = modal({
    title: 'View as customer',
    body: el('div', {},
      el('p', { class: 'small muted', style: { marginBottom: '11px' } },
        'The customer screens render for whoever is selected here. Handy mid-demo: switch to a '
        + 'loyal regular to show a tight rebook cycle, then to a lapsed one to show the win-back.'),
      search, list),
  });
}

// -------------------------------------------------------------------- routing
let renderToken = 0;

async function renderRoute() {
  const path = routeOf();
  const r = ROUTES[path];
  titleNode.textContent = r.title;
  subNode.textContent = r.sub;
  document.title = `${r.title} · BarberIQ`;
  paintNav();

  // Guard against a slow render finishing after the user has moved on.
  const token = ++renderToken;
  try {
    await r.mod.render(contentHost);
  } catch (e) {
    if (token !== renderToken) return;
    clear(contentHost);
    contentHost.append(empty('⚠️', 'This screen failed to load', e.message));
    console.error(e);
  }
  if (token === renderToken) window.scrollTo({ top: 0, behavior: 'instant' });
}

// ----------------------------------------------------------------------- boot
async function boot() {
  state.initTheme();

  const app = el('div', { class: 'app' },
    buildSidebar(),
    el('main', { class: 'main' },
      el('header', { class: 'topbar' },
        el('div', { style: { minWidth: 0 } }, titleNode, subNode),
        el('div', { class: 'topbar-actions' },
          el('a', { class: 'btn btn-ghost btn-sm', href: '#/pricing' }, '💷 Pricing'),
          el('button', {
            class: 'btn btn-ghost btn-icon', title: 'Toggle light/dark',
            onclick: () => { state.toggleTheme(); paintNav(); },
          }, '◐'))),
      contentHost),
    mobileNav,
  );
  clear(document.body);
  document.body.append(app);

  try {
    await state.load();
  } catch (e) {
    clear(contentHost);
    contentHost.append(empty('🔌', 'Cannot reach the server',
      'Start it with "npm start" and reload this page.'));
    console.error(e);
    return;
  }

  // A trial banner on first paint — it is also the thing you want a prospect
  // to notice within the first five seconds.
  if (state.shop?.trial_days_left != null && state.shop.subscription_state === 'trialing') {
    const banner = el('div', {
      class: 'card', style: {
        margin: '0 0 18px', borderColor: 'var(--brass-ring)',
        background: 'var(--brass-soft)', padding: '12px 15px',
      },
    },
      el('div', { class: 'row-between wrap', style: { gap: '10px' } },
        el('div', { class: 'row', style: { gap: '9px' } },
          el('span', {}, '🎁'),
          el('span', { class: 'small' },
            `Free trial — ${state.shop.trial_days_left} days left. Full features, no card taken.`)),
        el('a', { class: 'btn btn-primary btn-sm', href: '#/pricing' }, 'See plans')));
    contentHost.before(banner);
  }

  paintPersona();
  await renderRoute();

  window.addEventListener('hashchange', renderRoute);

  // Keyboard shortcuts — fast screen switching while presenting.
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
    const map = { 1: '/wallet', 2: '/book', 3: '/reminders', 4: '/referral', 5: '/dashboard', 6: '/pricing' };
    if (map[e.key]) { location.hash = `#${map[e.key]}`; }
    if (e.key === 'p' || e.key === 'P') openPersonaPicker();
  });
}

boot();
