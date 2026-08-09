/**
 * C. BOOK + ADD-ONS
 *
 * The brief: while booking, the customer should see beard trim, head massage
 * and so on alongside the haircut. The commercial upgrade is that the list is
 * ordered by what THIS customer is likely to want, each row says why it is
 * being suggested, and the running basket total is always visible.
 *
 * Ordering matters more than it sounds: an add-on list sorted alphabetically
 * gets skimmed, whereas "you add this most visits" at the top gets tapped.
 */
import { api, state } from '../api.js';
import {
  el, clear, money, toast, skeletonLines, empty, todayISO,
  fmtDate, fmtTime, confirmDialog,
} from '../ui.js';

export async function render(host) {
  clear(host);
  host.append(skeletonLines(7));

  let cat, addons;
  try {
    cat = await api.catalogue();
    addons = (await api.recommendAddons(state.customerId, cat.services[0].id)).addons;
  } catch (e) {
    clear(host);
    host.append(empty('⚠️', 'Could not load the booking screen', e.message));
    return;
  }

  // ------------------------------------------------------------------ state
  const sel = {
    service: cat.services[0],
    barberId: null,          // null = any available
    date: todayISO(),
    time: null,
    addonIds: new Set(),
    payWithWallet: true,
  };

  const walletData = await api.wallet(state.customerId).catch(() => null);
  const balance = walletData?.wallet?.balance_pence ?? 0;

  // Containers, so each section can repaint independently.
  const serviceGrid = el('div', { class: 'pick-grid' });
  const barberGrid = el('div', { class: 'pick-grid' });
  const addonList = el('div', { class: 'stack-sm' });
  const slotWrap = el('div', {});
  const basket = el('div', { class: 'basket' });
  const dateStrip = el('div', { class: 'row wrap', style: { gap: '7px' } });

  // ---------------------------------------------------------------- services
  function paintServices() {
    clear(serviceGrid);
    for (const s of cat.services) {
      serviceGrid.append(el('button', {
        class: `pick${sel.service.id === s.id ? ' selected' : ''}`,
        'aria-pressed': sel.service.id === s.id,
        onclick: async () => {
          sel.service = s;
          paintServices();
          // Re-score add-ons: affinity is conditional on the chosen service.
          try {
            addons = (await api.recommendAddons(state.customerId, s.id)).addons;
            paintAddons();
          } catch { /* keep previous ordering */ }
          paintBasket();
          loadSlots();
        },
      },
        el('div', { class: 'pick-ico' }, s.icon),
        el('div', { class: 'pick-name' }, s.name),
        el('div', { class: 'pick-meta' }, `${s.duration_min} min`),
        el('div', { class: 'pick-price' }, money(s.price_pence)),
      ));
    }
  }

  // ----------------------------------------------------------------- barbers
  function paintBarbers() {
    clear(barberGrid);
    barberGrid.append(el('button', {
      class: `pick${sel.barberId === null ? ' selected' : ''}`,
      onclick: () => { sel.barberId = null; paintBarbers(); loadSlots(); },
    },
      el('div', { class: 'pick-ico' }, '🎲'),
      el('div', { class: 'pick-name' }, 'Anyone free'),
      el('div', { class: 'pick-meta' }, 'Best availability'),
    ));
    for (const b of cat.barbers) {
      barberGrid.append(el('button', {
        class: `pick${sel.barberId === b.id ? ' selected' : ''}`,
        onclick: () => { sel.barberId = b.id; paintBarbers(); loadSlots(); },
      },
        el('div', { class: 'pick-ico' }, b.avatar_emoji),
        el('div', { class: 'pick-name' }, b.nickname || b.name),
        el('div', { class: 'pick-meta truncate' }, b.specialty || ''),
        el('div', { class: 'tiny subtle' }, `★ ${b.rating.toFixed(1)}`),
      ));
    }
  }

  // ----------------------------------------------------------------- add-ons
  function paintAddons() {
    clear(addonList);
    const recommended = addons.filter((a) => a.recommended);
    const rest = addons.filter((a) => !a.recommended);

    if (recommended.length) {
      addonList.append(el('div', { class: 'row', style: { gap: '7px', margin: '2px 0 4px' } },
        el('span', { class: 'up subtle' }, 'Picked for you'),
        el('span', { class: 'badge badge-brass' }, '🧠 Based on your history')));
      recommended.forEach((a) => addonList.append(addonRow(a)));
    }
    if (rest.length) {
      addonList.append(el('div', { class: 'up subtle', style: { margin: '12px 0 4px' } },
        'Everything else'));
      rest.forEach((a) => addonList.append(addonRow(a)));
    }
  }

  function addonRow(a) {
    const on = sel.addonIds.has(a.id);
    return el('button', {
      class: `addon${on ? ' selected' : ''}${a.recommended ? ' recommended' : ''}`,
      'aria-pressed': on,
      onclick: () => {
        if (on) sel.addonIds.delete(a.id); else sel.addonIds.add(a.id);
        paintAddons(); paintBasket();
      },
    },
      el('span', { class: 'addon-check' }, '✓'),
      el('span', { class: 'addon-ico' }, a.icon),
      el('span', { style: { minWidth: 0, flex: '1 1 auto' } },
        el('span', { class: 'row', style: { gap: '7px' } },
          el('span', { class: 'bold small' }, a.name),
          a.recommended && el('span', { class: 'badge badge-brass tiny' }, a.reason)),
        el('span', { class: 'tiny subtle', style: { display: 'block' } },
          `${a.description} · +${a.duration_min} min`)),
      el('span', { class: 'mono bold' }, `+${money(a.price_pence)}`),
    );
  }

  // ------------------------------------------------------------------- dates
  function paintDates() {
    clear(dateStrip);
    for (let i = 0; i < 10; i++) {
      const d = new Date(Date.now() + i * 86400000);
      const iso = d.toISOString().slice(0, 10);
      const active = sel.date === iso;
      dateStrip.append(el('button', {
        class: `date-chip${active ? ' selected' : ''}`,
        style: { minWidth: '62px', padding: '8px 10px' },
        onclick: () => { sel.date = iso; sel.time = null; paintDates(); loadSlots(); paintBasket(); },
      },
        el('div', { class: 'tiny', style: { opacity: 0.75 } },
          i === 0 ? 'Today' : i === 1 ? 'Tom' : d.toLocaleDateString('en-GB', { weekday: 'short' })),
        el('div', { class: 'bold' }, d.getDate()),
      ));
    }
  }

  // ------------------------------------------------------------------- slots
  async function loadSlots() {
    clear(slotWrap);
    slotWrap.append(el('div', { class: 'skel skel-line', style: { height: '58px' } }));
    let res;
    try { res = await api.slots(sel.date); }
    catch (e) { clear(slotWrap); slotWrap.append(empty('⚠️', 'Could not load slots', e.message)); return; }

    clear(slotWrap);
    const grid = el('div', { class: 'slot-grid' });
    let anyFree = false;

    for (const s of res.slots) {
      // Respect the barber filter: a slot is only offered if that barber is free.
      const free = sel.barberId
        ? s.available_barbers.some((b) => b.id === sel.barberId)
        : s.available_barbers.length > 0;
      const usable = free && !s.in_past;
      if (usable) anyFree = true;

      grid.append(el('button', {
        class: `slot${sel.time === s.time ? ' selected' : ''}`,
        disabled: !usable,
        title: usable
          ? `${s.available_barbers.map((b) => b.name).join(', ')} available`
          : s.in_past ? 'Already passed' : 'Fully booked',
        onclick: () => { sel.time = s.time; loadSlots(); paintBasket(); },
      }, s.time));
    }
    slotWrap.append(grid);
    if (!anyFree) {
      slotWrap.append(el('div', { class: 'small muted', style: { marginTop: '10px' } },
        '⚠️ Nothing left on this day for that choice — try another date or “Anyone free”.'));
    }
  }

  // ------------------------------------------------------------------ basket
  function paintBasket() {
    clear(basket);
    const chosen = addons.filter((a) => sel.addonIds.has(a.id));
    const addonTotal = chosen.reduce((s, a) => s + a.price_pence, 0);
    const total = sel.service.price_pence + addonTotal;
    const duration = sel.service.duration_min + chosen.reduce((s, a) => s + a.duration_min, 0);
    const canPayWallet = balance >= total;

    basket.append(
      el('div', { class: 'row-between', style: { marginBottom: '9px' } },
        el('div', { class: 'up subtle' }, 'Your booking'),
        el('span', { class: 'badge' }, `${duration} min`)),
      el('div', { class: 'basket-line' },
        el('span', {}, `${sel.service.icon} ${sel.service.name}`),
        el('span', { class: 'mono' }, money(sel.service.price_pence))),
      ...chosen.map((a) => el('div', { class: 'basket-line muted' },
        el('span', {}, `${a.icon} ${a.name}`),
        el('span', { class: 'mono' }, money(a.price_pence)))),
      el('div', { class: 'basket-total' },
        el('span', {}, 'Total'),
        el('span', { class: 'mono' }, money(total))),
    );

    // Slot summary
    basket.append(el('div', { class: 'small muted', style: { marginTop: '9px' } },
      sel.time
        ? `📅 ${fmtDate(sel.date, { weekday: 'short', day: 'numeric', month: 'short' })} at ${sel.time}`
        : '📅 Pick a time to continue'));

    // Payment choice
    const payToggle = el('div', { class: 'row', style: { gap: '9px', marginTop: '12px' } },
      el('button', {
        class: `btn btn-sm ${sel.payWithWallet && canPayWallet ? 'btn-primary' : 'btn-ghost'}`,
        disabled: !canPayWallet,
        onclick: () => { sel.payWithWallet = true; paintBasket(); },
      }, `Pay from wallet (${money(balance)})`),
      el('button', {
        class: `btn btn-sm ${!sel.payWithWallet || !canPayWallet ? 'btn-primary' : 'btn-ghost'}`,
        onclick: () => { sel.payWithWallet = false; paintBasket(); },
      }, 'Pay in the chair'),
    );
    basket.append(payToggle);
    if (!canPayWallet) {
      basket.append(el('div', { class: 'tiny', style: { color: 'var(--warn)', marginTop: '6px' } },
        `Wallet has ${money(balance)} — ${money(total - balance)} short. Top up to save 10%+.`));
    }

    const confirmBtn = el('button', {
      class: 'btn btn-primary btn-lg btn-block',
      // Stable hook: the pay-method toggles above are also .btn-primary when
      // active, so tests and assistive tooling need something unambiguous.
      'data-action': 'confirm-booking',
      style: { marginTop: '12px' },
      disabled: !sel.time,
    }, sel.time ? `Confirm booking · ${money(total)}` : 'Choose a time');

    confirmBtn.addEventListener('click', async () => {
      // Resolve "anyone free" to a concrete barber before posting.
      let barberId = sel.barberId;
      if (!barberId) {
        try {
          const res = await api.slots(sel.date);
          const slot = res.slots.find((s) => s.time === sel.time);
          barberId = slot?.available_barbers?.[0]?.id;
        } catch { /* handled below */ }
      }
      if (!barberId) { toast('That slot just went — pick another time.', 'error'); loadSlots(); return; }

      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Booking…';
      try {
        const res = await api.book({
          customer_id: state.customerId,
          barber_id: barberId,
          service_id: sel.service.id,
          starts_at: `${sel.date} ${sel.time}:00`,
          addon_ids: [...sel.addonIds],
          pay_with_wallet: sel.payWithWallet && canPayWallet,
        });
        const a = res.appointment;
        toast(`Booked: ${a.service_name} with ${a.barber_nickname} on ${fmtDate(a.starts_at)} at ${fmtTime(a.starts_at)}.`, 'success');
        await state.refreshCustomers();
        render(host);
      } catch (e) {
        toast(e.message, 'error');
        confirmBtn.disabled = false;
        confirmBtn.textContent = `Confirm booking · ${money(total)}`;
      }
    });
    basket.append(confirmBtn);

    // Upsell nudge: show the single best add-on they have not selected.
    const nextBest = addons.find((a) => a.recommended && !sel.addonIds.has(a.id));
    if (nextBest) {
      basket.append(el('button', {
        class: 'btn btn-ghost btn-sm btn-block',
        style: { marginTop: '8px' },
        onclick: () => { sel.addonIds.add(nextBest.id); paintAddons(); paintBasket(); },
      }, `+ Add ${nextBest.name} (${money(nextBest.price_pence)})`));
    }
  }

  paintServices(); paintBarbers(); paintAddons(); paintDates(); paintBasket();
  await loadSlots();

  const section = (title, sub, ...body) => el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('div', {}, el('h3', {}, title), sub && el('div', { class: 'sub' }, sub))),
    ...body);

  const left = el('div', { class: 'stack' },
    section('1. Choose your cut', 'Prices include the wash and finish.', serviceGrid),
    section('2. Pick your barber', 'Or let us give you the first free chair.', barberGrid),
    section('3. Add anything else?',
      'Ordered by what you usually go for — tap to add or remove.', addonList),
    section('4. When suits you?', null,
      el('div', { class: 'stack-sm' }, dateStrip, slotWrap)),
  );

  const right = el('div', { style: { position: 'sticky', top: '78px' } }, basket);

  const layout = el('div', { class: 'grid', style: { gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,340px)' } },
    left, right);
  const applyCols = () => {
    layout.style.gridTemplateColumns = window.innerWidth < 980 ? 'minmax(0,1fr)' : 'minmax(0,1.6fr) minmax(0,340px)';
    right.style.position = window.innerWidth < 980 ? 'static' : 'sticky';
  };
  applyCols();
  window.addEventListener('resize', applyCols, { once: true });

  clear(host);
  host.append(layout);
}
