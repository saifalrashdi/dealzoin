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
const multer = require('multer');

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
CREATE TABLE IF NOT EXISTS conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL DEFAULT 'private',        -- 'private' | 'group'
  name       TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id INTEGER NOT NULL,
  company_id      INTEGER NOT NULL,
  UNIQUE(conversation_id, company_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id   INTEGER NOT NULL,
  sender_company_id INTEGER NOT NULL,
  body              TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS media (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  mime       TEXT NOT NULL,
  filename   TEXT DEFAULT '',
  data       BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS counter_offers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id         INTEGER NOT NULL,
  from_company_id INTEGER NOT NULL,
  new_value       TEXT DEFAULT '',
  new_currency    TEXT DEFAULT 'USD',
  new_terms       TEXT DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'pending',     -- pending | accepted | refused
  created_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS private_contracts (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_company_id    INTEGER NOT NULL,
  recipient_company_id INTEGER NOT NULL,
  title                TEXT NOT NULL,
  value                REAL,
  currency             TEXT DEFAULT 'USD',
  terms                TEXT DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'pending_recipient', -- pending_recipient | pending_owner | pending_admin | approved | rejected
  signed_at            TEXT,
  decided_at           TEXT,
  created_at           TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  type       TEXT NOT NULL,
  text       TEXT NOT NULL,
  link       TEXT DEFAULT '',
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`);

// Graceful upgrades for databases created before media support existed.
try { db.exec('ALTER TABLE deals ADD COLUMN media_id INTEGER'); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE posts ADD COLUMN media_id INTEGER'); } catch (e) { /* column already exists */ }

// Graceful upgrades for databases created before these features existed.
try { db.exec("ALTER TABLE deals ADD COLUMN currency TEXT DEFAULT 'USD'"); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE deals ADD COLUMN time_period TEXT DEFAULT '30 days'"); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE deals ADD COLUMN contract_state TEXT DEFAULT NULL'); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE deals ADD COLUMN contract_party TEXT DEFAULT NULL'); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE conversation_members ADD COLUMN last_read_at TEXT'); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE companies ADD COLUMN avatar_media_id INTEGER'); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE companies ADD COLUMN header_media_id INTEGER'); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE companies ADD COLUMN bio TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE companies ADD COLUMN about TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }
// v4 upgrades: reputation scale, Research Agent intel, OTP payloads for signing/counter flows.
try { db.exec('ALTER TABLE companies ADD COLUMN reputation INTEGER DEFAULT 0'); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE companies ADD COLUMN market_value TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE companies ADD COLUMN field TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE companies ADD COLUMN employees TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE companies ADD COLUMN research_source TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE verification_codes ADD COLUMN payload TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }

// ============================= PLATFORM COMMISSION =============================
const PLATFORM_FEE_PCT = 1; // transparent 1% Dealzoin commission on every deal
/** Parse a numeric amount out of a free-text deal value ("50,000 / year" -> 50000). NaN if none. */
function parseDealValue(value) {
  const m = String(value || '').replace(/[,\s]/g, '').match(/\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
}
function fmtAmount(n) {
  const r = Math.round(n * 100) / 100;
  return (r % 1 === 0 ? r.toString() : r.toFixed(2)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
/** "Platform fee: 1% (100 EUR) — transparent Dealzoin commission" line for deal surfaces. */
function feeLineHtml(deal, style) {
  const cur = deal.currency || 'USD';
  const num = parseDealValue(deal.value);
  const amount = isFinite(num) && num > 0
    ? `${fmtAmount(num * PLATFORM_FEE_PCT / 100)} ${esc(cur)}`
    : `1% of deal value`;
  const inner = isFinite(num) && num > 0
    ? `Platform fee: ${PLATFORM_FEE_PCT}% (${amount}) — transparent Dealzoin commission`
    : `Platform fee: ${PLATFORM_FEE_PCT}% of deal value — transparent Dealzoin commission`;
  return `<div class="muted" style="font-size:12px;${style || ''}">🏦 ${inner}</div>`;
}
/** Plain-text fee line for the downloadable contract document. */
function feeLineText(deal) {
  const cur = deal.currency || 'USD';
  const num = parseDealValue(deal.value);
  return isFinite(num) && num > 0
    ? `Platform fee: ${PLATFORM_FEE_PCT}% (${fmtAmount(num * PLATFORM_FEE_PCT / 100)} ${cur}) — transparent Dealzoin commission`
    : `Platform fee: ${PLATFORM_FEE_PCT}% of deal value — transparent Dealzoin commission`;
}

// ============================= MEDIA UPLOADS (MULTER) =============================
// Images: jpg/jpeg/png/gif/webp up to 5 MB. Videos: mp4/webm up to 25 MB.
const MEDIA_IMAGE_EXT = { jpg: 1, jpeg: 1, png: 1, gif: 1, webp: 1 };
const MEDIA_VIDEO_EXT = { mp4: 1, webm: 1 };
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const VIDEO_MAX_BYTES = 25 * 1024 * 1024;
const MEDIA_RULES_MSG = 'Only JPG, PNG, GIF or WEBP images (max 5 MB) and MP4 or WEBM videos (max 25 MB) are allowed.';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: VIDEO_MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = String(file.originalname || '').split('.').pop().toLowerCase();
    const mime = String(file.mimetype || '').toLowerCase();
    const okImage = MEDIA_IMAGE_EXT[ext] && mime.startsWith('image/');
    const okVideo = MEDIA_VIDEO_EXT[ext] && mime.startsWith('video/');
    if (okImage || okVideo) return cb(null, true);
    cb(new Error(MEDIA_RULES_MSG));
  }
});

/** Multer middleware for the "media" field with friendly error redirects. Pass-through for urlencoded forms. */
function mediaUpload(req, res, next) {
  upload.single('media')(req, res, (err) => {
    const back = (req.get('referer') || '/new').split('?')[0];
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File too large — images max 5 MB, videos max 25 MB.' : (err.message || MEDIA_RULES_MSG);
      return res.redirect(back + '?err=' + encodeURIComponent(msg));
    }
    if (req.file) {
      const ext = String(req.file.originalname || '').split('.').pop().toLowerCase();
      if (!MEDIA_VIDEO_EXT[ext] && req.file.size > IMAGE_MAX_BYTES) {
        return res.redirect(back + '?err=' + encodeURIComponent('Images are limited to 5 MB.'));
      }
      // Magic-byte sniffing: the file's real signature must match its claimed type.
      const b = req.file.buffer;
      const sig = {
        png:  b.length > 3 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47,
        jpg:  b.length > 2 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF,
        gif:  b.length > 5 && b.toString('latin1', 0, 4) === 'GIF8',
        webp: b.length > 11 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
        mp4:  b.length > 11 && b.toString('latin1', 4, 8) === 'ftyp',
        webm: b.length > 3 && b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3,
      };
      const realImage = sig.png || sig.jpg || sig.gif || sig.webp;
      const realVideo = sig.mp4 || sig.webm;
      if (!realImage && !realVideo) {
        return res.redirect(back + '?err=' + encodeURIComponent('Upload rejected: file content does not look like a real image or video.'));
      }
      if (realImage && !MEDIA_IMAGE_EXT[ext]) return res.redirect(back + '?err=' + encodeURIComponent(MEDIA_RULES_MSG));
      if (realVideo && !MEDIA_VIDEO_EXT[ext]) return res.redirect(back + '?err=' + encodeURIComponent(MEDIA_RULES_MSG));
    }
    next();
  });
}

/** Persist an uploaded file to the media table; returns the new media id. */
function saveMedia(companyId, file) {
  const info = db.prepare('INSERT INTO media (company_id, mime, filename, data, created_at) VALUES (?,?,?,?,?)')
    .run(companyId, String(file.mimetype).toLowerCase(), String(file.originalname || '').slice(0, 200), file.buffer, now());
  return info.lastInsertRowid;
}

/** Render an attached image/video inside a feed or deal card. */
function mediaHtml(mediaId) {
  if (!mediaId) return '';
  const m = db.prepare('SELECT id, mime FROM media WHERE id = ?').get(mediaId);
  if (!m) return '';
  if (String(m.mime).startsWith('video/')) {
    return `<div class="card-media"><video controls muted playsinline preload="metadata" src="/media/${m.id}"></video></div>`;
  }
  return `<div class="card-media"><img src="/media/${m.id}" alt="Attached media" loading="lazy"></div>`;
}

/** JSON safely embeddable inside an inline <script> tag. */
function jsonForHtml(obj) {
  return JSON.stringify(obj).replace(/&/g, '\\u0026').replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

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

// ============================= NOTIFICATIONS =============================
/** Insert an in-app notification for a company (bell icon + /notifications page). */
function notify(companyId, type, text, link) {
  if (!companyId) return;
  db.prepare('INSERT INTO notifications (company_id, type, text, link, is_read, created_at) VALUES (?,?,?,?,0,?)')
    .run(companyId, String(type || 'info').slice(0, 40), String(text || '').slice(0, 500), String(link || '').slice(0, 200), now());
}
function unreadNotifications(companyId) {
  return db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE company_id = ? AND is_read = 0').get(companyId).n;
}
/** Received private contracts awaiting the recipient's action (drives the nav badge). */
function unreadPrivateContracts(companyId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM private_contracts WHERE recipient_company_id = ? AND status = 'pending_recipient'`).get(companyId).n;
}

// ============================= REPUTATION STARS =============================
/** Gold star rating for a reputation score (1–5); 0/NULL renders muted "Unrated". */
function starsHtml(rep, small) {
  const r = parseInt(rep, 10) || 0;
  const size = small ? 'font-size:12px;' : 'font-size:14px;';
  if (r < 1 || r > 5) return `<span class="muted" style="${size}">Unrated</span>`;
  const stars = '★'.repeat(r) + '<span style="opacity:0.35">' + '★'.repeat(5 - r) + '</span>';
  return `<span style="color:var(--gold);${size};letter-spacing:1px" title="Reputation ${r}/5" aria-label="Reputation ${r} out of 5 stars">${stars}</span>`;
}
/** Reputation score for a company id (0 = unrated). */
function companyReputation(companyId) {
  const row = db.prepare('SELECT reputation FROM companies WHERE id = ?').get(companyId);
  return row ? (row.reputation || 0) : 0;
}

// ----- Contract state machine: pending_owner -> pending_admin -> finalized (row deleted) -----
const LIVE_CONTRACT_STATUSES = ['pending', 'pending_owner', 'pending_admin']; // 'pending' = legacy pre-v4 rows
function isLiveContract(ct) { return !!ct && LIVE_CONTRACT_STATUSES.includes(ct.status); }

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
// "The Gilded Ledger" theme (BRAND2) — Midnight Floor dark / Day Ledger light.
// Craft layers: reeded coin edges, banknote guilloché, sealed-letter mailbox.
const CSS = `
  :root {
    --bg-void:       #0A0912;
    --bg-elevated:   #0F0D19;
    --bg-spotlight:  #1B1929;
    --surface-card:  #15131F;
    --surface-deal:  linear-gradient(165deg, #1E1A30 0%, #14121E 55%, #171322 100%);
    --gold:          #F5B942;
    --gold-deep:     #C98A1E;
    --gold-glow:     rgba(245,185,66,0.16);
    --mint:          #3FE0B0;
    --mint-deep:     #1FAF85;
    --ink-primary:   #F5F0E4;
    --ink-muted:     #A39FB2;
    --ink-faint:     #5C5A6B;
    --success:       #3FE0B0;
    --warning:       #FFB454;
    --danger:        #FF5C7A;
    --danger-deep:   #C93A56;
    --border-soft:   #262438;
    --border-gold:   rgba(245,185,66,0.38);
    --gradient-coin: linear-gradient(120deg, #F5B942 0%, #FFE1A0 45%, #C98A1E 100%);
    --gold-bright:   #FFD97A;
    --on-gold:       #241A05;
    --on-mint:       #FFF7F0;
    --on-danger:     #FFF7F0;
    --bg-glow:       radial-gradient(1200px 600px at 50% -10%, rgba(245,185,66,0.07), transparent 60%);
    --nav-bg:        rgba(10,9,18,0.85);
    --media-bg:      #0A0912;
    --row-hover:     rgba(27,25,41,0.5);
    --bubble-mine-bg: linear-gradient(160deg, #33280F 0%, #231B0B 100%);
    --bubble-theirs-bg: #1E1B2D;
    --card-shadow:        0 10px 34px rgba(0,0,0,0.50);
    --card-shadow-hover:  0 16px 44px rgba(0,0,0,0.55);
    --card-inset:         inset 0 1px 0 rgba(255,217,122,0.10);
    --input-bg:      #12101C;
    --input-border:  #2A2840;
    --ok-bg:         rgba(63,224,176,0.12);
    --ok-border:     rgba(63,224,176,0.4);
    --ok-badge-bg:   rgba(63,224,176,0.13);
    --ok-badge-border: rgba(63,224,176,0.3);
    --err-bg:        rgba(255,92,122,0.12);
    --err-border:    rgba(255,92,122,0.4);
    --err-badge-border: rgba(255,92,122,0.3);
    --warn-bg:       rgba(255,180,84,0.13);
    --warn-border:   rgba(255,180,84,0.35);
    --warn-badge-border: rgba(255,180,84,0.3);
    --badge-flag-bg: rgba(255,92,122,0.12);
    --badge-flag-fg: #FF7A92;
    --gold-shadow-sm: 0 2px 12px rgba(245,185,66,0.35);
    --gold-shadow-md: 0 4px 18px rgba(245,185,66,0.28);
    --gold-shadow-lg: 0 8px 26px rgba(245,185,66,0.42);
    --gold-shadow-plus: 0 4px 18px rgba(245,185,66,0.35);
    --gold-shadow-plus-hover: 0 8px 26px rgba(245,185,66,0.5);
    --shadow-gold:   0 6px 24px rgba(245,185,66,0.28);
    --font-display: "Space Grotesk", "Segoe UI", system-ui, sans-serif;
    --font-body:    "Inter", -apple-system, "Segoe UI", Roboto, sans-serif;
    /* Theme-agnostic craft layers (BRAND2) */
    --coin-reed:     repeating-linear-gradient(90deg, rgba(0,0,0,0.22) 0 2px, transparent 2px 5px);
    --guilloche:     repeating-radial-gradient(circle at 50% -60%, transparent 0 7px, rgba(140,110,40,0.06) 7px 8px);
    --radius-card:   16px;
    --radius-ctl:    10px;
  }
  /* Light theme — "Day Ledger": 100% beige-family parchment, espresso ink, darkened bullion gold. No white anywhere. */
  [data-theme="light"] {
    --bg-void:       #ECE2CB;
    --bg-elevated:   #E2D6B8;
    --bg-spotlight:  #EFE6CD;
    --surface-card:  #F5EEDA;
    --surface-deal:  linear-gradient(165deg, #F9F2DE 0%, #F1E7CC 55%, #F5EBD2 100%);
    --gold:          #8A5C08;
    --gold-deep:     #6E4A05;
    --gold-glow:     rgba(138,92,8,0.14);
    --mint:          #0B7A58;
    --mint-deep:     #0B6B4E;
    --ink-primary:   #2B2114;
    --ink-muted:     #6E6046;
    --ink-faint:     #8B8574;
    --success:       #0B7A58;
    --warning:       #8F5200;
    --danger:        #C22A47;
    --danger-deep:   #A31F3C;
    --border-soft:   #D8CBA6;
    --border-gold:   rgba(138,92,8,0.45);
    --gradient-coin: linear-gradient(120deg, #D9A02B 0%, #F0C668 45%, #A9760F 100%);
    --gold-bright:   #6E4A05;
    --on-gold:       #241A05;
    --on-mint:       #FFF7F0;
    --on-danger:     #FFF7F0;
    --bg-glow:       radial-gradient(1200px 600px at 50% -10%, rgba(138,92,8,0.06), transparent 60%);
    --nav-bg:        rgba(236,226,203,0.88);
    --media-bg:      #11111C;
    --row-hover:     rgba(74,56,20,0.06);
    --bubble-mine-bg: linear-gradient(160deg, #F3DFA6 0%, #EBD18C 100%);
    --bubble-theirs-bg: #F5EEDA;
    --card-shadow:        0 10px 28px rgba(74,56,20,0.14);
    --card-shadow-hover:  0 16px 36px rgba(74,56,20,0.16);
    --card-inset:         inset 0 1px 0 rgba(255,255,255,0.6);
    --input-bg:      #F9F3E2;
    --input-border:  #CDBF97;
    --ok-bg:         rgba(11,122,88,0.10);
    --ok-border:     rgba(11,122,88,0.4);
    --ok-badge-bg:   #DFF0E4;
    --ok-badge-border: rgba(11,107,78,0.45);
    --err-bg:        rgba(194,42,71,0.10);
    --err-border:    rgba(194,42,71,0.4);
    --err-badge-border: rgba(163,31,60,0.45);
    --warn-bg:       #F3E2B8;
    --warn-border:   rgba(122,78,0,0.45);
    --warn-badge-border: rgba(122,78,0,0.4);
    --badge-flag-bg: #F6DDE2;
    --badge-flag-fg: #A31F3C;
    --gold-shadow-sm: 0 2px 12px rgba(138,92,8,0.25);
    --gold-shadow-md: 0 4px 18px rgba(138,92,8,0.18);
    --gold-shadow-lg: 0 8px 26px rgba(138,92,8,0.30);
    --gold-shadow-plus: 0 4px 18px rgba(138,92,8,0.25);
    --gold-shadow-plus-hover: 0 8px 26px rgba(138,92,8,0.38);
    --shadow-gold:   0 6px 22px rgba(138,92,8,0.28);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background-color: var(--bg-void); background-image: var(--bg-glow); background-attachment: fixed; background-repeat: no-repeat; color: var(--ink-primary); font-family: var(--font-body); font-size: 16px; line-height: 1.6; min-height: 100vh; }
  a { color: var(--gold); text-decoration: none; }
  a:hover { color: var(--gold-bright); }
  h1, h2, h3 { font-family: var(--font-display); color: var(--ink-primary); }
  h1 { font-size: 2rem; font-weight: 700; letter-spacing: -0.02em; }
  h2 { font-size: 1.375rem; font-weight: 700; letter-spacing: -0.015em; }
  h3 { font-size: 1.125rem; font-weight: 700; letter-spacing: -0.015em; }
  .kicker { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.14em; color: var(--mint); }
  .sec-h { margin: 18px 0 10px; }

  /* Nav — sticky, blurred, members-only feel */
  .nav { position: sticky; top: 0; z-index: 10; min-height: 64px; background: var(--nav-bg); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-bottom: 1px solid var(--border-soft); padding: 10px 24px; display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
  .nav::after { content: ""; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; background: linear-gradient(90deg, transparent, var(--border-gold) 30%, var(--border-gold) 70%, transparent); pointer-events: none; }
  .nav .brand { display: inline-flex; align-items: center; gap: 10px; font-family: var(--font-display); font-size: 20px; font-weight: 700; letter-spacing: -0.02em; color: var(--ink-primary); }
  .nav .brand:hover { color: var(--ink-primary); }
  .nav .coin { width: 30px; height: 30px; border-radius: 50%; background: var(--gradient-coin); color: var(--on-gold); display: inline-flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; letter-spacing: 0; box-shadow: var(--gold-shadow-sm); }
  .nav a.navlink { color: var(--ink-muted); font-size: 14px; font-weight: 500; padding-bottom: 2px; border-bottom: 2px solid transparent; }
  .nav a.navlink:hover { color: var(--ink-primary); }
  .nav .spacer { flex: 1; }

  .container { max-width: 860px; margin: 28px auto; padding: 0 16px; }

  /* Cards */
  .card { background: var(--surface-card); border: 1px solid var(--border-soft); border-radius: 16px; padding: 1.25rem; margin-bottom: 16px; }
  .card h2, .card h3 { margin-bottom: 10px; }
  /* Deal cards — struck coin: guilloché engraving + reeded gold edge */
  .card-deal { position: relative; overflow: hidden; background: var(--guilloche), var(--surface-deal), var(--surface-card); border: 1px solid var(--border-gold); padding: 1.5rem; box-shadow: var(--card-shadow), var(--card-inset); transition: transform .2s ease, box-shadow .2s ease; }
  .card-deal::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 4px; background: var(--gradient-coin); border-radius: 16px 16px 0 0; }
  .card-deal::after { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 4px; background: var(--coin-reed); opacity: .5; pointer-events: none; }
  .card-deal:hover { transform: translateY(-3px); box-shadow: var(--card-shadow-hover), var(--shadow-gold), 0 0 0 1px var(--border-gold); }
  /* Vault-secure panels (signing room, contract status) — guilloché + inner door seam */
  .vault { position: relative; overflow: hidden; border-color: var(--border-gold); background: var(--guilloche), var(--surface-card); box-shadow: var(--card-shadow), var(--card-inset); }
  .vault::before { content: ""; position: absolute; inset: 10px; border-radius: 10px; border: 1px dashed var(--border-gold); pointer-events: none; }
  .muted { color: var(--ink-muted); font-size: 13px; }
  .deal-value { font-family: var(--font-display); font-weight: 700; font-size: 1.35rem; color: var(--gold); letter-spacing: -0.01em; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .avatar { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 10px; background: var(--bg-spotlight); border: 1px solid var(--border-soft); color: var(--gold); font-family: var(--font-display); font-weight: 700; font-size: 15px; vertical-align: middle; margin-right: 8px; }

  /* Buttons — primary .btn is the struck gold coin (reeded bottom edge) */
  .btn { display: inline-block; background: var(--gradient-coin); color: var(--on-gold); border: 1px solid transparent; border-radius: 10px; padding: 0.7rem 1.4rem; font: 600 0.9375rem var(--font-body); cursor: pointer; transition: all .18s ease; box-shadow: var(--gold-shadow-md), inset 0 1px 0 rgba(255,255,255,0.35); }
  .btn:not(.btn-outline):not(.btn-danger):not(.btn-green) { position: relative; overflow: hidden; }
  .btn:not(.btn-outline):not(.btn-danger):not(.btn-green)::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: var(--coin-reed); opacity: .35; pointer-events: none; }
  .btn:hover { transform: translateY(-2px); box-shadow: var(--gold-shadow-lg); color: var(--on-gold); }
  .btn:active { transform: translateY(0); box-shadow: var(--gold-shadow-md); }
  .btn:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
  .btn-sm { padding: 5px 11px; font-size: 13px; }
  .btn-outline { background: transparent; color: var(--ink-primary); border-color: var(--border-soft); box-shadow: none; }
  .btn-outline:hover { border-color: var(--border-gold); background: var(--bg-spotlight); color: var(--ink-primary); transform: none; box-shadow: none; }
  .btn-danger { background: var(--danger); color: var(--on-danger); box-shadow: none; }
  .btn-danger:hover { background: var(--danger-deep); color: var(--on-danger); }
  .btn-green { background: var(--mint); color: var(--on-mint); box-shadow: none; }
  .btn-green:hover { background: var(--mint-deep); color: var(--on-mint); }
  .btn.liked { animation: likepop .15s ease; }
  @keyframes likepop { 0% { transform: scale(1); } 50% { transform: scale(1.15); } 100% { transform: scale(1); } }

  /* Forms / inputs */
  input[type=text], input[type=email], input[type=password], input[type=url], input[type=number], textarea, select {
    width: 100%; background: var(--input-bg); border: 1px solid var(--input-border); border-radius: 10px;
    color: var(--ink-primary); padding: 0.7rem 0.9rem; font-size: 14px; font-family: var(--font-body); margin-bottom: 12px;
    box-shadow: inset 0 2px 4px rgba(0,0,0,0.12);
  }
  input::placeholder, textarea::placeholder { color: var(--ink-faint); }
  input:focus, textarea:focus, select:focus { outline: none; border-color: var(--border-gold); box-shadow: 0 0 0 3px var(--gold-glow); background: var(--bg-spotlight); }
  select { cursor: pointer; }
  label { display: block; font-size: 0.8125rem; font-weight: 600; color: var(--ink-muted); margin-bottom: 6px; }

  /* Styled upload button — the native file input is visually hidden behind a themed label. */
  .file-input { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; z-index: -1; }
  .file-btn { display: inline-block; background: transparent; color: var(--gold); border: 1px dashed var(--border-gold); border-radius: 10px; padding: 0.6rem 1.1rem; font: 600 0.875rem var(--font-body); cursor: pointer; margin-bottom: 12px; transition: all .18s ease; }
  .file-btn:hover { background: var(--gold-glow); border-style: solid; }
  .file-btn .file-btn-text { overflow-wrap: anywhere; }

  /* Flash messages */
  .flash-ok, .flash-err { border-radius: 10px; padding: 0.8rem 1.1rem; font: 500 0.9375rem var(--font-body); border: 1px solid; margin-bottom: 14px; animation: flashin .3s ease; }
  .flash-ok { background: var(--ok-bg); border-color: var(--ok-border); color: var(--mint); }
  .flash-err { background: var(--err-bg); border-color: var(--err-border); color: var(--danger); }
  @keyframes flashin { from { transform: translateY(-8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  .demo-banner { background: var(--warn-bg); border: 1px solid var(--warn-border); color: var(--warning); border-radius: 10px; padding: 12px 14px; margin-bottom: 14px; font-size: 14px; }
  .demo-banner b { color: var(--warning); }

  /* Badges */
  .badge { display: inline-block; border-radius: 999px; padding: 0.2rem 0.7rem; font: 600 0.75rem var(--font-body); text-transform: uppercase; letter-spacing: 0.08em; border: 1px solid transparent; }
  .badge-pass, .badge-approved { background: var(--ok-badge-bg); color: var(--success); border-color: var(--ok-badge-border); }
  .badge-approved::before { content: "\\2713  "; }
  .badge-contract { background: var(--ok-badge-bg); color: var(--mint); border-color: var(--ok-border); }
  .badge-pending { background: var(--warn-bg); color: var(--warning); border-color: var(--warn-badge-border); }
  .badge-flag { background: var(--badge-flag-bg); color: var(--badge-flag-fg); border: 1px dashed currentColor; }
  .badge-fail, .badge-rejected { background: var(--err-bg); color: var(--danger); border-color: var(--err-badge-border); }
  .badge-sealed { background: transparent; color: var(--gold); border: 1px solid var(--border-gold); }
  .badge-suspended { background: transparent; color: var(--ink-faint); border: 1px dashed var(--border-soft); }
  .warn-badge { display: inline-block; background: var(--badge-flag-bg); color: var(--badge-flag-fg); border: 1px dashed currentColor; border-radius: 999px; padding: 0.2rem 0.7rem; font: 600 0.75rem var(--font-body); text-transform: uppercase; letter-spacing: 0.08em; }
  .warn-badge .warn-ic { font-style: normal; display: inline-block; animation: warnpulse 2s ease-in-out infinite; }
  @keyframes warnpulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

  /* Tables (admin dashboard) */
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border-soft); vertical-align: top; }
  th { color: var(--ink-muted); font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.14em; }
  tbody tr:hover td, tr:hover td { background: var(--row-hover); }

  /* Stat tiles */
  .stats { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 18px; }
  .stat { position: relative; overflow: hidden; background: var(--surface-card); border: 1px solid var(--border-soft); border-radius: 14px; padding: 1.1rem 1.25rem; flex: 1; min-width: 110px; transition: border-color .18s ease; }
  .stat::after { content: ""; position: absolute; inset: 0; background: var(--guilloche); opacity: .7; pointer-events: none; }
  .stat:hover { border-color: var(--border-gold); }
  .stat .num { position: relative; font-family: var(--font-display); font-size: 1.75rem; font-weight: 700; color: var(--ink-primary); font-variant-numeric: tabular-nums; }
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

  /* Icon navigation (company pages) */
  .nav-icons { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
  .nav-ic { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 12px; color: var(--ink-muted); border: 1px solid transparent; transition: all .15s ease; }
  .nav-ic svg { width: 20px; height: 20px; }
  .nav-ic:hover { color: var(--ink-primary); background: var(--bg-spotlight); }
  .nav-ic.active { color: var(--gold); background: var(--gold-glow); border-color: var(--border-gold); }
  .nav-badge { position: absolute; top: -5px; right: -5px; min-width: 18px; height: 18px; border-radius: 999px; background: var(--danger); color: var(--on-danger); font-size: 11px; font-weight: 700; font-family: var(--font-body); display: inline-flex; align-items: center; justify-content: center; padding: 0 5px; line-height: 1; box-shadow: 0 0 0 2px var(--bg-void); pointer-events: none; animation: badge-pulse 2.4s ease-in-out infinite; }
  @keyframes badge-pulse { 50% { transform: scale(1.12); } }
  .unread-chip { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 20px; border-radius: 999px; background: var(--danger); color: var(--on-danger); font-size: 12px; font-weight: 700; padding: 0 6px; margin-left: 8px; }
  button.nav-ic { background: transparent; cursor: pointer; font-size: 17px; line-height: 1; padding: 0; font-family: var(--font-body); }
  .nav-plus { display: inline-flex; align-items: center; justify-content: center; width: 42px; height: 42px; border-radius: 50%; background: var(--gradient-coin); color: var(--on-gold); margin-left: 6px; box-shadow: var(--gold-shadow-plus); transition: all .18s ease; }
  .nav-plus svg { width: 22px; height: 22px; }
  .nav-plus:hover { transform: translateY(-2px) scale(1.05); box-shadow: var(--gold-shadow-plus-hover); color: var(--on-gold); }
  @media (max-width: 700px) { .nav { gap: 8px; padding: 8px 12px; } .nav-ic { width: 36px; height: 36px; } }

  /* Attached media on cards */
  .card-media img, .card-media video { display: block; width: 100%; max-height: 420px; object-fit: cover; border-radius: 12px; border: 1px solid var(--border-soft); margin-top: 12px; background: var(--media-bg); }

  /* Create menu (/new) */
  .create-card { display: block; text-align: center; padding: 2rem 1.5rem; }
  .create-card .big-ic { font-size: 2.2rem; }
  .create-card:hover { border-color: var(--border-gold); }

  /* Chat */
  .conv-row { display: flex; align-items: center; gap: 12px; padding: 12px 4px; border-bottom: 1px solid var(--border-soft); color: var(--ink-primary); }
  .conv-row:hover { background: var(--row-hover); color: var(--ink-primary); }
  .conv-row .conv-name { font-weight: 600; }
  .conv-row .conv-preview { color: var(--ink-muted); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 420px; }
  .chat-box { display: flex; flex-direction: column; gap: 10px; margin: 14px 0; }
  .bubble { width: fit-content; max-width: min(70%, 560px); border-radius: 14px; padding: 10px 14px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
  .bubble.mine { align-self: flex-end; background: var(--bubble-mine-bg); border: 1px solid var(--border-gold); border-bottom-right-radius: 4px; }
  .bubble.theirs { align-self: flex-start; background: var(--bubble-theirs-bg); border: 1px solid var(--border-soft); border-bottom-left-radius: 4px; }
  .bubble .bubble-meta { font-size: 11px; color: var(--ink-faint); margin-top: 4px; }
  .bubble .bubble-sender { font-size: 12px; font-weight: 600; color: var(--mint); margin-bottom: 2px; }
  .chat-send { display: flex; gap: 8px; }
  .chat-send input { margin-bottom: 0; }
  .member-check { display: flex; gap: 8px; align-items: center; font-size: 14px; color: var(--ink-primary); font-weight: 500; padding: 6px 0; }
  .member-check input { width: auto; margin: 0; }

  /* Dashboard charts */
  .chart-wrap { position: relative; min-height: 260px; }
  .dash-empty { color: var(--ink-muted); font-size: 14px; padding: 18px 0; text-align: center; }

  /* Rich company profiles — cover banner + avatar + bio/about */
  .profile-cover { display: block; width: 100%; height: 180px; object-fit: cover; border-radius: 12px; border: 1px solid var(--border-soft); margin-bottom: 14px; background: var(--media-bg); }
  .avatar-img { display: inline-block; width: 34px; height: 34px; border-radius: 10px; object-fit: cover; vertical-align: middle; margin-right: 8px; border: 1px solid var(--border-soft); background: var(--bg-spotlight); }
  .avatar-lg, .avatar-lg.avatar-img { width: 96px; height: 96px; border-radius: 24px; font-size: 40px; border: 1px solid var(--border-gold); }
  .profile-bio { margin-top: 8px; font-size: 15px; color: var(--ink-primary); }
  .profile-about { margin-top: 10px; white-space: pre-wrap; }

  /* Two-stage contract states */
  .badge-pending_owner, .badge-pending_admin, .badge-pending_recipient { background: var(--warn-bg); color: var(--warning); border-color: var(--warn-badge-border); }
  .badge-accepted { background: var(--ok-badge-bg); color: var(--success); border-color: var(--ok-badge-border); }
  .badge-refused { background: var(--err-bg); color: var(--danger); border-color: var(--err-badge-border); }

  /* Signing room tabs (Sign | Counter offer) */
  .tab-row { display: flex; gap: 8px; margin: 14px 0 16px; }
  .tab-row a { flex: 1; text-align: center; padding: 0.65rem 1rem; border-radius: 10px; border: 1px solid var(--border-soft); color: var(--ink-muted); font: 600 0.875rem var(--font-body); background: var(--bg-elevated); }
  .tab-row a:hover { color: var(--ink-primary); border-color: var(--border-gold); }
  .tab-row a.tab-active { color: var(--gold); background: var(--gold-glow); border-color: var(--border-gold); }

  /* Company intelligence card (Research Agent) */
  .intel-card { border: 1px solid var(--ok-border); background: linear-gradient(160deg, var(--ok-badge-bg) 0%, var(--surface-card) 55%); }
  .intel-card .kicker { color: var(--mint); }
  .intel-row { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--border-soft); font-size: 14px; }
  .intel-row:last-of-type { border-bottom: none; }
  .intel-row .k { color: var(--ink-muted); font-weight: 600; }
  .intel-src { font-size: 12px; margin-top: 10px; }

  /* Reputation star selector (admin) */
  .rep-form { display: inline-flex; gap: 6px; align-items: center; }
  .rep-form select { width: auto; margin-bottom: 0; padding: 4px 8px; font-size: 13px; }

  /* ============ Private Contracts Mailbox — "sealed letters" (BRAND2) ============ */
  .mail-row {
    position: relative; display: flex; align-items: center; gap: 1rem;
    padding: 1rem 1.25rem; border: 1px solid var(--border-soft);
    border-radius: 14px; background: var(--surface-card); cursor: pointer; color: var(--ink-primary);
    margin-bottom: 10px;
    transition: transform .18s ease, box-shadow .18s ease;
  }
  .mail-row--sealed {
    background: var(--guilloche), var(--surface-deal), var(--surface-card);
    border-color: var(--border-gold);
    box-shadow: var(--card-shadow);
  }
  .mail-row--sealed::before {      /* envelope flap — folded gold top edge */
    content: ""; position: absolute; inset: 0 0 auto 0; height: 3px;
    background: linear-gradient(90deg, transparent, var(--border-gold), transparent);
  }
  .mail-row--sealed .mail-subject { font-weight: 700; color: var(--ink-primary); }
  .mail-row--sealed .mail-sender  { font-weight: 600; }
  .mail-row--sealed::after {       /* unread dot, mint = seal intact */
    content: ""; position: absolute; top: 12px; right: 14px; width: 8px; height: 8px;
    border-radius: 50%; background: var(--mint);
  }
  .mail-row--opened .mail-subject { font-weight: 500; color: var(--ink-muted); }
  .mail-row--opened { opacity: .88; }
  .mail-row:hover { transform: translateY(-2px); box-shadow: var(--card-shadow), 0 0 0 1px var(--border-gold); color: var(--ink-primary); }
  .mail-main { flex: 1; min-width: 0; }
  .mail-subject { font-family: var(--font-body); font-size: 0.9375rem; overflow-wrap: anywhere; }
  .mail-sender { font-size: 0.8125rem; color: var(--ink-muted); }
  .mail-amount { font-family: var(--font-display); font-weight: 700; color: var(--gold); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .mail-date { font-size: 0.75rem; color: var(--ink-faint); white-space: nowrap; }
  /* The wax seal — pure CSS, 40px */
  .wax-seal {
    position: relative; flex: 0 0 auto; width: 40px; height: 40px; border-radius: 50%;
    display: grid; place-items: center;
    background: radial-gradient(circle at 32% 28%, #FFD97A 0%, #F5B942 42%, #C98A1E 78%, #9A6A0A 100%);
    box-shadow: inset 0 2px 3px rgba(255,255,255,0.45), inset 0 -3px 5px rgba(80,50,0,0.45),
                0 2px 6px rgba(0,0,0,0.35);
    transform: rotate(-8deg);
    font: 700 0.875rem var(--font-display); color: #4A3200; letter-spacing: -0.02em;
  }
  .wax-seal::before {              /* embossed inner ring */
    content: ""; position: absolute; inset: 4px; border-radius: 50%;
    border: 1px solid rgba(80,50,0,0.35); box-shadow: inset 0 1px 1px rgba(255,255,255,0.3);
  }
  .wax-seal > span { position: relative; }
  /* Opened letters: the seal is cracked — desaturated, dashed ring, upright */
  .mail-row--opened .wax-seal {
    background: var(--bg-spotlight); color: var(--ink-muted); transform: none;
    box-shadow: inset 0 0 0 1px var(--border-soft);
  }
  .mail-row--opened .wax-seal::before { border-style: dashed; border-color: var(--border-soft); box-shadow: none; }
  /* Mailbox filter pills (All / Sealed / Opened / Signed) */
  .mail-filters { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0 16px; }
  .mail-filters a { border-radius: 999px; padding: 0.3rem 0.9rem; font: 600 0.8125rem var(--font-body); border: 1px solid var(--border-soft); color: var(--ink-muted); }
  .mail-filters a:hover { color: var(--ink-primary); border-color: var(--border-gold); }
  .mail-filters a.pill-active { background: var(--bg-spotlight); border-color: var(--border-gold); color: var(--gold); }
  /* Discover companies (empty timeline) */
  .discover-row { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--border-soft); }
  .discover-row:last-of-type { border-bottom: none; }
  .discover-row .grow { flex: 1; min-width: 0; }
`;

/** Inline SVG icons for the company nav (no emoji in the nav bar). */
const NAV_ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/></svg>',
  chats: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a7.5 7.5 0 0 1-7.5 7.5c-1.2 0-2.4-.27-3.4-.78L4 20l1.7-4.4A7.5 7.5 0 1 1 21 11.5z"/><path d="M8.5 10.5h7M8.5 13.5h4"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.8-4.8"/></svg>',
  profile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="7.5" r="3.5"/><path d="M3.5 20v-1.5a5.5 5.5 0 0 1 5.5-5.5h0a5.5 5.5 0 0 1 5.5 5.5V20"/><path d="M16 4h5v7h-5z"/><path d="M17.5 7.5h1"/></svg>',
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21h18"/><path d="M6 21v-7M11 21V9M16 21v-11M21 21V5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8.5a6 6 0 0 0-12 0c0 6.5-2.5 7.5-2.5 7.5h17S18 15 18 8.5z"/><path d="M10 20a2.2 2.2 0 0 0 4 0"/></svg>',
  contracts: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7.5 9 6 9-6"/></svg>'
};
function navIcon(key, href, label, active, badge) {
  const badgeHtml = badge > 0 ? `<span class="nav-badge" aria-label="${badge} unread">${badge > 99 ? '99+' : badge}</span>` : '';
  return `<a class="nav-ic${active === key ? ' active' : ''}" href="${href}" title="${label}" aria-label="${label}">${NAV_ICONS[key]}${badgeHtml}</a>`;
}

/** Total unread messages across all of a company's conversations (one query). */
function totalUnread(companyId) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM messages m
    JOIN conversation_members cm ON cm.conversation_id = m.conversation_id
    WHERE cm.company_id = ? AND m.sender_company_id != ?
      AND m.created_at > COALESCE(cm.last_read_at, '')`).get(companyId, companyId).n;
}

/** Moon/sun theme toggle button (client-side only, persists to localStorage). */
const THEME_TOGGLE_BTN = '<button class="nav-ic theme-toggle" id="theme-toggle" type="button" title="Toggle light/dark theme" aria-label="Toggle light/dark theme">🌙</button>';

/** Render the full HTML page shell. */
function page(title, body, user, msg, err, active, headExtra) {
  const unread = (user && !user.isAdmin) ? totalUnread(user.id) : 0;
  const notifUnread = (user && !user.isAdmin) ? unreadNotifications(user.id) : 0;
  const contractsUnread = (user && !user.isAdmin) ? unreadPrivateContracts(user.id) : 0;
  const navLinks = user && user.isAdmin
    ? `${THEME_TOGGLE_BTN}
       <a class="navlink" href="/admin">Dashboard</a>
       <form method="POST" action="/admin/logout" style="display:inline"><button class="btn btn-sm btn-outline">Log out</button></form>`
    : user
    ? `<span class="nav-icons">
         ${navIcon('home', '/timeline', 'Home', active)}
         ${navIcon('chats', '/chats', 'Chats', active, unread)}
         ${navIcon('contracts', '/contracts', 'Contracts', active, contractsUnread)}
         ${navIcon('bell', '/notifications', 'Notifications', active, notifUnread)}
         ${navIcon('search', '/search', 'Search', active)}
         ${navIcon('profile', '/profile', 'Profile', active)}
         ${navIcon('dashboard', '/dashboard', 'Dashboard', active)}
         <a class="nav-plus" href="/new" title="Create" aria-label="Create">${NAV_ICONS.plus}</a>
       </span>
       ${THEME_TOGGLE_BTN}
       <form method="POST" action="/logout" style="display:inline"><button class="btn btn-sm btn-outline">Log out</button></form>`
    : `${THEME_TOGGLE_BTN}
       <a class="navlink" href="/login">Sign in</a>
       <a class="navlink" href="/signup">Register company</a>`;
  return `<!DOCTYPE html>
<html lang="en"><head>
<script>try{if(localStorage.getItem('dz-theme')==='light'){document.documentElement.dataset.theme='light';}}catch(e){}</script>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Dealzoin</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${CSS}</style>
${headExtra || ''}
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
<script>(function(){
  var root=document.documentElement,btn=document.getElementById('theme-toggle');
  function paintIcon(){if(btn)btn.textContent=root.dataset.theme==='light'?'\\u2600\\uFE0F':'\\uD83C\\uDF19';}
  if(btn){paintIcon();btn.addEventListener('click',function(){
    if(root.dataset.theme==='light'){root.removeAttribute('data-theme');}else{root.dataset.theme='light';}
    try{localStorage.setItem('dz-theme',root.dataset.theme==='light'?'light':'dark');}catch(e){}
    paintIcon();
  });}
  document.querySelectorAll('input.file-input').forEach(function(inp){
    inp.addEventListener('change',function(){
      var lbl=inp.closest('.file-btn');if(!lbl)return;
      var t=lbl.querySelector('.file-btn-text');if(!t)return;
      var def=t.getAttribute('data-default')||'\\uD83D\\uDCCE Attach photo or video';
      t.textContent=(inp.files&&inp.files.length)?'\\uD83D\\uDCCE '+Array.prototype.map.call(inp.files,function(f){return f.name;}).join(', '):def;
    });
  });
})();</script>
</body></html>`;
}

function statusBadge(status) {
  return `<span class="badge badge-${esc(status)}">${esc(String(status).replace(/_/g, ' '))}</span>`;
}
function resultBadge(result) {
  return `<span class="badge badge-${esc(result)}">${esc(result)}</span>`;
}
/** Rounded-square company avatar (institutions, not people — never a circle).
 *  Renders the company's uploaded avatar image when set, else a letter tile. */
function avatarHtml(name, mediaId, extraClass) {
  const cls = extraClass ? ' ' + extraClass : '';
  if (mediaId) return `<img class="avatar-img${cls}" src="/media/${mediaId}" alt="${esc(String(name || '?'))} avatar" loading="lazy">`;
  const initial = (String(name || '?').trim()[0] || '?').toUpperCase();
  return `<span class="avatar${cls}" aria-hidden="true">${esc(initial)}</span>`;
}
/** avatar_media_id for a company, or null (letter-avatar fallback). */
const _avatarStmt = db.prepare('SELECT avatar_media_id FROM companies WHERE id = ?');
function companyAvatarMediaId(companyId) {
  const row = _avatarStmt.get(companyId);
  return row && row.avatar_media_id ? row.avatar_media_id : null;
}

// ----- Deal dropdown options -----
const DEAL_CURRENCIES = ['USD', 'EUR', 'GBP', 'AED', 'SAR', 'JPY', 'CNY', 'INR'];
const DEAL_TIME_PERIODS = ['7 days', '14 days', '30 days', '60 days', '90 days', '6 months', '1 year', 'Ongoing'];
function optionsHtml(list, selected) {
  return list.map(v => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(v)}</option>`).join('');
}

// ----- Styled upload button (hides the native file input) -----
const MEDIA_ACCEPT = 'image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm';
function fileButtonHtml(labelText) {
  const def = labelText || '📎 Attach photo or video';
  return `<label class="file-btn"><span class="file-btn-text" data-default="${esc(def)}">${esc(def)}</span><input type="file" class="file-input" name="media" accept="${MEDIA_ACCEPT}"></label>`;
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
/** Build a feed-card item from a full deal row. */
function dealFeedItem(d) {
  return { kind: 'deal', ref_id: d.id, company_id: d.company_id, title: d.title, body: d.description,
           value: d.value, currency: d.currency || 'USD', time_period: d.time_period || '',
           contract_state: d.contract_state || null, contract_party: d.contract_party || '',
           created_at: d.created_at, media_id: d.media_id };
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
    head = `${avatarHtml(ownerName, companyAvatarMediaId(item.company_id))} <a href="/company/${item.company_id}"><b>${esc(ownerName)}</b></a> <span class="muted">posted</span>`;
    bodyHtml = `<p style="margin-top:8px;white-space:pre-wrap">${esc(item.body)}</p>`;
  } else if (item.kind === 'deal') {
    head = `${avatarHtml(ownerName, companyAvatarMediaId(item.company_id))} <a href="/company/${item.company_id}"><b>${esc(ownerName)}</b></a> ${starsHtml(companyReputation(item.company_id), true)} <span class="muted">posted a deal</span>`;
    bodyHtml = `<h3 style="margin-top:8px"><a href="/deal/${item.ref_id}">${esc(item.title)}</a></h3>
      <p style="margin-top:6px;white-space:pre-wrap">${esc(item.body)}</p>`;
  } else { // repost
    const origName = names.get(item.orig_company) || 'Unknown';
    head = `🔁 Reposted from <a href="/company/${item.orig_company}"><b>${esc(origName)}</b></a> ${starsHtml(companyReputation(item.orig_company), true)}
            by <a href="/company/${item.company_id}"><b>${esc(ownerName)}</b></a>`;
    bodyHtml = `<h3 style="margin-top:8px"><a href="/deal/${item.repost_of}">${esc(item.title)}</a></h3>
      <p style="margin-top:6px;white-space:pre-wrap">${esc(item.body)}</p>`;
  }
  // Deal value sits top-right in display gold (with currency); time period + timestamp stay muted.
  const timeStamp = esc(item.created_at.slice(0, 16).replace('T', ' '));
  let headRight;
  if (item.kind !== 'post') {
    const valLine = item.value ? `<div class="deal-value">💰 ${esc(item.value)} ${esc(item.currency || 'USD')}</div>` : '';
    const feeLine = item.value ? feeLineHtml(item) : '';
    const tpLine = item.time_period ? `<span class="muted">⏳ ${esc(item.time_period)}</span>` : '';
    headRight = `<div style="text-align:right">${valLine}${feeLine}${tpLine}${tpLine ? '<br>' : ''}<span class="muted">${timeStamp}</span></div>`;
  } else {
    headRight = `<span class="muted">${timeStamp}</span>`;
  }
  // Mint badge once the deal's contract has been approved by an admin.
  const contractBadge = (item.kind !== 'post' && item.contract_state === 'approved')
    ? `<div style="margin-top:10px"><span class="badge badge-contract">Contract approved ✓${item.contract_party ? ' (with ' + esc(item.contract_party) + ')' : ''}</span></div>` : '';

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
    ${mediaHtml(item.media_id)}
    ${contractBadge}
    ${interact}
  </div>`;
}

// ============================= COMPANY ROUTES (timeline, posts, deals) =============================
/** Unified feed query (deals + posts + reposts). Optional filter SQL is injected into each branch. */
function feedQuery(filterSql, ...args) {
  return db.prepare(`
    SELECT * FROM (
      SELECT 'deal' AS kind, d.id AS ref_id, d.company_id, d.title, d.description AS body,
             d.value, d.created_at, NULL AS repost_of, NULL AS orig_company, d.media_id,
             d.currency, d.time_period, d.contract_state, d.contract_party
      FROM deals d ${filterSql}
      UNION ALL
      SELECT 'post', p.id, p.company_id, NULL, p.body, NULL, p.created_at, NULL, NULL, p.media_id,
             NULL, NULL, NULL, NULL
      FROM posts p ${filterSql}
      UNION ALL
      SELECT 'repost', r.id, r.company_id, d.title, d.description, d.value, r.created_at, d.id, d.company_id, d.media_id,
             d.currency, d.time_period, d.contract_state, d.contract_party
      FROM reposts r JOIN deals d ON d.id = r.deal_id ${filterSql ? filterSql.replace(/company_id/g, 'r.company_id') : ''}
    ) ORDER BY created_at DESC LIMIT 100`).all(...args, ...args, ...args);
}

app.get('/timeline', requireCompany, (req, res) => {
  const names = companyNameMap();
  // Following-only feed: posts/deals/reposts from companies the user follows, plus their own.
  const followFilter = 'WHERE (company_id IN (SELECT followed_id FROM follows WHERE follower_id = ?) OR company_id = ?)';
  const followCount = db.prepare('SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?').get(req.user.id).n;
  const feed = feedQuery(followFilter, req.user.id, req.user.id);

  let feedHtml;
  if (!followCount) {
    // Empty state: friendly note + "Discover companies" (approved companies, limit 8).
    const discover = db.prepare(`
      SELECT id, name, avatar_media_id, reputation FROM companies
      WHERE status = 'approved' AND id != ? ORDER BY reputation DESC, name ASC LIMIT 8`).all(req.user.id);
    const discoverHtml = discover.length ? `
      <div class="card">
        <div class="kicker">Discover companies</div>
        <h3 style="margin:6px 0 4px">Start your ledger</h3>
        ${discover.map(c => `
          <div class="discover-row">
            <div class="grow">${avatarHtml(c.name, c.avatar_media_id)}<a href="/company/${c.id}"><b>${esc(c.name)}</b></a>
              <div style="margin-left:42px">${starsHtml(c.reputation, true)}</div></div>
            ${followButton(req.user, c.id)}
          </div>`).join('')}
      </div>` : '';
    feedHtml = `
    <div class="card" style="text-align:center">
      <h3>Your exchange is quiet — follow companies to fill it</h3>
      <p class="muted" style="margin:8px 0 14px">Your timeline shows deals, posts and reposts only from companies you follow (plus your own). Find the players in your industry and hit Follow.</p>
      <a class="btn" href="/search">Find companies to follow</a>
    </div>
    ${discoverHtml}
    ${feed.length ? feed.map(i => feedCard(i, req.user, names)).join('') : ''}`;
  } else {
    feedHtml = feed.length
      ? feed.map(i => feedCard(i, req.user, names)).join('')
      : '<div class="card"><p class="muted">Nothing yet from the companies you follow. <a href="/search">Discover more companies →</a></p></div>';
  }

  const body = `
  <div class="card">
    <h2>Your exchange — following</h2>
    <form method="POST" action="/posts" enctype="multipart/form-data">
      <textarea name="body" rows="3" maxlength="2000" placeholder="Share an update with the network…" required style="margin-bottom:8px"></textarea>
      ${fileButtonHtml()}
      <button class="btn btn-sm" type="submit">Post update</button>
      <a class="btn btn-sm btn-outline" href="/deals/new" style="margin-left:8px">Post a deal</a>
    </form>
  </div>
  ${feedHtml}`;
  res.send(page('Timeline', body, req.user, req.query.msg, req.query.err, 'home'));
});

app.post('/posts', requireCompany, mediaUpload, (req, res) => {
  const txt = String(req.body.body || '').trim();
  if (!txt) return res.redirect('/timeline?err=' + encodeURIComponent('Post cannot be empty.'));
  const mediaId = req.file ? saveMedia(req.user.id, req.file) : null;
  db.prepare('INSERT INTO posts (company_id, body, created_at, media_id) VALUES (?,?,?,?)').run(req.user.id, txt.slice(0, 2000), now(), mediaId);
  res.redirect((req.get('referer') || '/timeline').split('?')[0] + '?msg=' + encodeURIComponent('Posted!'));
});

app.get('/deals/new', requireCompany, (req, res) => {
  const body = `
  <div class="card" style="max-width:560px;margin:0 auto">
    <h2>📦 Post a new deal</h2>
    <p class="muted" style="margin-bottom:12px">Deals go live on every company's timeline immediately.</p>
    <form method="POST" action="/deals" enctype="multipart/form-data">
      <label>Deal title</label><input type="text" name="title" required maxlength="160">
      <label>Deal value (e.g. 50,000 / year)</label><input type="text" name="value" maxlength="80">
      <div class="grid2">
        <div><label>Currency</label><select name="currency">${optionsHtml(DEAL_CURRENCIES, 'USD')}</select></div>
        <div><label>Time period</label><select name="time_period">${optionsHtml(DEAL_TIME_PERIODS, '30 days')}</select></div>
      </div>
      <label>Description</label><textarea name="description" rows="6" required maxlength="4000"></textarea>
      <label>Photo or video (optional — image ≤ 5 MB, video ≤ 25 MB)</label>
      ${fileButtonHtml()}
      <button class="btn" type="submit">Publish deal</button>
    </form>
  </div>`;
  res.send(page('New deal', body, req.user, req.query.msg, req.query.err, 'new'));
});

app.post('/deals', requireCompany, mediaUpload, (req, res) => {
  const title = String(req.body.title || '').trim();
  const desc = String(req.body.description || '').trim();
  const value = String(req.body.value || '').trim().slice(0, 80);
  const currency = DEAL_CURRENCIES.includes(req.body.currency) ? req.body.currency : 'USD';
  const timePeriod = DEAL_TIME_PERIODS.includes(req.body.time_period) ? req.body.time_period : '30 days';
  if (!title || !desc) return res.redirect('/deals/new?err=' + encodeURIComponent('Title and description are required.'));
  const mediaId = req.file ? saveMedia(req.user.id, req.file) : null;
  db.prepare('INSERT INTO deals (company_id, title, description, value, created_at, media_id, currency, time_period) VALUES (?,?,?,?,?,?,?,?)')
    .run(req.user.id, title.slice(0, 160), desc.slice(0, 4000), value, now(), mediaId, currency, timePeriod);
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
      ? deals.map(d => feedCard(dealFeedItem(d), req.user, names)).join('')
      : '<p class="muted">No deals match your search.</p>';
    companiesHtml = companies.length
      ? companies.map(c => {
          const fc = followCounts(c.id);
          return `<div class="card">
            <div class="feed-head"><h3>${avatarHtml(c.name, c.avatar_media_id)}<a href="/company/${c.id}">${esc(c.name)}</a></h3>${followButton(req.user, c.id)}</div>
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
    ? deals.map(d => feedCard(dealFeedItem(d), req.user, names)).join('')
    : '<div class="card"><p class="muted">No deals yet.</p></div>';

  // Research Agent intelligence card — shown only when at least one intel field is set.
  const hasIntel = !!(c.market_value || c.field || c.employees);
  const intelCard = hasIntel ? `
  <div class="card intel-card">
    <div class="kicker">Researched by Dealzoin Research Agent</div>
    <h3 style="margin:6px 0 8px">📊 Company intelligence</h3>
    ${c.market_value ? `<div class="intel-row"><span class="k">Market value</span><span>${esc(c.market_value)}</span></div>` : ''}
    ${c.field ? `<div class="intel-row"><span class="k">Field</span><span style="text-align:right">${esc(c.field)}</span></div>` : ''}
    ${c.employees ? `<div class="intel-row"><span class="k">Employees</span><span>${esc(c.employees)}</span></div>` : ''}
    ${c.research_source ? `<div class="muted intel-src">Source: <a href="${esc(c.research_source)}" rel="noopener noreferrer nofollow">${esc(c.research_source)}</a></div>` : ''}
    <div class="muted intel-src">Data provided by platform admin &amp; public sources.</div>
  </div>` : '';

  const body = `
  <div class="card">
    ${c.header_media_id ? `<img class="profile-cover" src="/media/${c.header_media_id}" alt="${esc(c.name)} header image" loading="lazy">` : ''}
    <div class="feed-head"><h2>${avatarHtml(c.name, c.avatar_media_id, 'avatar-lg')}${esc(c.name)}</h2>${followButton(req.user, c.id)}</div>
    <p style="margin-top:6px">${starsHtml(c.reputation)}</p>
    ${c.bio ? `<p class="profile-bio">${esc(c.bio)}</p>` : ''}
    <p class="muted">${fc.followers} followers · ${fc.following} following · member since ${esc(c.created_at.slice(0, 10))}</p>
    ${c.website ? `<p style="margin-top:8px">🌐 <a href="${esc(c.website)}" rel="noopener noreferrer nofollow">${esc(c.website)}</a></p>` : ''}
    <p style="margin-top:10px;white-space:pre-wrap">${esc(c.description || '')}</p>
  </div>
  ${intelCard}
  ${c.about ? `<div class="card"><h3>About</h3><p class="profile-about">${esc(c.about)}</p></div>` : ''}
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
  '9. ENTIRE AGREEMENT. This document constitutes the entire agreement between the parties and supersedes all prior discussions.',
  '10. PLATFORM FEE. A transparent platform commission of 1% of the stated deal value is payable to Dealzoin. This fee is disclosed to both parties — including the deal issuer — before signing and is separate from the deal value exchanged between the parties.'
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
  const owner = db.prepare('SELECT id, name, avatar_media_id FROM companies WHERE id = ?').get(deal.company_id);
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
  if (deal.contract_state === 'approved') {
    contractHtml += `<div class="card vault">
      <h3>Contract <span class="badge badge-contract">Contract approved ✓${deal.contract_party ? ' (with ' + esc(deal.contract_party) + ')' : ''}</span></h3>
      <p class="muted">This deal's contract was approved by an admin and archived.</p>
    </div>`;
  }

  const dealValueHtml = deal.value
    ? `<div style="text-align:right"><div class="deal-value">💰 ${esc(deal.value)} ${esc(deal.currency || 'USD')}</div>${feeLineHtml(deal)}${deal.time_period ? `<span class="muted">⏳ ${esc(deal.time_period)}</span><br>` : ''}<span class="muted">${esc(deal.created_at.slice(0, 16).replace('T', ' '))}</span></div>`
    : `<div style="text-align:right">${deal.time_period ? `<span class="muted">⏳ ${esc(deal.time_period)}</span><br>` : ''}<span class="muted">${esc(deal.created_at.slice(0, 16).replace('T', ' '))}</span></div>`;

  const signBtn = req.user.id !== deal.company_id && deal.contract_state !== 'approved'
    ? `<a class="btn btn-green" href="/deal/${deal.id}/contract">View contract &amp; sign</a>` : '';
  const body = `
  <div class="card card-deal">
    <div class="feed-head"><h2>${esc(deal.title)}</h2>
      ${dealValueHtml}</div>
    <p class="muted">by ${avatarHtml(owner ? owner.name : '?', owner ? owner.avatar_media_id : null)}<a href="/company/${deal.company_id}"><b>${esc(owner ? owner.name : 'Unknown')}</b></a> ${starsHtml(companyReputation(deal.company_id), true)}</p>
    <p style="margin-top:12px;white-space:pre-wrap">${esc(deal.description)}</p>
    ${deal.contract_state === 'approved' ? `<div style="margin-top:12px"><span class="badge badge-contract">Contract approved ✓${deal.contract_party ? ' (with ' + esc(deal.contract_party) + ')' : ''}</span></div>` : ''}
    ${mediaHtml(deal.media_id)}
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
  const existing = isLiveContract(contract)
    ? `<p class="muted" style="margin-top:10px">A contract for this deal is currently <b>${esc(contract.status.replace(/_/g, ' '))}</b>.</p>` : '';
  const finalizedNote = deal.contract_state === 'approved'
    ? `<p style="margin-top:10px"><span class="badge badge-contract">Contract approved ✓${deal.contract_party ? ' (with ' + esc(deal.contract_party) + ')' : ''}</span></p>` : '';

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
    ${deal.value ? `<p><b>Deal value:</b> <span class="deal-value" style="font-size:1.05rem">${esc(deal.value)} ${esc(deal.currency || 'USD')}</span>${deal.time_period ? ` <span class="muted">· ⏳ ${esc(deal.time_period)}</span>` : ''}</p>` : ''}
    ${feeLineHtml(deal, 'margin-top:6px')}
    <h3 style="margin:14px 0 6px">Deal terms</h3>
    <p style="white-space:pre-wrap">${esc(deal.description)}</p>
    <h3 style="margin:14px 0 6px">Standard B2B terms</h3>
    <div class="muted" style="font-size:13px">${clauses}</div>
    ${existing}
    ${finalizedNote}
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
     ${deal.value ? `<b>Deal value:</b> ${esc(deal.value)} ${esc(deal.currency || 'USD')}<br>` : ''}
     <b>${esc(feeLineText(deal))}</b><br>
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
  const finalized = deal.contract_state === 'approved';
  const live = isLiveContract(contract);
  const myCounter = (!user.isAdmin && user.id)
    ? db.prepare(`SELECT * FROM counter_offers WHERE deal_id = ? AND from_company_id = ? AND status = 'pending'`).get(deal.id, user.id)
    : null;
  const canAct = !user.isAdmin && !isOwn && !finalized;
  const tab = req.query.tab === 'counter' ? 'counter' : 'sign';

  // ---- Tab 1: SIGN — step 1: password re-entry + declarations (step 2 is the OTP page) ----
  let signPanel;
  if (finalized) {
    signPanel = `<p style="margin-top:14px"><span class="badge badge-contract">Contract approved ✓${deal.contract_party ? ' (with ' + esc(deal.contract_party) + ')' : ''}</span></p>
      <p class="muted" style="margin-top:10px">This deal's contract is finalized.</p>`;
  } else if (user.isAdmin) {
    signPanel = '<p class="muted" style="margin-top:14px">Admin view — signing is performed by the counterparty company.</p>';
  } else if (isOwn) {
    signPanel = '<p class="muted" style="margin-top:14px">This is your own deal — the counterparty signs here.</p>';
  } else if (live) {
    signPanel = `<p class="muted" style="margin-top:14px">A contract for this deal is currently <b>${esc(contract.status.replace(/_/g, ' '))}</b> — no new signature can be started.</p>`;
  } else {
    signPanel = `
    <form method="POST" action="/deal/${deal.id}/sign">
      <label>Re-enter your account password (signing authority check)</label>
      <input type="password" name="password" required>
      <label style="display:flex;gap:8px;align-items:center;margin:10px 0">
        <input type="checkbox" name="authorized" value="yes" style="width:auto;margin:0" required>
        I am an authorized signatory of my company</label>
      <label style="display:flex;gap:8px;align-items:center;margin:10px 0">
        <input type="checkbox" name="agree" value="yes" style="width:auto;margin:0" required>
        I agree to the terms of this contract</label>
      <button class="btn btn-green" type="submit" onclick="this.textContent='Verifying…'">Verify &amp; continue →</button>
      <p class="muted" style="margin-top:8px">Step 1 of 2 — next, the Authentication Agent sends a one-time signing code to your business email.</p>
    </form>`;
  }

  // ---- Tab 2: COUNTER OFFER — propose new value/terms (same password + OTP authentication) ----
  let counterPanel;
  if (!canAct) {
    counterPanel = `<p class="muted" style="margin-top:14px">${finalized ? "This deal's contract is finalized." : user.isAdmin ? 'Admin view — counter offers are made by counterparty companies.' : 'This is your own deal — counter offers come from counterparties.'}</p>`;
  } else if (live) {
    counterPanel = `<p class="muted" style="margin-top:14px">A contract for this deal is currently <b>${esc(contract.status.replace(/_/g, ' '))}</b> — counter offers are closed.</p>`;
  } else if (myCounter) {
    counterPanel = `<p class="muted" style="margin-top:14px">You already have a pending counter offer on this deal (${esc(myCounter.new_value)} ${esc(myCounter.new_currency)}). Wait for the deal owner's decision.</p>`;
  } else {
    const parsedVal = parseDealValue(deal.value);
    counterPanel = `
    <form method="POST" action="/deal/${deal.id}/counter">
      <div class="grid2" style="gap:10px">
        <div><label>Proposed new value</label><input type="number" name="new_value" min="0" step="any" required value="${isFinite(parsedVal) ? parsedVal : ''}"></div>
        <div><label>Currency</label><select name="new_currency">${optionsHtml(DEAL_CURRENCIES, deal.currency || 'USD')}</select></div>
      </div>
      <label>Revised terms</label>
      <textarea name="new_terms" rows="5" required maxlength="4000">${esc(deal.description)}</textarea>
      <label>Re-enter your account password (signing authority check)</label>
      <input type="password" name="password" required>
      <button class="btn" type="submit">Send counter offer →</button>
      <p class="muted" style="margin-top:8px">Step 1 of 2 — next, the Authentication Agent sends a one-time confirmation code to your business email.</p>
    </form>`;
  }

  const body = `
  <div class="card vault">
    <div class="kicker" style="margin-bottom:6px">Vault-secure · AI-guarded</div>
    <h2>🔒 Private signing room — Deal #${deal.id}</h2>
    <p class="muted">Access restricted to the contracting parties and the admin. All checks are logged by the Authentication Agent.</p>
    <hr class="sep">
    <p><b>Deal:</b> ${esc(deal.title)}</p>
    ${deal.value ? `<p><b>Value:</b> <span class="deal-value" style="font-size:1.05rem">${esc(deal.value)} ${esc(deal.currency || 'USD')}</span></p>` : ''}
    ${feeLineHtml(deal)}
    <p><b>Provider:</b> ${esc(owner ? owner.name : 'Unknown')} ${starsHtml(companyReputation(deal.company_id), true)}</p>
    ${contract ? `<p><b>Counterparty (signer):</b> ${esc((db.prepare('SELECT name FROM companies WHERE id = ?').get(contract.signer_company_id) || {}).name || 'Unknown')}
      · status ${statusBadge(contract.status)} · signed at ${esc(contract.signed_at.slice(0, 16).replace('T', ' '))} UTC</p>` : ''}
    <h3 style="margin:12px 0 6px">Terms summary</h3>
    <p style="white-space:pre-wrap">${esc(deal.description)}</p>
    <div class="tab-row">
      <a href="/deal/${deal.id}/sign" class="${tab === 'sign' ? 'tab-active' : ''}">✍️ Sign</a>
      <a href="/deal/${deal.id}/sign?tab=counter" class="${tab === 'counter' ? 'tab-active' : ''}">💱 Counter offer</a>
    </div>
    ${tab === 'sign' ? signPanel : counterPanel}
  </div>`;
  res.send(page('Signing room', body, user, req.query.msg, req.query.err));
});

// ----- Signing step 1: AUTHENTICATION AGENT re-verifies the signer, then issues a signing OTP -----
app.post('/deal/:id/sign', requireCompany, (req, res) => {
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!deal) return res.redirect('/timeline?err=' + encodeURIComponent('Deal not found.'));

  // Server-side guard: a company cannot sign its OWN deal.
  if (deal.company_id === req.user.id) {
    audit('AUTHENTICATION AGENT', 'signing self-deal guard', 'fail', `${req.user.name} attempted to sign own deal #${deal.id}`);
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — You cannot sign your own deal.</h2></div>', req.user));
  }
  // Finalized deals cannot be signed again (approved contracts are archived off the queue).
  if (deal.contract_state === 'approved') {
    return res.redirect(`/deal/${deal.id}?err=` + encodeURIComponent("This deal's contract is finalized."));
  }
  // One live contract per deal.
  const existing = latestContract(deal.id);
  if (isLiveContract(existing)) {
    return res.redirect(`/deal/${deal.id}/sign?err=` + encodeURIComponent('A contract for this deal is already ' + existing.status.replace(/_/g, ' ') + '.'));
  }
  // One pending counter offer per company per deal.
  const myCounter = db.prepare(`SELECT id FROM counter_offers WHERE deal_id = ? AND from_company_id = ? AND status = 'pending'`).get(deal.id, req.user.id);
  if (myCounter) {
    return res.redirect(`/deal/${deal.id}/sign?tab=counter&err=` + encodeURIComponent('You already have a pending counter offer on this deal.'));
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

  // (d) step 2 — issue a one-time signing code (Brevo email, or demo banner + server log without an API key)
  const code = String(crypto.randomInt(100000, 1000000)); // 6-digit
  const token = randomToken();
  db.prepare(`DELETE FROM verification_codes WHERE company_id = ? AND purpose = 'sign'`).run(me.id);
  db.prepare('INSERT INTO verification_codes (token, company_id, code, purpose, payload, expires_at, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(token, me.id, code, 'sign', JSON.stringify({ deal_id: deal.id }), new Date(Date.now() + CODE_TTL_MS).toISOString(), now());
  sendVerificationCode(me.email, code);
  audit('AUTHENTICATION AGENT', 'signing OTP issued', 'pass', `Signing code issued for ${me.email} (deal #${deal.id}, 10-min expiry)`);

  res.setHeader('Set-Cookie', `dz_sign=${signedCookieValue(token)}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax${isSecureReq(req) ? '; Secure' : ''}`);
  res.redirect(`/deal/${deal.id}/sign/verify`);
});

/** Shared loader for the signing/counter OTP pages: validates cookie, code row, payload and ownership. */
function loadOtpContext(req, cookieName, purpose, dealId) {
  const token = readSignedCookie(req, cookieName);
  if (!token) return null;
  const row = db.prepare('SELECT * FROM verification_codes WHERE token = ? AND purpose = ?').get(token, purpose);
  if (!row || row.company_id !== req.user.id) return null;
  let payload = {};
  try { payload = JSON.parse(row.payload || '{}'); } catch (e) { payload = {}; }
  if (payload.deal_id !== dealId) return null;
  return { row, payload };
}

// ----- Signing step 2: enter the one-time code to execute the signature -----
app.get('/deal/:id/sign/verify', requireCompany, (req, res) => {
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!deal) return res.redirect('/timeline?err=' + encodeURIComponent('Deal not found.'));
  const ctx = loadOtpContext(req, 'dz_sign', 'sign', deal.id);
  if (!ctx) return res.redirect(`/deal/${deal.id}/sign?err=` + encodeURIComponent('No signing verification in progress. Please start again.'));

  const demo = BREVO_API_KEY ? '' : `
    <div class="demo-banner">⚠️ <b>DEMO MODE</b> — no BREVO_API_KEY configured, so the email was not sent.
    Your signing code is: <b style="font-size:18px;letter-spacing:3px">${esc(ctx.row.code)}</b></div>`;
  const body = `
  <div class="card vault" style="max-width:480px;margin:0 auto">
    <div class="kicker" style="margin-bottom:6px">Step 2 of 2 · signing code</div>
    <h2>✍️ Confirm your signature</h2>
    <p class="muted" style="margin-bottom:12px">The Authentication Agent sent a 6-digit signing code to your business email. Enter it to sign <b>${esc(deal.title)}</b>.</p>
    ${demo}
    <form method="POST" action="/deal/${deal.id}/sign/verify">
      <label>6-digit signing code</label><input type="text" name="code" required pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code">
      <button class="btn btn-green" type="submit">Sign contract</button>
    </form>
    <p class="shield-note">🛡️ Protected by Dealzoin security agents</p>
  </div>`;
  res.send(page('Confirm signature', body, req.user, req.query.msg, req.query.err));
});

app.post('/deal/:id/sign/verify', requireCompany, (req, res) => {
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!deal) return res.redirect('/timeline?err=' + encodeURIComponent('Deal not found.'));
  const code = String(req.body.code || '').trim();
  const ctx = loadOtpContext(req, 'dz_sign', 'sign', deal.id);
  if (!ctx || ctx.row.expires_at < now()) {
    audit('AUTHENTICATION AGENT', 'signing OTP verify', 'fail', `Signing code expired or missing for ${req.user.name} (deal #${deal.id})`);
    return res.redirect(`/deal/${deal.id}/sign?err=` + encodeURIComponent('Signing code expired. Please start signing again.'));
  }
  const a = Buffer.from(code.padEnd(6, ' '));
  const b = Buffer.from(ctx.row.code.padEnd(6, ' '));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    audit('AUTHENTICATION AGENT', 'signing OTP verify', 'fail', `Wrong signing code for ${req.user.name} (deal #${deal.id})`);
    return res.redirect(`/deal/${deal.id}/sign/verify?err=` + encodeURIComponent('Incorrect code. Try again.'));
  }

  // Re-check the guards at commit time (the deal may have changed while the code was in flight).
  if (deal.company_id === req.user.id) {
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — You cannot sign your own deal.</h2></div>', req.user));
  }
  if (deal.contract_state === 'approved') {
    db.prepare('DELETE FROM verification_codes WHERE id = ?').run(ctx.row.id);
    return res.redirect(`/deal/${deal.id}?err=` + encodeURIComponent("This deal's contract is finalized."));
  }
  const existing = latestContract(deal.id);
  if (isLiveContract(existing)) {
    db.prepare('DELETE FROM verification_codes WHERE id = ?').run(ctx.row.id);
    return res.redirect(`/deal/${deal.id}/sign?err=` + encodeURIComponent('A contract for this deal is already ' + existing.status.replace(/_/g, ' ') + '.'));
  }

  db.prepare('DELETE FROM verification_codes WHERE id = ?').run(ctx.row.id);
  const ts = now();
  // State machine stage 1: the contract first awaits the DEAL OWNER's approval.
  db.prepare(`INSERT INTO contracts (deal_id, signer_company_id, owner_company_id, status, signed_at, created_at)
              VALUES (?,?,?, 'pending_owner', ?, ?)`)
    .run(deal.id, req.user.id, deal.company_id, ts, ts);
  res.setHeader('Set-Cookie', 'dz_sign=; HttpOnly; Path=/; Max-Age=0');
  audit('AUTHENTICATION AGENT', 'signing OTP verify', 'pass', `Signing code verified for ${req.user.name} (deal #${deal.id})`);
  audit('AUTHENTICATION AGENT', 'contract signed', 'pass', `${req.user.name} signed deal #${deal.id} at ${ts} — pending owner approval`);
  notify(deal.company_id, 'contract_signed', `${req.user.name} signed the contract for your deal "${deal.title}". Review it in your deal inbox.`, '/deals/inbox');

  res.redirect(`/deal/${deal.id}?msg=` + encodeURIComponent("Contract signed! It now awaits the deal owner's approval."));
});

// ----- Counter offer step 1: validate proposal + password, then issue a confirmation OTP -----
app.post('/deal/:id/counter', requireCompany, (req, res) => {
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!deal) return res.redirect('/timeline?err=' + encodeURIComponent('Deal not found.'));

  // Self-dealing guard: cannot counter your own deal.
  if (deal.company_id === req.user.id) {
    audit('AUTHENTICATION AGENT', 'counter self-deal guard', 'fail', `${req.user.name} attempted to counter own deal #${deal.id}`);
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — You cannot counter your own deal.</h2></div>', req.user));
  }
  if (deal.contract_state === 'approved') {
    return res.redirect(`/deal/${deal.id}?err=` + encodeURIComponent("This deal's contract is finalized."));
  }
  // One pending contract/counter per company per deal (friendly duplicate errors).
  const myContract = latestContract(deal.id);
  if (isLiveContract(myContract) && myContract.signer_company_id === req.user.id) {
    return res.redirect(`/deal/${deal.id}/sign?err=` + encodeURIComponent('You already have a pending contract on this deal.'));
  }
  const myCounter = db.prepare(`SELECT id FROM counter_offers WHERE deal_id = ? AND from_company_id = ? AND status = 'pending'`).get(deal.id, req.user.id);
  if (myCounter) {
    return res.redirect(`/deal/${deal.id}/sign?tab=counter&err=` + encodeURIComponent('You already have a pending counter offer on this deal.'));
  }

  const newValue = parseFloat(String(req.body.new_value || ''));
  if (!isFinite(newValue) || newValue < 0) {
    return res.redirect(`/deal/${deal.id}/sign?tab=counter&err=` + encodeURIComponent('Proposed value must be a valid number.'));
  }
  const newCurrency = DEAL_CURRENCIES.includes(req.body.new_currency) ? req.body.new_currency : (deal.currency || 'USD');
  const newTerms = String(req.body.new_terms || '').trim().slice(0, 4000);
  if (!newTerms) {
    return res.redirect(`/deal/${deal.id}/sign?tab=counter&err=` + encodeURIComponent('Revised terms are required.'));
  }

  // Password re-entry (same signing-authority check as the sign path).
  const me = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.user.id);
  if (!verifyPassword(String(req.body.password || ''), me.salt, me.password_hash)) {
    audit('AUTHENTICATION AGENT', 'counter password re-verification', 'fail', `Wrong password at counter offer for ${me.email} (deal #${deal.id})`);
    return res.redirect(`/deal/${deal.id}/sign?tab=counter&err=` + encodeURIComponent('Password verification failed.'));
  }
  audit('AUTHENTICATION AGENT', 'counter password re-verification', 'pass', `Password re-verified for counter offer by ${me.email} (deal #${deal.id})`);

  // Step 2 — one-time confirmation code (Brevo email, or demo banner + server log without an API key).
  const code = String(crypto.randomInt(100000, 1000000));
  const token = randomToken();
  db.prepare(`DELETE FROM verification_codes WHERE company_id = ? AND purpose = 'counter'`).run(me.id);
  db.prepare('INSERT INTO verification_codes (token, company_id, code, purpose, payload, expires_at, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(token, me.id, code, 'counter',
         JSON.stringify({ deal_id: deal.id, new_value: String(newValue), new_currency: newCurrency, new_terms: newTerms }),
         new Date(Date.now() + CODE_TTL_MS).toISOString(), now());
  sendVerificationCode(me.email, code);
  audit('AUTHENTICATION AGENT', 'counter OTP issued', 'pass', `Counter-offer code issued for ${me.email} (deal #${deal.id}, 10-min expiry)`);

  res.setHeader('Set-Cookie', `dz_counter=${signedCookieValue(token)}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax${isSecureReq(req) ? '; Secure' : ''}`);
  res.redirect(`/deal/${deal.id}/counter/verify`);
});

// ----- Counter offer step 2: enter the code to submit the counter offer -----
app.get('/deal/:id/counter/verify', requireCompany, (req, res) => {
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!deal) return res.redirect('/timeline?err=' + encodeURIComponent('Deal not found.'));
  const ctx = loadOtpContext(req, 'dz_counter', 'counter', deal.id);
  if (!ctx) return res.redirect(`/deal/${deal.id}/sign?tab=counter&err=` + encodeURIComponent('No counter-offer verification in progress. Please start again.'));

  const demo = BREVO_API_KEY ? '' : `
    <div class="demo-banner">⚠️ <b>DEMO MODE</b> — no BREVO_API_KEY configured, so the email was not sent.
    Your confirmation code is: <b style="font-size:18px;letter-spacing:3px">${esc(ctx.row.code)}</b></div>`;
  const body = `
  <div class="card vault" style="max-width:480px;margin:0 auto">
    <div class="kicker" style="margin-bottom:6px">Step 2 of 2 · confirmation code</div>
    <h2>💱 Confirm your counter offer</h2>
    <p class="muted" style="margin-bottom:6px">You are proposing <b>${esc(ctx.payload.new_value)} ${esc(ctx.payload.new_currency)}</b> on <b>${esc(deal.title)}</b>.</p>
    <p class="muted" style="margin-bottom:12px">The Authentication Agent sent a 6-digit code to your business email. Enter it to send the counter offer to the deal owner.</p>
    ${demo}
    <form method="POST" action="/deal/${deal.id}/counter/verify">
      <label>6-digit confirmation code</label><input type="text" name="code" required pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code">
      <button class="btn" type="submit">Send counter offer</button>
    </form>
    <p class="shield-note">🛡️ Protected by Dealzoin security agents</p>
  </div>`;
  res.send(page('Confirm counter offer', body, req.user, req.query.msg, req.query.err));
});

app.post('/deal/:id/counter/verify', requireCompany, (req, res) => {
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!deal) return res.redirect('/timeline?err=' + encodeURIComponent('Deal not found.'));
  const code = String(req.body.code || '').trim();
  const ctx = loadOtpContext(req, 'dz_counter', 'counter', deal.id);
  if (!ctx || ctx.row.expires_at < now()) {
    audit('AUTHENTICATION AGENT', 'counter OTP verify', 'fail', `Counter code expired or missing for ${req.user.name} (deal #${deal.id})`);
    return res.redirect(`/deal/${deal.id}/sign?tab=counter&err=` + encodeURIComponent('Confirmation code expired. Please start again.'));
  }
  const a = Buffer.from(code.padEnd(6, ' '));
  const b = Buffer.from(ctx.row.code.padEnd(6, ' '));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    audit('AUTHENTICATION AGENT', 'counter OTP verify', 'fail', `Wrong counter code for ${req.user.name} (deal #${deal.id})`);
    return res.redirect(`/deal/${deal.id}/counter/verify?err=` + encodeURIComponent('Incorrect code. Try again.'));
  }

  // Re-check guards at commit time.
  if (deal.company_id === req.user.id) {
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — You cannot counter your own deal.</h2></div>', req.user));
  }
  if (deal.contract_state === 'approved') {
    db.prepare('DELETE FROM verification_codes WHERE id = ?').run(ctx.row.id);
    return res.redirect(`/deal/${deal.id}?err=` + encodeURIComponent("This deal's contract is finalized."));
  }
  const dup = db.prepare(`SELECT id FROM counter_offers WHERE deal_id = ? AND from_company_id = ? AND status = 'pending'`).get(deal.id, req.user.id);
  if (dup) {
    db.prepare('DELETE FROM verification_codes WHERE id = ?').run(ctx.row.id);
    return res.redirect(`/deal/${deal.id}/sign?tab=counter&err=` + encodeURIComponent('You already have a pending counter offer on this deal.'));
  }

  db.prepare('DELETE FROM verification_codes WHERE id = ?').run(ctx.row.id);
  db.prepare(`INSERT INTO counter_offers (deal_id, from_company_id, new_value, new_currency, new_terms, status, created_at)
              VALUES (?,?,?,?,?, 'pending', ?)`)
    .run(deal.id, req.user.id, String(ctx.payload.new_value || ''), String(ctx.payload.new_currency || deal.currency || 'USD'),
         String(ctx.payload.new_terms || '').slice(0, 4000), now());
  res.setHeader('Set-Cookie', 'dz_counter=; HttpOnly; Path=/; Max-Age=0');
  audit('AUTHENTICATION AGENT', 'counter OTP verify', 'pass', `Counter code verified for ${req.user.name} (deal #${deal.id})`);
  audit('AUTHENTICATION AGENT', 'counter offer submitted', 'pass', `${req.user.name} countered deal #${deal.id}: ${ctx.payload.new_value} ${ctx.payload.new_currency}`);
  notify(deal.company_id, 'counter_offer', `${req.user.name} sent a counter offer on your deal "${deal.title}" (${ctx.payload.new_value} ${ctx.payload.new_currency}). Review it in your deal inbox.`, '/deals/inbox');

  res.redirect(`/deal/${deal.id}?msg=` + encodeURIComponent('Counter offer sent to the deal owner.'));
});

// ============================= NOTIFICATIONS =============================
app.get('/notifications', requireCompany, (req, res) => {
  const rows = db.prepare('SELECT * FROM notifications WHERE company_id = ? ORDER BY id DESC LIMIT 100').all(req.user.id);
  const list = rows.length ? rows.map(n => `
    <div class="conv-row" style="${n.is_read ? 'opacity:0.65' : ''}">
      <div style="flex:1;min-width:0">
        <div>${n.is_read ? '' : '<span class="badge badge-pending" style="margin-right:8px">new</span>'}${esc(n.text)}</div>
        <div class="muted" style="margin-top:2px">${esc(n.type.replace(/_/g, ' '))} · ${esc(n.created_at.slice(0, 16).replace('T', ' '))} UTC
          ${n.link ? ` · <a href="${esc(n.link)}">Open →</a>` : ''}</div>
      </div>
    </div>`).join('')
    : '<p class="muted">No notifications yet — signatures, counter offers and decisions will land here.</p>';
  const body = `
  <div class="card">
    <h2>🔔 Notifications</h2>
    <p class="muted" style="margin-bottom:10px">Viewing this page marks everything as read.</p>
    ${list}
  </div>`;
  res.send(page('Notifications', body, req.user, req.query.msg, req.query.err, 'bell'));
  // Mark all read on view (after rendering so the badge reflects what the user saw).
  db.prepare('UPDATE notifications SET is_read = 1 WHERE company_id = ? AND is_read = 0').run(req.user.id);
});

// ============================= OWNER DECISION INBOX (/deals/inbox) =============================
// The deal owner's decision center: contracts awaiting owner approval + pending counter offers.
app.get('/deals/inbox', requireCompany, (req, res) => {
  const myId = req.user.id;
  const names = companyNameMap();

  // Contracts on MY deals awaiting MY approval (state machine stage: pending_owner)
  const pendingContracts = db.prepare(`
    SELECT ct.*, d.title AS deal_title FROM contracts ct
    JOIN deals d ON d.id = ct.deal_id
    WHERE ct.owner_company_id = ? AND ct.status = 'pending_owner'
    ORDER BY ct.signed_at ASC`).all(myId);
  const contractsHtml = pendingContracts.length ? pendingContracts.map(ct => {
    const signer = db.prepare('SELECT * FROM companies WHERE id = ?').get(ct.signer_company_id);
    const signerName = signer ? signer.name : (names.get(ct.signer_company_id) || 'Unknown');
    const flagHtml = signer && signer.flagged
      ? `<br><span class="warn-badge"><i class="warn-ic">⚠️</i> flagged</span> <span class="flag-note">${esc(signer.flag_reasons || '')}</span>`
      : '<br><span class="muted" style="font-size:12px">No flag history</span>';
    return `<div class="card vault">
      <div class="feed-head">
        <h3>✍️ ${esc(signerName)} signed <a href="/deal/${ct.deal_id}">"${esc(ct.deal_title)}"</a></h3>
        ${statusBadge(ct.status)}
      </div>
      <p style="margin-top:8px">${avatarHtml(signerName, signer ? signer.avatar_media_id : null)}<a href="/company/${ct.signer_company_id}"><b>${esc(signerName)}</b></a>
        · ${starsHtml(signer ? signer.reputation : 0)}${flagHtml}</p>
      <p class="muted" style="margin-top:6px">Signed at ${esc(ct.signed_at.slice(0, 16).replace('T', ' '))} UTC — your approval sends it to the admin for final approval.</p>
      <div class="feed-actions">
        <form method="POST" action="/contracts/${ct.id}/owner-approve"><button class="btn btn-sm btn-green" type="submit">Approve → send to admin</button></form>
        <form method="POST" action="/contracts/${ct.id}/owner-reject"><button class="btn btn-sm btn-danger" type="submit">Reject</button></form>
      </div>
    </div>`;
  }).join('') : '<div class="card"><p class="muted">No contracts awaiting your approval.</p></div>';

  // Pending counter offers on MY deals — current vs proposed side by side
  const pendingCounters = db.prepare(`
    SELECT co.*, d.title AS deal_title, d.value AS cur_value, d.currency AS cur_currency, d.description AS cur_terms
    FROM counter_offers co JOIN deals d ON d.id = co.deal_id
    WHERE d.company_id = ? AND co.status = 'pending'
    ORDER BY co.created_at ASC`).all(myId);
  const countersHtml = pendingCounters.length ? pendingCounters.map(co => {
    const from = db.prepare('SELECT * FROM companies WHERE id = ?').get(co.from_company_id);
    const fromName = from ? from.name : (names.get(co.from_company_id) || 'Unknown');
    return `<div class="card">
      <div class="feed-head">
        <h3>💱 ${esc(fromName)} countered <a href="/deal/${co.deal_id}">"${esc(co.deal_title)}"</a></h3>
        ${statusBadge(co.status)}
      </div>
      <p style="margin-top:8px">${avatarHtml(fromName, from ? from.avatar_media_id : null)}<a href="/company/${co.from_company_id}"><b>${esc(fromName)}</b></a>
        · ${starsHtml(from ? from.reputation : 0)}
        ${from && from.flagged ? `<span class="warn-badge" style="margin-left:6px"><i class="warn-ic">⚠️</i> flagged</span>` : ''}</p>
      <div class="grid2" style="margin-top:10px">
        <div style="border:1px solid var(--border-soft);border-radius:10px;padding:12px">
          <div class="kicker" style="color:var(--ink-muted)">Current</div>
          <div class="deal-value" style="font-size:1.05rem;margin:6px 0">${esc(co.cur_value || '—')} ${esc(co.cur_currency || 'USD')}</div>
          <p class="muted" style="white-space:pre-wrap">${esc((co.cur_terms || '').slice(0, 400))}</p>
        </div>
        <div style="border:1px solid var(--border-gold);border-radius:10px;padding:12px">
          <div class="kicker">Proposed</div>
          <div class="deal-value" style="font-size:1.05rem;margin:6px 0">${esc(co.new_value)} ${esc(co.new_currency)}</div>
          <p class="muted" style="white-space:pre-wrap">${esc(co.new_terms.slice(0, 400))}</p>
        </div>
      </div>
      <div class="feed-actions">
        <form method="POST" action="/counter/${co.id}/accept"><button class="btn btn-sm btn-green" type="submit">Accept counter offer</button></form>
        <form method="POST" action="/counter/${co.id}/refuse"><button class="btn btn-sm btn-danger" type="submit">Refuse</button></form>
      </div>
    </div>`;
  }).join('') : '<div class="card"><p class="muted">No pending counter offers on your deals.</p></div>';

  const body = `
  <h2 class="sec-h" style="margin-top:0;margin-bottom:14px">📥 Deal inbox — your decisions</h2>
  <h3 class="sec-h">Contracts awaiting your approval</h3>
  ${contractsHtml}
  <h3 class="sec-h">Pending counter offers</h3>
  ${countersHtml}`;
  res.send(page('Deal inbox', body, req.user, req.query.msg, req.query.err));
});

// ----- Owner decisions on contracts (party-only: the deal owner) -----
app.post('/contracts/:id/owner-approve', requireCompany, (req, res) => {
  const ct = db.prepare('SELECT * FROM contracts WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!ct || ct.owner_company_id !== req.user.id) {
    return res.redirect('/deals/inbox?err=' + encodeURIComponent('Contract not found.'));
  }
  if (ct.status !== 'pending_owner') {
    return res.redirect('/deals/inbox?err=' + encodeURIComponent('This contract is not awaiting your approval.'));
  }
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(ct.deal_id);
  db.prepare(`UPDATE contracts SET status = 'pending_admin' WHERE id = ?`).run(ct.id);
  audit('CONTRACT AGENT', 'owner approve contract', 'pass', `Owner ${req.user.name} approved contract #${ct.id} (deal #${ct.deal_id}) — forwarded to admin for final approval`);
  notify(ct.signer_company_id, 'contract_owner_approved',
    `${req.user.name} approved your signature on "${deal ? deal.title : 'deal #' + ct.deal_id}" — awaiting admin final approval.`, `/deal/${ct.deal_id}`);
  res.redirect('/deals/inbox?msg=' + encodeURIComponent('Approved — the contract now awaits admin final approval.'));
});

app.post('/contracts/:id/owner-reject', requireCompany, (req, res) => {
  const ct = db.prepare('SELECT * FROM contracts WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!ct || ct.owner_company_id !== req.user.id) {
    return res.redirect('/deals/inbox?err=' + encodeURIComponent('Contract not found.'));
  }
  if (ct.status !== 'pending_owner') {
    return res.redirect('/deals/inbox?err=' + encodeURIComponent('This contract is not awaiting your approval.'));
  }
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(ct.deal_id);
  db.prepare(`UPDATE contracts SET status = 'rejected', decided_at = ? WHERE id = ?`).run(now(), ct.id);
  audit('CONTRACT AGENT', 'owner reject contract', 'fail', `Owner ${req.user.name} rejected contract #${ct.id} (deal #${ct.deal_id})`);
  notify(ct.signer_company_id, 'contract_rejected',
    `${req.user.name} rejected your signed contract on "${deal ? deal.title : 'deal #' + ct.deal_id}".`, `/deal/${ct.deal_id}`);
  res.redirect('/deals/inbox?msg=' + encodeURIComponent('Contract rejected. The signer has been notified.'));
});

// ----- Owner decisions on counter offers (party-only: the deal owner) -----
app.post('/counter/:id/accept', requireCompany, (req, res) => {
  const co = db.prepare('SELECT * FROM counter_offers WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!co) return res.redirect('/deals/inbox?err=' + encodeURIComponent('Counter offer not found.'));
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(co.deal_id);
  if (!deal || deal.company_id !== req.user.id) {
    return res.redirect('/deals/inbox?err=' + encodeURIComponent('Counter offer not found.'));
  }
  if (co.status !== 'pending') {
    return res.redirect('/deals/inbox?err=' + encodeURIComponent('This counter offer was already decided.'));
  }
  const apply = db.transaction(() => {
    db.prepare('UPDATE deals SET value = ?, currency = ?, description = ? WHERE id = ?')
      .run(co.new_value, co.new_currency || deal.currency || 'USD', co.new_terms, deal.id);
    db.prepare(`UPDATE counter_offers SET status = 'accepted' WHERE id = ?`).run(co.id);
  });
  apply();
  audit('CONTRACT AGENT', 'counter offer accepted', 'pass', `Owner ${req.user.name} accepted counter offer #${co.id} on deal #${deal.id} — deal updated to ${co.new_value} ${co.new_currency}`);
  notify(co.from_company_id, 'counter_accepted',
    `${req.user.name} accepted your counter offer on "${deal.title}" — sign now to close the deal.`, `/deal/${deal.id}/contract`);
  res.redirect('/deals/inbox?msg=' + encodeURIComponent('Counter offer accepted — the deal terms were updated and the counterparty was notified to sign.'));
});

app.post('/counter/:id/refuse', requireCompany, (req, res) => {
  const co = db.prepare('SELECT * FROM counter_offers WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!co) return res.redirect('/deals/inbox?err=' + encodeURIComponent('Counter offer not found.'));
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(co.deal_id);
  if (!deal || deal.company_id !== req.user.id) {
    return res.redirect('/deals/inbox?err=' + encodeURIComponent('Counter offer not found.'));
  }
  if (co.status !== 'pending') {
    return res.redirect('/deals/inbox?err=' + encodeURIComponent('This counter offer was already decided.'));
  }
  db.prepare(`UPDATE counter_offers SET status = 'refused' WHERE id = ?`).run(co.id);
  audit('CONTRACT AGENT', 'counter offer refused', 'fail', `Owner ${req.user.name} refused counter offer #${co.id} on deal #${deal.id}`);
  notify(co.from_company_id, 'counter_refused',
    `${req.user.name} refused your counter offer on "${deal.title}".`, `/deal/${deal.id}`);
  res.redirect('/deals/inbox?msg=' + encodeURIComponent('Counter offer refused. The counterparty has been notified.'));
});

// ============================= PRIVATE CONTRACTS MAILBOX =============================
// Company → company contracts that never touch a public deal. Flow:
// pending_recipient → (recipient signs w/ OTP) pending_owner → (sender approves) pending_admin → (admin) approved.
function getPrivateContract(id) {
  return db.prepare('SELECT * FROM private_contracts WHERE id = ?').get(parseInt(id, 10));
}
/** Privacy guard: only the sender, the recipient and the admin may view a private contract. */
function canViewPrivateContract(user, pc) {
  return !!user && !!pc && (user.isAdmin || user.id === pc.sender_company_id || user.id === pc.recipient_company_id);
}
/** 1% platform-fee clause for private contracts (HTML / plain-text variants). */
function pcFeeAmount(pc) {
  const num = Number(pc && pc.value);
  return isFinite(num) && num > 0 ? `${fmtAmount(num * PLATFORM_FEE_PCT / 100)} ${pc.currency || 'USD'}` : `1% of contract value`;
}
function pcFeeLineHtml(pc, style) {
  return `<div class="muted" style="font-size:12px;${style || ''}">🏦 Platform fee: ${PLATFORM_FEE_PCT}% (${esc(pcFeeAmount(pc))}) — transparent Dealzoin commission</div>`;
}
function pcFeeLineText(pc) {
  return `Platform fee: ${PLATFORM_FEE_PCT}% (${pcFeeAmount(pc)}) — transparent Dealzoin commission`;
}
/** A letter is "sealed" while the mailbox owner owes the next action on it. */
function pcIsSealed(pc, viewerId) {
  if (pc.status === 'pending_recipient') return pc.recipient_company_id === viewerId;
  if (pc.status === 'pending_owner') return pc.sender_company_id === viewerId;
  return false;
}

// ----- Compose: GET /contracts/new -----
app.get('/contracts/new', requireCompany, (req, res) => {
  const q = String(req.query.q || '').trim();
  let recipients;
  if (q) {
    const like = '%' + q.replace(/[%_]/g, '') + '%';
    recipients = db.prepare(`SELECT id, name FROM companies WHERE status = 'approved' AND id != ? AND name LIKE ? ORDER BY name LIMIT 20`).all(req.user.id, like);
  } else {
    recipients = db.prepare(`SELECT id, name FROM companies WHERE status = 'approved' AND id != ? ORDER BY name LIMIT 50`).all(req.user.id);
  }
  const options = recipients.length
    ? recipients.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')
    : '';
  const body = `
  <div class="card vault" style="max-width:560px;margin:0 auto">
    <div class="kicker">Private contracts</div>
    <h2 style="margin:6px 0 10px">✉️ New private contract</h2>
    <p class="muted" style="margin-bottom:12px">Sealed company-to-company — never posted to any feed. Only the two parties and the admin can read it.</p>
    <form method="GET" action="/contracts/new" style="display:flex;gap:8px;margin-bottom:14px">
      <input type="text" name="q" value="${esc(q)}" placeholder="Search a company by name…" style="margin-bottom:0">
      <button class="btn btn-sm btn-outline" type="submit">Search</button>
    </form>
    ${recipients.length ? `
    <form method="POST" action="/contracts">
      <label>Recipient company</label>
      <select name="recipient" required>${options}</select>
      <label>Letter subject</label>
      <input type="text" name="title" required maxlength="160" placeholder="e.g. Exclusivity &amp; supply agreement">
      <div class="grid2" style="gap:10px">
        <div><label>Value</label><input type="number" name="value" min="0" step="any" placeholder="50000"></div>
        <div><label>Currency</label><select name="currency">${optionsHtml(DEAL_CURRENCIES, 'USD')}</select></div>
      </div>
      <label>Terms of the offer</label>
      <textarea name="terms" rows="6" required maxlength="4000" placeholder="Scope, deliverables, payment schedule…"></textarea>
      ${'<div class="muted" style="font-size:12px;margin-bottom:12px">🏦 A transparent ' + PLATFORM_FEE_PCT + '% Dealzoin platform fee applies and is disclosed to both parties.</div>'}
      <button class="btn" type="submit">Seal &amp; send</button>
      <a class="btn btn-outline" href="/contracts" style="margin-left:8px">Discard draft</a>
    </form>` : `<p class="muted">No approved companies match. <a href="/contracts/new">Clear the search</a> to list all.</p>`}
  </div>`;
  res.send(page('New private contract', body, req.user, req.query.msg, req.query.err, 'contracts'));
});

// ----- Mailbox: GET /contracts (tabs Received / Sent; filters All / Sealed / Opened / Signed) -----
app.get('/contracts', requireCompany, (req, res) => {
  const tab = req.query.tab === 'sent' ? 'sent' : 'received';
  const filter = ['sealed', 'opened', 'signed'].includes(req.query.filter) ? req.query.filter : 'all';
  const rows = tab === 'sent'
    ? db.prepare('SELECT * FROM private_contracts WHERE sender_company_id = ? ORDER BY id DESC LIMIT 100').all(req.user.id)
    : db.prepare('SELECT * FROM private_contracts WHERE recipient_company_id = ? ORDER BY id DESC LIMIT 100').all(req.user.id);
  const names = companyNameMap();
  const isSigned = s => ['pending_owner', 'pending_admin', 'approved'].includes(s);
  const shown = rows.filter(pc => {
    if (filter === 'sealed') return pcIsSealed(pc, req.user.id);
    if (filter === 'opened') return !pcIsSealed(pc, req.user.id);
    if (filter === 'signed') return isSigned(pc.status);
    return true;
  });

  const rowHtml = shown.length ? shown.map(pc => {
    const sealed = pcIsSealed(pc, req.user.id);
    const otherId = tab === 'sent' ? pc.recipient_company_id : pc.sender_company_id;
    const otherName = names.get(otherId) || 'Unknown';
    const amount = Number(pc.value) > 0 ? `<span class="mail-amount">${esc(fmtAmount(Number(pc.value)))} ${esc(pc.currency || 'USD')}</span>` : '';
    return `<a class="mail-row ${sealed ? 'mail-row--sealed' : 'mail-row--opened'}" href="/contracts/${pc.id}"
        title="${sealed ? 'Sealed — open to read the terms' : 'Opened · seal spent'}">
      <span class="wax-seal"><span>Dz</span></span>
      <div class="mail-main">
        <div class="mail-subject">${esc(pc.title)}</div>
        <div class="mail-sender">${tab === 'sent' ? 'To' : 'From'}: ${esc(otherName)} · ${esc((pc.terms || '').slice(0, 80))}${(pc.terms || '').length > 80 ? '…' : ''}</div>
      </div>
      <div style="text-align:right">
        ${amount}<br>
        <span class="mail-date">${esc(pc.created_at.slice(0, 10))}</span><br>
        ${statusBadge(pc.status)}
      </div>
    </a>`;
  }).join('') : `<div class="card"><p class="muted">${tab === 'sent'
      ? 'Nothing sent. Seal your first offer and put it in the post.'
      : 'No letters yet. When a company offers you a contract, it arrives here — sealed in gold.'}</p></div>`;

  const filterHref = f => `/contracts?tab=${tab}${f === 'all' ? '' : '&filter=' + f}`;
  const body = `
  <div class="feed-head" style="margin-bottom:4px">
    <div>
      <div class="kicker">Private contracts</div>
      <h1 style="font-size:1.75rem;margin-top:4px">The Sealed Ledger</h1>
    </div>
    <a class="btn" href="/contracts/new">✉️ New private contract</a>
  </div>
  <div class="tab-row" style="max-width:420px">
    <a href="/contracts?tab=received" class="${tab === 'received' ? 'tab-active' : ''}">Received</a>
    <a href="/contracts?tab=sent" class="${tab === 'sent' ? 'tab-active' : ''}">Sent</a>
  </div>
  <div class="mail-filters">
    ${['all', 'sealed', 'opened', 'signed'].map(f => `<a href="${filterHref(f)}" class="${filter === f ? 'pill-active' : ''}">${f[0].toUpperCase() + f.slice(1)}</a>`).join('')}
  </div>
  ${rowHtml}`;
  res.send(page('Contracts', body, req.user, req.query.msg, req.query.err, 'contracts'));
});

// ----- Create: POST /contracts -----
app.post('/contracts', requireCompany, (req, res) => {
  const recipientId = parseInt(req.body.recipient, 10);
  const title = String(req.body.title || '').trim().slice(0, 160);
  const terms = String(req.body.terms || '').trim().slice(0, 4000);
  const currency = DEAL_CURRENCIES.includes(req.body.currency) ? req.body.currency : 'USD';
  const rawValue = String(req.body.value || '').trim();
  const value = rawValue === '' ? null : parseFloat(rawValue);
  if (!title || !terms) return res.redirect('/contracts/new?err=' + encodeURIComponent('Subject and terms are required.'));
  if (value !== null && (!isFinite(value) || value < 0)) return res.redirect('/contracts/new?err=' + encodeURIComponent('Value must be a valid non-negative number.'));
  const recipient = db.prepare(`SELECT id, name FROM companies WHERE id = ? AND status = 'approved'`).get(recipientId);
  if (!recipient || recipient.id === req.user.id) {
    return res.redirect('/contracts/new?err=' + encodeURIComponent('Choose another approved company as recipient.'));
  }
  const info = db.prepare(`INSERT INTO private_contracts (sender_company_id, recipient_company_id, title, value, currency, terms, status, created_at)
    VALUES (?,?,?,?,?,?, 'pending_recipient', ?)`).run(req.user.id, recipient.id, title, value, currency, terms, now());
  const pcId = info.lastInsertRowid;
  audit('CONTRACT AGENT', 'private contract created', 'pass', `${req.user.name} sealed private contract #${pcId} "${title}" to ${recipient.name}${value ? ` (${fmtAmount(value)} ${currency})` : ''}`);
  notify(recipient.id, 'private_contract', `${req.user.name} sent you a sealed private contract: "${title}". Open it in your contracts mailbox.`, `/contracts/${pcId}`);
  res.redirect('/contracts?tab=sent&msg=' + encodeURIComponent('Contract sealed & sent. The recipient has been notified.'));
});

// ----- View one letter: GET /contracts/:id (parties + admin only) -----
app.get('/contracts/:id', (req, res) => {
  const pc = getPrivateContract(req.params.id);
  const user = currentUser(req);
  if (!pc) return res.status(404).send(page('Not found', '<div class="card"><h2>Contract not found</h2></div>', user));
  if (!canViewPrivateContract(user, pc)) {
    audit('CONTRACT AGENT', 'private contract access', 'fail', `Unauthorized view attempt on private contract #${pc.id} by ${user ? user.name : 'anonymous'}`);
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Private contract</h2><p class="muted">Only the sender, the recipient and the admin can view this contract.</p></div>', user));
  }
  const names = companyNameMap();
  const senderName = names.get(pc.sender_company_id) || 'Unknown';
  const recipientName = names.get(pc.recipient_company_id) || 'Unknown';
  const isRecipient = !user.isAdmin && user.id === pc.recipient_company_id;
  const isSender = !user.isAdmin && user.id === pc.sender_company_id;

  let actions = '';
  if (isRecipient && pc.status === 'pending_recipient') {
    actions = `
    <hr class="sep">
    <h3 style="margin-bottom:8px">✍️ Sign this contract</h3>
    <form method="POST" action="/contracts/${pc.id}/sign">
      <label>Re-enter your account password (signing authority check)</label>
      <input type="password" name="password" required>
      <label style="display:flex;gap:8px;align-items:center;margin:10px 0">
        <input type="checkbox" name="authorized" value="yes" style="width:auto;margin:0" required>
        I am an authorized signatory of my company</label>
      <label style="display:flex;gap:8px;align-items:center;margin:10px 0">
        <input type="checkbox" name="agree" value="yes" style="width:auto;margin:0" required>
        I agree to the terms of this contract</label>
      <button class="btn btn-green" type="submit" onclick="this.textContent='Verifying…'">Verify &amp; continue →</button>
      <p class="muted" style="margin-top:8px">Step 1 of 2 — next, the Authentication Agent sends a one-time signing code to your business email.</p>
    </form>
    <form method="POST" action="/contracts/${pc.id}/decline" style="margin-top:8px">
      <button class="btn btn-danger" type="submit">Decline contract</button>
    </form>`;
  } else if (isSender && pc.status === 'pending_owner') {
    actions = `
    <hr class="sep">
    <p class="muted" style="margin-bottom:10px">${esc(recipientName)} has signed. Your approval forwards the contract to the admin for final approval.</p>
    <form method="POST" action="/contracts/${pc.id}/sender-approve">
      <button class="btn btn-green" type="submit">Approve → send to admin</button>
    </form>`;
  } else if (pc.status === 'pending_admin') {
    actions = `<hr class="sep"><p class="muted">Both parties have signed — awaiting admin final approval.</p>`;
  }

  const finalized = pc.status === 'approved'
    ? `<p style="margin-top:10px"><span class="badge badge-contract">Finalized ✓</span> <span class="muted">Approved by the admin. This contract is kept on file in both mailboxes.</span></p>` : '';
  const valueLine = Number(pc.value) > 0
    ? `<p><b>Value:</b> <span class="deal-value" style="font-size:1.05rem">${esc(fmtAmount(Number(pc.value)))} ${esc(pc.currency || 'USD')}</span></p>${pcFeeLineHtml(pc)}` : '';

  const body = `
  <div class="card vault">
    <div class="kicker" style="margin-bottom:6px">Private contract · sealed ledger</div>
    <h2>✉️ ${esc(pc.title)}</h2>
    <p class="muted">Contract #${pc.id} · sealed ${esc(pc.created_at.slice(0, 16).replace('T', ' '))} UTC
      ${pc.signed_at ? ' · signed ' + esc(pc.signed_at.slice(0, 16).replace('T', ' ')) + ' UTC' : ''}
      ${pc.decided_at ? ' · decided ' + esc(pc.decided_at.slice(0, 16).replace('T', ' ')) + ' UTC' : ''}</p>
    <p style="margin-top:8px">${statusBadge(pc.status)}</p>
    <hr class="sep">
    <p><b>From (sender):</b> ${esc(senderName)} ${starsHtml(companyReputation(pc.sender_company_id), true)}</p>
    <p><b>To (recipient):</b> ${esc(recipientName)} ${starsHtml(companyReputation(pc.recipient_company_id), true)}</p>
    ${valueLine}
    <h3 style="margin:14px 0 6px">Terms of the offer</h3>
    <p style="white-space:pre-wrap">${esc(pc.terms)}</p>
    <h3 style="margin:14px 0 6px">Platform fee clause</h3>
    <p class="muted" style="font-size:13px">${esc('10. PLATFORM FEE. A transparent platform commission of 1% of the stated contract value is payable to Dealzoin. This fee is disclosed to both parties before signing and is separate from the value exchanged between the parties.')}</p>
    ${pcFeeLineHtml(pc, 'margin-top:6px')}
    ${finalized}
    <div class="feed-actions" style="margin-top:16px">
      <a class="btn btn-sm btn-outline" href="/contracts/${pc.id}/download">Download contract document</a>
      <a class="btn btn-sm btn-outline" href="/contracts">← Mailbox</a>
    </div>
    ${actions}
  </div>`;
  res.send(page('Private contract — ' + pc.title, body, user, req.query.msg, req.query.err, user.isAdmin ? undefined : 'contracts'));
});

// ----- Download the letter as a Word-compatible document -----
app.get('/contracts/:id/download', (req, res) => {
  const pc = getPrivateContract(req.params.id);
  const user = currentUser(req);
  if (!pc) return res.status(404).send(page('Not found', '<div class="card"><h2>Contract not found</h2></div>', user));
  if (!canViewPrivateContract(user, pc)) {
    audit('CONTRACT AGENT', 'private contract download', 'fail', `Unauthorized download attempt on private contract #${pc.id} by ${user ? user.name : 'anonymous'}`);
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Private contract</h2><p class="muted">Only the sender, the recipient and the admin can download this contract.</p></div>', user));
  }
  const names = companyNameMap();
  const doc = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
<head><meta charset="utf-8"><title>Private Contract #${pc.id}</title></head>
<body style="font-family:Calibri,Arial,sans-serif">
  <h1>Private Contract #${pc.id}</h1>
  <h2>${esc(pc.title)}</h2>
  <p><b>From (sender):</b> ${esc(names.get(pc.sender_company_id) || 'Unknown')}<br>
     <b>To (recipient):</b> ${esc(names.get(pc.recipient_company_id) || 'Unknown')}<br>
     ${Number(pc.value) > 0 ? `<b>Value:</b> ${esc(fmtAmount(Number(pc.value)))} ${esc(pc.currency || 'USD')}<br>` : ''}
     <b>${esc(pcFeeLineText(pc))}</b><br>
     <b>Status:</b> ${esc(pc.status.replace(/_/g, ' '))}<br>
     <b>Sealed:</b> ${esc(pc.created_at)}${pc.signed_at ? `<br><b>Signed:</b> ${esc(pc.signed_at)}` : ''}${pc.decided_at ? `<br><b>Decided:</b> ${esc(pc.decided_at)}` : ''}</p>
  <h3>Terms of the offer</h3><p>${esc(pc.terms)}</p>
  <h3>Platform fee clause</h3>
  <p>${esc('10. PLATFORM FEE. A transparent platform commission of 1% of the stated contract value is payable to Dealzoin. This fee is disclosed to both parties before signing and is separate from the value exchanged between the parties.')}</p>
  <p>__________________________&nbsp;&nbsp;&nbsp;__________________________<br>
  Sender signature&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Recipient signature</p>
</body></html>`;
  res.setHeader('Content-Type', 'application/msword');
  res.setHeader('Content-Disposition', `attachment; filename="private-contract-${pc.id}.doc"`);
  res.send(doc);
});

/** Loader for the private-contract signing OTP (payload.pc must match the contract id). */
function loadPcOtpContext(req, pcId) {
  const token = readSignedCookie(req, 'dz_sign');
  if (!token) return null;
  const row = db.prepare(`SELECT * FROM verification_codes WHERE token = ? AND purpose = 'sign'`).get(token);
  if (!row || row.company_id !== req.user.id) return null;
  let payload = {};
  try { payload = JSON.parse(row.payload || '{}'); } catch (e) { payload = {}; }
  if (payload.pc !== pcId) return null;
  return { row, payload };
}

// ----- Recipient signing step 1: password + declarations, then a signing OTP -----
app.post('/contracts/:id/sign', requireCompany, (req, res) => {
  const pc = getPrivateContract(req.params.id);
  if (!pc) return res.redirect('/contracts?err=' + encodeURIComponent('Contract not found.'));
  if (pc.recipient_company_id !== req.user.id) {
    audit('CONTRACT AGENT', 'private contract sign guard', 'fail', `${req.user.name} attempted to sign private contract #${pc.id} without being the recipient`);
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Only the recipient can sign this contract.</h2></div>', req.user));
  }
  if (pc.status !== 'pending_recipient') {
    return res.redirect(`/contracts/${pc.id}?err=` + encodeURIComponent('This contract is not awaiting your signature.'));
  }

  // (a) password re-verification
  const me = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.user.id);
  if (!verifyPassword(String(req.body.password || ''), me.salt, me.password_hash)) {
    audit('AUTHENTICATION AGENT', 'signing password re-verification', 'fail', `Wrong password at private-contract signing for ${me.email} (contract #${pc.id})`);
    return res.redirect(`/contracts/${pc.id}?err=` + encodeURIComponent('Password verification failed.'));
  }
  audit('AUTHENTICATION AGENT', 'signing password re-verification', 'pass', `Password re-verified for ${me.email} (private contract #${pc.id})`);
  // (b) authorized-signatory checkbox
  if (req.body.authorized !== 'yes') {
    audit('AUTHENTICATION AGENT', 'signatory authority checkbox', 'fail', `Not confirmed by ${me.email} (private contract #${pc.id})`);
    return res.redirect(`/contracts/${pc.id}?err=` + encodeURIComponent('You must confirm you are an authorized signatory.'));
  }
  // (c) agree-to-terms checkbox
  if (req.body.agree !== 'yes') {
    audit('AUTHENTICATION AGENT', 'terms agreement checkbox', 'fail', `Terms not accepted by ${me.email} (private contract #${pc.id})`);
    return res.redirect(`/contracts/${pc.id}?err=` + encodeURIComponent('You must agree to the terms.'));
  }
  audit('AUTHENTICATION AGENT', 'signing declarations', 'pass', `Authorized signatory + terms confirmed by ${me.email} (private contract #${pc.id})`);

  // (d) step 2 — one-time signing code (Brevo email, or demo banner without an API key)
  const code = String(crypto.randomInt(100000, 1000000));
  const token = randomToken();
  db.prepare(`DELETE FROM verification_codes WHERE company_id = ? AND purpose = 'sign'`).run(me.id);
  db.prepare('INSERT INTO verification_codes (token, company_id, code, purpose, payload, expires_at, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(token, me.id, code, 'sign', JSON.stringify({ pc: pc.id }), new Date(Date.now() + CODE_TTL_MS).toISOString(), now());
  sendVerificationCode(me.email, code);
  audit('AUTHENTICATION AGENT', 'signing OTP issued', 'pass', `Signing code issued for ${me.email} (private contract #${pc.id}, 10-min expiry)`);

  res.setHeader('Set-Cookie', `dz_sign=${signedCookieValue(token)}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax${isSecureReq(req) ? '; Secure' : ''}`);
  res.redirect(`/contracts/${pc.id}/sign/verify`);
});

// ----- Recipient signing step 2: enter the one-time code to execute the signature -----
app.get('/contracts/:id/sign/verify', requireCompany, (req, res) => {
  const pc = getPrivateContract(req.params.id);
  if (!pc) return res.redirect('/contracts?err=' + encodeURIComponent('Contract not found.'));
  if (pc.recipient_company_id !== req.user.id) return res.redirect('/contracts?err=' + encodeURIComponent('Contract not found.'));
  const ctx = loadPcOtpContext(req, pc.id);
  if (!ctx) return res.redirect(`/contracts/${pc.id}?err=` + encodeURIComponent('No signing verification in progress. Please start again.'));

  const demo = BREVO_API_KEY ? '' : `
    <div class="demo-banner">⚠️ <b>DEMO MODE</b> — no BREVO_API_KEY configured, so the email was not sent.
    Your signing code is: <b style="font-size:18px;letter-spacing:3px">${esc(ctx.row.code)}</b></div>`;
  const body = `
  <div class="card vault" style="max-width:480px;margin:0 auto">
    <div class="kicker" style="margin-bottom:6px">Step 2 of 2 · signing code</div>
    <h2>✍️ Confirm your signature</h2>
    <p class="muted" style="margin-bottom:12px">The Authentication Agent sent a 6-digit signing code to your business email. Enter it to sign <b>${esc(pc.title)}</b>.</p>
    ${demo}
    <form method="POST" action="/contracts/${pc.id}/sign/verify">
      <label>6-digit signing code</label><input type="text" name="code" required pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code">
      <button class="btn btn-green" type="submit">Sign contract</button>
    </form>
    <p class="shield-note">🛡️ Protected by Dealzoin security agents</p>
  </div>`;
  res.send(page('Confirm signature', body, req.user, req.query.msg, req.query.err, 'contracts'));
});

app.post('/contracts/:id/sign/verify', requireCompany, (req, res) => {
  const pc = getPrivateContract(req.params.id);
  if (!pc) return res.redirect('/contracts?err=' + encodeURIComponent('Contract not found.'));
  if (pc.recipient_company_id !== req.user.id) {
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Only the recipient can sign this contract.</h2></div>', req.user));
  }
  const code = String(req.body.code || '').trim();
  const ctx = loadPcOtpContext(req, pc.id);
  if (!ctx || ctx.row.expires_at < now()) {
    audit('AUTHENTICATION AGENT', 'signing OTP verify', 'fail', `Private-contract signing code expired or missing for ${req.user.name} (contract #${pc.id})`);
    return res.redirect(`/contracts/${pc.id}?err=` + encodeURIComponent('Signing code expired. Please start signing again.'));
  }
  const a = Buffer.from(code.padEnd(6, ' '));
  const b = Buffer.from(ctx.row.code.padEnd(6, ' '));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    audit('AUTHENTICATION AGENT', 'signing OTP verify', 'fail', `Wrong private-contract signing code for ${req.user.name} (contract #${pc.id})`);
    return res.redirect(`/contracts/${pc.id}/sign/verify?err=` + encodeURIComponent('Incorrect code. Try again.'));
  }
  if (pc.status !== 'pending_recipient') {
    db.prepare('DELETE FROM verification_codes WHERE id = ?').run(ctx.row.id);
    return res.redirect(`/contracts/${pc.id}?err=` + encodeURIComponent('This contract is not awaiting your signature.'));
  }

  db.prepare('DELETE FROM verification_codes WHERE id = ?').run(ctx.row.id);
  const ts = now();
  db.prepare(`UPDATE private_contracts SET status = 'pending_owner', signed_at = ? WHERE id = ?`).run(ts, pc.id);
  res.setHeader('Set-Cookie', 'dz_sign=; HttpOnly; Path=/; Max-Age=0');
  audit('AUTHENTICATION AGENT', 'signing OTP verify', 'pass', `Signing code verified for ${req.user.name} (private contract #${pc.id})`);
  audit('CONTRACT AGENT', 'private contract signed', 'pass', `${req.user.name} signed private contract #${pc.id} "${pc.title}" at ${ts} — pending sender approval`);
  notify(pc.sender_company_id, 'private_contract_signed', `${req.user.name} signed your private contract "${pc.title}". Review and approve it from your contracts mailbox.`, `/contracts/${pc.id}`);
  res.redirect(`/contracts/${pc.id}?msg=` + encodeURIComponent('Contract signed and filed. The ledger remembers. 🪙'));
});

// ----- Recipient declines -----
app.post('/contracts/:id/decline', requireCompany, (req, res) => {
  const pc = getPrivateContract(req.params.id);
  if (!pc || pc.recipient_company_id !== req.user.id) {
    return res.redirect('/contracts?err=' + encodeURIComponent('Contract not found.'));
  }
  if (pc.status !== 'pending_recipient') {
    return res.redirect(`/contracts/${pc.id}?err=` + encodeURIComponent('This contract was already decided.'));
  }
  db.prepare(`UPDATE private_contracts SET status = 'rejected', decided_at = ? WHERE id = ?`).run(now(), pc.id);
  audit('CONTRACT AGENT', 'private contract declined', 'fail', `${req.user.name} declined private contract #${pc.id} "${pc.title}"`);
  notify(pc.sender_company_id, 'private_contract_rejected', `${req.user.name} declined your private contract "${pc.title}".`, `/contracts/${pc.id}`);
  res.redirect('/contracts?msg=' + encodeURIComponent('Contract declined. The sender has been notified.'));
});

// ----- Sender (owner) approves the recipient's signature → admin queue -----
app.post('/contracts/:id/sender-approve', requireCompany, (req, res) => {
  const pc = getPrivateContract(req.params.id);
  if (!pc || pc.sender_company_id !== req.user.id) {
    return res.redirect('/contracts?err=' + encodeURIComponent('Contract not found.'));
  }
  if (pc.status !== 'pending_owner') {
    return res.redirect(`/contracts/${pc.id}?err=` + encodeURIComponent('This contract is not awaiting your approval.'));
  }
  db.prepare(`UPDATE private_contracts SET status = 'pending_admin' WHERE id = ?`).run(pc.id);
  audit('CONTRACT AGENT', 'sender approve private contract', 'pass', `Sender ${req.user.name} approved private contract #${pc.id} "${pc.title}" — forwarded to admin for final approval`);
  notify(pc.recipient_company_id, 'private_contract_owner_approved', `${req.user.name} approved the signed private contract "${pc.title}" — awaiting admin final approval.`, `/contracts/${pc.id}`);
  res.redirect(`/contracts/${pc.id}?msg=` + encodeURIComponent('Approved — the contract now awaits admin final approval.'));
});

// ============================= MEDIA SERVING =============================
app.get('/media/:id', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.redirect('/login?err=' + encodeURIComponent('Please sign in to view media.'));
  const m = db.prepare('SELECT * FROM media WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!m) return res.status(404).send(page('Not found', '<div class="card"><h2>Media not found</h2></div>', user));
  res.setHeader('Content-Type', m.mime);
  res.setHeader('Content-Length', m.data.length);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(m.data);
});

// ============================= HOME FEED → TIMELINE =============================
// The home feed was merged into the (following-only) timeline; keep the route as a redirect.
app.get('/home', requireCompany, (req, res) => {
  res.redirect(302, '/timeline');
});

// ============================= CREATE MENU (/new) =============================
app.get('/new', requireCompany, (req, res) => {
  const mediaInput = fileButtonHtml();
  const body = `
  <div class="card" style="text-align:center">
    <h2>What are we putting on the wire?</h2>
    <p class="muted">Deals carry a value and can be signed into contracts; feed posts keep the network warm.</p>
  </div>
  <div class="grid2">
    <div class="card card-deal create-card">
      <div class="big-ic">📄</div>
      <h2>Post a deal</h2>
      <p class="muted">Title, value, description — plus an optional photo or video.</p>
      <form method="POST" action="/deals" enctype="multipart/form-data" style="margin-top:14px;text-align:left">
        <label>Deal title</label><input type="text" name="title" required maxlength="160">
        <label>Deal value (e.g. 50,000 / year)</label><input type="text" name="value" maxlength="80">
        <div class="grid2" style="gap:10px">
          <div><label>Currency</label><select name="currency">${optionsHtml(DEAL_CURRENCIES, 'USD')}</select></div>
          <div><label>Time period</label><select name="time_period">${optionsHtml(DEAL_TIME_PERIODS, '30 days')}</select></div>
        </div>
        <label>Description</label><textarea name="description" rows="4" required maxlength="4000"></textarea>
        <label>Photo or video (optional — image ≤ 5 MB, video ≤ 25 MB)</label>${mediaInput}
        <button class="btn" type="submit">Publish deal</button>
      </form>
    </div>
    <div class="card create-card">
      <div class="big-ic">💬</div>
      <h2>Post a feed</h2>
      <p class="muted">Share an update with the network — text plus an optional photo or video.</p>
      <form method="POST" action="/posts" enctype="multipart/form-data" style="margin-top:14px;text-align:left">
        <label>Update</label><textarea name="body" rows="5" required maxlength="2000" placeholder="What's happening in your business?"></textarea>
        <label>Photo or video (optional — image ≤ 5 MB, video ≤ 25 MB)</label>${mediaInput}
        <button class="btn" type="submit">Post update</button>
      </form>
    </div>
  </div>`;
  res.send(page('Create', body, req.user, req.query.msg, req.query.err, 'new'));
});

// ============================= PROFILE (/profile) =============================
app.get('/profile', requireCompany, (req, res) => {
  const c = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.user.id);
  if (!c) return res.redirect('/login?err=' + encodeURIComponent('Please sign in again.'));
  const fc = followCounts(c.id);
  const names = companyNameMap();
  const deals = db.prepare('SELECT * FROM deals WHERE company_id = ? ORDER BY created_at DESC LIMIT 50').all(c.id);
  const posts = db.prepare('SELECT * FROM posts WHERE company_id = ? ORDER BY created_at DESC LIMIT 50').all(c.id);
  const dealsHtml = deals.length
    ? deals.map(d => feedCard(dealFeedItem(d), req.user, names)).join('')
    : '<div class="card"><p class="muted">No deals yet — <a href="/deals/new">post your first deal</a>.</p></div>';
  const postsHtml = posts.length
    ? posts.map(p => feedCard({ kind: 'post', ref_id: p.id, company_id: p.company_id, body: p.body, created_at: p.created_at, media_id: p.media_id }, req.user, names)).join('')
    : '<div class="card"><p class="muted">No posts yet — share an update from the <a href="/new">create menu</a>.</p></div>';

  const coverHtml = c.header_media_id ? `<img class="profile-cover" src="/media/${c.header_media_id}" alt="${esc(c.name)} header image" loading="lazy">` : '';
  const body = `
  <div class="card">
    ${coverHtml}
    <div class="feed-head"><h2>${avatarHtml(c.name, c.avatar_media_id, 'avatar-lg')}${esc(c.name)}</h2>
      <a class="btn btn-sm btn-outline" href="/company/${c.id}">View public profile</a></div>
    <p style="margin-top:6px">${starsHtml(c.reputation)}</p>
    ${c.bio ? `<p class="profile-bio">${esc(c.bio)}</p>` : ''}
    <p class="muted">${esc(c.email)} · ${fc.followers} followers · ${fc.following} following · member since ${esc(c.created_at.slice(0, 10))}</p>
    ${c.website ? `<p style="margin-top:8px">🌐 <a href="${esc(c.website)}" rel="noopener noreferrer nofollow">${esc(c.website)}</a></p>` : ''}
    <p style="margin-top:10px;white-space:pre-wrap">${esc(c.description || '')}</p>
  </div>
  ${c.about ? `<div class="card"><h3>About</h3><p class="profile-about">${esc(c.about)}</p></div>` : ''}
  <h2 class="sec-h">Edit profile</h2>
  <div class="card">
    <h3>Profile images</h3>
    <div class="grid2">
      <form method="POST" action="/profile/avatar" enctype="multipart/form-data">
        <label>Avatar (square image works best)</label>
        ${fileButtonHtml('📎 Attach avatar image')}
        <button class="btn btn-sm" type="submit">Upload avatar</button>
      </form>
      <form method="POST" action="/profile/header" enctype="multipart/form-data">
        <label>Header / cover image (wide banner)</label>
        ${fileButtonHtml('📎 Attach header image')}
        <button class="btn btn-sm" type="submit">Upload header</button>
      </form>
    </div>
  </div>
  <div class="card">
    <h3>Bio &amp; about</h3>
    <form method="POST" action="/profile/info">
      <label>Bio — one-liner under your name (max 160 characters)</label>
      <input type="text" name="bio" maxlength="160" value="${esc(c.bio || '')}" placeholder="e.g. Industrial robotics, delivered.">
      <label>About — the full story (max 2000 characters)</label>
      <textarea name="about" rows="6" maxlength="2000" placeholder="What your company does, who you serve, why you win.">${esc(c.about || '')}</textarea>
      <button class="btn" type="submit">Save bio &amp; about</button>
    </form>
  </div>
  <div class="stats">
    <div class="stat"><div class="num gold">${deals.length}</div><div class="lbl">My deals</div></div>
    <div class="stat"><div class="num">${posts.length}</div><div class="lbl">My posts</div></div>
    <div class="stat"><div class="num mint">${fc.followers}</div><div class="lbl">Followers</div></div>
    <div class="stat"><div class="num">${fc.following}</div><div class="lbl">Following</div></div>
  </div>
  <h2 class="sec-h">My deals</h2>
  ${dealsHtml}
  <h2 class="sec-h">My posts</h2>
  ${postsHtml}`;
  res.send(page('My profile', body, req.user, req.query.msg, req.query.err, 'profile'));
});

// ----- Profile editing: avatar, header/cover image, bio & about -----
function profileImageUpload(field) {
  return [requireCompany, mediaUpload, (req, res) => {
    if (!req.file) return res.redirect('/profile?err=' + encodeURIComponent('Choose an image to upload first.'));
    if (!String(req.file.mimetype).startsWith('image/')) {
      return res.redirect('/profile?err=' + encodeURIComponent('Profile images must be image files (JPG, PNG, GIF or WEBP).'));
    }
    const mediaId = saveMedia(req.user.id, req.file);
    db.prepare(`UPDATE companies SET ${field} = ? WHERE id = ?`).run(mediaId, req.user.id);
    res.redirect('/profile?msg=' + encodeURIComponent(field === 'avatar_media_id' ? 'Avatar updated.' : 'Header image updated.'));
  }];
}
app.post('/profile/avatar', ...profileImageUpload('avatar_media_id'));
app.post('/profile/header', ...profileImageUpload('header_media_id'));

app.post('/profile/info', requireCompany, (req, res) => {
  const bio = String(req.body.bio || '').trim().slice(0, 160);
  const about = String(req.body.about || '').trim().slice(0, 2000);
  db.prepare('UPDATE companies SET bio = ?, about = ? WHERE id = ?').run(bio, about, req.user.id);
  res.redirect('/profile?msg=' + encodeURIComponent('Profile updated.'));
});

// ============================= DASHBOARD (/dashboard) =============================
app.get('/dashboard', requireCompany, (req, res) => {
  const myId = req.user.id;
  const count = (sql, ...args) => db.prepare(sql).get(...args).n;
  const stats = {
    deals: count('SELECT COUNT(*) AS n FROM deals WHERE company_id = ?', myId),
    posts: count('SELECT COUNT(*) AS n FROM posts WHERE company_id = ?', myId),
    followers: count('SELECT COUNT(*) AS n FROM follows WHERE followed_id = ?', myId),
    likesReceived: count(`SELECT COUNT(*) AS n FROM likes l WHERE
      (l.target_type = 'deal' AND l.target_id IN (SELECT id FROM deals WHERE company_id = ?)) OR
      (l.target_type = 'post' AND l.target_id IN (SELECT id FROM posts WHERE company_id = ?))`, myId, myId),
    commentsReceived: count(`SELECT COUNT(*) AS n FROM comments c WHERE
      (c.target_type = 'deal' AND c.target_id IN (SELECT id FROM deals WHERE company_id = ?)) OR
      (c.target_type = 'post' AND c.target_id IN (SELECT id FROM posts WHERE company_id = ?))`, myId, myId),
    signedPending: count(`SELECT COUNT(*) AS n FROM contracts WHERE signer_company_id = ? AND status IN ('pending','pending_owner','pending_admin')`, myId),
    signedApproved: count(`SELECT COUNT(*) AS n FROM contracts WHERE signer_company_id = ? AND status = 'approved'`, myId),
    minePending: count(`SELECT COUNT(*) AS n FROM contracts WHERE owner_company_id = ? AND status IN ('pending','pending_owner','pending_admin')`, myId),
    mineApproved: count(`SELECT COUNT(*) AS n FROM contracts WHERE owner_company_id = ? AND status = 'approved'`, myId),
    inboxActions: count(`SELECT
      (SELECT COUNT(*) FROM contracts WHERE owner_company_id = ? AND status = 'pending_owner') +
      (SELECT COUNT(*) FROM counter_offers co JOIN deals d ON d.id = co.deal_id WHERE d.company_id = ? AND co.status = 'pending') AS n`, myId, myId)
  };
  const tiles = [
    ['My deals', stats.deals, ' gold'], ['My posts', stats.posts, ''], ['Followers', stats.followers, ' mint'],
    ['Likes received', stats.likesReceived, ' gold'], ['Comments received', stats.commentsReceived, ''],
    ['Contracts I signed', stats.signedPending + ' pending · ' + stats.signedApproved + ' approved', ''],
    ['Contracts on my deals', stats.minePending + ' pending · ' + stats.mineApproved + ' approved', '']
  ];
  const tilesHtml = `<div class="stats">${tiles.map(([l, n, cls]) => `<div class="stat"><div class="num${cls}">${n}</div><div class="lbl">${l}</div></div>`).join('')}</div>`;

  // My deals table + per-deal chart data
  const myDeals = db.prepare('SELECT * FROM deals WHERE company_id = ? ORDER BY created_at DESC LIMIT 50').all(myId);
  const barLabels = [], barLikes = [], barComments = [];
  const dealsRows = myDeals.length ? myDeals.map(d => {
    const likes = count(`SELECT COUNT(*) AS n FROM likes WHERE target_type = 'deal' AND target_id = ?`, d.id);
    const comments = count(`SELECT COUNT(*) AS n FROM comments WHERE target_type = 'deal' AND target_id = ?`, d.id);
    const ct = latestContract(d.id);
    barLabels.push(d.title.length > 18 ? d.title.slice(0, 18) + '…' : d.title);
    barLikes.push(likes);
    barComments.push(comments);
    return `<tr>
      <td><a href="/deal/${d.id}"><b>${esc(d.title)}</b></a></td>
      <td>${d.value ? `<span class="deal-value" style="font-size:0.95rem">${esc(d.value)} ${esc(d.currency || 'USD')}</span>` : '<span class="muted">—</span>'}</td>
      <td>${likes}</td><td>${comments}</td>
      <td>${ct ? statusBadge(ct.status) : (d.contract_state === 'approved' ? `<span class="badge badge-contract" title="With ${esc(d.contract_party || '')}">approved ✓</span>` : '<span class="muted">—</span>')}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="5" class="muted">No deals yet — <a href="/deals/new">post your first deal</a>.</td></tr>';

  // Contract status breakdown (all contracts involving my company)
  const statusRows = db.prepare(`SELECT status, COUNT(*) AS n FROM contracts WHERE signer_company_id = ? OR owner_company_id = ? GROUP BY status`).all(myId, myId);

  const barCard = myDeals.length
    ? `<div class="card"><h3>Likes &amp; comments per deal</h3><div class="chart-wrap"><canvas id="chart-deals"></canvas></div></div>`
    : `<div class="card"><h3>Likes &amp; comments per deal</h3><div class="dash-empty">No deals yet — this chart appears once you publish a deal.</div></div>`;
  const doughnutCard = statusRows.length
    ? `<div class="card"><h3>My contract statuses</h3><div class="chart-wrap"><canvas id="chart-contracts"></canvas></div></div>`
    : `<div class="card"><h3>My contract statuses</h3><div class="dash-empty">No contracts yet — sign a deal or receive a signature to see the breakdown.</div></div>`;

  const chartScript = `
  <script>
  (function () {
    if (!window.Chart) return;
    var cs = getComputedStyle(document.documentElement);
    var v = function (name, fb) { var x = cs.getPropertyValue(name).trim(); return x || fb; };
    var ink = v('--ink-muted', '#9A97A8'), soft = v('--border-soft', '#242435'), primary = v('--ink-primary', '#F4F1E8');
    var gold = v('--gold', '#F5B942'), mint = v('--mint', '#3FE0B0'), warn = v('--warning', '#FFB454'), dgr = v('--danger', '#FF5C7A'), faint = v('--ink-faint', '#5C5A6B'), bgv = v('--bg-void', '#0A0A12');
    var base = { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: primary } } } };
    var bar = ${jsonForHtml({ labels: barLabels, likes: barLikes, comments: barComments })};
    var bctx = document.getElementById('chart-deals');
    if (bctx && bar.labels.length) {
      new Chart(bctx, { type: 'bar',
        data: { labels: bar.labels, datasets: [
          { label: 'Likes', data: bar.likes, backgroundColor: gold, borderRadius: 6 },
          { label: 'Comments', data: bar.comments, backgroundColor: mint, borderRadius: 6 }
        ]},
        options: Object.assign({}, base, { scales: {
          y: { beginAtZero: true, ticks: { precision: 0, color: ink }, grid: { color: soft } },
          x: { ticks: { color: ink }, grid: { display: false } }
        }})
      });
    }
    var dn = ${jsonForHtml({ labels: statusRows.map(r => r.status), values: statusRows.map(r => r.n) })};
    var dctx = document.getElementById('chart-contracts');
    if (dctx && dn.labels.length) {
      var colors = { approved: mint, pending: warn, pending_owner: warn, pending_admin: gold, rejected: dgr };
      new Chart(dctx, { type: 'doughnut',
        data: { labels: dn.labels, datasets: [{ data: dn.values, backgroundColor: dn.labels.map(function (l) { return colors[l] || faint; }), borderColor: bgv, borderWidth: 2 }]},
        options: base
      });
    }
  })();
  </script>`;

  const body = `
  <h2 class="sec-h" style="margin-top:0;margin-bottom:14px">📊 Company dashboard</h2>
  <div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
    <div><h3 style="margin-bottom:2px">📥 Deal inbox</h3>
      <p class="muted">Contracts and counter offers on your deals awaiting your decision.</p></div>
    <a class="btn btn-sm${stats.inboxActions ? '' : ' btn-outline'}" href="/deals/inbox">Open inbox${stats.inboxActions ? ` <span class="unread-chip" style="margin-left:6px">${stats.inboxActions}</span>` : ''}</a>
  </div>
  ${tilesHtml}
  <div class="card"><h3>My deals</h3>
    <table><tr><th>Title</th><th>Value</th><th>Likes</th><th>Comments</th><th>Contract</th></tr>${dealsRows}</table></div>
  ${barCard}
  ${doughnutCard}
  ${chartScript}`;
  res.send(page('Dashboard', body, req.user, req.query.msg, req.query.err, 'dashboard',
    '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>'));
});

// ============================= CHATS (PRIVATE + GROUP MESSAGING) =============================
function isMember(convId, companyId) {
  return !!db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND company_id = ?').get(convId, companyId);
}
/** Display name for a conversation: group name, or the other party's company name for private chats. */
function convDisplayName(conv, viewerId, names) {
  if (conv.type === 'group') return conv.name || 'Group chat';
  const other = db.prepare('SELECT company_id FROM conversation_members WHERE conversation_id = ? AND company_id != ? LIMIT 1').get(conv.id, viewerId);
  if (other) return names.get(other.company_id) || 'Unknown';
  return names.get(viewerId) || 'Chat';
}

app.get('/chats', requireCompany, (req, res) => {
  const names = companyNameMap();
  const convs = db.prepare(`
    SELECT c.*, (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.id) AS last_at
    FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id
    WHERE cm.company_id = ?
    ORDER BY COALESCE(last_at, c.created_at) DESC`).all(req.user.id);
  const rows = convs.map(c => {
    const dn = convDisplayName(c, req.user.id, names);
    const last = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(c.id);
    const preview = last
      ? esc((names.get(last.sender_company_id) || 'Unknown') + ': ' + last.body.slice(0, 80))
      : '<span class="muted">No messages yet</span>';
    const when = esc((last ? last.created_at : c.created_at).slice(0, 16).replace('T', ' '));
    const unread = db.prepare(`
      SELECT COUNT(*) AS n FROM messages m
      WHERE m.conversation_id = ? AND m.sender_company_id != ?
        AND m.created_at > COALESCE((SELECT last_read_at FROM conversation_members WHERE conversation_id = ? AND company_id = ?), '')`)
      .get(c.id, req.user.id, c.id, req.user.id).n;
    const other = c.type === 'private'
      ? db.prepare('SELECT company_id FROM conversation_members WHERE conversation_id = ? AND company_id != ? LIMIT 1').get(c.id, req.user.id)
      : null;
    return `<a class="conv-row" href="/chat/${c.id}">
      ${avatarHtml(dn, other ? companyAvatarMediaId(other.company_id) : null)}
      <div style="flex:1;min-width:0">
        <div class="conv-name">${esc(dn)} ${c.type === 'group' ? '<span class="badge badge-pending">group</span>' : ''}</div>
        <div class="conv-preview">${preview}</div>
      </div>
      ${unread ? `<span class="unread-chip">${unread}</span>` : ''}
      <span class="muted" style="white-space:nowrap">${when}</span>
    </a>`;
  }).join('');

  // New private chat — search an approved company by name
  const q = String(req.query.q || '').trim();
  let resultsHtml = '';
  if (q) {
    const like = '%' + q.replace(/[%_]/g, '') + '%';
    const matches = db.prepare(`SELECT * FROM companies WHERE status = 'approved' AND id != ? AND name LIKE ? ORDER BY name LIMIT 20`).all(req.user.id, like);
    resultsHtml = matches.length ? matches.map(c => `
      <div class="feed-head" style="padding:6px 0">
        <div>${avatarHtml(c.name, c.avatar_media_id)}<a href="/company/${c.id}"><b>${esc(c.name)}</b></a></div>
        <form method="POST" action="/chats/private"><input type="hidden" name="company_id" value="${c.id}"><button class="btn btn-sm" type="submit">Chat</button></form>
      </div>`).join('')
      : '<p class="muted">No approved companies match that name.</p>';
  }

  // New group — checkbox list of approved companies
  const others = db.prepare(`SELECT id, name FROM companies WHERE status = 'approved' AND id != ? ORDER BY name LIMIT 100`).all(req.user.id);
  const checks = others.length
    ? others.map(c => `<label class="member-check"><input type="checkbox" name="members" value="${c.id}">${esc(c.name)}</label>`).join('')
    : '<p class="muted">No other approved companies on the network yet.</p>';

  const body = `
  <div class="card">
    <h2>💬 Chats</h2>
    ${convs.length ? rows : '<p class="muted">No conversations yet — start a private chat or open a group below.</p>'}
  </div>
  <div class="grid2">
    <div class="card">
      <h3>New private chat</h3>
      <form method="GET" action="/chats" style="display:flex;gap:8px;margin:10px 0">
        <input type="text" name="q" value="${esc(q)}" placeholder="Search a company by name…" style="margin-bottom:0">
        <button class="btn btn-sm" type="submit">Search</button>
      </form>
      ${resultsHtml}
    </div>
    <div class="card">
      <h3>New group</h3>
      <form method="POST" action="/chats/group" style="margin-top:10px">
        <label>Group name</label><input type="text" name="name" required maxlength="120" placeholder="e.g. Q3 supplier sync">
        <div style="max-height:220px;overflow:auto">${checks}</div>
        <button class="btn" type="submit" style="margin-top:10px">Create group</button>
      </form>
    </div>
  </div>`;
  res.send(page('Chats', body, req.user, req.query.msg, req.query.err, 'chats'));
});

app.post('/chats/private', requireCompany, (req, res) => {
  const otherId = parseInt(req.body.company_id, 10);
  if (!otherId || otherId === req.user.id) {
    return res.redirect('/chats?err=' + encodeURIComponent('Pick another company to chat with.'));
  }
  const other = db.prepare(`SELECT id FROM companies WHERE id = ? AND status = 'approved'`).get(otherId);
  if (!other) return res.redirect('/chats?err=' + encodeURIComponent('Company not found.'));
  const existing = db.prepare(`
    SELECT c.id FROM conversations c
    WHERE c.type = 'private'
      AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id AND m.company_id = ?)
      AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id AND m.company_id = ?)`)
    .get(req.user.id, otherId);
  let convId;
  if (existing) {
    convId = existing.id;
  } else {
    convId = db.prepare(`INSERT INTO conversations (type, name, created_at) VALUES ('private', '', ?)`).run(now()).lastInsertRowid;
    const ins = db.prepare('INSERT INTO conversation_members (conversation_id, company_id) VALUES (?,?)');
    ins.run(convId, req.user.id);
    ins.run(convId, otherId);
  }
  res.redirect('/chat/' + convId);
});

app.post('/chats/group', requireCompany, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 120);
  if (!name) return res.redirect('/chats?err=' + encodeURIComponent('Group name is required.'));
  let members = req.body.members || [];
  if (!Array.isArray(members)) members = [members];
  const ids = [...new Set(members.map(m => parseInt(m, 10)).filter(n => Number.isInteger(n) && n > 0 && n !== req.user.id))];
  const valid = ids.filter(id => db.prepare(`SELECT 1 FROM companies WHERE id = ? AND status = 'approved'`).get(id));
  if (!valid.length) return res.redirect('/chats?err=' + encodeURIComponent('Select at least one company for the group.'));
  const convId = db.prepare(`INSERT INTO conversations (type, name, created_at) VALUES ('group', ?, ?)`).run(name, now()).lastInsertRowid;
  const ins = db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, company_id) VALUES (?,?)');
  ins.run(convId, req.user.id);
  for (const id of valid) ins.run(convId, id);
  res.redirect('/chat/' + convId + '?msg=' + encodeURIComponent('Group created.'));
});

app.get('/chat/:id', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.redirect('/login?err=' + encodeURIComponent('Please sign in.'));
  const convId = parseInt(req.params.id, 10);
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
  if (!conv) return res.status(404).send(page('Not found', '<div class="card"><h2>Conversation not found</h2></div>', user));
  const member = !user.isAdmin && isMember(convId, user.id);
  if (!user.isAdmin && !member) {
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Private conversation</h2><p class="muted">Only members of this conversation can view it.</p></div>', user));
  }
  // Viewing a conversation marks it read for the viewer (drives the unread badges).
  if (member) {
    db.prepare('UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND company_id = ?').run(now(), convId, user.id);
  }
  const names = companyNameMap();
  const dn = convDisplayName(conv, user.id, names);
  const other = conv.type === 'private'
    ? db.prepare('SELECT company_id FROM conversation_members WHERE conversation_id = ? AND company_id != ? LIMIT 1').get(conv.id, user.id || 0)
    : null;
  const convAvatar = avatarHtml(dn, other ? companyAvatarMediaId(other.company_id) : null);
  const msgs = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC LIMIT 500').all(convId);
  const bubbles = msgs.length ? msgs.map(m => {
    const mine = !user.isAdmin && m.sender_company_id === user.id;
    const sender = names.get(m.sender_company_id) || 'Unknown';
    return `<div class="bubble ${mine ? 'mine' : 'theirs'}">
      ${conv.type === 'group' && !mine ? `<div class="bubble-sender">${esc(sender)}</div>` : ''}
      ${esc(m.body)}
      <div class="bubble-meta">${esc(m.created_at.slice(0, 16).replace('T', ' '))}</div>
    </div>`;
  }).join('') : '<p class="muted">No messages yet — say hello.</p>';

  const sendForm = user.isAdmin
    ? '<p class="muted">Admin view — conversations are read-only for admins.</p>'
    : `<form method="POST" action="/chat/${conv.id}/send" class="chat-send">
         <input type="text" name="body" required maxlength="2000" placeholder="Write a message…" autocomplete="off">
         <button class="btn" type="submit">Send</button>
       </form>`;

  const body = `
  <div class="card">
    <div class="feed-head"><h2>${convAvatar}${esc(dn)}</h2>
      <a class="btn btn-sm btn-outline" href="/chats">← All chats</a></div>
    <p class="muted">${conv.type === 'group' ? 'Group conversation' : 'Private conversation'} · auto-refreshes every 8s</p>
    <hr class="sep">
    <div class="chat-box" id="chatbox">${bubbles}</div>
    ${sendForm}
  </div>
  <script>window.scrollTo(0, document.body.scrollHeight);</script>`;
  res.send(page(dn, body, user, req.query.msg, req.query.err, 'chats', '<meta http-equiv="refresh" content="8">'));
});

app.post('/chat/:id/send', requireCompany, (req, res) => {
  const convId = parseInt(req.params.id, 10);
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
  if (!conv || !isMember(convId, req.user.id)) {
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Private conversation</h2></div>', req.user));
  }
  const txt = String(req.body.body || '').trim();
  if (!txt) return res.redirect('/chat/' + convId + '?err=' + encodeURIComponent('Message cannot be empty.'));
  db.prepare('INSERT INTO messages (conversation_id, sender_company_id, body, created_at) VALUES (?,?,?,?)')
    .run(convId, req.user.id, txt.slice(0, 2000), now());
  res.redirect('/chat/' + convId);
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
    contractsPending: count(`SELECT COUNT(*) AS n FROM contracts WHERE status = 'pending_admin'`) +
                      count(`SELECT COUNT(*) AS n FROM private_contracts WHERE status = 'pending_admin'`),
    follows: count('SELECT COUNT(*) AS n FROM follows')
  };
  // Platform commission: 1% of the summed value of approved (finalized) deals, broken down per currency.
  const approvedDeals = db.prepare(`SELECT value, currency FROM deals WHERE contract_state = 'approved'`).all();
  const feeByCurrency = {};
  for (const d of approvedDeals) {
    const num = parseDealValue(d.value);
    if (!isFinite(num) || num <= 0) continue;
    const cur = d.currency || 'USD';
    feeByCurrency[cur] = (feeByCurrency[cur] || 0) + num * PLATFORM_FEE_PCT / 100;
  }
  const feeCurrencies = Object.keys(feeByCurrency).sort();
  const commissionText = feeCurrencies.length
    ? feeCurrencies.map(cur => `${esc(cur)} ${fmtAmount(feeByCurrency[cur])}`).join(' · ')
    : '—';
  const statsHtml = `<div class="stats">${[
    ['Total companies', stats.companies, ''], ['Pending', stats.pending, ''], ['Approved', stats.approved, ' mint'],
    ['Flagged ⚠️', stats.flagged, ''], ['Deals', stats.deals, ' gold'], ['Contracts pending', stats.contractsPending, ' gold'],
    ['Follows', stats.follows, '']
  ].map(([l, n, cls]) => `<div class="stat"><div class="num${cls}">${n}</div><div class="lbl">${l}</div></div>`).join('')}
    <div class="stat"><div class="num gold" style="font-size:1.15rem;line-height:1.4">${commissionText}</div><div class="lbl">Platform commission (approved deals) · ${PLATFORM_FEE_PCT}%</div></div></div>`;

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

  // Final approval queue — ONLY contracts the deal owner has already approved (state: pending_admin).
  const names = companyNameMap();
  const pendingContracts = db.prepare(`SELECT * FROM contracts WHERE status = 'pending_admin' ORDER BY signed_at ASC`).all();
  const dealContractRows = pendingContracts.map(ct => {
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
  });
  // Private contracts (company → company, off-feed) awaiting final approval — kept on file after approval.
  const pendingPrivate = db.prepare(`SELECT * FROM private_contracts WHERE status = 'pending_admin' ORDER BY signed_at ASC`).all();
  const privateContractRows = pendingPrivate.map(pc => `<tr>
      <td><b>${esc(pc.title)}</b> <span class="muted">#${pc.id}</span> <span class="badge badge-sealed">Private contract</span></td>
      <td>${esc(names.get(pc.sender_company_id) || '?')} ⇄ ${esc(names.get(pc.recipient_company_id) || '?')}</td>
      <td class="muted">${esc((pc.signed_at || pc.created_at).slice(0, 16).replace('T', ' '))}</td>
      <td style="white-space:nowrap">
        <a class="btn btn-sm btn-outline" href="/contracts/${pc.id}">View</a>
        <form method="POST" action="/admin/private-contracts/${pc.id}/approve" style="display:inline"><button class="btn btn-sm btn-green">Approve</button></form>
        <form method="POST" action="/admin/private-contracts/${pc.id}/reject" style="display:inline"><button class="btn btn-sm btn-danger">Reject</button></form>
      </td>
    </tr>`);
  const allContractRows = [...dealContractRows, ...privateContractRows];
  const contractsHtml = allContractRows.length ? allContractRows.join('') : '<tr><td colspan="4" class="muted">No contracts awaiting final approval. Contracts land here after the deal owner approves them.</td></tr>';

  // All companies (suspend / reactivate / delete / reputation / research)
  const allCompanies = db.prepare('SELECT * FROM companies ORDER BY created_at DESC LIMIT 100').all();
  const companiesHtml = allCompanies.map(c => {
    const actions = [];
    if (c.status === 'approved') actions.push(`<form method="POST" action="/admin/companies/${c.id}/suspend" style="display:inline"><button class="btn btn-sm btn-outline">Suspend</button></form>`);
    if (c.status === 'suspended' || c.status === 'rejected') actions.push(`<form method="POST" action="/admin/companies/${c.id}/reactivate" style="display:inline"><button class="btn btn-sm btn-green">Reactivate</button></form>`);
    actions.push(`<form method="POST" action="/admin/companies/${c.id}/delete" style="display:inline" onsubmit="return confirm('Delete ${esc(c.name)} and ALL their data?')"><button class="btn btn-sm btn-danger">Delete</button></form>`);
    const repOptions = [0, 1, 2, 3, 4, 5].map(r =>
      `<option value="${r}"${r === (c.reputation || 0) ? ' selected' : ''}>${r === 0 ? 'Unrated' : '★'.repeat(r)}</option>`).join('');
    return `<tr>
      <td><b>${esc(c.name)}</b> ${c.flagged ? '<span class="warn-badge"><i class="warn-ic">⚠️</i></span>' : ''}<br><span class="muted">${esc(c.email)}</span></td>
      <td>${statusBadge(c.status)}</td>
      <td style="white-space:nowrap">
        ${starsHtml(c.reputation, true)}<br>
        <form class="rep-form" method="POST" action="/admin/companies/${c.id}/reputation" style="margin-top:4px">
          <select name="reputation" aria-label="Reputation for ${esc(c.name)}">${repOptions}</select>
          <button class="btn btn-sm btn-outline" type="submit">Set</button>
        </form>
      </td>
      <td style="white-space:nowrap">
        <form method="POST" action="/admin/companies/${c.id}/research" style="display:inline"><button class="btn btn-sm btn-outline" type="submit">🔬 Run research</button></form><br>
        <div style="margin-top:4px">${actions.join(' ')}</div>
      </td>
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
  <div class="card"><h3>Pending contracts — final approval</h3>
    <table><tr><th>Deal</th><th>Parties</th><th>Signed at</th><th>Actions</th></tr>${contractsHtml}</table></div>
  <div class="card"><h3>All companies</h3>
    <table><tr><th>Company</th><th>Status</th><th>Reputation</th><th>Actions</th></tr>${companiesHtml}</table></div>
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
      db.prepare('DELETE FROM counter_offers WHERE deal_id = ?').run(d);
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
    db.prepare('DELETE FROM private_contracts WHERE sender_company_id = ? OR recipient_company_id = ?').run(id, id);
    db.prepare('DELETE FROM counter_offers WHERE from_company_id = ?').run(id);
    db.prepare('DELETE FROM notifications WHERE company_id = ?').run(id);
    db.prepare('DELETE FROM sessions WHERE company_id = ?').run(id);
    db.prepare('DELETE FROM verification_codes WHERE company_id = ?').run(id);
    db.prepare('DELETE FROM media WHERE company_id = ?').run(id);
    // Remove the company from all conversations (their messages keep attribution as "Unknown").
    db.prepare('DELETE FROM conversation_members WHERE company_id = ?').run(id);
    db.prepare('DELETE FROM companies WHERE id = ?').run(id);
  });
  wipe();
  audit('ONBOARDING AGENT', 'admin delete company', 'fail', `Admin deleted "${c.name}" and all associated data`);
  res.redirect('/admin/dashboard?msg=' + encodeURIComponent(`Deleted ${c.name} and all their data.`));
});

// ----- Admin reputation scale (0 = unrated, 1–5 stars) -----
app.post('/admin/companies/:id/reputation', requireAdmin, (req, res) => {
  const c = db.prepare('SELECT * FROM companies WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!c) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Company not found.'));
  const rep = parseInt(req.body.reputation, 10);
  if (!Number.isInteger(rep) || rep < 0 || rep > 5) {
    return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Reputation must be a whole number from 0 to 5.'));
  }
  db.prepare('UPDATE companies SET reputation = ? WHERE id = ?').run(rep, c.id);
  audit('ADMIN', 'reputation set', 'pass', `Admin set reputation of "${c.name}" to ${rep === 0 ? 'Unrated (0)' : rep + '/5'}`);
  res.redirect('/admin/dashboard?msg=' + encodeURIComponent(`Reputation for ${c.name} set to ${rep === 0 ? 'Unrated' : rep + '★'}.`));
});

// ----- RESEARCH AGENT: Wikipedia lookup + admin-confirmed intelligence fields -----
app.get('/admin/companies/:id/research', requireAdmin, (req, res) => {
  const c = db.prepare('SELECT * FROM companies WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!c) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Company not found.'));
  const body = `
  <div class="card" style="max-width:560px;margin:0 auto">
    <div class="kicker">🔬 Research Agent</div>
    <h2 style="margin:6px 0 10px">Company intelligence — ${esc(c.name)}</h2>
    <p class="muted" style="margin-bottom:12px">Review and edit the researched fields, then save. They appear on the public company profile.</p>
    ${c.research_source ? `<p class="muted" style="margin-bottom:12px">Source: <a href="${esc(c.research_source)}" rel="noopener noreferrer nofollow">${esc(c.research_source)}</a></p>` : ''}
    <form method="POST" action="/admin/companies/${c.id}/research">
      <label>Market value</label><input type="text" name="market_value" maxlength="120" value="${esc(c.market_value || '')}" placeholder="e.g. $2.8T (2024)">
      <label>Field / industry</label><input type="text" name="field" maxlength="200" value="${esc(c.field || '')}" placeholder="e.g. Consumer electronics and software">
      <label>Employees</label><input type="text" name="employees" maxlength="80" value="${esc(c.employees || '')}" placeholder="e.g. ~160,000">
      <button class="btn" type="submit">Save intelligence</button>
      <a class="btn btn-outline" href="/admin/dashboard" style="margin-left:8px">Back</a>
    </form>
  </div>`;
  res.send(page('Research — ' + c.name, body, req.user, req.query.msg, req.query.err));
});

app.post('/admin/companies/:id/research', requireAdmin, async (req, res) => {
  const c = db.prepare('SELECT * FROM companies WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!c) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Company not found.'));

  // Save branch: the edit form posts the three intel fields.
  if ('market_value' in req.body || 'field' in req.body || 'employees' in req.body) {
    db.prepare('UPDATE companies SET market_value = ?, field = ?, employees = ? WHERE id = ?')
      .run(String(req.body.market_value || '').trim().slice(0, 120),
           String(req.body.field || '').trim().slice(0, 200),
           String(req.body.employees || '').trim().slice(0, 80), c.id);
    audit('RESEARCH AGENT', 'intelligence saved', 'pass', `Admin confirmed research fields for "${c.name}"`);
    return res.redirect('/admin/dashboard?msg=' + encodeURIComponent(`Intelligence saved for ${c.name}.`));
  }

  // Research branch: "Run research" button — query the public Wikipedia summary API (no key, 5s timeout).
  let suggestion = null, sourceUrl = '', failReason = '';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(c.name), {
      signal: ctrl.signal, headers: { 'User-Agent': 'Dealzoin Research Agent' }
    });
    clearTimeout(timer);
    if (r.ok) {
      const data = await r.json();
      if (data && data.extract) {
        const firstSentence = String(data.extract).split(/(?<=[.!?])\s+/)[0].trim().slice(0, 200);
        suggestion = firstSentence;
        sourceUrl = (data.content_urls && data.content_urls.desktop && data.content_urls.desktop.page) || '';
      } else {
        failReason = 'no summary extract returned';
      }
    } else {
      failReason = `Wikipedia API HTTP ${r.status}`;
    }
  } catch (e) {
    failReason = e.name === 'AbortError' ? 'Wikipedia API timed out (5s)' : `fetch error: ${e.message}`;
  }

  if (suggestion) {
    // Never overwrite non-empty fields — only fill in blanks.
    if (!c.field) db.prepare('UPDATE companies SET field = ? WHERE id = ?').run(suggestion, c.id);
    if (sourceUrl) db.prepare('UPDATE companies SET research_source = ? WHERE id = ?').run(sourceUrl, c.id);
    audit('RESEARCH AGENT', 'research run', 'pass', `Research for "${c.name}" — Wikipedia summary found${c.field ? ' (field kept: already set)' : `, suggested field: "${suggestion}"`}${sourceUrl ? ', source: ' + sourceUrl : ''}`);
  } else {
    audit('RESEARCH AGENT', 'research run', 'fail', `Research for "${c.name}" — no public summary found (${failReason || 'not found'})`);
  }
  // Redirect to the edit form so the admin can confirm/edit before saving.
  res.redirect(`/admin/companies/${c.id}/research?` + (suggestion
    ? 'msg=' + encodeURIComponent('Research found a public summary — review and save.')
    : 'err=' + encodeURIComponent('No public data found for "' + c.name + '" (' + (failReason || 'not found') + '). You can still fill the fields manually.')));
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
    db.prepare('DELETE FROM counter_offers WHERE deal_id = ?').run(d.id);
    db.prepare('DELETE FROM deals WHERE id = ?').run(d.id);
  });
  wipe();
  audit('ONBOARDING AGENT', 'admin remove deal', 'flag', `Admin removed deal #${d.id} "${d.title}"`);
  res.redirect('/admin/dashboard?msg=' + encodeURIComponent('Deal removed.'));
});

// ----- Contract final approval queue (stage 2: only owner-approved contracts) -----
app.post('/admin/contracts/:id/approve', requireAdmin, (req, res) => {
  const ct = db.prepare('SELECT * FROM contracts WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!ct) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Contract not found.'));
  if (ct.status !== 'pending_admin') {
    return res.redirect('/admin/dashboard?err=' + encodeURIComponent('This contract is not awaiting final approval (owner must approve first).'));
  }
  // 1) Mark the deal as approved and record the signing party on the deal itself.
  const signer = db.prepare('SELECT name FROM companies WHERE id = ?').get(ct.signer_company_id);
  const party = signer ? signer.name : 'Unknown';
  const dealRow = db.prepare('SELECT title FROM deals WHERE id = ?').get(ct.deal_id);
  const dealTitle = dealRow ? dealRow.title : 'deal #' + ct.deal_id;
  db.prepare(`UPDATE deals SET contract_state = 'approved', contract_party = ? WHERE id = ?`).run(party, ct.deal_id);
  // 2) Approved contracts are archived: the row is deleted; the deal carries the state.
  db.prepare('DELETE FROM contracts WHERE id = ?').run(ct.id);
  // TODO PHASE 3 — PAYMENT-ESCROW AGENT: when admin approves a contract, hook Stripe escrow initiation here (create escrow, notify both parties, release funds on delivery confirmation). Not implemented in this version.
  audit('CONTRACT AGENT', 'admin approve contract', 'pass', `Contract #${ct.id} (deal #${ct.deal_id}) approved by admin — deal marked approved (party: ${party}); contract record archived (deleted)`);
  // Both parties are notified when the deal is finalized.
  notify(ct.signer_company_id, 'contract_approved', `Final approval granted — your contract on "${dealTitle}" is finalized. Deal closed! 🎉`, `/deal/${ct.deal_id}`);
  notify(ct.owner_company_id, 'contract_approved', `Final approval granted — the contract with ${party} on "${dealTitle}" is finalized. Deal closed! 🎉`, `/deal/${ct.deal_id}`);
  res.redirect('/admin/dashboard?msg=' + encodeURIComponent('Contract approved and archived. The deal now shows its finalized state.'));
});
app.post('/admin/contracts/:id/reject', requireAdmin, (req, res) => {
  const ct = db.prepare('SELECT * FROM contracts WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!ct) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Contract not found.'));
  if (ct.status !== 'pending_admin') {
    return res.redirect('/admin/dashboard?err=' + encodeURIComponent('This contract is not awaiting final approval.'));
  }
  const dealRow = db.prepare('SELECT title FROM deals WHERE id = ?').get(ct.deal_id);
  db.prepare(`UPDATE contracts SET status = 'rejected', decided_at = ? WHERE id = ?`).run(now(), ct.id);
  audit('AUTHENTICATION AGENT', 'admin reject contract', 'fail', `Contract #${ct.id} (deal #${ct.deal_id}) rejected by admin at final approval`);
  notify(ct.signer_company_id, 'contract_rejected', `An admin rejected your signed contract on "${dealRow ? dealRow.title : 'deal #' + ct.deal_id}" at final approval.`, `/deal/${ct.deal_id}`);
  res.redirect('/admin/dashboard?msg=' + encodeURIComponent('Contract rejected.'));
});

// ----- Private contracts final approval (rows are KEPT after approval — shown as "Finalized ✓") -----
app.post('/admin/private-contracts/:id/approve', requireAdmin, (req, res) => {
  const pc = getPrivateContract(req.params.id);
  if (!pc) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Contract not found.'));
  if (pc.status !== 'pending_admin') {
    return res.redirect('/admin/dashboard?err=' + encodeURIComponent('This private contract is not awaiting final approval.'));
  }
  const names = companyNameMap();
  db.prepare(`UPDATE private_contracts SET status = 'approved', decided_at = ? WHERE id = ?`).run(now(), pc.id);
  audit('CONTRACT AGENT', 'admin approve private contract', 'pass', `Private contract #${pc.id} "${pc.title}" (${names.get(pc.sender_company_id) || '?'} ⇄ ${names.get(pc.recipient_company_id) || '?'}) approved by admin — kept on file in both mailboxes`);
  notify(pc.sender_company_id, 'private_contract_approved', `Final approval granted — your private contract "${pc.title}" is finalized. 🎉`, `/contracts/${pc.id}`);
  notify(pc.recipient_company_id, 'private_contract_approved', `Final approval granted — the private contract "${pc.title}" is finalized. 🎉`, `/contracts/${pc.id}`);
  res.redirect('/admin/dashboard?msg=' + encodeURIComponent('Private contract approved and kept on file.'));
});
app.post('/admin/private-contracts/:id/reject', requireAdmin, (req, res) => {
  const pc = getPrivateContract(req.params.id);
  if (!pc) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Contract not found.'));
  if (pc.status !== 'pending_admin') {
    return res.redirect('/admin/dashboard?err=' + encodeURIComponent('This private contract is not awaiting final approval.'));
  }
  db.prepare(`UPDATE private_contracts SET status = 'rejected', decided_at = ? WHERE id = ?`).run(now(), pc.id);
  audit('CONTRACT AGENT', 'admin reject private contract', 'fail', `Private contract #${pc.id} "${pc.title}" rejected by admin at final approval`);
  notify(pc.sender_company_id, 'private_contract_rejected', `An admin rejected your private contract "${pc.title}" at final approval.`, `/contracts/${pc.id}`);
  notify(pc.recipient_company_id, 'private_contract_rejected', `An admin rejected the private contract "${pc.title}" at final approval.`, `/contracts/${pc.id}`);
  res.redirect('/admin/dashboard?msg=' + encodeURIComponent('Private contract rejected.'));
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
