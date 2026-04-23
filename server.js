const express = require("express");
const axios   = require("axios");
const cheerio = require("cheerio");
const urlLib  = require("url");
const { Pool } = require("pg");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Database ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: "postgresql://server_login_mgr_user:TrqUTHQt5H29h5oHlDglqGKuUGRTokNA@dpg-d7knlipj2pic73cbng30-a.ohio-postgres.render.com/server_login_mgr",
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      username   TEXT PRIMARY KEY,
      hash       TEXT NOT NULL,
      config     TEXT,
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      saved_at   BIGINT
    )
  `);
  console.log("Database ready");
}
initDB().catch(err => console.error("DB init error:", err));

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: "50mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function resolveUrl(base, relative) { return urlLib.resolve(base, relative); }
function ok(res, data)  { res.json({ ok: true,  ...data }); }
function fail(res, msg) { res.json({ ok: false, error: msg }); }

// ── Auth endpoints ────────────────────────────────────────────────────────────

// POST /auth/register
app.post("/auth/register", async (req, res) => {
  const { username, hash } = req.body || {};
  if (!username || !hash) return fail(res, "Missing username or hash");
  const key = username.trim().toLowerCase();
  if (key.length < 2 || key.length > 32) return fail(res, "Username must be 2-32 characters");
  if (!/^[a-z0-9_.\-]+$/.test(key)) return fail(res, "Username may only contain letters, numbers, _ . -");
  try {
    await pool.query("INSERT INTO accounts (username, hash) VALUES ($1, $2)", [key, hash]);
    ok(res, { username: username.trim() });
  } catch (e) {
    if (e.code === "23505") return fail(res, "Username already taken");
    console.error(e); fail(res, "Server error");
  }
});

// POST /auth/login
app.post("/auth/login", async (req, res) => {
  const { username, hash } = req.body || {};
  if (!username || !hash) return fail(res, "Missing credentials");
  const key = username.trim().toLowerCase();
  try {
    const { rows } = await pool.query("SELECT username, hash, config FROM accounts WHERE username = $1", [key]);
    const u = rows[0];
    if (!u || u.hash !== hash) return fail(res, "Invalid username or password");
    ok(res, { username: u.username, config: u.config ? JSON.parse(u.config) : null });
  } catch (e) { console.error(e); fail(res, "Server error"); }
});

// POST /auth/save-config
app.post("/auth/save-config", async (req, res) => {
  const { username, hash, config } = req.body || {};
  if (!username || !hash) return fail(res, "Missing credentials");
  const key = username.trim().toLowerCase();
  try {
    const { rows } = await pool.query("SELECT hash FROM accounts WHERE username = $1", [key]);
    if (!rows[0] || rows[0].hash !== hash) return fail(res, "Unauthorized");
    await pool.query("UPDATE accounts SET config = $1, saved_at = $2 WHERE username = $3",
      [JSON.stringify(config), Date.now(), key]);
    ok(res);
  } catch (e) { console.error(e); fail(res, "Server error"); }
});

// GET /auth/load-config
app.get("/auth/load-config", async (req, res) => {
  const { username, hash } = req.query || {};
  if (!username || !hash) return fail(res, "Missing credentials");
  const key = username.trim().toLowerCase();
  try {
    const { rows } = await pool.query("SELECT hash, config FROM accounts WHERE username = $1", [key]);
    const u = rows[0];
    if (!u || u.hash !== hash) return fail(res, "Unauthorized");
    ok(res, { config: u.config ? JSON.parse(u.config) : null });
  } catch (e) { console.error(e); fail(res, "Server error"); }
});

// POST /auth/delete
app.post("/auth/delete", async (req, res) => {
  const { username, hash } = req.body || {};
  if (!username || !hash) return fail(res, "Missing credentials");
  const key = username.trim().toLowerCase();
  try {
    const { rows } = await pool.query("SELECT hash FROM accounts WHERE username = $1", [key]);
    if (!rows[0] || rows[0].hash !== hash) return fail(res, "Unauthorized");
    await pool.query("DELETE FROM accounts WHERE username = $1", [key]);
    ok(res);
  } catch (e) { console.error(e); fail(res, "Server error"); }
});

// ── Proxy (unchanged) ─────────────────────────────────────────────────────────
app.get("/proxy", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.send("No URL provided");
  try {
    const response = await axios.get(target, {
      responseType: "text",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const $ = cheerio.load(response.data);
    $("a").each((_, el) => {
      const href = $(el).attr("href");
      if (href) $(el).attr("href", "/proxy?url=" + resolveUrl(target, href));
    });
    res.send($.html());
  } catch (e) { res.send("Error loading page"); }
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
