const express = require("express");
const axios   = require("axios");
const cheerio = require("cheerio");
const urlLib  = require("url");
const fs      = require("fs");
const path    = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Storage ──────────────────────────────────────────────────────────────────
// Flat JSON file: { [username_lowercase]: { username, hash, config } }
// Lives next to server.js; survives restarts automatically.
const DB_PATH = path.join(__dirname, "accounts.json");

function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, "utf8")); }
  catch (_) { return {}; }
}
function writeDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: "50mb" })); // configs can include base64 photos

// CORS — allow the HTML file to call from any origin
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function resolveUrl(base, relative) {
  return urlLib.resolve(base, relative);
}
function authOk(db, key, hash) {
  const u = db[key];
  return u && u.hash === hash;
}

// ── Auth endpoints ────────────────────────────────────────────────────────────

// POST /auth/register  { username, hash }
app.post("/auth/register", (req, res) => {
  const { username, hash } = req.body || {};
  if (!username || !hash)
    return res.json({ ok: false, error: "Missing username or hash" });

  const key = username.trim().toLowerCase();
  if (key.length < 2 || key.length > 32)
    return res.json({ ok: false, error: "Username must be 2-32 characters" });
  if (!/^[a-z0-9_.-]+$/.test(key))
    return res.json({ ok: false, error: "Username may only contain letters, numbers, _ . -" });

  const db = readDB();
  if (db[key])
    return res.json({ ok: false, error: "Username already taken" });

  db[key] = { username: username.trim(), hash, config: null, createdAt: Date.now() };
  writeDB(db);
  res.json({ ok: true, username: username.trim() });
});

// POST /auth/login  { username, hash }
app.post("/auth/login", (req, res) => {
  const { username, hash } = req.body || {};
  if (!username || !hash)
    return res.json({ ok: false, error: "Missing credentials" });

  const db  = readDB();
  const key = username.trim().toLowerCase();
  const u   = db[key];

  if (!u || u.hash !== hash)
    return res.json({ ok: false, error: "Invalid username or password" });

  res.json({ ok: true, username: u.username, config: u.config });
});

// POST /auth/save-config  { username, hash, config }
app.post("/auth/save-config", (req, res) => {
  const { username, hash, config } = req.body || {};
  if (!username || !hash)
    return res.json({ ok: false, error: "Missing credentials" });

  const db  = readDB();
  const key = username.trim().toLowerCase();

  if (!authOk(db, key, hash))
    return res.json({ ok: false, error: "Unauthorized" });

  db[key].config = config;
  db[key].savedAt = Date.now();
  writeDB(db);
  res.json({ ok: true });
});

// GET /auth/load-config?username=&hash=
app.get("/auth/load-config", (req, res) => {
  const { username, hash } = req.query || {};
  if (!username || !hash)
    return res.json({ ok: false, error: "Missing credentials" });

  const db  = readDB();
  const key = username.trim().toLowerCase();

  if (!authOk(db, key, hash))
    return res.json({ ok: false, error: "Unauthorized" });

  res.json({ ok: true, config: db[key].config });
});

// POST /auth/delete  { username, hash }
app.post("/auth/delete", (req, res) => {
  const { username, hash } = req.body || {};
  if (!username || !hash)
    return res.json({ ok: false, error: "Missing credentials" });

  const db  = readDB();
  const key = username.trim().toLowerCase();

  if (!authOk(db, key, hash))
    return res.json({ ok: false, error: "Unauthorized" });

  delete db[key];
  writeDB(db);
  res.json({ ok: true });
});

// ── Original proxy endpoint (unchanged) ──────────────────────────────────────
app.get("/proxy", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.send("No URL provided");

  try {
    const response = await axios.get(target, {
      responseType: "text",
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const $ = cheerio.load(response.data);

    $("a").each((_, el) => {
      let href = $(el).attr("href");
      if (href) {
        $(el).attr("href", "/proxy?url=" + resolveUrl(target, href));
      }
    });

    res.send($.html());
  } catch (err) {
    res.send("Error loading page");
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nProxy+Auth server running on port ${PORT}`);
  console.log(`  POST /auth/register     — create account`);
  console.log(`  POST /auth/login        — sign in + load config`);
  console.log(`  POST /auth/save-config  — push full desktop config`);
  console.log(`  GET  /auth/load-config  — pull full desktop config`);
  console.log(`  POST /auth/delete       — delete account`);
  console.log(`  GET  /proxy?url=        — web proxy (unchanged)\n`);
});
