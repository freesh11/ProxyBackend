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
 *   POST /admin/*             — admin panel routes (password protected)
 *
 * Environment variables (optional — fallbacks are hardcoded below):
 *   DATABASE_URL              — PostgreSQL connection string
 *   PORT                      — defaults to 10000
 */

const express  = require('express');
const { Pool } = require('pg');
const https    = require('https');
const http     = require('http');

const app  = express();
const PORT = process.env.PORT || 10000;

// ── Database ──────────────────────────────────────────────────────────────────
// Use the EXTERNAL hostname — .internal only works if services are linked in Render
const DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://server_login_mgr_user:TrqUTHQt5H29h5oHlDglqGKuUGRTokNA@dpg-d7knlipj2pic73cbng30-a.oregon-postgres.render.com/server_login_mgr';

console.log('🔌 Connecting to DB:', DATABASE_URL.replace(/:\/\/[^@]+@/, '://***@'));

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // always use SSL with external Render Postgres
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 30000,
  max: 5,
});

// ── Simple fetch wrapper using built-in https/http modules ────────────────────
// Avoids any dependency on axios or node-fetch — works on all Node versions
function nodeFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   opts.method || 'GET',
      headers:  opts.headers || {},
    };
    const req = lib.request(reqOpts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, text: () => Promise.resolve(data) }));
    });
    req.on('error', reject);
    if(opts.body) req.write(opts.body);
    req.end();
  });
}

// Create tables on startup if they don't exist
async function initDB() {
  // Test the connection first so we get a clear error if it fails
  const client = await pool.connect();
  try{
    await client.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        username    TEXT PRIMARY KEY,
        hash        TEXT NOT NULL,
        config      JSONB,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('✅ Database ready');
  } finally {
    client.release();
  }
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
app.all('/render-api/*', async (req, res) => {
  const params       = req.method === 'GET' ? req.query : req.body;
  const renderKey    = params._renderKey;
  const targetMethod = (params._targetMethod || req.method).toUpperCase();

  if (!renderKey) return err(res, 'Missing _renderKey', 401);

  const { _renderKey, _targetMethod, _svcId, _dbId, _method, _targetPath, ...forwardBody } = params;

  const subPath  = req.path.replace(/^\/render-api/, '');
  const queryStr = Object.keys(req.query).filter(k => !k.startsWith('_')).length > 0
    ? '?' + new URLSearchParams(Object.fromEntries(
        Object.entries(req.query).filter(([k]) => !k.startsWith('_'))
      ))
    : '';
  const url = `https://api.render.com/v1${subPath}${queryStr}`;

  console.log(`[render-api] ${targetMethod} ${url}`);

  try {
    const body = (targetMethod !== 'GET' && Object.keys(forwardBody).length > 0)
      ? JSON.stringify(forwardBody) : undefined;

    const r    = await nodeFetch(url, {
      method:  targetMethod,
      headers: {
        'Authorization': `Bearer ${renderKey}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
      },
      body,
    });
    const text = await r.text();
    res.status(r.status).set('Content-Type', 'application/json').send(text || '{"ok":true}');
  } catch (e) {
    console.error('[render-api] error:', e.message);
    err(res, 'Proxy error: ' + e.message, 502);
  }
});

// ── Admin routes ──────────────────────────────────────────────────────────────
// Protected by admin password sent in body or x-admin-key header.
// These are only called from the DevTools Server panel (password-gated in UI).

const ADMIN_PW = '213646';
const _logs = []; // in-memory log ring buffer (last 200 lines)
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origErr = console.error.bind(console);
function _capture(level, ...args){
  const line = `[${new Date().toISOString()}] [${level}] ${args.join(' ')}`;
  _logs.push(line);
  if(_logs.length > 200) _logs.shift();
}
console.log   = (...a)=>{ _capture('INFO',  ...a); _origLog(...a);  };
console.warn  = (...a)=>{ _capture('WARN',  ...a); _origWarn(...a); };
console.error = (...a)=>{ _capture('ERROR', ...a); _origErr(...a);  };

function adminAuth(req, res, next){
  const pw = req.body?._adminPw || req.query?._adminPw || req.headers['x-admin-key'];
  if(pw !== ADMIN_PW) return res.status(401).json({ok:false, error:'Unauthorised'});
  next();
}

// GET /admin/users — list all accounts
app.all('/admin/users', adminAuth, async (req, res) => {
  try{
    const r = await pool.query(
      `SELECT username, hash, created_at, updated_at,
              config IS NOT NULL AS has_config,
              pg_column_size(config) AS config_bytes,
              config
       FROM accounts ORDER BY created_at DESC`
    );
    res.json({ ok: true, users: r.rows });
  }catch(e){ err(res, e.message, 500); }
});

// POST /admin/users/:username/delete
app.all('/admin/users/:username/delete', adminAuth, async (req, res) => {
  try{
    await pool.query('DELETE FROM accounts WHERE username = $1', [req.params.username]);
    res.json({ ok: true });
  }catch(e){ err(res, e.message, 500); }
});

// POST /admin/users/:username/wipe-config
app.all('/admin/users/:username/wipe-config', adminAuth, async (req, res) => {
  try{
    await pool.query(
      'UPDATE accounts SET config = NULL, updated_at = NOW() WHERE username = $1',
      [req.params.username]
    );
    res.json({ ok: true });
  }catch(e){ err(res, e.message, 500); }
});

// GET /admin/db/stats
app.all('/admin/db/stats', adminAuth, async (req, res) => {
  try{
    const [counts, sizes, dates] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total, COUNT(config) AS with_config FROM accounts`),
      pool.query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size,
                         pg_size_pretty(pg_total_relation_size('accounts')) AS table_size`),
      pool.query(`SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest FROM accounts`),
    ]);
    res.json({
      ok: true,
      totalAccounts: parseInt(counts.rows[0].total),
      withConfig:    parseInt(counts.rows[0].with_config),
      dbSize:        sizes.rows[0].db_size,
      tableSize:     sizes.rows[0].table_size,
      oldest:        dates.rows[0].oldest,
      newest:        dates.rows[0].newest,
    });
  }catch(e){ err(res, e.message, 500); }
});

// POST /admin/db/query — SELECT only
app.all('/admin/db/query', adminAuth, async (req, res) => {
  const sql = req.body?.sql || req.query?.sql;
  if(!sql) return err(res, 'No SQL provided');
  const trimmed = sql.trim().toLowerCase();
  if(!trimmed.startsWith('select') && !trimmed.startsWith('with')){
    return err(res, 'Only SELECT queries are allowed');
  }
  try{
    const r = await pool.query(sql);
    res.json({ ok: true, rows: r.rows, rowCount: r.rowCount });
  }catch(e){ err(res, e.message, 400); }
});

// GET /admin/logs
app.all('/admin/logs', adminAuth, (req, res) => {
  res.json({ ok: true, logs: [..._logs].reverse() });
});


app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'Desktop Simulator Backend', time: new Date().toISOString() });
});

// ── Self-ping keepalive ───────────────────────────────────────────────────────
function startKeepalive() {
  const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(async () => {
    try {
      const r = await nodeFetch(SELF_URL + '/');
      console.log(`[keepalive] ping → ${r.status}`);
    } catch (e) {
      console.warn(`[keepalive] ping failed: ${e.message}`);
    }
  }, 10 * 60 * 1000); // every 10 minutes
  console.log(`[keepalive] started, pinging ${SELF_URL} every 10min`);
}

// ── Start ─────────────────────────────────────────────────────────────────────
initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      startKeepalive();
    });
  })
  .catch(e => {
    console.error('Failed to initialise DB:', e.message);
    console.error('Connection string (masked):', DATABASE_URL.replace(/:\/\/[^@]+@/, '://***@'));
    process.exit(1);
  });
