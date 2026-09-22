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
// v5 upgrades (Trust & KYC): compliance-grade registration fields on companies.
try { db.exec("ALTER TABLE companies ADD COLUMN category TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE companies ADD COLUMN activity TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE companies ADD COLUMN trade_license TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE companies ADD COLUMN signature_name TEXT'); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE companies ADD COLUMN signature_at TEXT'); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE companies ADD COLUMN signature_ip TEXT'); } catch (e) { /* column already exists */ }
// v6 upgrades (Deals 2.0): structured deal fields, status pipeline, shipment tracking, product proof.
try { db.exec("ALTER TABLE deals ADD COLUMN deal_type TEXT DEFAULT 'sell'"); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE deals ADD COLUMN deal_number TEXT'); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE deals ADD COLUMN category TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE deals ADD COLUMN origin TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE deals ADD COLUMN incoterm TEXT DEFAULT 'CIF'"); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE deals ADD COLUMN product_proof TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE deals ADD COLUMN product_proof_doc_id INTEGER'); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE deals ADD COLUMN status TEXT DEFAULT 'open'"); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE deals ADD COLUMN status_note TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE deals ADD COLUMN tracking_number TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE deals ADD COLUMN tracking_url TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE deals ADD COLUMN contract_party_id INTEGER'); } catch (e) { /* column already exists */ }
// Unique deal numbers (DZ-<year>-<seq>); old rows stay NULL until backfilled below.
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_deals_deal_number ON deals(deal_number)'); } catch (e) { /* index may already exist */ }

// KYC document vault — registration & compliance PDFs, private to owner company + admin.
db.exec(`
CREATE TABLE IF NOT EXISTS documents (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id          INTEGER NOT NULL,
  doc_type            TEXT NOT NULL,                 -- profile_pdf | moa_authority | bank_statement | signed_terms | activity_proof
  mime                TEXT NOT NULL,
  filename            TEXT DEFAULT '',
  data                BLOB NOT NULL,
  sha256              TEXT DEFAULT '',
  authenticity_status TEXT DEFAULT 'pass',           -- pass | flag
  authenticity_notes  TEXT DEFAULT '',
  created_at          TEXT NOT NULL
);
`);

// Deals 2.0 — per-deal document exchange: buyer document requests (kind='request', data NULL)
// and owner-uploaded response documents (kind='document', PDF or image).
db.exec(`
CREATE TABLE IF NOT EXISTS deal_documents (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id    INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'document',       -- 'request' | 'document'
  note       TEXT DEFAULT '',
  mime       TEXT DEFAULT '',
  filename   TEXT DEFAULT '',
  data       BLOB,
  sha256     TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
`);

// ============================= STAGE C SCHEMA (trade pipeline & platform) =============================
// Negotiation pipeline: LOI -> offer/counter rounds -> buyer approval -> PO -> signing ->
// owner approval -> commission-split negotiation -> admin final approval -> DONE / REJECTED.
db.exec(`
CREATE TABLE IF NOT EXISTS negotiations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id           INTEGER NOT NULL,
  buyer_id          INTEGER NOT NULL,
  seller_id         INTEGER NOT NULL,
  state             TEXT NOT NULL DEFAULT 'LOI_SENT',
  round             INTEGER NOT NULL DEFAULT 0,
  loi_text          TEXT DEFAULT '',
  loi_location      TEXT DEFAULT '',
  loi_quantity      TEXT DEFAULT '',
  loi_wishes        TEXT DEFAULT '',
  offer_value       TEXT DEFAULT '',
  offer_currency    TEXT DEFAULT 'USD',
  offer_terms       TEXT DEFAULT '',
  commission_split  TEXT DEFAULT '50-50',
  split_proposed_by INTEGER,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS negotiation_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  negotiation_id INTEGER NOT NULL,
  actor_id       INTEGER,
  kind           TEXT NOT NULL,                    -- loi | offer | counter | approve | decline | po | signing | signed | owner_approved | split | split_accept | admin_approved | admin_rejected
  value          TEXT DEFAULT '',
  currency       TEXT DEFAULT '',
  terms          TEXT DEFAULT '',
  note           TEXT DEFAULT '',
  created_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS company_members (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER NOT NULL,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member',    -- member | manager
  status        TEXT NOT NULL DEFAULT 'active',    -- active | deactivated
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_company_id INTEGER NOT NULL,
  title              TEXT NOT NULL,
  type               TEXT NOT NULL DEFAULT 'meeting', -- meeting | signing
  event_date         TEXT NOT NULL,                -- YYYY-MM-DD
  event_time         TEXT DEFAULT '',              -- HH:MM
  notes              TEXT DEFAULT '',
  room               TEXT DEFAULT '',              -- Jitsi room slug
  deal_id            INTEGER,
  created_at         TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS event_participants (
  event_id   INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  UNIQUE(event_id, company_id)
);
`);
// Stage C graceful column upgrades (old databases keep booting).
try { db.exec('ALTER TABLE sessions ADD COLUMN member_id INTEGER'); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE posts ADD COLUMN author_name TEXT'); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE deals ADD COLUMN author_name TEXT'); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE messages ADD COLUMN author_name TEXT'); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE posts ADD COLUMN is_system INTEGER DEFAULT 0'); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE contracts ADD COLUMN negotiation_id INTEGER'); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE negotiations ADD COLUMN split_proposed_by INTEGER'); } catch (e) { /* column already exists */ }

/** Next unique deal number for the current year: DZ-<year>-<zero-padded seq> (counter in settings). */
function nextDealNumber(year) {
  const yr = year || new Date().getFullYear();
  const key = 'deal_seq_' + yr;
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    const seq = (row ? parseInt(row.value, 10) || 0 : 0) + 1;
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(seq));
    return seq;
  });
  return `DZ-${yr}-${String(tx()).padStart(4, '0')}`;
}

// Backfill deal numbers for rows created before Deals 2.0 (oldest first, per their creation year).
(function backfillDealNumbers() {
  try {
    const missing = db.prepare(`SELECT id, created_at FROM deals WHERE deal_number IS NULL OR deal_number = '' ORDER BY created_at ASC, id ASC`).all();
    for (const d of missing) {
      const yr = parseInt(String(d.created_at || '').slice(0, 4), 10) || new Date().getFullYear();
      db.prepare('UPDATE deals SET deal_number = ? WHERE id = ?').run(nextDealNumber(yr), d.id);
    }
  } catch (e) { console.error('[Dealzoin] deal-number backfill failed:', e.message); }
})();

// ============================= PLATFORM COMMISSION =============================
const PLATFORM_FEE_PCT = 1; // default 1% Dealzoin commission — the admin can adjust it (settings key platform_fee_pct)
/** Current platform commission percentage (admin-adjustable, 0.1–20; default 1). */
function platformFeePct() {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('platform_fee_pct');
    const n = parseFloat(row && row.value);
    if (isFinite(n) && n >= 0.1 && n <= 20) return Math.round(n * 100) / 100;
  } catch (e) { /* fall through to default */ }
  return PLATFORM_FEE_PCT;
}
/** Parse a numeric amount out of a free-text deal value ("50,000 / year" -> 50000). NaN if none. */
function parseDealValue(value) {
  const m = String(value || '').replace(/[,\s]/g, '').match(/\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
}
function fmtAmount(n) {
  const r = Math.round(n * 100) / 100;
  return (r % 1 === 0 ? r.toString() : r.toFixed(2)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
/** "Platform fee: X% (…) — transparent Dealzoin commission" line for deal surfaces (private contexts only). */
function feeLineHtml(deal, style) {
  const pct = platformFeePct();
  const cur = deal.currency || 'USD';
  const num = parseDealValue(deal.value);
  const amount = isFinite(num) && num > 0
    ? `${fmtAmount(num * pct / 100)} ${esc(cur)}`
    : `${pct}% of deal value`;
  const inner = isFinite(num) && num > 0
    ? `Platform fee: ${pct}% (${amount}) — transparent Dealzoin commission`
    : `Platform fee: ${pct}% of deal value — transparent Dealzoin commission`;
  return `<div class="muted" style="font-size:12px;${style || ''}">🏦 ${inner}</div>`;
}
/** Plain-text fee line for the downloadable contract document. */
function feeLineText(deal) {
  const pct = platformFeePct();
  const cur = deal.currency || 'USD';
  const num = parseDealValue(deal.value);
  return isFinite(num) && num > 0
    ? `Platform fee: ${pct}% (${fmtAmount(num * pct / 100)} ${cur}) — transparent Dealzoin commission`
    : `Platform fee: ${pct}% of deal value — transparent Dealzoin commission`;
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

// ----- Deal form uploads: "media" (image/video) + "product_proof" (PDF) in one multipart form -----
const dealFieldsUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: VIDEO_MAX_BYTES, files: 2 },
  fileFilter: (req, file, cb) => {
    const ext = String(file.originalname || '').split('.').pop().toLowerCase();
    const mime = String(file.mimetype || '').toLowerCase();
    if (file.fieldname === 'product_proof') {
      if (ext === 'pdf' || mime === 'application/pdf') return cb(null, true);
      return cb(new Error('Product proof must be a PDF document.'));
    }
    const okImage = MEDIA_IMAGE_EXT[ext] && mime.startsWith('image/');
    const okVideo = MEDIA_VIDEO_EXT[ext] && mime.startsWith('video/');
    if (okImage || okVideo) return cb(null, true);
    cb(new Error(MEDIA_RULES_MSG));
  }
});

/** True when the buffer looks like a real image (png/jpg/gif/webp magic bytes). */
function isImageBuffer(buf) {
  if (!buf || buf.length < 12) return false;
  return (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47)       // png
      || (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF)                        // jpg
      || buf.toString('latin1', 0, 4) === 'GIF8'                                        // gif
      || (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP'); // webp
}

/** Multer middleware for the deal form: media (image/video) + product_proof (PDF), magic-byte checked. */
function dealUpload(req, res, next) {
  dealFieldsUpload.fields([{ name: 'media', maxCount: 1 }, { name: 'product_proof', maxCount: 1 }])(req, res, (err) => {
    const back = (req.get('referer') || '/deals/new').split('?')[0];
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File too large — images max 5 MB, videos max 25 MB, PDFs max 25 MB.' : (err.message || MEDIA_RULES_MSG);
      return res.redirect(back + '?err=' + encodeURIComponent(msg));
    }
    const files = req.files || {};
    const media = files.media && files.media[0];
    if (media) {
      const ext = String(media.originalname || '').split('.').pop().toLowerCase();
      if (!MEDIA_VIDEO_EXT[ext] && media.size > IMAGE_MAX_BYTES) {
        return res.redirect(back + '?err=' + encodeURIComponent('Images are limited to 5 MB.'));
      }
      const b = media.buffer;
      const realImage = isImageBuffer(b);
      const realVideo = b.length > 11 && (b.toString('latin1', 4, 8) === 'ftyp' || (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3));
      if (!realImage && !realVideo) {
        return res.redirect(back + '?err=' + encodeURIComponent('Upload rejected: file content does not look like a real image or video.'));
      }
      if (realImage && !MEDIA_IMAGE_EXT[ext]) return res.redirect(back + '?err=' + encodeURIComponent(MEDIA_RULES_MSG));
      if (realVideo && !MEDIA_VIDEO_EXT[ext]) return res.redirect(back + '?err=' + encodeURIComponent(MEDIA_RULES_MSG));
    }
    const proof = files.product_proof && files.product_proof[0];
    if (proof) {
      if (proof.size > DOC_MAX_BYTES) return res.redirect(back + '?err=' + encodeURIComponent('Product proof PDFs are limited to 15 MB.'));
      if (!isPdfBuffer(proof.buffer)) return res.redirect(back + '?err=' + encodeURIComponent('Product proof must be a real PDF file.'));
    }
    next();
  });
}

/** Multer middleware for deal response documents (PDF or image, magic-byte checked in the route). */
function dealDocUploadMw(req, res, next) {
  const dealDocUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: DOC_MAX_BYTES, files: 1 },
    fileFilter: (req, file, cb) => {
      const ext = String(file.originalname || '').split('.').pop().toLowerCase();
      const mime = String(file.mimetype || '').toLowerCase();
      if (ext === 'pdf' || mime === 'application/pdf' || (MEDIA_IMAGE_EXT[ext] && mime.startsWith('image/'))) return cb(null, true);
      cb(new Error('Only PDF documents or images (JPG, PNG, GIF, WEBP) are allowed.'));
    }
  });
  dealDocUpload.single('doc')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Document too large — max 15 MB.' : (err.message || 'Invalid document file.');
      return res.redirect((req.get('referer') || '/timeline').split('?')[0] + '?err=' + encodeURIComponent(msg));
    }
    next();
  });
}

// ============================= KYC DOCUMENTS (PDF-ONLY UPLOADS) =============================
// pdf-parse is a hard dependency; loaded defensively so a broken install degrades to
// "flag" authenticity results instead of crashing the process.
let pdfParse = null;
try { pdfParse = require('pdf-parse'); } catch (e) { console.error('[Dealzoin] pdf-parse unavailable:', e.message); }

const DOC_MAX_BYTES = 15 * 1024 * 1024; // 15 MB
const DOC_MIN_BYTES = 1024;             // 1 KB
const DOC_TYPES = ['profile_pdf', 'moa_authority', 'bank_statement', 'signed_terms', 'activity_proof'];
const DOC_TYPE_LABELS = {
  profile_pdf: 'Company profile PDF',
  moa_authority: 'MOA & authority document',
  bank_statement: 'Bank account statement / proof of funds',
  signed_terms: 'Signed Terms & Conditions',
  activity_proof: 'Activity proof',
  product_proof: 'Product proof'
};
const PDF_RULES_MSG = 'Only real PDF documents (max 15 MB) are allowed.';

/** True when the buffer starts with the %PDF magic bytes. */
function isPdfBuffer(buf) {
  return !!buf && buf.length > 4 && buf.toString('latin1', 0, 5) === '%PDF-';
}

const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: DOC_MAX_BYTES, files: 5 },
  fileFilter: (req, file, cb) => {
    const ext = String(file.originalname || '').split('.').pop().toLowerCase();
    if (ext === 'pdf' || String(file.mimetype || '').toLowerCase() === 'application/pdf') return cb(null, true);
    cb(new Error(PDF_RULES_MSG));
  }
});

/** Multer middleware for the registration document fields, with friendly error redirects. */
function signupDocsUpload(req, res, next) {
  pdfUpload.fields([
    { name: 'profile_pdf', maxCount: 1 },
    { name: 'moa_authority', maxCount: 1 },
    { name: 'bank_statement', maxCount: 1 },
    { name: 'signed_terms', maxCount: 1 },
    { name: 'activity_proof', maxCount: 1 }
  ])(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'A document is too large — PDFs are limited to 15 MB each.' : (err.message || PDF_RULES_MSG);
      return res.redirect('/signup?err=' + encodeURIComponent(msg));
    }
    next();
  });
}

/** Extract text + page count from a PDF buffer. Never throws — corrupt PDFs yield null. */
async function extractPdfText(buffer) {
  if (!pdfParse || !isPdfBuffer(buffer)) return null;
  try {
    // pdf.js (bundled with pdf-parse) misreads Node Buffers whose underlying
    // ArrayBuffer is pool-shared (byteOffset != 0). Pass a clean zero-offset copy.
    const data = await pdfParse(new Uint8Array(buffer));
    return { text: String((data && data.text) || ''), pages: (data && data.numpages) || 0 };
  } catch (e) {
    return null;
  }
}

/**
 * DOCUMENT AUTHENTICITY AGENT — runs on every uploaded KYC document.
 * Returns { status: 'pass'|'flag', notes: [string], text: string }.
 */
async function runDocumentAgent(company, docType, file) {
  const notes = [];
  let text = '';

  // (g) size window: 1 KB – 15 MB
  const size = file.buffer ? file.buffer.length : 0;
  if (size < DOC_MIN_BYTES) notes.push(`suspiciously small file (${size} bytes)`);
  if (size > DOC_MAX_BYTES) notes.push(`file too large (${size} bytes)`);

  // (a) %PDF magic bytes
  if (!isPdfBuffer(file.buffer)) {
    notes.push('missing %PDF magic bytes — not a real PDF');
  } else {
    // (b) pdf-parse succeeds & page count >= 1 ; (c) extracted text >= 50 chars
    const parsed = await extractPdfText(file.buffer);
    if (!parsed) {
      notes.push('PDF could not be parsed (corrupt or malformed)');
    } else {
      text = parsed.text;
      if (parsed.pages < 1) notes.push('PDF reports 0 pages');
      if (text.trim().length < 50) notes.push('no extractable text (scanned-empty document?)');

      // (d) company name appears in text (fuzzy: all significant words, case-insensitive)
      if (['moa_authority', 'bank_statement', 'signed_terms'].includes(docType)) {
        const words = String(company.name || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
        const hay = text.toLowerCase();
        if (words.length && !words.every(w => hay.includes(w))) {
          notes.push(`company name "${company.name}" not found in document text`);
        }
      }
      // (e) trade license number appears in moa_authority / profile_pdf
      if (['moa_authority', 'profile_pdf'].includes(docType) && company.trade_license) {
        if (!text.toLowerCase().includes(String(company.trade_license).toLowerCase())) {
          notes.push(`trade license "${company.trade_license}" not found in document text`);
        }
      }
    }
  }

  // (f) duplicate sha256 across companies
  const sha256 = crypto.createHash('sha256').update(file.buffer || Buffer.alloc(0)).digest('hex');
  const dup = db.prepare('SELECT company_id FROM documents WHERE sha256 = ? AND company_id != ? LIMIT 1').get(sha256, company.id);
  if (dup) notes.push('duplicate document — identical file already uploaded by another company');

  const status = notes.length ? 'flag' : 'pass';
  audit('DOCUMENT AGENT', `document check (${docType})`, status,
    `"${file.originalname || 'file'}" for "${company.name}": ${notes.length ? notes.join('; ') : 'all checks passed'}`);
  return { status, notes, text, sha256 };
}

/** Persist a KYC document row (after the authenticity agent has run). */
function saveDocument(companyId, docType, file, agent) {
  const info = db.prepare(`INSERT INTO documents (company_id, doc_type, mime, filename, data, sha256, authenticity_status, authenticity_notes, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(companyId, docType, 'application/pdf', String(file.originalname || '').slice(0, 200),
         file.buffer, agent.sha256, agent.status, agent.notes.join('; '), now());
  return info.lastInsertRowid;
}

/** Authenticity badge: mint ✓ verified / ⚠️ flagged + notes. */
function authenticityBadge(status, notes) {
  if (status === 'flag') {
    return `<span class="warn-badge" title="${esc(notes || '')}"><i class="warn-ic">⚠️</i> flagged</span>${notes ? `<br><span class="flag-note">${esc(notes)}</span>` : ''}`;
  }
  return '<span class="badge badge-pass">✓ verified</span>';
}

/**
 * Heuristic guesses from a company-profile PDF text (step-1 auto-fill).
 * Never throws — always returns a (possibly empty) guess object.
 */
function guessesFromProfileText(text) {
  const g = { name: '', website: '', email: '', activity: '', employees: '' };
  try {
    const t = String(text || '');
    const lines = t.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    // Company name: first prominent line (short-ish, mostly letters, not a URL/email/boilerplate).
    for (const line of lines.slice(0, 15)) {
      if (line.length < 3 || line.length > 80) continue;
      if (/https?:|www\.|@|\d{3,}|page\s+\d|confidential/i.test(line)) continue;
      if (!/[a-zA-Z]/.test(line)) continue;
      g.name = line;
      break;
    }
    const wm = t.match(/https?:\/\/[^\s<>"')\]]+/i);
    if (wm) g.website = wm[0].replace(/[.,;:]+$/, '');
    const em = t.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    if (em) g.email = em[0].toLowerCase();
    for (const line of lines) {
      if (/industry|field|sector|specializ/i.test(line) && line.length >= 8 && line.length <= 300) { g.activity = line; break; }
    }
    const empl = t.match(/([~≈]?[\d][\d,. ]{0,12})\s*(?:\+\s*)?employees/i) || t.match(/employees[:\s]+([~≈]?[\d][\d,.]{0,12})/i);
    if (empl) g.employees = ('~' + empl[1].trim().replace(/\s+/g, '').replace(/^~+/, '')).replace(/^~(?=~)/, '');
  } catch (e) { /* guesses are best-effort */ }
  return g;
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

// ============================= SYSTEM ANNOUNCEMENT POSTS =============================
/**
 * Congratulations auto-post: inserted when a deal negotiation (or private contract) is finalized.
 * company_id = 0 (system sender — no FK on posts.company_id), is_system = 1 so every timeline
 * shows it regardless of follow filters. Deal values are NEVER included — only the title,
 * deal number and the two company names.
 */
function postCongrats(dealTitle, dealNumber, companyAName, companyBName) {
  const title = `🎉 Deal closed: ${dealTitle}${dealNumber ? ` №${dealNumber}` : ''}`;
  const body = `${title}\n\nDear ${companyAName} and ${companyBName},\n\n` +
    `Congratulations on closing this deal on Dealzoin! Your contract has passed final approval and the deal is now officially closed.\n\n` +
    `We wish both companies a smooth execution — may this be the first of many ledger entries together.\n\n` +
    `— The Dealzoin team 🪙`;
  try {
    db.prepare('INSERT INTO posts (company_id, body, created_at, is_system) VALUES (0, ?, ?, 1)').run(body.slice(0, 2000), now());
    audit('ANNOUNCEMENT AGENT', 'congratulations post', 'pass', `System post published: "${dealTitle}"${dealNumber ? ' №' + dealNumber : ''} (${companyAName} ⇄ ${companyBName})`);
  } catch (e) {
    audit('ANNOUNCEMENT AGENT', 'congratulations post', 'fail', `Could not publish system post for "${dealTitle}": ${e.message}`);
  }
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
 * opts: { website: string, tradeLicense: string } (Trust & KYC upgrade).
 * Returns { hardReject: bool, error: string, flags: [string] }.
 */
function runOnboardingAgent(name, email, opts) {
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

  // (e) Trust & KYC: trade license must be present and plausible (flag, not hard reject —
  // the route already enforces presence; the agent records compliance quality).
  const tl = String((opts && opts.tradeLicense) || '').trim();
  if (!tl || tl.length < 4) {
    flags.push('Trade license number missing or too short');
    audit('ONBOARDING AGENT', 'trade license check', 'flag', `Trade license missing/too short for "${n}"`);
  } else {
    audit('ONBOARDING AGENT', 'trade license check', 'pass', `Trade license recorded: ${tl}`);
  }

  // (f) Trust & KYC: website domain should roughly match the email domain (warn only).
  const site = String((opts && opts.website) || '').trim();
  if (site) {
    const siteHost = (site.match(/^https?:\/\/([^/\s]+)/i) || [])[1] || '';
    const siteDomain = siteHost.toLowerCase().replace(/^www\./, '');
    const roughMatch = siteDomain && domain && (siteDomain === domain || siteDomain.endsWith('.' + domain) || domain.endsWith('.' + siteDomain)
      || siteDomain.split('.').slice(-2).join('.') === domain.split('.').slice(-2).join('.'));
    if (!roughMatch) {
      flags.push(`Website domain (${siteDomain || site}) does not match email domain (${domain})`);
      audit('ONBOARDING AGENT', 'website/email domain check', 'flag', `Domain mismatch for "${n}": website ${siteDomain || site} vs email ${domain}`);
    } else {
      audit('ONBOARDING AGENT', 'website/email domain check', 'pass', `Website domain matches email domain: ${domain}`);
    }
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

  /* ============ Deals 2.0 — deal numbers, type/status chips, shipment stepper ============ */
  .deal-num { font-family: var(--font-display); font-weight: 700; font-size: 0.8125rem; color: var(--gold); letter-spacing: 0.04em; white-space: nowrap; }
  .chip { display: inline-block; border-radius: 999px; padding: 0.15rem 0.6rem; font: 600 0.7rem var(--font-body); text-transform: uppercase; letter-spacing: 0.08em; border: 1px solid var(--border-soft); color: var(--ink-muted); }
  .chip-sell { color: var(--gold); border-color: var(--border-gold); background: var(--gold-glow); }
  .chip-buy { color: var(--mint); border-color: var(--ok-border); background: var(--ok-badge-bg); }
  .chip-category { color: var(--ink-muted); }
  .status-chip { display: inline-block; border-radius: 999px; padding: 0.15rem 0.6rem; font: 600 0.7rem var(--font-body); text-transform: uppercase; letter-spacing: 0.08em; border: 1px solid var(--ok-border); color: var(--mint); background: var(--ok-badge-bg); }
  .status-chip.st-open { color: var(--gold); border-color: var(--border-gold); background: var(--gold-glow); }
  .status-chip.st-production, .status-chip.st-dispatched, .status-chip.st-shipped { color: var(--warning); border-color: var(--warn-border); background: var(--warn-bg); }
  .status-chip.st-closed { color: var(--ink-muted); border-color: var(--border-soft); background: var(--bg-elevated); }
  .private-value-note { font-size: 12px; color: var(--ink-muted); white-space: nowrap; }
  .hint-chips { display: flex; gap: 6px; flex-wrap: wrap; margin: -6px 0 8px; }
  .hint-chip { display: inline-block; border-radius: 999px; padding: 0.12rem 0.6rem; font: 500 0.72rem var(--font-body); border: 1px dashed var(--border-gold); color: var(--gold); background: transparent; }
  /* Shipment status stepper — gold progress rail, motion-revealed nodes */
  .stepper { display: flex; align-items: flex-start; margin: 16px 0 6px; }
  .stepper .step-node { flex: 1; text-align: center; position: relative; }
  .stepper .step-node::before { /* rail */
    content: ""; position: absolute; top: 11px; left: -50%; right: 50%; height: 3px;
    background: var(--border-soft); z-index: 0;
  }
  .stepper .step-node:first-child::before { display: none; }
  .stepper .step-node.done::before { background: var(--gradient-coin); }
  .stepper .step-dot {
    position: relative; z-index: 1; display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 24px; border-radius: 50%; font-size: 12px; font-weight: 700;
    background: var(--bg-spotlight); border: 2px solid var(--border-soft); color: var(--ink-faint);
  }
  .stepper .step-node.done .step-dot { background: var(--gradient-coin); border-color: var(--gold); color: var(--on-gold); box-shadow: var(--gold-shadow-sm); }
  .stepper .step-node.current .step-dot { border-color: var(--gold); color: var(--gold); box-shadow: 0 0 0 4px var(--gold-glow); }
  .stepper .step-lbl { display: block; margin-top: 6px; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-faint); }
  .stepper .step-node.done .step-lbl, .stepper .step-node.current .step-lbl { color: var(--gold); }
  @media (prefers-reduced-motion: no-preference) {
    html.dz-js .stepper .step-node { opacity: 0; animation: dz-rise .45s cubic-bezier(.2,.7,.25,1) forwards; animation-delay: calc(var(--i, 0) * 90ms); }
    .stepper .step-node.current .step-dot { animation: dz-steppulse 2.2s ease-in-out infinite; }
    @keyframes dz-steppulse { 0%, 100% { box-shadow: 0 0 0 3px var(--gold-glow); } 50% { box-shadow: 0 0 0 7px var(--gold-glow); } }
  }

  /* ==================== MOTION DESIGN LAYER ====================
     Living trading-floor feel: drifting atmosphere, choreographed entrances,
     micro-interactions. All motion is gated behind prefers-reduced-motion. */

  /* Atmosphere — fixed aurora layers behind all content (painted over the
     propagated body background, under everything else). Dark: deep gold nebula
     with a whisper of mint. Transform-only drift = GPU-friendly. */
  body::before {
    content: ""; position: fixed; inset: -15%; z-index: -1; pointer-events: none;
    background:
      radial-gradient(38% 32% at 18% 22%, rgba(245,185,66,0.10), transparent 70%),
      radial-gradient(34% 30% at 82% 14%, rgba(63,224,176,0.06), transparent 70%),
      radial-gradient(42% 38% at 55% 88%, rgba(245,185,66,0.07), transparent 70%);
    will-change: transform;
  }
  body::after {
    content: ""; position: fixed; inset: -15%; z-index: -1; pointer-events: none;
    background:
      radial-gradient(30% 26% at 70% 62%, rgba(245,185,66,0.06), transparent 70%),
      radial-gradient(26% 24% at 12% 78%, rgba(63,224,176,0.05), transparent 70%);
    will-change: transform;
  }
  /* Light theme — warm parchment light-play (bullion amber on beige, faint mint). */
  [data-theme="light"] body::before {
    background:
      radial-gradient(38% 32% at 18% 22%, rgba(217,160,43,0.16), transparent 70%),
      radial-gradient(34% 30% at 82% 14%, rgba(11,122,88,0.08), transparent 70%),
      radial-gradient(42% 38% at 55% 88%, rgba(169,118,15,0.11), transparent 70%);
  }
  [data-theme="light"] body::after {
    background:
      radial-gradient(30% 26% at 70% 62%, rgba(240,198,104,0.14), transparent 70%),
      radial-gradient(26% 24% at 12% 78%, rgba(11,122,88,0.06), transparent 70%);
  }

  @media (prefers-reduced-motion: no-preference) {
    /* --- Atmosphere drift: slow 30-45s loops, translate/scale only --- */
    body::before { animation: dz-drift-a 42s ease-in-out infinite alternate; }
    body::after  { animation: dz-drift-b 34s ease-in-out infinite alternate; }
    @keyframes dz-drift-a {
      from { transform: translate3d(0, 0, 0) scale(1); }
      50%  { transform: translate3d(2.5%, -2%, 0) scale(1.06); }
      to   { transform: translate3d(-2%, 2.5%, 0) scale(1.02); }
    }
    @keyframes dz-drift-b {
      from { transform: translate3d(0, 0, 0) scale(1.03); }
      50%  { transform: translate3d(-3%, 2%, 0) scale(1); }
      to   { transform: translate3d(2%, -2.5%, 0) scale(1.07); }
    }

    /* --- Page fade-in (class added by the head/footer scripts) --- */
    html.dz-js body { opacity: 0; transform: translateY(10px); }
    html.dz-js body.dz-in { opacity: 1; transform: none; transition: opacity .22s ease-out, transform .22s ease-out; }

    /* --- Staggered entrance + scroll reveal ---
       Hidden only until .in-view lands; animation uses fill-mode "backwards"
       so hover transforms keep working after the entrance completes. */
    html.dz-js [data-reveal]:not(.in-view) { opacity: 0; }
    html.dz-js [data-reveal].in-view { animation: dz-rise .55s cubic-bezier(.2, .7, .25, 1) backwards; animation-delay: calc(var(--i, 0) * 60ms); }
    @keyframes dz-rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }

    /* --- Buttons: shine sweep on the struck-gold primary, press feedback --- */
    .btn:not(.btn-outline):not(.btn-danger):not(.btn-green)::before {
      content: ""; position: absolute; top: -10%; bottom: -10%; left: 0; width: 45%;
      background: linear-gradient(105deg, transparent 0%, rgba(255,255,255,0.5) 50%, transparent 100%);
      transform: translateX(-170%) skewX(-18deg); transition: transform .55s ease; pointer-events: none;
    }
    .btn:not(.btn-outline):not(.btn-danger):not(.btn-green):hover::before { transform: translateX(330%) skewX(-18deg); }
    .btn:active { transform: scale(.97); }
    .btn-outline { transition: border-color .18s ease, transform .18s ease, background .18s ease, color .18s ease; }
    .btn-outline:hover { transform: translateY(-1px); border-color: var(--gold); }

    /* --- Cards: hover lift with stronger gold shadow + border glow --- */
    .card { transition: transform .18s ease-out, box-shadow .18s ease-out, border-color .18s ease-out; }
    .card:hover { transform: translateY(-3px); box-shadow: var(--card-shadow-hover), 0 0 0 1px var(--border-gold); border-color: var(--border-gold); }
    .card-deal:hover { transform: translateY(-3px); box-shadow: var(--card-shadow-hover), var(--shadow-gold), 0 0 0 1px var(--border-gold); }

    /* --- Nav icons: micro-bounce + gold underlight; active page gets a pulsing gold dot --- */
    .nav-ic:hover { transform: translateY(-2px) scale(1.08); }
    .nav-ic::after { content: ""; position: absolute; left: 9px; right: 9px; bottom: 1px; height: 5px; border-radius: 50%; background: var(--gold); filter: blur(5px); opacity: 0; transition: opacity .2s ease; pointer-events: none; }
    .nav-ic:hover::after { opacity: .45; }
    .nav-ic.active::before { content: ""; position: absolute; bottom: 4px; left: 50%; width: 5px; height: 5px; margin-left: -2.5px; border-radius: 50%; background: var(--gold); box-shadow: 0 0 6px var(--gold); animation: dz-navdot 2s ease-in-out infinite; pointer-events: none; }
    @keyframes dz-navdot { 0%, 100% { transform: scale(1); opacity: .9; } 50% { transform: scale(1.35); opacity: .5; } }

    /* --- Unread / notification badges: gentle pulse --- */
    .unread-chip { animation: badge-pulse 2s ease-in-out infinite; }
    @keyframes badge-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.12); } }

    /* --- Wax seals: slow idle sway (sealed letters only) --- */
    .mail-row--sealed .wax-seal { animation: dz-seal-sway 4s ease-in-out infinite alternate; }
    @keyframes dz-seal-sway { from { transform: rotate(-8deg); } to { transform: rotate(-5deg); } }

    /* --- Like button: one-time heart-burst pop on render when .liked --- */
    .btn.liked { animation: dz-likeburst .3s ease-out; }
    @keyframes dz-likeburst { 0% { transform: scale(1); } 40% { transform: scale(1.35); } 100% { transform: scale(1); } }
    .feed-actions .btn:active { transform: scale(.93); }

    /* --- Flash messages: slide-in + 5s countdown progress bar (matches auto-dismiss) --- */
    .flash-ok, .flash-err { position: relative; overflow: hidden; }
    .flash-ok::after, .flash-err::after {
      content: ""; position: absolute; left: 0; bottom: 0; height: 3px; width: 100%;
      background: currentColor; opacity: .45; transform-origin: left center;
      animation: dz-flashbar 5s linear forwards;
    }
    @keyframes dz-flashbar { from { transform: scaleX(1); } to { transform: scaleX(0); } }
    @keyframes flashin { from { transform: translateY(-8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    @keyframes warnpulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

    /* --- Signing-room vault: breathing mint inner ring ("the vault is listening") ---
       Opacity-animated pseudo-element (inset shadows stay inside the clipped vault). */
    .vault::after {
      content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
      box-shadow: inset 0 0 0 1px var(--ok-border), inset 0 0 26px rgba(63,224,176,0.22);
      opacity: 0; animation: dz-vault-breathe 3.8s ease-in-out infinite;
    }
    @keyframes dz-vault-breathe { 0%, 100% { opacity: 0; } 50% { opacity: .85; } }

    /* --- Finalized / approved contract badges: shimmer sweep --- */
    .badge-contract {
      background-image: linear-gradient(100deg, transparent 20%, rgba(63,224,176,0.35) 50%, transparent 80%);
      background-size: 220% 100%; background-repeat: no-repeat;
      animation: dz-shimmer 3.2s linear infinite;
    }
    @keyframes dz-shimmer { from { background-position: 200% 0; } to { background-position: -120% 0; } }

    /* --- Search inputs: focus glow expand --- */
    input[name="q"] { transition: box-shadow .2s ease, transform .2s ease, border-color .2s ease, background .2s ease; }
    input[name="q"]:focus { box-shadow: 0 0 0 4px var(--gold-glow), 0 0 26px var(--gold-glow); transform: scale(1.01); }
  }

  /* --- Stage C: negotiation timeline (rounds) --- */
  .tl { position: relative; margin: 6px 0 18px; padding-left: 26px; }
  .tl::before { content: ""; position: absolute; left: 8px; top: 6px; bottom: 6px; width: 2px;
    background: linear-gradient(180deg, var(--gold), var(--mint)); opacity: .35; border-radius: 2px; }
  .tl-item { position: relative; padding: 10px 0 10px 8px; }
  .tl-dot { position: absolute; left: -24px; top: 16px; width: 14px; height: 14px; border-radius: 50%;
    background: var(--surface-card); border: 2px solid var(--gold); box-shadow: 0 0 10px var(--gold-glow); }
  .tl-body { background: var(--bg-elevated); border: 1px solid var(--border-soft); border-radius: 12px; padding: 10px 14px;
    transition: transform .25s ease, border-color .25s ease; }
  .tl-body:hover { transform: translateX(3px); border-color: var(--border-gold); }

  /* --- Stage C: congratulations announcement card --- */
  .card-announce { border: 1px solid var(--border-gold);
    background: linear-gradient(150deg, rgba(245,185,66,.12), rgba(63,224,176,.06) 60%, transparent),
      var(--surface-card); box-shadow: 0 0 34px var(--gold-glow); }

  /* --- Stage C: calendar grid --- */
  .cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; }
  .cal-dow { text-align: center; font-size: 11px; letter-spacing: .12em; text-transform: uppercase;
    color: var(--ink-muted); padding: 4px 0; }
  .cal-cell { min-height: 74px; border: 1px solid var(--border-soft); border-radius: 10px; padding: 5px 6px;
    background: var(--bg-elevated); transition: border-color .2s ease, box-shadow .2s ease; }
  .cal-cell:hover { border-color: var(--border-gold); box-shadow: 0 0 14px var(--gold-glow); }
  .cal-empty { background: transparent; border-style: dashed; opacity: .4; }
  .cal-today { border-color: var(--gold); box-shadow: inset 0 0 0 1px var(--gold); }
  .cal-day { font-size: 12px; font-weight: 600; color: var(--ink-muted); margin-bottom: 3px; }
  .cal-today .cal-day { color: var(--gold); }
  .cal-event { display: block; font-size: 11px; line-height: 1.3; padding: 2px 6px; margin-bottom: 2px;
    border-radius: 6px; background: var(--gold-glow); color: var(--gold); text-decoration: none;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: transform .2s ease; }
  .cal-event:hover { transform: translateX(2px); }
  .cal-event.cal-signing { background: rgba(63,224,176,.14); color: var(--mint); }
  @media (max-width: 700px) { .cal-cell { min-height: 52px; } .cal-event { font-size: 10px; } }

  /* Reduced motion: kill every animation/transition globally, show content instantly. */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
      scroll-behavior: auto !important;
    }
  }
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
  contracts: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7.5 9 6 9-6"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 3v4M16 3v4"/><path d="M7.5 14h3M13.5 14h3M7.5 17.5h3"/></svg>'
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
         ${navIcon('calendar', '/calendar', 'Calendar', active)}
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
<script>try{if(localStorage.getItem('dz-theme')==='light'){document.documentElement.dataset.theme='light';}}catch(e){}document.documentElement.classList.add('dz-js');</script>
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
<script>(function(){
  var reduce=!!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  // Page fade-in: add the class on the next frame so the CSS transition fires.
  requestAnimationFrame(function(){if(document.body)document.body.classList.add('dz-in');});
  // Flash messages: auto-dismiss after 5s (matches the CSS countdown bar).
  setTimeout(function(){document.querySelectorAll('.flash-ok,.flash-err').forEach(function(e){e.style.transition='opacity .4s';e.style.opacity='0';setTimeout(function(){e.remove();},400);});},5000);
  // Theme toggle (persists to localStorage).
  var root=document.documentElement,btn=document.getElementById('theme-toggle');
  function paintIcon(){if(btn)btn.textContent=root.dataset.theme==='light'?'\\u2600\\uFE0F':'\\uD83C\\uDF19';}
  if(btn){paintIcon();btn.addEventListener('click',function(){
    if(root.dataset.theme==='light'){root.removeAttribute('data-theme');}else{root.dataset.theme='light';}
    try{localStorage.setItem('dz-theme',root.dataset.theme==='light'?'light':'dark');}catch(e){}
    paintIcon();
  });}
  // Styled file-input labels.
  document.querySelectorAll('input.file-input').forEach(function(inp){
    inp.addEventListener('change',function(){
      var lbl=inp.closest('.file-btn');if(!lbl)return;
      var t=lbl.querySelector('.file-btn-text');if(!t)return;
      var def=t.getAttribute('data-default')||'\\uD83D\\uDCCE Attach photo or video';
      t.textContent=(inp.files&&inp.files.length)?'\\uD83D\\uDCCE '+Array.prototype.map.call(inp.files,function(f){return f.name;}).join(', '):def;
    });
  });
  // Stat tiles: count-up 0 -> value over 800ms ease-out (fallback: plain number stays).
  function countUp(el){
    var target=parseFloat(el.getAttribute('data-count'));
    if(!isFinite(target))return;
    if(reduce){el.textContent=String(target);return;}
    var t0=null,dur=800;
    var step=function(ts){
      if(t0===null)t0=ts;
      var p=Math.min(1,(ts-t0)/dur),e=1-Math.pow(1-p,3);
      el.textContent=String(Math.round(target*e));
      if(p<1)requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  // Scroll reveal: one shared IntersectionObserver adds .in-view / triggers count-ups.
  var motionEls=document.querySelectorAll('[data-reveal],[data-count]');
  if('IntersectionObserver' in window&&motionEls.length){
    var io=new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        if(!en.isIntersecting)return;
        var el=en.target;
        if(el.hasAttribute('data-reveal'))el.classList.add('in-view');
        if(el.hasAttribute('data-count')&&!el.getAttribute('data-counted')){el.setAttribute('data-counted','1');countUp(el);}
        io.unobserve(el);
      });
    },{threshold:0.12});
    motionEls.forEach(function(el){io.observe(el);});
  }else{
    motionEls.forEach(function(el){
      if(el.hasAttribute('data-reveal'))el.classList.add('in-view');
      if(el.hasAttribute('data-count'))countUp(el);
    });
  }
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

// ----- Deals 2.0: types, incoterms, status pipeline -----
const DEAL_TYPES = ['sell', 'buy'];
const DEAL_INCOTERMS = ['FOP', 'CIF', 'CRF'];
const INCOTERM_EXPLAINERS = {
  FOP: 'FOP — Free on Plane/Point: the buyer arranges & pays main carriage. Shipment tracking is not available on the platform.',
  CIF: 'CIF — Cost, Insurance & Freight: the seller pays shipping and insurance to the destination port. Platform tracking enabled.',
  CRF: 'CRF — Cost & Freight: the seller pays freight to the destination port; insurance is on the buyer. Platform tracking enabled.'
};
const DEAL_STATUSES = ['open', 'production', 'dispatched', 'shipped', 'delivered'];
/** Small status chip for feed cards and lists. */
function dealStatusChip(deal) {
  const st = deal.contract_state === 'approved' ? 'closed' : (deal.status || 'open');
  return `<span class="status-chip st-${esc(st)}">${st === 'closed' ? 'closed · contracted' : esc(st)}</span>`;
}
/** Sell/buy + category chips row for deal cards. */
function dealTypeChips(deal) {
  const t = DEAL_TYPES.includes(deal.deal_type) ? deal.deal_type : 'sell';
  return `<span class="chip chip-${t}">${t === 'sell' ? 'Selling' : 'Buying'}</span>`
    + (deal.category ? ` <span class="chip chip-category">${esc(deal.category)}</span>` : '');
}
/** The contracted buyer company id for a deal: finalized contract_party_id, else the signer on a live contract (legacy name fallback last). */
function dealBuyerId(deal) {
  if (!deal) return null;
  if (deal.contract_party_id) return deal.contract_party_id;
  const live = db.prepare(`SELECT signer_company_id FROM contracts WHERE deal_id = ? AND status IN ('pending','pending_owner','pending_admin') ORDER BY id DESC LIMIT 1`).get(deal.id);
  if (live) return live.signer_company_id;
  if (deal.contract_state === 'approved' && deal.contract_party) {
    const row = db.prepare('SELECT id FROM companies WHERE name = ?').get(deal.contract_party);
    if (row) return row.id;
  }
  return null;
}
/** Themed gold shipment stepper (open → production → dispatched → shipped → delivered). */
function stepperHtml(deal) {
  const closed = deal.contract_state === 'approved' || deal.status === 'closed';
  const curIdx = DEAL_STATUSES.indexOf(deal.status);
  const doneThrough = closed ? DEAL_STATUSES.length - 1 : (curIdx < 0 ? 0 : curIdx);
  const nodes = DEAL_STATUSES.map((s, i) => {
    const cls = closed || i < doneThrough ? 'done' : (i === doneThrough ? (closed ? 'done' : 'current done') : '');
    return `<div class="step-node ${cls}" style="--i:${i}"><span class="step-dot">${closed || i <= doneThrough ? '✓' : (i + 1)}</span><span class="step-lbl">${esc(s)}</span></div>`;
  }).join('');
  return `<div class="stepper" role="list" aria-label="Deal status">${nodes}</div>`
    + (closed ? '<p style="margin-top:8px"><span class="badge badge-contract">Deal closed — contract finalized ✓</span></p>' : '');
}
/** Shared deal composer fields (used by /deals/new and /new). */
function dealFormFieldsHtml() {
  return `
      <label>I want to…</label>
      <div style="display:flex;gap:16px;margin-bottom:12px">
        <label style="display:flex;gap:8px;align-items:center;margin:0;font-weight:600;color:var(--ink-primary)">
          <input type="radio" name="deal_type" value="sell" style="width:auto;margin:0" checked> 💰 SELL</label>
        <label style="display:flex;gap:8px;align-items:center;margin:0;font-weight:600;color:var(--ink-primary)">
          <input type="radio" name="deal_type" value="buy" style="width:auto;margin:0"> 🛒 BUY</label>
      </div>
      <label>Deal title</label><input type="text" name="title" required maxlength="160">
      <div class="grid2" style="gap:10px">
        <div><label>Category (required)</label><select name="category" required><option value="">— choose —</option>${optionsHtml(COMPANY_CATEGORIES, '')}</select></div>
        <div><label>Origin location (required)</label><input type="text" name="origin" required maxlength="160" placeholder="e.g. Rotterdam, NL"></div>
      </div>
      <label>Incoterm</label>
      <select name="incoterm" id="incoterm-select">${optionsHtml(DEAL_INCOTERMS, 'CIF')}</select>
      <p class="muted" style="margin:-6px 0 12px">${esc(INCOTERM_EXPLAINERS.FOP)}<br>${esc(INCOTERM_EXPLAINERS.CIF)}<br>${esc(INCOTERM_EXPLAINERS.CRF)}</p>
      <label>Deal value (e.g. 50,000 / year) — shared privately, never shown on feeds</label><input type="text" name="value" maxlength="80">
      <div class="grid2" style="gap:10px">
        <div><label>Currency</label><select name="currency">${optionsHtml(DEAL_CURRENCIES, 'USD')}</select></div>
        <div><label>Time period</label><select name="time_period">${optionsHtml(DEAL_TIME_PERIODS, '30 days')}</select></div>
      </div>
      <label>Description</label><textarea name="description" rows="6" required maxlength="4000"></textarea>
      <div id="proof-section">
        <hr class="sep">
        <label>Product proof (selling)</label>
        <div style="display:flex;gap:16px;margin-bottom:10px">
          <label style="display:flex;gap:8px;align-items:center;margin:0;font-weight:500;color:var(--ink-primary)">
            <input type="radio" name="proof_mode" value="pdf" style="width:auto;margin:0" checked> Upload proof PDF</label>
          <label style="display:flex;gap:8px;align-items:center;margin:0;font-weight:500;color:var(--ink-primary)">
            <input type="radio" name="proof_mode" value="manual" style="width:auto;margin:0"> Describe manually</label>
        </div>
        <div id="proof-pdf-block">
          <label class="file-btn"><span class="file-btn-text" data-default="📎 Upload product proof (PDF, max 15 MB)">📎 Upload product proof (PDF, max 15 MB)</span>
            <input type="file" class="file-input" name="product_proof" accept="application/pdf,.pdf"></label>
          <p class="muted" style="margin:-4px 0 10px">Screened by the Document Authenticity Agent.</p>
        </div>
        <div id="proof-manual-block" style="display:none">
          <label>Product proof — manual description</label>
          <textarea name="product_proof_text" rows="3" maxlength="2000" placeholder="e.g. Warehouse stock of 12,000 units, batch certificates available on request…"></textarea>
        </div>
      </div>
      <script>(function(){
        function sync(){
          var selling=(document.querySelector('input[name=deal_type]:checked')||{}).value!=='buy';
          var sec=document.getElementById('proof-section'); if(sec)sec.style.display=selling?'':'none';
          var mode=(document.querySelector('input[name=proof_mode]:checked')||{}).value||'pdf';
          var pb=document.getElementById('proof-pdf-block'), mb=document.getElementById('proof-manual-block');
          if(pb)pb.style.display=(selling&&mode==='pdf')?'':'none';
          if(mb)mb.style.display=(selling&&mode==='manual')?'':'none';
        }
        document.querySelectorAll('input[name=deal_type],input[name=proof_mode]').forEach(function(r){r.addEventListener('change',sync);});
        sync();
      })();</script>`;
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
function createSession(req, res, companyId, isAdmin, memberId) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare('INSERT INTO sessions (token, company_id, is_admin, member_id, created_at, expires_at) VALUES (?,?,?,?,?,?)')
    .run(token, companyId, isAdmin ? 1 : 0, memberId || null, now(), expires);
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
  // Sub-account session: resolve the member (must still be active) and attach attribution info.
  if (sess.member_id) {
    const m = db.prepare(`SELECT id, name, role, status FROM company_members WHERE id = ? AND company_id = ?`).get(sess.member_id, c.id);
    if (!m || m.status !== 'active') return null;
    return { id: c.id, name: c.name, isAdmin: false, memberId: m.id, memberName: m.name, memberRole: m.role };
  }
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

// ============================= TERMS & CONDITIONS (REGISTRATION) =============================
// The commission percentage in clauses 4 is live — it reflects the admin-adjustable platform_fee_pct setting.
function termsClauses() {
  const pct = platformFeePct();
  return [
  '1. LAWFUL CONDUCT. The registering company shall not use the Dealzoin platform for any illegal activity, and shall not offer, negotiate, or conclude any trade with countries, entities or individuals subject to international sanctions or bans.',
  '2. TRANSPARENCY PLEDGE. The company pledges to submit truthful, accurate and current documents and information upon request by the platform, and to promptly correct any submission found to be inaccurate.',
  `3. ANTI-MONEY-LAUNDERING PLEDGE. The company pledges that it will not use the platform for money fraud, money laundering, or the concealment of the origin or ownership of funds, and will cooperate with lawful compliance inquiries.`,
  `4. PLATFORM COMMISSION. The platform commission (currently ${pct}% of deal value) becomes due after the required approvals have been granted but BEFORE deal processing begins. The commission is transparent, disclosed before signing, and separate from the deal value exchanged between the parties.`,
  '5. SIGNING RESPONSIBILITY. The individual registering and signing on behalf of the company is fully responsible for every contract they sign on the platform, and warrants they hold the signing authority of the company.',
  '6. PLATFORM LIABILITY LIMITS. Dealzoin provides the network, signing rooms and security agents as a venue only. To the maximum extent permitted by law, the platform is not liable for the performance of contracts between member companies, nor for indirect or consequential damages.',
  '7. DOCUMENT AUTHENTICITY. All documents uploaded to the platform must be authentic and unaltered. Forged, duplicated or misleading documents are grounds for immediate rejection, suspension and reporting to the competent authorities.'
  ];
}
function signupPledges() {
  return [
  ['pledge_legal', 'We pledge not to engage in illegal activity or trade with sanctioned/banned countries.'],
  ['pledge_transparency', 'We pledge to submit truthful documents and information whenever the platform requests them.'],
  ['pledge_aml', 'We pledge not to engage in money fraud or money laundering of any kind.'],
  ['pledge_commission', `We accept the platform commission (currently ${platformFeePct()}%), due after approvals but before deal processing.`],
  ['pledge_responsibility', 'The signer is fully responsible for the contracts they sign, and all uploaded documents are authentic.']
  ];
}
const COMPANY_CATEGORIES = ['Trading', 'Manufacturing', 'Logistics', 'Technology', 'Agriculture', 'Energy', 'Construction', 'Healthcare', 'Finance', 'Other'];

/** Full registration Terms & Conditions page (public). */
app.get('/legal/terms', (req, res) => {
  const body = `
  <div class="card vault">
    <div class="kicker">Legal · Registration agreement</div>
    <h2 style="margin:6px 0 10px">📜 Dealzoin Terms &amp; Conditions</h2>
    <p class="muted" style="margin-bottom:12px">These terms govern company registration on the Dealzoin B2B network. Every registering company must read, sign and upload a signed copy during registration.</p>
    ${termsClauses().map(c => `<p style="margin-bottom:10px">${esc(c)}</p>`).join('')}
    <hr class="sep">
    <p class="muted">Download this document, print it, sign it, and upload the signed copy during registration.</p>
    <div class="feed-actions" style="margin-top:12px">
      <a class="btn" href="/legal/terms/download">Download Terms &amp; Conditions (.doc)</a>
      <a class="btn btn-outline" href="/signup">Back to registration</a>
    </div>
  </div>`;
  res.send(page('Terms & Conditions', body, currentUser(req), req.query.msg, req.query.err));
});

/** Download the Terms & Conditions as a Word-compatible .doc (same pattern as contracts). */
app.get('/legal/terms/download', (req, res) => {
  const doc = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
<head><meta charset="utf-8"><title>Dealzoin Terms &amp; Conditions</title></head>
<body style="font-family:Calibri,Arial,sans-serif">
  <h1>Dealzoin — Registration Terms &amp; Conditions</h1>
  <p><b>Generated:</b> ${esc(now())}</p>
  ${termsClauses().map(c => `<p>${esc(c)}</p>`).join('')}
  <p>__________________________<br>Authorized signatory — full legal name, signature &amp; date</p>
</body></html>`;
  res.setHeader('Content-Type', 'application/msword');
  res.setHeader('Content-Disposition', 'attachment; filename="dealzoin-terms-and-conditions.doc"');
  res.send(doc);
});

// ----- Company signup (compliance-grade: ONBOARDING + DOCUMENT AUTHENTICITY agents run here) -----
app.get('/signup', (req, res) => {
  const pledgeBoxes = signupPledges().map(([key, text]) => `
      <label style="display:flex;gap:8px;align-items:flex-start;margin:8px 0;font-weight:500;color:var(--ink-primary)">
        <input type="checkbox" name="${key}" value="yes" style="width:auto;margin:3px 0 0" required>
        <span>${esc(text)}</span></label>`).join('');
  const docInput = (name, label, required) => `
      <label>${esc(label)}${required ? ' (required, PDF)' : ' (optional, PDF)'}</label>
      <label class="file-btn"><span class="file-btn-text" data-default="📎 ${esc(label)}">📎 ${esc(label)}</span>
        <input type="file" class="file-input" name="${name}" accept="application/pdf,.pdf"${required ? ' required' : ''}></label>`;
  const body = `
  <div class="card" style="max-width:620px;margin:0 auto" data-reveal>
    <div class="kicker">Compliance-grade registration</div>
    <h2 style="margin:6px 0 8px">Register your company</h2>
    <p class="muted" style="margin-bottom:14px">Companies only — no individual accounts. New companies are reviewed by an admin before they can trade.</p>

    <div class="card" style="background:var(--bg-elevated)">
      <h3 style="margin-bottom:6px">Step 1 — Company profile PDF <span class="muted">(optional, encouraged)</span></h3>
      <p class="muted" style="margin-bottom:10px">Upload your company profile and our agent will auto-fill the form below for you to review.</p>
      <label class="file-btn"><span class="file-btn-text" id="profile-label" data-default="📎 Upload your company profile (PDF)">📎 Upload your company profile (PDF)</span>
        <input type="file" class="file-input" id="profile-pdf" name="profile_pdf" accept="application/pdf,.pdf" form="signup-form"></label>
      <div id="parse-note"></div>
    </div>

    <h3 style="margin:16px 0 6px">Step 2 — Company details &amp; KYC documents</h3>
    <form method="POST" action="/signup/complete" enctype="multipart/form-data" id="signup-form">
      <label>Company name</label><input type="text" name="name" id="f-name" required maxlength="120">
      <div class="grid2">
        <div><label>Business email</label><input type="email" name="email" id="f-email" required maxlength="160"></div>
        <div><label>Password (min 8 characters)</label><input type="password" name="password" required minlength="8" maxlength="200"></div>
      </div>
      <label>Website (required)</label><input type="url" name="website" id="f-website" required placeholder="https://example.com" maxlength="200">
      <label>Description</label><textarea name="description" rows="4" maxlength="2000"></textarea>
      <label>Field of activity (required)</label><input type="text" name="activity" id="f-activity" required maxlength="300" placeholder="e.g. Wholesale electronics trading">
      <div class="grid2">
        <div><label>Category (required)</label><select name="category" required><option value="">— choose —</option>${optionsHtml(COMPANY_CATEGORIES, '')}</select></div>
        <div><label>Trade license number (required)</label><input type="text" name="trade_license" required minlength="4" maxlength="80" placeholder="e.g. TL-9988"></div>
      </div>

      <hr class="sep">
      ${docInput('moa_authority', 'MOA & authority document — Memorandum of Association / authorization proving you may register this company', true)}
      ${docInput('bank_statement', 'Bank account statement / proof of funds', true)}
      <label>Signed Terms &amp; Conditions (required, PDF)</label>
      <p class="muted" style="margin-bottom:8px"><a href="/legal/terms">Read the Terms &amp; Conditions</a> — download, print, sign, and upload the signed copy below.
        <a href="/legal/terms/download">Download the Terms &amp; Conditions (.doc)</a></p>
      <label class="file-btn"><span class="file-btn-text" data-default="📎 Upload signed Terms &amp; Conditions">📎 Upload signed Terms &amp; Conditions</span>
        <input type="file" class="file-input" name="signed_terms" accept="application/pdf,.pdf" required></label>
      ${docInput('activity_proof', 'Activity proof (e.g. portfolio, catalog, past invoices)', false)}

      <hr class="sep">
      <h3 style="margin-bottom:6px">Pledges &amp; signature</h3>
      ${pledgeBoxes}
      <label>Typed legal signature — type your full legal name; this acts as your signature</label>
      <input type="text" name="signature_name" required maxlength="120" placeholder="Full legal name of the authorized signatory">
      <p class="muted" style="margin-bottom:12px">Your signature timestamp and IP address are recorded with this registration.</p>
      <button class="btn" type="submit">Create company account</button>
    </form>
    <p class="muted" style="margin-top:12px">Already approved? <a href="/login">Sign in</a></p>
    <p class="shield-note">🛡️ Screened by the Onboarding &amp; Document Authenticity agents</p>
  </div>
  <script>(function(){
    var inp=document.getElementById('profile-pdf');
    if(!inp)return;
    inp.addEventListener('change',function(){
      var note=document.getElementById('parse-note');
      if(!inp.files||!inp.files.length)return;
      var fd=new FormData();
      fd.append('profile',inp.files[0]);
      if(note)note.innerHTML='<p class="muted" style="margin-top:8px">⏳ Reading your company profile…</p>';
      fetch('/signup/parse-profile',{method:'POST',body:fd}).then(function(r){return r.json();}).then(function(g){
        if(g&&g.ok){
          var set=function(id,v){var el=document.getElementById(id);if(el&&v&&!el.value)el.value=v;};
          set('f-name',g.name);set('f-website',g.website);set('f-email',g.email);set('f-activity',g.activity);
          if(note)note.innerHTML='<div class="flash-ok" style="margin-top:8px">✓ Auto-filled from your company profile — please review.</div>';
        }else{
          if(note)note.innerHTML='<div class="flash-err" style="margin-top:8px">⚠ '+(g&&g.error?g.error:'Could not read that PDF — please fill the form manually.')+'</div>';
        }
      }).catch(function(){
        if(note)note.innerHTML='<div class="flash-err" style="margin-top:8px">⚠ Could not read that PDF — please fill the form manually.</div>';
      });
    });
  })();</script>`;
  res.send(page('Sign up', body, null, req.query.msg, req.query.err));
});

/** AJAX helper: parse an uploaded company-profile PDF and return auto-fill guesses as JSON. */
app.post('/signup/parse-profile', (req, res) => {
  pdfUpload.single('profile')(req, res, async (err) => {
    if (err) return res.json({ ok: false, error: err.code === 'LIMIT_FILE_SIZE' ? 'PDF too large (max 15 MB).' : PDF_RULES_MSG });
    if (!req.file) return res.json({ ok: false, error: 'No PDF received.' });
    if (!isPdfBuffer(req.file.buffer)) return res.json({ ok: false, error: 'That file is not a real PDF.' });
    const parsed = await extractPdfText(req.file.buffer);
    if (!parsed) return res.json({ ok: false, error: 'Could not parse that PDF — it may be corrupt or password-protected.' });
    const g = guessesFromProfileText(parsed.text);
    res.json({ ok: true, ...g });
  });
});

/** Step 2: full registration — fields, KYC documents, pledges, typed signature. */
async function signupCompleteHandler(req, res) {
  const fail = (m) => res.redirect('/signup?err=' + encodeURIComponent(m));
  const b = req.body || {};
  const nm = String(b.name || '').trim();
  const em = String(b.email || '').trim().toLowerCase();
  // Sanitize website: only allow http(s) URLs (blocks javascript: etc.); prepend https:// if missing.
  let site = String(b.website || '').trim().slice(0, 200);
  if (site && !/^https?:\/\//i.test(site)) site = 'https://' + site.replace(/^[a-z][a-z0-9+.-]*:/i, '');
  if (site && !/^https:\/\/[^\s]+$/i.test(site)) site = '';
  const activity = String(b.activity || '').trim().slice(0, 300);
  const category = COMPANY_CATEGORIES.includes(b.category) ? b.category : '';
  const tradeLicense = String(b.trade_license || '').trim().slice(0, 80);
  const signatureName = String(b.signature_name || '').trim().slice(0, 120);

  if (!nm || !em || !b.password) return fail('Company name, email and password are required.');
  if (String(b.password).length < 8) return fail('Password must be at least 8 characters.');
  if (!site) return fail('A valid company website is required (https://…).');
  if (!activity) return fail('Field of activity is required.');
  if (!category) return fail('Please choose a company category.');
  if (tradeLicense.length < 4) return fail('A valid trade license number (min 4 characters) is required.');
  const missingPledge = signupPledges().find(([key]) => b[key] !== 'yes');
  if (missingPledge) return fail('All five pledges must be accepted to register.');
  if (!signatureName) return fail('Please type your full legal name as your signature.');

  // Required KYC documents (PDF-only, magic-byte checked).
  const files = req.files || {};
  for (const docType of ['moa_authority', 'bank_statement', 'signed_terms']) {
    const f = files[docType] && files[docType][0];
    if (!f) return fail(`Missing required document: ${DOC_TYPE_LABELS[docType]}.`);
    if (!isPdfBuffer(f.buffer)) return fail(`${DOC_TYPE_LABELS[docType]} must be a real PDF file.`);
  }
  for (const docType of ['profile_pdf', 'activity_proof']) {
    const f = files[docType] && files[docType][0];
    if (f && !isPdfBuffer(f.buffer)) return fail(`${DOC_TYPE_LABELS[docType]} must be a real PDF file.`);
  }

  // --- ONBOARDING AGENT automated checks ---
  const check = runOnboardingAgent(nm, em, { website: site, tradeLicense });
  if (check.hardReject) return fail(check.error);

  const existing = db.prepare('SELECT id FROM companies WHERE email = ?').get(em);
  if (existing) return fail('A company with this email is already registered.');

  const salt = newSalt();
  const signatureIp = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 80);
  const info = db.prepare(`INSERT INTO companies (name, email, password_hash, salt, website, description, status, flagged, flag_reasons, created_at,
              category, activity, trade_license, signature_name, signature_at, signature_ip)
              VALUES (?,?,?,?,?,?, 'pending', ?, ?, ?, ?,?,?,?,?,?)`)
    .run(nm, em, hashPassword(b.password, salt), salt,
         site, String(b.description || '').trim().slice(0, 2000),
         check.flags.length ? 1 : 0, check.flags.join('; '), now(),
         category, activity, tradeLicense, signatureName, now(), signatureIp);
  const companyId = info.lastInsertRowid;
  audit('ONBOARDING AGENT', 'signup decision', check.flags.length ? 'flag' : 'pass',
        `Company "${nm}" registered as pending (category: ${category}, trade license: ${tradeLicense})${check.flags.length ? ' with warnings: ' + check.flags.join('; ') : ''}`);

  // Store every uploaded KYC document; the DOCUMENT AUTHENTICITY AGENT checks each one.
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
  for (const docType of DOC_TYPES) {
    const f = files[docType] && files[docType][0];
    if (!f) continue;
    try {
      const agent = await runDocumentAgent(company, docType, f);
      saveDocument(companyId, docType, f, agent);
    } catch (e) {
      audit('DOCUMENT AGENT', `document check (${docType})`, 'fail', `"${f.originalname || 'file'}" for "${nm}": agent error: ${e.message}`);
    }
  }

  res.redirect('/login?msg=' + encodeURIComponent('Registration received! Your company and documents are pending admin approval.'));
}
app.post('/signup/complete', signupDocsUpload, signupCompleteHandler);
// Legacy entry point: the old simple POST /signup now routes through the same compliance-grade handler.
app.post('/signup', signupDocsUpload, signupCompleteHandler);

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
    <p class="muted">Team member? Sign in with your own member email &amp; password.</p>
    <p class="shield-note">🛡️ Protected by Dealzoin security agents</p>
  </div>`;
  res.send(page('Sign in', body, null, req.query.msg, req.query.err));
});

app.post('/login', (req, res) => {
  const em = String(req.body.email || '').trim().toLowerCase();
  const pw = String(req.body.password || '');
  const company = db.prepare('SELECT * FROM companies WHERE email = ?').get(em);

  // Sub-account login: team members sign in with their own email + password and act AS the company.
  if (!company) {
    const member = db.prepare(`SELECT * FROM company_members WHERE email = ? AND status = 'active'`).get(em);
    const parent = member ? db.prepare('SELECT * FROM companies WHERE id = ?').get(member.company_id) : null;
    if (!member || !parent || !verifyPassword(pw, member.salt, member.password_hash)) {
      audit('AUTHENTICATION AGENT', 'login password check', 'fail', `Failed login for ${em}`);
      return res.redirect('/login?err=' + encodeURIComponent('Invalid email or password.'));
    }
    if (parent.status !== 'approved') {
      return res.redirect('/login?err=' + encodeURIComponent('This company account is not currently approved. Contact support.'));
    }
    audit('AUTHENTICATION AGENT', 'login password check', 'pass', `Password OK for member ${em} (${member.name} @ ${parent.name})`);
    const code = String(crypto.randomInt(100000, 1000000)); // 6-digit
    const token = randomToken();
    db.prepare('DELETE FROM verification_codes WHERE company_id = ? AND purpose = ?').run(parent.id, 'login');
    db.prepare('INSERT INTO verification_codes (token, company_id, code, purpose, payload, expires_at, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(token, parent.id, code, 'login', JSON.stringify({ member_id: member.id }), new Date(Date.now() + CODE_TTL_MS).toISOString(), now());
    sendVerificationCode(member.email, code);
    audit('AUTHENTICATION AGENT', '2FA code issued', 'pass', `Login code issued for member ${em} (10-min expiry)`);
    res.setHeader('Set-Cookie', `dz_verify=${signedCookieValue(token)}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax${isSecureReq(req) ? '; Secure' : ''}`);
    return res.redirect('/verify-login');
  }

  if (!verifyPassword(pw, company.salt, company.password_hash)) {
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
  // Sub-account session when the login was initiated by a team member.
  let memberId = null, memberRow = null;
  try { memberId = (JSON.parse(row.payload || '{}') || {}).member_id || null; } catch (e) { memberId = null; }
  if (memberId) {
    memberRow = db.prepare(`SELECT * FROM company_members WHERE id = ? AND company_id = ? AND status = 'active'`).get(memberId, company.id);
    if (!memberRow) return res.redirect('/login?err=' + encodeURIComponent('This team member account is no longer active.'));
  }
  audit('AUTHENTICATION AGENT', '2FA verify', 'pass', `2FA passed for ${company.email}${memberRow ? ` (member ${memberRow.name} <${memberRow.email}>)` : ''} — session created`);
  if (memberRow) audit('AUTHENTICATION AGENT', 'member login', 'pass', `Team member ${memberRow.name} <${memberRow.email}> signed in as ${company.name} (role: ${memberRow.role})`);
  res.setHeader('Set-Cookie', 'dz_verify=; HttpOnly; Path=/; Max-Age=0');
  createSession(req, res, company.id, false, memberRow ? memberRow.id : null);
  res.redirect('/timeline?msg=' + encodeURIComponent('Welcome back, ' + (memberRow ? memberRow.name + ' — ' : '') + company.name + '!'));
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
           deal_number: d.deal_number || '', deal_type: d.deal_type || 'sell', category: d.category || '',
           origin: d.origin || '', incoterm: d.incoterm || 'CIF', status: d.status || 'open',
           created_at: d.created_at, media_id: d.media_id, author_name: d.author_name || '' };
}
/** Render one feed card. kind: 'deal' | 'post' | 'repost'. idx = loop index (entrance stagger). */
function feedCard(item, user, names, idx) {
  const stagger = Math.min(Number.isInteger(idx) ? idx : 0, 10);
  const ownerName = names.get(item.company_id) || 'Unknown';
  const isOwn = user && !user.isAdmin && user.id === item.company_id;
  // Member attribution: "— by {member name}" when a sub-account authored the item.
  const byLine = item.author_name ? ` <span class="muted">— by ${esc(item.author_name)}</span>` : '';

  // For reposts the social target is the ORIGINAL deal; otherwise the item itself.
  const targetType = item.kind === 'post' ? 'post' : 'deal';
  const targetId = item.kind === 'repost' ? item.repost_of : item.ref_id;
  const soc = cardSocial(targetType, targetId, user && !user.isAdmin ? user.id : null);

  // System announcement posts (deal-closed congratulations): gold announcement card, shown to everyone.
  if (item.kind === 'post' && item.is_system) {
    const timeStamp = esc(item.created_at.slice(0, 16).replace('T', ' '));
    return `<div class="card card-announce" data-reveal style="--i:${stagger}">
    <div class="feed-head"><div><span class="coin" aria-hidden="true">Dz</span> <b>Dealzoin</b> <span class="muted">official announcement</span></div>
      <span class="muted">${timeStamp}</span></div>
    <p style="margin-top:8px;white-space:pre-wrap">${esc(item.body)}</p>
    ${user && !user.isAdmin ? `
    <div class="feed-actions">
      <form method="POST" action="/like/post/${item.ref_id}">
        <button class="btn btn-sm ${soc.liked ? 'liked' : 'btn-outline'}" type="submit" title="Celebrate">${soc.liked ? 'Liked' : 'Like'} (${soc.likeCount})</button>
      </form>
    </div>` : `<p class="muted" style="margin-top:10px">${soc.likeCount} likes</p>`}
  </div>`;
  }

  let head, bodyHtml;
  if (item.kind === 'post') {
    head = `${avatarHtml(ownerName, companyAvatarMediaId(item.company_id))} <a href="/company/${item.company_id}"><b>${esc(ownerName)}</b></a> <span class="muted">posted</span>${byLine}`;
    bodyHtml = `<p style="margin-top:8px;white-space:pre-wrap">${esc(item.body)}</p>`;
  } else if (item.kind === 'deal') {
    head = `${avatarHtml(ownerName, companyAvatarMediaId(item.company_id))} <a href="/company/${item.company_id}"><b>${esc(ownerName)}</b></a> ${starsHtml(companyReputation(item.company_id), true)} <span class="muted">posted a deal</span>${byLine}`;
    bodyHtml = `<h3 style="margin-top:8px"><a href="/deal/${item.ref_id}">${esc(item.title)}</a></h3>
      <p style="margin-top:6px;white-space:pre-wrap">${esc(item.body)}</p>`;
  } else { // repost
    const origName = names.get(item.orig_company) || 'Unknown';
    head = `🔁 Reposted from <a href="/company/${item.orig_company}"><b>${esc(origName)}</b></a> ${starsHtml(companyReputation(item.orig_company), true)}
            by <a href="/company/${item.company_id}"><b>${esc(ownerName)}</b></a>`;
    bodyHtml = `<h3 style="margin-top:8px"><a href="/deal/${item.repost_of}">${esc(item.title)}</a></h3>
      <p style="margin-top:6px;white-space:pre-wrap">${esc(item.body)}</p>`;
  }
  // Deal values are PRIVATE: feeds never show value/currency/fee — only a "shared privately" note,
  // the prominent deal number, type/category chips, a small status chip, and the time period + timestamp.
  const timeStamp = esc(item.created_at.slice(0, 16).replace('T', ' '));
  let headRight;
  if (item.kind !== 'post') {
    const numLine = item.deal_number ? `<div class="deal-num">Deal № ${esc(item.deal_number)}</div>` : '';
    const chipsLine = `<div style="margin:2px 0">${dealTypeChips(item)} ${dealStatusChip(item)}</div>`;
    const valLine = `<div class="private-value-note">💰 Value shared privately</div>`;
    const tpLine = item.time_period ? `<span class="muted">⏳ ${esc(item.time_period)}</span>` : '';
    headRight = `<div style="text-align:right">${numLine}${chipsLine}${valLine}${tpLine}${tpLine ? '<br>' : ''}<span class="muted">${timeStamp}</span></div>`;
  } else {
    headRight = `<span class="muted">${timeStamp}</span>`;
  }
  // Mint badge once the deal's contract has been approved by an admin.
  const contractBadge = (item.kind !== 'post' && item.contract_state === 'approved')
    ? `<div style="margin-top:10px"><span class="badge badge-contract">Contract approved ✓${item.contract_party ? ' (with ' + esc(item.contract_party) + ')' : ''}</span></div>` : '';

  const signBtn = (item.kind !== 'post' && user && !user.isAdmin && !isOwn && item.company_id !== user.id && item.contract_state !== 'approved')
    ? `<a class="btn btn-sm btn-green" href="/deal/${targetId}/loi">Express interest (LOI)</a>` : '';
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

  return `<div class="card${item.kind === 'post' ? '' : ' card-deal'}" data-reveal style="--i:${stagger}">
    <div class="feed-head"><div>${head}</div>
    ${headRight}</div>
    ${bodyHtml}
    ${mediaHtml(item.media_id)}
    ${contractBadge}
    ${interact}
  </div>`;
}

// ============================= COMPANY ROUTES (timeline, posts, deals) =============================
/** Unified feed query (deals + posts + reposts). Optional filter SQL is injected into each branch.
 *  System announcement posts (is_system = 1) bypass the follow filter — they are shown to EVERYONE. */
function feedQuery(filterSql, ...args) {
  const postFilter = filterSql ? `(${filterSql.replace(/^WHERE\s+/i, '')}) OR p.is_system = 1` : '';
  return db.prepare(`
    SELECT * FROM (
      SELECT 'deal' AS kind, d.id AS ref_id, d.company_id, d.title, d.description AS body,
             d.value, d.created_at, NULL AS repost_of, NULL AS orig_company, d.media_id,
             d.currency, d.time_period, d.contract_state, d.contract_party,
             d.deal_number, d.deal_type, d.category, d.origin, d.incoterm, d.status,
             d.author_name, 0 AS is_system
      FROM deals d ${filterSql}
      UNION ALL
      SELECT 'post', p.id, p.company_id, NULL, p.body, NULL, p.created_at, NULL, NULL, p.media_id,
             NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
             p.author_name, COALESCE(p.is_system, 0)
      FROM posts p ${postFilter ? 'WHERE ' + postFilter : ''}
      UNION ALL
      SELECT 'repost', r.id, r.company_id, d.title, d.description, d.value, r.created_at, d.id, d.company_id, d.media_id,
             d.currency, d.time_period, d.contract_state, d.contract_party,
             d.deal_number, d.deal_type, d.category, d.origin, d.incoterm, d.status,
             d.author_name, 0
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
      <div class="card" data-reveal>
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
      <a class="btn" href="/companies">Browse the companies directory</a>
      <a class="btn btn-outline" href="/explore" style="margin-left:8px">Explore open deals</a>
      <a class="btn btn-outline" href="/search" style="margin-left:8px">Search</a>
    </div>
    ${discoverHtml}
    ${feed.length ? feed.map((i, idx) => feedCard(i, req.user, names, idx)).join('') : ''}`;
  } else {
    feedHtml = feed.length
      ? feed.map((i, idx) => feedCard(i, req.user, names, idx)).join('')
      : '<div class="card"><p class="muted">Nothing yet from the companies you follow. <a href="/companies">Browse the companies directory</a> · <a href="/explore">Explore open deals →</a></p></div>';
  }

  const body = `
  <div class="card">
    <div class="feed-head"><h2>Your exchange — following</h2>
      <div><a class="btn btn-sm btn-outline" href="/explore">🧭 Explorer</a>
      <a class="btn btn-sm btn-outline" href="/companies" style="margin-left:6px">🏢 Companies</a></div></div>
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
  db.prepare('INSERT INTO posts (company_id, body, created_at, media_id, author_name) VALUES (?,?,?,?,?)')
    .run(req.user.id, txt.slice(0, 2000), now(), mediaId, req.user.memberName || null);
  res.redirect((req.get('referer') || '/timeline').split('?')[0] + '?msg=' + encodeURIComponent('Posted!'));
});

app.get('/deals/new', requireCompany, (req, res) => {
  const body = `
  <div class="card" style="max-width:560px;margin:0 auto">
    <h2>📦 Post a new deal</h2>
    <p class="muted" style="margin-bottom:12px">Deals go live on every company's timeline immediately. Deal values stay private — only counterparties see them.</p>
    <form method="POST" action="/deals" enctype="multipart/form-data">
      ${dealFormFieldsHtml()}
      <label>Photo or video (optional — image ≤ 5 MB, video ≤ 25 MB)</label>
      ${fileButtonHtml()}
      <button class="btn" type="submit">Publish deal</button>
    </form>
  </div>`;
  res.send(page('New deal', body, req.user, req.query.msg, req.query.err, 'new'));
});

app.post('/deals', requireCompany, dealUpload, async (req, res) => {
  const title = String(req.body.title || '').trim();
  const desc = String(req.body.description || '').trim();
  const value = String(req.body.value || '').trim().slice(0, 80);
  const currency = DEAL_CURRENCIES.includes(req.body.currency) ? req.body.currency : 'USD';
  const timePeriod = DEAL_TIME_PERIODS.includes(req.body.time_period) ? req.body.time_period : '30 days';
  const dealType = DEAL_TYPES.includes(req.body.deal_type) ? req.body.deal_type : 'sell';
  const category = COMPANY_CATEGORIES.includes(req.body.category) ? req.body.category : '';
  const origin = String(req.body.origin || '').trim().slice(0, 160);
  const incoterm = DEAL_INCOTERMS.includes(req.body.incoterm) ? req.body.incoterm : 'CIF';
  const proofMode = req.body.proof_mode === 'manual' ? 'manual' : 'pdf';
  const proofText = String(req.body.product_proof_text || '').trim().slice(0, 2000);

  if (!title || !desc) return res.redirect('/deals/new?err=' + encodeURIComponent('Title and description are required.'));
  if (!category) return res.redirect('/deals/new?err=' + encodeURIComponent('Please choose a deal category.'));
  if (!origin) return res.redirect('/deals/new?err=' + encodeURIComponent('Origin location is required.'));

  const files = req.files || {};
  const mediaFile = files.media && files.media[0];
  const proofFile = files.product_proof && files.product_proof[0];
  // Selling requires product proof: either an uploaded PDF or a manual description.
  if (dealType === 'sell') {
    if (proofMode === 'pdf' && !proofFile) return res.redirect('/deals/new?err=' + encodeURIComponent('Please upload your product proof PDF (or switch to a manual description).'));
    if (proofMode === 'manual' && !proofText) return res.redirect('/deals/new?err=' + encodeURIComponent('Please describe your product proof (or upload a proof PDF).'));
  }

  const mediaId = mediaFile ? saveMedia(req.user.id, mediaFile) : null;

  // Product-proof PDF → documents vault (doc_type 'product_proof'), screened by the authenticity agent.
  let proofDocId = null;
  if (dealType === 'sell' && proofMode === 'pdf' && proofFile) {
    try {
      const me = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.user.id);
      const agent = await runDocumentAgent(me, 'product_proof', proofFile);
      proofDocId = saveDocument(req.user.id, 'product_proof', proofFile, agent);
    } catch (e) {
      audit('DOCUMENT AGENT', 'document check (product_proof)', 'fail', `Product proof for "${title}": agent error: ${e.message}`);
    }
  }

  const number = nextDealNumber();
  db.prepare(`INSERT INTO deals (company_id, title, description, value, created_at, media_id, currency, time_period,
              deal_type, deal_number, category, origin, incoterm, product_proof, product_proof_doc_id, status, author_name)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'open', ?)`)
    .run(req.user.id, title.slice(0, 160), desc.slice(0, 4000), value, now(), mediaId, currency, timePeriod,
         dealType, number, category, origin, incoterm,
         dealType === 'sell' && proofMode === 'manual' ? proofText : '', proofDocId, req.user.memberName || null);
  audit('DEAL AGENT', 'deal published', 'pass', `${req.user.name} posted ${dealType.toUpperCase()} deal ${number} "${title.slice(0, 60)}" (${category}, ${incoterm}, origin ${origin})`);
  res.redirect('/timeline?msg=' + encodeURIComponent(`Deal ${number} published to all timelines!`));
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
  const category = COMPANY_CATEGORIES.includes(req.query.category) ? req.query.category : '';
  const activity = String(req.query.activity || '').trim();
  const hasFilters = !!(q || category || activity);
  let dealsHtml = '', companiesHtml = '';
  if (hasFilters) {
    const like = '%' + q.replace(/[%_]/g, '') + '%';
    const actLike = '%' + activity.replace(/[%_]/g, '') + '%';
    let dealSql = `SELECT * FROM deals WHERE 1=1`;
    const dealArgs = [];
    if (q) { dealSql += ' AND (title LIKE ? OR description LIKE ?)'; dealArgs.push(like, like); }
    if (category) { dealSql += ' AND category = ?'; dealArgs.push(category); }
    dealSql += ' ORDER BY created_at DESC LIMIT 30';
    const deals = db.prepare(dealSql).all(...dealArgs);
    let compSql = `SELECT * FROM companies WHERE status = 'approved'`;
    const compArgs = [];
    if (q) { compSql += ' AND (name LIKE ? OR description LIKE ?)'; compArgs.push(like, like); }
    if (category) { compSql += ' AND category = ?'; compArgs.push(category); }
    if (activity) { compSql += ' AND activity LIKE ?'; compArgs.push(actLike); }
    compSql += ' ORDER BY name LIMIT 30';
    const companies = db.prepare(compSql).all(...compArgs);
    const names = companyNameMap();
    dealsHtml = deals.length
      ? deals.map((d, idx) => feedCard(dealFeedItem(d), req.user, names, idx)).join('')
      : '<p class="muted">No deals match your search.</p>';
    companiesHtml = companies.length
      ? companies.map((c, idx) => {
          const fc = followCounts(c.id);
          return `<div class="card" data-reveal style="--i:${Math.min(idx, 10)}">
            <div class="feed-head"><h3>${avatarHtml(c.name, c.avatar_media_id)}<a href="/company/${c.id}">${esc(c.name)}</a></h3>${followButton(req.user, c.id)}</div>
            <p class="muted">${c.category ? `<span class="chip chip-category">${esc(c.category)}</span> · ` : ''}${fc.followers} followers · ${fc.following} following</p>
            ${c.activity ? `<p class="muted" style="margin-top:4px">⚙️ ${esc(c.activity)}</p>` : ''}
            <p style="margin-top:6px">${esc(c.description || '')}</p>
          </div>`;
        }).join('')
      : '<p class="muted">No companies match that — yet. Try an industry, a category, or a company name.</p>';
  }
  const body = `
  <div class="card">
    <div class="feed-head"><h2>🔍 Search Dealzoin</h2>
      <a class="btn btn-sm btn-outline" href="/companies">🏢 Companies directory</a></div>
    <form method="GET" action="/search" style="margin-top:10px">
      <div style="display:flex;gap:8px">
        <input type="text" name="q" value="${esc(q)}" placeholder="Search deals and companies…" style="margin-bottom:0">
        <button class="btn" type="submit">Search</button>
      </div>
      <div class="grid2" style="gap:10px;margin-top:10px">
        <div><label>Category</label><select name="category"><option value="">All categories</option>${optionsHtml(COMPANY_CATEGORIES, category)}</select></div>
        <div><label>Activity keyword</label><input type="text" name="activity" value="${esc(activity)}" placeholder="e.g. wholesale, logistics…" style="margin-bottom:0"></div>
      </div>
    </form>
  </div>
  ${hasFilters ? `<h2 class="sec-h">Deals matching your search</h2>${dealsHtml}
         <h2 class="sec-h">Companies matching your search</h2>${companiesHtml}` : ''}`;
  res.send(page('Search', body, req.user, req.query.msg, req.query.err));
});

// ============================= COMPANIES DIRECTORY (/companies) =============================
app.get('/companies', requireCompany, (req, res) => {
  const category = COMPANY_CATEGORIES.includes(req.query.category) ? req.query.category : '';
  const activity = String(req.query.activity || '').trim();
  const q = String(req.query.q || '').trim();
  let sql = `SELECT * FROM companies WHERE status = 'approved'`;
  const args = [];
  if (category) { sql += ' AND category = ?'; args.push(category); }
  if (activity) { sql += ' AND activity LIKE ?'; args.push('%' + activity.replace(/[%_]/g, '') + '%'); }
  if (q) { sql += ' AND (name LIKE ? OR description LIKE ? OR activity LIKE ?)'; const like = '%' + q.replace(/[%_]/g, '') + '%'; args.push(like, like, like); }
  sql += ' ORDER BY reputation DESC, name ASC LIMIT 100';
  const companies = db.prepare(sql).all(...args);

  const cards = companies.length ? companies.map((c, idx) => {
    const fc = followCounts(c.id);
    return `<div class="card" data-reveal style="--i:${Math.min(idx, 10)}">
      <div class="feed-head">
        <h3>${avatarHtml(c.name, c.avatar_media_id)}<a href="/company/${c.id}">${esc(c.name)}</a></h3>
        ${followButton(req.user, c.id)}
      </div>
      <p class="muted" style="margin-top:4px">${c.category ? `<span class="chip chip-category">${esc(c.category)}</span> ` : ''}${starsHtml(c.reputation, true)} · ${fc.followers} followers</p>
      ${c.activity ? `<p style="margin-top:6px">⚙️ ${esc(c.activity)}</p>` : ''}
      ${c.bio || c.description ? `<p class="muted" style="margin-top:6px">${esc((c.bio || c.description || '').slice(0, 160))}</p>` : ''}
    </div>`;
  }).join('') : `<div class="card"><p class="muted">No approved companies match those filters. <a href="/companies">Clear filters</a></p></div>`;

  const body = `
  <div class="feed-head" style="margin-bottom:4px">
    <div>
      <div class="kicker">Companies directory</div>
      <h1 style="font-size:1.75rem;margin-top:4px">🏢 The register</h1>
    </div>
    <a class="btn btn-sm btn-outline" href="/explore">🧭 Explorer</a>
  </div>
  <div class="card">
    <form method="GET" action="/companies">
      <div class="grid2" style="gap:10px">
        <div><label>Category</label><select name="category"><option value="">All categories</option>${optionsHtml(COMPANY_CATEGORIES, category)}</select></div>
        <div><label>Activity keyword</label><input type="text" name="activity" value="${esc(activity)}" placeholder="e.g. wholesale, logistics…"></div>
      </div>
      <div style="display:flex;gap:8px">
        <input type="text" name="q" value="${esc(q)}" placeholder="Search by name or description…" style="margin-bottom:0">
        <button class="btn" type="submit">Filter</button>
      </div>
    </form>
  </div>
  ${cards}`;
  res.send(page('Companies', body, req.user, req.query.msg, req.query.err, 'search'));
});

// ============================= DEALS EXPLORER (/explore) — algorithmic ranking =============================
app.get('/explore', requireCompany, (req, res) => {
  const myId = req.user.id;
  const names = companyNameMap();

  // Signals for the interest algorithm.
  const followCats = new Set(db.prepare(`
    SELECT c.category FROM follows f JOIN companies c ON c.id = f.followed_id
    WHERE f.follower_id = ? AND c.category != ''`).all(myId).map(r => r.category));
  const engageCats = new Set([
    ...db.prepare(`SELECT DISTINCT d.category FROM likes l JOIN deals d ON d.id = l.target_id
                   WHERE l.company_id = ? AND l.target_type = 'deal' AND d.category != ''`).all(myId),
    ...db.prepare(`SELECT DISTINCT d.category FROM comments cm JOIN deals d ON d.id = cm.target_id
                   WHERE cm.company_id = ? AND cm.target_type = 'deal' AND d.category != ''`).all(myId)
  ].map(r => r.category));
  const followedIds = new Set(db.prepare('SELECT followed_id FROM follows WHERE follower_id = ?').all(myId).map(r => r.followed_id));

  const openDeals = db.prepare(`SELECT * FROM deals WHERE status = 'open' ORDER BY created_at DESC LIMIT 200`).all();
  const nowMs = Date.now();
  const scored = openDeals.map(d => {
    const likes = db.prepare(`SELECT COUNT(*) AS n FROM likes WHERE target_type = 'deal' AND target_id = ?`).get(d.id).n;
    const comments = db.prepare(`SELECT COUNT(*) AS n FROM comments WHERE target_type = 'deal' AND target_id = ?`).get(d.id).n;
    const rep = companyReputation(d.company_id);
    const ageDays = Math.max(0, (nowMs - Date.parse(d.created_at || '')) / 86400000);
    let score = 0;
    const hints = [];
    if (d.category && followCats.has(d.category)) { score += 3; hints.push(`Because you follow ${d.category} companies`); }
    if (d.category && engageCats.has(d.category)) { score += 3; hints.push(`Because you engaged with ${d.category} deals`); }
    score += 2 * Math.log(1 + likes + comments);
    if (likes + comments >= 3) hints.push('Trending on the network');
    score += 1.5 * rep;
    if (rep >= 4) hints.push('High-reputation issuer');
    score += 3 * Math.exp(-ageDays / 7); // recency decay — newer ranks higher
    if (ageDays < 1) hints.push('Fresh on the wire');
    if (followedIds.has(d.company_id)) { score += 1; hints.push(`You follow ${names.get(d.company_id) || 'the issuer'}`); }
    return { deal: d, score, hints: hints.slice(0, 3) };
  }).sort((a, b) => b.score - a.score).slice(0, 50);

  const list = scored.length ? scored.map((s, idx) => {
    const hintsHtml = s.hints.length
      ? `<div class="hint-chips">${s.hints.map(h => `<span class="hint-chip">💡 ${esc(h)}</span>`).join('')}</div>` : '';
    return hintsHtml + feedCard(dealFeedItem(s.deal), req.user, names, idx);
  }).join('') : `<div class="card" style="text-align:center">
      <h3>No open deals right now</h3>
      <p class="muted" style="margin:8px 0 14px">Be the first to put an offer on the wire — or browse the register to find counterparties.</p>
      <a class="btn" href="/deals/new">Post a deal</a>
      <a class="btn btn-outline" href="/companies" style="margin-left:8px">Companies directory</a>
    </div>`;

  const body = `
  <div class="feed-head" style="margin-bottom:4px">
    <div>
      <div class="kicker">Deals explorer</div>
      <h1 style="font-size:1.75rem;margin-top:4px">🧭 Open deals, ranked for you</h1>
    </div>
    <a class="btn btn-sm btn-outline" href="/companies">🏢 Companies</a>
  </div>
  <p class="muted" style="margin-bottom:14px">Ranked by your interests — categories you follow and engage with, network traction, issuer reputation and freshness. Deal values stay private.</p>
  ${list}`;
  res.send(page('Explorer', body, req.user, req.query.msg, req.query.err, 'home'));
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
    ? deals.map((d, idx) => feedCard(dealFeedItem(d), req.user, names, idx)).join('')
    : '<div class="card"><p class="muted">No deals yet.</p></div>';

  // Research Agent intelligence card — shown only when at least one intel field is set.
  const hasIntel = !!(c.market_value || c.field || c.employees || c.trade_license);
  const intelCard = hasIntel ? `
  <div class="card intel-card">
    <div class="kicker">Researched by Dealzoin Research Agent</div>
    <h3 style="margin:6px 0 8px">📊 Company intelligence</h3>
    ${c.market_value ? `<div class="intel-row"><span class="k">Market value</span><span>${esc(c.market_value)}</span></div>` : ''}
    ${c.field ? `<div class="intel-row"><span class="k">Field</span><span style="text-align:right">${esc(c.field)}</span></div>` : ''}
    ${c.employees ? `<div class="intel-row"><span class="k">Employees</span><span>${esc(c.employees)}</span></div>` : ''}
    ${c.trade_license ? `<div class="intel-row"><span class="k">Trade license</span><span>🪪 ${esc(c.trade_license)}</span></div>` : ''}
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
/** Standard B2B terms clauses shown on every contract. Clause 10 reflects the live platform commission. */
function contractClauses() {
  return [
  '1. PARTIES. This agreement is entered into between the deal-owning company ("Provider") and the signing company ("Counterparty"), both registered members of the Dealzoin B2B network.',
  '2. SCOPE. The Provider agrees to deliver the products/services described in the deal terms, and the Counterparty agrees to the stated deal value and conditions.',
  '3. PAYMENT. Payment terms are net-30 from invoice date unless otherwise agreed in writing between the parties.',
  '4. CONFIDENTIALITY. Both parties agree to keep all non-public business information exchanged under this agreement strictly confidential for a period of three (3) years.',
  '5. WARRANTIES. Each party warrants that it is duly organized, validly existing, and that the individual executing this agreement is an authorized signatory.',
  '6. LIABILITY. Neither party shall be liable for indirect, incidental, or consequential damages arising from this agreement.',
  '7. TERMINATION. Either party may terminate this agreement with thirty (30) days written notice, subject to settlement of outstanding obligations.',
  '8. GOVERNING LAW. This agreement shall be governed by the laws of the jurisdiction in which the Provider is registered.',
  '9. ENTIRE AGREEMENT. This document constitutes the entire agreement between the parties and supersedes all prior discussions.',
  `10. PLATFORM FEE. A transparent platform commission of ${platformFeePct()}% of the stated deal value is payable to Dealzoin. This fee is disclosed to both parties — including the deal issuer — before signing and is separate from the deal value exchanged between the parties.`
  ];
}

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

// ----- Deal detail page: shows deal + contract status (visible to both parties and the admin) -----
function requireCompanyOrAdmin(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.redirect('/login?err=' + encodeURIComponent('Please sign in.'));
  req.user = user;
  next();
}
/** True when the user may view deal_documents for this deal: owner, a requesting company, the contracted buyer, or admin. */
function canViewDealDocs(user, deal) {
  if (!user || !deal) return false;
  if (user.isAdmin) return true;
  if (user.id === deal.company_id) return true;
  if (dealBuyerId(deal) === user.id) return true;
  return !!db.prepare(`SELECT 1 FROM deal_documents WHERE deal_id = ? AND company_id = ? AND kind = 'request' LIMIT 1`).get(deal.id, user.id);
}
/** True when the user may see the deal's value, amounts and contract terms: the deal owner, any company
 *  with a negotiation row on the deal (any state), the contracted party, or the admin. Everyone else
 *  sees "value shared privately" — values are only exchanged inside the negotiation. */
function canViewDealTerms(user, deal) {
  if (!user || !deal) return false;
  if (user.isAdmin) return true;
  if (user.id === deal.company_id) return true;
  if (dealBuyerId(deal) === user.id) return true;
  return !!db.prepare('SELECT 1 FROM negotiations WHERE deal_id = ? AND (buyer_id = ? OR seller_id = ?) LIMIT 1').get(deal.id, user.id, user.id);
}
/** The contract counterparty name: the finalized party once approved, else the signer on a live contract,
 *  else the buyer of the latest negotiation — never the viewer. "To be determined" pre-negotiation. */
function dealCounterpartyName(deal, names) {
  if (deal.contract_state === 'approved' && deal.contract_party) return deal.contract_party;
  const contract = latestContract(deal.id);
  if (isLiveContract(contract)) return names.get(contract.signer_company_id) || 'Unknown';
  const neg = db.prepare('SELECT buyer_id FROM negotiations WHERE deal_id = ? ORDER BY id DESC LIMIT 1').get(deal.id);
  if (neg) return names.get(neg.buyer_id) || 'Unknown';
  return 'To be determined via negotiation';
}

app.get('/deal/:id', requireCompanyOrAdmin, (req, res) => {
  const deal = getDealOr404(req, res);
  if (!deal) return;
  const owner = db.prepare('SELECT id, name, avatar_media_id FROM companies WHERE id = ?').get(deal.company_id);
  const contract = latestContract(deal.id);
  const names = companyNameMap();
  const isOwner = !req.user.isAdmin && req.user.id === deal.company_id;
  const buyerId = dealBuyerId(deal);
  const isBuyer = !req.user.isAdmin && buyerId === req.user.id;
  const isParty = isOwner || isBuyer || req.user.isAdmin;

  let contractHtml = '';
  if (contract && (req.user.id === contract.owner_company_id || req.user.id === contract.signer_company_id || req.user.isAdmin)) {
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

  // Deal value, currency amount and platform fee amounts are PRIVATE: only the owner, companies with a
  // negotiation on this deal, the contracted party and the admin see them. Everyone else gets a note.
  const canSeeValue = canViewDealTerms(req.user, deal);
  const dateLine = `${deal.time_period ? `<span class="muted">⏳ ${esc(deal.time_period)}</span><br>` : ''}<span class="muted">${esc(deal.created_at.slice(0, 16).replace('T', ' '))}</span>`;
  const dealValueHtml = deal.value
    ? (canSeeValue
      ? `<div style="text-align:right"><div class="deal-value">💰 ${esc(deal.value)} ${esc(deal.currency || 'USD')}</div>${feeLineHtml(deal)}${dateLine}</div>`
      : `<div style="text-align:right"><div class="private-value-note" style="white-space:normal">💰 Value shared privately — values are exchanged inside the negotiation</div>${dateLine}</div>`)
    : `<div style="text-align:right">${dateLine}</div>`;

  // Stage C entry point: non-owners express interest with an LOI (the negotiation pipeline leads to signing).
  const myDealNeg = (!req.user.isAdmin && req.user.id !== deal.company_id) ? activeNegotiationFor(deal.id, req.user.id) : null;
  const signBtn = !req.user.isAdmin && req.user.id !== deal.company_id && deal.contract_state !== 'approved'
    ? (myDealNeg
      ? `<a class="btn btn-green" href="/negotiation/${myDealNeg.id}">View negotiation ${statusBadge(myDealNeg.state)}</a>`
      : `<a class="btn btn-green" href="/deal/${deal.id}/loi">Express interest (LOI)</a>`) : '';

  // ---- Status & shipment tracking (CIF/CRF only; FOP has no platform tracking) ----
  const isFop = (deal.incoterm || 'CIF') === 'FOP';
  let statusHtml;
  if (isFop) {
    statusHtml = `<div class="card" data-reveal>
      <h3>📦 Deal status</h3>
      <p style="margin-top:8px">${dealStatusChip(deal)}</p>
      <p class="muted" style="margin-top:10px">FOP terms — shipment tracking is not available on the platform. The buyer arranges main carriage directly with the seller.</p>
    </div>`;
  } else {
    const tracking = (deal.tracking_number || deal.tracking_url) ? `
      <p style="margin-top:10px">🚚 <b>Tracking:</b> ${deal.tracking_number ? `<span class="deal-num">${esc(deal.tracking_number)}</span>` : ''}
        ${deal.tracking_url ? ` · <a href="${esc(deal.tracking_url)}" rel="noopener noreferrer nofollow">Track shipment →</a>` : ''}</p>` : '';
    const note = deal.status_note ? `<p class="muted" style="margin-top:8px">📝 ${esc(deal.status_note)}</p>` : '';
    const canUpdate = (isOwner || isBuyer || req.user.isAdmin) && deal.contract_state !== 'approved' && deal.status !== 'closed';
    const updateForm = canUpdate ? `
      <hr class="sep">
      <h4 style="margin-bottom:8px">Advance status</h4>
      <form method="POST" action="/deal/${deal.id}/status">
        <label>New status</label>
        <select name="status">${optionsHtml(DEAL_STATUSES, DEAL_STATUSES.includes(deal.status) ? deal.status : 'open')}</select>
        <div class="grid2" style="gap:10px">
          <div><label>Tracking number (optional)</label><input type="text" name="tracking_number" maxlength="120" value="${esc(deal.tracking_number || '')}"></div>
          <div><label>Tracking URL (optional, https://)</label><input type="url" name="tracking_url" maxlength="300" value="${esc(deal.tracking_url || '')}" placeholder="https://carrier.example/track/…"></div>
        </div>
        <label>Note (optional)</label><input type="text" name="status_note" maxlength="300" placeholder="e.g. Loaded on vessel, ETA 12 days">
        <button class="btn btn-sm" type="submit">Update status</button>
        <p class="muted" style="margin-top:6px">The other party is notified and the update is audit-logged.</p>
      </form>` : '';
    statusHtml = `<div class="card" data-reveal>
      <h3>📦 Deal status <span class="muted" style="font-weight:400">· ${esc(deal.incoterm || 'CIF')} terms</span></h3>
      ${stepperHtml(deal)}
      ${tracking}${note}
      ${updateForm}
    </div>`;
  }

  // ---- Product proof (sell deals) ----
  let proofHtml = '';
  if ((deal.deal_type || 'sell') === 'sell' && (deal.product_proof || deal.product_proof_doc_id)) {
    let inner = '';
    if (deal.product_proof_doc_id) {
      const doc = db.prepare('SELECT id, filename, authenticity_status, authenticity_notes FROM documents WHERE id = ?').get(deal.product_proof_doc_id);
      if (doc) {
        const dl = (isOwner || req.user.isAdmin) ? ` <a href="/documents/${doc.id}">Download</a>` : '';
        inner += `<p style="margin-top:8px">📄 Product proof on file (${esc(doc.filename || 'proof.pdf')}) ${authenticityBadge(doc.authenticity_status, (isOwner || req.user.isAdmin) ? doc.authenticity_notes : '')}${dl}</p>`;
      }
    }
    if (deal.product_proof) inner += `<p class="muted" style="margin-top:8px;white-space:pre-wrap">🧾 ${esc(deal.product_proof)}</p>`;
    if (inner) proofHtml = `<div class="card" data-reveal><h3>🔍 Product proof</h3>${inner}</div>`;
  }

  // ---- Request more documents (buyer → seller) + deal document exchange ----
  const docRequests = db.prepare(`SELECT * FROM deal_documents WHERE deal_id = ? AND kind = 'request' ORDER BY id DESC LIMIT 50`).all(deal.id);
  const docUploads = db.prepare(`SELECT * FROM deal_documents WHERE deal_id = ? AND kind = 'document' ORDER BY id DESC LIMIT 50`).all(deal.id);
  let docsHtml = '';
  if (isOwner) {
    const reqList = docRequests.length ? docRequests.map(r => `
      <div style="padding:8px 0;border-top:1px dashed var(--border-soft)">
        📩 <a href="/company/${r.company_id}"><b>${esc(names.get(r.company_id) || 'Unknown')}</b></a> requested:
        <span style="white-space:pre-wrap">${esc(r.note)}</span><br>
        <span class="muted">${esc(r.created_at.slice(0, 16).replace('T', ' '))} UTC</span>
      </div>`).join('') : '<p class="muted">No document requests yet.</p>';
    docsHtml += `<div class="card" data-reveal>
      <h3>📩 Document requests</h3>
      ${reqList}
      <hr class="sep">
      <h4 style="margin-bottom:8px">Upload a response document</h4>
      <form method="POST" action="/deal/${deal.id}/documents" enctype="multipart/form-data">
        <label>Document (PDF or image, max 15 MB)</label>
        <label class="file-btn"><span class="file-btn-text" data-default="📎 Attach PDF or image">📎 Attach PDF or image</span>
          <input type="file" class="file-input" name="doc" accept="application/pdf,.pdf,image/jpeg,image/png,image/gif,image/webp" required></label>
        <label>Note for the requester (optional)</label><input type="text" name="note" maxlength="300" placeholder="e.g. Certificate of origin for the full batch">
        <button class="btn btn-sm" type="submit">Upload &amp; share with requesters</button>
        <p class="muted" style="margin-top:6px">Visible to you, requesting/contracted parties and the admin. Screened by the Document Authenticity Agent.</p>
      </form>
    </div>`;
  } else if (!req.user.isAdmin) {
    docsHtml += `<div class="card" data-reveal>
      <h3>📩 Request documents</h3>
      <p class="muted" style="margin-bottom:10px">Need certificates, licenses or proof from the ${(deal.deal_type || 'sell') === 'sell' ? 'seller' : 'buyer'}? Send a request — they are notified instantly.</p>
      <form method="POST" action="/deal/${deal.id}/request-docs">
        <label>What do you need?</label>
        <textarea name="request" rows="3" required maxlength="500" placeholder="e.g. Certificate of origin, lab analysis, export license…"></textarea>
        <button class="btn btn-sm" type="submit">Send document request</button>
      </form>
    </div>`;
  }
  if (canViewDealDocs(req.user, deal) && (docUploads.length || (docRequests.length && !isOwner))) {
    const myReqs = isOwner ? '' : docRequests.filter(r => r.company_id === req.user.id).map(r => `
      <div style="padding:6px 0;border-top:1px dashed var(--border-soft)">📩 You requested: <span style="white-space:pre-wrap">${esc(r.note)}</span>
        <span class="muted">· ${esc(r.created_at.slice(0, 16).replace('T', ' '))} UTC</span></div>`).join('');
    const upList = docUploads.map(d => `
      <div style="padding:6px 0;border-top:1px dashed var(--border-soft)">📄 <a href="/deal-docs/${d.id}/download"><b>${esc(d.filename || 'document')}</b></a>
        ${d.note ? `<br><span class="muted">${esc(d.note)}</span>` : ''}
        <br><span class="muted">${(d.data.length / 1024).toFixed(1)} KB · ${esc(d.created_at.slice(0, 16).replace('T', ' '))} UTC</span></div>`).join('');
    docsHtml += `<div class="card" data-reveal>
      <h3>🗂️ Deal documents</h3>
      ${myReqs}
      ${upList || '<p class="muted">No response documents shared yet.</p>'}
    </div>`;
  }

  const body = `
  <div class="card card-deal">
    <div class="feed-head"><h2>${esc(deal.title)}</h2>
      ${dealValueHtml}</div>
    <div style="margin:8px 0 4px">
      ${deal.deal_number ? `<span class="deal-num" style="font-size:1rem">Deal № ${esc(deal.deal_number)}</span> · ` : ''}
      ${dealTypeChips(deal)}
      <span class="chip" title="${esc(INCOTERM_EXPLAINERS[deal.incoterm] || INCOTERM_EXPLAINERS.CIF)}">⚓ ${esc(deal.incoterm || 'CIF')}</span>
      ${deal.origin ? ` <span class="chip">📍 ${esc(deal.origin)}</span>` : ''}
    </div>
    <p class="muted">by ${avatarHtml(owner ? owner.name : '?', owner ? owner.avatar_media_id : null)}<a href="/company/${deal.company_id}"><b>${esc(owner ? owner.name : 'Unknown')}</b></a> ${starsHtml(companyReputation(deal.company_id), true)}</p>
    <p style="margin-top:12px;white-space:pre-wrap">${esc(deal.description)}</p>
    ${deal.contract_state === 'approved' ? `<div style="margin-top:12px"><span class="badge badge-contract">Contract approved ✓${deal.contract_party ? ' (with ' + esc(deal.contract_party) + ')' : ''}</span></div>` : ''}
    ${mediaHtml(deal.media_id)}
    <div class="feed-actions">${signBtn}</div>
  </div>
  ${statusHtml}
  ${proofHtml}
  ${contractHtml}
  ${docsHtml}`;
  res.send(page(deal.title, body, req.user, req.query.msg, req.query.err));
});

// ----- POST /deal/:id/status — owner, contracted buyer or admin advances the pipeline (CIF/CRF only) -----
app.post('/deal/:id/status', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.redirect('/login?err=' + encodeURIComponent('Please sign in.'));
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!deal) return res.redirect(user.isAdmin ? '/admin/dashboard' : '/timeline?err=' + encodeURIComponent('Deal not found.'));
  const back = user.isAdmin ? '/admin/dashboard' : `/deal/${deal.id}`;
  const isOwner = !user.isAdmin && user.id === deal.company_id;
  const buyerId = dealBuyerId(deal);
  const isBuyer = !user.isAdmin && buyerId === user.id;
  if (!user.isAdmin && !isOwner && !isBuyer) {
    audit('DEAL AGENT', 'status update guard', 'fail', `${user.name} attempted to update status on deal #${deal.id} without being a party`);
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Parties only</h2><p class="muted">Only the deal owner, the contracted buyer and the admin can advance the deal status.</p></div>', user));
  }
  if ((deal.incoterm || 'CIF') === 'FOP') {
    return res.redirect(back + '?err=' + encodeURIComponent('FOP terms — shipment tracking is not available on the platform.'));
  }
  if (deal.contract_state === 'approved' || deal.status === 'closed') {
    return res.redirect(back + '?err=' + encodeURIComponent('This deal is closed — the contract is finalized.'));
  }
  const newStatus = String(req.body.status || '');
  if (!DEAL_STATUSES.includes(newStatus)) {
    return res.redirect(back + '?err=' + encodeURIComponent('Invalid status. Choose one of: ' + DEAL_STATUSES.join(', ') + '.'));
  }
  const note = String(req.body.status_note || '').trim().slice(0, 300);
  let trackingNumber = String(req.body.tracking_number || '').trim().slice(0, 120);
  let trackingUrl = String(req.body.tracking_url || '').trim().slice(0, 300);
  if (trackingUrl && !/^https:\/\//i.test(trackingUrl)) {
    return res.redirect(back + '?err=' + encodeURIComponent('Tracking URL must start with https://'));
  }
  if (!trackingNumber) trackingNumber = deal.tracking_number || '';
  if (!trackingUrl) trackingUrl = deal.tracking_url || '';
  db.prepare('UPDATE deals SET status = ?, status_note = ?, tracking_number = ?, tracking_url = ? WHERE id = ?')
    .run(newStatus, note, trackingNumber, trackingUrl, deal.id);
  audit('DEAL AGENT', 'status update', 'pass', `${user.isAdmin ? 'Admin' : user.name} advanced deal ${deal.deal_number || '#' + deal.id} to "${newStatus}"${note ? ` — note: ${note}` : ''}${trackingNumber ? ` — tracking ${trackingNumber}` : ''}`);
  // Notify the other party (admin updates notify both parties).
  const label = `${user.isAdmin ? 'The platform' : user.name} updated deal ${deal.deal_number || '#' + deal.id} ("${deal.title}") to "${newStatus.toUpperCase()}"${note ? ` — ${note}` : ''}`;
  if (user.isAdmin || isBuyer) notify(deal.company_id, 'deal_status', label, `/deal/${deal.id}`);
  if (user.isAdmin || isOwner) { if (buyerId) notify(buyerId, 'deal_status', label, `/deal/${deal.id}`); }
  res.redirect(back + '?msg=' + encodeURIComponent(`Deal status updated to "${newStatus}".`));
});

// ----- POST /deal/:id/request-docs — a non-owner company asks the owner for more documents -----
app.post('/deal/:id/request-docs', requireCompany, (req, res) => {
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!deal) return res.redirect('/timeline?err=' + encodeURIComponent('Deal not found.'));
  if (deal.company_id === req.user.id) {
    return res.redirect(`/deal/${deal.id}?err=` + encodeURIComponent('This is your own deal — document requests come from counterparties.'));
  }
  const text = String(req.body.request || '').trim().slice(0, 500);
  if (!text) return res.redirect(`/deal/${deal.id}?err=` + encodeURIComponent('Please describe which documents you need.'));
  db.prepare(`INSERT INTO deal_documents (deal_id, company_id, kind, note, created_at) VALUES (?,?, 'request', ?, ?)`)
    .run(deal.id, req.user.id, text, now());
  audit('DEAL AGENT', 'document request', 'pass', `${req.user.name} requested documents on deal ${deal.deal_number || '#' + deal.id}: "${text.slice(0, 80)}"`);
  notify(deal.company_id, 'doc_request', `${req.user.name} requested documents on your deal "${deal.title}": "${text.slice(0, 120)}". Respond on the deal page.`, `/deal/${deal.id}`);
  res.redirect(`/deal/${deal.id}?msg=` + encodeURIComponent('Document request sent to the deal owner.'));
});

// ----- POST /deal/:id/documents — the owner uploads a response document (PDF or image) -----
app.post('/deal/:id/documents', requireCompany, dealDocUploadMw, async (req, res) => {
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!deal) return res.redirect('/timeline?err=' + encodeURIComponent('Deal not found.'));
  if (deal.company_id !== req.user.id) {
    audit('DEAL AGENT', 'document upload guard', 'fail', `${req.user.name} attempted to upload a response document to deal #${deal.id} without owning it`);
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Only the deal owner can upload response documents.</h2></div>', req.user));
  }
  const f = req.file;
  if (!f) return res.redirect(`/deal/${deal.id}?err=` + encodeURIComponent('Choose a PDF or image to upload.'));
  const isPdf = isPdfBuffer(f.buffer);
  if (!isPdf && !isImageBuffer(f.buffer)) {
    return res.redirect(`/deal/${deal.id}?err=` + encodeURIComponent('Upload rejected: the file content is not a real PDF or image.'));
  }
  // Document Authenticity Agent — light pass (magic bytes, size window, PDF parseability, sha256).
  const notes = [];
  const size = f.buffer.length;
  if (size < 200) notes.push(`suspiciously small file (${size} bytes)`);
  if (size > DOC_MAX_BYTES) notes.push(`file too large (${size} bytes)`);
  if (isPdf) {
    const parsed = await extractPdfText(f.buffer);
    if (!parsed) notes.push('PDF could not be parsed (corrupt or malformed)');
  }
  const sha256 = crypto.createHash('sha256').update(f.buffer).digest('hex');
  const dup = db.prepare(`SELECT id FROM deal_documents WHERE sha256 = ? AND kind = 'document' LIMIT 1`).get(sha256);
  if (dup) notes.push('identical file already shared on the platform');
  audit('DOCUMENT AGENT', 'deal document check', notes.length ? 'flag' : 'pass',
    `"${f.originalname || 'file'}" on deal ${deal.deal_number || '#' + deal.id} by ${req.user.name}: ${notes.length ? notes.join('; ') : 'light pass OK'}`);

  const note = String(req.body.note || '').trim().slice(0, 300);
  const mime = isPdf ? 'application/pdf' : String(f.mimetype || 'image/jpeg').toLowerCase();
  db.prepare(`INSERT INTO deal_documents (deal_id, company_id, kind, note, mime, filename, data, sha256, created_at)
              VALUES (?,?, 'document', ?,?,?,?,?,?)`)
    .run(deal.id, req.user.id, note, mime, String(f.originalname || 'document').slice(0, 200), f.buffer, sha256, now());
  // Notify every requesting party + the contracted buyer.
  const recipients = new Set(db.prepare(`SELECT DISTINCT company_id FROM deal_documents WHERE deal_id = ? AND kind = 'request'`).all(deal.id).map(r => r.company_id));
  const buyerId = dealBuyerId(deal);
  if (buyerId) recipients.add(buyerId);
  recipients.delete(req.user.id);
  for (const cid of recipients) {
    notify(cid, 'deal_document', `${req.user.name} shared a document on deal "${deal.title}"${note ? `: "${note.slice(0, 100)}"` : ''}. Open the deal page to download it.`, `/deal/${deal.id}`);
  }
  res.redirect(`/deal/${deal.id}?msg=` + encodeURIComponent('Document shared with the requesting parties.'));
});

// ----- GET /deal-docs/:id/download — owner, requesting/contracted parties, admin only -----
app.get('/deal-docs/:id/download', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.redirect('/login?err=' + encodeURIComponent('Please sign in.'));
  const doc = db.prepare(`SELECT * FROM deal_documents WHERE id = ? AND kind = 'document'`).get(parseInt(req.params.id, 10));
  if (!doc) return res.status(404).send(page('Not found', '<div class="card"><h2>Document not found</h2></div>', user));
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(doc.deal_id);
  if (!deal || !canViewDealDocs(user, deal)) {
    audit('DEAL AGENT', 'deal document access', 'fail', `Unauthorized download attempt on deal document #${doc.id} by ${user.isAdmin ? 'admin?' : user.name}`);
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Private deal document</h2><p class="muted">Only the deal owner, requesting/contracted parties and the admin can download this document.</p></div>', user));
  }
  audit('DEAL AGENT', 'deal document access', 'pass', `Deal document #${doc.id} (deal ${deal.deal_number || '#' + deal.id}) downloaded by ${user.isAdmin ? 'admin' : user.name}`);
  res.setHeader('Content-Type', doc.mime || 'application/octet-stream');
  res.setHeader('Content-Length', doc.data.length);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', `attachment; filename="${String(doc.filename || 'document').replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  res.send(doc.data);
});

// ----- Contract terms page (party-guarded: values & terms stay inside the negotiation circle) -----
app.get('/deal/:id/contract', requireCompanyOrAdmin, (req, res) => {
  const deal = getDealOr404(req, res);
  if (!deal) return;
  if (!canViewDealTerms(req.user, deal)) {
    audit('CONTRACT AGENT', 'contract page access', 'fail', `Unauthorized contract view attempt on deal ${deal.deal_number || '#' + deal.id} by ${req.user.name}`);
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Private</h2><p class="muted">Private — values and terms are shared only inside a negotiation.</p></div>', req.user));
  }
  const owner = db.prepare('SELECT id, name FROM companies WHERE id = ?').get(deal.company_id);
  const isOwn = !req.user.isAdmin && deal.company_id === req.user.id;
  const contract = latestContract(deal.id);
  const names = companyNameMap();
  const dealNum = deal.deal_number || String(deal.id);
  const counterpartyName = dealCounterpartyName(deal, names);

  const clauses = contractClauses().map(c => `<p style="margin-bottom:10px">${esc(c)}</p>`).join('');
  const existing = isLiveContract(contract)
    ? `<p class="muted" style="margin-top:10px">A contract for this deal is currently <b>${esc(contract.status.replace(/_/g, ' '))}</b>.</p>` : '';
  const finalizedNote = deal.contract_state === 'approved'
    ? `<p style="margin-top:10px"><span class="badge badge-contract">Contract approved ✓${deal.contract_party ? ' (with ' + esc(deal.contract_party) + ')' : ''}</span></p>` : '';

  const actions = req.user.isAdmin
    ? `<p class="muted" style="margin-top:16px">Admin view — contract actions are performed by the parties.</p>`
    : isOwn
    ? `<p class="muted" style="margin-top:16px">This is your own deal — you cannot sign a contract with yourself.</p>`
    : (() => {
        const myNeg2 = activeNegotiationFor(deal.id, req.user.id);
        const signStep = myNeg2 && ['PO_SENT', 'SIGNING'].includes(myNeg2.state)
          ? `<a class="btn btn-green" href="/deal/${deal.id}/sign">Proceed with signing →</a>`
          : myNeg2
            ? `<a class="btn btn-green" href="/negotiation/${myNeg2.id}">View negotiation ${statusBadge(myNeg2.state)}</a>`
            : `<a class="btn btn-green" href="/deal/${deal.id}/loi">Express interest (LOI) →</a>`;
        return `<div class="feed-actions" style="margin-top:18px">
         <a class="btn btn-outline" href="/deal/${deal.id}/contract/download">Download contract document</a>
         ${signStep}
       </div>`;
      })();

  const body = `
  <div class="card">
    <h2>B2B Contract — ${esc(deal.title)}</h2>
    <p class="muted">Generated ${esc(now().slice(0, 10))} · Deal № ${esc(dealNum)}</p>
    <hr class="sep">
    <p><b>Provider:</b> ${esc(owner ? owner.name : 'Unknown')}</p>
    <p><b>Counterparty:</b> ${esc(counterpartyName)}</p>
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

// ----- Download contract as a Word-compatible document (same party guard as the contract page) -----
app.get('/deal/:id/contract/download', requireCompanyOrAdmin, (req, res) => {
  const deal = getDealOr404(req, res);
  if (!deal) return;
  if (!canViewDealTerms(req.user, deal)) {
    audit('CONTRACT AGENT', 'contract download access', 'fail', `Unauthorized contract download attempt on deal ${deal.deal_number || '#' + deal.id} by ${req.user.name}`);
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Private</h2><p class="muted">Private — values and terms are shared only inside a negotiation.</p></div>', req.user));
  }
  const owner = db.prepare('SELECT id, name FROM companies WHERE id = ?').get(deal.company_id);
  const names = companyNameMap();
  const dealNum = deal.deal_number || String(deal.id);
  const counterpartyName = dealCounterpartyName(deal, names);
  const clauses = contractClauses().map(c => `<p>${esc(c)}</p>`).join('');
  const doc = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
<head><meta charset="utf-8"><title>Contract — Deal № ${esc(dealNum)}</title></head>
<body style="font-family:Calibri,Arial,sans-serif">
  <h1>B2B Contract — Deal № ${esc(dealNum)}</h1>
  <h2>${esc(deal.title)}</h2>
  <p><b>Provider:</b> ${esc(owner ? owner.name : 'Unknown')}<br>
     <b>Counterparty:</b> ${esc(counterpartyName)}<br>
     ${deal.value ? `<b>Deal value:</b> ${esc(deal.value)} ${esc(deal.currency || 'USD')}<br>` : ''}
     <b>${esc(feeLineText(deal))}</b><br>
     <b>Generated:</b> ${esc(now())}</p>
  <h3>Deal terms</h3><p>${esc(deal.description)}</p>
  <h3>Standard B2B terms</h3>${clauses}
  <p>__________________________&nbsp;&nbsp;&nbsp;__________________________<br>
  Provider signature&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Counterparty signature</p>
</body></html>`;
  audit('CONTRACT AGENT', 'contract download access', 'pass', `Contract for deal ${dealNum} downloaded by ${req.user.isAdmin ? 'admin' : req.user.name}`);
  res.setHeader('Content-Type', 'application/msword');
  res.setHeader('Content-Disposition', `attachment; filename="contract-${String(dealNum).replace(/[^A-Za-z0-9._-]/g, '_')}.doc"`);
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
  // Stage C: signing is only reachable through the negotiation pipeline (buyer, after the PO is issued).
  const myNeg = (!user.isAdmin && user.id && user.id !== deal.company_id)
    ? db.prepare(`SELECT * FROM negotiations WHERE deal_id = ? AND buyer_id = ? AND state IN ('PO_SENT','SIGNING') ORDER BY id DESC LIMIT 1`).get(deal.id, user.id)
    : null;
  const canSign = !user.isAdmin && !isOwn && !finalized && !!myNeg;
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
  } else if (!canSign) {
    signPanel = `<p class="muted" style="margin-top:14px">Deal contracts on Dealzoin start with a <b>Letter of Intent</b> and a negotiation with the seller.
      Once the seller issues a Purchase Order, you sign right here.</p>
      <div class="feed-actions"><a class="btn btn-green" href="/deal/${deal.id}/loi">Express interest (LOI) →</a></div>`;
  } else {
    signPanel = `
    <p class="muted" style="margin-top:10px">Negotiation #${myNeg.id} — agreed value
      <span class="deal-value" style="font-size:1rem">${esc(myNeg.offer_value)} ${esc(myNeg.offer_currency || 'USD')}</span>
      · <a href="/negotiation/${myNeg.id}/po.doc">Download PO (.doc)</a> · <a href="/negotiation/${myNeg.id}">back to negotiation</a></p>
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
  // Stage C: a signature requires an active negotiation at the PO stage (buyer only).
  const neg = db.prepare(`SELECT * FROM negotiations WHERE deal_id = ? AND buyer_id = ? AND state IN ('PO_SENT','SIGNING') ORDER BY id DESC LIMIT 1`).get(deal.id, req.user.id);
  if (!neg) {
    audit('AUTHENTICATION AGENT', 'signing pipeline guard', 'fail', `${req.user.name} attempted to sign deal #${deal.id} without a Purchase Order (no active negotiation)`);
    return res.redirect(`/deal/${deal.id}?err=` + encodeURIComponent('Contracts start with a Letter of Intent — complete the negotiation until the seller issues the Purchase Order.'));
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
  // Pipeline: PO_SENT → SIGNING once the buyer starts the signing ritual.
  if (neg.state === 'PO_SENT') {
    negSetState(neg.id, 'SIGNING');
    negEvent(neg.id, req.user.id, 'signing');
  }

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
  // Stage C: re-check the negotiation pipeline at commit time.
  const neg = db.prepare(`SELECT * FROM negotiations WHERE deal_id = ? AND buyer_id = ? AND state IN ('PO_SENT','SIGNING') ORDER BY id DESC LIMIT 1`).get(deal.id, req.user.id);
  if (!neg) {
    db.prepare('DELETE FROM verification_codes WHERE id = ?').run(ctx.row.id);
    return res.redirect(`/deal/${deal.id}?err=` + encodeURIComponent('No active negotiation at the signing stage. Start with a Letter of Intent.'));
  }

  db.prepare('DELETE FROM verification_codes WHERE id = ?').run(ctx.row.id);
  const ts = now();
  // State machine stage 1: the contract first awaits the DEAL OWNER's approval.
  db.prepare(`INSERT INTO contracts (deal_id, signer_company_id, owner_company_id, status, signed_at, created_at, negotiation_id)
              VALUES (?,?,?, 'pending_owner', ?, ?, ?)`)
    .run(deal.id, req.user.id, deal.company_id, ts, ts, neg.id);
  // Pipeline: SIGNING → SIGNED — the seller (owner) approves next, inside the negotiation thread.
  negSetState(neg.id, 'SIGNED');
  negEvent(neg.id, req.user.id, 'signed', { note: 'Signed in the vault signing room (password + OTP verified)' });
  res.setHeader('Set-Cookie', 'dz_sign=; HttpOnly; Path=/; Max-Age=0');
  audit('AUTHENTICATION AGENT', 'signing OTP verify', 'pass', `Signing code verified for ${req.user.name} (deal #${deal.id})`);
  audit('AUTHENTICATION AGENT', 'contract signed', 'pass', `${req.user.name} signed deal #${deal.id} at ${ts} (negotiation #${neg.id}) — pending seller approval`);
  notify(deal.company_id, 'contract_signed', `${req.user.name} signed the contract for your deal "${deal.title}" (negotiation #${neg.id}). Review and approve it.`, `/negotiation/${neg.id}`);

  res.redirect(`/negotiation/${neg.id}?msg=` + encodeURIComponent("Contract signed! It now awaits the seller's approval."));
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
    WHERE ct.owner_company_id = ? AND ct.status = 'pending_owner' AND ct.negotiation_id IS NULL
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

  // ---- Stage C: negotiations hub — all my negotiations as buyer or seller, newest first ----
  const myNegs = db.prepare(`
    SELECT n.*, d.title AS deal_title, d.deal_number
    FROM negotiations n LEFT JOIN deals d ON d.id = n.deal_id
    WHERE n.buyer_id = ? OR n.seller_id = ?
    ORDER BY n.updated_at DESC LIMIT 100`).all(myId, myId);
  const negAction = (n) => {
    const open = `/negotiation/${n.id}`;
    if (n.state === 'LOI_SENT') return n.seller_id === myId ? `<a class="btn btn-sm" href="${open}">Send offer</a>` : `<a class="btn btn-sm btn-outline" href="${open}">Open</a>`;
    if (n.state === 'OFFER_SENT') return n.buyer_id === myId ? `<a class="btn btn-sm btn-green" href="${open}">Approve / counter</a>` : `<a class="btn btn-sm btn-outline" href="${open}">Open</a>`;
    if (n.state === 'COUNTER_SENT') return n.seller_id === myId ? `<a class="btn btn-sm" href="${open}">Re-offer / decline</a>` : `<a class="btn btn-sm btn-outline" href="${open}">Open</a>`;
    if (n.state === 'BUYER_APPROVED') return n.seller_id === myId ? `<a class="btn btn-sm btn-green" href="${open}">Approve &amp; send PO</a>` : `<a class="btn btn-sm btn-outline" href="${open}">Open</a>`;
    if (n.state === 'PO_SENT' || n.state === 'SIGNING') return n.buyer_id === myId ? `<a class="btn btn-sm btn-green" href="${open}">Proceed to signing</a>` : `<a class="btn btn-sm btn-outline" href="${open}">Open</a>`;
    if (n.state === 'SIGNED') return n.seller_id === myId ? `<a class="btn btn-sm btn-green" href="${open}">Approve signature</a>` : `<a class="btn btn-sm btn-outline" href="${open}">Open</a>`;
    if (n.state === 'OWNER_APPROVED' || n.state === 'SPLIT_NEGO') return `<a class="btn btn-sm" href="${open}">Commission split</a>`;
    return `<a class="btn btn-sm btn-outline" href="${open}">Open</a>`;
  };
  const negsHtml = myNegs.length ? myNegs.map((n, i) => {
    const role = n.buyer_id === myId ? 'buyer' : 'seller';
    const otherName = names.get(role === 'buyer' ? n.seller_id : n.buyer_id) || 'Unknown';
    return `<div class="card" data-reveal style="--i:${Math.min(i, 10)}">
      <div class="feed-head">
        <h3>🤝 <a href="/negotiation/${n.id}">${esc(n.deal_title || 'Deal #' + n.deal_id)}</a></h3>
        ${statusBadge(n.state)}
      </div>
      <p class="muted" style="margin-top:6px">You are the <b>${role}</b> · with <a href="/company/${role === 'buyer' ? n.seller_id : n.buyer_id}"><b>${esc(otherName)}</b></a>
        · Deal № ${esc(n.deal_number || String(n.deal_id))} · round ${n.round}
        ${n.offer_value ? ` · offer <b>${esc(n.offer_value)} ${esc(n.offer_currency || 'USD')}</b>` : ''}
        · updated ${esc(n.updated_at.slice(0, 16).replace('T', ' '))} UTC</p>
      <div class="feed-actions">${negAction(n)}</div>
    </div>`;
  }).join('') : '<div class="card"><p class="muted">No negotiations yet — express interest with an LOI from any deal page.</p></div>';

  const body = `
  <h2 class="sec-h" style="margin-top:0;margin-bottom:14px">📥 Deal inbox — your decisions</h2>
  <h3 class="sec-h">🤝 Negotiations</h3>
  ${negsHtml}
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
  // Negotiation-linked contracts are decided inside the negotiation thread.
  if (ct.negotiation_id) return res.redirect(`/negotiation/${ct.negotiation_id}`);
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
  if (ct.negotiation_id) return res.redirect(`/negotiation/${ct.negotiation_id}`);
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

// ============================= NEGOTIATION PIPELINE (Stage C) =============================
// State machine: LOI_SENT → OFFER_SENT ⇄ COUNTER_SENT (unlimited rounds) → BUYER_APPROVED
//   → PO_SENT → SIGNING → SIGNED → OWNER_APPROVED → SPLIT_NEGO → PENDING_ADMIN → DONE / REJECTED.
const NEG_STATES = ['LOI_SENT', 'OFFER_SENT', 'COUNTER_SENT', 'BUYER_APPROVED', 'PO_SENT', 'SIGNING',
  'SIGNED', 'OWNER_APPROVED', 'SPLIT_NEGO', 'PENDING_ADMIN', 'DONE', 'REJECTED'];
const NEG_OPEN_STATES = NEG_STATES.filter(s => s !== 'DONE' && s !== 'REJECTED');
const NEG_SPLITS = { '50-50': '50 / 50 shared', 'buyer-pays': 'Buyer pays 100%', 'seller-pays': 'Seller pays 100%' };

/** Load a negotiation row by id. */
function getNegotiation(id) {
  return db.prepare('SELECT * FROM negotiations WHERE id = ?').get(parseInt(id, 10));
}
/** True when the user is the buyer, the seller, or an admin. */
function isNegParty(user, neg) {
  if (!user || !neg) return false;
  return user.isAdmin || user.id === neg.buyer_id || user.id === neg.seller_id;
}
/** Append an event to the negotiation timeline (drives the rounds view). */
function negEvent(negId, actorId, kind, fields) {
  const f = fields || {};
  db.prepare(`INSERT INTO negotiation_events (negotiation_id, actor_id, kind, value, currency, terms, note, created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(negId, actorId || null, kind, f.value || '', f.currency || '', String(f.terms || '').slice(0, 2000), String(f.note || '').slice(0, 500), now());
}
/** Move a negotiation to a new state (updated_at bumped). */
function negSetState(negId, state) {
  db.prepare('UPDATE negotiations SET state = ?, updated_at = ? WHERE id = ?').run(state, now(), negId);
}
/** The buyer's currently active negotiation on a deal (any non-terminal state), if any. */
function activeNegotiationFor(dealId, buyerId) {
  return db.prepare(`SELECT * FROM negotiations WHERE deal_id = ? AND buyer_id = ?
                     AND state NOT IN ('DONE','REJECTED') ORDER BY id DESC LIMIT 1`).get(dealId, buyerId);
}
/** Commission math for a negotiation: total platform fee + per-party share per the agreed split. */
function negFeeBreakdown(neg) {
  const pct = platformFeePct();
  const num = parseDealValue(neg.offer_value);
  const cur = neg.offer_currency || 'USD';
  if (!isFinite(num) || num <= 0) return { pct, cur, fee: NaN, buyer: NaN, seller: NaN };
  const fee = num * pct / 100;
  const split = NEG_SPLITS[neg.commission_split] ? neg.commission_split : '50-50';
  const buyer = split === 'buyer-pays' ? fee : (split === 'seller-pays' ? 0 : fee / 2);
  return { pct, cur, fee, buyer, seller: fee - buyer, split };
}
/** Human + HTML row describing the split amounts (values stay between parties + admin). */
function negFeeHtml(neg) {
  const f = negFeeBreakdown(neg);
  const label = NEG_SPLITS[neg.commission_split] || NEG_SPLITS['50-50'];
  if (!isFinite(f.fee)) {
    return `<p class="muted">Platform commission: ${f.pct}% of the agreed value — split: <b>${esc(label)}</b></p>`;
  }
  return `<p>Platform commission: <b>${f.pct}%</b> = <span class="deal-value" style="font-size:1rem">${fmtAmount(f.fee)} ${esc(f.cur)}</span>
    — split: <b>${esc(label)}</b><br>
    <span class="muted">Buyer owes ${fmtAmount(f.buyer)} ${esc(f.cur)} · Seller owes ${fmtAmount(f.seller)} ${esc(f.cur)}</span></p>`;
}
/** Label for a negotiation timeline event. */
function negEventLabel(kind) {
  return {
    loi: '📨 Letter of Intent', offer: '📤 Offer', counter: '💱 Counter offer',
    approve: '✅ Offer approved', decline: '⛔ Negotiation declined', po: '📄 Purchase Order issued',
    signing: '✍️ Signing started', signed: '🖊️ Contract signed', owner_approved: '✅ Signature approved by seller',
    split: '⚖️ Commission split proposed', split_accept: '🤝 Commission split accepted',
    admin_approved: '🏛️ Final admin approval', admin_rejected: '🏛️ Admin rejected'
  }[kind] || kind;
}
/** Timeline-style rounds list (staggered reveal). */
function negTimelineHtml(negId, names) {
  const events = db.prepare('SELECT * FROM negotiation_events WHERE negotiation_id = ? ORDER BY id ASC LIMIT 200').all(negId);
  if (!events.length) return '<p class="muted">No events yet.</p>';
  return `<div class="tl">${events.map((e, i) => {
    const actor = e.actor_id ? (names.get(e.actor_id) || 'Unknown') : 'Dealzoin';
    const valLine = e.value ? `<div class="deal-value" style="font-size:1rem;margin:4px 0">${esc(e.value)} ${esc(e.currency || '')}</div>` : '';
    const termsLine = e.terms ? `<p class="muted" style="white-space:pre-wrap;margin-top:4px">${esc(e.terms.slice(0, 600))}</p>` : '';
    const noteLine = e.note ? `<p class="muted" style="margin-top:4px">${esc(e.note)}</p>` : '';
    return `<div class="tl-item" data-reveal style="--i:${Math.min(i, 10)}">
      <div class="tl-dot"></div>
      <div class="tl-body">
        <div class="feed-head" style="margin:0"><b>${negEventLabel(e.kind)}</b>
          <span class="muted">${esc(actor)} · ${esc(e.created_at.slice(0, 16).replace('T', ' '))} UTC</span></div>
        ${valLine}${termsLine}${noteLine}
      </div>
    </div>`;
  }).join('')}</div>`;
}

// ----- LOI (Letter of Intent): the buyer's entry point into the pipeline -----
app.get('/deal/:id/loi', requireCompany, (req, res) => {
  const deal = getDealOr404(req, res);
  if (!deal) return;
  if (deal.company_id === req.user.id) {
    return res.redirect(`/deal/${deal.id}?err=` + encodeURIComponent('This is your own deal — LOIs come from interested counterparties.'));
  }
  if (deal.contract_state === 'approved' || deal.status === 'closed') {
    return res.redirect(`/deal/${deal.id}?err=` + encodeURIComponent('This deal is closed — the contract is finalized.'));
  }
  const existing = activeNegotiationFor(deal.id, req.user.id);
  if (existing) return res.redirect(`/negotiation/${existing.id}`);
  const owner = db.prepare('SELECT id, name FROM companies WHERE id = ?').get(deal.company_id);
  const body = `
  <div class="card" data-reveal style="max-width:640px;margin:0 auto">
    <div class="kicker">Step 1 — express interest</div>
    <h2>📨 Letter of Intent — ${esc(deal.title)}</h2>
    <p class="muted">To <b>${esc(owner ? owner.name : 'the deal owner')}</b> · Deal № ${esc(deal.deal_number || String(deal.id))}.
      The seller is notified and can answer with a private offer. Deal values are only shared inside the negotiation.</p>
    <hr class="sep">
    <form method="POST" action="/deal/${deal.id}/loi">
      <label>Your intent *</label>
      <textarea name="loi_text" rows="4" required maxlength="2000" placeholder="We are interested in purchasing …"></textarea>
      <div class="grid2" style="gap:10px">
        <div><label>Quantity</label><input type="text" name="loi_quantity" maxlength="120" placeholder="e.g. 500 units / month"></div>
        <div><label>Your location (country / city) *</label><input type="text" name="loi_location" required maxlength="160" placeholder="e.g. Dubai, UAE"></div>
      </div>
      <label>Wishes / conditions (optional)</label>
      <textarea name="loi_wishes" rows="3" maxlength="2000" placeholder="Delivery windows, inspection, certificates…"></textarea>
      <button class="btn btn-green" type="submit">Send Letter of Intent →</button>
      <p class="muted" style="margin-top:8px">Logged by the Deal Agent. The seller sees your company profile and this letter.</p>
    </form>
  </div>`;
  res.send(page('Letter of Intent', body, req.user, req.query.msg, req.query.err));
});

app.post('/deal/:id/loi', requireCompany, (req, res) => {
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!deal) return res.redirect('/timeline?err=' + encodeURIComponent('Deal not found.'));
  if (deal.company_id === req.user.id) {
    audit('DEAL AGENT', 'LOI self-deal guard', 'fail', `${req.user.name} attempted an LOI on own deal #${deal.id}`);
    return res.redirect(`/deal/${deal.id}?err=` + encodeURIComponent('You cannot send an LOI on your own deal.'));
  }
  if (deal.contract_state === 'approved' || deal.status === 'closed') {
    return res.redirect(`/deal/${deal.id}?err=` + encodeURIComponent('This deal is closed — the contract is finalized.'));
  }
  const existing = activeNegotiationFor(deal.id, req.user.id);
  if (existing) return res.redirect(`/negotiation/${existing.id}?err=` + encodeURIComponent('You already have an active negotiation on this deal.'));
  const loiText = String(req.body.loi_text || '').trim().slice(0, 2000);
  const loiQty = String(req.body.loi_quantity || '').trim().slice(0, 120);
  const loiLoc = String(req.body.loi_location || '').trim().slice(0, 160);
  const loiWishes = String(req.body.loi_wishes || '').trim().slice(0, 2000);
  if (!loiText) return res.redirect(`/deal/${deal.id}/loi?err=` + encodeURIComponent('Please describe your intent.'));
  if (!loiLoc) return res.redirect(`/deal/${deal.id}/loi?err=` + encodeURIComponent('Your location is required.'));
  const ts = now();
  const negId = db.prepare(`INSERT INTO negotiations (deal_id, buyer_id, seller_id, state, round, loi_text, loi_location, loi_quantity, loi_wishes, commission_split, created_at, updated_at)
    VALUES (?,?,?, 'LOI_SENT', 0, ?,?,?,?, '50-50', ?, ?)`)
    .run(deal.id, req.user.id, deal.company_id, loiText, loiLoc, loiQty, loiWishes, ts, ts).lastInsertRowid;
  negEvent(negId, req.user.id, 'loi', { note: `Location: ${loiLoc}${loiQty ? ` · Quantity: ${loiQty}` : ''}`, terms: loiText + (loiWishes ? `\nWishes: ${loiWishes}` : '') });
  audit('DEAL AGENT', 'LOI sent', 'pass', `${req.user.name} sent an LOI on deal ${deal.deal_number || '#' + deal.id} (negotiation #${negId}, location: ${loiLoc})`);
  notify(deal.company_id, 'loi', `${req.user.name} expressed interest in your deal "${deal.title}" (LOI, from ${loiLoc}). Review and send a private offer.`, `/negotiation/${negId}`);
  res.redirect(`/negotiation/${negId}?msg=` + encodeURIComponent('Letter of Intent sent — the seller has been notified.'));
});

// ----- Unified negotiation thread (role-aware actions for buyer / seller; admin read-only) -----
app.get('/negotiation/:id', requireCompanyOrAdmin, (req, res) => {
  const neg = getNegotiation(req.params.id);
  if (!neg) return res.status(404).send(page('Not found', '<div class="card"><h2>Negotiation not found</h2></div>', req.user));
  if (!isNegParty(req.user, neg)) {
    audit('DEAL AGENT', 'negotiation access', 'fail', `Unauthorized negotiation #${neg.id} view attempt by ${req.user.isAdmin ? 'admin?' : req.user.name}`);
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Private negotiation</h2><p class="muted">Only the two negotiating parties and the admin can view this page.</p></div>', req.user));
  }
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(neg.deal_id);
  const names = companyNameMap();
  const isBuyer = !req.user.isAdmin && req.user.id === neg.buyer_id;
  const isSeller = !req.user.isAdmin && req.user.id === neg.seller_id;
  const buyerName = names.get(neg.buyer_id) || 'Unknown';
  const sellerName = names.get(neg.seller_id) || 'Unknown';
  const st = neg.state;

  // ---- Role-aware action panel ----
  let actionHtml = '';
  const waiting = (who) => `<div class="card" data-reveal><h3>⏳ Waiting for ${esc(who)}</h3><p class="muted">You'll be notified when the other party acts. Current state: ${statusBadge(st)}</p></div>`;
  if (req.user.isAdmin) {
    actionHtml = `<div class="card" data-reveal><h3>Admin view</h3><p class="muted">Negotiations are finalized from the admin dashboard once they reach final approval.</p></div>`;
  } else if (st === 'LOI_SENT' && isSeller) {
    actionHtml = `<div class="card" data-reveal>
      <h3>📤 Send a private offer</h3>
      <form method="POST" action="/negotiation/${neg.id}/offer">
        <div class="grid2" style="gap:10px">
          <div><label>Offer value *</label><input type="number" name="offer_value" min="0.01" step="any" required></div>
          <div><label>Currency</label><select name="offer_currency">${optionsHtml(DEAL_CURRENCIES, deal ? (deal.currency || 'USD') : 'USD')}</select></div>
        </div>
        <label>Terms *</label><textarea name="offer_terms" rows="4" required maxlength="2000" placeholder="Payment terms, delivery, inspection…"></textarea>
        <label style="display:flex;gap:8px;align-items:center;margin:10px 0">
          <input type="checkbox" name="incoterm_ok" value="yes" style="width:auto;margin:0" required>
          I confirm the deal incoterm (${esc(deal ? (deal.incoterm || 'CIF') : 'CIF')})</label>
        <button class="btn" type="submit">Send offer →</button>
      </form>
      <form method="POST" action="/negotiation/${neg.id}/decline" style="margin-top:8px">
        <button class="btn btn-sm btn-danger" type="submit">Decline this LOI</button>
      </form>
    </div>`;
  } else if (st === 'OFFER_SENT' && isBuyer) {
    actionHtml = `<div class="card" data-reveal>
      <h3>💱 Answer the offer</h3>
      <div class="feed-actions" style="margin-top:0">
        <form method="POST" action="/negotiation/${neg.id}/approve-offer"><button class="btn btn-green" type="submit">Approve offer</button></form>
      </div>
      <hr class="sep">
      <h4 style="margin-bottom:8px">…or send a counter offer</h4>
      <form method="POST" action="/negotiation/${neg.id}/counter">
        <div class="grid2" style="gap:10px">
          <div><label>Counter value *</label><input type="number" name="offer_value" min="0.01" step="any" required value="${esc(neg.offer_value)}"></div>
          <div><label>Currency</label><select name="offer_currency">${optionsHtml(DEAL_CURRENCIES, neg.offer_currency || 'USD')}</select></div>
        </div>
        <label>Counter terms *</label><textarea name="offer_terms" rows="4" required maxlength="2000">${esc(neg.offer_terms)}</textarea>
        <button class="btn" type="submit">Send counter →</button>
      </form>
    </div>`;
  } else if (st === 'COUNTER_SENT' && isSeller) {
    actionHtml = `<div class="card" data-reveal>
      <h3>📤 Re-offer (round ${neg.round + 1})</h3>
      <form method="POST" action="/negotiation/${neg.id}/offer">
        <div class="grid2" style="gap:10px">
          <div><label>New offer value *</label><input type="number" name="offer_value" min="0.01" step="any" required value="${esc(neg.offer_value)}"></div>
          <div><label>Currency</label><select name="offer_currency">${optionsHtml(DEAL_CURRENCIES, neg.offer_currency || 'USD')}</select></div>
        </div>
        <label>New terms *</label><textarea name="offer_terms" rows="4" required maxlength="2000">${esc(neg.offer_terms)}</textarea>
        <label style="display:flex;gap:8px;align-items:center;margin:10px 0">
          <input type="checkbox" name="incoterm_ok" value="yes" style="width:auto;margin:0" required>
          I confirm the deal incoterm (${esc(deal ? (deal.incoterm || 'CIF') : 'CIF')})</label>
        <button class="btn" type="submit">Send new offer →</button>
      </form>
      <form method="POST" action="/negotiation/${neg.id}/decline" style="margin-top:8px">
        <button class="btn btn-sm btn-danger" type="submit">Decline — end negotiation</button>
      </form>
    </div>`;
  } else if (st === 'BUYER_APPROVED' && isSeller) {
    actionHtml = `<div class="card" data-reveal>
      <h3>📄 Approve &amp; send Purchase Order</h3>
      <p class="muted">The buyer approved your offer of <b>${esc(neg.offer_value)} ${esc(neg.offer_currency)}</b>. Generate the Purchase Order — the buyer signs next in the vault signing room.</p>
      <form method="POST" action="/negotiation/${neg.id}/send-po"><button class="btn btn-green" type="submit">Approve &amp; send PO →</button></form>
    </div>`;
  } else if ((st === 'PO_SENT' || st === 'SIGNING') && isBuyer) {
    actionHtml = `<div class="card" data-reveal>
      <h3>✍️ Sign the contract</h3>
      <p class="muted">The Purchase Order is in. Review it, then sign in the vault signing room (password + signing code).</p>
      <div class="feed-actions">
        <a class="btn btn-outline" href="/negotiation/${neg.id}/po.doc">Download PO (.doc)</a>
        <a class="btn btn-green" href="/deal/${neg.deal_id}/sign">Proceed to signing →</a>
      </div>
    </div>`;
  } else if (st === 'SIGNED' && isSeller) {
    actionHtml = `<div class="card" data-reveal>
      <h3>✅ Buyer signed — your approval</h3>
      <p class="muted">${esc(buyerName)} signed the contract. Approve to move on to the commission-split step.</p>
      <form method="POST" action="/negotiation/${neg.id}/owner-approve"><button class="btn btn-green" type="submit">Approve signature →</button></form>
    </div>`;
  } else if ((st === 'OWNER_APPROVED' || st === 'SPLIT_NEGO') && (isBuyer || isSeller)) {
    const iProposed = st === 'SPLIT_NEGO' && neg.split_proposed_by === req.user.id;
    const current = NEG_SPLITS[neg.commission_split] || NEG_SPLITS['50-50'];
    const proposeForm = `
      <form method="POST" action="/negotiation/${neg.id}/split">
        <label>Commission split</label>
        <select name="split">${optionsHtml(Object.keys(NEG_SPLITS), NEG_SPLITS[neg.commission_split] ? neg.commission_split : '50-50')}</select>
        <p class="muted" style="margin:4px 0 10px">${Object.entries(NEG_SPLITS).map(([k, v]) => `<b>${esc(k)}</b> = ${esc(v)}`).join(' · ')}</p>
        <button class="btn" type="submit">${st === 'SPLIT_NEGO' ? 'Counter-propose split' : 'Propose split'} →</button>
      </form>`;
    const acceptForm = (st === 'SPLIT_NEGO' && !iProposed) ? `
      <form method="POST" action="/negotiation/${neg.id}/split-accept" style="margin-bottom:10px">
        <button class="btn btn-green" type="submit">Accept "${esc(current)}" — send to admin for final approval</button>
      </form>` : '';
    actionHtml = `<div class="card" data-reveal>
      <h3>⚖️ Commission split negotiation</h3>
      ${negFeeHtml(neg)}
      ${st === 'SPLIT_NEGO'
        ? `<p class="muted">Proposed by <b>${esc(names.get(neg.split_proposed_by) || 'the other party')}</b>: <b>${esc(current)}</b>. ${iProposed ? 'Waiting for the other party to accept or counter.' : 'Accept it or counter-propose below.'}</p>`
        : '<p class="muted">Default split is <b>50-50</b>. Either party may propose how the platform commission is shared before final admin approval.</p>'}
      ${acceptForm}
      ${iProposed ? '' : proposeForm}
    </div>`;
  } else if (st === 'PENDING_ADMIN') {
    actionHtml = `<div class="card" data-reveal><h3>🏛️ Awaiting admin final approval</h3>${negFeeHtml(neg)}<p class="muted">The admin sees the agreed split and amounts in the final-approval queue.</p></div>`;
  } else if (st === 'DONE') {
    actionHtml = `<div class="card card-announce" data-reveal><h3>🎉 Deal closed</h3>${negFeeHtml(neg)}<p class="muted">The platform commission is due before deal processing. Congratulations to both parties!</p></div>`;
  } else if (st === 'REJECTED') {
    actionHtml = `<div class="card" data-reveal><h3>⛔ Negotiation ended</h3><p class="muted">This negotiation was closed without a contract.</p></div>`;
  } else {
    actionHtml = waiting(isBuyer ? sellerName : buyerName);
  }

  const loiCard = `
  <div class="card" data-reveal>
    <h3>📨 Letter of Intent</h3>
    <p style="margin-top:8px;white-space:pre-wrap">${esc(neg.loi_text)}</p>
    <p class="muted" style="margin-top:8px">📍 Buyer location: <b>${esc(neg.loi_location)}</b>${neg.loi_quantity ? ` · Quantity: ${esc(neg.loi_quantity)}` : ''}</p>
    ${neg.loi_wishes ? `<p class="muted" style="white-space:pre-wrap">💭 Wishes: ${esc(neg.loi_wishes)}</p>` : ''}
  </div>`;

  const stateIdx = NEG_STATES.indexOf(st);
  const pipeline = ['LOI_SENT', 'OFFER_SENT', 'BUYER_APPROVED', 'PO_SENT', 'SIGNED', 'OWNER_APPROVED', 'PENDING_ADMIN', 'DONE'];
  const curPipe = st === 'REJECTED' ? -1 : pipeline.indexOf(st === 'COUNTER_SENT' ? 'OFFER_SENT' : st === 'SIGNING' ? 'PO_SENT' : st === 'SPLIT_NEGO' ? 'OWNER_APPROVED' : st);
  const pipelineHtml = `<div class="stepper" role="list" aria-label="Negotiation pipeline">${pipeline.map((s, i) =>
    `<div class="step-node ${st === 'REJECTED' ? '' : i < curPipe ? 'done' : i === curPipe ? 'current done' : ''}" style="--i:${i}">
      <span class="step-dot">${i < curPipe ? '✓' : i + 1}</span><span class="step-lbl">${esc(s.replace(/_/g, ' '))}</span>
    </div>`).join('')}</div>
    ${st === 'REJECTED' ? '<p style="margin-top:8px"><span class="badge badge-rejected">rejected</span></p>' : ''}`;

  const body = `
  <div class="feed-head" style="margin-bottom:4px">
    <div><div class="kicker">Negotiation #${neg.id} · round ${neg.round}</div>
      <h1 style="font-size:1.6rem;margin-top:4px">🤝 ${esc(deal ? deal.title : 'Deal #' + neg.deal_id)}</h1></div>
    <a class="btn btn-sm btn-outline" href="/deals/inbox">← Deal inbox</a>
  </div>
  <p class="muted" style="margin-bottom:14px">
    Buyer: <a href="/company/${neg.buyer_id}"><b>${esc(buyerName)}</b></a> · Seller: <a href="/company/${neg.seller_id}"><b>${esc(sellerName)}</b></a>
    · Deal № ${esc(deal ? (deal.deal_number || String(deal.id)) : String(neg.deal_id))} · ${statusBadge(st)}
    · <a href="/deal/${neg.deal_id}">view deal</a>
    ${['PO_SENT', 'SIGNING', 'SIGNED', 'OWNER_APPROVED', 'SPLIT_NEGO', 'PENDING_ADMIN', 'DONE'].includes(st) ? ` · <a href="/negotiation/${neg.id}/po.doc">PO (.doc)</a>` : ''}
  </p>
  <div class="card" data-reveal><h3>Pipeline</h3>${pipelineHtml}</div>
  ${actionHtml}
  <h3 class="sec-h">Rounds</h3>
  ${negTimelineHtml(neg.id, names)}
  ${loiCard}`;
  res.send(page(`Negotiation #${neg.id}`, body, req.user, req.query.msg, req.query.err));
});

// ----- Negotiation actions (party-guarded, state-machine enforced) -----
/** Load neg + check party + expected state; on failure redirects and returns null. */
function negGuard(req, res, states, role) {
  const neg = getNegotiation(req.params.id);
  const back = neg ? `/negotiation/${neg.id}` : '/deals/inbox';
  if (!neg) { res.redirect('/deals/inbox?err=' + encodeURIComponent('Negotiation not found.')); return null; }
  if (req.user.isAdmin || (req.user.id !== neg.buyer_id && req.user.id !== neg.seller_id)) {
    res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Private negotiation</h2></div>', req.user));
    return null;
  }
  if (role === 'seller' && req.user.id !== neg.seller_id) { res.redirect(back + '?err=' + encodeURIComponent('Only the seller can do that.')); return null; }
  if (role === 'buyer' && req.user.id !== neg.buyer_id) { res.redirect(back + '?err=' + encodeURIComponent('Only the buyer can do that.')); return null; }
  if (states && !states.includes(neg.state)) { res.redirect(back + '?err=' + encodeURIComponent(`This action is not available in state ${neg.state.replace(/_/g, ' ')}.`)); return null; }
  return neg;
}

// Seller sends (or re-sends) a private offer.
app.post('/negotiation/:id/offer', requireCompany, (req, res) => {
  const neg = negGuard(req, res, ['LOI_SENT', 'COUNTER_SENT'], 'seller');
  if (!neg) return;
  const value = String(req.body.offer_value || '').trim();
  const num = parseFloat(value);
  if (!isFinite(num) || num <= 0) return res.redirect(`/negotiation/${neg.id}?err=` + encodeURIComponent('Offer value must be a positive number.'));
  const currency = DEAL_CURRENCIES.includes(req.body.offer_currency) ? req.body.offer_currency : 'USD';
  const terms = String(req.body.offer_terms || '').trim().slice(0, 2000);
  if (!terms) return res.redirect(`/negotiation/${neg.id}?err=` + encodeURIComponent('Offer terms are required.'));
  if (req.body.incoterm_ok !== 'yes') return res.redirect(`/negotiation/${neg.id}?err=` + encodeURIComponent('Please confirm the deal incoterm.'));
  const isReoffer = neg.state === 'COUNTER_SENT';
  const round = neg.round + 1; // the initial offer is round 1, the first re-offer after a counter is round 2, …
  db.prepare(`UPDATE negotiations SET state = 'OFFER_SENT', round = ?, offer_value = ?, offer_currency = ?, offer_terms = ?, updated_at = ? WHERE id = ?`)
    .run(round, String(num), currency, terms, now(), neg.id);
  negEvent(neg.id, req.user.id, 'offer', { value: String(num), currency, terms, note: isReoffer ? `Re-offer — round ${round}` : 'Initial offer' });
  audit('DEAL AGENT', isReoffer ? 're-offer sent' : 'offer sent', 'pass', `${req.user.name} offered ${num} ${currency} on negotiation #${neg.id} (round ${round})`);
  notify(neg.buyer_id, 'offer', `${req.user.name} sent you a private offer (${fmtAmount(num)} ${currency}) on negotiation #${neg.id}. Approve or counter.`, `/negotiation/${neg.id}`);
  res.redirect(`/negotiation/${neg.id}?msg=` + encodeURIComponent('Offer sent to the buyer.'));
});

// Buyer counters the current offer.
app.post('/negotiation/:id/counter', requireCompany, (req, res) => {
  const neg = negGuard(req, res, ['OFFER_SENT'], 'buyer');
  if (!neg) return;
  const value = String(req.body.offer_value || '').trim();
  const num = parseFloat(value);
  if (!isFinite(num) || num <= 0) return res.redirect(`/negotiation/${neg.id}?err=` + encodeURIComponent('Counter value must be a positive number.'));
  const currency = DEAL_CURRENCIES.includes(req.body.offer_currency) ? req.body.offer_currency : 'USD';
  const terms = String(req.body.offer_terms || '').trim().slice(0, 2000);
  if (!terms) return res.redirect(`/negotiation/${neg.id}?err=` + encodeURIComponent('Counter terms are required.'));
  db.prepare(`UPDATE negotiations SET state = 'COUNTER_SENT', offer_value = ?, offer_currency = ?, offer_terms = ?, updated_at = ? WHERE id = ?`)
    .run(String(num), currency, terms, now(), neg.id);
  negEvent(neg.id, req.user.id, 'counter', { value: String(num), currency, terms });
  audit('DEAL AGENT', 'counter offer sent', 'pass', `${req.user.name} countered ${num} ${currency} on negotiation #${neg.id}`);
  notify(neg.seller_id, 'counter', `${req.user.name} countered your offer on negotiation #${neg.id}: ${fmtAmount(num)} ${currency}. Re-offer or decline.`, `/negotiation/${neg.id}`);
  res.redirect(`/negotiation/${neg.id}?msg=` + encodeURIComponent('Counter offer sent to the seller.'));
});

// Buyer approves the current offer.
app.post('/negotiation/:id/approve-offer', requireCompany, (req, res) => {
  const neg = negGuard(req, res, ['OFFER_SENT'], 'buyer');
  if (!neg) return;
  negSetState(neg.id, 'BUYER_APPROVED');
  negEvent(neg.id, req.user.id, 'approve', { value: neg.offer_value, currency: neg.offer_currency });
  audit('DEAL AGENT', 'offer approved', 'pass', `${req.user.name} approved the offer on negotiation #${neg.id}`);
  notify(neg.seller_id, 'offer_approved', `${req.user.name} approved your offer on negotiation #${neg.id}. Approve & send the Purchase Order.`, `/negotiation/${neg.id}`);
  res.redirect(`/negotiation/${neg.id}?msg=` + encodeURIComponent('Offer approved — the seller can now issue the Purchase Order.'));
});

// Seller declines (from LOI_SENT or COUNTER_SENT) → REJECTED.
app.post('/negotiation/:id/decline', requireCompany, (req, res) => {
  const neg = negGuard(req, res, ['LOI_SENT', 'OFFER_SENT', 'COUNTER_SENT'], 'seller');
  if (!neg) return;
  negSetState(neg.id, 'REJECTED');
  negEvent(neg.id, req.user.id, 'decline');
  audit('DEAL AGENT', 'negotiation declined', 'fail', `${req.user.name} declined negotiation #${neg.id}`);
  notify(neg.buyer_id, 'negotiation_declined', `${req.user.name} declined the negotiation on your LOI (negotiation #${neg.id}).`, `/negotiation/${neg.id}`);
  res.redirect(`/negotiation/${neg.id}?msg=` + encodeURIComponent('Negotiation declined. The buyer has been notified.'));
});

// Seller approves & issues the Purchase Order (document generated on demand via /po.doc).
app.post('/negotiation/:id/send-po', requireCompany, (req, res) => {
  const neg = negGuard(req, res, ['BUYER_APPROVED'], 'seller');
  if (!neg) return;
  negSetState(neg.id, 'PO_SENT');
  negEvent(neg.id, req.user.id, 'po', { value: neg.offer_value, currency: neg.offer_currency });
  audit('DEAL AGENT', 'purchase order sent', 'pass', `${req.user.name} issued the PO on negotiation #${neg.id}`);
  notify(neg.buyer_id, 'po_sent', `${req.user.name} issued the Purchase Order for negotiation #${neg.id}. Review it and proceed to signing.`, `/deal/${neg.deal_id}/sign`);
  res.redirect(`/negotiation/${neg.id}?msg=` + encodeURIComponent('Purchase Order sent — the buyer can now sign in the vault.'));
});

// Purchase Order document (msword .doc) — parties + admin only, once issued.
app.get('/negotiation/:id/po.doc', requireCompanyOrAdmin, (req, res) => {
  const neg = getNegotiation(req.params.id);
  if (!neg) return res.status(404).send(page('Not found', '<div class="card"><h2>Negotiation not found</h2></div>', req.user));
  if (!isNegParty(req.user, neg)) {
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Private negotiation document</h2></div>', req.user));
  }
  if (!['PO_SENT', 'SIGNING', 'SIGNED', 'OWNER_APPROVED', 'SPLIT_NEGO', 'PENDING_ADMIN', 'DONE'].includes(neg.state)) {
    return res.redirect(`/negotiation/${neg.id}?err=` + encodeURIComponent('The Purchase Order is issued after the buyer approves the offer.'));
  }
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(neg.deal_id);
  const names = companyNameMap();
  const buyerName = names.get(neg.buyer_id) || 'Unknown';
  const sellerName = names.get(neg.seller_id) || 'Unknown';
  const dealNum = deal ? (deal.deal_number || String(deal.id)) : String(neg.deal_id);
  const f = negFeeBreakdown(neg);
  const splitLabel = NEG_SPLITS[neg.commission_split] || NEG_SPLITS['50-50'];
  const feeClause = isFinite(f.fee)
    ? `PLATFORM COMMISSION. A platform commission of ${f.pct}% of the agreed deal value (${fmtAmount(f.fee)} ${f.cur}) is payable to Dealzoin before deal processing. Split: ${splitLabel} — Buyer: ${fmtAmount(f.buyer)} ${f.cur}, Seller: ${fmtAmount(f.seller)} ${f.cur}.`
    : `PLATFORM COMMISSION. A platform commission of ${f.pct}% of the agreed deal value is payable to Dealzoin before deal processing. Split: ${splitLabel}.`;
  const doc = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
<head><meta charset="utf-8"><title>Purchase Order ${esc(dealNum)}</title></head>
<body style="font-family:Calibri,Arial,sans-serif">
  <h1>Purchase Order — Deal № ${esc(dealNum)}</h1>
  <h2>${esc(deal ? deal.title : 'Deal')}</h2>
  <p><b>Buyer:</b> ${esc(buyerName)}${neg.loi_location ? ` (${esc(neg.loi_location)})` : ''}<br>
     <b>Seller:</b> ${esc(sellerName)}<br>
     <b>Deal number:</b> ${esc(dealNum)}<br>
     <b>Agreed value:</b> ${esc(neg.offer_value)} ${esc(neg.offer_currency || 'USD')}<br>
     <b>Incoterm:</b> ${esc(deal ? (deal.incoterm || 'CIF') : 'CIF')}<br>
     <b>Negotiation rounds:</b> ${neg.round}<br>
     <b>Issued:</b> ${esc(now())}</p>
  <h3>Agreed terms</h3><p>${esc(neg.offer_terms)}</p>
  <h3>Platform commission</h3><p><b>${esc(feeClause)}</b></p>
  <p>__________________________&nbsp;&nbsp;&nbsp;__________________________<br>
  Buyer signature&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Seller signature</p>
</body></html>`;
  audit('DEAL AGENT', 'PO download', 'pass', `PO for negotiation #${neg.id} downloaded by ${req.user.isAdmin ? 'admin' : req.user.name}`);
  res.setHeader('Content-Type', 'application/msword');
  res.setHeader('Content-Disposition', `attachment; filename="PO-${String(dealNum).replace(/[^A-Za-z0-9._-]/g, '_')}.doc"`);
  res.send(doc);
});

// Seller (deal owner) approves the buyer's signature.
app.post('/negotiation/:id/owner-approve', requireCompany, (req, res) => {
  const neg = negGuard(req, res, ['SIGNED'], 'seller');
  if (!neg) return;
  negSetState(neg.id, 'OWNER_APPROVED');
  negEvent(neg.id, req.user.id, 'owner_approved');
  audit('CONTRACT AGENT', 'owner approve signature (negotiation)', 'pass', `Seller ${req.user.name} approved the buyer's signature on negotiation #${neg.id}`);
  notify(neg.buyer_id, 'owner_approved', `${req.user.name} approved your signature on negotiation #${neg.id}. Agree the commission split to reach final approval.`, `/negotiation/${neg.id}`);
  notify(neg.seller_id, 'owner_approved', `Negotiation #${neg.id}: propose or confirm the commission split to proceed to final approval.`, `/negotiation/${neg.id}`);
  res.redirect(`/negotiation/${neg.id}?msg=` + encodeURIComponent('Signature approved — now agree the commission split.'));
});

// Either party proposes (or counter-proposes) the commission split.
app.post('/negotiation/:id/split', requireCompany, (req, res) => {
  const neg = negGuard(req, res, ['OWNER_APPROVED', 'SPLIT_NEGO']);
  if (!neg) return;
  if (neg.state === 'SPLIT_NEGO' && neg.split_proposed_by === req.user.id) {
    return res.redirect(`/negotiation/${neg.id}?err=` + encodeURIComponent('You made the current proposal — wait for the other party.'));
  }
  const split = String(req.body.split || '');
  if (!NEG_SPLITS[split]) return res.redirect(`/negotiation/${neg.id}?err=` + encodeURIComponent('Invalid split option.'));
  db.prepare(`UPDATE negotiations SET commission_split = ?, split_proposed_by = ?, state = 'SPLIT_NEGO', updated_at = ? WHERE id = ?`)
    .run(split, req.user.id, now(), neg.id);
  negEvent(neg.id, req.user.id, 'split', { note: `Proposed split: ${NEG_SPLITS[split]}` });
  audit('DEAL AGENT', 'commission split proposed', 'pass', `${req.user.name} proposed split "${split}" on negotiation #${neg.id}`);
  const other = req.user.id === neg.buyer_id ? neg.seller_id : neg.buyer_id;
  notify(other, 'split_proposed', `${req.user.name} proposed a commission split of "${NEG_SPLITS[split]}" on negotiation #${neg.id}. Accept or counter-propose.`, `/negotiation/${neg.id}`);
  res.redirect(`/negotiation/${neg.id}?msg=` + encodeURIComponent('Split proposed — the other party has been notified.'));
});

// The other party accepts the proposed split → PENDING_ADMIN.
app.post('/negotiation/:id/split-accept', requireCompany, (req, res) => {
  const neg = negGuard(req, res, ['SPLIT_NEGO']);
  if (!neg) return;
  if (neg.split_proposed_by === req.user.id) {
    return res.redirect(`/negotiation/${neg.id}?err=` + encodeURIComponent('You made the current proposal — the other party must accept it.'));
  }
  negSetState(neg.id, 'PENDING_ADMIN');
  negEvent(neg.id, req.user.id, 'split_accept', { note: `Accepted split: ${NEG_SPLITS[neg.commission_split] || neg.commission_split}` });
  audit('DEAL AGENT', 'commission split accepted', 'pass', `${req.user.name} accepted split "${neg.commission_split}" on negotiation #${neg.id} — pending admin final approval`);
  const other = req.user.id === neg.buyer_id ? neg.seller_id : neg.buyer_id;
  notify(other, 'split_accepted', `${req.user.name} accepted the commission split on negotiation #${neg.id} — awaiting admin final approval.`, `/negotiation/${neg.id}`);
  res.redirect(`/negotiation/${neg.id}?msg=` + encodeURIComponent('Split accepted — the negotiation now awaits admin final approval.'));
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
/** Platform-fee helpers for private contracts (HTML / plain-text variants) — dynamic commission. */
function pcFeeAmount(pc) {
  const pct = platformFeePct();
  const num = Number(pc && pc.value);
  return isFinite(num) && num > 0 ? `${fmtAmount(num * pct / 100)} ${pc.currency || 'USD'}` : `${pct}% of contract value`;
}
function pcFeeLineHtml(pc, style) {
  return `<div class="muted" style="font-size:12px;${style || ''}">🏦 Platform fee: ${platformFeePct()}% (${esc(pcFeeAmount(pc))}) — transparent Dealzoin commission</div>`;
}
function pcFeeLineText(pc) {
  return `Platform fee: ${platformFeePct()}% (${pcFeeAmount(pc)}) — transparent Dealzoin commission`;
}
/** Platform-fee clause text for private contracts (dynamic commission). */
function pcFeeClauseText() {
  return `10. PLATFORM FEE. A transparent platform commission of ${platformFeePct()}% of the stated contract value is payable to Dealzoin. This fee is disclosed to both parties before signing and is separate from the value exchanged between the parties.`;
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
      ${'<div class="muted" style="font-size:12px;margin-bottom:12px">🏦 A transparent ' + platformFeePct() + '% Dealzoin platform fee applies and is disclosed to both parties.</div>'}
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

  const rowHtml = shown.length ? shown.map((pc, idx) => {
    const sealed = pcIsSealed(pc, req.user.id);
    const otherId = tab === 'sent' ? pc.recipient_company_id : pc.sender_company_id;
    const otherName = names.get(otherId) || 'Unknown';
    const amount = Number(pc.value) > 0 ? `<span class="mail-amount">${esc(fmtAmount(Number(pc.value)))} ${esc(pc.currency || 'USD')}</span>` : '';
    return `<a class="mail-row ${sealed ? 'mail-row--sealed' : 'mail-row--opened'}" href="/contracts/${pc.id}"
        data-reveal style="--i:${Math.min(idx, 10)}"
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
    <p class="muted" style="font-size:13px">${esc(pcFeeClauseText())}</p>
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
  <p>${esc(pcFeeClauseText())}</p>
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

// ----- KYC document download: the OWNING company or an admin only (documents are private) -----
app.get('/documents/:id', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.redirect('/login?err=' + encodeURIComponent('Please sign in to view documents.'));
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!doc) return res.status(404).send(page('Not found', '<div class="card"><h2>Document not found</h2></div>', user));
  if (!user.isAdmin && doc.company_id !== user.id) {
    audit('DOCUMENT AGENT', 'document access', 'fail', `Unauthorized document access attempt: doc #${doc.id} by ${user.name}`);
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Private document</h2><p class="muted">Only the owning company and the admin can download this document.</p></div>', user));
  }
  audit('DOCUMENT AGENT', 'document access', 'pass', `Document #${doc.id} (${doc.doc_type}) downloaded by ${user.isAdmin ? 'admin' : user.name}`);
  res.setHeader('Content-Type', doc.mime || 'application/pdf');
  res.setHeader('Content-Length', doc.data.length);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', `attachment; filename="${String(doc.filename || 'document.pdf').replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  res.send(doc.data);
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
        ${dealFormFieldsHtml()}
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
    ? deals.map((d, idx) => feedCard(dealFeedItem(d), req.user, names, idx)).join('')
    : '<div class="card"><p class="muted">No deals yet — <a href="/deals/new">post your first deal</a>.</p></div>';
  const postsHtml = posts.length
    ? posts.map((p, idx) => feedCard({ kind: 'post', ref_id: p.id, company_id: p.company_id, body: p.body, created_at: p.created_at, media_id: p.media_id, author_name: p.author_name || '', is_system: p.is_system || 0 }, req.user, names, idx)).join('')
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
    ${req.user.memberId ? '<p class="muted">Profile images are managed by the main company account.</p>' : `
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
    </div>`}
  </div>
  ${teamSectionHtml(req.user, c)}
  <div class="card">
    <h3>Bio &amp; about</h3>
    ${req.user.memberId ? '<p class="muted">You are signed in as a team member — profile editing is restricted to the main company account.</p>' : `
    <form method="POST" action="/profile/info">
      <label>Bio — one-liner under your name (max 160 characters)</label>
      <input type="text" name="bio" maxlength="160" value="${esc(c.bio || '')}" placeholder="e.g. Industrial robotics, delivered.">
      <label>About — the full story (max 2000 characters)</label>
      <textarea name="about" rows="6" maxlength="2000" placeholder="What your company does, who you serve, why you win.">${esc(c.about || '')}</textarea>
      <button class="btn" type="submit">Save bio &amp; about</button>
    </form>`}
  </div>
  <div class="stats">
    <div class="stat" data-reveal style="--i:0"><div class="num gold" data-count="${deals.length}">${deals.length}</div><div class="lbl">My deals</div></div>
    <div class="stat" data-reveal style="--i:1"><div class="num" data-count="${posts.length}">${posts.length}</div><div class="lbl">My posts</div></div>
    <div class="stat" data-reveal style="--i:2"><div class="num mint" data-count="${fc.followers}">${fc.followers}</div><div class="lbl">Followers</div></div>
    <div class="stat" data-reveal style="--i:3"><div class="num" data-count="${fc.following}">${fc.following}</div><div class="lbl">Following</div></div>
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
    if (req.user.memberId) return res.redirect('/profile?err=' + encodeURIComponent('Team members cannot change the company profile.'));
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
  if (req.user.memberId) return res.redirect('/profile?err=' + encodeURIComponent('Team members cannot change the company profile.'));
  const bio = String(req.body.bio || '').trim().slice(0, 160);
  const about = String(req.body.about || '').trim().slice(0, 2000);
  db.prepare('UPDATE companies SET bio = ?, about = ? WHERE id = ?').run(bio, about, req.user.id);
  res.redirect('/profile?msg=' + encodeURIComponent('Profile updated.'));
});

// ============================= SUB-ACCOUNTS (TEAM MEMBERS) =============================
/** Team management card for /profile — main company account only. */
function teamSectionHtml(user, company) {
  if (user.memberId) {
    return `<div class="card"><h3>👥 Team</h3>
      <p class="muted">Signed in as team member <b>${esc(user.memberName || '')}</b> (${esc(user.memberRole || 'member')}).
      Only the main company account can manage the team.</p></div>`;
  }
  const members = db.prepare('SELECT * FROM company_members WHERE company_id = ? ORDER BY created_at ASC').all(company.id);
  const rows = members.length ? members.map(m => `
    <div class="feed-head" style="padding:8px 0;border-top:1px dashed var(--border-soft)">
      <div>${avatarHtml(m.name, null)}<b>${esc(m.name)}</b> <span class="badge ${m.status === 'active' ? 'badge-pass' : 'badge-rejected'}">${esc(m.status)}</span>
        <span class="badge badge-sealed">${esc(m.role)}</span><br>
        <span class="muted" style="margin-left:42px">${esc(m.email)} · added ${esc(m.created_at.slice(0, 10))}</span></div>
      ${m.status === 'active' ? `<form method="POST" action="/profile/team/${m.id}/deactivate" onsubmit="return confirm('Deactivate this team member? Their sessions are revoked.')"><button class="btn btn-sm btn-danger" type="submit">Deactivate</button></form>` : ''}
    </div>`).join('') : '<p class="muted">No team members yet.</p>';
  return `<div class="card" data-reveal>
    <h3>👥 Team — sub-accounts</h3>
    <p class="muted">Team members sign in with their own email &amp; password and act as <b>${esc(company.name)}</b> — posts, deals, chats and signatures show a "— by {name}" attribution. Members cannot manage the team or edit the profile.</p>
    ${rows}
    <hr class="sep">
    <h4 style="margin-bottom:8px">Add a team member</h4>
    <form method="POST" action="/profile/team/add">
      <div class="grid2" style="gap:10px">
        <div><label>Full name</label><input type="text" name="name" required maxlength="120" placeholder="e.g. Dana Procurement"></div>
        <div><label>Member email</label><input type="email" name="email" required maxlength="200" placeholder="dana@${esc((company.website || 'company.com').replace(/^https?:\/\//, '').split('/')[0])}"></div>
      </div>
      <div class="grid2" style="gap:10px">
        <div><label>Password (min 8 characters)</label><input type="password" name="password" required minlength="8"></div>
        <div><label>Role</label><select name="role">${optionsHtml(['member', 'manager'], 'member')}</select></div>
      </div>
      <button class="btn" type="submit">Add member</button>
      <p class="muted" style="margin-top:6px">Member sign-in is protected by the same 2FA email codes. All member logins are audit-logged.</p>
    </form>
  </div>`;
}

// ----- Team management actions (main company account only) -----
app.post('/profile/team/add', requireCompany, (req, res) => {
  if (req.user.memberId) {
    audit('TEAM AGENT', 'member add guard', 'fail', `Member ${req.user.memberName} attempted to manage the team of ${req.user.name}`);
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Only the main company account can manage the team.</h2></div>', req.user));
  }
  const name = String(req.body.name || '').trim().slice(0, 120);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 200);
  const pw = String(req.body.password || '');
  const role = req.body.role === 'manager' ? 'manager' : 'member';
  if (!name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.redirect('/profile?err=' + encodeURIComponent('Name and a valid member email are required.'));
  }
  if (pw.length < 8) return res.redirect('/profile?err=' + encodeURIComponent('Member password must be at least 8 characters.'));
  if (db.prepare('SELECT id FROM companies WHERE email = ?').get(email) || db.prepare('SELECT id FROM company_members WHERE email = ?').get(email)) {
    return res.redirect('/profile?err=' + encodeURIComponent('That email is already in use on Dealzoin.'));
  }
  const salt = newSalt();
  db.prepare('INSERT INTO company_members (company_id, name, email, password_hash, salt, role, status, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(req.user.id, name, email, hashPassword(pw, salt), salt, role, 'active', now());
  audit('TEAM AGENT', 'member added', 'pass', `${req.user.name} added team member ${name} <${email}> (role: ${role})`);
  res.redirect('/profile?msg=' + encodeURIComponent(`Team member ${name} added. They can sign in with their own email & password.`));
});

app.post('/profile/team/:id/deactivate', requireCompany, (req, res) => {
  if (req.user.memberId) {
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Only the main company account can manage the team.</h2></div>', req.user));
  }
  const m = db.prepare('SELECT * FROM company_members WHERE id = ? AND company_id = ?').get(parseInt(req.params.id, 10), req.user.id);
  if (!m) return res.redirect('/profile?err=' + encodeURIComponent('Team member not found.'));
  db.prepare(`UPDATE company_members SET status = 'deactivated' WHERE id = ?`).run(m.id);
  db.prepare('DELETE FROM sessions WHERE member_id = ?').run(m.id); // revoke live sessions
  audit('TEAM AGENT', 'member deactivated', 'pass', `${req.user.name} deactivated team member ${m.name} <${m.email}> — sessions revoked`);
  res.redirect('/profile?msg=' + encodeURIComponent(`Team member ${m.name} deactivated.`));
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
  const tilesHtml = `<div class="stats">${tiles.map(([l, n, cls], ti) => `<div class="stat" data-reveal style="--i:${Math.min(ti, 10)}"><div class="num${cls}"${typeof n === 'number' ? ` data-count="${n}"` : ''}>${n}</div><div class="lbl">${l}</div></div>`).join('')}</div>`;

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
    ? `<div class="card" data-reveal><h3>Likes &amp; comments per deal</h3><div class="chart-wrap"><canvas id="chart-deals"></canvas></div></div>`
    : `<div class="card" data-reveal><h3>Likes &amp; comments per deal</h3><div class="dash-empty">No deals yet — this chart appears once you publish a deal.</div></div>`;
  const doughnutCard = statusRows.length
    ? `<div class="card" data-reveal><h3>My contract statuses</h3><div class="chart-wrap"><canvas id="chart-contracts"></canvas></div></div>`
    : `<div class="card" data-reveal><h3>My contract statuses</h3><div class="dash-empty">No contracts yet — sign a deal or receive a signature to see the breakdown.</div></div>`;

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
  <div class="card" data-reveal><h3>My deals</h3>
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
    const senderLine = (conv.type === 'group' || m.author_name) && !mine
      ? `<div class="bubble-sender">${esc(sender)}${m.author_name ? ` — by ${esc(m.author_name)}` : ''}</div>`
      : (mine && m.author_name ? `<div class="bubble-sender">— by ${esc(m.author_name)}</div>` : '');
    return `<div class="bubble ${mine ? 'mine' : 'theirs'}">
      ${senderLine}
      ${esc(m.body)}
      <div class="bubble-meta">${esc(m.created_at.slice(0, 16).replace('T', ' '))}</div>
    </div>`;
  }).join('') : '<p class="muted">No messages yet — say hello.</p>';

  const sendForm = user.isAdmin
    ? '<p class="muted">Admin view — conversations are read-only for admins.</p>'
    : `<form method="POST" action="/chat/${conv.id}/send" class="chat-send" id="chatform">
         <input type="text" name="body" required maxlength="2000" placeholder="Write a message…" autocomplete="off">
         <button class="btn" type="submit">Send</button>
       </form>`;

  // Live updates via SSE (EventSource). The 8s <meta refresh> below is the no-JS / SSE-error fallback —
  // it is removed from the DOM as soon as the stream opens.
  const liveScript = user.isAdmin ? '' : `
  <script>(function(){
    var box=document.getElementById('chatbox');
    var form=document.getElementById('chatform');
    var ME=${user.id}, ISGROUP=${conv.type === 'group' ? 'true' : 'false'};
    var CID='c'+Math.random().toString(36).slice(2);
    function scrollDown(){window.scrollTo(0,document.body.scrollHeight);}
    function addBubble(m,optimistic){
      if(!box)return;
      var div=document.createElement('div');
      div.className='bubble '+((m.sender_company_id===ME)?'mine':'theirs');
      if(m.sender_company_id!==ME&&(ISGROUP||m.author_name)){
        var s=document.createElement('div');s.className='bubble-sender';
        s.textContent=(m.sender_name||'')+(m.author_name?' — by '+m.author_name:'');
        div.appendChild(s);
      }
      div.appendChild(document.createTextNode(m.body));
      var meta=document.createElement('div');meta.className='bubble-meta';
      meta.textContent=(m.created_at||'').slice(0,16).replace('T',' ')+(optimistic?' · sending…':'');
      div.appendChild(meta);
      box.appendChild(div);scrollDown();
    }
    try{
      var es=new EventSource('/chat/${conv.id}/stream');
      es.onopen=function(){
        var meta=document.querySelector('meta[http-equiv="refresh"]');
        if(meta&&meta.parentNode)meta.parentNode.removeChild(meta);
      };
      es.onmessage=function(ev){
        try{
          var m=JSON.parse(ev.data);
          if(m.cid&&m.cid===CID)return; // own optimistic echo
          addBubble(m,false);
        }catch(e){}
      };
      es.onerror=function(){
        // Fallback: if the stream dies and the meta refresh is gone, reload every 8s.
        if(!document.querySelector('meta[http-equiv="refresh"]')){setTimeout(function(){location.reload();},8000);}
      };
    }catch(e){}
    if(form){form.addEventListener('submit',function(ev){
      ev.preventDefault();
      var input=form.elements.body;var txt=(input.value||'').trim();
      if(!txt)return;
      input.value='';
      addBubble({sender_company_id:ME,body:txt,created_at:new Date().toISOString()},true);
      fetch('/chat/${conv.id}/send',{method:'POST',
        headers:{'Content-Type':'application/x-www-form-urlencoded','X-DZ-Client':CID},
        body:'body='+encodeURIComponent(txt)}).then(function(r){
        if(!r.ok&&!r.redirected)location.reload();
      }).catch(function(){location.reload();});
    });}
  })();</script>`;

  const body = `
  <div class="card">
    <div class="feed-head"><h2>${convAvatar}${esc(dn)}</h2>
      <a class="btn btn-sm btn-outline" href="/chats">← All chats</a></div>
    <p class="muted">${conv.type === 'group' ? 'Group conversation' : 'Private conversation'} · live updates${user.isAdmin ? '' : ' (SSE)'} · 8s refresh fallback</p>
    <hr class="sep">
    <div class="chat-box" id="chatbox">${bubbles}</div>
    ${sendForm}
  </div>
  <script>window.scrollTo(0, document.body.scrollHeight);</script>
  ${liveScript}`;
  res.send(page(dn, body, user, req.query.msg, req.query.err, 'chats', '<meta http-equiv="refresh" content="8">'));
});

// ----- Server-Sent Events: live message push (in-memory; fine for a single dyno) -----
const sseClients = new Map(); // convId -> Set<res>
/** Push a message payload to every connected client of a conversation. */
function sseBroadcast(convId, payload) {
  const set = sseClients.get(convId);
  if (!set || !set.size) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const r of [...set]) {
    try { r.write(data); } catch (e) { try { r.end(); } catch (_) {} set.delete(r); }
  }
}

app.get('/chat/:id/stream', requireCompany, (req, res) => {
  const convId = parseInt(req.params.id, 10);
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
  if (!conv || !isMember(convId, req.user.id)) {
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Private conversation</h2></div>', req.user));
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');
  let set = sseClients.get(convId);
  if (!set) { set = new Set(); sseClients.set(convId, set); }
  set.add(res);
  const heartbeat = setInterval(() => { try { res.write(':ping\n\n'); } catch (e) { /* closed */ } }, 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    set.delete(res);
    if (!set.size) sseClients.delete(convId);
  });
});

app.post('/chat/:id/send', requireCompany, (req, res) => {
  const convId = parseInt(req.params.id, 10);
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
  if (!conv || !isMember(convId, req.user.id)) {
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Private conversation</h2></div>', req.user));
  }
  const txt = String(req.body.body || '').trim();
  if (!txt) return res.redirect('/chat/' + convId + '?err=' + encodeURIComponent('Message cannot be empty.'));
  const ts = now();
  const info = db.prepare('INSERT INTO messages (conversation_id, sender_company_id, body, created_at, author_name) VALUES (?,?,?,?,?)')
    .run(convId, req.user.id, txt.slice(0, 2000), ts, req.user.memberName || null);
  // Live-push to connected SSE clients (cid lets the sender's own tab skip its optimistic echo).
  sseBroadcast(convId, {
    id: Number(info.lastInsertRowid), conversation_id: convId,
    sender_company_id: req.user.id, sender_name: req.user.name,
    author_name: req.user.memberName || '', body: txt.slice(0, 2000), created_at: ts,
    cid: String(req.get('x-dz-client') || '')
  });
  res.redirect('/chat/' + convId);
});

// ============================= CALENDAR & ONLINE CALLS =============================
/** Events visible to a company: created by them OR they are a participant. */
function eventsForCompany(companyId) {
  return db.prepare(`
    SELECT DISTINCT e.* FROM events e
    LEFT JOIN event_participants ep ON ep.event_id = e.id
    WHERE e.creator_company_id = ? OR ep.company_id = ?
    ORDER BY e.event_date ASC, e.event_time ASC`).all(companyId, companyId);
}
/** True when the user may see the join link: creator, participant, or admin. */
function canJoinEvent(user, ev) {
  if (!user || !ev) return false;
  if (user.isAdmin) return true;
  if (ev.creator_company_id === user.id) return true;
  return !!db.prepare('SELECT 1 FROM event_participants WHERE event_id = ? AND company_id = ?').get(ev.id, user.id);
}

app.get('/calendar', requireCompany, (req, res) => {
  const names = companyNameMap();
  // Month navigation (?m=YYYY-MM), clamped to a sane range.
  let ym = String(req.query.m || '').match(/^(\d{4})-(\d{2})$/);
  const today = new Date();
  let year = today.getUTCFullYear(), month = today.getUTCMonth() + 1; // 1-based
  if (ym) {
    const y = parseInt(ym[1], 10), mo = parseInt(ym[2], 10);
    if (y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12) { year = y; month = mo; }
  }
  const ymStr = `${year}-${String(month).padStart(2, '0')}`;
  const prev = new Date(Date.UTC(year, month - 2, 1));
  const next = new Date(Date.UTC(year, month, 1));
  const prevStr = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
  const nextStr = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
  const monthName = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en', { month: 'long', timeZone: 'UTC' });

  const myEvents = eventsForCompany(req.user.id);
  const inMonth = myEvents.filter(e => String(e.event_date || '').startsWith(ymStr));
  const byDay = {};
  for (const e of inMonth) {
    const day = parseInt(String(e.event_date).slice(8, 10), 10);
    (byDay[day] = byDay[day] || []).push(e);
  }
  // Grid: weeks start Monday.
  const firstDow = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7; // 0 = Monday
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const todayStr = today.toISOString().slice(0, 10);
  let cells = '';
  for (let i = 0; i < firstDow; i++) cells += '<div class="cal-cell cal-empty"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${ymStr}-${String(d).padStart(2, '0')}`;
    const evs = byDay[d] || [];
    cells += `<div class="cal-cell${dateStr === todayStr ? ' cal-today' : ''}">
      <div class="cal-day">${d}</div>
      ${evs.slice(0, 3).map((e, i) => `<a class="cal-event ${e.type === 'signing' ? 'cal-signing' : ''}" href="/calendar?m=${ymStr}#ev-${e.id}" style="--i:${i}" title="${esc(e.title)}${e.event_time ? ' ' + esc(e.event_time) : ''}">${esc(e.title.slice(0, 22))}</a>`).join('')}
      ${evs.length > 3 ? `<div class="muted" style="font-size:11px">+${evs.length - 3} more</div>` : ''}
    </div>`;
  }
  const dowHead = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<div class="cal-dow">${d}</div>`).join('');

  // Upcoming events list (from today forward), with join-call buttons for allowed viewers.
  const upcoming = myEvents.filter(e => String(e.event_date || '') >= todayStr).slice(0, 20);
  const upcomingHtml = upcoming.length ? upcoming.map((e, i) => {
    const parts = db.prepare('SELECT company_id FROM event_participants WHERE event_id = ?').all(e.id).map(p => names.get(p.company_id) || '?');
    const dealLink = e.type === 'signing' && e.deal_id ? ` · <a href="/deal/${e.deal_id}">linked deal / contract</a>` : '';
    return `<div class="card" data-reveal style="--i:${Math.min(i, 10)}" id="ev-${e.id}">
      <div class="feed-head">
        <h3>${e.type === 'signing' ? '✍️' : '📅'} ${esc(e.title)}</h3>
        <span class="badge ${e.type === 'signing' ? 'badge-sealed' : 'badge-pending'}">${esc(e.type)}</span>
      </div>
      <p class="muted" style="margin-top:6px">📆 ${esc(e.event_date)}${e.event_time ? ' · ' + esc(e.event_time) + ' UTC' : ''} · by ${esc(names.get(e.creator_company_id) || '?')}
        ${parts.length ? '<br>👥 ' + esc(parts.join(', ')) : ''}${dealLink}</p>
      ${e.notes ? `<p style="white-space:pre-wrap;margin-top:6px">${esc(e.notes)}</p>` : ''}
      ${canJoinEvent(req.user, e) && e.room ? `<div class="feed-actions"><a class="btn btn-sm btn-green" href="/calendar/join/${e.id}">🎥 Join call</a></div>` : ''}
    </div>`;
  }).join('') : '<div class="card"><p class="muted">No upcoming events — schedule a meeting or a signing below.</p></div>';

  // Create form: participants = approved companies multi-select; signing events can link a deal.
  const others = db.prepare(`SELECT id, name FROM companies WHERE status = 'approved' AND id != ? ORDER BY name LIMIT 200`).all(req.user.id);
  const checks = others.length
    ? others.map(c => `<label class="member-check"><input type="checkbox" name="participants" value="${c.id}">${esc(c.name)}</label>`).join('')
    : '<p class="muted">No other approved companies on the network yet.</p>';
  const myDeals = db.prepare(`SELECT id, title, deal_number FROM deals WHERE company_id = ? OR contract_party_id = ? ORDER BY created_at DESC LIMIT 50`).all(req.user.id, req.user.id);
  const dealOptions = ['<option value="">— none —</option>']
    .concat(myDeals.map(d => `<option value="${d.id}">${esc((d.deal_number ? d.deal_number + ' · ' : '') + d.title)}</option>`)).join('');

  const body = `
  <div class="feed-head" style="margin-bottom:10px">
    <div><div class="kicker">Meetings &amp; signings</div><h1 style="font-size:1.75rem;margin-top:4px">📅 Calendar — ${monthName} ${year}</h1></div>
    <div class="feed-actions" style="margin:0">
      <a class="btn btn-sm btn-outline" href="/calendar?m=${prevStr}">← Prev</a>
      <a class="btn btn-sm btn-outline" href="/calendar">Today</a>
      <a class="btn btn-sm btn-outline" href="/calendar?m=${nextStr}">Next →</a>
    </div>
  </div>
  <div class="card" data-reveal>
    <div class="cal-grid">${dowHead}${cells}</div>
  </div>
  <h3 class="sec-h">Upcoming</h3>
  ${upcomingHtml}
  <h3 class="sec-h">Schedule an event</h3>
  <div class="card" data-reveal>
    <form method="POST" action="/calendar">
      <label>Title</label><input type="text" name="title" required maxlength="160" placeholder="e.g. Contract signing — DZ-2025-0042">
      <div class="grid2" style="gap:10px">
        <div><label>Type</label><select name="type">${optionsHtml(['meeting', 'signing'], 'meeting')}</select></div>
        <div><label>Related deal (optional, for signings)</label><select name="deal_id">${dealOptions}</select></div>
      </div>
      <div class="grid2" style="gap:10px">
        <div><label>Date</label><input type="date" name="event_date" required value="${todayStr}"></div>
        <div><label>Time (UTC)</label><input type="time" name="event_time"></div>
      </div>
      <label>Notes (optional)</label><textarea name="notes" rows="3" maxlength="2000" placeholder="Agenda, documents to prepare…"></textarea>
      <label>Participant companies (they get notified)</label>
      <div style="max-height:200px;overflow:auto">${checks}</div>
      <button class="btn" type="submit" style="margin-top:10px">Create event</button>
      <p class="muted" style="margin-top:6px">Every event gets a private Jitsi video room — visible to participants and the admin only.</p>
    </form>
  </div>`;
  res.send(page('Calendar', body, req.user, req.query.msg, req.query.err, 'calendar'));
});

app.post('/calendar', requireCompany, (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 160);
  const type = req.body.type === 'signing' ? 'signing' : 'meeting';
  const date = String(req.body.event_date || '').trim();
  const time = String(req.body.event_time || '').trim().slice(0, 5);
  const notes = String(req.body.notes || '').trim().slice(0, 2000);
  if (!title) return res.redirect('/calendar?err=' + encodeURIComponent('Event title is required.'));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.redirect('/calendar?err=' + encodeURIComponent('Pick a valid date.'));
  if (time && !/^\d{2}:\d{2}$/.test(time)) return res.redirect('/calendar?err=' + encodeURIComponent('Pick a valid time.'));
  let dealId = parseInt(req.body.deal_id, 10) || null;
  if (dealId) {
    const d = db.prepare('SELECT id FROM deals WHERE id = ? AND (company_id = ? OR contract_party_id = ?)').get(dealId, req.user.id, req.user.id);
    if (!d) dealId = null;
  }
  let participants = req.body.participants || [];
  if (!Array.isArray(participants)) participants = [participants];
  const ids = [...new Set(participants.map(p => parseInt(p, 10)).filter(n => Number.isInteger(n) && n > 0 && n !== req.user.id))]
    .filter(id => db.prepare(`SELECT 1 FROM companies WHERE id = ? AND status = 'approved'`).get(id));

  const create = db.transaction(() => {
    const evId = db.prepare(`INSERT INTO events (creator_company_id, title, type, event_date, event_time, notes, room, deal_id, created_at)
      VALUES (?,?,?,?,?,?, '', ?, ?)`).run(req.user.id, title, type, date, time, notes, type === 'signing' ? dealId : null, now()).lastInsertRowid;
    const room = `Dealzoin-${evId}-${crypto.randomBytes(4).toString('hex')}`;
    db.prepare('UPDATE events SET room = ? WHERE id = ?').run(room, evId);
    const ins = db.prepare('INSERT OR IGNORE INTO event_participants (event_id, company_id) VALUES (?,?)');
    for (const id of ids) ins.run(evId, id);
    return evId;
  });
  const evId = create();
  audit('CALENDAR AGENT', 'event created', 'pass', `${req.user.name} scheduled ${type} "${title.slice(0, 60)}" on ${date} ${time || ''} with ${ids.length} participant(s)`);
  for (const id of ids) {
    notify(id, 'event', `${req.user.name} invited you to ${type === 'signing' ? 'a signing' : 'a meeting'} "${title}" on ${date}${time ? ' ' + time + ' UTC' : ''}. See your calendar for the video room.`, '/calendar#ev-' + evId);
  }
  res.redirect('/calendar?msg=' + encodeURIComponent(`Event created${ids.length ? ` — ${ids.length} participant(s) notified` : ''}.`));
});

// Join gate: participants + creator + admin only; everyone else gets 403.
app.get('/calendar/join/:id', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.redirect('/login?err=' + encodeURIComponent('Please sign in.'));
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!ev) return res.status(404).send(page('Not found', '<div class="card"><h2>Event not found</h2></div>', user));
  if (!canJoinEvent(user, ev)) {
    audit('CALENDAR AGENT', 'join call guard', 'fail', `Unauthorized join attempt on event #${ev.id} by ${user.isAdmin ? 'admin?' : user.name}`);
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Private call</h2><p class="muted">Only event participants and the admin can join this call.</p></div>', user));
  }
  audit('CALENDAR AGENT', 'join call', 'pass', `${user.isAdmin ? 'Admin' : user.name} joined the call for event #${ev.id} ("${ev.title.slice(0, 60)}")`);
  res.redirect(`https://meet.jit.si/${encodeURIComponent(ev.room)}`);
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
                      count(`SELECT COUNT(*) AS n FROM private_contracts WHERE status = 'pending_admin'`) +
                      count(`SELECT COUNT(*) AS n FROM negotiations WHERE state = 'PENDING_ADMIN'`),
    follows: count('SELECT COUNT(*) AS n FROM follows')
  };
  // Platform commission: the live admin-adjustable pct of the summed value of approved (finalized) deals, per currency.
  const feePct = platformFeePct();
  const approvedDeals = db.prepare(`SELECT value, currency FROM deals WHERE contract_state = 'approved'`).all();
  const feeByCurrency = {};
  for (const d of approvedDeals) {
    const num = parseDealValue(d.value);
    if (!isFinite(num) || num <= 0) continue;
    const cur = d.currency || 'USD';
    feeByCurrency[cur] = (feeByCurrency[cur] || 0) + num * feePct / 100;
  }
  const feeCurrencies = Object.keys(feeByCurrency).sort();
  const commissionText = feeCurrencies.length
    ? feeCurrencies.map(cur => `${esc(cur)} ${fmtAmount(feeByCurrency[cur])}`).join(' · ')
    : '—';
  const statsHtml = `<div class="stats">${[
    ['Total companies', stats.companies, ''], ['Pending', stats.pending, ''], ['Approved', stats.approved, ' mint'],
    ['Flagged ⚠️', stats.flagged, ''], ['Deals', stats.deals, ' gold'], ['Contracts pending', stats.contractsPending, ' gold'],
    ['Follows', stats.follows, '']
  ].map(([l, n, cls], ti) => `<div class="stat" data-reveal style="--i:${Math.min(ti, 10)}"><div class="num${cls}" data-count="${n}">${n}</div><div class="lbl">${l}</div></div>`).join('')}
    <div class="stat" data-reveal style="--i:7"><div class="num gold" style="font-size:1.15rem;line-height:1.4">${commissionText}</div><div class="lbl">Platform commission (approved deals) · ${feePct}%</div></div></div>`;

  // Pending companies queue (with ONBOARDING AGENT flags + KYC documents reviewed inline)
  const pending = db.prepare(`SELECT * FROM companies WHERE status = 'pending' ORDER BY created_at ASC`).all();
  const pendingHtml = pending.length ? pending.map(c => {
    const docs = db.prepare('SELECT * FROM documents WHERE company_id = ? ORDER BY id ASC').all(c.id);
    const docsHtml = docs.length ? `<div style="margin-top:8px">${docs.map(d => `
        <div style="padding:5px 0;border-top:1px dashed var(--border-soft)">
          📄 <b>${esc(DOC_TYPE_LABELS[d.doc_type] || d.doc_type)}</b>
          <a href="/admin/documents/${d.id}/download">${esc(d.filename || 'document.pdf')}</a>
          <span class="muted">(${(d.data.length / 1024).toFixed(1)} KB)</span><br>
          ${authenticityBadge(d.authenticity_status, d.authenticity_notes)}
        </div>`).join('')}</div>`
      : '<div class="flag-note" style="margin-top:6px">⚠️ No KYC documents uploaded.</div>';
    return `
    <tr>
      <td><b>${esc(c.name)}</b> ${c.flagged ? '<span class="warn-badge"><i class="warn-ic">⚠️</i> flagged</span>' : ''}<br>
        <span class="muted">${esc(c.email)}${c.website ? ' · <a href="' + esc(c.website) + '" rel="noopener noreferrer nofollow">' + esc(c.website) + '</a>' : ''}</span><br>
        <span class="muted">${c.category ? 'Category: <b>' + esc(c.category) + '</b> · ' : ''}${c.trade_license ? 'Trade license: <b>' + esc(c.trade_license) + '</b>' : 'Trade license: <span class="flag-note">missing</span>'}</span>
        ${c.activity ? `<br><span class="muted">Activity: ${esc(c.activity)}</span>` : ''}
        ${c.signature_name ? `<br><span class="muted">Signed by: ${esc(c.signature_name)} · ${esc((c.signature_at || '').slice(0, 16).replace('T', ' '))} UTC · IP ${esc(c.signature_ip || '—')}</span>` : ''}
        ${c.flagged ? `<br><span class="flag-note">${esc(c.flag_reasons)}</span>` : ''}
        ${docsHtml}</td>
      <td class="muted">${esc(c.created_at.slice(0, 10))}</td>
      <td style="white-space:nowrap">
        <form method="POST" action="/admin/companies/${c.id}/approve" style="display:inline"><button class="btn btn-sm btn-green">Approve</button></form>
        <form method="POST" action="/admin/companies/${c.id}/reject" style="display:inline"><button class="btn btn-sm btn-danger">Reject</button></form>
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="3" class="muted">No pending reviews. The agents are holding the fort. 🛡️</td></tr>';

  // Final approval queue — ONLY contracts the deal owner has already approved (state: pending_admin).
  const names = companyNameMap();
  const pendingContracts = db.prepare(`SELECT * FROM contracts WHERE status = 'pending_admin' AND negotiation_id IS NULL ORDER BY signed_at ASC`).all();
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

  // Stage C: negotiation final-approval queue — shows the agreed commission split + amounts.
  const pendingNegs = db.prepare(`SELECT * FROM negotiations WHERE state = 'PENDING_ADMIN' ORDER BY updated_at ASC`).all();
  const negRows = pendingNegs.map(n => {
    const deal = db.prepare('SELECT title, deal_number FROM deals WHERE id = ?').get(n.deal_id);
    const f = negFeeBreakdown(n);
    const splitLabel = NEG_SPLITS[n.commission_split] || n.commission_split;
    const amounts = isFinite(f.fee)
      ? `${f.pct}% = <b>${fmtAmount(f.fee)} ${esc(f.cur)}</b> — buyer ${fmtAmount(f.buyer)} · seller ${fmtAmount(f.seller)} ${esc(f.cur)}`
      : `${f.pct}% of ${esc(n.offer_value)} ${esc(n.offer_currency || 'USD')}`;
    return `<tr>
      <td><b>${esc(deal ? deal.title : '(deal removed)')}</b> <span class="muted">№ ${esc(deal ? (deal.deal_number || String(n.deal_id)) : String(n.deal_id))} · neg #${n.id} · round ${n.round}</span></td>
      <td>${esc(names.get(n.seller_id) || '?')} ⇄ ${esc(names.get(n.buyer_id) || '?')}</td>
      <td><b>${esc(splitLabel)}</b><br><span class="muted">${amounts}</span></td>
      <td style="white-space:nowrap">
        <a class="btn btn-sm btn-outline" href="/negotiation/${n.id}">View</a>
        <form method="POST" action="/admin/negotiations/${n.id}/approve" style="display:inline"><button class="btn btn-sm btn-green">Approve</button></form>
        <form method="POST" action="/admin/negotiations/${n.id}/reject" style="display:inline"><button class="btn btn-sm btn-danger">Reject</button></form>
      </td>
    </tr>`;
  });
  const negsTableHtml = negRows.length ? negRows.join('') : '<tr><td colspan="4" class="muted">No negotiations awaiting final approval. Negotiations land here once both parties agree the commission split.</td></tr>';

  // All companies (suspend / reactivate / delete / reputation / research)
  const allCompanies = db.prepare('SELECT * FROM companies ORDER BY created_at DESC LIMIT 100').all();
  const companiesHtml = allCompanies.map(c => {
    const actions = [];
    if (c.status === 'approved') actions.push(`<form method="POST" action="/admin/companies/${c.id}/suspend" style="display:inline"><button class="btn btn-sm btn-outline">Suspend</button></form>`);
    if (c.status === 'suspended' || c.status === 'rejected') actions.push(`<form method="POST" action="/admin/companies/${c.id}/reactivate" style="display:inline"><button class="btn btn-sm btn-green">Reactivate</button></form>`);
    actions.push(`<a class="btn btn-sm btn-danger" href="/admin/companies/${c.id}/delete">Delete</a>`);
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
  <div class="feed-actions" style="margin:0 0 14px"><a class="btn btn-sm btn-outline" href="/admin/documents">🗄️ Document vault</a></div>
  ${statsHtml}
  <div class="card" data-reveal><h3>Pending companies</h3>
    <table><tr><th>Company</th><th>Registered</th><th>Actions</th></tr>${pendingHtml}</table></div>
  <div class="card" data-reveal><h3>Pending contracts — final approval</h3>
    <table><tr><th>Deal</th><th>Parties</th><th>Signed at</th><th>Actions</th></tr>${contractsHtml}</table></div>
  <div class="card" data-reveal><h3>🤝 Pending negotiations — final approval (commission split)</h3>
    <table><tr><th>Deal</th><th>Parties</th><th>Split &amp; commission</th><th>Actions</th></tr>${negsTableHtml}</table></div>
  <div class="card" data-reveal><h3>All companies</h3>
    <table><tr><th>Company</th><th>Status</th><th>Reputation</th><th>Actions</th></tr>${companiesHtml}</table></div>
  <div class="card" data-reveal><h3>All deals</h3>
    <table><tr><th>Deal</th><th>Actions</th></tr>${dealsHtml}</table></div>
  <div class="card"><h3>Change admin password</h3>
    <form method="POST" action="/admin/password" style="max-width:380px">
      <label>Current password</label><input type="password" name="current" required>
      <label>New password (min 10 characters)</label><input type="password" name="next" required minlength="10">
      <button class="btn btn-sm" type="submit">Update password</button>
      <p class="muted" style="margin-top:8px">Stored as a salted hash in the settings table; the env var remains a fallback until changed.</p>
    </form></div>
  <div class="card" data-reveal><h3>⚙️ Platform settings</h3>
    <form method="POST" action="/admin/settings/commission" style="max-width:380px">
      <label>Platform commission (%) — currently <b style="color:var(--gold)">${feePct}%</b></label>
      <input type="number" name="platform_fee_pct" min="0.1" max="20" step="0.1" value="${feePct}" required>
      <button class="btn btn-sm" type="submit">Update commission</button>
      <p class="muted" style="margin-top:8px">Between 0.1% and 20%. Applied immediately to deal pages, contracts, documents and the commission tile. Changes are audit-logged.</p>
    </form></div>
  <div class="card" data-reveal><h3>🤖 Agent activity (latest 50)</h3>
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
// ----- 3-step company deletion (replaces one-click delete) -----
/** Cascade-wipe ALL company data, including KYC documents. */
function wipeCompanyData(id) {
  const wipe = db.transaction(() => {
    const dealIds = db.prepare('SELECT id FROM deals WHERE company_id = ?').all(id).map(r => r.id);
    const postIds = db.prepare('SELECT id FROM posts WHERE company_id = ?').all(id).map(r => r.id);
    for (const d of dealIds) {
      db.prepare(`DELETE FROM likes WHERE target_type = 'deal' AND target_id = ?`).run(d);
      db.prepare(`DELETE FROM comments WHERE target_type = 'deal' AND target_id = ?`).run(d);
      db.prepare('DELETE FROM reposts WHERE deal_id = ?').run(d);
      db.prepare('DELETE FROM contracts WHERE deal_id = ?').run(d);
      db.prepare('DELETE FROM counter_offers WHERE deal_id = ?').run(d);
      db.prepare('DELETE FROM deal_documents WHERE deal_id = ?').run(d);
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
    db.prepare('DELETE FROM documents WHERE company_id = ?').run(id);
    db.prepare('DELETE FROM deal_documents WHERE company_id = ?').run(id);
    // Remove the company from all conversations (their messages keep attribution as "Unknown").
    db.prepare('DELETE FROM conversation_members WHERE company_id = ?').run(id);
    db.prepare('DELETE FROM companies WHERE id = ?').run(id);
  });
  wipe();
}

function deleteStepPage(c, inner, user, msg, err) {
  return page('Delete company', `
  <div class="card" style="max-width:560px;margin:0 auto;border-color:var(--err-border)">
    <div class="kicker" style="color:var(--danger)">Danger zone · irreversible</div>
    <h2 style="margin:6px 0 10px">🗑️ Delete ${esc(c.name)}</h2>
    ${inner}
    <hr class="sep">
    <a class="btn btn-outline" href="/admin/dashboard">✕ Abort — back to dashboard</a>
  </div>`, user, msg, err);
}

// Step 1 (GET): type the exact company name.
app.get('/admin/companies/:id/delete', requireAdmin, (req, res) => {
  const c = db.prepare('SELECT * FROM companies WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!c) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Company not found.'));
  audit('ONBOARDING AGENT', 'delete company step 1', 'flag', `Admin opened deletion flow for "${c.name}"`);
  res.send(deleteStepPage(c, `
    <p class="muted" style="margin-bottom:12px"><b>Step 1 of 3.</b> This permanently deletes the company and ALL associated data — deals, posts, contracts, documents, sessions. Type the exact company name to continue:</p>
    <p style="margin-bottom:10px"><b>${esc(c.name)}</b></p>
    <form method="POST" action="/admin/companies/${c.id}/delete">
      <label>Company name (exact match)</label>
      <input type="text" name="confirm_name" required maxlength="120" autocomplete="off" placeholder="${esc(c.name)}">
      <button class="btn btn-danger" type="submit">Continue →</button>
    </form>`, req.user, req.query.msg, req.query.err));
});

// Step 2 (POST): name verified — now require admin password + acknowledgment checkbox.
app.post('/admin/companies/:id/delete', requireAdmin, (req, res) => {
  const c = db.prepare('SELECT * FROM companies WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!c) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Company not found.'));
  const typed = String(req.body.confirm_name || '').trim();
  if (typed !== c.name) {
    audit('ONBOARDING AGENT', 'delete company step 1', 'fail', `Deletion of "${c.name}" aborted at step 1 — name mismatch ("${typed.slice(0, 60)}")`);
    return res.redirect(`/admin/companies/${c.id}/delete?err=` + encodeURIComponent('The typed name does not match the company name exactly. Deletion aborted.'));
  }
  audit('ONBOARDING AGENT', 'delete company step 2', 'flag', `Admin confirmed company name for deletion of "${c.name}" — awaiting password + acknowledgment`);
  res.send(deleteStepPage(c, `
    <p class="muted" style="margin-bottom:12px"><b>Step 2 of 3.</b> Company name confirmed. Re-enter your admin password and acknowledge the consequences:</p>
    <form method="POST" action="/admin/companies/${c.id}/delete/verify">
      <input type="hidden" name="confirm_name" value="${esc(c.name)}">
      <label>Admin password</label>
      <input type="password" name="admin_password" required autocomplete="current-password">
      <label style="display:flex;gap:8px;align-items:flex-start;margin:10px 0;font-weight:500;color:var(--ink-primary)">
        <input type="checkbox" name="understand" value="yes" style="width:auto;margin:3px 0 0" required>
        <span>I understand this permanently deletes all data</span></label>
      <button class="btn btn-danger" type="submit">Continue →</button>
    </form>`, req.user, req.query.msg, req.query.err));
});

// Step 3 (POST): password + checkbox verified — final confirmation screen.
app.post('/admin/companies/:id/delete/verify', requireAdmin, (req, res) => {
  const c = db.prepare('SELECT * FROM companies WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!c) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Company not found.'));
  if (String(req.body.confirm_name || '').trim() !== c.name) {
    return res.redirect(`/admin/companies/${c.id}/delete?err=` + encodeURIComponent('Confirmation mismatch. Please start the deletion again.'));
  }
  if (!adminPasswordOk(String(req.body.admin_password || ''))) {
    audit('ONBOARDING AGENT', 'delete company step 2', 'fail', `Deletion of "${c.name}" aborted at step 2 — wrong admin password`);
    return res.redirect(`/admin/companies/${c.id}/delete?err=` + encodeURIComponent('Wrong admin password. Deletion aborted.'));
  }
  if (req.body.understand !== 'yes') {
    audit('ONBOARDING AGENT', 'delete company step 2', 'fail', `Deletion of "${c.name}" aborted at step 2 — acknowledgment checkbox not ticked`);
    return res.redirect(`/admin/companies/${c.id}/delete?err=` + encodeURIComponent('You must acknowledge the permanent deletion. Deletion aborted.'));
  }
  audit('ONBOARDING AGENT', 'delete company step 3', 'flag', `Admin passed password + acknowledgment for deletion of "${c.name}" — final confirmation shown`);
  res.send(deleteStepPage(c, `
    <p class="muted" style="margin-bottom:12px"><b>Step 3 of 3 — final confirmation.</b> Identity verified. Press the button below to permanently erase <b>${esc(c.name)}</b> and every piece of their data. There is no undo.</p>
    <form method="POST" action="/admin/companies/${c.id}/delete/execute">
      <input type="hidden" name="confirm_name" value="${esc(c.name)}">
      <button class="btn btn-danger" type="submit">🗑️ Permanently delete ${esc(c.name)}</button>
    </form>`, req.user, req.query.msg, req.query.err));
});

// Execute (POST): re-verify name, then cascade-wipe everything (including documents).
app.post('/admin/companies/:id/delete/execute', requireAdmin, (req, res) => {
  const c = db.prepare('SELECT * FROM companies WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!c) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Company not found.'));
  if (String(req.body.confirm_name || '').trim() !== c.name) {
    return res.redirect(`/admin/companies/${c.id}/delete?err=` + encodeURIComponent('Confirmation mismatch. Deletion aborted.'));
  }
  wipeCompanyData(c.id);
  audit('ONBOARDING AGENT', 'admin delete company', 'fail', `Admin deleted "${c.name}" and all associated data (3-step flow completed)`);
  res.redirect('/admin/dashboard?msg=' + encodeURIComponent(`Deleted ${c.name} and all their data.`));
});

// ----- Admin document vault: every KYC document, with authenticity badges -----
app.get('/admin/documents', requireAdmin, (req, res) => {
  const docs = db.prepare(`
    SELECT d.*, c.name AS company_name FROM documents d
    LEFT JOIN companies c ON c.id = d.company_id
    ORDER BY d.created_at DESC LIMIT 500`).all();
  const rows = docs.length ? docs.map((d, i) => `
    <tr data-reveal style="--i:${Math.min(i, 10)}">
      <td><b>${esc(d.company_name || '(deleted company)')}</b></td>
      <td>${esc(DOC_TYPE_LABELS[d.doc_type] || d.doc_type)}</td>
      <td><a href="/admin/documents/${d.id}/download">${esc(d.filename || 'document.pdf')}</a><br>
        <span class="muted">sha256 ${esc((d.sha256 || '').slice(0, 16))}…</span></td>
      <td class="muted">${(d.data.length / 1024).toFixed(1)} KB</td>
      <td>${authenticityBadge(d.authenticity_status, d.authenticity_notes)}</td>
      <td class="muted" style="white-space:nowrap">${esc(d.created_at.slice(0, 16).replace('T', ' '))}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="muted">No documents uploaded yet.</td></tr>';
  const body = `
  <h2 class="sec-h" style="margin-top:0;margin-bottom:14px">🗄️ Document vault</h2>
  <div class="feed-actions" style="margin:0 0 14px"><a class="btn btn-sm btn-outline" href="/admin/dashboard">← Back to dashboard</a></div>
  <div class="card" data-reveal>
    <p class="muted" style="margin-bottom:12px">All KYC documents uploaded at registration, screened by the Document Authenticity Agent. Downloads are admin-only; each company can also download its own documents via <span class="muted">/documents/:id</span>.</p>
    <table><tr><th>Company</th><th>Type</th><th>File</th><th>Size</th><th>Authenticity</th><th>Uploaded (UTC)</th></tr>${rows}</table>
  </div>`;
  res.send(page('Document vault', body, req.user, req.query.msg, req.query.err));
});

app.get('/admin/documents/:id/download', requireAdmin, (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!doc) return res.redirect('/admin/documents?err=' + encodeURIComponent('Document not found.'));
  audit('DOCUMENT AGENT', 'document access', 'pass', `Admin downloaded document #${doc.id} (${doc.doc_type}, "${doc.filename}")`);
  res.setHeader('Content-Type', doc.mime || 'application/pdf');
  res.setHeader('Content-Length', doc.data.length);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', `attachment; filename="${String(doc.filename || 'document.pdf').replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  res.send(doc.data);
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
    ${c.trade_license ? `<p class="muted" style="margin-bottom:12px">🪪 Trade license: <b>${esc(c.trade_license)}</b></p>` : ''}
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
    audit('RESEARCH AGENT', 'research run', 'pass', `Research for "${c.name}" — Wikipedia summary found${c.field ? ' (field kept: already set)' : `, suggested field: "${suggestion}"`}${sourceUrl ? ', source: ' + sourceUrl : ''}. Trade license: ${c.trade_license || 'not provided'}`);
  } else {
    audit('RESEARCH AGENT', 'research run', 'fail', `Research for "${c.name}" — no public summary found (${failReason || 'not found'}). Trade license: ${c.trade_license || 'not provided'}`);
  }

  // Trust & KYC upgrade: mine the company's uploaded profile PDF for field/employees hints.
  let profileNote = '';
  try {
    const profileDoc = db.prepare(`SELECT * FROM documents WHERE company_id = ? AND doc_type = 'profile_pdf' ORDER BY id DESC LIMIT 1`).get(c.id);
    if (profileDoc) {
      const parsed = await extractPdfText(profileDoc.data);
      if (parsed && parsed.text.trim()) {
        const g = guessesFromProfileText(parsed.text);
        if (!c.field && g.activity) {
          db.prepare('UPDATE companies SET field = ? WHERE id = ?').run(g.activity.slice(0, 200), c.id);
          profileNote += `field suggested from profile PDF: "${g.activity.slice(0, 80)}"`;
        }
        if (!c.employees && g.employees) {
          db.prepare('UPDATE companies SET employees = ? WHERE id = ?').run(g.employees.slice(0, 80), c.id);
          profileNote += `${profileNote ? '; ' : ''}employees suggested from profile PDF: "${g.employees}"`;
        }
        if (profileNote) audit('RESEARCH AGENT', 'profile PDF mining', 'pass', `Research for "${c.name}" — ${profileNote}. Trade license: ${c.trade_license || 'not provided'}`);
        else audit('RESEARCH AGENT', 'profile PDF mining', 'pass', `Research for "${c.name}" — profile PDF contained no new field/employee hints. Trade license: ${c.trade_license || 'not provided'}`);
      } else {
        audit('RESEARCH AGENT', 'profile PDF mining', 'flag', `Research for "${c.name}" — profile PDF has no extractable text. Trade license: ${c.trade_license || 'not provided'}`);
      }
    }
  } catch (e) {
    audit('RESEARCH AGENT', 'profile PDF mining', 'fail', `Research for "${c.name}" — profile PDF mining error: ${e.message}`);
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
    db.prepare('DELETE FROM deal_documents WHERE deal_id = ?').run(d.id);
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
  if (ct.negotiation_id) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Negotiation-linked contracts are approved from the negotiations queue below.'));
  if (ct.status !== 'pending_admin') {
    return res.redirect('/admin/dashboard?err=' + encodeURIComponent('This contract is not awaiting final approval (owner must approve first).'));
  }
  // 1) Mark the deal as approved, record the signing party on the deal, and close the status pipeline.
  const signer = db.prepare('SELECT name FROM companies WHERE id = ?').get(ct.signer_company_id);
  const party = signer ? signer.name : 'Unknown';
  const dealRow = db.prepare('SELECT title FROM deals WHERE id = ?').get(ct.deal_id);
  const dealTitle = dealRow ? dealRow.title : 'deal #' + ct.deal_id;
  db.prepare(`UPDATE deals SET contract_state = 'approved', contract_party = ?, contract_party_id = ?, status = 'closed' WHERE id = ?`)
    .run(party, ct.signer_company_id, ct.deal_id);
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
  if (ct.negotiation_id) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Negotiation-linked contracts are rejected from the negotiations queue below.'));
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
  postCongrats(pc.title, '', names.get(pc.sender_company_id) || 'Sender', names.get(pc.recipient_company_id) || 'Recipient');
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

// ----- Platform settings: adjustable commission (0.1–20%), audit-logged old→new -----
app.post('/admin/settings/commission', requireAdmin, (req, res) => {
  const pct = parseFloat(String(req.body.platform_fee_pct || '').replace(',', '.'));
  if (!isFinite(pct) || pct < 0.1 || pct > 20) {
    return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Commission must be a number between 0.1 and 20.'));
  }
  const rounded = Math.round(pct * 100) / 100;
  const old = platformFeePct();
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('platform_fee_pct', String(rounded));
  audit('ADMIN', 'platform commission change', 'pass', `Platform fee changed from ${old}% to ${rounded}%`);
  res.redirect('/admin/dashboard?msg=' + encodeURIComponent(`Platform commission updated from ${old}% to ${rounded}%.`));
});

// ----- Admin final approval for negotiations (split + amounts shown in the queue) -----
app.post('/admin/negotiations/:id/approve', requireAdmin, (req, res) => {
  const neg = getNegotiation(req.params.id);
  if (!neg) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Negotiation not found.'));
  if (neg.state !== 'PENDING_ADMIN') {
    return res.redirect('/admin/dashboard?err=' + encodeURIComponent('This negotiation is not awaiting final approval.'));
  }
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(neg.deal_id);
  const names = companyNameMap();
  const buyerName = names.get(neg.buyer_id) || 'Unknown';
  const sellerName = names.get(neg.seller_id) || 'Unknown';
  const dealTitle = deal ? deal.title : 'deal #' + neg.deal_id;
  const f = negFeeBreakdown(neg);
  const splitLabel = NEG_SPLITS[neg.commission_split] || NEG_SPLITS['50-50'];
  const feeNote = isFinite(f.fee)
    ? ` Commission due before deal processing: ${fmtAmount(f.fee)} ${f.cur} (${splitLabel} — buyer ${fmtAmount(f.buyer)} ${f.cur}, seller ${fmtAmount(f.seller)} ${f.cur}).`
    : ` The ${f.pct}% platform commission (${splitLabel}) is due before deal processing.`;
  const finalize = db.transaction(() => {
    // 1) Mark the deal as approved, record the buyer on the deal, close the status pipeline.
    db.prepare(`UPDATE deals SET contract_state = 'approved', contract_party = ?, contract_party_id = ?, status = 'closed' WHERE id = ?`)
      .run(buyerName, neg.buyer_id, neg.deal_id);
    // 2) Archive the signature record (same pattern as the legacy contract queue).
    db.prepare('DELETE FROM contracts WHERE negotiation_id = ?').run(neg.id);
    // 3) Close the negotiation.
    db.prepare(`UPDATE negotiations SET state = 'DONE', updated_at = ? WHERE id = ?`).run(now(), neg.id);
  });
  finalize();
  negEvent(neg.id, null, 'admin_approved', { note: `Split: ${splitLabel}` });
  audit('CONTRACT AGENT', 'admin approve negotiation', 'pass', `Negotiation #${neg.id} (deal ${deal ? deal.deal_number || deal.id : neg.deal_id}) approved by admin — DONE. Split: ${splitLabel}.${isFinite(f.fee) ? ` Fee ${fmtAmount(f.fee)} ${f.cur} (buyer ${fmtAmount(f.buyer)}, seller ${fmtAmount(f.seller)}).` : ''}`);
  notify(neg.buyer_id, 'deal_closed', `Final approval granted — "${dealTitle}" is finalized. Deal closed! 🎉${feeNote}`, `/negotiation/${neg.id}`);
  notify(neg.seller_id, 'deal_closed', `Final approval granted — "${dealTitle}" is finalized. Deal closed! 🎉${feeNote}`, `/negotiation/${neg.id}`);
  postCongrats(dealTitle, deal ? (deal.deal_number || '') : '', sellerName, buyerName);
  res.redirect('/admin/dashboard?msg=' + encodeURIComponent('Negotiation approved — deal closed, both parties notified, congratulations posted.'));
});

app.post('/admin/negotiations/:id/reject', requireAdmin, (req, res) => {
  const neg = getNegotiation(req.params.id);
  if (!neg) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Negotiation not found.'));
  if (neg.state !== 'PENDING_ADMIN') {
    return res.redirect('/admin/dashboard?err=' + encodeURIComponent('This negotiation is not awaiting final approval.'));
  }
  const deal = db.prepare('SELECT title FROM deals WHERE id = ?').get(neg.deal_id);
  const reject = db.transaction(() => {
    db.prepare(`UPDATE negotiations SET state = 'REJECTED', updated_at = ? WHERE id = ?`).run(now(), neg.id);
    db.prepare(`UPDATE contracts SET status = 'rejected', decided_at = ? WHERE negotiation_id = ?`).run(now(), neg.id);
  });
  reject();
  negEvent(neg.id, null, 'admin_rejected');
  audit('CONTRACT AGENT', 'admin reject negotiation', 'fail', `Negotiation #${neg.id} (deal #${neg.deal_id}) rejected by admin at final approval`);
  notify(neg.buyer_id, 'negotiation_rejected', `An admin rejected the contract on "${deal ? deal.title : 'deal #' + neg.deal_id}" at final approval.`, `/negotiation/${neg.id}`);
  notify(neg.seller_id, 'negotiation_rejected', `An admin rejected the contract on "${deal ? deal.title : 'deal #' + neg.deal_id}" at final approval.`, `/negotiation/${neg.id}`);
  res.redirect('/admin/dashboard?msg=' + encodeURIComponent('Negotiation rejected.'));
});

// ============================= 404 & SERVER START =============================
app.use((req, res) => {
  res.status(404).send(page('Not found', '<div class="card"><h2>404 — page not found</h2><p class="muted"><a href="/">Back to home</a></p></div>', currentUser(req)));
});

app.listen(PORT, () => {
  console.log(`Dealzoin listening on http://localhost:${PORT}`);
  console.log(`Admin login: ${ADMIN_EMAIL} (env-configured)${BREVO_API_KEY ? '' : ' — DEMO MODE: verification codes shown on screen'}`);
});
