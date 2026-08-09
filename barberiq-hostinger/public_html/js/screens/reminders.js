/**
 * B. REMINDERS
 *
 * The brief asked for an automatic nudge after 25-30 days. This screen shows
 * the learned version of that: the customer's own measured cycle, when the
 * nudge will fire, and — crucially — WHY. Showing the reasoning is what turns
 * "the app is pestering me" into "the app knows me".
 */
import { api, state } from '../api.js';
import {
  el, clear, money, toast, ring, skeletonLines, empty, riskBadge,
  fmtDate, fmtDateTime, relDays, confirmDialog,
} from '../ui.js';

const STATUS_BADGE = {
  scheduled: ['badge-info', 'Scheduled'],
  sent: ['badge-brass', 'Sent'],
  opened: ['badge-brass', 'Opened'],
  booked: ['badge-success', 'Booked'],
  snoozed: ['badge', 'Snoozed'],
  dismissed: ['badge', 'Dismissed'],
  failed: ['badge-danger', 'Failed'],
};

export async function render(host) {
  clear(host);
  host.append(skeletonLines(6));

  let data;
  try {
    data = await api.reminders(state.customerId);
  } catch (e) {
    // An auth error is not a load failure — let app.js show the
    // owner login prompt rather than a dead end here.
    if (e?.authRequired) throw e;
    clear(host);
    host.append(empty('⚠️', 'Could not load reminders', e.message));
    return;
  }

  const { cycle, risk, reminders, upcoming, history, preferences } = data;
  clear(host);

  // ------------------------------------------------------------ cycle ring
  const daysSince = risk.daysSince ?? 0;
  const fraction = cycle.cycleDays ? Math.min(1.25, daysSince / cycle.cycleDays) : 0;
  const daysLeft = cycle.cycleDays - daysSince;
  const ringColour = fraction >= 1 ? 'var(--danger)' : fraction >= 0.75 ? 'var(--warn)' : 'var(--brass)';

  const ringCard = el('div', { class: 'card card-pad-lg' },
    el('div', { class: 'row wrap', style: { gap: '26px', alignItems: 'center' } },
      el('div', { class: 'cycle-ring' },
        ring(fraction, { size: 138, thickness: 11, color: ringColour }),
        el('div', { class: 'cycle-ring-label' },
          el('div', { class: 'cycle-ring-days', style: { color: ringColour } },
            daysLeft > 0 ? daysLeft : Math.abs(daysLeft)),
          el('div', { class: 'tiny subtle' }, daysLeft > 0 ? 'days to go' : 'days overdue')),
      ),
      el('div', { style: { flex: '1 1 260px', minWidth: 0 } },
        el('div', { class: 'row', style: { gap: '8px', marginBottom: '6px' } },
          el('h3', {}, 'Your haircut rhythm'),
          riskBadge(risk.band, risk.label)),
        el('div', { class: 'muted small' }, cycle.basis),
        el('div', { class: 'divider' }),
        el('div', { class: 'grid g3', style: { gap: '12px' } },
          stat('Your cycle', `${cycle.cycleDays} days`),
          stat('Last visit', cycle.lastVisit ? fmtDate(cycle.lastVisit) : '—',
            cycle.lastVisit ? relDays(cycle.lastVisit) : null),
          stat('Confidence', `${Math.round(cycle.confidence * 100)}%`,
            `${cycle.sampleSize} visits analysed`),
        ),
      ),
    ),
  );

  function stat(label, value, foot) {
    return el('div', {},
      el('div', { class: 'up subtle' }, label),
      el('div', { class: 'mono bold', style: { fontSize: '17px' } }, value),
      foot && el('div', { class: 'tiny subtle' }, foot));
  }

  // -------------------------------------------------- how the AI decided
  const explainCard = el('div', { class: 'card', style: { background: 'var(--surface-2)' } },
    el('div', { class: 'row', style: { alignItems: 'flex-start', gap: '12px' } },
      el('div', { style: { fontSize: '20px' } }, '🧠'),
      el('div', {},
        el('div', { class: 'bold small' }, 'Why this date, not a fixed 30 days'),
        el('div', { class: 'small muted', style: { marginTop: '3px' } },
          `We measured the gap between each of your visits, weighted the recent ones more `
          + `heavily, and landed on ${cycle.cycleDays} days`
          + `${cycle.variability !== null ? ` (give or take ${cycle.variability} days)` : ''}. `
          + `The nudge fires a couple of days early so there are still good slots left.`)),
    ),
  );

  // ----------------------------------------------------- upcoming booking
  let upcomingCard;
  if (upcoming.length) {
    upcomingCard = el('div', { class: 'card', style: { borderColor: 'var(--success)' } },
      el('div', { class: 'card-head' },
        el('div', {},
          el('h3', {}, '✓ You are booked in'),
          el('div', { class: 'sub' }, 'Reminders pause while you have an appointment ahead.'))),
      ...upcoming.map((a) => el('div', { class: 'row', style: { gap: '12px', padding: '8px 0' } },
        el('div', { class: 'avatar avatar-lg' }, a.service_icon),
        el('div', { style: { minWidth: 0 } },
          el('div', { class: 'bold' }, a.service_name),
          el('div', { class: 'tiny subtle' },
            `${fmtDateTime(a.starts_at)} · with ${a.barber_name} ${a.barber_emoji}`)),
        el('div', { class: 'spacer' }),
        el('div', { class: 'col', style: { alignItems: 'flex-end' } },
          el('div', { class: 'mono bold' }, money(a.total_pence)),
          el('div', { class: 'badge badge-success', style: { marginTop: '3px' } }, relDays(a.starts_at))),
      )),
    );
  }

  // ------------------------------------------------------- reminder queue
  const queue = el('div', { class: 'stack-sm' });
  const active = reminders.filter((r) => r.status !== 'dismissed');
  if (!active.length) {
    queue.append(empty('🔔', 'No reminders queued',
      upcoming.length
        ? 'You already have a booking, so nothing is scheduled.'
        : 'A reminder appears once you have visit history to learn from.'));
  } else {
    for (const r of active) {
      const [cls, label] = STATUS_BADGE[r.status] || ['badge', r.status];
      const isNext = r.status === 'scheduled';

      const actions = el('div', { class: 'row wrap', style: { gap: '7px', marginTop: '10px' } });
      if (isNext || r.status === 'sent' || r.status === 'snoozed') {
        actions.append(
          el('button', {
            class: 'btn btn-primary btn-sm',
            onclick: () => { location.hash = '#/book'; },
          }, 'Book now'),
          el('button', {
            class: 'btn btn-ghost btn-sm',
            onclick: async () => {
              try {
                await api.reminderAction(r.id, { action: 'snooze', days: 7 });
                toast('Snoozed for a week.', 'success');
                render(host);
              } catch (e) { toast(e.message, 'error'); }
            },
          }, 'Snooze 7 days'),
          el('button', {
            class: 'btn btn-outline btn-sm',
            onclick: async () => {
              if (!(await confirmDialog('Turn off this reminder?',
                'You will not be nudged for this cycle. You can still book any time.',
                'Turn it off'))) return;
              try {
                await api.reminderAction(r.id, { action: 'dismiss' });
                toast('Reminder dismissed.');
                render(host);
              } catch (e) { toast(e.message, 'error'); }
            },
          }, 'No thanks'),
        );
      }

      queue.append(el('div', {
        class: 'card',
        style: isNext ? { borderColor: 'var(--brass-ring)' } : {},
      },
        el('div', { class: 'row-between wrap', style: { gap: '10px' } },
          el('div', { class: 'row', style: { gap: '9px' } },
            el('span', {}, r.channel === 'sms' ? '💬' : r.channel === 'push' ? '📱' : '✉️'),
            el('span', { class: 'bold small' }, `Due ${fmtDate(r.due_date)}`),
            el('span', { class: `badge ${cls}` }, label)),
          el('span', { class: 'tiny subtle' }, `nudge ${relDays(r.send_on)} by ${r.channel.toUpperCase()}`)),
        el('div', {
          class: 'small',
          style: {
            marginTop: '10px', padding: '11px 13px', borderRadius: '10px',
            background: 'var(--surface-2)', borderLeft: '3px solid var(--brass)',
          },
        }, `“${r.message}”`),
        r.confidence !== null && el('div', { class: 'tiny subtle', style: { marginTop: '7px' } },
          `Predicted cycle ${r.predicted_cycle_days} days · confidence ${Math.round((r.confidence || 0) * 100)}%`),
        actions.children.length ? actions : null,
      ));
    }
  }

  const queueCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', {},
        el('h3', {}, 'Your reminders'),
        el('div', { class: 'sub' }, 'Automatic, timed to you, and easy to switch off.'))),
    queue,
  );

  // ----------------------------------------------------------- preferences
  const prefRow = (key, icon, title, sub, checked) => {
    const input = el('input', { type: 'checkbox', ...(checked ? { checked: 'checked' } : {}) });
    input.addEventListener('change', async () => {
      const next = {
        sms: key === 'sms' ? input.checked : preferences.sms,
        email: key === 'email' ? input.checked : preferences.email,
        push: key === 'push' ? input.checked : preferences.push,
      };
      try {
        await api.reminderPrefs(state.customerId, next);
        Object.assign(preferences, next);
        toast('Preferences saved.', 'success');
      } catch (e) { toast(e.message, 'error'); input.checked = !input.checked; }
    });
    return el('div', { class: 'row', style: { gap: '12px', padding: '9px 0' } },
      el('span', { style: { fontSize: '18px' } }, icon),
      el('div', { style: { minWidth: 0 } },
        el('div', { class: 'bold small' }, title),
        el('div', { class: 'tiny subtle' }, sub)),
      el('div', { class: 'spacer' }),
      el('label', { class: 'switch' }, input, el('span', { class: 'switch-track' })));
  };

  const prefCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', {},
        el('h3', {}, 'How we contact you'),
        el('div', { class: 'sub' }, 'One reminder per cycle. Never more than that.'))),
    prefRow('sms', '💬', 'Text message', 'Highest open rate — arrives on the day.', preferences.sms),
    prefRow('push', '📱', 'App notification', 'Free to send, tap straight through to booking.', preferences.push),
    prefRow('email', '✉️', 'Email', 'Good for the offer, slower to act on.', preferences.email),
  );

  // --------------------------------------------------------- visit history
  const histCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', {},
        el('h3', {}, 'Visit history'),
        el('div', { class: 'sub' }, 'The data the prediction is built from.'))),
    history.length
      ? el('div', { class: 'timeline' },
        ...history.map((h, i) => el('div', { class: `timeline-item ${i === 0 ? 'next' : 'done'}` },
          el('div', { class: 'row-between' },
            el('div', {},
              el('span', {}, `${h.service_icon} `),
              el('span', { class: 'bold small' }, h.service_name),
              el('span', { class: 'tiny subtle' }, ` · ${h.barber_name}`)),
            el('span', { class: 'mono small' }, money(h.total_pence))),
          el('div', { class: 'tiny subtle' }, `${fmtDate(h.starts_at, { day: 'numeric', month: 'short', year: 'numeric' })} · ${relDays(h.starts_at)}`),
        )))
      : empty('📋', 'No visits yet', 'History builds after the first appointment.'),
  );

  const layout = el('div', { class: 'grid', style: { gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,1fr)' } },
    el('div', { class: 'stack' }, queueCard),
    el('div', { class: 'stack' }, prefCard, histCard),
  );
  const applyCols = () => {
    layout.style.gridTemplateColumns = window.innerWidth < 960 ? 'minmax(0,1fr)' : 'minmax(0,1.2fr) minmax(0,1fr)';
  };
  applyCols();
  window.addEventListener('resize', applyCols, { once: true });

  host.append(el('div', { class: 'stack-lg' },
    ringCard, explainCard, upcomingCard, layout));
}
