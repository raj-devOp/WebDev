/**
 * API client and shared app state.
 *
 * Errors surface the server's own message so the UI can show something useful
 * ("Wallet balance is £12.00 — £15.00 short") rather than a generic failure.
 */
const BASE = '/api';

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Cannot reach the server. Is it still running?');
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
  return json;
}

export const api = {
  bootstrap:      ()                 => request('GET', '/bootstrap'),
  health:         ()                 => request('GET', '/admin/health'),
  reseed:         ()                 => request('POST', '/admin/reseed'),

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

  get customer() {
    return this.customers.find((c) => c.id === this.customerId) || this.customers[0] || null;
  },

  async load() {
    const data = await api.bootstrap();
    this.shop = data.shop;
    this.plans = data.plans;
    this.customers = data.customers;

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
    this.customers = data.customers;
    this.shop = data.shop;
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
