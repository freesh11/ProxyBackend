/**
 * server.js — Backend for the Desktop Simulator
 *
 * Routes:
 *   POST /auth/register       — create account
 *   POST /auth/login          — sign in + return saved config
 *   POST /auth/save-config    — push desktop config to DB
 *   GET  /auth/load-config    — pull desktop config from DB
 *   POST /auth/delete         — delete account + config
 *
 *   POST /render-api/*        — proxy to api.render.com (CORS-safe)
 *
 * Environment variables (set in Render dashboard):
 *   DATABASE_URL   — PostgreSQL connection string
 *   PORT           — (optional, defaults to 3000)
 */

const express  = require('express');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Database ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required for Render-hosted Postgres
});

// Create tables on startup if they don't exist
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      username    TEXT PRIMARY KEY,
      hash        TEXT NOT NULL,
      config      JSONB,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✅ Database ready');
}

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));

// CORS — allow any origin (the app is a local HTML file)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function ok(res, data = {})  { res.json({ ok: true,  ...data }); }
function err(res, msg, status = 400) { res.status(status).json({ ok: false, error: msg }); }

// ── Auth routes ───────────────────────────────────────────────────────────────

// POST /auth/register
app.post('/auth/register', async (req, res) => {
  const { username, hash } = req.body || {};
  if (!username || !hash) return err(res, 'Username and password required.');
  if (username.length < 2 || username.length > 32) return err(res, 'Username must be 2–32 characters.');

  try {
    const existing = await pool.query('SELECT username FROM accounts WHERE username = $1', [username]);
    if (existing.rows.length > 0) return err(res, 'Username already taken.');

    await pool.query(
      'INSERT INTO accounts (username, hash) VALUES ($1, $2)',
      [username, hash]
    );
    ok(res, { username });
  } catch (e) {
    console.error('register error:', e.message);
    err(res, 'Server error during registration.', 500);
  }
});

// POST /auth/login
app.post('/auth/login', async (req, res) => {
  const { username, hash } = req.body || {};
  if (!username || !hash) return err(res, 'Username and password required.');

  try {
    const result = await pool.query(
      'SELECT username, hash, config FROM accounts WHERE username = $1',
      [username]
    );
    if (result.rows.length === 0) return err(res, 'Account not found.');
    const row = result.rows[0];
    if (row.hash !== hash) return err(res, 'Incorrect password.');

    ok(res, { username: row.username, config: row.config || null });
  } catch (e) {
    console.error('login error:', e.message);
    err(res, 'Server error during login.', 500);
  }
});

// POST /auth/save-config
app.post('/auth/save-config', async (req, res) => {
  const { username, hash, config } = req.body || {};
  if (!username || !hash) return err(res, 'Missing credentials.');

  try {
    const result = await pool.query(
      'SELECT hash FROM accounts WHERE username = $1',
      [username]
    );
    if (result.rows.length === 0) return err(res, 'Account not found.');
    if (result.rows[0].hash !== hash) return err(res, 'Incorrect password.');

    await pool.query(
      'UPDATE accounts SET config = $1, updated_at = NOW() WHERE username = $2',
      [config ? JSON.stringify(config) : null, username]
    );
    ok(res);
  } catch (e) {
    console.error('save-config error:', e.message);
    err(res, 'Server error saving config.', 500);
  }
});

// GET /auth/load-config
app.get('/auth/load-config', async (req, res) => {
  const { username, hash } = req.query || {};
  if (!username || !hash) return err(res, 'Missing credentials.');

  try {
    const result = await pool.query(
      'SELECT hash, config FROM accounts WHERE username = $1',
      [username]
    );
    if (result.rows.length === 0) return err(res, 'Account not found.');
    if (result.rows[0].hash !== hash) return err(res, 'Incorrect password.');

    ok(res, { config: result.rows[0].config || null });
  } catch (e) {
    console.error('load-config error:', e.message);
    err(res, 'Server error loading config.', 500);
  }
});

// POST /auth/delete
app.post('/auth/delete', async (req, res) => {
  const { username, hash } = req.body || {};
  if (!username || !hash) return err(res, 'Missing credentials.');

  try {
    const result = await pool.query(
      'SELECT hash FROM accounts WHERE username = $1',
      [username]
    );
    if (result.rows.length === 0) return err(res, 'Account not found.');
    if (result.rows[0].hash !== hash) return err(res, 'Incorrect password.');

    await pool.query('DELETE FROM accounts WHERE username = $1', [username]);
    ok(res);
  } catch (e) {
    console.error('delete error:', e.message);
    err(res, 'Server error deleting account.', 500);
  }
});

// ── Render API proxy ──────────────────────────────────────────────────────────
// Receives: { _renderKey, _targetMethod, ...body }
// Proxies to: https://api.render.com/v1/<path>
// Returns the Render API response with CORS headers already set above.

app.all('/render-api/*', async (req, res) => {
  // Support both GET (query params) and POST (body) for flexibility
  const params      = req.method === 'GET' ? req.query : req.body;
  const renderKey   = params._renderKey;
  const targetMethod = (params._targetMethod || req.method).toUpperCase();

  if (!renderKey) return err(res, 'Missing _renderKey', 401);

  // Strip our private fields before forwarding body
  const { _renderKey, _targetMethod, _svcId, _dbId, ...forwardBody } = params;

  // Build the Render API URL: everything after /render-api
  const subPath  = req.path.replace(/^\/render-api/, '');
  const queryStr = Object.keys(req.query).filter(k => !k.startsWith('_')).length > 0
    ? '?' + new URLSearchParams(Object.fromEntries(
        Object.entries(req.query).filter(([k]) => !k.startsWith('_'))
      ))
    : '';
  const url = `https://api.render.com/v1${subPath}${queryStr}`;

  console.log(`[render-api] ${targetMethod} ${url}`);

  try {
    const fetchOpts = {
      method:  targetMethod,
      headers: {
        'Authorization': `Bearer ${renderKey}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
      },
    };

    // Only send a body for non-GET requests that have actual payload
    if (targetMethod !== 'GET' && Object.keys(forwardBody).length > 0) {
      fetchOpts.body = JSON.stringify(forwardBody);
    }

    const r    = await fetch(url, fetchOpts);
    const text = await r.text();

    res.status(r.status)
       .set('Content-Type', 'application/json')
       .send(text || '{"ok":true}');
  } catch (e) {
    console.error('render-api proxy error:', e.message);
    err(res, 'Proxy error: ' + e.message, 502);
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'Desktop Simulator Backend', time: new Date().toISOString() });
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDB()
  .then(() => {
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  })
  .catch(e => {
    console.error('Failed to initialise DB:', e.message);
    process.exit(1);
  });
