/**
 * API client and shared app state.
 *
 * Two things differ from the Node build:
 *
 * 1. Transport detection. Pretty URLs (/api/wallet/12) need mod_rewrite. Most
 *    Hostinger plans have it, but if a rewrite is missing or the app is
 *    installed in a subfolder, the first call fails and we fall back to
 *    /api/index.php?route=wallet/12 for the rest of the session. The user never
 *    sees it, and nobody has to edit a config file to make the app work.
 *
 * 2. Owner login. The dashboard is behind a password once the app is on a
 *    public domain, so a 401 from a /dashboard call raises an auth prompt
 *    rather than an error toast.
 */

// Base path, so the app also works from a subfolder like /barberiq/.
const ROOT = (() => {
  const path = window.location.pathname;
  const dir = path.endsWith('/') ? path : path.slice(0, path.lastIndexOf('/') + 1);
  return dir === '' ? '/' : dir;
})();

let mode = localStorage.getItem('biq.apiMode') || 'pretty';

const buildUrl = (path) => {
  // path looks like "/wallet/12?x=1"
  const [route, query] = path.replace(/^\//, '').split('?');
  if (mode === 'pretty') {
    return `${ROOT}api/${route}${query ? `?${query}` : ''}`;
  }
  const qs = new URLSearchParams(query || '');
  qs.set('route', route);
  return `${ROOT}api/index.php?${qs.toString()}`;
};

/** Raised when the server wants an owner password. */
export class AuthRequiredError extends Error {
  constructor(message) {
    super(message || 'Owner password required.');
    this.name = 'AuthRequiredError';
    this.authRequired = true;
  }
}

async function attempt(method, path, body) {
  const res = await fetch(buildUrl(path), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin', // carries the owner session cookie
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON. Either the rewrite is missing (Apache served index.html) or PHP
    // printed a warning ahead of the response.
    return { ok: false, notJson: true, status: res.status, text };
  }
  return { ok: res.ok, status: res.status, json };
}

async function request(method, path, body) {
  let out;
  try {
    out = await attempt(method, path, body);
  } catch {
    throw new Error('Cannot reach the server. Check your internet connection.');
  }

  // One-time transport downgrade: if pretty URLs are not being rewritten,
  // switch to the query-string form and retry immediately.
  if (out.notJson && mode === 'pretty') {
    mode = 'query';
    localStorage.setItem('biq.apiMode', 'query');
    try {
      out = await attempt(method, path, body);
    } catch {
      throw new Error('Cannot reach the server.');
    }
  }

  if (out.notJson) {
    throw new Error(
      'The server did not return valid data. If you have just installed, open '
      + '/install/ to finish setup.'
    );
  }
  if (out.status === 401 && out.json?.auth_required) {
    throw new AuthRequiredError(out.json.error);
  }
  if (!out.ok) {
    throw new Error(out.json?.error || `Request failed (${out.status})`);
  }
  return out.json;
}

export const api = {
  bootstrap:      ()                 => request('GET', '/bootstrap'),
  health:         ()                 => request('GET', '/admin/health'),
  reseed:         ()                 => request('POST', '/admin/reseed'),

  session:        ()                 => request('GET', '/session'),
  login:          (password)         => request('POST', '/session/login', { password }),
  logout:         ()                 => request('POST', '/session/logout'),

  wallet:         (id)               => request('GET', `/wallet/${id}`),
  topup:          (id, payload)      => request('POST', `/wallet/${id}/topup`, payload),

  catalogue:      ()                 => request('GET', '/catalogue'),
  recommendAddons:(customerId, serviceId) =>
    request('GET', `/addons/recommend?customer_id=${customerId}&service_id=${serviceId ?? ''}`),
  slots:          (date)             => request('GET', `/slots?date=${date}`),
  book:           (payload)          => request('POST', '/bookings', payload),
  bookings:       (id)               => request('GET', `/bookings/${id}`),
  cancelBooking:  (id)               => request('POST', `/bookings/${id}/cancel`),
  completeBooking:(id)               => request('POST', `/bookings/${id}/complete`),

  reminders:      (id)               => request('GET', `/reminders/${id}`),
  reminderAction: (id, payload)      => request('POST', `/reminders/${id}/action`, payload),
  reminderPrefs:  (id, payload)      => request('PUT', `/reminders/${id}/preferences`, payload),
  rebuildReminders:()                => request('POST', '/reminders/rebuild'),

  referral:       (id)               => request('GET', `/referral/${id}`),
  invite:         (id, contact)      => request('POST', `/referral/${id}/invite`, { contact }),
  simulateSignup: (refId, name)      => request('POST', `/referral/${refId}/simulate-signup`, { name }),

  dashboard:      (range = 'today')  => request('GET', `/dashboard?range=${range}`),
  dashBarbers:    ()                 => request('GET', '/dashboard/barbers'),
  dashCustomers:  (limit = 20)       => request('GET', `/dashboard/customers?limit=${limit}`),
  dashWinback:    ()                 => request('GET', '/dashboard/winback'),
  dashAddons:     ()                 => request('GET', '/dashboard/addons'),
  dashInsights:   ()                 => request('GET', '/dashboard/insights'),
};

/**
 * App state. Deliberately tiny — this app has no need for a store library.
 * The active customer persists in localStorage so a refresh mid-demo does not
 * dump you back to a different persona.
 */
export const state = {
  shop: null,
  plans: [],
  customers: [],
  customerId: null,
  theme: 'dark',
  demoMode: true,
  isOwner: false,
  ownerGateEnabled: false,

  get customer() {
    return this.customers.find((c) => c.id === this.customerId) || this.customers[0] || null;
  },

  async load() {
    const data = await api.bootstrap();
    this.shop = data.shop;
    this.plans = data.plans;
    this.customers = data.customers || [];
    this.demoMode = !!data.demo_mode;
    this.isOwner = !!data.is_owner;
    this.ownerGateEnabled = !!data.owner_gate_enabled;

    const saved = Number(localStorage.getItem('biq.customerId'));
    this.customerId = this.customers.some((c) => c.id === saved)
      ? saved
      // Default to a customer with real history so every screen has content.
      : (this.customers.find((c) => c.visits >= 6) || this.customers[0])?.id;
    return data;
  },

  setCustomer(id) {
    this.customerId = Number(id);
    localStorage.setItem('biq.customerId', String(id));
  },

  async refreshCustomers() {
    const data = await api.bootstrap();
    this.customers = data.customers || [];
    this.shop = data.shop;
    this.isOwner = !!data.is_owner;
  },

  initTheme() {
    const saved = localStorage.getItem('biq.theme');
    this.theme = saved || 'dark';
    document.documentElement.dataset.theme = this.theme;
  },

  toggleTheme() {
    this.theme = this.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = this.theme;
    localStorage.setItem('biq.theme', this.theme);
  },
};
