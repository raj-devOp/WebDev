/**
 * View helpers: formatting, DOM building, toasts, modals and charts.
 *
 * Charts are hand-rolled SVG rather than a charting library. Three reasons:
 * no network dependency during a demo, no 300kB download, and total control
 * over how the numbers read.
 */

// ------------------------------------------------------------------ formatting
export const money = (pence, opts = {}) => {
  const n = (pence || 0) / 100;
  return new Intl.NumberFormat('en-GB', {
    style: 'currency', currency: 'GBP',
    minimumFractionDigits: opts.whole && Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: opts.whole ? 0 : 2,
  }).format(n);
};

/** Compact money for tight tiles: £1.2k, £14.5k */
export const moneyShort = (pence) => {
  const n = (pence || 0) / 100;
  if (Math.abs(n) >= 1000) return `£${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return `£${n.toFixed(0)}`;
};

export const pct = (v, digits = 0) =>
  v === null || v === undefined ? '—' : `${Number(v).toFixed(digits)}%`;

const parseDate = (s) => {
  if (!s) return null;
  if (s instanceof Date) return s;
  const str = String(s).replace(' ', 'T');
  return new Date(str.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(str) ? str : str + 'Z');
};

export const fmtDate = (s, opts = { day: 'numeric', month: 'short' }) => {
  const d = parseDate(s);
  return d ? d.toLocaleDateString('en-GB', opts) : '—';
};

export const fmtTime = (s) => {
  const d = parseDate(s);
  return d ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
};

export const fmtDateTime = (s) => {
  const d = parseDate(s);
  if (!d) return '—';
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} · ${fmtTime(s)}`;
};

/** "in 3 days" / "5 days ago" / "today" */
export const relDays = (s) => {
  const d = parseDate(s);
  if (!d) return '—';
  const days = Math.round((d - new Date()) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago`;
};

export const todayISO = () => new Date().toISOString().slice(0, 10);
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------------ DOM
/** Build an element from a tag, props and children. Keeps render code terse. */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    // Note: the number 0 is intentionally NOT skipped — some callers render a
    // legitimate zero ("0 days to go"). That means `someInt && el(...)` guards
    // must be written `!!someInt && el(...)`, or SQLite's 0/1 booleans leak a
    // stray "0" into the page.
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// --------------------------------------------------------------------- toast
let toastHost;
export function toast(message, kind = '') {
  if (!toastHost) {
    toastHost = el('div', { class: 'toast-host' });
    document.body.append(toastHost);
  }
  const icon = kind === 'success' ? '✓' : kind === 'error' ? '!' : '›';
  const node = el('div', { class: `toast ${kind}` }, el('span', { text: icon }), el('span', { text: message }));
  toastHost.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s, transform .25s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(8px)';
    setTimeout(() => node.remove(), 260);
  }, kind === 'error' ? 4600 : 3000);
}

// --------------------------------------------------------------------- modal
export function modal({ title, body, actions = [], onClose }) {
  const host = el('div', { class: 'modal-host' });
  const box = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' });

  const close = () => { host.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  host.addEventListener('click', (e) => { if (e.target === host) close(); });

  if (title) {
    box.append(el('div', { class: 'row-between', style: { marginBottom: '14px' } },
      el('h3', { text: title, style: { fontSize: '18px' } }),
      el('button', { class: 'btn btn-ghost btn-icon', 'aria-label': 'Close', onclick: close, text: '✕' })));
  }
  box.append(body instanceof Node ? body : el('div', { html: body || '' }));
  if (actions.length) {
    box.append(el('div', { class: 'row wrap', style: { marginTop: '20px', justifyContent: 'flex-end' } },
      ...actions.map((a) => el('button', {
        class: `btn ${a.class || 'btn-ghost'}`,
        onclick: () => { const r = a.onClick?.(); if (r !== false) close(); },
      }, a.label))));
  }
  host.append(box);
  document.body.append(host);
  box.querySelector('input,select,textarea,button')?.focus();
  return { close, box };
}

export function confirmDialog(title, message, confirmLabel = 'Confirm') {
  return new Promise((resolve) => {
    modal({
      title,
      body: el('p', { class: 'muted', text: message }),
      onClose: () => resolve(false),
      actions: [
        { label: 'Cancel', class: 'btn-ghost', onClick: () => resolve(false) },
        { label: confirmLabel, class: 'btn-primary', onClick: () => resolve(true) },
      ],
    });
  });
}

// ------------------------------------------------------------------ skeletons
export const skeletonCards = (n = 4) =>
  el('div', { class: 'grid g4' }, ...Array.from({ length: n }, () => el('div', { class: 'skel skel-card' })));

export const skeletonLines = (n = 5) =>
  el('div', {}, ...Array.from({ length: n }, (_, i) =>
    el('div', { class: 'skel skel-line', style: { width: `${100 - i * 9}%` } })));

export const empty = (icon, title, sub) =>
  el('div', { class: 'empty' },
    el('div', { class: 'empty-ico', text: icon }),
    el('div', { class: 'bold', text: title }),
    sub && el('div', { class: 'tiny subtle', style: { marginTop: '4px' } }, sub));

// --------------------------------------------------------------------- charts
const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) n.setAttribute(k, String(v));
  }
  return n;
}

let tipNode;
function showTip(text, x, y) {
  if (!tipNode) { tipNode = el('div', { class: 'chart-tip' }); document.body.append(tipNode); }
  tipNode.textContent = text;
  tipNode.style.opacity = '1';
  // Keep the tooltip inside the viewport.
  const w = tipNode.offsetWidth || 90;
  tipNode.style.left = `${Math.min(Math.max(8, x - w / 2), window.innerWidth - w - 8)}px`;
  tipNode.style.top = `${y - 40}px`;
}
const hideTip = () => { if (tipNode) tipNode.style.opacity = '0'; };

/**
 * Area + line revenue chart. Takes [{bucket, revenue_pence, cuts}].
 * Y axis starts at zero — truncating it to exaggerate a trend is exactly the
 * sort of thing that destroys trust when an owner checks it against reality.
 */
export function areaChart(data, { height = 190, valueKey = 'revenue_pence', labelFn } = {}) {
  const W = 760, H = height, padL = 46, padR = 10, padT = 14, padB = 26;
  const svg = svgEl('svg', {
    class: 'chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none',
    style: `height:${H}px`, role: 'img',
    'aria-label': `Revenue chart with ${data.length} points`,
  });
  if (!data.length) return svg;

  const vals = data.map((d) => d[valueKey] || 0);
  const max = Math.max(...vals, 1);
  // Pick a "nice" gridline step (1/2/5 × a power of ten) so labels land on
  // round money rather than £167 / £333, which reads as a rounding error.
  const GRIDS = 4;
  const rough = max / GRIDS;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(max / step) * step;

  const x = (i) => padL + (i * (W - padL - padR)) / Math.max(1, data.length - 1);
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);

  // Gridlines + y labels
  for (let v = 0; v <= top + 0.5; v += step) {
    const yy = y(v);
    svg.append(svgEl('line', {
      x1: padL, x2: W - padR, y1: yy, y2: yy,
      stroke: 'var(--border)', 'stroke-width': 1,
    }));
    const t = svgEl('text', {
      x: padL - 7, y: yy + 3.5, 'text-anchor': 'end',
      fill: 'var(--fg-subtle)', 'font-size': 10, 'font-family': 'var(--font-mono)',
    });
    t.textContent = moneyShort(v);
    svg.append(t);
  }

  const gradId = `grad-${Math.random().toString(36).slice(2, 8)}`;
  const defs = svgEl('defs');
  const lg = svgEl('linearGradient', { id: gradId, x1: 0, y1: 0, x2: 0, y2: 1 });
  lg.append(svgEl('stop', { offset: '0%', 'stop-color': 'var(--brass)', 'stop-opacity': 0.34 }));
  lg.append(svgEl('stop', { offset: '100%', 'stop-color': 'var(--brass)', 'stop-opacity': 0.02 }));
  defs.append(lg); svg.append(defs);

  const linePts = data.map((d, i) => `${x(i)},${y(d[valueKey] || 0)}`);
  svg.append(svgEl('path', {
    d: `M ${padL},${y(0)} L ${linePts.join(' L ')} L ${x(data.length - 1)},${y(0)} Z`,
    fill: `url(#${gradId})`, stroke: 'none',
  }));
  svg.append(svgEl('polyline', {
    points: linePts.join(' '), fill: 'none',
    stroke: 'var(--brass)', 'stroke-width': 2,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }));

  // Hover targets
  data.forEach((d, i) => {
    const dot = svgEl('circle', {
      cx: x(i), cy: y(d[valueKey] || 0), r: 3.2,
      fill: 'var(--bg)', stroke: 'var(--brass)', 'stroke-width': 1.8,
      opacity: data.length > 34 ? 0 : 1,
    });
    const hit = svgEl('rect', {
      x: x(i) - (W - padL - padR) / Math.max(1, data.length - 1) / 2,
      y: padT, width: (W - padL - padR) / Math.max(1, data.length - 1) || 12,
      height: H - padT - padB, fill: 'transparent', style: 'cursor:pointer',
    });
    hit.addEventListener('pointerenter', (e) => {
      dot.setAttribute('opacity', '1'); dot.setAttribute('r', '4.6');
      const label = labelFn ? labelFn(d) : `${fmtDate(d.bucket)} · ${money(d[valueKey])} · ${d.cuts} cuts`;
      const r = e.target.getBoundingClientRect();
      showTip(label, r.left + r.width / 2, r.top);
    });
    hit.addEventListener('pointerleave', () => {
      dot.setAttribute('opacity', data.length > 34 ? '0' : '1'); dot.setAttribute('r', '3.2');
      hideTip();
    });
    svg.append(dot, hit);
  });

  // X labels — thinned so they never collide.
  const every = Math.ceil(data.length / 7);
  data.forEach((d, i) => {
    if (i % every !== 0 && i !== data.length - 1) return;
    const t = svgEl('text', {
      x: x(i), y: H - 8, 'text-anchor': 'middle',
      fill: 'var(--fg-subtle)', 'font-size': 10,
    });
    t.textContent = String(d.bucket).includes('W')
      ? String(d.bucket).split('-')[1] : fmtDate(d.bucket);
    svg.append(t);
  });

  return svg;
}

/** Vertical bar chart, used for the by-hour breakdown. */
export function barChart(data, { height = 150, valueKey = 'cuts', labelKey = 'hour', labelFn } = {}) {
  const W = 760, H = height, padL = 34, padR = 8, padT = 12, padB = 24;
  const svg = svgEl('svg', {
    class: 'chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none',
    style: `height:${H}px`, role: 'img', 'aria-label': 'Bookings by hour',
  });
  if (!data.length) return svg;

  const max = Math.max(...data.map((d) => d[valueKey] || 0), 1);
  const bw = (W - padL - padR) / data.length;
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);

  const quietest = Math.min(...data.map((d) => d[valueKey] || 0));

  data.forEach((d, i) => {
    const v = d[valueKey] || 0;
    const isQuiet = v === quietest;
    const bar = svgEl('rect', {
      x: padL + i * bw + bw * 0.16, y: y(v),
      width: bw * 0.68, height: Math.max(1, H - padB - y(v)),
      rx: 3.5,
      // The quietest hour is called out — it is the actionable one.
      fill: isQuiet ? 'var(--warn)' : 'var(--brass)',
      opacity: isQuiet ? 0.95 : 0.78, style: 'cursor:pointer',
    });
    bar.addEventListener('pointerenter', (e) => {
      bar.setAttribute('opacity', '1');
      const r = e.target.getBoundingClientRect();
      showTip(labelFn ? labelFn(d) : `${d[labelKey]}:00 · ${v} cuts`, r.left + r.width / 2, r.top);
    });
    bar.addEventListener('pointerleave', () => { bar.setAttribute('opacity', isQuiet ? '0.95' : '0.78'); hideTip(); });
    svg.append(bar);

    if (i % 2 === 0) {
      const t = svgEl('text', {
        x: padL + i * bw + bw / 2, y: H - 7, 'text-anchor': 'middle',
        fill: 'var(--fg-subtle)', 'font-size': 10, 'font-family': 'var(--font-mono)',
      });
      t.textContent = d[labelKey];
      svg.append(t);
    }
  });

  const zero = svgEl('line', { x1: padL, x2: W - padR, y1: H - padB, y2: H - padB, stroke: 'var(--border)' });
  svg.append(zero);
  return svg;
}

/** Donut, used for the booking-source mix. */
export function donut(segments, { size = 132, thickness = 17 } = {}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const svg = svgEl('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img' });
  const g = svgEl('g', { transform: `rotate(-90 ${size / 2} ${size / 2})` });
  let offset = 0;
  segments.forEach((s) => {
    const len = (s.value / total) * c;
    const arc = svgEl('circle', {
      cx: size / 2, cy: size / 2, r,
      fill: 'none', stroke: s.color, 'stroke-width': thickness,
      'stroke-dasharray': `${len} ${c - len}`,
      'stroke-dashoffset': -offset, 'stroke-linecap': 'butt',
    });
    // Note: Element.append() returns undefined, so the <title> must be built
    // and populated before appending — chaining off append() throws.
    const title = svgEl('title');
    title.textContent = `${s.label}: ${s.value}`;
    arc.append(title);
    g.append(arc);
    offset += len;
  });
  svg.append(g);
  return svg;
}

/** Progress ring for the reminder cycle countdown. */
export function ring(fraction, { size = 128, thickness = 10, color = 'var(--brass)' } = {}) {
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, fraction));
  const svg = svgEl('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}` });
  svg.append(svgEl('circle', {
    cx: size / 2, cy: size / 2, r, fill: 'none',
    stroke: 'var(--surface-3)', 'stroke-width': thickness,
  }));
  svg.append(svgEl('circle', {
    cx: size / 2, cy: size / 2, r, fill: 'none',
    stroke: color, 'stroke-width': thickness, 'stroke-linecap': 'round',
    'stroke-dasharray': `${c * f} ${c}`,
  }));
  return svg;
}

/** Trend arrow with sign-aware colour. */
export function trendPill(pctChange, { invert = false } = {}) {
  if (pctChange === null || pctChange === undefined) {
    return el('span', { class: 'trend subtle' }, '—');
  }
  const up = pctChange >= 0;
  const good = invert ? !up : up;
  return el('span', { class: `trend ${good ? 'pos' : 'neg'}` },
    up ? '▲' : '▼', `${Math.abs(pctChange).toFixed(1)}%`);
}

export const riskBadge = (band, label) => {
  const map = {
    healthy: 'badge-success', due: 'badge-info', overdue: 'badge-warn',
    at_risk: 'badge-danger', lost: 'badge-danger', never_visited: 'badge',
  };
  return el('span', { class: `badge ${map[band] || 'badge'} badge-dot` }, label || band);
};
