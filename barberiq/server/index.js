/**
 * BarberIQ server entrypoint.
 *
 * Serves the API under /api and the single-page client from /public.
 */
const express = require('express');
const path = require('path');
const { init, DB_PATH } = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// Request log — quiet enough to leave on during a live demo.
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api')) {
      console.log(`  ${req.method} ${req.path} → ${res.statusCode} (${Date.now() - t}ms)`);
    }
  });
  next();
});

app.use('/api', require('./routes'));

app.use(express.static(path.join(__dirname, '..', 'public'), {
  extensions: ['html'],
  setHeaders(res, filePath) {
    // The client is served from disk during demos; never let a stale bundle
    // survive a refresh in front of a client.
    if (/\.(?:js|css|html)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// SPA fallback for client-side routes.
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// JSON error handler so the client never has to parse an HTML error page.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

const { seeded } = init();

const dash = '─'.repeat(58);
console.log(`\n┌${dash}┐`);
console.log(`  💈  BarberIQ — Intelligent Barbershop OS`);
console.log(`└${dash}┘`);
console.log(`  Database : ${DB_PATH}`);
console.log(`  Seeded   : ${seeded ? 'yes (fresh demo data generated)' : 'no (existing data kept)'}`);

app.listen(PORT, HOST, () => {
  console.log(`  Ready    : http://localhost:${PORT}\n`);
  console.log(`  Customer app  →  http://localhost:${PORT}/#/wallet`);
  console.log(`  Owner console →  http://localhost:${PORT}/#/dashboard`);
  console.log(`  Sales pitch   →  http://localhost:${PORT}/#/pricing\n`);
});
