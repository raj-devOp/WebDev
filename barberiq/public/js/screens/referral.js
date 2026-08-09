/**
 * D. REFERRAL
 *
 * £10 for the friend, £10 for the referrer. The important design decision is
 * visible right on the screen: the referrer's £10 unlocks only after the
 * friend has actually sat in the chair. Stating that plainly does two things —
 * it stops the owner being drained by fake sign-ups, and it sets the
 * customer's expectation so the "where's my tenner" complaint never happens.
 */
import { api, state } from '../api.js';
import {
  el, clear, money, toast, modal, skeletonLines, empty,
  fmtDate, relDays,
} from '../ui.js';

const STATUS = {
  sent:      ['badge-info', 'Invite sent', '📤'],
  signed_up: ['badge-warn', 'Signed up — awaiting first visit', '🧍'],
  qualified: ['badge-brass', 'Qualified', '✅'],
  rewarded:  ['badge-success', 'Paid out', '💸'],
  expired:   ['badge', 'Expired', '⌛'],
  blocked:   ['badge-danger', 'Blocked', '⛔'],
};

export async function render(host) {
  clear(host);
  host.append(skeletonLines(6));

  let data;
  try {
    data = await api.referral(state.customerId);
  } catch (e) {
    clear(host);
    host.append(empty('⚠️', 'Could not load the referral programme', e.message));
    return;
  }

  const { code, share_url, reward_pence, referrals, stats, leaderboard, terms } = data;
  clear(host);

  // -------------------------------------------------------------- hero card
  const hero = el('div', { class: 'wallet-hero' },
    el('div', { class: 'up subtle' }, 'Refer a friend'),
    el('h2', { style: { fontSize: 'clamp(24px,4.2vw,34px)', margin: '6px 0 4px' } },
      `Give ${money(reward_pence, { whole: true })}, get ${money(reward_pence, { whole: true })}`),
    el('p', { class: 'muted', style: { maxWidth: '52ch' } },
      'Send your code to anyone who has not been in before. They get £10 off their '
      + 'first cut, and £10 lands in your wallet the moment they have had it.'),
    el('div', { class: 'code-box', style: { marginTop: '18px' } },
      el('div', { style: { minWidth: 0 } },
        el('div', { class: 'tiny subtle' }, 'Your code'),
        el('div', { class: 'code-value' }, code)),
      el('div', { class: 'spacer' }),
      el('button', {
        class: 'btn btn-ghost btn-sm',
        onclick: () => copy(code, 'Code copied.'),
      }, '📋 Copy'),
    ),
    el('div', { class: 'row wrap', style: { gap: '9px', marginTop: '13px' } },
      el('button', { class: 'btn btn-primary', onclick: openInvite }, '✉️ Invite someone'),
      el('button', { class: 'btn btn-ghost', onclick: () => copy(share_url, 'Link copied.') },
        '🔗 Copy link'),
      el('button', { class: 'btn btn-ghost', onclick: shareNative }, '📱 Share'),
    ),
  );

  async function copy(text, msg) {
    try {
      await navigator.clipboard.writeText(text);
      toast(msg, 'success');
    } catch {
      // Clipboard API needs a secure context; show the value so it can be
      // copied by hand rather than failing silently.
      modal({ title: 'Copy this', body: el('div', { class: 'code-box' }, el('code', { class: 'mono' }, text)) });
    }
  }

  async function shareNative() {
    const payload = {
      title: state.shop?.name || 'BarberIQ',
      text: `Get £10 off your first cut at ${state.shop?.name} with my code ${code}.`,
      url: share_url,
    };
    if (navigator.share) {
      try { await navigator.share(payload); return; } catch { /* cancelled */ }
    }
    copy(`${payload.text} ${payload.url}`, 'Message copied — paste it anywhere.');
  }

  // ------------------------------------------------------------ stat strip
  const statStrip = el('div', { class: 'grid g4' },
    tile('Earned so far', money(stats.earned_pence), `${stats.rewarded} friends came in`, true),
    tile('Invites sent', String(stats.total), 'across all time'),
    tile('Waiting on first visit', String(stats.pending), 'not yet paid out'),
    tile('Your rank', `#${stats.rank}`, 'among all customers'),
  );

  function tile(label, value, foot, featured) {
    return el('div', { class: `stat${featured ? ' featured' : ''}` },
      featured && el('span', { class: 'stat-accent' }),
      el('span', { class: 'stat-label' }, label),
      el('span', { class: 'stat-value' }, value),
      el('span', { class: 'stat-foot' }, foot));
  }

  // ------------------------------------------------------------ invite flow
  function openInvite() {
    const input = el('input', {
      class: 'input', placeholder: '07700 900123 or friend@email.com', autocomplete: 'off',
    });
    modal({
      title: 'Invite a friend',
      body: el('div', { class: 'stack' },
        el('div', { class: 'field' },
          el('label', {}, 'Their mobile or email'), input),
        el('div', { class: 'small muted' },
          `We will send them your code ${code}. They get ${money(reward_pence)} off their first `
          + `visit; you get ${money(reward_pence)} once they have been in.`),
      ),
      actions: [
        { label: 'Cancel', class: 'btn-ghost' },
        {
          label: 'Send invite', class: 'btn-primary',
          onClick: async () => {
            const contact = input.value.trim();
            if (contact.length < 5) { toast('Enter a mobile number or email.', 'error'); return false; }
            try {
              const res = await api.invite(state.customerId, contact);
              toast(res.message, 'success');
              render(host);
            } catch (e) { toast(e.message, 'error'); return false; }
          },
        },
      ],
    });
  }

  // -------------------------------------------------------- how it works
  const howCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('div', {}, el('h3', {}, 'How it works'))),
    el('div', { class: 'stack' },
      ...[
        ['1', 'Share your code', 'Send it by text, WhatsApp, or just say it out loud in the shop.'],
        ['2', 'They book their first cut', `Your code takes ${money(reward_pence)} off automatically.`],
        ['3', 'They sit in the chair', 'This is the bit that counts — the reward is tied to a real visit.'],
        ['4', 'You both get paid', `${money(reward_pence)} lands in each wallet. Nothing to claim.`],
      ].map(([n, title, sub]) => el('div', { class: 'funnel-step' },
        el('div', { class: 'funnel-num' }, n),
        el('div', { style: { minWidth: 0 } },
          el('div', { class: 'bold small' }, title),
          el('div', { class: 'tiny subtle' }, sub)))),
    ),
    el('div', { class: 'divider' }),
    el('div', { class: 'up subtle', style: { marginBottom: '7px' } }, 'The rules'),
    el('ul', { class: 'feature-list' },
      ...terms.map((t) => el('li', {}, el('span', { class: 'tick' }, '•'), el('span', { class: 'muted' }, t)))),
  );

  // ------------------------------------------------------------ my invites
  const list = el('div', { class: 'stack-sm' });
  if (!referrals.length) {
    list.append(empty('🤝', 'No invites yet', 'Send your first one and start earning.'));
  } else {
    for (const r of referrals) {
      const [cls, label, icon] = STATUS[r.status] || ['badge', r.status, '•'];
      const row = el('div', { class: 'card', style: { padding: '13px 15px' } },
        el('div', { class: 'row-between wrap', style: { gap: '9px' } },
          el('div', { class: 'row', style: { gap: '10px', minWidth: 0 } },
            el('div', { class: 'avatar' }, r.referred_emoji || icon),
            el('div', { style: { minWidth: 0 } },
              el('div', { class: 'bold small truncate' },
                r.referred_name || r.invited_contact || 'Invitation'),
              el('div', { class: 'tiny subtle' },
                `Sent ${fmtDate(r.created_at)} · ${relDays(r.created_at)}`))),
          el('div', { class: 'row', style: { gap: '9px' } },
            el('span', { class: `badge ${cls}` }, label),
            r.status === 'rewarded'
              ? el('span', { class: 'mono bold pos' }, `+${money(r.reward_pence)}`)
              : el('span', { class: 'mono subtle' }, money(r.reward_pence))),
        ),
      );

      // Demo affordance: walk an invite through sign-up so a client can watch
      // the two-sided payout happen live.
      if (r.status === 'sent') {
        row.append(el('div', { class: 'row wrap', style: { gap: '7px', marginTop: '10px' } },
          el('button', {
            class: 'btn btn-outline btn-sm',
            onclick: async () => {
              try {
                const res = await api.simulateSignup(r.id, 'Invited Friend');
                toast(res.message, 'success');
                await state.refreshCustomers();
                render(host);
              } catch (e) { toast(e.message, 'error'); }
            },
          }, '▶︎ Simulate them signing up'),
          el('span', { class: 'tiny subtle' }, 'demo control')));
      }
      if (r.status === 'signed_up') {
        row.append(el('div', {
          class: 'small', style: {
            marginTop: '10px', padding: '10px 12px', borderRadius: '9px',
            background: 'var(--warn-soft)', color: 'var(--warn)',
          },
        }, `⏳ Waiting on their first completed visit. This is the fraud guard — `
          + `credit is never paid on a sign-up alone.`));
      }
      list.append(row);
    }
  }

  const listCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', {},
        el('h3', {}, 'Your invitations'),
        el('div', { class: 'sub' }, 'Track every invite from sent to paid.')),
      el('div', { class: 'card-head-actions' },
        el('button', { class: 'btn btn-primary btn-sm', onclick: openInvite }, '+ Invite'))),
    list,
  );

  // ----------------------------------------------------------- leaderboard
  const lb = el('div', {});
  if (!leaderboard.length) {
    lb.append(empty('🏆', 'Nobody on the board yet', 'Be the first.'));
  } else {
    leaderboard.forEach((c, i) => {
      const isMe = c.id === state.customerId;
      lb.append(el('div', { class: `lb-row${isMe ? ' me' : ''}` },
        el('div', { class: 'lb-rank' }, i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`),
        el('div', { class: 'avatar' }, c.avatar_emoji),
        el('div', { style: { minWidth: 0 } },
          el('div', { class: 'bold small truncate' }, isMe ? `${c.name} (you)` : c.name),
          el('div', { class: 'tiny subtle' }, `${c.rewarded} referred`)),
        el('div', { class: 'spacer' }),
        el('div', { class: 'mono bold pos' }, money(c.earned_pence))));
    });
  }

  const lbCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', {},
        el('h3', {}, 'Top referrers'),
        el('div', { class: 'sub' }, 'This month across the whole shop.'))),
    lb,
  );

  const layout = el('div', { class: 'grid', style: { gridTemplateColumns: 'minmax(0,1.25fr) minmax(0,1fr)' } },
    el('div', { class: 'stack' }, listCard),
    el('div', { class: 'stack' }, howCard, lbCard),
  );
  const applyCols = () => {
    layout.style.gridTemplateColumns = window.innerWidth < 960 ? 'minmax(0,1fr)' : 'minmax(0,1.25fr) minmax(0,1fr)';
  };
  applyCols();
  window.addEventListener('resize', applyCols, { once: true });

  host.append(el('div', { class: 'stack-lg' }, hero, statStrip, layout));
}
