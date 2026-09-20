'use strict';
/* ============================================================================
 * DEALZOIN v2 — B2B social network for COMPANIES only.
 * Single-file app: Express 4 + better-sqlite3 (sync) + built-in crypto.
 * "Midnight Exchange" theme (gold/mint on ink), server-rendered HTML via template literals.
 * ==========================================================================*/

// ============================= CONFIG & DEPENDENCIES =============================
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');

const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@dealzoin.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || ADMIN_EMAIL;

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CODE_TTL_MS = 10 * 60 * 1000;             // 10 minutes (login 2FA codes)

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.disable('x-powered-by');

// ============================= DATABASE SETUP =============================
const db = new Database(path.join(process.cwd(), 'dealzoin.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS companies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  website       TEXT DEFAULT '',
  description   TEXT DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending',     -- pending | approved | rejected | suspended
  flagged       INTEGER NOT NULL DEFAULT 0,
  flag_reasons  TEXT DEFAULT '',
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  company_id INTEGER,                                -- NULL for admin sessions
  is_admin   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL,
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  value       TEXT DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS likes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL,
  target_type TEXT NOT NULL,                         -- 'deal' | 'post'
  target_id   INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(company_id, target_type, target_id)
);
CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL,
  target_type TEXT NOT NULL,                         -- 'deal' | 'post'
  target_id   INTEGER NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reposts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  deal_id    INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS follows (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  follower_id INTEGER NOT NULL,
  followed_id INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(follower_id, followed_id)
);
CREATE TABLE IF NOT EXISTS contracts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id            INTEGER NOT NULL,
  signer_company_id  INTEGER NOT NULL,
  owner_company_id   INTEGER NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  signed_at          TEXT NOT NULL,
  decided_at         TEXT,
  created_at         TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS verification_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token      TEXT NOT NULL,                          -- random pending-login token (cookie)
  company_id INTEGER NOT NULL,
  code       TEXT NOT NULL,
  purpose    TEXT NOT NULL DEFAULT 'login',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent      TEXT NOT NULL,
  action     TEXT NOT NULL,
  result     TEXT NOT NULL,                          -- pass | flag | fail
  details    TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
`);

const now = () => new Date().toISOString();

// ============================= SECURITY HELPERS =============================
/** Escape ALL user content before injecting into HTML. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
function newSalt() { return crypto.randomBytes(16).toString('hex'); }
function verifyPassword(password, salt, expectedHash) {
  const actual = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(expectedHash || '', 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}
/** Constant-time comparison for plain (env) secrets via SHA-256 digests. */
function safeEqualPlain(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function hmac(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}
function randomToken() { return crypto.randomBytes(32).toString('hex'); }

/** Minimal cookie parser (no cookie-parser dependency). */
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}
/** Read + verify an HMAC-signed cookie value of the form "value.sig". Returns value or null. */
function readSignedCookie(req, name) {
  const raw = parseCookies(req)[name];
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot === -1) return null;
  const value = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = hmac(value);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return value;
}
function signedCookieValue(value) { return value + '.' + hmac(value); }

// ============================= AGENT AUDIT LOG =============================
function audit(agent, action, result, details) {
  db.prepare('INSERT INTO agent_audit (agent, action, result, details, created_at) VALUES (?,?,?,?,?)')
    .run(agent, action, result, String(details || '').slice(0, 500), now());
}

// ============================= SECURITY AGENTS =============================
// --- ONBOARDING AGENT data ---
const DISPOSABLE_DOMAINS = [
  'mailinator.com', 'tempmail.com', '10minutemail.com', 'guerrillamail.com',
  'yopmail.com', 'temp-mail.org', 'throwawaymail.com', 'fakeinbox.com',
  'sharklasers.com', 'getnada.com', 'maildrop.cc', 'trashmail.com',
  'tempmailo.com', 'dispostable.com', 'mailnesia.com', 'mintemail.com'
];
const FREE_PROVIDERS = [
  'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com',
  'aol.com', 'icloud.com', 'proton.me', 'protonmail.com'
];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * ONBOARDING AGENT — runs on every company signup.
 * Returns { hardReject: bool, error: string, flags: [string] }.
 */
function runOnboardingAgent(name, email) {
  const flags = [];
  const domain = String(email).split('@')[1]?.toLowerCase() || '';

  // (a) email format validation
  if (!EMAIL_RE.test(email)) {
    audit('ONBOARDING AGENT', 'signup email validation', 'fail', `Invalid email format: ${email}`);
    return { hardReject: true, error: 'Invalid business email format.', flags };
  }
  audit('ONBOARDING AGENT', 'signup email validation', 'pass', `Email format OK: ${email}`);

  // (b) disposable / temp email domains -> hard reject
  if (DISPOSABLE_DOMAINS.includes(domain)) {
    audit('ONBOARDING AGENT', 'disposable domain check', 'fail', `Blocked disposable domain: ${domain}`);
    return { hardReject: true, error: 'Disposable/temporary email addresses are not allowed. Please use your business email.', flags };
  }
  audit('ONBOARDING AGENT', 'disposable domain check', 'pass', `Domain not disposable: ${domain}`);

  // (c) free providers -> warning flag (registration still allowed, stays pending)
  if (FREE_PROVIDERS.includes(domain)) {
    flags.push('Non-business email domain (' + domain + ')');
    audit('ONBOARDING AGENT', 'free provider check', 'flag', `Free email provider used: ${domain}`);
  } else {
    audit('ONBOARDING AGENT', 'free provider check', 'pass', `Business domain: ${domain}`);
  }

  // (d) name screening: too short, contains "test", or keyboard mash
  const n = String(name).trim();
  const mash = /(qwerty|asdf|zxcv|qazwsx|12345|(.)\2{3,})/i;
  if (n.length < 3) {
    flags.push('Company name too short (<3 chars)');
    audit('ONBOARDING AGENT', 'name screening', 'flag', `Name too short: "${n}"`);
  } else if (/test/i.test(n)) {
    flags.push('Company name contains "test"');
    audit('ONBOARDING AGENT', 'name screening', 'flag', `Name contains "test": "${n}"`);
  } else if (mash.test(n)) {
    flags.push('Company name looks like keyboard mash');
    audit('ONBOARDING AGENT', 'name screening', 'flag', `Keyboard-mash name: "${n}"`);
  } else {
    audit('ONBOARDING AGENT', 'name screening', 'pass', `Name OK: "${n}"`);
  }

  return { hardReject: false, error: '', flags };
}

// ============================= EMAIL DELIVERY (BREVO / DEMO MODE) =============================
/**
 * Dual-mode code delivery.
 *  - BREVO_API_KEY set   -> send via Brevo HTTPS API (global fetch, no SMTP/nodemailer).
 *  - BREVO_API_KEY unset -> DEMO MODE: code shown on the verify page + console.log.
 */
function sendVerificationCode(email, code) {
  if (!BREVO_API_KEY) {
    console.log(`[DEMO MODE] Verification code for ${email}: ${code}`);
    audit('AUTHENTICATION AGENT', '2FA code delivery', 'flag', `DEMO MODE — code for ${email} shown on screen (no BREVO_API_KEY set)`);
    return;
  }
  fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { email: BREVO_SENDER_EMAIL, name: 'Dealzoin Security' },
      to: [{ email }],
      subject: 'Your Dealzoin verification code',
      htmlContent: `<html><body style="font-family:sans-serif"><h2>Dealzoin Security</h2>
        <p>Your login verification code is:</p>
        <p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p>
        <p>This code expires in 10 minutes. If you did not request it, ignore this email.</p>
        </body></html>`
    })
  }).then(async (res) => {
    if (res.ok) {
      audit('AUTHENTICATION AGENT', '2FA code delivery', 'pass', `Brevo email sent to ${email}`);
    } else {
      const txt = await res.text().catch(() => '');
      audit('AUTHENTICATION AGENT', '2FA code delivery', 'fail', `Brevo API ${res.status} for ${email}: ${txt.slice(0, 200)}`);
    }
  }).catch((err) => {
    audit('AUTHENTICATION AGENT', '2FA code delivery', 'fail', `Brevo send error for ${email}: ${err.message}`);
  });
}

// ============================= HTML LAYOUT & CSS =============================
// "The Midnight Exchange" theme — molten gold (money) + electric mint (trust) on ink.
const CSS = `
  :root {
    --bg-void:       #0A0A12;
    --bg-elevated:   #11111C;
    --bg-spotlight:  #171726;
    --surface-card:  #14141F;
    --surface-deal:  linear-gradient(160deg, #1B1A2E 0%, #14141F 60%);
    --gold:          #F5B942;
    --gold-deep:     #C98A1E;
    --gold-glow:     rgba(245,185,66,0.16);
    --mint:          #3FE0B0;
    --mint-deep:     #1FAF85;
    --ink-primary:   #F4F1E8;
    --ink-muted:     #9A97A8;
    --ink-faint:     #5C5A6B;
    --success:       #3FE0B0;
    --warning:       #FFB454;
    --danger:        #FF5C7A;
    --danger-deep:   #C93A56;
    --border-soft:   #242435;
    --border-gold:   rgba(245,185,66,0.35);
    --gradient-coin: linear-gradient(120deg, #F5B942 0%, #FFD97A 45%, #C98A1E 100%);
    --font-display: "Space Grotesk", "Segoe UI", system-ui, sans-serif;
    --font-body:    "Inter", -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background-color: var(--bg-void); background-image: radial-gradient(1200px 600px at 50% -10%, rgba(245,185,66,0.07), transparent 60%); background-attachment: fixed; background-repeat: no-repeat; color: var(--ink-primary); font-family: var(--font-body); font-size: 16px; line-height: 1.6; min-height: 100vh; }
  a { color: var(--gold); text-decoration: none; }
  a:hover { color: #FFD97A; }
  h1, h2, h3 { font-family: var(--font-display); color: var(--ink-primary); }
  h1 { font-size: 2rem; font-weight: 700; letter-spacing: -0.02em; }
  h2 { font-size: 1.375rem; font-weight: 700; letter-spacing: -0.015em; }
  h3 { font-size: 1.125rem; font-weight: 700; letter-spacing: -0.015em; }
  .kicker { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.14em; color: var(--mint); }
  .sec-h { margin: 18px 0 10px; }

  /* Nav — sticky, blurred, members-only feel */
  .nav { position: sticky; top: 0; z-index: 10; min-height: 64px; background: rgba(10,10,18,0.85); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-bottom: 1px solid var(--border-soft); padding: 10px 24px; display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
  .nav .brand { display: inline-flex; align-items: center; gap: 10px; font-family: var(--font-display); font-size: 20px; font-weight: 700; letter-spacing: -0.02em; color: var(--ink-primary); }
  .nav .brand:hover { color: var(--ink-primary); }
  .nav .coin { width: 30px; height: 30px; border-radius: 50%; background: var(--gradient-coin); color: #14100A; display: inline-flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; letter-spacing: 0; box-shadow: 0 2px 12px rgba(245,185,66,0.35); }
  .nav a.navlink { color: var(--ink-muted); font-size: 14px; font-weight: 500; padding-bottom: 2px; border-bottom: 2px solid transparent; }
  .nav a.navlink:hover { color: var(--ink-primary); }
  .nav .spacer { flex: 1; }

  .container { max-width: 860px; margin: 28px auto; padding: 0 16px; }

  /* Cards */
  .card { background: var(--surface-card); border: 1px solid var(--border-soft); border-radius: 16px; padding: 1.25rem; margin-bottom: 16px; }
  .card h2, .card h3 { margin-bottom: 10px; }
  /* Deal cards — the money moment */
  .card-deal { position: relative; background: var(--surface-deal); border: 1px solid var(--border-gold); padding: 1.5rem; box-shadow: 0 8px 32px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,217,122,0.08); transition: transform .2s ease, box-shadow .2s ease; }
  .card-deal::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 3px; background: var(--gradient-coin); border-radius: 16px 16px 0 0; }
  .card-deal:hover { transform: translateY(-3px); box-shadow: 0 16px 44px rgba(0,0,0,0.55), 0 0 0 1px var(--border-gold); }
  /* Vault-secure panels (signing room, contract status) */
  .vault { border-color: var(--border-gold); box-shadow: 0 8px 32px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,217,122,0.08); }
  .muted { color: var(--ink-muted); font-size: 13px; }
  .deal-value { font-family: var(--font-display); font-weight: 700; font-size: 1.35rem; color: var(--gold); letter-spacing: -0.01em; white-space: nowrap; }
  .avatar { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 10px; background: var(--bg-spotlight); border: 1px solid var(--border-soft); color: var(--gold); font-family: var(--font-display); font-weight: 700; font-size: 15px; vertical-align: middle; margin-right: 8px; }

  /* Buttons */
  .btn { display: inline-block; background: var(--gradient-coin); color: #14100A; border: 1px solid transparent; border-radius: 10px; padding: 0.7rem 1.4rem; font: 600 0.9375rem var(--font-body); cursor: pointer; transition: all .18s ease; box-shadow: 0 4px 18px rgba(245,185,66,0.28); }
  .btn:hover { transform: translateY(-2px); box-shadow: 0 8px 26px rgba(245,185,66,0.42); color: #14100A; }
  .btn:active { transform: translateY(0); box-shadow: 0 4px 18px rgba(245,185,66,0.28); }
  .btn:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
  .btn-sm { padding: 5px 11px; font-size: 13px; }
  .btn-outline { background: transparent; color: var(--ink-primary); border-color: var(--border-soft); box-shadow: none; }
  .btn-outline:hover { border-color: var(--border-gold); background: var(--bg-spotlight); color: var(--ink-primary); transform: none; box-shadow: none; }
  .btn-danger { background: var(--danger); color: #fff; box-shadow: none; }
  .btn-danger:hover { background: var(--danger-deep); color: #fff; }
  .btn-green { background: var(--mint); color: #0A0A12; box-shadow: none; }
  .btn-green:hover { background: var(--mint-deep); color: #0A0A12; }
  .btn.liked { animation: likepop .15s ease; }
  @keyframes likepop { 0% { transform: scale(1); } 50% { transform: scale(1.15); } 100% { transform: scale(1); } }

  /* Forms / inputs */
  input[type=text], input[type=email], input[type=password], input[type=url], input[type=number], textarea {
    width: 100%; background: var(--bg-elevated); border: 1px solid var(--border-soft); border-radius: 10px;
    color: var(--ink-primary); padding: 0.7rem 0.9rem; font-size: 14px; font-family: var(--font-body); margin-bottom: 12px;
  }
  input::placeholder, textarea::placeholder { color: var(--ink-faint); }
  input:focus, textarea:focus { outline: none; border-color: var(--border-gold); box-shadow: 0 0 0 3px var(--gold-glow); background: var(--bg-spotlight); }
  label { display: block; font-size: 0.8125rem; font-weight: 600; color: var(--ink-muted); margin-bottom: 6px; }

  /* Flash messages */
  .flash-ok, .flash-err { border-radius: 10px; padding: 0.8rem 1.1rem; font: 500 0.9375rem var(--font-body); border: 1px solid; margin-bottom: 14px; animation: flashin .3s ease; }
  .flash-ok { background: rgba(63,224,176,0.15); border-color: rgba(63,224,176,0.4); color: var(--mint); }
  .flash-err { background: rgba(255,92,122,0.12); border-color: rgba(255,92,122,0.4); color: var(--danger); }
  @keyframes flashin { from { transform: translateY(-8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  .demo-banner { background: rgba(255,180,84,0.12); border: 1px solid rgba(255,180,84,0.35); color: var(--warning); border-radius: 10px; padding: 12px 14px; margin-bottom: 14px; font-size: 14px; }
  .demo-banner b { color: var(--warning); }

  /* Badges */
  .badge { display: inline-block; border-radius: 999px; padding: 0.2rem 0.7rem; font: 600 0.75rem var(--font-body); text-transform: uppercase; letter-spacing: 0.08em; border: 1px solid transparent; }
  .badge-pass, .badge-approved { background: rgba(63,224,176,0.12); color: var(--success); border-color: rgba(63,224,176,0.3); }
  .badge-approved::before { content: "\\2713  "; }
  .badge-flag, .badge-pending { background: rgba(255,180,84,0.12); color: var(--warning); border-color: rgba(255,180,84,0.3); }
  .badge-fail, .badge-rejected { background: rgba(255,92,122,0.12); color: var(--danger); border-color: rgba(255,92,122,0.3); }
  .badge-suspended { background: transparent; color: var(--ink-faint); border: 1px dashed var(--border-soft); }
  .warn-badge { display: inline-block; background: rgba(255,180,84,0.16); color: var(--warning); border: 1px dashed var(--warning); border-radius: 999px; padding: 0.2rem 0.7rem; font: 600 0.75rem var(--font-body); text-transform: uppercase; letter-spacing: 0.08em; }
  .warn-badge .warn-ic { font-style: normal; display: inline-block; animation: warnpulse 2s ease-in-out infinite; }
  @keyframes warnpulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

  /* Tables (admin dashboard) */
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border-soft); vertical-align: top; }
  th { color: var(--ink-muted); font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.14em; }
  tbody tr:hover td, tr:hover td { background: rgba(23,23,38,0.5); }

  /* Stat tiles */
  .stats { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 18px; }
  .stat { background: var(--surface-card); border: 1px solid var(--border-soft); border-radius: 14px; padding: 1.1rem 1.25rem; flex: 1; min-width: 110px; transition: border-color .18s ease; }
  .stat:hover { border-color: var(--border-gold); }
  .stat .num { font-family: var(--font-display); font-size: 1.75rem; font-weight: 700; color: var(--ink-primary); }
  .stat .num.gold { color: var(--gold); }
  .stat .num.mint { color: var(--mint); }
  .stat .lbl { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.14em; color: var(--ink-muted); margin-top: 2px; }

  /* Feed */
  .feed-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; flex-wrap: wrap; }
  .feed-actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; align-items: center; }
  .feed-actions form { display: inline; }
  .comment { border-top: 1px solid var(--border-soft); padding: 8px 0; font-size: 13px; }

  /* Landing page */
  .hero { text-align: center; padding: 72px 20px 52px; }
  .hero h1 { font-size: clamp(2.75rem, 6vw, 4.5rem); font-weight: 700; letter-spacing: -0.03em; line-height: 1.05; margin: 16px 0 18px; }
  .hero h1 .gold { background: var(--gradient-coin); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .hero p { color: var(--ink-muted); font-size: 17px; max-width: 640px; margin: 0 auto 30px; }
  .steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin: 10px 0 26px; }
  .step { background: var(--surface-card); border: 1px solid var(--border-soft); border-radius: 14px; padding: 1.1rem 1.25rem; }
  .step .stepnum { font-family: var(--font-display); font-weight: 700; font-size: 1.1rem; color: var(--gold); }
  .step h3 { margin: 6px 0; }
  .trust { text-align: center; background: var(--bg-elevated); border: 1px solid var(--border-soft); border-radius: 16px; padding: 28px 20px; margin-top: 8px; }
  .trust p { color: var(--ink-muted); font-size: 14px; max-width: 640px; margin: 8px auto 0; }

  .footer { text-align: center; color: var(--ink-faint); font-size: 12px; padding: 30px 0; }
  .shield-note { color: var(--mint); font-size: 12px; margin-top: 18px; }
  .sep { border: none; border-top: 1px solid var(--border-soft); margin: 14px 0; }
  .flag-note { color: var(--warning); font-size: 12px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 700px) { .grid2, .steps { grid-template-columns: 1fr; } }
`;

/** Render the full HTML page shell. */
function page(title, body, user, msg, err) {
  const navLinks = user && user.isAdmin
    ? `<a class="navlink" href="/admin">Dashboard</a>
       <form method="POST" action="/admin/logout" style="display:inline"><button class="btn btn-sm btn-outline">Log out</button></form>`
    : user
    ? `<a class="navlink" href="/timeline">Timeline</a>
       <a class="navlink" href="/deals/new">New Deal</a>
       <a class="navlink" href="/search">Search</a>
       <a class="navlink" href="/company/${user.id}">My Profile</a>
       <form method="POST" action="/logout" style="display:inline"><button class="btn btn-sm btn-outline">Log out</button></form>`
    : `<a class="navlink" href="/login">Sign in</a>
       <a class="navlink" href="/signup">Register company</a>`;
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Dealzoin</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head><body>
<nav class="nav">
  <a href="/" class="brand"><span class="coin">Dz</span>Dealzoin</a>
  <span class="spacer"></span>
  ${navLinks}
</nav>
<main class="container">
  ${msg ? `<div class="flash-ok">✓ ${esc(msg)}</div>` : ''}
  ${err ? `<div class="flash-err">⚠ ${esc(err)}</div>` : ''}
  ${body}
</main>
<div class="footer">Dealzoin — the B2B deal network. Companies only. 🪙</div>
<script>setTimeout(function(){document.querySelectorAll('.flash-ok,.flash-err').forEach(function(e){e.style.transition='opacity .4s';e.style.opacity='0';setTimeout(function(){e.remove();},400);});},5000);</script>
</body></html>`;
}

function statusBadge(status) {
  return `<span class="badge badge-${esc(status)}">${esc(status)}</span>`;
}
function resultBadge(result) {
  return `<span class="badge badge-${esc(result)}">${esc(result)}</span>`;
}
/** Rounded-square company avatar (institutions, not people — never a circle). */
function avatarHtml(name) {
  const initial = (String(name || '?').trim()[0] || '?').toUpperCase();
  return `<span class="avatar" aria-hidden="true">${esc(initial)}</span>`;
}

// ============================= SESSIONS & AUTH MIDDLEWARE =============================
/** True when the request arrived over HTTPS (Render/proxy sets x-forwarded-proto). */
function isSecureReq(req) {
  return req && (req.secure || req.headers['x-forwarded-proto'] === 'https');
}
function createSession(req, res, companyId, isAdmin) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare('INSERT INTO sessions (token, company_id, is_admin, created_at, expires_at) VALUES (?,?,?,?,?)')
    .run(token, companyId, isAdmin ? 1 : 0, now(), expires);
  res.setHeader('Set-Cookie',
    `dz_session=${signedCookieValue(token)}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; SameSite=Lax${isSecureReq(req) ? '; Secure' : ''}`);
}
function destroySession(req, res) {
  const token = readSignedCookie(req, 'dz_session');
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', 'dz_session=; HttpOnly; Path=/; Max-Age=0');
}
/** Resolve the current session -> { id, name, isAdmin } or null. */
function currentUser(req) {
  const token = readSignedCookie(req, 'dz_session');
  if (!token) return null;
  const sess = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!sess || sess.expires_at < now()) return null;
  if (sess.is_admin) return { id: 0, name: 'Admin', isAdmin: true };
  const c = db.prepare('SELECT id, name, status FROM companies WHERE id = ?').get(sess.company_id);
  if (!c || c.status !== 'approved') return null;
  return { id: c.id, name: c.name, isAdmin: false };
}
/** Guard: approved company session required. */
function requireCompany(req, res, next) {
  const user = currentUser(req);
  if (!user || user.isAdmin) return res.redirect('/login?err=' + encodeURIComponent('Please sign in with an approved company account.'));
  req.user = user;
  next();
}
/** Guard: admin session required. */
function requireAdmin(req, res, next) {
  const user = currentUser(req);
  if (!user || !user.isAdmin) return res.redirect('/admin?err=' + encodeURIComponent('Admin sign-in required.'));
  req.user = user;
  next();
}

// ============================= PUBLIC ROUTES =============================
app.get('/', (req, res) => {
  const user = currentUser(req);
  const body = `
  <div class="hero">
    <div class="kicker">The B2B deal network</div>
    <h1>Where <span class="gold">companies</span> close.</h1>
    <p>Dealzoin is the social network for businesses — post deals to every company's timeline,
       follow the players in your industry, and sign binding contracts in AI-guarded signing rooms.</p>
    ${user
      ? `<a class="btn" href="${user.isAdmin ? '/admin' : '/timeline'}">Open ${user.isAdmin ? 'dashboard' : 'timeline'} &rarr;</a>`
      : `<a class="btn" href="/signup">Register your company</a>
         &nbsp; <a class="btn btn-outline" href="/login">Sign in</a>`}
  </div>
  <div class="grid2">
    <div class="card"><h3>📣 Deals on every timeline</h3><p class="muted">Publish a deal once; it's live on every follower company's feed instantly. Likes, comments and reposts built in — dealmaking with a pulse.</p></div>
    <div class="card"><h3>✍️ Private signing rooms</h3><p class="muted">Take it off the feed and into the vault. Password re-verification, signing-authority checks, and downloadable contract documents — from handshake to signature in minutes.</p></div>
    <div class="card"><h3>🤖 AI security agents on duty</h3><p class="muted">Automated agents screen onboarding, verify 2FA login codes and watch every signature — all logged to a tamper-evident audit trail.</p></div>
    <div class="card"><h3>🏢 Companies only. No noise.</h3><p class="muted">No personal profiles, no influencers. Every member is a vetted business, approved before it can post a single deal.</p></div>
  </div>
  <div class="kicker" style="margin:26px 0 10px">How it works</div>
  <div class="steps">
    <div class="step"><div class="stepnum">01</div><h3>Register &amp; get vetted</h3><p class="muted">Your company joins the network after admin approval.</p></div>
    <div class="step"><div class="stepnum">02</div><h3>Post or follow deals</h3><p class="muted">Put your offer on the wire; watch the right companies react.</p></div>
    <div class="step"><div class="stepnum">03</div><h3>Sign in the vault</h3><p class="muted">Close in a private signing room, guarded by AI agents.</p></div>
  </div>
  <div class="trust">
    <div class="kicker">Security, built in</div>
    <p>Every onboarding, login and signature is screened by Dealzoin's AI security agents and written to a tamper-evident audit trail. Real contracts deserve real locks.</p>
  </div>`;
  res.send(page('Welcome', body, user, req.query.msg, req.query.err));
});

// ----- Company signup (ONBOARDING AGENT runs here) -----
app.get('/signup', (req, res) => {
  const body = `
  <div class="card" style="max-width:520px;margin:0 auto">
    <h2>Register your company</h2>
    <p class="muted" style="margin-bottom:14px">Companies only — no individual accounts. New companies are reviewed by an admin.</p>
    <form method="POST" action="/signup">
      <label>Company name</label><input type="text" name="name" required maxlength="120">
      <label>Business email</label><input type="email" name="email" required maxlength="160">
      <label>Password (min 8 characters)</label><input type="password" name="password" required minlength="8" maxlength="200">
      <label>Website</label><input type="url" name="website" placeholder="https://example.com" maxlength="200">
      <label>Description</label><textarea name="description" rows="4" maxlength="2000"></textarea>
      <button class="btn" type="submit">Create company account</button>
    </form>
    <p class="muted" style="margin-top:12px">Already approved? <a href="/login">Sign in</a></p>
  </div>`;
  res.send(page('Sign up', body, null, req.query.msg, req.query.err));
});

app.post('/signup', (req, res) => {
  const { name, email, password, website, description } = req.body;
  const nm = String(name || '').trim();
  const em = String(email || '').trim().toLowerCase();
  // Sanitize website: only allow http(s) URLs (blocks javascript: etc.); prepend https:// if missing.
  let site = String(website || '').trim().slice(0, 200);
  if (site && !/^https?:\/\//i.test(site)) site = 'https://' + site.replace(/^[a-z][a-z0-9+.-]*:/i, '');
  if (site && !/^https:\/\/[^\s]+$/i.test(site)) site = '';

  if (!nm || !em || !password) {
    return res.redirect('/signup?err=' + encodeURIComponent('Company name, email and password are required.'));
  }
  if (String(password).length < 8) {
    return res.redirect('/signup?err=' + encodeURIComponent('Password must be at least 8 characters.'));
  }

  // --- ONBOARDING AGENT automated checks ---
  const check = runOnboardingAgent(nm, em);
  if (check.hardReject) {
    return res.redirect('/signup?err=' + encodeURIComponent(check.error));
  }

  const existing = db.prepare('SELECT id FROM companies WHERE email = ?').get(em);
  if (existing) {
    return res.redirect('/signup?err=' + encodeURIComponent('A company with this email is already registered.'));
  }

  const salt = newSalt();
  db.prepare(`INSERT INTO companies (name, email, password_hash, salt, website, description, status, flagged, flag_reasons, created_at)
              VALUES (?,?,?,?,?,?, 'pending', ?, ?, ?)`)
    .run(nm, em, hashPassword(password, salt), salt,
         site, String(description || '').trim().slice(0, 2000),
         check.flags.length ? 1 : 0, check.flags.join('; '), now());
  audit('ONBOARDING AGENT', 'signup decision', check.flags.length ? 'flag' : 'pass',
        `Company "${nm}" registered as pending${check.flags.length ? ' with warnings: ' + check.flags.join('; ') : ''}`);

  res.redirect('/login?msg=' + encodeURIComponent('Registration received! Your company is pending admin approval.'));
});

// ============================= AUTH ROUTES (login + 2FA + logout) =============================
app.get('/login', (req, res) => {
  const body = `
  <div class="card" style="max-width:440px;margin:0 auto">
    <h2>Company sign in</h2>
    <form method="POST" action="/login">
      <label>Business email</label><input type="email" name="email" required>
      <label>Password</label><input type="password" name="password" required>
      <button class="btn" type="submit">Continue</button>
    </form>
    <p class="muted" style="margin-top:12px">No account yet? <a href="/signup">Register your company</a></p>
    <p class="shield-note">🛡️ Protected by Dealzoin security agents</p>
  </div>`;
  res.send(page('Sign in', body, null, req.query.msg, req.query.err));
});

app.post('/login', (req, res) => {
  const em = String(req.body.email || '').trim().toLowerCase();
  const pw = String(req.body.password || '');
  const company = db.prepare('SELECT * FROM companies WHERE email = ?').get(em);

  if (!company || !verifyPassword(pw, company.salt, company.password_hash)) {
    audit('AUTHENTICATION AGENT', 'login password check', 'fail', `Failed login for ${em}`);
    return res.redirect('/login?err=' + encodeURIComponent('Invalid email or password.'));
  }
  audit('AUTHENTICATION AGENT', 'login password check', 'pass', `Password OK for ${em}`);

  if (company.status === 'pending') {
    return res.redirect('/login?err=' + encodeURIComponent('Your company is still pending admin approval.'));
  }
  if (company.status === 'rejected') {
    return res.redirect('/login?err=' + encodeURIComponent('This registration was rejected. Contact support.'));
  }
  if (company.status === 'suspended') {
    return res.redirect('/login?err=' + encodeURIComponent('This account is suspended. Contact support.'));
  }

  // --- AUTHENTICATION AGENT: sign-in 2FA — issue code, do NOT create session yet ---
  const code = String(crypto.randomInt(100000, 1000000)); // 6-digit
  const token = randomToken();
  db.prepare('DELETE FROM verification_codes WHERE company_id = ? AND purpose = ?').run(company.id, 'login');
  db.prepare('INSERT INTO verification_codes (token, company_id, code, purpose, expires_at, created_at) VALUES (?,?,?,?,?,?)')
    .run(token, company.id, code, 'login', new Date(Date.now() + CODE_TTL_MS).toISOString(), now());
  sendVerificationCode(company.email, code);
  audit('AUTHENTICATION AGENT', '2FA code issued', 'pass', `Login code issued for ${em} (10-min expiry)`);

  res.setHeader('Set-Cookie', `dz_verify=${signedCookieValue(token)}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax${isSecureReq(req) ? '; Secure' : ''}`);
  res.redirect('/verify-login');
});

app.get('/verify-login', (req, res) => {
  const token = readSignedCookie(req, 'dz_verify');
  if (!token) return res.redirect('/login?err=' + encodeURIComponent('No verification in progress. Please sign in again.'));
  const row = db.prepare(`SELECT * FROM verification_codes WHERE token = ? AND purpose = 'login'`).get(token);
  if (!row) return res.redirect('/login?err=' + encodeURIComponent('Verification expired. Please sign in again.'));

  // DEMO MODE: without BREVO_API_KEY the code is shown on-screen (and console.logged).
  const demo = BREVO_API_KEY ? '' : `
    <div class="demo-banner">⚠️ <b>DEMO MODE</b> — no BREVO_API_KEY configured, so the email was not sent.
    Your verification code is: <b style="font-size:18px;letter-spacing:3px">${esc(row.code)}</b></div>`;

  const body = `
  <div class="card" style="max-width:440px;margin:0 auto">
    <h2>Two-factor verification</h2>
    <p class="muted" style="margin-bottom:12px">The Authentication Agent sent a 6-digit code to your business email. Enter it below to finish signing in.</p>
    ${demo}
    <form method="POST" action="/verify-login">
      <label>6-digit code</label><input type="text" name="code" required pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code">
      <button class="btn" type="submit">Verify &amp; sign in</button>
    </form>
    <p class="shield-note">🛡️ Protected by Dealzoin security agents</p>
  </div>`;
  res.send(page('Verify login', body, null, req.query.msg, req.query.err));
});

app.post('/verify-login', (req, res) => {
  const token = readSignedCookie(req, 'dz_verify');
  const code = String(req.body.code || '').trim();
  if (!token) return res.redirect('/login?err=' + encodeURIComponent('No verification in progress. Please sign in again.'));
  const row = db.prepare(`SELECT * FROM verification_codes WHERE token = ? AND purpose = 'login'`).get(token);

  if (!row || row.expires_at < now()) {
    audit('AUTHENTICATION AGENT', '2FA verify', 'fail', 'Code expired or missing');
    return res.redirect('/login?err=' + encodeURIComponent('Code expired. Please sign in again.'));
  }
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(row.company_id);
  if (!company || company.status !== 'approved') {
    return res.redirect('/login?err=' + encodeURIComponent('Account not available.'));
  }
  // constant-time code comparison
  const a = Buffer.from(code.padEnd(6, ' '));
  const b = Buffer.from(row.code.padEnd(6, ' '));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    audit('AUTHENTICATION AGENT', '2FA verify', 'fail', `Wrong code for ${company.email}`);
    return res.redirect('/verify-login?err=' + encodeURIComponent('Incorrect code. Try again.'));
  }

  db.prepare('DELETE FROM verification_codes WHERE id = ?').run(row.id);
  audit('AUTHENTICATION AGENT', '2FA verify', 'pass', `2FA passed for ${company.email} — session created`);
  res.setHeader('Set-Cookie', 'dz_verify=; HttpOnly; Path=/; Max-Age=0');
  createSession(req, res, company.id, false);
  res.redirect('/timeline?msg=' + encodeURIComponent('Welcome back, ' + company.name + '!'));
});

app.post('/logout', (req, res) => {
  destroySession(req, res);
  res.redirect('/?msg=' + encodeURIComponent('Signed out.'));
});

// ============================= FEED CARD RENDERING =============================
function companyNameMap() {
  const map = new Map();
  for (const c of db.prepare('SELECT id, name FROM companies').all()) map.set(c.id, c.name);
  return map;
}
/** Likes + comments for a card target, plus whether the viewer liked it. */
function cardSocial(targetType, targetId, viewerId) {
  const likeCount = db.prepare('SELECT COUNT(*) AS n FROM likes WHERE target_type = ? AND target_id = ?').get(targetType, targetId).n;
  const liked = viewerId
    ? !!db.prepare('SELECT 1 FROM likes WHERE company_id = ? AND target_type = ? AND target_id = ?').get(viewerId, targetType, targetId)
    : false;
  const comments = db.prepare('SELECT * FROM comments WHERE target_type = ? AND target_id = ? ORDER BY created_at ASC LIMIT 50').all(targetType, targetId);
  return { likeCount, liked, comments };
}
function commentListHtml(comments, names) {
  if (!comments.length) return '';
  return comments.map(c =>
    `<div class="comment"><a href="/company/${c.company_id}"><b>${esc(names.get(c.company_id) || 'Unknown')}</b></a>: ${esc(c.body)}
     <span class="muted"> · ${esc(c.created_at.slice(0, 16).replace('T', ' '))}</span></div>`
  ).join('');
}
/** Render one feed card. kind: 'deal' | 'post' | 'repost'. */
function feedCard(item, user, names) {
  const ownerName = names.get(item.company_id) || 'Unknown';
  const isOwn = user && !user.isAdmin && user.id === item.company_id;

  // For reposts the social target is the ORIGINAL deal; otherwise the item itself.
  const targetType = item.kind === 'post' ? 'post' : 'deal';
  const targetId = item.kind === 'repost' ? item.repost_of : item.ref_id;
  const soc = cardSocial(targetType, targetId, user && !user.isAdmin ? user.id : null);

  let head, bodyHtml;
  if (item.kind === 'post') {
    head = `${avatarHtml(ownerName)} <a href="/company/${item.company_id}"><b>${esc(ownerName)}</b></a> <span class="muted">posted</span>`;
    bodyHtml = `<p style="margin-top:8px;white-space:pre-wrap">${esc(item.body)}</p>`;
  } else if (item.kind === 'deal') {
    head = `${avatarHtml(ownerName)} <a href="/company/${item.company_id}"><b>${esc(ownerName)}</b></a> <span class="muted">posted a deal</span>`;
    bodyHtml = `<h3 style="margin-top:8px"><a href="/deal/${item.ref_id}">${esc(item.title)}</a></h3>
      <p style="margin-top:6px;white-space:pre-wrap">${esc(item.body)}</p>`;
  } else { // repost
    const origName = names.get(item.orig_company) || 'Unknown';
    head = `🔁 Reposted from <a href="/company/${item.orig_company}"><b>${esc(origName)}</b></a>
            by <a href="/company/${item.company_id}"><b>${esc(ownerName)}</b></a>`;
    bodyHtml = `<h3 style="margin-top:8px"><a href="/deal/${item.repost_of}">${esc(item.title)}</a></h3>
      <p style="margin-top:6px;white-space:pre-wrap">${esc(item.body)}</p>`;
  }
  // Deal value sits top-right in display gold; timestamp stays muted.
  const timeStamp = esc(item.created_at.slice(0, 16).replace('T', ' '));
  const headRight = (item.kind !== 'post' && item.value)
    ? `<div style="text-align:right"><div class="deal-value">${esc(item.value)}</div><span class="muted">${timeStamp}</span></div>`
    : `<span class="muted">${timeStamp}</span>`;

  const signBtn = (item.kind !== 'post' && user && !user.isAdmin && !isOwn && item.company_id !== user.id)
    ? `<a class="btn btn-sm btn-green" href="/deal/${targetId}/contract">Sign contract</a>` : '';
  const repostBtn = (item.kind !== 'post' && user && !user.isAdmin && item.orig_company !== user.id && item.company_id !== user.id)
    ? `<form method="POST" action="/repost/${targetId}"><button class="btn btn-sm btn-outline" type="submit">Repost</button></form>` : '';
  const interact = user && !user.isAdmin ? `
    <div class="feed-actions">
      <form method="POST" action="/like/${targetType}/${targetId}">
        <button class="btn btn-sm ${soc.liked ? 'liked' : 'btn-outline'}" type="submit" title="Back this deal">${soc.liked ? 'Liked' : 'Like'} (${soc.likeCount})</button>
      </form>
      ${repostBtn}
      ${signBtn}
    </div>
    <div style="margin-top:12px">
      ${commentListHtml(soc.comments, names)}
      <form method="POST" action="/comment/${targetType}/${targetId}" style="margin-top:8px;display:flex;gap:8px">
        <input type="text" name="body" placeholder="Write a comment…" required maxlength="500" style="margin-bottom:0">
        <button class="btn btn-sm" type="submit">Comment</button>
      </form>
    </div>` : `<p class="muted" style="margin-top:10px">${soc.likeCount} likes · ${soc.comments.length} comments</p>`;

  return `<div class="card${item.kind === 'post' ? '' : ' card-deal'}">
    <div class="feed-head"><div>${head}</div>
    ${headRight}</div>
    ${bodyHtml}
    ${interact}
  </div>`;
}

// ============================= COMPANY ROUTES (timeline, posts, deals) =============================
app.get('/timeline', requireCompany, (req, res) => {
  const names = companyNameMap();
  const feed = db.prepare(`
    SELECT * FROM (
      SELECT 'deal' AS kind, d.id AS ref_id, d.company_id, d.title, d.description AS body,
             d.value, d.created_at, NULL AS repost_of, NULL AS orig_company
      FROM deals d
      UNION ALL
      SELECT 'post', p.id, p.company_id, NULL, p.body, NULL, p.created_at, NULL, NULL
      FROM posts p
      UNION ALL
      SELECT 'repost', r.id, r.company_id, d.title, d.description, d.value, r.created_at, d.id, d.company_id
      FROM reposts r JOIN deals d ON d.id = r.deal_id
    ) ORDER BY created_at DESC LIMIT 100`).all();

  const body = `
  <div class="card">
    <h2>Your timeline</h2>
    <form method="POST" action="/posts">
      <textarea name="body" rows="3" maxlength="2000" placeholder="Share an update with the network…" required style="margin-bottom:8px"></textarea>
      <button class="btn btn-sm" type="submit">Post update</button>
      <a class="btn btn-sm btn-outline" href="/deals/new" style="margin-left:8px">Post a deal</a>
    </form>
  </div>
  ${feed.length ? feed.map(i => feedCard(i, req.user, names)).join('') : '<div class="card"><p class="muted">The floor is quiet… for now. Post the first deal and watch the network react.</p></div>'}`;
  res.send(page('Timeline', body, req.user, req.query.msg, req.query.err));
});

app.post('/posts', requireCompany, (req, res) => {
  const txt = String(req.body.body || '').trim();
  if (!txt) return res.redirect('/timeline?err=' + encodeURIComponent('Post cannot be empty.'));
  db.prepare('INSERT INTO posts (company_id, body, created_at) VALUES (?,?,?)').run(req.user.id, txt.slice(0, 2000), now());
  res.redirect('/timeline?msg=' + encodeURIComponent('Posted!'));
});

app.get('/deals/new', requireCompany, (req, res) => {
  const body = `
  <div class="card" style="max-width:560px;margin:0 auto">
    <h2>📦 Post a new deal</h2>
    <p class="muted" style="margin-bottom:12px">Deals go live on every company's timeline immediately.</p>
    <form method="POST" action="/deals">
      <label>Deal title</label><input type="text" name="title" required maxlength="160">
      <label>Deal value (e.g. $50,000 / year)</label><input type="text" name="value" maxlength="80">
      <label>Description</label><textarea name="description" rows="6" required maxlength="4000"></textarea>
      <button class="btn" type="submit">Publish deal</button>
    </form>
  </div>`;
  res.send(page('New deal', body, req.user, req.query.msg, req.query.err));
});

app.post('/deals', requireCompany, (req, res) => {
  const title = String(req.body.title || '').trim();
  const desc = String(req.body.description || '').trim();
  const value = String(req.body.value || '').trim().slice(0, 80);
  if (!title || !desc) return res.redirect('/deals/new?err=' + encodeURIComponent('Title and description are required.'));
  db.prepare('INSERT INTO deals (company_id, title, description, value, created_at) VALUES (?,?,?,?,?)')
    .run(req.user.id, title.slice(0, 160), desc.slice(0, 4000), value, now());
  res.redirect('/timeline?msg=' + encodeURIComponent('Deal published to all timelines!'));
});

// ============================= SOCIAL ROUTES (likes, comments, reposts, follows) =============================
app.post('/like/:type/:id', requireCompany, (req, res) => {
  const type = req.params.type === 'post' ? 'post' : 'deal';
  const id = parseInt(req.params.id, 10);
  const table = type === 'post' ? 'posts' : 'deals';
  if (!db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id)) {
    return res.redirect('/timeline?err=' + encodeURIComponent('Item not found.'));
  }
  const existing = db.prepare('SELECT id FROM likes WHERE company_id = ? AND target_type = ? AND target_id = ?').get(req.user.id, type, id);
  if (existing) {
    db.prepare('DELETE FROM likes WHERE id = ?').run(existing.id); // toggle off
  } else {
    db.prepare('INSERT INTO likes (company_id, target_type, target_id, created_at) VALUES (?,?,?,?)').run(req.user.id, type, id, now());
  }
  res.redirect(req.get('referer') || '/timeline');
});

app.post('/comment/:type/:id', requireCompany, (req, res) => {
  const type = req.params.type === 'post' ? 'post' : 'deal';
  const id = parseInt(req.params.id, 10);
  const txt = String(req.body.body || '').trim();
  const table = type === 'post' ? 'posts' : 'deals';
  if (!db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id)) {
    return res.redirect('/timeline?err=' + encodeURIComponent('Item not found.'));
  }
  if (!txt) return res.redirect('/timeline?err=' + encodeURIComponent('Comment cannot be empty.'));
  db.prepare('INSERT INTO comments (company_id, target_type, target_id, body, created_at) VALUES (?,?,?,?,?)')
    .run(req.user.id, type, id, txt.slice(0, 500), now());
  res.redirect(req.get('referer') || '/timeline');
});

app.post('/repost/:dealId', requireCompany, (req, res) => {
  const dealId = parseInt(req.params.dealId, 10);
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(dealId);
  if (!deal) return res.redirect('/timeline?err=' + encodeURIComponent('Deal not found.'));
  if (deal.company_id === req.user.id) return res.redirect('/timeline?err=' + encodeURIComponent('You cannot repost your own deal.'));
  db.prepare('INSERT INTO reposts (company_id, deal_id, created_at) VALUES (?,?,?)').run(req.user.id, dealId, now());
  res.redirect('/timeline?msg=' + encodeURIComponent('Reposted to your feed!'));
});

app.post('/follow/:id', requireCompany, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) return res.redirect('/company/' + id + '?err=' + encodeURIComponent('You cannot follow your own company.'));
  if (!db.prepare(`SELECT id FROM companies WHERE id = ? AND status = 'approved'`).get(id)) {
    return res.redirect('/timeline?err=' + encodeURIComponent('Company not found.'));
  }
  db.prepare('INSERT OR IGNORE INTO follows (follower_id, followed_id, created_at) VALUES (?,?,?)').run(req.user.id, id, now());
  res.redirect(req.get('referer') || '/company/' + id);
});

app.post('/unfollow/:id', requireCompany, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare('DELETE FROM follows WHERE follower_id = ? AND followed_id = ?').run(req.user.id, id);
  res.redirect(req.get('referer') || '/company/' + id);
});

// ============================= SEARCH & COMPANY PROFILES =============================
function followButton(viewer, companyId) {
  if (!viewer || viewer.isAdmin || viewer.id === companyId) return '';
  const following = db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ?').get(viewer.id, companyId);
  return following
    ? `<form method="POST" action="/unfollow/${companyId}" style="display:inline"><button class="btn btn-sm btn-outline" type="submit">Following ✓</button></form>`
    : `<form method="POST" action="/follow/${companyId}" style="display:inline"><button class="btn btn-sm" type="submit">Follow</button></form>`;
}
function followCounts(companyId) {
  const followers = db.prepare('SELECT COUNT(*) AS n FROM follows WHERE followed_id = ?').get(companyId).n;
  const following = db.prepare('SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?').get(companyId).n;
  return { followers, following };
}

app.get('/search', requireCompany, (req, res) => {
  const q = String(req.query.q || '').trim();
  let dealsHtml = '', companiesHtml = '';
  if (q) {
    const like = '%' + q.replace(/[%_]/g, '') + '%';
    const deals = db.prepare(`SELECT * FROM deals WHERE title LIKE ? OR description LIKE ? ORDER BY created_at DESC LIMIT 30`).all(like, like);
    const companies = db.prepare(`SELECT * FROM companies WHERE status = 'approved' AND (name LIKE ? OR description LIKE ?) ORDER BY name LIMIT 30`).all(like, like);
    const names = companyNameMap();
    dealsHtml = deals.length
      ? deals.map(d => feedCard({ kind: 'deal', ref_id: d.id, company_id: d.company_id, title: d.title, body: d.description, value: d.value, created_at: d.created_at }, req.user, names)).join('')
      : '<p class="muted">No deals match your search.</p>';
    companiesHtml = companies.length
      ? companies.map(c => {
          const fc = followCounts(c.id);
          return `<div class="card">
            <div class="feed-head"><h3>${avatarHtml(c.name)}<a href="/company/${c.id}">${esc(c.name)}</a></h3>${followButton(req.user, c.id)}</div>
            <p class="muted">${fc.followers} followers · ${fc.following} following</p>
            <p style="margin-top:6px">${esc(c.description || '')}</p>
          </div>`;
        }).join('')
      : '<p class="muted">No companies match that — yet. Try an industry, a deal value, or a company name.</p>';
  }
  const body = `
  <div class="card">
    <h2>🔍 Search Dealzoin</h2>
    <form method="GET" action="/search" style="display:flex;gap:8px;margin-top:10px">
      <input type="text" name="q" value="${esc(q)}" placeholder="Search deals and companies…" style="margin-bottom:0">
      <button class="btn" type="submit">Search</button>
    </form>
  </div>
  ${q ? `<h2 class="sec-h">Deals matching “${esc(q)}”</h2>${dealsHtml}
         <h2 class="sec-h">Companies matching “${esc(q)}”</h2>${companiesHtml}` : ''}`;
  res.send(page('Search', body, req.user, req.query.msg, req.query.err));
});

app.get('/company/:id', requireCompany, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
  if (!c || c.status !== 'approved') {
    return res.redirect('/timeline?err=' + encodeURIComponent('Company not found.'));
  }
  const fc = followCounts(id);
  const deals = db.prepare('SELECT * FROM deals WHERE company_id = ? ORDER BY created_at DESC LIMIT 50').all(id);
  const names = companyNameMap();
  const dealsHtml = deals.length
    ? deals.map(d => feedCard({ kind: 'deal', ref_id: d.id, company_id: d.company_id, title: d.title, body: d.description, value: d.value, created_at: d.created_at }, req.user, names)).join('')
    : '<div class="card"><p class="muted">No deals yet.</p></div>';

  const body = `
  <div class="card">
    <div class="feed-head"><h2>${avatarHtml(c.name)}${esc(c.name)}</h2>${followButton(req.user, c.id)}</div>
    <p class="muted">${fc.followers} followers · ${fc.following} following · member since ${esc(c.created_at.slice(0, 10))}</p>
    ${c.website ? `<p style="margin-top:8px">🌐 <a href="${esc(c.website)}" rel="noopener noreferrer nofollow">${esc(c.website)}</a></p>` : ''}
    <p style="margin-top:10px;white-space:pre-wrap">${esc(c.description || '')}</p>
  </div>
  <h2 class="sec-h">Deals by ${esc(c.name)}</h2>
  ${dealsHtml}`;
  res.send(page(c.name, body, req.user, req.query.msg, req.query.err));
});

// ============================= CONTRACT ROUTES =============================
/** Standard B2B terms clauses shown on every contract. */
const CONTRACT_CLAUSES = [
  '1. PARTIES. This agreement is entered into between the deal-owning company ("Provider") and the signing company ("Counterparty"), both registered members of the Dealzoin B2B network.',
  '2. SCOPE. The Provider agrees to deliver the products/services described in the deal terms, and the Counterparty agrees to the stated deal value and conditions.',
  '3. PAYMENT. Payment terms are net-30 from invoice date unless otherwise agreed in writing between the parties.',
  '4. CONFIDENTIALITY. Both parties agree to keep all non-public business information exchanged under this agreement strictly confidential for a period of three (3) years.',
  '5. WARRANTIES. Each party warrants that it is duly organized, validly existing, and that the individual executing this agreement is an authorized signatory.',
  '6. LIABILITY. Neither party shall be liable for indirect, incidental, or consequential damages arising from this agreement.',
  '7. TERMINATION. Either party may terminate this agreement with thirty (30) days written notice, subject to settlement of outstanding obligations.',
  '8. GOVERNING LAW. This agreement shall be governed by the laws of the jurisdiction in which the Provider is registered.',
  '9. ENTIRE AGREEMENT. This document constitutes the entire agreement between the parties and supersedes all prior discussions.'
];

function getDealOr404(req, res) {
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!deal) {
    res.status(404).send(page('Not found', '<div class="card"><h2>Deal not found</h2></div>', currentUser(req)));
    return null;
  }
  return deal;
}
/** Latest contract for a deal (any signer). */
function latestContract(dealId) {
  return db.prepare('SELECT * FROM contracts WHERE deal_id = ? ORDER BY id DESC LIMIT 1').get(dealId);
}

// ----- Deal detail page: shows deal + contract status (visible to both parties) -----
app.get('/deal/:id', requireCompany, (req, res) => {
  const deal = getDealOr404(req, res);
  if (!deal) return;
  const owner = db.prepare('SELECT id, name FROM companies WHERE id = ?').get(deal.company_id);
  const contract = latestContract(deal.id);
  const names = companyNameMap();

  let contractHtml = '';
  if (contract && (req.user.id === contract.owner_company_id || req.user.id === contract.signer_company_id)) {
    const signerName = names.get(contract.signer_company_id) || 'Unknown';
    contractHtml = `<div class="card vault">
      <h3>Contract status: ${statusBadge(contract.status)}</h3>
      <p class="muted">Signed by <b>${esc(signerName)}</b> at ${esc(contract.signed_at.slice(0, 16).replace('T', ' '))} UTC
      ${contract.decided_at ? ' · decided ' + esc(contract.decided_at.slice(0, 16).replace('T', ' ')) + ' UTC' : ''}</p>
    </div>`;
  }

  const signBtn = req.user.id !== deal.company_id
    ? `<a class="btn btn-green" href="/deal/${deal.id}/contract">View contract &amp; sign</a>` : '';
  const body = `
  <div class="card card-deal">
    <div class="feed-head"><h2>${esc(deal.title)}</h2>
      ${deal.value ? `<div style="text-align:right"><div class="deal-value">${esc(deal.value)}</div><span class="muted">${esc(deal.created_at.slice(0, 16).replace('T', ' '))}</span></div>` : `<span class="muted">${esc(deal.created_at.slice(0, 16).replace('T', ' '))}</span>`}</div>
    <p class="muted">by ${avatarHtml(owner ? owner.name : '?')}<a href="/company/${deal.company_id}"><b>${esc(owner ? owner.name : 'Unknown')}</b></a></p>
    <p style="margin-top:12px;white-space:pre-wrap">${esc(deal.description)}</p>
    <div class="feed-actions">${signBtn}</div>
  </div>
  ${contractHtml}`;
  res.send(page(deal.title, body, req.user, req.query.msg, req.query.err));
});

// ----- Contract terms page -----
app.get('/deal/:id/contract', requireCompany, (req, res) => {
  const deal = getDealOr404(req, res);
  if (!deal) return;
  const owner = db.prepare('SELECT id, name FROM companies WHERE id = ?').get(deal.company_id);
  const me = db.prepare('SELECT id, name FROM companies WHERE id = ?').get(req.user.id);
  const isOwn = deal.company_id === req.user.id;
  const contract = latestContract(deal.id);

  const clauses = CONTRACT_CLAUSES.map(c => `<p style="margin-bottom:10px">${esc(c)}</p>`).join('');
  const existing = contract && (contract.status === 'pending' || contract.status === 'approved')
    ? `<p class="muted" style="margin-top:10px">A contract for this deal is currently <b>${esc(contract.status)}</b>.</p>` : '';

  const actions = isOwn
    ? `<p class="muted" style="margin-top:16px">This is your own deal — you cannot sign a contract with yourself.</p>`
    : `<div class="feed-actions" style="margin-top:18px">
         <a class="btn btn-outline" href="/deal/${deal.id}/contract/download">Download contract document</a>
         <a class="btn btn-green" href="/deal/${deal.id}/sign">Proceed with signing →</a>
       </div>`;

  const body = `
  <div class="card">
    <h2>B2B Contract — ${esc(deal.title)}</h2>
    <p class="muted">Generated ${esc(now().slice(0, 10))} · Deal #${deal.id}</p>
    <hr class="sep">
    <p><b>Provider:</b> ${esc(owner ? owner.name : 'Unknown')}</p>
    <p><b>Counterparty:</b> ${esc(me.name)}</p>
    ${deal.value ? `<p><b>Deal value:</b> <span class="deal-value" style="font-size:1.05rem">${esc(deal.value)}</span></p>` : ''}
    <h3 style="margin:14px 0 6px">Deal terms</h3>
    <p style="white-space:pre-wrap">${esc(deal.description)}</p>
    <h3 style="margin:14px 0 6px">Standard B2B terms</h3>
    <div class="muted" style="font-size:13px">${clauses}</div>
    ${existing}
    ${actions}
  </div>`;
  res.send(page('Contract — ' + deal.title, body, req.user, req.query.msg, req.query.err));
});

// ----- Download contract as a Word-compatible document -----
app.get('/deal/:id/contract/download', requireCompany, (req, res) => {
  const deal = getDealOr404(req, res);
  if (!deal) return;
  const owner = db.prepare('SELECT id, name FROM companies WHERE id = ?').get(deal.company_id);
  const me = db.prepare('SELECT id, name FROM companies WHERE id = ?').get(req.user.id);
  const clauses = CONTRACT_CLAUSES.map(c => `<p>${esc(c)}</p>`).join('');
  const doc = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
<head><meta charset="utf-8"><title>Contract #${deal.id}</title></head>
<body style="font-family:Calibri,Arial,sans-serif">
  <h1>B2B Contract — Deal #${deal.id}</h1>
  <h2>${esc(deal.title)}</h2>
  <p><b>Provider:</b> ${esc(owner ? owner.name : 'Unknown')}<br>
     <b>Counterparty:</b> ${esc(me.name)}<br>
     ${deal.value ? `<b>Deal value:</b> ${esc(deal.value)}<br>` : ''}
     <b>Generated:</b> ${esc(now())}</p>
  <h3>Deal terms</h3><p>${esc(deal.description)}</p>
  <h3>Standard B2B terms</h3>${clauses}
  <p>__________________________&nbsp;&nbsp;&nbsp;__________________________<br>
  Provider signature&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Counterparty signature</p>
</body></html>`;
  res.setHeader('Content-Type', 'application/msword');
  res.setHeader('Content-Disposition', `attachment; filename="contract-${deal.id}.doc"`);
  res.send(doc);
});

// ----- PRIVATE signing room: signer-to-be (non-owner), owner, and admin only -----
function canViewSigningRoom(req, deal, contract) {
  const user = currentUser(req);
  if (!user) return false;
  if (user.isAdmin) return true;
  if (user.id === deal.company_id) return true;                    // deal owner
  if (contract) return user.id === contract.signer_company_id;     // after signing: signer only
  return true;                                                     // before signing: any approved non-owner company may enter to sign
}

app.get('/deal/:id/sign', (req, res) => {
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!deal) return res.status(404).send(page('Not found', '<div class="card"><h2>Deal not found</h2></div>', currentUser(req)));
  const contract = latestContract(deal.id);
  if (!canViewSigningRoom(req, deal, contract)) {
    const user = currentUser(req);
    audit('AUTHENTICATION AGENT', 'signing room access', 'fail', `Unauthorized access attempt to deal #${deal.id} signing room by ${user ? user.name : 'anonymous'}`);
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Private signing room</h2><p class="muted">Only the two contracting parties and the admin can view this page.</p></div>', user));
  }
  const user = currentUser(req);
  if (!user || user.isAdmin) {
    // Admin can view but not sign; companies must be logged in anyway.
    if (!user) return res.redirect('/login?err=' + encodeURIComponent('Please sign in.'));
  }
  const owner = db.prepare('SELECT id, name FROM companies WHERE id = ?').get(deal.company_id);
  const isOwn = !user.isAdmin && user.id === deal.company_id;

  const signForm = (!user.isAdmin && !isOwn && !(contract && contract.status !== 'rejected')) ? `
    <form method="POST" action="/deal/${deal.id}/sign">
      <label>Re-enter your account password (signing authority check)</label>
      <input type="password" name="password" required>
      <label style="display:flex;gap:8px;align-items:center;margin:10px 0">
        <input type="checkbox" name="authorized" value="yes" style="width:auto;margin:0" required>
        I am an authorized signatory of my company</label>
      <label style="display:flex;gap:8px;align-items:center;margin:10px 0">
        <input type="checkbox" name="agree" value="yes" style="width:auto;margin:0" required>
        I agree to the terms of this contract</label>
      <button class="btn btn-green" type="submit" onclick="this.textContent='Verifying signature…'">Verify &amp; sign</button>
    </form>` : (user.isAdmin
      ? '<p class="muted" style="margin-top:14px">Admin view — signing is performed by the counterparty company.</p>'
      : '<p class="muted" style="margin-top:14px">This is your own deal — the counterparty signs here.</p>');

  const body = `
  <div class="card vault">
    <div class="kicker" style="margin-bottom:6px">Vault-secure · AI-guarded</div>
    <h2>🔒 Private signing room — Deal #${deal.id}</h2>
    <p class="muted">Access restricted to the contracting parties and the admin. All checks are logged by the Authentication Agent.</p>
    <hr class="sep">
    <p><b>Deal:</b> ${esc(deal.title)}</p>
    ${deal.value ? `<p><b>Value:</b> <span class="deal-value" style="font-size:1.05rem">${esc(deal.value)}</span></p>` : ''}
    <p><b>Provider:</b> ${esc(owner ? owner.name : 'Unknown')}</p>
    ${contract ? `<p><b>Counterparty (signer):</b> ${esc((db.prepare('SELECT name FROM companies WHERE id = ?').get(contract.signer_company_id) || {}).name || 'Unknown')}
      · status ${statusBadge(contract.status)} · signed at ${esc(contract.signed_at.slice(0, 16).replace('T', ' '))} UTC</p>` : ''}
    <h3 style="margin:12px 0 6px">Terms summary</h3>
    <p style="white-space:pre-wrap">${esc(deal.description)}</p>
    <hr class="sep">
    ${signForm}
  </div>`;
  res.send(page('Signing room', body, user, req.query.msg, req.query.err));
});

// ----- Signing action: AUTHENTICATION AGENT re-verifies the signer -----
app.post('/deal/:id/sign', requireCompany, (req, res) => {
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!deal) return res.redirect('/timeline?err=' + encodeURIComponent('Deal not found.'));

  // Server-side guard: a company cannot sign its OWN deal.
  if (deal.company_id === req.user.id) {
    audit('AUTHENTICATION AGENT', 'signing self-deal guard', 'fail', `${req.user.name} attempted to sign own deal #${deal.id}`);
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — You cannot sign your own deal.</h2></div>', req.user));
  }
  // One live contract per deal.
  const existing = latestContract(deal.id);
  if (existing && (existing.status === 'pending' || existing.status === 'approved')) {
    return res.redirect(`/deal/${deal.id}/sign?err=` + encodeURIComponent('A contract for this deal is already ' + existing.status + '.'));
  }

  // (a) signer must re-enter their account password (signing authority check)
  const me = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.user.id);
  if (!verifyPassword(String(req.body.password || ''), me.salt, me.password_hash)) {
    audit('AUTHENTICATION AGENT', 'signing password re-verification', 'fail', `Wrong password at signing for ${me.email} (deal #${deal.id})`);
    return res.redirect(`/deal/${deal.id}/sign?err=` + encodeURIComponent('Password verification failed.'));
  }
  audit('AUTHENTICATION AGENT', 'signing password re-verification', 'pass', `Password re-verified for ${me.email} (deal #${deal.id})`);

  // (b) authorized-signatory checkbox
  if (req.body.authorized !== 'yes') {
    audit('AUTHENTICATION AGENT', 'signatory authority checkbox', 'fail', `Not confirmed by ${me.email} (deal #${deal.id})`);
    return res.redirect(`/deal/${deal.id}/sign?err=` + encodeURIComponent('You must confirm you are an authorized signatory.'));
  }
  audit('AUTHENTICATION AGENT', 'signatory authority checkbox', 'pass', `Authorized signatory confirmed by ${me.email}`);

  // (c) agree-to-terms checkbox
  if (req.body.agree !== 'yes') {
    audit('AUTHENTICATION AGENT', 'terms agreement checkbox', 'fail', `Terms not accepted by ${me.email} (deal #${deal.id})`);
    return res.redirect(`/deal/${deal.id}/sign?err=` + encodeURIComponent('You must agree to the terms.'));
  }
  audit('AUTHENTICATION AGENT', 'terms agreement checkbox', 'pass', `Terms accepted by ${me.email}`);

  // (d) record timestamp + create the contract (pending admin approval)
  const ts = now();
  db.prepare(`INSERT INTO contracts (deal_id, signer_company_id, owner_company_id, status, signed_at, created_at)
              VALUES (?,?,?, 'pending', ?, ?)`)
    .run(deal.id, req.user.id, deal.company_id, ts, ts);
  audit('AUTHENTICATION AGENT', 'contract signed', 'pass', `${me.name} signed deal #${deal.id} at ${ts} — pending admin approval`);

  res.redirect(`/deal/${deal.id}?msg=` + encodeURIComponent('Contract signed! It is now pending admin approval.'));
});

// ============================= ADMIN ROUTES =============================
/** Verify admin credentials: settings-table password override wins, env var is fallback. */
function adminPasswordOk(pw) {
  const overrideHash = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password_hash');
  const overrideSalt = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password_salt');
  if (overrideHash && overrideSalt) return verifyPassword(pw, overrideSalt.value, overrideHash.value);
  return safeEqualPlain(pw, ADMIN_PASSWORD);
}

app.get('/admin', (req, res) => {
  const user = currentUser(req);
  if (!user || !user.isAdmin) {
    const body = `
    <div class="card" style="max-width:420px;margin:0 auto">
      <h2>🛡️ Admin sign in</h2>
      <form method="POST" action="/admin/login">
        <label>Admin email</label><input type="email" name="email" required>
        <label>Password</label><input type="password" name="password" required>
        <button class="btn" type="submit">Sign in</button>
      </form>
    </div>`;
    return res.send(page('Admin', body, null, req.query.msg, req.query.err));
  }
  res.redirect('/admin/dashboard');
});

app.post('/admin/login', (req, res) => {
  const em = String(req.body.email || '').trim().toLowerCase();
  const pw = String(req.body.password || '');
  if (em !== ADMIN_EMAIL.toLowerCase() || !adminPasswordOk(pw)) {
    audit('AUTHENTICATION AGENT', 'admin login', 'fail', `Failed admin login for ${em}`);
    return res.redirect('/admin?err=' + encodeURIComponent('Invalid admin credentials.'));
  }
  audit('AUTHENTICATION AGENT', 'admin login', 'pass', `Admin ${em} signed in`);
  createSession(req, res, null, true);
  res.redirect('/admin/dashboard');
});

app.post('/admin/logout', (req, res) => {
  destroySession(req, res);
  res.redirect('/admin?msg=' + encodeURIComponent('Admin signed out.'));
});

// ----- Admin dashboard -----
app.get('/admin/dashboard', requireAdmin, (req, res) => {
  const count = (sql, ...args) => db.prepare(sql).get(...args).n;
  const stats = {
    companies: count('SELECT COUNT(*) AS n FROM companies'),
    pending: count(`SELECT COUNT(*) AS n FROM companies WHERE status = 'pending'`),
    approved: count(`SELECT COUNT(*) AS n FROM companies WHERE status = 'approved'`),
    flagged: count('SELECT COUNT(*) AS n FROM companies WHERE flagged = 1'),
    deals: count('SELECT COUNT(*) AS n FROM deals'),
    contractsPending: count(`SELECT COUNT(*) AS n FROM contracts WHERE status = 'pending'`),
    follows: count('SELECT COUNT(*) AS n FROM follows')
  };
  const statsHtml = `<div class="stats">${[
    ['Total companies', stats.companies, ''], ['Pending', stats.pending, ''], ['Approved', stats.approved, ' mint'],
    ['Flagged ⚠️', stats.flagged, ''], ['Deals', stats.deals, ' gold'], ['Contracts pending', stats.contractsPending, ' gold'],
    ['Follows', stats.follows, '']
  ].map(([l, n, cls]) => `<div class="stat"><div class="num${cls}">${n}</div><div class="lbl">${l}</div></div>`).join('')}</div>`;

  // Pending companies queue (with ONBOARDING AGENT flags)
  const pending = db.prepare(`SELECT * FROM companies WHERE status = 'pending' ORDER BY created_at ASC`).all();
  const pendingHtml = pending.length ? pending.map(c => `
    <tr>
      <td><b>${esc(c.name)}</b> ${c.flagged ? '<span class="warn-badge"><i class="warn-ic">⚠️</i> flagged</span>' : ''}<br>
        <span class="muted">${esc(c.email)}${c.website ? ' · ' + esc(c.website) : ''}</span>
        ${c.flagged ? `<br><span class="flag-note">${esc(c.flag_reasons)}</span>` : ''}</td>
      <td class="muted">${esc(c.created_at.slice(0, 10))}</td>
      <td style="white-space:nowrap">
        <form method="POST" action="/admin/companies/${c.id}/approve" style="display:inline"><button class="btn btn-sm btn-green">Approve</button></form>
        <form method="POST" action="/admin/companies/${c.id}/reject" style="display:inline"><button class="btn btn-sm btn-danger">Reject</button></form>
      </td>
    </tr>`).join('') : '<tr><td colspan="3" class="muted">No pending reviews. The agents are holding the fort. 🛡️</td></tr>';

  // Pending contracts queue
  const names = companyNameMap();
  const pendingContracts = db.prepare(`SELECT * FROM contracts WHERE status = 'pending' ORDER BY signed_at ASC`).all();
  const contractsHtml = pendingContracts.length ? pendingContracts.map(ct => {
    const deal = db.prepare('SELECT title FROM deals WHERE id = ?').get(ct.deal_id);
    return `<tr>
      <td><b>${esc(deal ? deal.title : '(deal removed)')}</b> <span class="muted">#${ct.deal_id}</span></td>
      <td>${esc(names.get(ct.owner_company_id) || '?')} ⇄ ${esc(names.get(ct.signer_company_id) || '?')}</td>
      <td class="muted">${esc(ct.signed_at.slice(0, 16).replace('T', ' '))}</td>
      <td style="white-space:nowrap">
        <form method="POST" action="/admin/contracts/${ct.id}/approve" style="display:inline"><button class="btn btn-sm btn-green">Approve</button></form>
        <form method="POST" action="/admin/contracts/${ct.id}/reject" style="display:inline"><button class="btn btn-sm btn-danger">Reject</button></form>
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="4" class="muted">No contracts awaiting approval.</td></tr>';

  // All companies (suspend / reactivate / delete)
  const allCompanies = db.prepare('SELECT * FROM companies ORDER BY created_at DESC LIMIT 100').all();
  const companiesHtml = allCompanies.map(c => {
    const actions = [];
    if (c.status === 'approved') actions.push(`<form method="POST" action="/admin/companies/${c.id}/suspend" style="display:inline"><button class="btn btn-sm btn-outline">Suspend</button></form>`);
    if (c.status === 'suspended' || c.status === 'rejected') actions.push(`<form method="POST" action="/admin/companies/${c.id}/reactivate" style="display:inline"><button class="btn btn-sm btn-green">Reactivate</button></form>`);
    actions.push(`<form method="POST" action="/admin/companies/${c.id}/delete" style="display:inline" onsubmit="return confirm('Delete ${esc(c.name)} and ALL their data?')"><button class="btn btn-sm btn-danger">Delete</button></form>`);
    return `<tr>
      <td><b>${esc(c.name)}</b> ${c.flagged ? '<span class="warn-badge"><i class="warn-ic">⚠️</i></span>' : ''}<br><span class="muted">${esc(c.email)}</span></td>
      <td>${statusBadge(c.status)}</td>
      <td style="white-space:nowrap">${actions.join(' ')}</td>
    </tr>`;
  }).join('');

  // All deals (admin can remove)
  const allDeals = db.prepare('SELECT * FROM deals ORDER BY created_at DESC LIMIT 100').all();
  const dealsHtml = allDeals.length ? allDeals.map(d => `<tr>
      <td><b>${esc(d.title)}</b><br><span class="muted">${esc(names.get(d.company_id) || '?')} · ${esc(d.created_at.slice(0, 10))}${d.value ? ' · ' + esc(d.value) : ''}</span></td>
      <td><form method="POST" action="/admin/deals/${d.id}/delete" style="display:inline" onsubmit="return confirm('Remove this deal?')"><button class="btn btn-sm btn-danger">Remove</button></form></td>
    </tr>`).join('') : '<tr><td colspan="2" class="muted">No deals yet.</td></tr>';

  // Agent activity — 50 most recent audit entries
  const auditRows = db.prepare('SELECT * FROM agent_audit ORDER BY id DESC LIMIT 50').all();
  const auditHtml = auditRows.length ? auditRows.map(a => `<tr>
      <td class="muted" style="white-space:nowrap">${esc(a.created_at.slice(0, 19).replace('T', ' '))}</td>
      <td>${esc(a.agent)}</td><td>${esc(a.action)}</td><td>${resultBadge(a.result)}</td><td class="muted">${esc(a.details)}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="muted">No agent activity yet.</td></tr>';

  const body = `
  <h2 class="sec-h" style="margin-top:0;margin-bottom:14px">🛡️ Admin dashboard</h2>
  ${statsHtml}
  <div class="card"><h3>Pending companies</h3>
    <table><tr><th>Company</th><th>Registered</th><th>Actions</th></tr>${pendingHtml}</table></div>
  <div class="card"><h3>Pending contracts</h3>
    <table><tr><th>Deal</th><th>Parties</th><th>Signed at</th><th>Actions</th></tr>${contractsHtml}</table></div>
  <div class="card"><h3>All companies</h3>
    <table><tr><th>Company</th><th>Status</th><th>Actions</th></tr>${companiesHtml}</table></div>
  <div class="card"><h3>All deals</h3>
    <table><tr><th>Deal</th><th>Actions</th></tr>${dealsHtml}</table></div>
  <div class="card"><h3>Change admin password</h3>
    <form method="POST" action="/admin/password" style="max-width:380px">
      <label>Current password</label><input type="password" name="current" required>
      <label>New password (min 10 characters)</label><input type="password" name="next" required minlength="10">
      <button class="btn btn-sm" type="submit">Update password</button>
      <p class="muted" style="margin-top:8px">Stored as a salted hash in the settings table; the env var remains a fallback until changed.</p>
    </form></div>
  <div class="card"><h3>🤖 Agent activity (latest 50)</h3>
    <table><tr><th>Time (UTC)</th><th>Agent</th><th>Action</th><th>Result</th><th>Details</th></tr>${auditHtml}</table></div>`;
  res.send(page('Admin dashboard', body, req.user, req.query.msg, req.query.err));
});

// ----- Company moderation -----
app.post('/admin/companies/:id/approve', requireAdmin, (req, res) => {
  const c = db.prepare('SELECT * FROM companies WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!c) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Company not found.'));
  db.prepare(`UPDATE companies SET status = 'approved' WHERE id = ?`).run(c.id);
  audit('ONBOARDING AGENT', 'admin approve company', 'pass', `Admin approved "${c.name}"`);
  res.redirect('/admin/dashboard?msg=' + encodeURIComponent(`Approved ${c.name}.`));
});
app.post('/admin/companies/:id/reject', requireAdmin, (req, res) => {
  const c = db.prepare('SELECT * FROM companies WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!c) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Company not found.'));
  db.prepare(`UPDATE companies SET status = 'rejected' WHERE id = ?`).run(c.id);
  audit('ONBOARDING AGENT', 'admin reject company', 'fail', `Admin rejected "${c.name}"`);
  res.redirect('/admin/dashboard?msg=' + encodeURIComponent(`Rejected ${c.name}.`));
});
app.post('/admin/companies/:id/suspend', requireAdmin, (req, res) => {
  const c = db.prepare('SELECT * FROM companies WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!c) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Company not found.'));
  db.prepare(`UPDATE companies SET status = 'suspended' WHERE id = ?`).run(c.id);
  db.prepare('DELETE FROM sessions WHERE company_id = ?').run(c.id); // kill active sessions
  audit('ONBOARDING AGENT', 'admin suspend company', 'flag', `Admin suspended "${c.name}"`);
  res.redirect('/admin/dashboard?msg=' + encodeURIComponent(`Suspended ${c.name}.`));
});
app.post('/admin/companies/:id/reactivate', requireAdmin, (req, res) => {
  const c = db.prepare('SELECT * FROM companies WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!c) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Company not found.'));
  db.prepare(`UPDATE companies SET status = 'approved' WHERE id = ?`).run(c.id);
  audit('ONBOARDING AGENT', 'admin reactivate company', 'pass', `Admin reactivated "${c.name}"`);
  res.redirect('/admin/dashboard?msg=' + encodeURIComponent(`Reactivated ${c.name}.`));
});
app.post('/admin/companies/:id/delete', requireAdmin, (req, res) => {
  const c = db.prepare('SELECT * FROM companies WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!c) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Company not found.'));
  const id = c.id;
  // Delete cascades ALL company data: posts, deals (+their social graph), likes,
  // comments, follows, reposts, contracts, sessions, verification codes.
  const wipe = db.transaction(() => {
    const dealIds = db.prepare('SELECT id FROM deals WHERE company_id = ?').all(id).map(r => r.id);
    const postIds = db.prepare('SELECT id FROM posts WHERE company_id = ?').all(id).map(r => r.id);
    for (const d of dealIds) {
      db.prepare(`DELETE FROM likes WHERE target_type = 'deal' AND target_id = ?`).run(d);
      db.prepare(`DELETE FROM comments WHERE target_type = 'deal' AND target_id = ?`).run(d);
      db.prepare('DELETE FROM reposts WHERE deal_id = ?').run(d);
      db.prepare('DELETE FROM contracts WHERE deal_id = ?').run(d);
    }
    for (const p of postIds) {
      db.prepare(`DELETE FROM likes WHERE target_type = 'post' AND target_id = ?`).run(p);
      db.prepare(`DELETE FROM comments WHERE target_type = 'post' AND target_id = ?`).run(p);
    }
    db.prepare('DELETE FROM deals WHERE company_id = ?').run(id);
    db.prepare('DELETE FROM posts WHERE company_id = ?').run(id);
    db.prepare('DELETE FROM likes WHERE company_id = ?').run(id);
    db.prepare('DELETE FROM comments WHERE company_id = ?').run(id);
    db.prepare('DELETE FROM reposts WHERE company_id = ?').run(id);
    db.prepare('DELETE FROM follows WHERE follower_id = ? OR followed_id = ?').run(id, id);
    db.prepare('DELETE FROM contracts WHERE signer_company_id = ? OR owner_company_id = ?').run(id, id);
    db.prepare('DELETE FROM sessions WHERE company_id = ?').run(id);
    db.prepare('DELETE FROM verification_codes WHERE company_id = ?').run(id);
    db.prepare('DELETE FROM companies WHERE id = ?').run(id);
  });
  wipe();
  audit('ONBOARDING AGENT', 'admin delete company', 'fail', `Admin deleted "${c.name}" and all associated data`);
  res.redirect('/admin/dashboard?msg=' + encodeURIComponent(`Deleted ${c.name} and all their data.`));
});

// ----- Deal moderation -----
app.post('/admin/deals/:id/delete', requireAdmin, (req, res) => {
  const d = db.prepare('SELECT * FROM deals WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!d) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Deal not found.'));
  const wipe = db.transaction(() => {
    db.prepare(`DELETE FROM likes WHERE target_type = 'deal' AND target_id = ?`).run(d.id);
    db.prepare(`DELETE FROM comments WHERE target_type = 'deal' AND target_id = ?`).run(d.id);
    db.prepare('DELETE FROM reposts WHERE deal_id = ?').run(d.id);
    db.prepare('DELETE FROM contracts WHERE deal_id = ?').run(d.id);
    db.prepare('DELETE FROM deals WHERE id = ?').run(d.id);
  });
  wipe();
  audit('ONBOARDING AGENT', 'admin remove deal', 'flag', `Admin removed deal #${d.id} "${d.title}"`);
  res.redirect('/admin/dashboard?msg=' + encodeURIComponent('Deal removed.'));
});

// ----- Contract approval queue -----
app.post('/admin/contracts/:id/approve', requireAdmin, (req, res) => {
  const ct = db.prepare('SELECT * FROM contracts WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!ct) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Contract not found.'));
  db.prepare(`UPDATE contracts SET status = 'approved', decided_at = ? WHERE id = ?`).run(now(), ct.id);
  // TODO PHASE 3 — PAYMENT-ESCROW AGENT: when admin approves a contract, hook Stripe escrow initiation here (create escrow, notify both parties, release funds on delivery confirmation). Not implemented in this version.
  audit('AUTHENTICATION AGENT', 'admin approve contract', 'pass', `Contract #${ct.id} (deal #${ct.deal_id}) approved by admin`);
  res.redirect('/admin/dashboard?msg=' + encodeURIComponent('Contract approved. Both parties can now see it on the deal page.'));
});
app.post('/admin/contracts/:id/reject', requireAdmin, (req, res) => {
  const ct = db.prepare('SELECT * FROM contracts WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!ct) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Contract not found.'));
  db.prepare(`UPDATE contracts SET status = 'rejected', decided_at = ? WHERE id = ?`).run(now(), ct.id);
  audit('AUTHENTICATION AGENT', 'admin reject contract', 'fail', `Contract #${ct.id} (deal #${ct.deal_id}) rejected by admin`);
  res.redirect('/admin/dashboard?msg=' + encodeURIComponent('Contract rejected.'));
});

// ----- Change admin password (settings override; env var is fallback) -----
app.post('/admin/password', requireAdmin, (req, res) => {
  const current = String(req.body.current || '');
  const next = String(req.body.next || '');
  if (!adminPasswordOk(current)) {
    audit('AUTHENTICATION AGENT', 'admin password change', 'fail', 'Wrong current password');
    return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Current password is incorrect.'));
  }
  if (next.length < 10) {
    return res.redirect('/admin/dashboard?err=' + encodeURIComponent('New password must be at least 10 characters.'));
  }
  const salt = newSalt();
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  upsert.run('admin_password_hash', hashPassword(next, salt));
  upsert.run('admin_password_salt', salt);
  audit('AUTHENTICATION AGENT', 'admin password change', 'pass', 'Admin password updated (hashed override stored)');
  res.redirect('/admin/dashboard?msg=' + encodeURIComponent('Admin password updated.'));
});

// ============================= 404 & SERVER START =============================
app.use((req, res) => {
  res.status(404).send(page('Not found', '<div class="card"><h2>404 — page not found</h2><p class="muted"><a href="/">Back to home</a></p></div>', currentUser(req)));
});

app.listen(PORT, () => {
  console.log(`Dealzoin listening on http://localhost:${PORT}`);
  console.log(`Admin login: ${ADMIN_EMAIL} (env-configured)${BREVO_API_KEY ? '' : ' — DEMO MODE: verification codes shown on screen'}`);
});
