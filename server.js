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

// Shipment tracking map: optional destination + lazily-resolved geocoordinates for origin/destination.
try { db.exec("ALTER TABLE deals ADD COLUMN destination TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE deals ADD COLUMN dest_lat REAL'); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE deals ADD COLUMN dest_lng REAL'); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE deals ADD COLUMN origin_lat REAL'); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE deals ADD COLUMN origin_lng REAL'); } catch (e) { /* column already exists */ }

// Persistent geocoding cache (Nominatim lookups are lazy and cached forever; failures are not cached).
db.exec(`
CREATE TABLE IF NOT EXISTS geocache (
  place      TEXT PRIMARY KEY,
  lat        REAL,
  lng        REAL,
  created_at TEXT NOT NULL
);
`);
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
  room               TEXT DEFAULT '',              -- legacy room slug (deprecated — calls are native in-platform rooms now)
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

// Batch A upgrades (old databases keep booting):
// T&C versioning + re-agreement, cargo capacity on deals, LOI response deadlines,
// seller-chosen offer incoterm, per-company palette choice.
try { db.exec('ALTER TABLE companies ADD COLUMN agreed_terms_version INTEGER DEFAULT 0'); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE companies ADD COLUMN agreed_at TEXT'); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE companies ADD COLUMN theme_choice TEXT DEFAULT 'titan'"); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE companies ADD COLUMN theme_custom TEXT'); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE deals ADD COLUMN cargo_qty REAL'); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE deals ADD COLUMN cargo_unit TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE negotiations ADD COLUMN loi_expires_at TEXT'); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE negotiations ADD COLUMN offer_incoterm TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }
// Incoterm migrations: 'CRF' was a typo for CFR; FOP was removed from the platform (all deals are platform-tracked now).
try { db.exec("UPDATE deals SET incoterm = 'CFR' WHERE incoterm = 'CRF'"); } catch (e) { /* best-effort */ }
try { db.exec("UPDATE negotiations SET offer_incoterm = 'CFR' WHERE offer_incoterm = 'CRF'"); } catch (e) { /* best-effort */ }
try { db.exec("UPDATE deals SET incoterm = 'CIF' WHERE incoterm = 'FOP'"); } catch (e) { /* best-effort */ }
try { db.exec("UPDATE negotiations SET offer_incoterm = 'CIF' WHERE offer_incoterm = 'FOP'"); } catch (e) { /* best-effort */ }

// Commission payment gate (old databases keep booting; finalized legacy deals stay 'none' = unaffected).
try { db.exec("ALTER TABLE deals ADD COLUMN payment_status TEXT DEFAULT 'none'"); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE deals ADD COLUMN payment_split TEXT'); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE deals ADD COLUMN payment_fee REAL'); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE deals ADD COLUMN payment_currency TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }

// ============================= BATCH B — payments flow design =============================
// (3)+(4) Escrow flow design: the buyer's receipt confirmation is REAL data (timestamp on the deal),
// only the money movement is simulated. escrow_dispute_at records an open dispute flag.
try { db.exec('ALTER TABLE deals ADD COLUMN buyer_received_confirmed_at TEXT'); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE deals ADD COLUMN escrow_dispute_at TEXT'); } catch (e) { /* column already exists */ }
// (5) Split-payment milestones agreed during SPLIT_NEGO — JSON array on the finalized deal,
// proposal parked on the negotiation while the parties negotiate.
try { db.exec('ALTER TABLE deals ADD COLUMN payment_milestones TEXT'); } catch (e) { /* column already exists */ }
try { db.exec('ALTER TABLE negotiations ADD COLUMN milestone_proposal TEXT'); } catch (e) { /* column already exists */ }

// Milestone release requests: advancing the shipment status onto an agreed payment milestone
// raises an admin approval request (approve/deny the release). The money itself is flow-preview.
db.exec(`CREATE TABLE IF NOT EXISTS milestone_releases (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id      INTEGER NOT NULL,
  ms_index     INTEGER NOT NULL,                 -- index into deals.payment_milestones
  label        TEXT NOT NULL,
  pct          INTEGER NOT NULL,
  amount       REAL,                             -- pct x agreed value (display only)
  currency     TEXT DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending_admin',  -- pending_admin | released | denied
  triggered_by TEXT DEFAULT '',
  admin_note   TEXT DEFAULT '',
  created_at   TEXT NOT NULL,
  decided_at   TEXT,
  UNIQUE(deal_id, ms_index)
)`);
// (6) Receiving-country shipment agent: JSON nomination on the deal + a updates log table.
try { db.exec('ALTER TABLE deals ADD COLUMN receiving_agent TEXT'); } catch (e) { /* column already exists */ }
db.exec(`CREATE TABLE IF NOT EXISTS receiving_updates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id    INTEGER NOT NULL,
  company_id INTEGER,               -- who logged the update (nominating party or NULL for admin)
  note       TEXT NOT NULL,
  created_at TEXT NOT NULL
)`);

// Manual commission-payment confirmations (party → admin review). deal_id is NULL for private-contract
// payments (private contracts have no deal row); private_contract_id is NULL for deal payments.
db.exec(`CREATE TABLE IF NOT EXISTS commission_payments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id             INTEGER,
  private_contract_id INTEGER,
  company_id          INTEGER NOT NULL,
  amount              REAL NOT NULL DEFAULT 0,
  currency            TEXT NOT NULL DEFAULT 'USD',
  note                TEXT DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  created_at          TEXT NOT NULL,
  decided_at          TEXT
)`);
// Batch B (1): payment-proof PDFs attached to commission_payments rows. NOTE: these ALTERs must run
// AFTER the CREATE TABLE above — on a fresh database the table does not exist before this point.
try { db.exec('ALTER TABLE commission_payments ADD COLUMN proof_media_id INTEGER'); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE commission_payments ADD COLUMN proof_filename TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }

// ============================= BATCH C SCHEMA =============================
// (7) Interface language on companies; (3) company bank details + BANK RESEARCH AGENT verdict.
try { db.exec("ALTER TABLE companies ADD COLUMN lang TEXT DEFAULT 'en'"); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE companies ADD COLUMN bank_name TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE companies ADD COLUMN bank_swift TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE companies ADD COLUMN bank_iban TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE companies ADD COLUMN bank_country TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE companies ADD COLUMN bank_holder TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE companies ADD COLUMN bank_kyc_status TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE companies ADD COLUMN bank_kyc_notes TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE companies ADD COLUMN bank_kyc_at TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }
// (6) Promotional posts published by the ADVERTISING AGENT get a subtle marker.
try { db.exec('ALTER TABLE posts ADD COLUMN is_promo INTEGER DEFAULT 0'); } catch (e) { /* column already exists */ }

// (2) Direct translator — persistent cache keyed by sha256(text + target language).
db.exec(`CREATE TABLE IF NOT EXISTS translation_cache (
  cache_key  TEXT PRIMARY KEY,
  target     TEXT NOT NULL,
  result     TEXT NOT NULL,
  created_at TEXT NOT NULL
)`);

// Per-company agent insight feed (ACCOUNTING / WAREHOUSE AGENTS) — distinct from agent_audit,
// which is the admin-facing global log. Insights are scoped to the owning company.
db.exec(`CREATE TABLE IF NOT EXISTS agent_insights (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  agent      TEXT NOT NULL,
  level      TEXT NOT NULL DEFAULT 'info',  -- info | warn
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL
)`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_agent_insights_company ON agent_insights(company_id, id)'); } catch (e) { /* index may already exist */ }

// (4) ACCOUNTING AGENT — invoices & expenses (lite Odoo).
db.exec(`CREATE TABLE IF NOT EXISTS invoices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  client     TEXT NOT NULL,
  amount     REAL NOT NULL DEFAULT 0,
  currency   TEXT NOT NULL DEFAULT 'USD',
  due_date   TEXT DEFAULT '',
  notes      TEXT DEFAULT '',
  deal_id    INTEGER,
  status     TEXT NOT NULL DEFAULT 'draft', -- draft | sent | paid | overdue (overdue is derived)
  created_at TEXT NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS expenses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  category   TEXT NOT NULL,
  amount     REAL NOT NULL DEFAULT 0,
  currency   TEXT NOT NULL DEFAULT 'USD',
  spent_on   TEXT DEFAULT '',
  notes      TEXT DEFAULT '',
  created_at TEXT NOT NULL
)`);

// (5) WAREHOUSE AGENT — items + stock movements (lite Zoho).
db.exec(`CREATE TABLE IF NOT EXISTS warehouse_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER NOT NULL,
  sku           TEXT NOT NULL,
  name          TEXT NOT NULL,
  unit          TEXT NOT NULL DEFAULT 'units',
  quantity      REAL NOT NULL DEFAULT 0,
  reorder_level REAL NOT NULL DEFAULT 0,
  location      TEXT DEFAULT '',
  created_at    TEXT NOT NULL,
  UNIQUE(company_id, sku)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS warehouse_movements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  direction  TEXT NOT NULL,                  -- IN | OUT
  quantity   REAL NOT NULL,
  note       TEXT DEFAULT '',
  deal_id    INTEGER,
  created_at TEXT NOT NULL
)`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_wh_movements_item ON warehouse_movements(item_id, id)'); } catch (e) { /* index may already exist */ }

/** Next warehouse SKU for a company: DZ-<companyId>-<zero-padded seq> (per-company counter in settings). */
function nextSku(companyId) {
  const key = `sku_seq_${companyId}`;
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const seq = (row ? parseInt(row.value, 10) || 0 : 0) + 1;
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(seq));
  return `DZ-${companyId}-${String(seq).padStart(4, '0')}`;
}

/** Record a scoped agent insight (company-visible) + mirror to the global agent_audit log. */
function agentInsight(companyId, agent, level, text) {
  const t = String(text || '').slice(0, 300);
  try {
    db.prepare('INSERT INTO agent_insights (company_id, agent, level, text, created_at) VALUES (?,?,?,?,?)')
      .run(companyId, agent, level === 'warn' ? 'warn' : 'info', t, now());
  } catch (e) { /* insights must never break the main flow */ }
  audit(agent, level === 'warn' ? 'insight (flag)' : 'insight', level === 'warn' ? 'flag' : 'pass', `Company #${companyId}: ${t}`);
}

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

// ============================= COMMISSION PAYMENT GATE =============================
/** Lock message shown (and returned) while a finalized deal awaits commission payment approval. */
const PAYMENT_LOCK_MSG = '🔒 Shipment tracking unlocks after commission payment is approved by the administrator';
/** Admin bank-transfer details shown on commission payment cards (settings key admin_bank_details). */
function adminBankDetails() {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_bank_details');
    if (row && String(row.value).trim()) return String(row.value).trim();
  } catch (e) { /* fall through to default */ }
  return 'Bank transfer details are being set up — please ask the platform administrator for the current account details before transferring.';
}
/** True while a deal is inside the commission-payment gate (pending or already paid). */
function paymentGateApplies(deal) {
  return !!deal && (deal.payment_status === 'pending_payment' || deal.payment_status === 'paid');
}
/**
 * Commission math for a finalized deal, frozen at final-approval time:
 * payment_fee / payment_currency / payment_split are recorded on the deal when the admin approves,
 * so later platform-fee changes never rewrite a finalized deal's obligation.
 * Split: '50-50' (both parties pay half) | 'buyer-pays' | 'seller-pays'.
 */
function dealPaymentBreakdown(deal) {
  const split = NEG_SPLITS[deal.payment_split] ? deal.payment_split : '50-50';
  const fee = Number(deal.payment_fee);
  const cur = deal.payment_currency || deal.currency || 'USD';
  const ok = isFinite(fee) && fee > 0;
  // The split decides WHO owes (fraction), independent of whether the fee amount is known.
  const buyerFrac = split === 'buyer-pays' ? 1 : (split === 'seller-pays' ? 0 : 0.5);
  return {
    pct: platformFeePct(), cur, fee: ok ? fee : NaN, split,
    buyerId: dealBuyerId(deal), sellerId: deal.company_id,
    buyerShare: ok ? fee * buyerFrac : NaN, sellerShare: ok ? fee * (1 - buyerFrac) : NaN,
    buyerOwes: buyerFrac > 0, sellerOwes: (1 - buyerFrac) > 0
  };
}
/** The company ids that owe an (approved) commission share for a deal, per the frozen split. */
function dealRequiredPayers(bd) {
  const req = [];
  if (bd.buyerId && bd.buyerOwes) req.push(bd.buyerId);
  if (bd.sellerId && bd.sellerOwes) req.push(bd.sellerId);
  return req;
}
/** Commission math for a finalized private contract (always split 50 / 50 between sender and recipient). */
function pcPaymentBreakdown(pc) {
  const pct = platformFeePct();
  const cur = pc.currency || 'USD';
  const v = Number(pc.value);
  const fee = isFinite(v) && v > 0 ? v * pct / 100 : NaN;
  const share = isFinite(fee) ? fee / 2 : NaN;
  return { pct, cur, fee, senderShare: share, recipientShare: share, senderId: pc.sender_company_id, recipientId: pc.recipient_company_id };
}
/** Small status badge for a commission-payment confirmation row. */
function paymentBadge(status) {
  const map = { pending: '⏳ pending review', approved: '✅ approved', rejected: '❌ rejected' };
  const cls = status === 'approved' ? 'badge-contract' : (status === 'rejected' ? 'badge-sealed' : '');
  return `<span class="badge ${cls}">${map[status] || esc(status)}</span>`;
}
/** Notification text sent to both parties when a deal/contract enters the payment gate. */
function commissionDueMessage(amountText, splitLabel, what) {
  return `${what} approved! Commission of ${amountText} (${splitLabel}) is due before deal processing. Pay via bank transfer and confirm below.`;
}
/**
 * After an admin approves a commission_payment row, check whether EVERY required share for its
 * deal (per the frozen split: 50-50 = both parties; buyer-pays / seller-pays = only that party)
 * is now approved. On completion the deal unlocks: payment_status='paid', both parties notified,
 * audit-logged. Returns true when the deal just flipped to paid.
 */
function maybeCompleteDealPayment(dealId) {
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(dealId);
  if (!deal || deal.payment_status !== 'pending_payment') return false;
  const bd = dealPaymentBreakdown(deal);
  const required = dealRequiredPayers(bd);
  if (!required.length) return false;
  const approved = new Set(db.prepare(`SELECT DISTINCT company_id FROM commission_payments WHERE deal_id = ? AND status = 'approved'`).all(deal.id).map(r => r.company_id));
  if (!required.every(id => approved.has(id))) return false;
  db.prepare(`UPDATE deals SET payment_status = 'paid' WHERE id = ?`).run(deal.id);
  const msg = `Payment approved — shipment tracking is now live 🚢 Deal ${deal.deal_number || '#' + deal.id} ("${deal.title}") is unlocked: the status stepper and tracking maps are active.`;
  if (bd.buyerId) notify(bd.buyerId, 'payment_complete', msg, `/deal/${deal.id}`);
  if (bd.sellerId) notify(bd.sellerId, 'payment_complete', msg, `/deal/${deal.id}`);
  audit('PAYMENT AGENT', 'deal payment complete', 'pass', `Deal ${deal.deal_number || '#' + deal.id} fully paid (${bd.split}) — shipment tracking unlocked`);
  return true;
}
/** Same completion check for private-contract payments (both parties always owe half). */
function maybeCompletePcPayment(pcId) {
  const pc = db.prepare('SELECT * FROM private_contracts WHERE id = ?').get(pcId);
  if (!pc || pc.status !== 'approved') return false;
  const approved = new Set(db.prepare(`SELECT DISTINCT company_id FROM commission_payments WHERE private_contract_id = ? AND status = 'approved'`).all(pc.id).map(r => r.company_id));
  if (!approved.has(pc.sender_company_id) || !approved.has(pc.recipient_company_id)) return false;
  // Only fire once: complete = both approved AND no pending rows left to review for this contract.
  const pendingLeft = db.prepare(`SELECT COUNT(*) AS n FROM commission_payments WHERE private_contract_id = ? AND status = 'pending'`).get(pc.id).n;
  if (pendingLeft > 0) return false;
  const msg = `Payment approved — the commission on your private contract "${pc.title}" is fully settled. ✅`;
  notify(pc.sender_company_id, 'payment_complete', msg, `/contracts/${pc.id}`);
  notify(pc.recipient_company_id, 'payment_complete', msg, `/contracts/${pc.id}`);
  audit('PAYMENT AGENT', 'private contract payment complete', 'pass', `Private contract #${pc.id} "${pc.title}" commission fully settled`);
  return true;
}

// ============================= BATCH B — PAYMENTS FLOW DESIGN (no real money moves) =============================
/** Badge marking every surface where the money movement is a designed flow, not a live charge. */
const FLOW_PREVIEW_BADGE = '<span class="badge badge-flow">🧪 Flow preview — payments go live when Dealzoin activates its payment processor</span>';
/** One-per-page delegated copy-button handler: navigator.clipboard with a textarea fallback. */
const COPY_BTN_SCRIPT = `<script>(function(){
  if(window.__dzCopyInit)return;window.__dzCopyInit=1;
  document.addEventListener('click',function(e){
    var b=e.target&&e.target.closest?e.target.closest('.copy-btn'):null;if(!b)return;
    var v=b.getAttribute('data-copy')||'';
    function done(){if(b.dataset.busy)return;b.dataset.busy='1';var t=b.textContent;b.textContent='Copied \\u2713';b.classList.add('copied');setTimeout(function(){b.textContent=t;b.classList.remove('copied');delete b.dataset.busy;},1400);}
    function fallback(){var ta=document.createElement('textarea');ta.value=v;ta.setAttribute('readonly','');ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();try{document.execCommand('copy');}catch(_){/* clipboard unavailable */}document.body.removeChild(ta);done();}
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(v).then(done,fallback);}else fallback();
  });
})();</script>`;

/** (2) Structured "Dealzoin receiving bank details" from the settings table; null when nothing is configured. */
function bankDetails() {
  const out = {};
  let any = false;
  for (const k of ['bank_name', 'bank_account', 'bank_iban', 'bank_swift', 'bank_currency', 'bank_ref']) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
    out[k] = row ? String(row.value).trim() : '';
    if (out[k]) any = true;
  }
  return any ? out : null;
}
/** One bank-detail row with its own one-click Copy button. */
function bankFieldRow(label, value) {
  return `<div class="bank-row">
    <div class="bank-row__meta"><span class="bank-row__label">${esc(label)}</span><span class="bank-row__value">${esc(value)}</span></div>
    <button type="button" class="copy-btn" data-copy="${esc(value)}" aria-label="Copy ${esc(label)}">Copy</button>
  </div>`;
}
/** Elegant receiving-bank-details card. reference = payment reference incl. the deal/contract number. */
function bankDetailsCardHtml(reference) {
  const b = bankDetails();
  let inner;
  if (b) {
    const rows = [
      b.bank_name && bankFieldRow('Bank name', b.bank_name),
      b.bank_account && bankFieldRow('Account name', b.bank_account),
      b.bank_iban && bankFieldRow('IBAN', b.bank_iban),
      b.bank_swift && bankFieldRow('SWIFT / BIC', b.bank_swift),
      b.bank_currency && bankFieldRow('Currency', b.bank_currency),
      reference && bankFieldRow('Payment reference', reference),
      b.bank_ref && bankFieldRow('Reference instructions', b.bank_ref)
    ].filter(Boolean).join('');
    inner = `<div class="bank-card">${rows}</div>`;
  } else {
    inner = `<p class="muted" style="white-space:pre-wrap">${esc(adminBankDetails())}</p>
      ${reference ? bankFieldRow('Payment reference', reference) : ''}`;
  }
  return `<h4 style="margin:12px 0 6px">🏦 Dealzoin receiving bank details</h4>
    ${inner}
    <p class="muted" style="margin-top:6px">Use the payment reference exactly as shown so the administrator can match your transfer.</p>
    ${COPY_BTN_SCRIPT}`;
}
/** (1b) Apple Pay preview button (black, Apple-style) + explanatory modal. No real Apple Pay JS anywhere. */
function applePayHtml() {
  return `
  <button type="button" class="apple-pay-btn" onclick="document.getElementById('dz-applepay-modal').classList.add('is-open')" aria-haspopup="dialog"><svg viewBox="0 0 384 512" width="15" height="15" aria-hidden="true" style="fill:currentColor;margin-right:2px"><path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"/></svg>Pay with Apple&nbsp;Pay</button>
  <div class="dz-modal" id="dz-applepay-modal" role="dialog" aria-modal="true" aria-labelledby="dz-applepay-title" onclick="if(event.target===this)this.classList.remove('is-open')">
    <div class="dz-modal__box card vault">
      <h3 id="dz-applepay-title" style="margin-top:0"> Pay with Apple&nbsp;Pay</h3>
      <p style="margin:8px 0">${FLOW_PREVIEW_BADGE}</p>
      <p class="muted">Apple&nbsp;Pay activates when Dealzoin's payment processor goes live. No real payment is processed today — this button previews the checkout experience.</p>
      <h4 style="margin:12px 0 6px">How to pay today — bank transfer</h4>
      <ol class="muted" style="margin:0;padding-left:18px;line-height:1.7">
        <li>Transfer your commission share to the Dealzoin receiving account (bank-details card — every field has its own Copy button).</li>
        <li>Use the deal number as your payment reference.</li>
        <li>Upload the bank-transfer receipt (PDF) with your confirmation.</li>
        <li>The administrator verifies the transfer and approves — the deal unlocks.</li>
      </ol>
      <div class="feed-actions" style="margin-top:14px"><button type="button" class="btn" onclick="document.getElementById('dz-applepay-modal').classList.remove('is-open')">Got it — pay by bank transfer</button></div>
    </div>
  </div>`;
}
/** (1a) Payment-proof cell for a commission_payments row: download link (admin/payer) + upload form (payer, while pending). */
function paymentProofHtml(r, user) {
  if (!r) return '';
  let out = '';
  if (r.proof_media_id) {
    out += (user.isAdmin || user.id === r.company_id)
      ? `<br>📄 Proof: <a href="/payments/${r.id}/proof"><b>${esc(r.proof_filename || 'receipt.pdf')}</b></a>`
      : `<br>📄 <span class="muted">Payment proof on file (${esc(r.proof_filename || 'receipt.pdf')})</span>`;
  }
  // Upload / re-upload replaces — only the paying party, and only while the row awaits admin review.
  if (!user.isAdmin && user.id === r.company_id && r.status === 'pending') {
    out += `<form method="POST" action="/payments/${r.id}/proof" enctype="multipart/form-data" style="margin-top:6px">
      <label class="file-btn file-btn-sm"><span class="file-btn-text" data-default="📎 ${r.proof_media_id ? 'Replace payment proof (PDF)' : 'Upload payment proof (PDF)'}">📎 ${r.proof_media_id ? 'Replace payment proof (PDF)' : 'Upload payment proof (PDF)'}</span>
        <input type="file" class="file-input" name="proof" accept="application/pdf,.pdf" required></label>
      <button class="btn btn-sm btn-outline" type="submit">Upload</button>
    </form>`;
  }
  return out;
}

// ----- (5) Split-payment milestones: preset label → the shipment status that unlocks the release -----
const MILESTONE_PRESETS = {
  'before-loading': { label: 'Before loading', status: 'production' },
  'after-loading':  { label: 'After loading',  status: 'dispatched' },
  'on-dispatch':    { label: 'On dispatch',    status: 'shipped' },
  'on-delivery':    { label: 'On delivery',    status: 'delivered' },
  'custom':         { label: 'Custom',         status: '' }
};
/** Sensible prefill for the milestone form: 10 / 20 / 70. */
const DEFAULT_MILESTONES = [
  { label: 'Before loading', status: 'production', pct: 10 },
  { label: 'After loading',  status: 'dispatched', pct: 20 },
  { label: 'On delivery',    status: 'delivered',  pct: 70 }
];
/** Parse a stored milestone JSON array; returns null when missing/invalid. */
function parseMilestoneJson(raw) {
  try {
    const a = JSON.parse(raw || '');
    if (!Array.isArray(a) || !a.length || a.length > 4) return null;
    const out = [];
    for (const m of a) {
      const pct = Number(m && m.pct);
      if (!m || typeof m.label !== 'string' || !m.label || !Number.isInteger(pct) || pct < 1 || pct > 100) return null;
      const st = DEAL_STATUSES.includes(m.status) ? m.status : 'delivered';
      out.push({ label: String(m.label).slice(0, 60), status: st, pct });
    }
    if (out.reduce((s, m) => s + m.pct, 0) !== 100) return null;
    return out;
  } catch (e) { return null; }
}
/** Validate the 4 milestone form rows from POST /negotiation/:id/split. Returns { milestones } or { error }. */
function parseMilestonesInput(body) {
  const out = [];
  for (let i = 1; i <= 4; i++) {
    const pctRaw = String(body['ms_pct_' + i] || '').trim();
    const labelKey = String(body['ms_label_' + i] || '');
    if (!pctRaw) continue; // empty row — ignored
    const pct = Number(pctRaw);
    if (!Number.isInteger(pct) || pct < 1 || pct > 100) {
      return { error: `Milestone ${i}: percentage must be a whole number between 1 and 100.` };
    }
    const preset = MILESTONE_PRESETS[labelKey];
    let label, status;
    if (preset && labelKey !== 'custom') {
      label = preset.label; status = preset.status;
    } else {
      label = String(body['ms_custom_' + i] || '').trim().slice(0, 60);
      if (!label) return { error: `Milestone ${i}: a custom milestone needs a label.` };
      status = DEAL_STATUSES.includes(body['ms_status_' + i]) ? body['ms_status_' + i] : 'delivered';
    }
    out.push({ label, status, pct });
  }
  if (!out.length) return { error: 'Define at least one payment milestone (percentages must sum to 100).' };
  const sum = out.reduce((s, m) => s + m.pct, 0);
  if (sum !== 100) return { error: `Milestone percentages must sum to exactly 100 — currently ${sum}.` };
  return { milestones: out };
}
/** One-line human summary of a milestone schedule (timeline events, notifications, admin queue). */
function milestoneSummaryText(ms) {
  return (ms || []).map(m => `${m.pct}% ${m.label} → ${m.status}`).join(' · ');
}
/** Read-only milestone rows with live release state (escrow panel). releases = Map(ms_index -> milestone_releases row). */
function milestoneRowsHtml(ms, effIdx, confirmed, releases) {
  return ms.map((m, i) => {
    const stIdx = DEAL_STATUSES.indexOf(m.status);
    let unlocked = effIdx >= 0 && stIdx >= 0 && effIdx >= stIdx;
    // A delivery-gated release only lands once the buyer has confirmed receipt.
    if (m.status === 'delivered' && !confirmed) unlocked = false;
    const rel = releases && releases.get(i);
    let badge;
    if (rel && rel.status === 'released') {
      badge = `<span class="badge badge-contract">✅ release approved by admin</span>`;
    } else if (rel && rel.status === 'denied') {
      badge = `<span class="badge badge-sealed">⛔ release denied${rel.admin_note ? ` — ${esc(rel.admin_note)}` : ''}</span>`;
    } else if (rel) {
      badge = `<span class="badge">🛡️ awaiting admin approval</span>`;
    } else {
      badge = `<span class="badge ${unlocked ? 'badge-contract' : ''}">${unlocked ? '🔓 stage reached' : '⏳ locked'}</span>`;
    }
    return `<div class="ms-row ${rel && rel.status === 'released' ? 'is-unlocked' : ''}">
      <span class="ms-pct">${m.pct}%</span>
      <span class="ms-body"><b>${esc(m.label)}</b>${rel && rel.amount ? ` <span class="muted">≈ ${esc(fmtAmount(rel.amount))} ${esc(rel.currency)}</span>` : ''}<br><span class="muted">Unlocks at status: <b>${esc(m.status.toUpperCase())}</b>${m.status === 'delivered' ? ' + buyer receipt confirmation' : ''} · admin approves each release</span></span>
      ${badge}
    </div>`;
  }).join('');
}

/**
 * Milestone release trigger — called after every deal-status change. When the new status
 * reaches an AGREED milestone's stage (and none was requested yet), a release request is
 * raised for the admin (approve/deny on the dashboard). Only agreed schedules trigger
 * requests; the default 10/20/70 schedule stays purely visual. Delivery-gated milestones
 * additionally need the buyer's receipt confirmation before the admin is asked.
 */
function triggerMilestoneReleases(deal, newStatus, user) {
  const ms = parseMilestoneJson(deal.payment_milestones);
  if (!ms) return;
  const newIdx = DEAL_STATUSES.indexOf(newStatus);
  if (newIdx < 0) return;
  const dealNum = deal.deal_number || String(deal.id);
  // Agreed value for the display amount: latest negotiation offer, falling back to the deal value.
  let amountBase = NaN, cur = deal.currency || 'USD';
  try {
    const neg = db.prepare("SELECT offer_value, offer_currency FROM negotiations WHERE deal_id = ? AND offer_value IS NOT NULL AND offer_value != '' ORDER BY id DESC LIMIT 1").get(deal.id);
    if (neg) { amountBase = parseFloat(String(neg.offer_value).replace(/[^0-9.]/g, '')); cur = neg.offer_currency || cur; }
    else { amountBase = parseFloat(String(deal.value || '').replace(/[^0-9.]/g, '')); }
  } catch (e) { /* amounts are decorative — never break the trigger */ }
  const dealNow = db.prepare('SELECT buyer_received_confirmed_at FROM deals WHERE id = ?').get(deal.id);
  const confirmed = !!(dealNow && dealNow.buyer_received_confirmed_at);
  ms.forEach((m, i) => {
    const stIdx = DEAL_STATUSES.indexOf(m.status);
    if (stIdx < 0 || newIdx < stIdx) return;                       // stage not reached yet
    if (m.status === 'delivered' && !confirmed) return;            // delivery gate: buyer must confirm receipt first
    if (db.prepare('SELECT id FROM milestone_releases WHERE deal_id = ? AND ms_index = ?').get(deal.id, i)) return; // already requested
    const amount = isFinite(amountBase) ? Math.round(amountBase * m.pct) / 100 : null;
    db.prepare('INSERT INTO milestone_releases (deal_id, ms_index, label, pct, amount, currency, status, triggered_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(deal.id, i, m.label, m.pct, amount, cur, 'pending_admin', (user.isAdmin ? 'Admin' : user.name) || '', now());
    audit('PAYMENT AGENT', 'milestone release requested', 'pass',
      `Deal ${dealNum}: status "${newStatus.toUpperCase()}" unlocked milestone "${m.label}" (${m.pct}%${amount ? ` ≈ ${fmtAmount(amount)} ${cur}` : ''}) — awaiting admin release decision`);
  });
}

/** (3)+(4) Escrow & payment protection panel — parties + admin only, clearly badged as a flow preview. */
function escrowPanelHtml(deal, user, isOwner, isBuyer) {
  if (!user.isAdmin && !isOwner && !isBuyer) return '';
  const buyerId = dealBuyerId(deal);
  if (!buyerId && !paymentGateApplies(deal) && deal.contract_state !== 'approved') return ''; // no counterparty yet
  const names = companyNameMap();
  const gated = paymentGateApplies(deal);
  const paid = deal.payment_status === 'paid' || (deal.contract_state === 'approved' && !gated);
  const ms = parseMilestoneJson(deal.payment_milestones) || DEFAULT_MILESTONES;
  const agreedMs = !!parseMilestoneJson(deal.payment_milestones);
  const legacyDone = deal.contract_state === 'approved' && !gated;
  const stIdx = DEAL_STATUSES.indexOf(deal.status);
  const effIdx = legacyDone ? DEAL_STATUSES.length - 1 : stIdx;
  const delivered = effIdx >= DEAL_STATUSES.indexOf('delivered');
  const confirmed = !!deal.buyer_received_confirmed_at;
  const anyMsUnlocked = paid && ms.some(m => DEAL_STATUSES.indexOf(m.status) <= effIdx && effIdx >= 0);

  // 4-stage pipeline: Buyer pays → Funds held → Milestones release → Seller paid.
  const stages = [
    { icon: '💳', label: 'Buyer pays',          done: paid,      current: !paid },
    { icon: '🏦', label: 'Funds held by Dealzoin escrow', done: paid && (anyMsUnlocked || delivered), current: paid && !anyMsUnlocked && !delivered },
    { icon: '📊', label: 'Milestones release',  done: delivered, current: paid && !delivered },
    { icon: '💰', label: 'Seller paid',         done: confirmed, current: delivered && !confirmed }
  ];
  const pipeline = `<div class="stepper escrow-stepper" role="list" aria-label="Escrow pipeline">${stages.map((s, i) =>
    `<div class="step-node ${s.done ? 'done' : s.current ? 'current done' : ''}" style="--i:${i}">
      <span class="step-dot">${s.done ? '✓' : s.icon}</span><span class="step-lbl">${esc(s.label)}</span>
    </div>`).join('')}</div>`;

  // (4) Buyer receipt confirmation — REAL data: only the buyer, only once the deal is delivered.
  let confirmHtml = '';
  if (deal.escrow_dispute_at) {
    confirmHtml = `<p style="margin-top:10px"><span class="badge badge-sealed">⚠️ Dispute raised ${esc(deal.escrow_dispute_at.slice(0, 16).replace('T', ' '))} UTC</span>
      <span class="muted">— the platform team has been alerted and will mediate between the parties.</span></p>`;
  } else if (confirmed) {
    confirmHtml = `<p style="margin-top:10px"><span class="badge badge-contract">✅ Buyer confirmed receipt of goods — ${esc(deal.buyer_received_confirmed_at.slice(0, 16).replace('T', ' '))} UTC</span>
      <span class="muted">· final milestone release awaits admin approval</span></p>`;
  } else if (delivered) {
    confirmHtml = `<div style="margin-top:10px">
      ${isBuyer ? `<form method="POST" action="/deal/${deal.id}/confirm-receipt" style="display:inline" onsubmit="return confirm('Confirm you have received the goods in good order? This requests the final escrow release (admin approves) and is audit-logged.')">
        <button class="btn btn-green" type="submit">✅ Confirm receipt of goods</button>
      </form>` : `<p class="muted">Waiting for <b>${esc(names.get(buyerId) || 'the buyer')}</b> to confirm receipt of goods.</p>`}
      <form method="POST" action="/deal/${deal.id}/escrow-dispute" style="display:inline;margin-left:8px" onsubmit="return confirm('Raise a dispute on this deal? The platform team is alerted and the release is paused.')">
        <button class="btn btn-sm btn-danger" type="submit">⚠️ Dispute</button>
      </form>
    </div>`;
  } else {
    confirmHtml = `<p class="muted" style="margin-top:10px">The "Confirm receipt of goods" step activates for the buyer once the deal status reaches <b>delivered</b>.</p>`;
  }

  // Live release requests raised by status changes (admin approves/denies each one).
  const releases = new Map();
  try {
    for (const r of db.prepare('SELECT * FROM milestone_releases WHERE deal_id = ?').all(deal.id)) releases.set(r.ms_index, r);
  } catch (e) { /* releases are additive — the panel works without them */ }

  return `<div class="card vault" data-reveal>
    <div class="feed-head" style="margin:0"><h3>🛡️ Escrow &amp; payment protection</h3>${FLOW_PREVIEW_BADGE}</div>
    <p class="muted" style="margin-top:6px">Dealzoin holds the buyer's funds and releases them only when the buyer confirms receipt.</p>
    ${pipeline}
    <h4 style="margin:14px 0 6px">📊 Release milestones ${agreedMs ? '<span class="muted" style="font-weight:400">(agreed during the commission-split step)</span>' : '<span class="muted" style="font-weight:400">(default schedule — none agreed yet)</span>'}</h4>
    ${milestoneRowsHtml(ms, effIdx, confirmed, releases)}
    ${confirmHtml}
  </div>`;
}

// ----- (6) Receiving-country shipment agent -----
/** Parse the receiving-agent JSON nomination on a deal; null when unset/invalid. */
function parseReceivingAgent(deal) {
  try {
    const a = JSON.parse(deal.receiving_agent || '');
    if (a && typeof a.name === 'string' && a.name.trim()) return a;
  } catch (e) { /* invalid JSON — treated as unset */ }
  return null;
}
/** Receiving-agent card: nomination form (parties), update log (nominating party / admin), timeline for all parties. */
function receivingAgentCardHtml(deal, user, isOwner, isBuyer) {
  if (!user.isAdmin && !isOwner && !isBuyer) return '';
  const agent = parseReceivingAgent(deal);
  const names = companyNameMap();
  const updates = db.prepare('SELECT * FROM receiving_updates WHERE deal_id = ? ORDER BY id DESC LIMIT 50').all(deal.id);
  const updatesHtml = updates.length ? `<div class="tl" style="margin-top:10px">${updates.map((u, i) => `
    <div class="tl-item" data-reveal style="--i:${Math.min(i, 8)}">
      <div class="tl-dot"></div>
      <div class="tl-body">
        <div class="feed-head" style="margin:0"><b>${esc(u.note)}</b>
          <span class="muted">${esc(u.company_id ? (names.get(u.company_id) || 'Unknown') : 'Admin')} · ${esc(u.created_at.slice(0, 16).replace('T', ' '))} UTC</span></div>
        <span class="badge badge-agent">🛳️ Receiving agent · ${esc(agent && agent.country ? agent.country : 'receiving country')}</span>
      </div>
    </div>`).join('')}</div>` : '<p class="muted" style="margin-top:8px">No receiving-side updates logged yet.</p>';

  let agentBody;
  if (agent) {
    agentBody = `<div class="bank-card" style="margin-top:8px">
      ${bankFieldRow('Agent company', agent.name)}
      ${agent.contact ? bankFieldRow('Contact person', agent.contact) : ''}
      ${agent.phone ? bankFieldRow('Phone', agent.phone) : ''}
      ${agent.email ? bankFieldRow('Email', agent.email) : ''}
      ${agent.country ? bankFieldRow('Country', agent.country) : ''}
    </div>
    <p class="muted" style="margin-top:6px">Nominated by <b>${esc(names.get(agent.nominated_by) || 'the platform')}</b> · ${esc(String(agent.nominated_at || '').slice(0, 16).replace('T', ' '))} UTC</p>`;
  } else {
    agentBody = '<p class="muted" style="margin-top:8px">No receiving-country agent nominated yet. Either party can nominate the shipment agent who handles the goods at destination.</p>';
  }

  // Nominate / edit form — either party (and admin); editing or removing is audit-logged (SHIPMENT AGENT).
  const canNominate = user.isAdmin || isOwner || isBuyer;
  const nominateHtml = canNominate ? `
    <hr class="sep">
    <h4 style="margin-bottom:8px">${agent ? '✏️ Edit receiving agent' : '➕ Nominate the receiving agent'}</h4>
    <form method="POST" action="/deal/${deal.id}/receiving-agent">
      <div class="grid2" style="gap:10px">
        <div><label>Agent company name *</label><input type="text" name="agent_name" required maxlength="160" value="${agent ? esc(agent.name) : ''}" placeholder="e.g. Gulf Gateway Shipping LLC"></div>
        <div><label>Contact person</label><input type="text" name="agent_contact" maxlength="120" value="${agent ? esc(agent.contact || '') : ''}" placeholder="e.g. Sara Haddad"></div>
      </div>
      <div class="grid2" style="gap:10px">
        <div><label>Phone</label><input type="text" name="agent_phone" maxlength="60" value="${agent ? esc(agent.phone || '') : ''}" placeholder="e.g. +971 4 000 0000"></div>
        <div><label>Email</label><input type="email" name="agent_email" maxlength="160" value="${agent ? esc(agent.email || '') : ''}" placeholder="agent@example.com"></div>
      </div>
      <label>Receiving country *</label><input type="text" name="agent_country" required maxlength="120" value="${agent ? esc(agent.country || '') : ''}" placeholder="e.g. United Arab Emirates">
      <button class="btn btn-sm" type="submit">${agent ? 'Save changes' : 'Nominate agent'}</button>
      ${agent ? `<button class="btn btn-sm btn-danger" type="submit" formaction="/deal/${deal.id}/receiving-agent/remove" formmethod="POST" onclick="return confirm('Remove the receiving-agent nomination? This is audit-logged.')">Remove</button>` : ''}
      <p class="muted" style="margin-top:6px">Changes are audit-logged by the Shipment Agent and the other party is notified.</p>
    </form>` : '';

  // Receiving-side update form — the nominating party (or admin) logs port/customs updates.
  const canLog = agent && (user.isAdmin || (agent.nominated_by && user.id === agent.nominated_by));
  const updateForm = canLog ? `
    <hr class="sep">
    <h4 style="margin-bottom:8px">📮 Log a receiving-side update</h4>
    <form method="POST" action="/deal/${deal.id}/receiving-update">
      <label>Status update *</label>
      <input type="text" name="note" required maxlength="300" placeholder="e.g. Arrived at Jebel Ali port · Customs clearance started">
      <button class="btn btn-sm" type="submit">Log update</button>
      <p class="muted" style="margin-top:6px">Posted to the shipment timeline, badged "Receiving agent · ${esc(agent.country || 'receiving country')}", visible to both parties and the admin.</p>
    </form>` : (agent ? '<p class="muted" style="margin-top:10px">Receiving-side updates are logged by the nominating party or the admin.</p>' : '');

  return `<div class="card" data-reveal>
    <h3>🛳️ Receiving-country shipment agent</h3>
    ${agentBody}
    ${(agent && updates.length) || canLog ? `<h4 style="margin:14px 0 4px">Shipment timeline — receiving side</h4>${updatesHtml}` : ''}
    ${updateForm}
    ${nominateHtml}
  </div>`;
}

/** Gold commission-payment card for a finalized private contract (parties + admin; 50 / 50 split). */
function pcPaymentCardHtml(pc, user) {
  if (!pc || pc.status !== 'approved' || !(Number(pc.value) > 0)) return '';
  if (!user || !(user.isAdmin || user.id === pc.sender_company_id || user.id === pc.recipient_company_id)) return '';
  const pcb = pcPaymentBreakdown(pc);
  const names = companyNameMap();
  const rows = db.prepare('SELECT * FROM commission_payments WHERE private_contract_id = ? ORDER BY id DESC LIMIT 50').all(pc.id);
  const latestBy = {};
  for (const r of rows) { if (!latestBy[r.company_id]) latestBy[r.company_id] = r; }
  const settled = ['sender_company_id', 'recipient_company_id']
    .every(k => { const r = latestBy[pc[k]]; return r && r.status === 'approved'; });
  const partyRow = (cid, label, share) => {
    const r = latestBy[cid];
    const st = r ? paymentBadge(r.status) : '<span class="badge">— no confirmation yet</span>';
    const meta = r ? `<br><span class="muted">${r.note ? `“${esc(r.note)}” · ` : ''}${esc(r.created_at.slice(0, 16).replace('T', ' '))} UTC</span>${paymentProofHtml(r, user)}` : '';
    return `<div style="padding:6px 0;border-top:1px dashed var(--border-soft)">${label} <b>${esc(names.get(cid) || 'Unknown')}</b> — ${isFinite(share) ? `${fmtAmount(share)} ${esc(pcb.cur)}` : 'amount per instructions'} ${st}${meta}</div>`;
  };
  let confirmHtml = '';
  if (!user.isAdmin && !settled) {
    const myShare = user.id === pc.sender_company_id ? pcb.senderShare : pcb.recipientShare;
    const mine = latestBy[user.id];
    if (mine && mine.status === 'pending') {
      confirmHtml = `<p class="muted" style="margin-top:10px">⏳ Your payment confirmation${isFinite(mine.amount) && mine.amount > 0 ? ` of ${fmtAmount(mine.amount)} ${esc(mine.currency)}` : ''} is awaiting admin review.</p>`;
    } else {
      confirmHtml = `<hr class="sep">
      <h4 style="margin-bottom:8px">Confirm your payment (${isFinite(myShare) ? `${fmtAmount(myShare)} ${esc(pcb.cur)}` : 'amount per instructions'})</h4>
      ${mine && mine.status === 'rejected' ? '<p class="flag-note">Your previous confirmation was rejected by the administrator. You can re-confirm once the transfer is made.</p>' : ''}
      <div class="feed-actions" style="margin:0 0 10px">${applePayHtml()}</div>
      <form method="POST" action="/contracts/${pc.id}/payment-confirm">
        <label>Payment reference / note (optional)</label>
        <input type="text" name="note" maxlength="300" placeholder="e.g. Bank transfer ref #TRX-12345, sent today">
        <button class="btn btn-sm btn-green" type="submit">Confirm payment sent</button>
        <p class="muted" style="margin-top:6px">After confirming you can attach the bank-transfer receipt (PDF) as payment proof for the admin.</p>
      </form>`;
    }
  }
  return `<div class="card vault" data-reveal>
    <h3>💰 Commission payment ${settled ? '<span class="badge badge-contract">settled ✓</span>' : '<span class="badge badge-sealed">awaiting payment</span>'} ${FLOW_PREVIEW_BADGE}</h3>
    <p style="margin-top:6px">Total commission: <span class="deal-value" style="font-size:1rem">${isFinite(pcb.fee) ? `${fmtAmount(pcb.fee)} ${esc(pcb.cur)}` : `${pcb.pct}% of contract value`}</span>
      <span class="muted">(${pcb.pct}% of contract value · split: <b>${esc(NEG_SPLITS['50-50'])}</b>)</span></p>
    ${partyRow(pc.sender_company_id, '✉️ Sender', pcb.senderShare)}
    ${partyRow(pc.recipient_company_id, '📬 Recipient', pcb.recipientShare)}
    ${bankDetailsCardHtml(`DZ-PC-${pc.id} commission`)}
    ${settled ? '<p style="margin-top:10px"><span class="badge badge-contract">Commission fully settled ✓</span></p>' : confirmHtml}
  </div>`;
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

// ============================= BATCH C (7) — i18n EN / AR / 中文 =============================
const SUPPORTED_LANGS = ['en', 'ar', 'zh'];
const LANG_LABELS = { en: 'English', ar: 'العربية', zh: '中文' };
/**
 * Core UI dictionary. English is the fallback for ANY missing key — t() never crashes,
 * never returns undefined. Deep legacy strings intentionally stay English (see report).
 */
const I18N = {
  en: {
    'nav.home': 'Home', 'nav.chats': 'Chats', 'nav.contracts': 'Contracts', 'nav.calendar': 'Calendar',
    'nav.tracking': 'Tracking', 'nav.notifications': 'Notifications', 'nav.search': 'Search',
    'nav.profile': 'Profile', 'nav.dashboard': 'Dashboard', 'nav.create': 'Create', 'nav.logout': 'Log out',
    'nav.signin': 'Sign in', 'nav.register': 'Register company', 'nav.theme': 'Toggle light/dark theme',
    'nav.language': 'Interface language',
    'common.save': 'Save', 'common.cancel': 'Cancel', 'common.send': 'Send', 'common.post': 'Post',
    'common.delete': 'Delete', 'common.edit': 'Edit', 'common.back': 'Back', 'common.close': 'Close',
    'common.submit': 'Submit', 'common.status': 'Status', 'common.date': 'Date', 'common.notes': 'Notes',
    'common.amount': 'Amount', 'common.currency': 'Currency', 'common.category': 'Category',
    'common.optional': 'optional', 'common.none': 'None yet.',
    'auth.welcome': 'Welcome back', 'auth.email': 'Email', 'auth.password': 'Password',
    'auth.signin': 'Sign in', 'auth.register': 'Register company', 'auth.noaccount': "Don't have a company account?",
    'ticker.markets': 'Markets', 'ticker.dealsdone': 'Deals done', 'ticker.dealclosed': 'closed',
    'dash.title': 'Company dashboard', 'dash.inbox': 'Deal inbox', 'dash.openinbox': 'Open inbox',
    'dash.mydeals': 'My deals', 'dash.myposts': 'My posts', 'dash.followers': 'Followers',
    'dash.likes': 'Likes received', 'dash.comments': 'Comments received',
    'dash.contractssigned': 'Contracts I signed', 'dash.contractsonmine': 'Contracts on my deals',
    'dash.accounting': 'Accounting', 'dash.warehouse': 'Warehouse', 'dash.lowstock': 'low stock',
    'dash.items': 'items',
    'feed.postupdate': 'Post update', 'feed.postdeal': 'Post a deal', 'feed.like': 'Like',
    'feed.liked': 'Liked', 'feed.comment': 'Comment', 'feed.writecomment': 'Write a comment…',
    'feed.repost': 'Repost', 'feed.loi': 'Express interest (LOI)', 'feed.promoted': 'Promoted',
    'feed.shareupdate': 'Share an update with the network…',
    'tr.translate': 'Translate', 'tr.translated': 'Translated', 'tr.showorig': 'Show original',
    'tr.unavailable': 'Translation unavailable right now', 'tr.to': 'Translate to',
    'bank.title': 'Bank details', 'bank.name': 'Bank name', 'bank.swift': 'SWIFT / BIC',
    'bank.iban': 'IBAN / account number', 'bank.country': 'Bank country', 'bank.holder': 'Account holder',
    'bank.save': 'Save bank details', 'bank.verified': 'Bank verified', 'bank.warnings': 'checks with warnings',
    'bank.passed': 'checks passed', 'bank.notset': 'not provided', 'bank.rejected': 'rejected by admin',
    'acct.title': 'Accounting', 'acct.invoices': 'Invoices', 'acct.expenses': 'Expenses',
    'acct.ledger': 'Ledger', 'acct.newinvoice': 'New invoice', 'acct.recordexpense': 'Record expense',
    'acct.client': 'Client name', 'acct.duedate': 'Due date', 'acct.linkeddeal': 'Linked deal',
    'acct.export': 'Export CSV', 'acct.insights': 'Agent insights', 'acct.receivables': 'Receivables',
    'acct.paid': 'Paid', 'acct.overdue': 'Overdue', 'acct.net': 'Net cash flow',
    'acct.spenton': 'Spent on', 'acct.balance': 'Running balance', 'acct.mark': 'Mark as',
    'wh.title': 'Warehouse', 'wh.items': 'Items', 'wh.additem': 'Add item', 'wh.movement': 'Record movement',
    'wh.in': 'Stock IN', 'wh.out': 'Stock OUT', 'wh.lowstock': 'Low stock', 'wh.quantity': 'Quantity',
    'wh.reorder': 'Reorder level', 'wh.location': 'Location note', 'wh.history': 'Movement history',
    'wh.unit': 'Unit', 'wh.name': 'Item name', 'wh.current': 'In stock',
    'promo.title': 'Promote', 'promo.product': 'Product / service name', 'promo.market': 'Target market',
    'promo.benefits': 'Key benefits', 'promo.tone': 'Tone', 'promo.generate': 'Generate post',
    'promo.publish': 'Publish to feed', 'promo.preview': 'Preview — edit before publishing',
    'promo.regenerate': 'Regenerate', 'promo.besttime': 'Best posting time',
    'settings.title': 'Settings', 'settings.language': 'Interface language'
  },
  ar: {
    'nav.home': 'الرئيسية', 'nav.chats': 'المحادثات', 'nav.contracts': 'العقود', 'nav.calendar': 'التقويم',
    'nav.tracking': 'التتبع', 'nav.notifications': 'الإشعارات', 'nav.search': 'بحث',
    'nav.profile': 'الملف الشخصي', 'nav.dashboard': 'لوحة التحكم', 'nav.create': 'إنشاء', 'nav.logout': 'تسجيل الخروج',
    'nav.signin': 'تسجيل الدخول', 'nav.register': 'تسجيل شركة', 'nav.theme': 'تبديل المظهر الفاتح/الداكن',
    'nav.language': 'لغة الواجهة',
    'common.save': 'حفظ', 'common.cancel': 'إلغاء', 'common.send': 'إرسال', 'common.post': 'نشر',
    'common.delete': 'حذف', 'common.edit': 'تعديل', 'common.back': 'رجوع', 'common.close': 'إغلاق',
    'common.submit': 'إرسال', 'common.status': 'الحالة', 'common.date': 'التاريخ', 'common.notes': 'ملاحظات',
    'common.amount': 'المبلغ', 'common.currency': 'العملة', 'common.category': 'الفئة',
    'common.optional': 'اختياري', 'common.none': 'لا يوجد بعد.',
    'auth.welcome': 'مرحباً بعودتك', 'auth.email': 'البريد الإلكتروني', 'auth.password': 'كلمة المرور',
    'auth.signin': 'تسجيل الدخول', 'auth.register': 'تسجيل شركة', 'auth.noaccount': 'ليس لديك حساب شركة؟',
    'ticker.markets': 'الأسواق', 'ticker.dealsdone': 'صفقات منجزة', 'ticker.dealclosed': 'أُغلقت',
    'dash.title': 'لوحة تحكم الشركة', 'dash.inbox': 'صندوق الصفقات', 'dash.openinbox': 'فتح الصندوق',
    'dash.mydeals': 'صفقاتي', 'dash.myposts': 'منشوراتي', 'dash.followers': 'المتابعون',
    'dash.likes': 'الإعجابات المستلمة', 'dash.comments': 'التعليقات المستلمة',
    'dash.contractssigned': 'العقود التي وقعتها', 'dash.contractsonmine': 'العقود على صفقاتي',
    'dash.accounting': 'المحاسبة', 'dash.warehouse': 'المستودع', 'dash.lowstock': 'مخزون منخفض',
    'dash.items': 'أصناف',
    'feed.postupdate': 'نشر تحديث', 'feed.postdeal': 'نشر صفقة', 'feed.like': 'إعجاب',
    'feed.liked': 'أعجبني', 'feed.comment': 'تعليق', 'feed.writecomment': 'اكتب تعليقاً…',
    'feed.repost': 'إعادة نشر', 'feed.loi': 'إبداء الاهتمام (LOI)', 'feed.promoted': 'مروَّج',
    'feed.shareupdate': 'شارك تحديثاً مع الشبكة…',
    'tr.translate': 'ترجمة', 'tr.translated': 'مُترجَم', 'tr.showorig': 'إظهار الأصل',
    'tr.unavailable': 'الترجمة غير متاحة حالياً', 'tr.to': 'ترجمة إلى',
    'bank.title': 'البيانات البنكية', 'bank.name': 'اسم البنك', 'bank.swift': 'سويفت / BIC',
    'bank.iban': 'IBAN / رقم الحساب', 'bank.country': 'بلد البنك', 'bank.holder': 'صاحب الحساب',
    'bank.save': 'حفظ البيانات البنكية', 'bank.verified': 'بنك موثّق', 'bank.warnings': 'فحوصات مع تحذيرات',
    'bank.passed': 'الفحوصات ناجحة', 'bank.notset': 'غير مقدَّمة', 'bank.rejected': 'مرفوضة من الإدارة',
    'acct.title': 'المحاسبة', 'acct.invoices': 'الفواتير', 'acct.expenses': 'المصروفات',
    'acct.ledger': 'دفتر الأستاذ', 'acct.newinvoice': 'فاتورة جديدة', 'acct.recordexpense': 'تسجيل مصروف',
    'acct.client': 'اسم العميل', 'acct.duedate': 'تاريخ الاستحقاق', 'acct.linkeddeal': 'صفقة مرتبطة',
    'acct.export': 'تصدير CSV', 'acct.insights': 'رؤى الوكيل', 'acct.receivables': 'المستحقات',
    'acct.paid': 'المدفوع', 'acct.overdue': 'المتأخر', 'acct.net': 'صافي التدفق النقدي',
    'acct.spenton': 'تاريخ الصرف', 'acct.balance': 'الرصيد الجاري', 'acct.mark': 'تحديد كـ',
    'wh.title': 'المستودع', 'wh.items': 'الأصناف', 'wh.additem': 'إضافة صنف', 'wh.movement': 'تسجيل حركة',
    'wh.in': 'إدخال مخزون', 'wh.out': 'إخراج مخزون', 'wh.lowstock': 'مخزون منخفض', 'wh.quantity': 'الكمية',
    'wh.reorder': 'حد إعادة الطلب', 'wh.location': 'ملاحظة الموقع', 'wh.history': 'سجل الحركات',
    'wh.unit': 'الوحدة', 'wh.name': 'اسم الصنف', 'wh.current': 'في المخزون',
    'promo.title': 'الترويج', 'promo.product': 'اسم المنتج / الخدمة', 'promo.market': 'السوق المستهدف',
    'promo.benefits': 'الفوائد الرئيسية', 'promo.tone': 'النبرة', 'promo.generate': 'توليد المنشور',
    'promo.publish': 'نشر في الخلاصة', 'promo.preview': 'معاينة — عدّل قبل النشر',
    'promo.regenerate': 'إعادة التوليد', 'promo.besttime': 'أفضل وقت للنشر',
    'settings.title': 'الإعدادات', 'settings.language': 'لغة الواجهة'
  },
  zh: {
    'nav.home': '首页', 'nav.chats': '聊天', 'nav.contracts': '合同', 'nav.calendar': '日历',
    'nav.tracking': '追踪', 'nav.notifications': '通知', 'nav.search': '搜索',
    'nav.profile': '个人资料', 'nav.dashboard': '仪表盘', 'nav.create': '创建', 'nav.logout': '退出登录',
    'nav.signin': '登录', 'nav.register': '注册公司', 'nav.theme': '切换明/暗主题',
    'nav.language': '界面语言',
    'common.save': '保存', 'common.cancel': '取消', 'common.send': '发送', 'common.post': '发布',
    'common.delete': '删除', 'common.edit': '编辑', 'common.back': '返回', 'common.close': '关闭',
    'common.submit': '提交', 'common.status': '状态', 'common.date': '日期', 'common.notes': '备注',
    'common.amount': '金额', 'common.currency': '货币', 'common.category': '类别',
    'common.optional': '可选', 'common.none': '暂无。',
    'auth.welcome': '欢迎回来', 'auth.email': '电子邮箱', 'auth.password': '密码',
    'auth.signin': '登录', 'auth.register': '注册公司', 'auth.noaccount': '还没有公司账户？',
    'ticker.markets': '市场行情', 'ticker.dealsdone': '已完成交易', 'ticker.dealclosed': '已成交',
    'dash.title': '公司仪表盘', 'dash.inbox': '交易收件箱', 'dash.openinbox': '打开收件箱',
    'dash.mydeals': '我的交易', 'dash.myposts': '我的帖子', 'dash.followers': '关注者',
    'dash.likes': '收到的赞', 'dash.comments': '收到的评论',
    'dash.contractssigned': '我签署的合同', 'dash.contractsonmine': '我交易的合同',
    'dash.accounting': '会计', 'dash.warehouse': '仓库', 'dash.lowstock': '库存不足',
    'dash.items': '个品类',
    'feed.postupdate': '发布动态', 'feed.postdeal': '发布交易', 'feed.like': '赞',
    'feed.liked': '已赞', 'feed.comment': '评论', 'feed.writecomment': '写评论…',
    'feed.repost': '转发', 'feed.loi': '表达意向 (LOI)', 'feed.promoted': '推广',
    'feed.shareupdate': '与网络分享动态…',
    'tr.translate': '翻译', 'tr.translated': '已翻译', 'tr.showorig': '显示原文',
    'tr.unavailable': '翻译暂时不可用', 'tr.to': '翻译为',
    'bank.title': '银行信息', 'bank.name': '银行名称', 'bank.swift': 'SWIFT / BIC',
    'bank.iban': 'IBAN / 账号', 'bank.country': '银行所在国', 'bank.holder': '账户持有人',
    'bank.save': '保存银行信息', 'bank.verified': '银行已验证', 'bank.warnings': '检查有警告',
    'bank.passed': '检查通过', 'bank.notset': '未提供', 'bank.rejected': '被管理员拒绝',
    'acct.title': '会计', 'acct.invoices': '发票', 'acct.expenses': '费用',
    'acct.ledger': '总账', 'acct.newinvoice': '新建发票', 'acct.recordexpense': '记录费用',
    'acct.client': '客户名称', 'acct.duedate': '到期日', 'acct.linkeddeal': '关联交易',
    'acct.export': '导出 CSV', 'acct.insights': '代理洞察', 'acct.receivables': '应收款',
    'acct.paid': '已付款', 'acct.overdue': '逾期', 'acct.net': '净现金流',
    'acct.spenton': '支出日期', 'acct.balance': '累计余额', 'acct.mark': '标记为',
    'wh.title': '仓库', 'wh.items': '物品', 'wh.additem': '添加物品', 'wh.movement': '记录出入库',
    'wh.in': '入库', 'wh.out': '出库', 'wh.lowstock': '库存不足', 'wh.quantity': '数量',
    'wh.reorder': '补货水平', 'wh.location': '位置备注', 'wh.history': '出入库历史',
    'wh.unit': '单位', 'wh.name': '物品名称', 'wh.current': '库存',
    'promo.title': '推广', 'promo.product': '产品/服务名称', 'promo.market': '目标市场',
    'promo.benefits': '核心优势', 'promo.tone': '语气', 'promo.generate': '生成帖子',
    'promo.publish': '发布到动态', 'promo.preview': '预览 — 发布前可编辑',
    'promo.regenerate': '重新生成', 'promo.besttime': '最佳发布时间',
    'settings.title': '设置', 'settings.language': '界面语言'
  }
};
/** Translate a UI key. English fallback for any missing key; never throws, never returns undefined. */
function t(lang, key) {
  const l = SUPPORTED_LANGS.includes(lang) ? lang : 'en';
  const hit = I18N[l] && I18N[l][key];
  if (hit != null) return hit;
  const en = I18N.en[key];
  return en != null ? en : key;
}
/** Resolve the request language: company preference > signed cookie > 'en'. */
function reqLang(req) {
  try {
    const u = currentUser(req);
    if (u && !u.isAdmin && u.lang && SUPPORTED_LANGS.includes(u.lang)) return u.lang;
  } catch (e) { /* fall through to cookie */ }
  const c = parseCookies(req).dz_lang;
  return SUPPORTED_LANGS.includes(c) ? c : 'en';
}
/** Small globe language selector for the nav (submits POST /lang, reloads current page). */
function langSelectorHtml(lang) {
  const opts = SUPPORTED_LANGS.map(l => `<option value="${l}"${l === lang ? ' selected' : ''}>${esc(LANG_LABELS[l])}</option>`).join('');
  return `<form method="POST" action="/lang" class="lang-form" title="${esc(t(lang, 'nav.language'))}" aria-label="${esc(t(lang, 'nav.language'))}">
    <span aria-hidden="true" style="align-self:center;font-size:14px">🌐</span><select name="lang" onchange="this.form.submit()" aria-label="${esc(t(lang, 'nav.language'))}">${opts}</select>
  </form>`;
}

// ============================= BATCH C (1) — MARKET TICKER (stooq CSV) =============================
/**
 * Liquid symbols incl. UAE names. NOTE: verified against stooq's documented free CSV quote API
 * (https://stooq.com/q/l/?s=…&f=sd2t2ohlcv&h&e=csv). Symbols that return no row ("N/D") are
 * skipped at render time, so a delisted/renamed symbol degrades silently.
 */
const MARKET_SYMBOLS = ['^spx', '^ndq', 'aapl.us', 'msft.us', 'amzn.us', 'googl.us', 'tsla.us', 'nvda.us', 'qcom.us', 'emaar.ae'];
const MARKET_LABELS = { '^spx': 'S&P 500', '^ndq': 'NASDAQ 100', 'aapl.us': 'AAPL', 'msft.us': 'MSFT', 'amzn.us': 'AMZN', 'googl.us': 'GOOGL', 'tsla.us': 'TSLA', 'nvda.us': 'NVDA', 'qcom.us': 'QCOM', 'emaar.ae': 'EMAAR' };
const MARKET_TTL_MS = 5 * 60 * 1000; // 5-minute in-memory cache
const marketCache = { at: 0, quotes: [], inflight: null };

/**
 * Parse stooq CSV ("Symbol,Date,Time,Open,High,Low,Close,Volume") into quote chips.
 * Change% is computed vs the row's Open (the free endpoint's same-day reference).
 * Rows with N/D or unparseable closes are skipped. Exported-ish for unit testing.
 */
function parseStooqCsv(csv) {
  const out = [];
  for (const line of String(csv || '').split(/\r?\n/)) {
    const row = line.trim();
    if (!row || /^symbol,/i.test(row)) continue;
    const cells = row.split(',');
    if (cells.length < 8) continue;
    const sym = String(cells[0] || '').toLowerCase().trim();
    const open = parseFloat(cells[3]);
    const close = parseFloat(cells[6]);
    if (!sym || !isFinite(open) || !isFinite(close) || open <= 0) continue;
    const pct = ((close - open) / open) * 100;
    out.push({ sym, label: MARKET_LABELS[sym] || sym.toUpperCase(), close, pct });
  }
  return out;
}
/**
 * Fire-and-forget market refresh: never awaited by page renders. On ANY failure
 * (offline, timeout, anti-bot page, HTTP error) the cache keeps its previous value —
 * if there has never been a success the market segment simply hides (tickerMarketItemsHtml).
 */
async function refreshMarketCache() {
  if (marketCache.inflight) return marketCache.inflight;
  marketCache.inflight = (async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) { /* settled */ } }, 5000);
      let text = '';
      try {
        const url = 'https://stooq.com/q/l/?s=' + MARKET_SYMBOLS.join(',') + '&f=sd2t2ohlcv&h&e=csv';
        const resp = await fetch(url, {
          signal: ctrl.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Dealzoin/1.0)', 'Accept': 'text/csv,*/*' }
        });
        if (resp && resp.ok) text = await resp.text();
      } finally {
        clearTimeout(timer);
      }
      const quotes = parseStooqCsv(text);
      // A bot-wall HTML page parses to zero rows — only accept real data.
      if (quotes.length) {
        marketCache.quotes = quotes;
        marketCache.at = Date.now();
      }
    } catch (e) { /* graceful: keep stale cache / stay hidden */ }
    finally { marketCache.inflight = null; }
  })();
  return marketCache.inflight;
}
/** Kick a refresh when the cache is stale; returns the CURRENT (possibly empty) quotes synchronously. */
function marketQuotes() {
  if (Date.now() - marketCache.at > MARKET_TTL_MS && !marketCache.inflight) {
    refreshMarketCache().catch(() => {});
  }
  return marketCache.quotes;
}
// Warm the cache shortly after boot (never blocks startup).
setTimeout(() => { refreshMarketCache().catch(() => {}); }, 1500);

/** Market chips HTML for the ticker — empty string when no data (silent hide). */
function tickerMarketItemsHtml(lang) {
  const q = marketQuotes();
  if (!q.length) return '';
  const chips = q.map(x => {
    const up = x.pct >= 0;
    return `<span class="ticker__item"><b>${esc(x.label)}</b> ${fmtAmount(Math.round(x.close * 100) / 100)} <span class="${up ? 'up' : 'dn'}">${up ? '▲' : '▼'} ${Math.abs(x.pct).toFixed(2)}%</span></span>`;
  }).join('');
  return `<span class="ticker__seg">📈 ${esc(t(lang, 'ticker.markets'))}</span>${chips}`;
}
/** "Deals done" chips: latest 10 finalized deals — number + category + incoterm ONLY
 *  (privacy: never values, never company names). Pure DB query, always available. */
function dealsDoneRows() {
  try {
    return db.prepare(`SELECT deal_number, category, incoterm FROM deals
      WHERE contract_state = 'approved' OR status = 'closed'
      ORDER BY created_at DESC LIMIT 10`).all();
  } catch (e) { return []; }
}
function tickerDealsDoneItemsHtml(lang) {
  const rows = dealsDoneRows();
  if (!rows.length) return '';
  const chips = rows.map(d =>
    `<span class="ticker__item"><b>${esc(d.deal_number || '—')}</b> ${esc(t(lang, 'ticker.dealclosed'))} · ${esc(d.category || '—')} · ${esc(d.incoterm || 'CIF')}</span>`
  ).join('');
  return `<span class="ticker__seg">🤝 ${esc(t(lang, 'ticker.dealsdone'))}</span>${chips}`;
}
/** All ticker segments as one HTML string: markets (cached, hidden on failure) + deals done +
 *  the Deal Floor open-deals items. Shared by page() and the /api/ticker polling endpoint. */
function tickerSegmentsHtml(lang) {
  const segments = [tickerMarketItemsHtml(lang), tickerDealsDoneItemsHtml(lang)];
  let tDeals = [];
  try {
    tDeals = db.prepare(`SELECT deal_number, category, deal_type FROM deals
      WHERE COALESCE(status, 'open') = 'open' AND COALESCE(contract_state, '') != 'approved'
      ORDER BY created_at DESC LIMIT 5`).all();
  } catch (e) { tDeals = []; }
  if (tDeals.length) {
    segments.push(tDeals.map(d => `<span class="ticker__item"><b>№ ${esc(d.deal_number || '—')}</b> · ${esc(d.category || (d.deal_type === 'buy' ? 'Buying' : 'Selling'))} <span class="up new">▲ NEW</span></span>`).join(''));
  }
  return segments.filter(Boolean).join('');
}
/** Combined ticker HTML for the authenticated layout (and landing): market chips + deals done. */
function newsTickerHtml(lang) {
  const inner = tickerSegmentsHtml(lang);
  if (!inner) return '';
  return `<div class="ticker a-enter" data-stage="nav" style="--i:1" role="marquee" aria-label="${esc(t(lang, 'ticker.markets'))} & ${esc(t(lang, 'ticker.dealsdone'))}" id="dz-ticker"><div class="ticker__track" id="dz-ticker-track">${inner}${inner}</div></div>`;
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
// "Titan Ledger" theme (TITAN.md) — Midnight Trading Floor dark / Paper Exchange light.
// Craft layers: reeded coin edges, banknote guilloché, sealed-letter mailbox, corner-cut numbered cards.
const CSS = `
  :root, [data-theme="dark"] {
    --bg-void:       #0D1321;
    --bg-elevated:   #0F1728;
    --bg-spotlight:  #16203A;
    --surface-card:  #141D31;
    --surface-deal:  linear-gradient(165deg, #1A2745 0%, #131C30 55%, #16203A 100%);
    --gold:          #F58A3A;
    --gold-deep:     #D0611C;
    --gold-glow:     rgba(245,138,58,0.16);
    --mint:          #3FE0B0;
    --mint-deep:     #1FAF85;
    --ink-primary:   #F4F1E8;
    --ink-muted:     #A3ACC2;
    --ink-faint:     #6E7A95;
    --success:       #3FE0B0;
    --warning:       #FFB454;
    --danger:        #FF6B85;
    --danger-deep:   #C93A56;
    --border-soft:   #24304A;
    --border-gold:   rgba(245,138,58,0.38);
    --gradient-coin: linear-gradient(120deg, #F08A3C 0%, #FFB37A 45%, #D0611C 100%);
    --gold-bright:   #FFB37A;
    --on-gold:       #160E04;
    --on-mint:       #FFF7F0;
    --on-danger:     #FFF7F0;
    --bg-glow:       radial-gradient(1200px 600px at 50% -10%, rgba(232,119,42,0.08), transparent 60%);
    --nav-bg:        rgba(13,19,33,0.85);
    --media-bg:      #0A0F1C;
    --row-hover:     rgba(22,32,58,0.55);
    --bubble-mine-bg: linear-gradient(160deg, #3A2412 0%, #241708 100%);
    --bubble-theirs-bg: #1A2438;
    --card-shadow:        0 10px 34px rgba(0,0,0,0.50);
    --card-shadow-hover:  0 16px 44px rgba(0,0,0,0.55);
    --card-inset:         inset 0 1px 0 rgba(255,179,122,0.12);
    --input-bg:      #101828;
    --input-border:  #2A3852;
    --ok-bg:         rgba(63,224,176,0.12);
    --ok-border:     rgba(63,224,176,0.4);
    --ok-badge-bg:   rgba(63,224,176,0.13);
    --ok-badge-border: rgba(63,224,176,0.3);
    --err-bg:        rgba(255,107,133,0.12);
    --err-border:    rgba(255,107,133,0.4);
    --err-badge-border: rgba(255,107,133,0.3);
    --warn-bg:       rgba(255,180,84,0.13);
    --warn-border:   rgba(255,180,84,0.35);
    --warn-badge-border: rgba(255,180,84,0.3);
    --badge-flag-bg: rgba(255,107,133,0.12);
    --badge-flag-fg: #FF8FA3;
    --gold-shadow-sm: 0 2px 12px rgba(232,119,42,0.35);
    --gold-shadow-md: 0 4px 18px rgba(232,119,42,0.28);
    --gold-shadow-lg: 0 8px 26px rgba(232,119,42,0.42);
    --gold-shadow-plus: 0 4px 18px rgba(232,119,42,0.35);
    --gold-shadow-plus-hover: 0 8px 26px rgba(232,119,42,0.5);
    --shadow-gold:   0 6px 24px rgba(232,119,42,0.28);
    --ghost-num:     rgba(244,241,232,0.06); /* giant ghost numbers (decorative) */
    --hero-ink:      #F4F1E8;                /* headline ink on the navy hero (both themes) */
    --font-display: "Space Grotesk", "Segoe UI", system-ui, sans-serif;
    --font-body:    "Inter", -apple-system, "Segoe UI", Roboto, sans-serif;
    /* Theme-agnostic craft layers */
    --coin-reed:     repeating-linear-gradient(90deg, rgba(0,0,0,0.20) 0 2px, transparent 2px 5px);
    --guilloche:     repeating-radial-gradient(circle at 50% -60%, transparent 0 7px, rgba(168,73,11,0.06) 7px 8px);
    --radius-card:   16px;
    --radius-ctl:    10px;
    --cut:           24px; /* signature corner cut */
    /* KINETIC physics system — 6 named easings */
    --ez-out:     cubic-bezier(.16,1,.3,1);     /* ENTRANCES — fast attack, long silk settle */
    --ez-spring:  cubic-bezier(.34,1.56,.64,1); /* POPS — overshoot: likes, badges, magnet release */
    --ez-slam:    cubic-bezier(.55,0,.84,.36);  /* STRIKES — accelerating: wax stamp, coin drop */
    --ez-press:   cubic-bezier(.3,0,.2,1);      /* PRESS DOWN — 80–120ms */
    --ez-release: cubic-bezier(.22,1.4,.36,1);  /* RELEASE — small settle bounce */
    --ez-drift:   cubic-bezier(.45,0,.55,1);    /* AMBIENT LOOPS — symmetric, seamless */
  }
  /* Light theme — "Paper Exchange": warm paper (never pure white), navy ink, orange signature. */
  [data-theme="light"] {
    --bg-void:       #F4EEE0;
    --bg-elevated:   #ECE3D0;
    --bg-spotlight:  #F8F3E8;
    --surface-card:  #FBF7EE;
    --surface-deal:  linear-gradient(165deg, #FCF8EF 0%, #F3EBDA 55%, #F7F0E0 100%);
    --gold:          #A8490B;
    --gold-deep:     #8A3D08;
    --gold-glow:     rgba(168,73,11,0.14);
    --mint:          #0B7A58;
    --mint-deep:     #0B6B4E;
    --ink-primary:   #101A2E;
    --ink-muted:     #54607A;
    --ink-faint:     #7A8296;
    --success:       #0B7A58;
    --warning:       #8F5200;
    --danger:        #C22A47;
    --danger-deep:   #A31F3C;
    --border-soft:   #DED4BC;
    --border-gold:   rgba(168,73,11,0.45);
    --gradient-coin: linear-gradient(120deg, #E8772A 0%, #F59A55 45%, #C75E1A 100%);
    --gold-bright:   #8A3D08;
    --on-gold:       #160E04;
    --on-mint:       #FFF7F0;
    --on-danger:     #FFF7F0;
    --bg-glow:       radial-gradient(1200px 600px at 50% -10%, rgba(232,119,42,0.07), transparent 60%);
    --nav-bg:        rgba(251,247,238,0.88);
    --media-bg:      #0D1321;
    --row-hover:     rgba(16,26,46,0.05);
    --bubble-mine-bg: linear-gradient(160deg, #F9DFC0 0%, #F3CD9E 100%);
    --bubble-theirs-bg: #F8F3E8;
    --card-shadow:        0 10px 28px rgba(16,26,46,0.12);
    --card-shadow-hover:  0 16px 36px rgba(16,26,46,0.16);
    --card-inset:         inset 0 1px 0 rgba(255,255,255,0.5);
    --input-bg:      #FDFAF3;
    --input-border:  #CFC3A4;
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
    --gold-shadow-sm: 0 2px 12px rgba(168,73,11,0.22);
    --gold-shadow-md: 0 4px 18px rgba(168,73,11,0.18);
    --gold-shadow-lg: 0 8px 26px rgba(168,73,11,0.28);
    --gold-shadow-plus: 0 4px 18px rgba(168,73,11,0.22);
    --gold-shadow-plus-hover: 0 8px 26px rgba(168,73,11,0.34);
    --shadow-gold:   0 6px 22px rgba(168,73,11,0.26);
    --ghost-num:     rgba(16,26,46,0.07);
    --hero-ink:      #F4F1E8;
  }

  /* ==================== BATCH A — Per-company palettes ====================
     Each palette re-themes the design tokens. Dark variants apply whenever
     data-palette is set (they follow the base dark :root block); light variants
     use the two-attribute selector so they beat the base [data-theme="light"].
     All light variants stay on warm paper — never pure white. */
  [data-palette="desert-gold"] {
    --bg-void: #181008; --bg-elevated: #221709; --bg-spotlight: #2B1D0C;
    --surface-card: #20150A; --surface-deal: linear-gradient(165deg, #241809 0%, #1B1106 60%, #201507 100%);
    --gold: #E3B04B; --gold-deep: #C08E2E; --gold-bright: #F2C56B; --gold-glow: rgba(227,176,75,0.14);
    --mint: #5EC9A0; --mint-deep: #3FA582;
    --ink-primary: #F2E8D4; --ink-muted: #B7A687; --ink-faint: #8B7B5E;
    --border-soft: #3A2C15; --border-gold: rgba(227,176,75,0.42);
    --gradient-coin: linear-gradient(120deg, #C08E2E 0%, #E3B04B 45%, #96691A 100%);
    --nav-bg: rgba(24,16,8,0.82);
    --bg-glow: radial-gradient(1200px 600px at 50% -10%, rgba(227,176,75,0.09), transparent 60%);
    --bubble-mine-bg: linear-gradient(160deg, #3A2A10 0%, #2C1F0B 100%);
    --bubble-theirs-bg: #1E1409;
    --gold-shadow-sm: 0 2px 12px rgba(227,176,75,0.20); --gold-shadow-md: 0 4px 18px rgba(227,176,75,0.16);
    --gold-shadow-lg: 0 8px 26px rgba(227,176,75,0.26); --gold-shadow-plus: 0 4px 18px rgba(227,176,75,0.20);
    --gold-shadow-plus-hover: 0 8px 26px rgba(227,176,75,0.32); --shadow-gold: 0 6px 22px rgba(227,176,75,0.24);
  }
  [data-palette="desert-gold"][data-theme="light"] {
    --bg-void: #F6ECD6; --bg-elevated: #EDE0C4; --bg-spotlight: #FAF3E2;
    --surface-card: #FCF6E8; --surface-deal: linear-gradient(165deg, #FDF7EA 0%, #F4E7C9 55%, #F8EEDC 100%);
    --gold: #8A5A13; --gold-deep: #6F470C; --gold-bright: #6F470C; --gold-glow: rgba(138,90,19,0.14);
    --mint: #0B7A58; --mint-deep: #0B6B4E;
    --ink-primary: #241808; --ink-muted: #6E5C3C; --ink-faint: #8D7B5B;
    --border-soft: #DCCBA2; --border-gold: rgba(138,90,19,0.45);
    --gradient-coin: linear-gradient(120deg, #B07E21 0%, #D9A441 45%, #8A5A13 100%);
    --nav-bg: rgba(252,246,232,0.88);
    --bg-glow: radial-gradient(1200px 600px at 50% -10%, rgba(217,164,65,0.10), transparent 60%);
    --bubble-mine-bg: linear-gradient(160deg, #F6E3BC 0%, #EED49E 100%);
    --bubble-theirs-bg: #F9F2E0;
    --gold-shadow-sm: 0 2px 12px rgba(138,90,19,0.22); --gold-shadow-md: 0 4px 18px rgba(138,90,19,0.18);
    --gold-shadow-lg: 0 8px 26px rgba(138,90,19,0.28); --gold-shadow-plus: 0 4px 18px rgba(138,90,19,0.22);
    --gold-shadow-plus-hover: 0 8px 26px rgba(138,90,19,0.34); --shadow-gold: 0 6px 22px rgba(138,90,19,0.26);
  }
  [data-palette="midnight-mint"] {
    --bg-void: #081615; --bg-elevated: #0C1F1D; --bg-spotlight: #102826;
    --surface-card: #0E211F; --surface-deal: linear-gradient(165deg, #102423 0%, #0A1A19 60%, #0D201E 100%);
    --gold: #2FD6A5; --gold-deep: #1FAD85; --gold-bright: #57E4B8; --gold-glow: rgba(47,214,165,0.13);
    --mint: #2FD6A5; --mint-deep: #1FAD85;
    --ink-primary: #E4F2EC; --ink-muted: #8FB3A8; --ink-faint: #6B8E84;
    --border-soft: #1E3B35; --border-gold: rgba(47,214,165,0.40);
    --gradient-coin: linear-gradient(120deg, #1FAD85 0%, #2FD6A5 45%, #158064 100%);
    --nav-bg: rgba(8,22,21,0.82);
    --bg-glow: radial-gradient(1200px 600px at 50% -10%, rgba(47,214,165,0.08), transparent 60%);
    --bubble-mine-bg: linear-gradient(160deg, #123B31 0%, #0E2C25 100%);
    --bubble-theirs-bg: #0E211F;
    --gold-shadow-sm: 0 2px 12px rgba(47,214,165,0.18); --gold-shadow-md: 0 4px 18px rgba(47,214,165,0.15);
    --gold-shadow-lg: 0 8px 26px rgba(47,214,165,0.24); --gold-shadow-plus: 0 4px 18px rgba(47,214,165,0.18);
    --gold-shadow-plus-hover: 0 8px 26px rgba(47,214,165,0.30); --shadow-gold: 0 6px 22px rgba(47,214,165,0.22);
  }
  [data-palette="midnight-mint"][data-theme="light"] {
    --bg-void: #EAF3EC; --bg-elevated: #DDEAE0; --bg-spotlight: #F3F9F4;
    --surface-card: #F6FAF5; --surface-deal: linear-gradient(165deg, #F7FBF6 0%, #E4F0E5 55%, #EDF5EC 100%);
    --gold: #0E6B54; --gold-deep: #0A563F; --gold-bright: #0A563F; --gold-glow: rgba(14,107,84,0.14);
    --mint: #0E6B54; --mint-deep: #0A563F;
    --ink-primary: #0C2018; --ink-muted: #47685B; --ink-faint: #6E8A7E;
    --border-soft: #C4DACB; --border-gold: rgba(14,107,84,0.45);
    --gradient-coin: linear-gradient(120deg, #0E6B54 0%, #1FAD85 45%, #0A563F 100%);
    --nav-bg: rgba(246,250,245,0.88);
    --bg-glow: radial-gradient(1200px 600px at 50% -10%, rgba(47,214,165,0.10), transparent 60%);
    --bubble-mine-bg: linear-gradient(160deg, #CFEBD9 0%, #BDE0C8 100%);
    --bubble-theirs-bg: #F1F7F0;
    --gold-shadow-sm: 0 2px 12px rgba(14,107,84,0.20); --gold-shadow-md: 0 4px 18px rgba(14,107,84,0.17);
    --gold-shadow-lg: 0 8px 26px rgba(14,107,84,0.26); --gold-shadow-plus: 0 4px 18px rgba(14,107,84,0.20);
    --gold-shadow-plus-hover: 0 8px 26px rgba(14,107,84,0.32); --shadow-gold: 0 6px 22px rgba(14,107,84,0.24);
  }
  [data-palette="royal-dune"] {
    --bg-void: #090F22; --bg-elevated: #0E1630; --bg-spotlight: #131C3C;
    --surface-card: #101831; --surface-deal: linear-gradient(165deg, #121A38 0%, #0B1228 60%, #101831 100%);
    --gold: #D08A52; --gold-deep: #B26C39; --gold-bright: #E3A471; --gold-glow: rgba(208,138,82,0.14);
    --mint: #5FA8D3; --mint-deep: #4585AF;
    --ink-primary: #E9E4D8; --ink-muted: #A29CA8; --ink-faint: #7B7690;
    --border-soft: #26304F; --border-gold: rgba(208,138,82,0.42);
    --gradient-coin: linear-gradient(120deg, #B26C39 0%, #D08A52 45%, #8F5427 100%);
    --nav-bg: rgba(9,15,34,0.82);
    --bg-glow: radial-gradient(1200px 600px at 50% -10%, rgba(208,138,82,0.09), transparent 60%);
    --bubble-mine-bg: linear-gradient(160deg, #3A2A1A 0%, #2B1F13 100%);
    --bubble-theirs-bg: #101831;
    --gold-shadow-sm: 0 2px 12px rgba(208,138,82,0.20); --gold-shadow-md: 0 4px 18px rgba(208,138,82,0.16);
    --gold-shadow-lg: 0 8px 26px rgba(208,138,82,0.26); --gold-shadow-plus: 0 4px 18px rgba(208,138,82,0.20);
    --gold-shadow-plus-hover: 0 8px 26px rgba(208,138,82,0.32); --shadow-gold: 0 6px 22px rgba(208,138,82,0.24);
  }
  [data-palette="royal-dune"][data-theme="light"] {
    --bg-void: #F3EDE2; --bg-elevated: #E8DFCE; --bg-spotlight: #F9F4E9;
    --surface-card: #FBF6EA; --surface-deal: linear-gradient(165deg, #FCF7EB 0%, #EFE5D0 55%, #F5EDDB 100%);
    --gold: #9A4A1F; --gold-deep: #7E3A14; --gold-bright: #7E3A14; --gold-glow: rgba(154,74,31,0.14);
    --mint: #1F5F8B; --mint-deep: #174C70;
    --ink-primary: #101A30; --ink-muted: #52597A; --ink-faint: #797E96;
    --border-soft: #DACFB6; --border-gold: rgba(154,74,31,0.45);
    --gradient-coin: linear-gradient(120deg, #B26C39 0%, #C97C4A 45%, #8F5427 100%);
    --nav-bg: rgba(251,246,234,0.88);
    --bg-glow: radial-gradient(1200px 600px at 50% -10%, rgba(201,124,74,0.10), transparent 60%);
    --bubble-mine-bg: linear-gradient(160deg, #F2DCC2 0%, #E9CBA4 100%);
    --bubble-theirs-bg: #F7F1E4;
    --gold-shadow-sm: 0 2px 12px rgba(154,74,31,0.22); --gold-shadow-md: 0 4px 18px rgba(154,74,31,0.18);
    --gold-shadow-lg: 0 8px 26px rgba(154,74,31,0.28); --gold-shadow-plus: 0 4px 18px rgba(154,74,31,0.22);
    --gold-shadow-plus-hover: 0 8px 26px rgba(154,74,31,0.34); --shadow-gold: 0 6px 22px rgba(154,74,31,0.26);
  }

  /* ==================== BATCH A — Loading logo overlay ====================
     Full-screen struck-coin loader: the Dz mark pulses while a gold ring spins
     around it. Rendered on every page; shown only with JS (.js gate), hidden on
     window load, re-shown briefly during same-origin navigations (.is-on), and
     fully suppressed under prefers-reduced-motion. */
  .dz-loader { display: none; position: fixed; inset: 0; z-index: 200; align-items: center; justify-content: center;
    background: var(--bg-void); background-image: var(--bg-glow); }
  /* gated on html.dz-js (set by the head script) so the overlay covers the whole page load,
     and never renders at all when JS is disabled */
  .dz-js .dz-loader.is-on { display: flex; }
  .dz-loader__stage { position: relative; width: 96px; height: 96px; display: grid; place-items: center; }
  .dz-loader__ring { position: absolute; inset: 0; border-radius: 50%;
    border: 3px solid transparent; border-top-color: var(--gold); border-right-color: var(--border-gold);
    animation: kf-loader-spin .9s linear infinite; }
  .dz-loader__coin { width: 62px; height: 62px; border-radius: 50%; display: grid; place-items: center;
    background: var(--gradient-coin); color: var(--on-gold); font: 700 1.35rem var(--font-display);
    box-shadow: inset 0 0 0 3px rgba(0,0,0,.18), inset 0 2px 4px rgba(255,255,255,.4), var(--shadow-gold);
    animation: kf-loader-pulse 1.4s var(--ez-drift) infinite; }
  .dz-loader__tag { position: absolute; top: calc(100% + 14px); left: 50%; transform: translateX(-50%); white-space: nowrap;
    font: 600 .75rem var(--font-body); letter-spacing: .16em; text-transform: uppercase; color: var(--ink-muted); }
  @keyframes kf-loader-spin { to { transform: rotate(360deg); } }
  @keyframes kf-loader-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.08); } }
  @media (prefers-reduced-motion: reduce) { .dz-loader { display: none !important; } }

  /* ==================== BATCH A — Terms & Conditions modal ====================
     Scroll-gated agreement modal: the Agree button unlocks only after the terms
     body is scrolled to the bottom. No Esc / backdrop dismissal — agreement must
     be explicit. mode=gate (post-login re-agreement) is a blocking full overlay. */
  .terms-gate { position: fixed; inset: 0; z-index: 150; display: none; align-items: center; justify-content: center;
    background: rgba(8,10,18,0.72); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); padding: 20px; }
  .terms-gate.is-open { display: flex; }
  .js .terms-gate--force { display: flex; } /* login re-agreement: always on for JS sessions */
  .terms-modal { width: 640px; max-width: 100%; max-height: 86vh; display: flex; flex-direction: column;
    background: var(--guilloche), var(--surface-card); border: 1px solid var(--border-gold); border-radius: 16px;
    box-shadow: var(--card-shadow-hover), var(--shadow-gold); overflow: hidden; }
  .terms-modal__head { padding: 16px 20px 12px; border-bottom: 1px solid var(--border-soft);
    background: linear-gradient(90deg, var(--gold-glow), transparent 70%); }
  .terms-modal__head .kicker { color: var(--gold); }
  .terms-modal__head h3 { margin: 4px 0 2px; }
  .terms-modal__body { flex: 1; overflow-y: auto; padding: 14px 20px; font-size: 14px; line-height: 1.6;
    border-bottom: 1px solid var(--border-soft); scrollbar-width: thin; scrollbar-color: var(--gold) var(--bg-elevated); }
  .terms-modal__body p { margin-bottom: 10px; }
  .terms-modal__foot { padding: 14px 20px 18px; display: flex; flex-direction: column; gap: 10px; }
  .terms-scroll-hint { font-size: 12px; color: var(--warning); display: flex; align-items: center; gap: 6px; }
  .terms-scroll-hint.done { color: var(--mint); }
  .terms-agree-btn[disabled] { opacity: .45; cursor: not-allowed; filter: grayscale(.4); }
  .terms-agree-btn[disabled]:hover { transform: none; box-shadow: var(--gold-shadow-md), inset 0 1px 0 rgba(255,255,255,0.35); }

  /* Batch A — cargo capacity chip (authorized viewers only; never public) */
  .chip-cargo { color: var(--mint); border-color: var(--ok-border); background: var(--ok-badge-bg); text-transform: none; }
  /* LOI countdown pill on negotiation views */
  .loi-countdown { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 0.3rem 0.9rem;
    font: 600 0.8rem var(--font-body); border: 1px solid var(--warn-badge-border); color: var(--warning); background: var(--warn-bg);
    font-variant-numeric: tabular-nums; }
  .loi-countdown.loi-expired { border-color: var(--err-badge-border); color: var(--danger); background: var(--err-bg); }
  /* Palette picker swatches on /profile */
  .palette-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 10px 0 14px; }
  .palette-opt { position: relative; display: block; cursor: pointer; }
  .palette-opt input { position: absolute; opacity: 0; width: 1px; height: 1px; }
  .palette-opt .palette-card { border: 2px solid var(--border-soft); border-radius: 12px; padding: 10px 12px;
    background: var(--bg-elevated); transition: border-color .18s ease, box-shadow .18s ease; }
  .palette-opt:hover .palette-card { border-color: var(--border-gold); }
  .palette-opt input:checked + .palette-card { border-color: var(--gold); box-shadow: 0 0 0 3px var(--gold-glow); }
  .palette-swatch { display: flex; height: 26px; border-radius: 7px; overflow: hidden; border: 1px solid var(--border-soft); margin-bottom: 8px; }
  .palette-swatch span { flex: 1; }
  .palette-name { font-weight: 700; font-size: 13px; color: var(--ink-primary); }
  .palette-hint { font-size: 11px; color: var(--ink-muted); }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background-color: var(--bg-void); background-image: var(--bg-glow); background-attachment: fixed; background-repeat: no-repeat; color: var(--ink-primary); font-family: var(--font-body); font-size: 16px; line-height: 1.6; min-height: 100vh; overflow-x: hidden; }
  a { color: var(--gold); text-decoration: none; }
  a:hover { color: var(--gold-bright); }
  h1, h2, h3 { font-family: var(--font-display); color: var(--ink-primary); }
  h1 { font-size: 2rem; font-weight: 700; letter-spacing: -0.02em; }
  h2 { font-size: 1.375rem; font-weight: 700; letter-spacing: -0.015em; }
  h3 { font-size: 1.125rem; font-weight: 700; letter-spacing: -0.015em; }
  .kicker { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.14em; color: var(--gold); } /* Titan orange eyebrow */
  .sec-h { margin: 18px 0 10px; }

  /* Nav — sticky, blurred, members-only feel */
  .nav { position: sticky; top: 0; z-index: 10; min-height: 64px; background: var(--nav-bg); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-bottom: 1px solid var(--border-soft); padding: 10px 24px; display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
  .nav::after { content: ""; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; background: linear-gradient(90deg, transparent, var(--border-gold) 30%, var(--border-gold) 70%, transparent); pointer-events: none; }
  .nav .brand { display: inline-flex; align-items: center; gap: 10px; font-family: var(--font-display); font-size: 20px; font-weight: 700; letter-spacing: -0.02em; color: var(--ink-primary); }
  .nav .brand:hover { color: var(--ink-primary); }
  .nav .coin { width: 30px; height: 30px; border-radius: 50%; background: var(--gradient-coin); color: var(--on-gold); display: inline-flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; letter-spacing: 0; box-shadow: var(--gold-shadow-sm); }
  .nav a.navlink { color: var(--ink-muted); font-size: 14px; font-weight: 500; padding-bottom: 2px; border-bottom: 2px solid transparent; }
  .nav a.navlink:hover { color: var(--ink-primary); }
  .nav a.navlink.active { color: var(--gold); border-bottom: 2px solid var(--gold); }
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
  .btn { position: relative; overflow: hidden; display: inline-block; background: var(--gradient-coin); color: var(--on-gold); border: 1px solid transparent; border-radius: 10px; padding: 0.7rem 1.4rem; font: 600 0.9375rem var(--font-body); cursor: pointer; transition: all .18s var(--ez-release); box-shadow: var(--gold-shadow-md), inset 0 1px 0 rgba(255,255,255,0.35); }
  .btn:not(.btn-outline):not(.btn-danger):not(.btn-green)::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: var(--coin-reed); opacity: .35; pointer-events: none; }
  .btn:hover { transform: translateY(-2px); box-shadow: var(--gold-shadow-lg); color: var(--on-gold); }
  /* KINETIC press contract: 90ms hard press, spring-eased release (release easing lives on .btn) */
  .btn:active { transform: scale(.94); box-shadow: var(--gold-shadow-md); transition-duration: .09s; transition-timing-function: var(--ez-press); }
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
  input:focus, textarea:focus, select:focus { outline: none; border-color: var(--border-gold); box-shadow: 0 0 0 3px rgba(245,138,58,0.18); background: var(--bg-spotlight); }
  [data-theme="light"] input:focus, [data-theme="light"] textarea:focus, [data-theme="light"] select:focus { box-shadow: 0 0 0 3px rgba(168,73,11,0.18); }
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

  /* Landing display scale (Titan editorial) */
  .display-xl { font: 700 clamp(2.6rem, 6vw, 4.75rem)/1.04 var(--font-display); letter-spacing: -0.03em; }
  .display-lg { font: 700 clamp(2rem, 4vw, 3rem)/1.08 var(--font-display); letter-spacing: -0.02em; }

  /* Landing hero — full-bleed navy panel in BOTH themes (Titan's photo slot, CSS-only).
     Overlays: one .bg-grid + one .orb--gold inside the panel; content sits above in .hero-in. */
  .hero { position: relative; overflow: hidden; text-align: center; min-height: 78vh; display: flex; align-items: center; justify-content: center;
    width: 100vw; margin: -28px 0 26px calc(50% - 50vw); padding: 72px 20px 64px;
    background: linear-gradient(180deg, #0D1321, #131E38); border-radius: 0; }
  .hero .bg-grid { z-index: 0; }
  .hero .orb--gold { z-index: 0; }
  [data-theme="light"] .hero .bg-grid { background: linear-gradient(rgba(232,119,42,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(232,119,42,0.05) 1px, transparent 1px); background-size: 56px 56px; }
  [data-theme="light"] .hero .orb--gold { background: radial-gradient(circle, rgba(232,119,42,0.10), transparent 65%); }
  .hero .hero-in { position: relative; z-index: 1; max-width: 860px; }
  .hero .coin-hero { margin-bottom: 10px; }
  .hero .kicker { color: #F58A3A; } /* hero is navy in both themes — always the dark-theme orange */
  .hero h1 { color: var(--hero-ink); margin: 16px 0 18px; }
  .hero h1 .w { display: inline-block; overflow: hidden; vertical-align: bottom; padding-bottom: 0.08em; margin-bottom: -0.08em; }
  .hero h1 .w > span { display: inline-block; }
  .hero p { color: rgba(244,241,232,0.78); font-size: 1.125rem; max-width: 640px; margin: 0 auto 30px; }
  .hero .btn-outline { background: transparent; border: 1px solid rgba(244,241,232,0.35); color: var(--hero-ink); box-shadow: none; }
  .hero .btn-outline:hover { border-color: rgba(244,241,232,0.6); background: rgba(244,241,232,0.07); color: var(--hero-ink); }
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
    background: radial-gradient(circle at 32% 28%, #FFB37A 0%, #F08A3C 42%, #D0611C 78%, #A8490B 100%);
    box-shadow: inset 0 2px 3px rgba(255,255,255,0.45), inset 0 -3px 5px rgba(60,30,0,0.45),
                0 2px 6px rgba(0,0,0,0.35);
    transform: rotate(-8deg);
    font: 700 0.875rem var(--font-display); color: #160E04; letter-spacing: -0.02em;
  }
  .wax-seal::before {              /* embossed inner ring */
    content: ""; position: absolute; inset: 4px; border-radius: 50%;
    border: 1px solid rgba(60,30,0,0.35); box-shadow: inset 0 1px 1px rgba(255,255,255,0.3);
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
    html.dz-js .stepper .step-node { opacity: 0; animation: dz-rise .45s var(--ez-out) forwards; animation-delay: calc(var(--i, 0) * 90ms); }
    .stepper .step-node.current .step-dot { animation: dz-steppulse 2.2s ease-in-out infinite; }
    @keyframes dz-steppulse { 0%, 100% { box-shadow: 0 0 0 3px var(--gold-glow); } 50% { box-shadow: 0 0 0 7px var(--gold-glow); } }
    /* KINETIC: animated gold fill on the stepper bar + pop as each dot is reached */
    .stepper__bar::after { animation: kf-stepfill .9s var(--ez-out) both; }
    @keyframes kf-stepfill { from { width: 0; } }
    .stepper .step-node.done .step-dot { animation: kf-pop .4s var(--ez-spring); }
    /* KINETIC map pins: pulsing trust rings on the Leaflet ship dot + origin/destination markers */
    .dz-ship-dot::after, .dz-marker::after { content: ""; position: absolute; inset: -5px; border-radius: 50%;
      border: 2px solid currentColor; animation: kf-pin 2s var(--ez-out) infinite; }
    .dz-ship-dot { color: var(--gold); } /* already positioned by Leaflet (.leaflet-marker-icon) */
    .dz-marker-gold { color: var(--gold); }
    .dz-marker-mint { color: var(--mint); }
    .dz-pulse::before { animation-timing-function: var(--ez-out); }
  }

  /* ==================== MOTION DESIGN LAYER ====================
     Living trading-floor feel: drifting atmosphere, choreographed entrances,
     micro-interactions. All motion is gated behind prefers-reduced-motion. */

  /* ==================== KINETIC — Living background ====================
     Orbiting vault light + faint scrolling ledger grid. Radial gradients only
     (no blur filters), transform/opacity only, theme-aware. The markup lives
     once as the first child of <body>: .bg-fx > .bg-grid + .orb--gold + .orb--mint. */
  .bg-fx { position: fixed; inset: 0; z-index: -1; overflow: hidden; pointer-events: none; }
  .orb { position: absolute; width: 46vmax; height: 46vmax; border-radius: 50%; }
  .orb--gold { top: -14vmax; left: -10vmax; background: radial-gradient(circle, rgba(232,119,42,.10), transparent 65%);
    animation: kf-orb-a 62s var(--ez-drift) infinite alternate; }
  .orb--mint { bottom: -16vmax; right: -12vmax; background: radial-gradient(circle, rgba(63,224,176,.07), transparent 65%);
    animation: kf-orb-b 84s var(--ez-drift) infinite alternate; }
  [data-theme="light"] .orb--gold { background: radial-gradient(circle, rgba(168,73,11,.09), transparent 65%); }
  [data-theme="light"] .orb--mint { background: radial-gradient(circle, rgba(11,122,88,.06), transparent 65%); }
  @keyframes kf-orb-a { to { transform: translate(16vw,12vh) scale(1.18); } }
  @keyframes kf-orb-b { to { transform: translate(-14vw,-10vh) scale(1.12); } }
  .bg-grid { position: absolute; inset: -60%; opacity: .5;
    background: linear-gradient(rgba(232,119,42,.05) 1px, transparent 1px), linear-gradient(90deg, rgba(232,119,42,.05) 1px, transparent 1px);
    background-size: 56px 56px; animation: kf-grid 36s linear infinite;
    -webkit-mask: radial-gradient(70% 60% at 50% 40%, #000, transparent); mask: radial-gradient(70% 60% at 50% 40%, #000, transparent); }
  [data-theme="light"] .bg-grid { background: linear-gradient(rgba(16,26,46,.05) 1px, transparent 1px), linear-gradient(90deg, rgba(16,26,46,.05) 1px, transparent 1px); background-size: 56px 56px; } /* navy grid on paper */
  @keyframes kf-grid { to { transform: translate(56px,56px); } }

  /* ==================== KINETIC — Choreography ====================
     Load staging (nav -> hero -> cards), IO scroll reveals, MPA page transitions.
     Every hidden-by-default state is gated behind .js so no-JS = fully visible. */
  .js .a-enter { opacity: 0; transform: translateY(18px); animation: kf-rise .7s var(--ez-out) both;
    animation-delay: calc(var(--i,0) * 90ms + var(--stage,0ms)); }
  [data-stage="hero"] { --stage: 250ms; }
  [data-stage="cards"] { --stage: 500ms; }
  @keyframes kf-rise { to { opacity: 1; transform: none; } }
  /* Scroll reveal: .rv (or legacy [data-reveal]) + optional --i; JS adds .is-in at 18% visibility */
  .js .rv, .js [data-reveal] { opacity: 0; transform: translateY(22px) scale(.985);
    transition: opacity .6s var(--ez-out), transform .6s var(--ez-out); transition-delay: calc(var(--i,0) * 70ms); }
  .js .rv.is-in, .js [data-reveal].is-in { opacity: 1; transform: none; }
  /* New feed item (server re-render or JS insert) */
  .feed-in { animation: kf-feed .55s var(--ez-spring) both; }
  @keyframes kf-feed { from { opacity: 0; transform: translateY(14px) scale(.96); } }
  /* MPA page transitions: fade/slide in on load, 170ms out on same-origin nav clicks */
  .js body { animation: kf-pagein .32s var(--ez-out); }
  @keyframes kf-pagein { from { opacity: 0; transform: translateY(-6px); } }
  body.is-leaving { opacity: 0; transform: translateY(10px); transition: opacity .17s var(--ez-press), transform .17s var(--ez-press); }

  @media (prefers-reduced-motion: no-preference) {
    @keyframes dz-rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }

    /* --- Buttons: shine sweep on the struck-gold primary --- */
    .btn:not(.btn-outline):not(.btn-danger):not(.btn-green)::before {
      content: ""; position: absolute; top: -10%; bottom: -10%; left: 0; width: 45%;
      background: linear-gradient(105deg, transparent 0%, rgba(255,255,255,0.5) 50%, transparent 100%);
      transform: translateX(-170%) skewX(-18deg); transition: transform .55s ease; pointer-events: none;
    }
    .btn:not(.btn-outline):not(.btn-danger):not(.btn-green):hover::before { transform: translateX(330%) skewX(-18deg); }
    .btn-outline { transition: border-color .18s var(--ez-release), transform .18s var(--ez-release), background .18s var(--ez-release), color .18s var(--ez-release); }
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
    /* press feedback unified under the KINETIC contract on .btn:active */

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
    background: linear-gradient(150deg, rgba(232,119,42,.12), rgba(63,224,176,.06) 60%, transparent),
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

  /* --- Shipment tracking maps (library + tiles via CDN on map pages only, no API keys) --- */
  .map-embed { height: 350px; border-radius: 14px; border: 1px solid var(--border-gold); overflow: hidden;
    margin-top: 10px; background: var(--bg-elevated); box-shadow: var(--gold-shadow-sm); }
  .map-embed.map-full { height: min(62vh, 560px); margin-top: 14px; }
  .map-fallback { display: flex; align-items: center; justify-content: center; height: 100%; padding: 22px;
    text-align: center; color: var(--ink-muted); font-size: 0.9rem;
    background: repeating-linear-gradient(45deg, var(--gold-glow) 0 14px, transparent 14px 28px), var(--bg-elevated); }
  .map-placeholder { border: 1px dashed var(--border-gold); }
  /* Round map markers: gold = origin / other companies, mint = destination / my company. */
  .dz-marker { border-radius: 50%; border: 2px solid rgba(255,255,255,.35); }
  .dz-marker-gold { background: var(--gold); box-shadow: 0 0 12px var(--gold); }
  .dz-marker-mint { background: var(--mint); box-shadow: 0 0 12px var(--mint); }
  .dz-ship-dot { background: var(--gold-bright); border-radius: 50%; border: 2px solid var(--on-gold);
    box-shadow: 0 0 0 4px var(--gold-glow), 0 0 14px var(--gold); }
  /* Pulsing in-transit markers on the global tracking map. */
  .dz-pulse { display: block; width: 14px; height: 14px; border-radius: 50%; position: relative; }
  .dz-pulse-gold { background: var(--gold); box-shadow: 0 0 10px var(--gold); }
  .dz-pulse-mint { background: var(--mint); box-shadow: 0 0 10px var(--mint); }
  .dz-pulse::before { content: ''; position: absolute; inset: -7px; border-radius: 50%;
    border: 2px solid currentColor; opacity: .7; animation: dz-ping 1.8s ease-out infinite; }
  .dz-pulse-gold::before { color: var(--gold); }
  .dz-pulse-mint::before { color: var(--mint); }
  @keyframes dz-ping { 0% { transform: scale(.5); opacity: .8; } 100% { transform: scale(1.7); opacity: 0; } }
  /* In-transit strip on /tracking. */
  .track-strip { display: flex; gap: 12px; overflow-x: auto; padding: 4px 2px 12px; }
  .track-card { min-width: 250px; flex: 0 0 auto; padding: 12px 14px; }
  .track-card h4 { margin: 0 0 6px; }

  /* ==================== KINETIC — Signature moment: THE MINT ====================
     The 96px brand coin drops from off-screen, spins two full turns, strikes the
     ledger with a squash and fires a gold shockwave ring — then idles in a slow
     3D float. One per page, hero only. JS gates the drop to once per session
     (.is-mint); repeat visits get .is-static (fully static coin); click re-flips. */
  .coin-hero { width: 96px; height: 96px; border-radius: 50%; display: grid; place-items: center; position: relative; cursor: pointer;
    margin: 0 auto; user-select: none; -webkit-user-select: none;
    background: var(--gradient-coin); font: 700 2rem var(--font-display); color: var(--on-gold);
    box-shadow: inset 0 0 0 3px rgba(0,0,0,.18), inset 0 2px 4px rgba(255,255,255,.4), var(--shadow-gold);
    animation: kf-float 6s var(--ez-drift) infinite; }
  .coin-hero::before { content: ""; position: absolute; inset: 0; border-radius: 50%; opacity: .5;
    background: repeating-conic-gradient(rgba(0,0,0,.28) 0 3deg, transparent 3deg 7deg);
    -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 6px), #000 calc(100% - 5px));
            mask: radial-gradient(farthest-side, transparent calc(100% - 6px), #000 calc(100% - 5px)); }
  .coin-hero::after { content: ""; position: absolute; inset: -6px; border-radius: 50%; border: 2px solid var(--border-gold); opacity: 0; }
  .coin-hero.is-mint { animation: kf-mint 1.15s var(--ez-out) .15s both, kf-float 6s var(--ez-drift) 1.5s infinite; }
  .coin-hero.is-mint::after { animation: kf-shock .9s var(--ez-out) .95s; }
  .coin-hero.is-static, .coin-hero.is-static::after { animation: none; }
  .coin-hero.is-flip { animation: kf-flip .8s var(--ez-spring), kf-float 6s var(--ez-drift) .9s infinite; }
  @keyframes kf-mint { 0% { transform: translateY(-40vh) rotateY(720deg) scale(.6); opacity: 0; }
    55% { transform: translateY(8px) rotateY(1080deg) scale(1.08,.88); opacity: 1; }
    72% { transform: translateY(-9px) scale(.97,1.05); } 100% { transform: none; } }
  @keyframes kf-float { 50% { transform: translateY(-6px) rotateY(16deg); } }
  @keyframes kf-flip { 50% { transform: rotateY(540deg) scale(1.12); } }
  @keyframes kf-shock { 0% { opacity: .9; transform: scale(.6); } 100% { opacity: 0; transform: scale(2.4); } }

  /* ==================== KINETIC — Deal Floor ticker ====================
     Live marquee under the nav; the item list is printed twice for a seamless
     loop. Deal numbers in gold, "NEW" riser pulse in mint. Values never shown.
     Pauses on hover and (via JS) when off-screen. */
  .ticker { overflow: hidden; border-bottom: 1px solid var(--border-soft); background: var(--bg-elevated); font: 600 .8125rem var(--font-body); }
  .ticker__track { display: flex; gap: 2.75rem; width: max-content; padding: .45rem 0; animation: kf-ticker 30s linear infinite; }
  .ticker:hover .ticker__track { animation-play-state: paused; }
  .ticker__item { white-space: nowrap; color: var(--ink-muted); }
  .ticker b { color: var(--gold); font-variant-numeric: tabular-nums; }
  .ticker .up { color: var(--mint); }
  .ticker .dn { color: var(--danger); }
  .ticker .up.new { display: inline-block; animation: kf-newpulse 1.6s var(--ez-drift) infinite; }
  @keyframes kf-ticker { to { transform: translateX(-50%); } }
  @keyframes kf-newpulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }

  /* ==================== BATCH C — ticker segments, i18n, translator, agents ==================== */
  /* Segment label chip inside the news ticker (Markets / Deals done). */
  .ticker__seg { white-space: nowrap; color: var(--gold); font-weight: 700; letter-spacing: .08em; text-transform: uppercase; font-size: .72rem; align-self: center; }
  /* RTL: the marquee travels the same way; flip the translate direction so the seamless loop holds. */
  html[dir="rtl"] .ticker__track { animation-name: kf-ticker-rtl; }
  @keyframes kf-ticker-rtl { to { transform: translateX(50%); } }
  /* Nav language selector (globe) — compact, themed. */
  .lang-form { display: inline-flex; margin: 0 2px; }
  .lang-form select { appearance: none; background: var(--bg-elevated); color: var(--ink-muted); border: 1px solid var(--border-soft);
    border-radius: var(--radius-ctl); font: 600 .75rem var(--font-body); padding: 4px 8px; cursor: pointer; max-width: 96px; }
  .lang-form select:hover, .lang-form select:focus { color: var(--gold); border-color: var(--border-gold); outline: none; }
  /* Global toast stack (translate failures, agent notices). */
  .dz-toasts { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; gap: 8px; z-index: 300; max-width: 92vw; }
  .dz-toast { background: var(--surface-card); border: 1px solid var(--border-soft); color: var(--ink-primary);
    padding: 9px 16px; border-radius: 12px; font-size: 13px; font-weight: 600; box-shadow: var(--gold-shadow-md, 0 8px 24px rgba(0,0,0,.35));
    transition: opacity .35s ease; }
  .dz-toast--err { border-color: var(--danger); color: var(--danger); }
  /* Translate button under messages/posts/descriptions. */
  .dz-tr-btn { background: none; border: none; color: var(--ink-faint); font: 600 .72rem var(--font-body); cursor: pointer; padding: 2px 0; }
  .dz-tr-btn:hover { color: var(--gold); }
  .dz-tr-btn:disabled { opacity: .5; cursor: wait; }
  /* Subtle "promoted" badge on advertising-agent posts. */
  .badge-promo { background: var(--warn-bg, transparent); color: var(--warning); border: 1px solid var(--warn-badge-border, var(--border-soft));
    font-weight: 600; text-transform: none; letter-spacing: 0; }
  /* Pragmatic RTL adjustments (Arabic): logical flow flips via dir=rtl; these cover the leftovers. */
  html[dir="rtl"] .nav-icons, html[dir="rtl"] .feed-head, html[dir="rtl"] .feed-actions { direction: rtl; }
  html[dir="rtl"] .ticker__track { direction: ltr; } /* marquee math stays LTR */
  html[dir="rtl"] .bubble.mine { margin-left: 0; margin-right: auto; }
  html[dir="rtl"] .bubble.theirs { margin-right: 0; margin-left: auto; }
  /* Low-stock warehouse rows. */
  .row-lowstock td { color: var(--warning); }
  .row-lowstock .qty { font-weight: 700; }
  /* Agent insights box. */
  .agent-insights { border-inline-start: 3px solid var(--gold); }
  .agent-insights li { margin: 4px 0; }

  /* ==================== KINETIC — Reactive surfaces: tilt, glare, magnet, ripple ==================== */
  /* Bullion shimmer: cursor-tracked gold glare, driven by --gx/--gy (child div inside .card-deal / .stat) */
  .card__glare { position: absolute; inset: -45%; pointer-events: none; opacity: 0; transition: opacity .35s var(--ez-out);
    background: radial-gradient(circle, rgba(232,119,42,.16), transparent 55%); transform: translate(var(--gx,0), var(--gy,0)); }
  [data-theme="light"] .card__glare { background: radial-gradient(circle, rgba(232,119,42,.12), transparent 55%); }
  .js-tilt:hover .card__glare { opacity: 1; }
  .js-tilt { transform: perspective(800px) rotateX(var(--rx,0)) rotateY(var(--ry,0)); will-change: transform; }
  .js-tilt.is-tilting { transition: transform .05s linear; }
  .js-tilt:not(.is-tilting) { transition: transform .5s var(--ez-spring), box-shadow .2s ease, border-color .18s ease; }
  /* The tilt transform owns the element while physics are attached — hover lifts must not fight it */
  .card-deal.js-tilt:hover, .card.js-tilt:hover, .stat.js-tilt:hover, .card--cut.js-tilt:hover { transform: perspective(800px) rotateX(var(--rx,0)) rotateY(var(--ry,0)); }
  .card-deal.js-tilt:hover { box-shadow: var(--card-shadow-hover), var(--shadow-gold), 0 0 0 1px var(--border-gold); }
  /* Magnetic primary buttons: pull within a 40px halo, <=10px travel, spring back */
  .js-magnet { transition: transform .28s var(--ez-spring); will-change: transform; }
  /* Click ripples from the exact click point (span injected by the delegated click handler) */
  .ripple { position: absolute; border-radius: 50%; pointer-events: none; transform: scale(0); z-index: 1;
    background: color-mix(in srgb, currentColor 28%, transparent); animation: kf-ripple .55s var(--ez-out) forwards; }
  .btn:not(.btn-outline):not(.btn-danger):not(.btn-green) .ripple { background: rgba(255,255,255,.5); }
  @keyframes kf-ripple { to { transform: scale(3); opacity: 0; } }
  /* Press/release contract on every control (restated late so it beats every :hover transform) */
  .btn:active { transform: scale(.94); transition-duration: .09s; transition-timing-function: var(--ez-press); }

  /* ==================== KINETIC — Micro-interactions ==================== */
  /* LIKE — gold burst: JS toggles .is-on, spawns 6 .spark particles */
  .btn-like { position: relative; }
  .btn-like.btn-outline.is-on { color: var(--gold); border-color: var(--border-gold); } /* ghost -> gold; the liked (gold-fill) state keeps --on-gold ink */
  .btn-like.is-on .ic { display: inline-block; animation: kf-pop .45s var(--ez-spring); }
  @keyframes kf-pop { 40% { transform: scale(1.45) rotate(-8deg); } 70% { transform: scale(.92); } }
  .spark { position: absolute; left: 50%; top: 50%; width: 5px; height: 5px; border-radius: 50%; background: var(--gold);
    pointer-events: none; animation: kf-spark .6s var(--ez-out) forwards; }
  @keyframes kf-spark { to { transform: translate(var(--sx), var(--sy)) scale(.2); opacity: 0; } }
  /* FOLLOW — state morph (min-width keeps layout stable; server or JS swaps .is-following) */
  .btn-follow { min-width: 112px; transition: all .3s var(--ez-spring); }
  .btn-follow.is-following { background: transparent; border-color: var(--mint); color: var(--mint); animation: kf-morph .4s var(--ez-spring); }
  @keyframes kf-morph { 45% { transform: scale(.9,.85); } }
  /* SEND MESSAGE — fly-off: JS clones the new .bubble.mine into a .fly-clone */
  .fly-clone { position: fixed; z-index: 60; margin: 0; pointer-events: none; animation: kf-fly .7s var(--ez-out) forwards; }
  @keyframes kf-fly { 55% { opacity: 1; } to { transform: translate(56px,-90px) scale(.85) rotate(3deg); opacity: 0; } }
  .js-send.is-sent { animation: kf-kick .4s var(--ez-spring); }
  @keyframes kf-kick { 40% { transform: rotate(-7deg) scale(.92); } }
  /* SEAL & SEND — wax stamp slam (pre-submit visual only; never blocks submission) */
  .wax-seal--fx { opacity: 0; margin-right: 10px; vertical-align: middle; }
  .wax-seal--stamp { opacity: 1; animation: kf-slam .55s var(--ez-slam) both; }
  .wax-seal--stamp::after { content: ""; position: absolute; inset: -8px; border-radius: 50%; border: 2px solid var(--border-gold);
    animation: kf-shock .7s var(--ez-out) .25s both; }
  @keyframes kf-slam { 0% { transform: scale(2.3) rotate(-24deg); opacity: 0; }
    60% { transform: scale(.92) rotate(-8deg); opacity: 1; } 80% { transform: scale(1.06) rotate(-8deg); } 100% { transform: scale(1) rotate(-8deg); } }
  /* UPLOAD DROPZONE — breathing border; drag state kills the loop and locks gold */
  .dropzone { border: 1.5px dashed var(--border-soft); border-radius: var(--radius-ctl); transition: transform .2s var(--ez-spring);
    animation: kf-breathe 3.2s var(--ez-drift) infinite; }
  @keyframes kf-breathe { 50% { border-color: var(--border-gold); box-shadow: 0 0 0 5px rgba(232,119,42,.06); } }
  [data-theme="light"] .dropzone { animation-name: kf-breathe-l; }
  @keyframes kf-breathe-l { 50% { border-color: var(--border-gold); box-shadow: 0 0 0 5px rgba(168,73,11,.08); } }
  .dropzone.is-over { animation: none; border-color: var(--gold); border-style: solid; transform: scale(1.015); }
  /* THEME TOGGLE — sun/moon spin: JS adds .is-spin for 650ms, swaps glyph at midpoint */
  .btn-theme .ic { display: inline-block; transition: transform .6s var(--ez-spring); font-style: normal; }
  .btn-theme.is-spin .ic { transform: rotate(360deg) scale(1.15); }
  /* STATUS STEPPER — animated gold fill under the node rail (--p set inline), dots pop as reached */
  .stepper__bar { height: 3px; background: var(--border-soft); border-radius: 2px; overflow: hidden; margin: 2px 34px 0; }
  .stepper__bar::after { content: ""; display: block; height: 100%; width: var(--p,0%); background: var(--gradient-coin); }
  /* MAP PINS — mint trust pulse (Leaflet divIcons: ship dot + origin/destination markers) */
  .pin { position: relative; width: 10px; height: 10px; border-radius: 50%; background: var(--mint); }
  .pin::after { content: ""; position: absolute; inset: -5px; border-radius: 50%; border: 2px solid var(--mint);
    animation: kf-pin 2s var(--ez-out) infinite; }
  @keyframes kf-pin { from { transform: scale(.5); opacity: .9; } to { transform: scale(2.4); opacity: 0; } }

  /* ==================== KINETIC — Data motion: bars, donut, live ticks ==================== */
  /* Bars: IO adds .is-in to the .chart wrapper; --i per bar for cascade (Chart.js canvases
     already grow/draw natively on dashboards — this covers CSS bar charts). */
  .chart .bar { transform: scaleY(0); transform-origin: bottom;
    transition: transform .9s var(--ez-out); transition-delay: calc(var(--i,0) * 80ms); }
  .chart.is-in .bar { transform: scaleY(1); }
  /* Donut: inline SVG — JS strokes .fg[data-p] when revealed */
  .donut .fg { transition: stroke-dashoffset 1.1s var(--ez-out); }
  /* Live badge tick: JS re-adds .tick whenever the value changes (dzTick helper) */
  .tick { animation: kf-tick .5s var(--ez-spring); }
  @keyframes kf-tick { 35% { transform: scale(1.18); color: var(--gold); } }

  /* ==================== TITAN — Signature corner-cut cards (.card--cut) ====================
     Angled 24px top-right cut (one clip-path polygon), orange top bar, giant decorative
     ghost number from data-num. No borders/radius under the clip — shadow + top bar only. */
  .card--cut { position: relative; overflow: hidden; border-radius: 0; border: none; background: var(--surface-card);
    box-shadow: var(--card-shadow); clip-path: polygon(0 0, calc(100% - var(--cut)) 0, 100% var(--cut), 100% 100%, 0 100%);
    padding: 1.5rem; transition: transform .2s var(--ez-out), box-shadow .2s var(--ez-out); }
  .card--cut::before { content: ""; position: absolute; top: 0; left: 0; right: var(--cut); height: 3px; background: var(--gradient-coin); }
  .card--cut::after { content: attr(data-num); position: absolute; right: .4rem; bottom: -1.5rem; pointer-events: none;
    font: 700 7rem/1 var(--font-display); color: var(--ghost-num); }
  .card--cut.is-feature { background: var(--gradient-coin); color: var(--on-gold); }
  .card--cut.is-feature h3, .card--cut.is-feature p { color: var(--on-gold); }
  .card--cut.is-feature::after { color: rgba(0,0,0,.12); }
  .card--cut:hover { transform: translateY(-4px); box-shadow: var(--card-shadow-hover), var(--shadow-gold); }

  /* Back-to-top — round orange coin, appears after 600px of scroll.
     Shifted 70px up (24px + 70px) so the Zo assistant owns the bottom-right corner. */
  .back-to-top { position: fixed; right: 24px; bottom: 94px; z-index: 50; width: 44px; height: 44px; border-radius: 50%;
    border: none; background: var(--gradient-coin); color: var(--on-gold); font: 700 18px/1 var(--font-body);
    display: grid; place-items: center; cursor: pointer; box-shadow: var(--gold-shadow-md);
    opacity: 0; transform: translateY(12px); pointer-events: none;
    transition: opacity .3s var(--ez-out), transform .3s var(--ez-out); }
  .back-to-top.is-show { opacity: 1; transform: none; pointer-events: auto; }
  .back-to-top:hover { transform: translateY(-3px); }
  .back-to-top:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }

  /* ----- ZO — the 24/7 assistant widget (floating button + chat panel) ----- */
  .zo { position: fixed; right: 24px; bottom: 24px; z-index: 60; }
  .zo[hidden], .zo-panel[hidden] { display: none; }
  .zo-fab { position: relative; width: 56px; height: 56px; border-radius: 50%; border: none; cursor: pointer;
    background: var(--gradient-coin); color: var(--on-gold); font: 700 15px/1 var(--font-display); letter-spacing: .02em;
    display: grid; place-items: center; box-shadow: var(--gold-shadow-lg);
    transition: transform .18s var(--ez-spring), box-shadow .18s var(--ez-out); }
  .zo-fab:hover { transform: translateY(-3px) scale(1.05); }
  .zo-fab:focus-visible { outline: 2px solid var(--gold); outline-offset: 3px; }
  .zo-fab__pulse { position: absolute; inset: 0; border-radius: 50%; pointer-events: none;
    box-shadow: 0 0 0 0 rgba(232,119,42,.45); animation: kf-zo-pulse 2.6s var(--ez-drift) infinite; }
  @keyframes kf-zo-pulse { 0% { box-shadow: 0 0 0 0 rgba(232,119,42,.45); } 70% { box-shadow: 0 0 0 16px rgba(232,119,42,0); } 100% { box-shadow: 0 0 0 0 rgba(232,119,42,0); } }
  .zo-panel { position: absolute; right: 0; bottom: 70px; width: 360px; max-width: calc(100vw - 32px); max-height: 70vh;
    display: flex; flex-direction: column; overflow: hidden; background: var(--surface-card);
    border: 1px solid var(--border-soft); border-radius: var(--radius-card); box-shadow: var(--card-shadow-hover);
    transform-origin: bottom right; animation: kf-zo-open .32s var(--ez-spring); }
  @keyframes kf-zo-open { from { opacity: 0; transform: translateY(16px) scale(.92); } to { opacity: 1; transform: none; } }
  .zo-head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; background: var(--gradient-coin); color: var(--on-gold); }
  .zo-dot { width: 9px; height: 9px; border-radius: 50%; background: #3FE0B0; box-shadow: 0 0 0 3px rgba(63,224,176,.28); flex: none; }
  .zo-title { display: flex; flex-direction: column; line-height: 1.25; font-size: 14px; }
  .zo-sub { font-size: 11px; opacity: .85; }
  .zo-close { margin-left: auto; background: none; border: none; color: inherit; font-size: 20px; line-height: 1;
    cursor: pointer; padding: 4px 8px; border-radius: 8px; }
  .zo-close:hover { background: rgba(0,0,0,.14); }
  .zo-log { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 8px; min-height: 160px; }
  .zo-msg { display: flex; flex-direction: column; }
  .zo-msg.zo-zo { align-items: flex-start; }
  .zo-msg.zo-me { align-items: flex-end; }
  .zo-bubble { max-width: 85%; border-radius: 14px; padding: 9px 13px; font-size: 14px; line-height: 1.5; overflow-wrap: anywhere; }
  .zo-msg.zo-zo .zo-bubble { background: var(--bubble-theirs-bg); border: 1px solid var(--border-soft); border-bottom-left-radius: 4px; color: var(--ink-primary); }
  .zo-msg.zo-me .zo-bubble { background: var(--bubble-mine-bg); border: 1px solid var(--border-gold); border-bottom-right-radius: 4px; color: var(--ink-primary); }
  .zo-links { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; max-width: 85%; }
  .zo-link { font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 999px;
    border: 1px solid var(--border-gold); color: var(--gold); background: var(--gold-glow); }
  .zo-link:hover { color: var(--gold-bright); }
  .zo-typing { display: inline-flex; gap: 5px; align-items: center; }
  .zo-typing span { width: 7px; height: 7px; border-radius: 50%; background: var(--ink-faint); animation: kf-zo-dot 1s var(--ez-drift) infinite; }
  .zo-typing span:nth-child(2) { animation-delay: .15s; }
  .zo-typing span:nth-child(3) { animation-delay: .3s; }
  @keyframes kf-zo-dot { 0%, 60%, 100% { transform: none; opacity: .4; } 30% { transform: translateY(-4px); opacity: 1; } }
  .zo-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 14px 8px; }
  .zo-chips:empty { padding: 0; }
  .zo-chip { font-size: 12px; padding: 5px 11px; border-radius: 999px; border: 1px solid var(--border-gold);
    background: transparent; color: var(--gold); cursor: pointer; font-family: var(--font-body);
    transition: background .15s var(--ez-release), transform .12s var(--ez-press); }
  .zo-chip:hover { background: var(--gold-glow); }
  .zo-chip:active { transform: scale(.94); }
  .zo-form { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--border-soft); }
  .zo-form input { flex: 1; min-width: 0; background: var(--input-bg); border: 1px solid var(--input-border);
    border-radius: var(--radius-ctl); color: var(--ink-primary); padding: 9px 12px; font: 400 14px var(--font-body); }
  .zo-form input:focus { outline: none; border-color: var(--gold); }
  .zo-send { border: none; border-radius: var(--radius-ctl); background: var(--gradient-coin); color: var(--on-gold);
    padding: 0 14px; cursor: pointer; font-size: 15px; box-shadow: var(--gold-shadow-sm); transition: transform .12s var(--ez-press); }
  .zo-send:active { transform: scale(.92); }
  /* Mobile: the panel becomes a full-width bottom sheet under 480px. */
  @media (max-width: 480px) {
    .zo { right: 12px; bottom: 12px; }
    .zo-panel { position: fixed; left: 0; right: 0; bottom: 0; width: auto; max-width: none; max-height: 78vh;
      border-radius: 16px 16px 0 0; transform-origin: bottom center; }
  }

  /* TITAN motion additions: ghost-number slide-in (fires with the card's reveal) + hero word-rise */
  @keyframes kf-ghost-in { from { transform: translateX(28px); opacity: 0; } to { transform: none; opacity: 1; } }
  @keyframes kf-word { from { transform: translateY(110%); opacity: 0; } to { transform: none; opacity: 1; } }
  @media (prefers-reduced-motion: no-preference) {
    .js .rv.is-in.card--cut::after, .js [data-reveal].is-in.card--cut::after, .js .a-enter.card--cut::after {
      animation: kf-ghost-in .5s var(--ez-out) both; animation-delay: calc(var(--i,0) * 90ms + var(--stage,0ms) + 200ms); }
    .js .hero h1 .w > span { animation: kf-word .7s var(--ez-out) both; animation-delay: calc(var(--i,0) * 80ms + 300ms); }
  }

  /* Reduced motion: kill every animation/transition globally, show content instantly. */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
      scroll-behavior: auto !important;
    }
    /* KINETIC kill-switch: every entrance/reveal state forced visible, ambient loops stopped */
    .js .a-enter, .js .rv, .js [data-reveal] { opacity: 1 !important; transform: none !important; animation: none !important; transition: none !important; }
    .orb, .bg-grid, .ticker__track, .pin::after, .dropzone, .coin-hero, .coin-hero::after, .feed-in, .hero h1 .w>span, .card--cut::after { animation: none !important; }
    .js body { animation: none !important; }
  }

  /* ==================== BATCH B — payments flow design UI ==================== */
  /* "Flow preview" badge: marks every surface where money movement is simulated (all palettes). */
  .badge-flow { background: var(--warn-bg); color: var(--warning); border: 1px solid var(--warn-badge-border);
    font-weight: 600; text-transform: none; letter-spacing: 0; }
  /* Receiving-agent timeline badge: mint, clearly distinct from platform status updates. */
  .badge-agent { background: var(--ok-badge-bg); color: var(--mint); border: 1px solid var(--ok-badge-border);
    font-weight: 600; text-transform: none; letter-spacing: 0; }
  /* Apple Pay — branded black button (stays black across palettes, like the real thing). */
  .apple-pay-btn { display: inline-flex; align-items: center; gap: 7px; background: #000; color: #fff;
    border: 1px solid #000; border-radius: 8px; padding: 9px 20px; font: 600 0.95rem var(--font-body);
    cursor: pointer; box-shadow: var(--card-shadow); transition: transform .12s var(--ez-press), box-shadow .18s ease; }
  .apple-pay-btn:hover { box-shadow: var(--card-shadow-hover); transform: translateY(-1px); }
  .apple-pay-btn:active { transform: scale(.97); }
  /* Lightweight modal (Apple Pay explainer). */
  .dz-modal { position: fixed; inset: 0; z-index: 140; display: none; align-items: center; justify-content: center;
    background: rgba(5,8,16,.72); backdrop-filter: blur(6px); padding: 20px; }
  .dz-modal.is-open { display: flex; }
  .dz-modal__box { max-width: 480px; width: 100%; margin: 0; max-height: 84vh; overflow-y: auto; }
  /* Bank-details card: one row per field, mono value, per-field Copy button. */
  .bank-card { border: 1px solid var(--border-gold); border-radius: 12px; overflow: hidden; background: var(--bg-elevated); }
  .bank-row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; }
  .bank-row + .bank-row { border-top: 1px dashed var(--border-soft); }
  .bank-row__meta { flex: 1; min-width: 0; }
  .bank-row__label { display: block; font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-faint); }
  .bank-row__value { display: block; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.9rem; color: var(--ink-primary); overflow-wrap: anywhere; }
  .copy-btn { flex: none; background: transparent; color: var(--gold); border: 1px solid var(--border-gold);
    border-radius: 8px; padding: 4px 12px; font: 600 0.72rem var(--font-body); text-transform: uppercase;
    letter-spacing: 0.06em; cursor: pointer; transition: all .15s ease; }
  .copy-btn:hover { background: var(--gold-glow); }
  .copy-btn.copied { background: var(--ok-badge-bg); color: var(--mint); border-color: var(--ok-badge-border); }
  /* Escrow pipeline: reuse the shipment stepper, slightly roomier labels. */
  .escrow-stepper .step-lbl { text-transform: none; font-size: 0.74rem; }
  .escrow-stepper .step-dot { font-size: 14px; }
  /* Milestone rows (read-only in the escrow panel) + the SPLIT_NEGO editor grid. */
  .ms-row { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-top: 1px dashed var(--border-soft); }
  .ms-row .ms-pct { flex: none; min-width: 52px; text-align: center; font: 700 0.95rem var(--font-display);
    color: var(--ink-muted); border: 1px solid var(--border-soft); border-radius: 10px; padding: 6px 4px; }
  .ms-row.is-unlocked .ms-pct { color: var(--mint); border-color: var(--ok-border); background: var(--ok-badge-bg); }
  .ms-row .ms-body { flex: 1; min-width: 0; }
  .ms-edit-head, .ms-edit-row { display: grid; grid-template-columns: 1.1fr 1fr 0.9fr 86px; gap: 8px; align-items: center; }
  .ms-edit-head { font-size: 0.66rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--ink-faint); margin-bottom: 4px; }
  .ms-edit-row { margin-bottom: 8px; }
  .ms-edit-row input, .ms-edit-row select { margin-bottom: 0; }
  @media (max-width: 560px) {
    .ms-edit-head { display: none; }
    .ms-edit-row { grid-template-columns: 1fr 1fr; }
  }
  .file-btn-sm { padding: 0.35rem 0.8rem; font-size: 0.78rem; margin-bottom: 6px; }
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
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 3v4M16 3v4"/><path d="M7.5 14h3M13.5 14h3M7.5 17.5h3"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.4 2.3 3.7 5.2 3.7 8.5s-1.3 6.2-3.7 8.5c-2.4-2.3-3.7-5.2-3.7-8.5s1.3-6.2 3.7-8.5z"/></svg>'
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
const THEME_TOGGLE_BTN = '<button class="nav-ic theme-toggle btn-theme js-theme" id="theme-toggle" type="button" title="Toggle light/dark theme" aria-label="Toggle light/dark theme"><span class="ic">🌙</span></button>';

/** Render the full HTML page shell. */
function page(title, body, user, msg, err, active, headExtra, opts) {
  const unread = (user && !user.isAdmin) ? totalUnread(user.id) : 0;
  const notifUnread = (user && !user.isAdmin) ? unreadNotifications(user.id) : 0;
  const contractsUnread = (user && !user.isAdmin) ? unreadPrivateContracts(user.id) : 0;
  // Per-company palette (admin sessions always see the default Titan look).
  const palette = companyPalette(user);
  // Logo-derived custom theme: a full CSS variable override block generated from the logo colors.
  const customTheme = palette === 'custom' ? companyCustomTheme(user) : null;
  // Batch C (7): interface language — company preference wins; anonymous pages may pass opts.lang
  // (resolved from the dz_lang cookie by the route). Arabic flips the whole page to RTL.
  const lang = (user && !user.isAdmin && SUPPORTED_LANGS.includes(user.lang)) ? user.lang
    : (opts && SUPPORTED_LANGS.includes(opts.lang)) ? opts.lang : 'en';
  const isRtl = lang === 'ar';
  const tt = (k) => t(lang, k);
  // Terms re-agreement gate: a logged-in company on an outdated terms version gets the
  // blocking modal on every page until it explicitly agrees (POST /terms/agree).
  let termsGate = '';
  if (user && !user.isAdmin) {
    try {
      const tv = db.prepare('SELECT agreed_terms_version FROM companies WHERE id = ?').get(user.id);
      if (!tv || (tv.agreed_terms_version || 0) < TERMS_VERSION) termsGate = termsGateHtml('gate');
    } catch (e) { termsGate = ''; }
  }
  const navLinks = user && user.isAdmin
    ? `${langSelectorHtml(lang)}${THEME_TOGGLE_BTN}
       <a class="navlink" href="/admin">${tt('nav.dashboard')}</a>
       <form method="POST" action="/admin/logout" style="display:inline"><button class="btn btn-sm btn-outline">${tt('nav.logout')}</button></form>`
    : user
    ? `<span class="nav-icons">
         ${navIcon('home', '/timeline', tt('nav.home'), active)}
         ${navIcon('chats', '/chats', tt('nav.chats'), active, unread)}
         ${navIcon('contracts', '/contracts', tt('nav.contracts'), active, contractsUnread)}
         ${navIcon('calendar', '/calendar', tt('nav.calendar'), active)}
         ${navIcon('globe', '/tracking', tt('nav.tracking'), active)}
         ${navIcon('bell', '/notifications', tt('nav.notifications'), active, notifUnread)}
         ${navIcon('search', '/search', tt('nav.search'), active)}
         ${navIcon('profile', '/profile', tt('nav.profile'), active)}
         ${navIcon('dashboard', '/dashboard', tt('nav.dashboard'), active)}
         <a class="nav-plus" href="/new" title="${tt('nav.create')}" aria-label="${tt('nav.create')}">${NAV_ICONS.plus}</a>
       </span>
       ${langSelectorHtml(lang)}
       ${THEME_TOGGLE_BTN}
       <form method="POST" action="/logout" style="display:inline"><button class="btn btn-sm btn-outline">${tt('nav.logout')}</button></form>`
    : `${langSelectorHtml(lang)}${THEME_TOGGLE_BTN}
       <a class="navlink" href="/login">${tt('nav.signin')}</a>
       <a class="navlink" href="/signup">${tt('nav.register')}</a>`;
  // Batch C (1) news ticker stripe: live market chips (5-min cached stooq CSV, hidden silently on
  // failure) + "deals done" chips (latest finalized deals — numbers/categories/incoterms ONLY,
  // never values or company names) + the KINETIC Deal Floor open-deals items from earlier batches.
  // The item list is printed twice for a seamless marquee loop; pauses on hover (CSS) and when
  // off-screen (JS below); fully static under prefers-reduced-motion.
  let ticker = '';
  {
    const inner = tickerSegmentsHtml(lang);
    if (inner) {
      ticker = `<div class="ticker a-enter" data-stage="nav" style="--i:1" role="marquee" aria-label="Dealzoin news ticker" id="dz-ticker"><div class="ticker__track" id="dz-ticker-track">${inner}${inner}</div></div>`;
    }
  }
  return `<!DOCTYPE html>
<html lang="${lang}"${isRtl ? ' dir="rtl"' : ''} class="no-js" data-palette="${esc(palette)}"><head>
<script>try{if(localStorage.getItem('dz-theme')==='light'){document.documentElement.dataset.theme='light';}}catch(e){}document.documentElement.classList.add('dz-js');</script>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Dealzoin</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${CSS}</style>
${customThemeStyle(customTheme)}${headExtra || ''}
</head><body>
<div class="dz-loader is-on" id="dz-loader" aria-hidden="true"><div class="dz-loader__stage"><div class="dz-loader__ring"></div><div class="dz-loader__coin">Dz</div><div class="dz-loader__tag">Dealzoin</div></div></div>
<div class="bg-fx" aria-hidden="true"><div class="bg-grid"></div><div class="orb orb--gold"></div><div class="orb orb--mint"></div></div>
<nav class="nav a-enter" data-stage="nav" style="--i:0">
  <a href="/" class="brand"><span class="coin">Dz</span>Dealzoin</a>
  <span class="spacer"></span>
  ${navLinks}
</nav>
${ticker}
<main class="container">
  ${msg ? `<div class="flash-ok">✓ ${esc(msg)}</div>` : ''}
  ${err ? `<div class="flash-err">⚠ ${esc(err)}</div>` : ''}
  ${body}
</main>
<div class="footer">Dealzoin — the B2B deal network. Companies only. 🪙</div>
<button class="back-to-top" id="back-to-top" type="button" aria-label="Back to top" title="Back to top">&uarr;</button>
${termsGate}
${termsGate ? `<noscript><div class="card" style="position:fixed;left:16px;right:16px;bottom:16px;z-index:150;border-color:var(--border-gold)">
  <b>Our Terms &amp; Conditions have been updated (v${TERMS_VERSION}).</b>
  <p class="muted" style="margin:6px 0 10px">Please <a href="/legal/terms">read the updated Terms &amp; Conditions</a>, then confirm your agreement to continue.</p>
  <form method="POST" action="/terms/agree"><button class="btn" type="submit">I have read and agree to the Terms &amp; Conditions</button></form>
</div></noscript>` : ''}
<!-- ZO — 24/7 assistant widget (hidden until JS reveals it; no-JS visitors simply never see it) -->
<div class="zo" id="zo" hidden>
  <button class="zo-fab" id="zo-fab" type="button" aria-label="Chat with Zo, the Dealzoin assistant" aria-expanded="false" title="Zo — ask me anything">
    <span class="zo-fab__pulse" aria-hidden="true"></span>
    <span class="zo-fab__label">Zo</span>
  </button>
  <section class="zo-panel" id="zo-panel" role="dialog" aria-label="Zo — Dealzoin assistant" hidden>
    <header class="zo-head">
      <span class="zo-dot" aria-hidden="true"></span>
      <div class="zo-title"><b>Zo — Dealzoin Assistant</b><span class="zo-sub">online 24/7</span></div>
      <button class="zo-close" id="zo-close" type="button" aria-label="Close Zo chat" title="Close">&times;</button>
    </header>
    <div class="zo-log" id="zo-log" aria-live="polite"></div>
    <div class="zo-chips" id="zo-chips"></div>
    <form class="zo-form" id="zo-form" action="/assistant/ask" method="POST">
      <input type="text" id="zo-input" name="message" maxlength="500" placeholder="Ask Zo anything…" autocomplete="off" aria-label="Message Zo">
      <button class="zo-send" id="zo-send" type="submit" aria-label="Send message">&#10148;</button>
    </form>
  </section>
</div>
<script>(function(){
  /* ===== KINETIC — the one shared script: physics, reactive surfaces, choreography ===== */
  var RM=!!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var FINE=!!(window.matchMedia&&window.matchMedia('(pointer: fine)').matches);
  var root=document.documentElement;
  if(root.classList.replace){root.classList.replace('no-js','js');}
  if(!root.classList.contains('js')){root.classList.remove('no-js');root.classList.add('js');}
  /* The Mint — coin drops once per session; repeat visits get a fully static coin. */
  var mintCoin=document.querySelector('.coin-hero');
  if(mintCoin){
    var minted=false;
    try{minted=sessionStorage.getItem('dz-minted')==='1';}catch(e0){}
    if(RM||minted){mintCoin.classList.add('is-static');}
    else{mintCoin.classList.add('is-mint');try{sessionStorage.setItem('dz-minted','1');}catch(e1){}}
    mintCoin.addEventListener('keydown',function(ev){if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();mintCoin.click();}});
  }
  // Flash messages: auto-dismiss after 5s (matches the CSS countdown bar).
  setTimeout(function(){document.querySelectorAll('.flash-ok,.flash-err').forEach(function(e){e.style.transition='opacity .4s';e.style.opacity='0';setTimeout(function(){e.remove();},400);});},5000);
  /* ===== BATCH C — shared toasts + direct translator + ticker polling ===== */
  window.dzToast=function(msg,isErr){
    var box=document.getElementById('dz-toasts');
    if(!box){box=document.createElement('div');box.id='dz-toasts';box.className='dz-toasts';box.setAttribute('aria-live','polite');document.body.appendChild(box);}
    var el=document.createElement('div');el.className='dz-toast'+(isErr?' dz-toast--err':'');el.textContent=msg;box.appendChild(el);
    setTimeout(function(){el.style.opacity='0';setTimeout(function(){el.remove();},350);},4200);
  };
  /* Direct translator: any element with [data-dz-tr] wrapping text + a .dz-tr-btn button.
     Click → POST /api/translate → swap bubble text + "Translated · show original" toggle. */
  var DZ_TR={
    btnLabel:${jsJson(tt('tr.translate'))},
    translated:${jsJson(tt('tr.translated'))},
    showOrig:${jsJson(tt('tr.showorig'))},
    failMsg:${jsJson(tt('tr.unavailable'))},
    target:${jsJson(lang)}
  };
  function dzTrAttach(scope){ /* no-op placeholder for symmetry; delegation handles everything */ }
  document.addEventListener('click',function(ev){
    var btn=ev.target&&ev.target.closest?ev.target.closest('.dz-tr-btn'):null;
    if(!btn)return;
    var wrap=btn.closest('[data-dz-tr]');
    if(!wrap)return;
    ev.preventDefault();
    var body=wrap.querySelector('.dz-tr-text');
    if(!body)return;
    if(!body.dataset.orig)body.dataset.orig=body.textContent;
    /* Toggle back to the original. */
    if(body.dataset.translated==='1'){body.textContent=body.dataset.orig;body.dataset.translated='';btn.textContent='🌐 '+DZ_TR.btnLabel;return;}
    btn.disabled=true;
    fetch('/api/translate',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({text:body.dataset.orig,target:btn.dataset.target||DZ_TR.target})})
      .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});})
      .then(function(res){
        btn.disabled=false;
        if(res.ok&&res.j&&res.j.ok&&res.j.text){
          body.textContent=res.j.text;body.dataset.translated='1';
          btn.textContent='✓ '+DZ_TR.translated+' · '+DZ_TR.showOrig;
        }else{window.dzToast(DZ_TR.failMsg,true);}
      })
      .catch(function(){btn.disabled=false;window.dzToast(DZ_TR.failMsg,true);});
  });
  /* Ticker polling: refresh the news ticker every 60s from /api/ticker (cheap, cached server-side). */
  var tkTrack=document.getElementById('dz-ticker-track');
  if(tkTrack){
    setInterval(function(){
      fetch('/api/ticker',{headers:{'Accept':'application/json'}})
        .then(function(r){return r.ok?r.json():null;})
        .then(function(j){
          if(!j||!j.ok||!j.html)return;
          var tk=document.getElementById('dz-ticker');
          if(!tk)return;
          tkTrack.innerHTML=j.html+j.html;
        }).catch(function(){/* keep the stale ticker */});
    },60000);
  }
  /* Loading logo overlay — hidden on window load, re-shown on same-origin navigation
     (see the MPA page-out handler below), fully suppressed under reduced motion. */
  var dzLoader=document.getElementById('dz-loader');
  function dzLoaderOff(){if(dzLoader)dzLoader.classList.remove('is-on');}
  if(dzLoader){
    if(RM){dzLoaderOff();}
    else{
      addEventListener('load',function(){setTimeout(dzLoaderOff,140);});
      setTimeout(dzLoaderOff,9000); /* failsafe if the load event stalls */
    }
  }
  /* Terms & Conditions modal — the Agree button unlocks only after the terms body has
     been scrolled to the bottom. Intentionally NO Esc/backdrop dismissal: agreement
     must be explicit. mode=signup checks the pledge boxes; mode=gate posts /terms/agree. */
  document.querySelectorAll('.terms-gate').forEach(function(g){
    var tBody=g.querySelector('.terms-modal__body'), agreeBtn=g.querySelector('.terms-agree-btn'), hint=g.querySelector('.terms-scroll-hint');
    function syncTerms(){
      if(!tBody||!agreeBtn)return;
      var done=tBody.scrollHeight-tBody.clientHeight<=2||tBody.scrollTop+tBody.clientHeight>=tBody.scrollHeight-10;
      agreeBtn.disabled=!done;
      if(hint){hint.classList.toggle('done',done);
        hint.textContent=done?'✓ You have reached the end — you may now agree below.':'↓ Scroll to the end of the Terms & Conditions to enable agreement';}
    }
    if(tBody){tBody.addEventListener('scroll',syncTerms,{passive:true});syncTerms();}
    if(g.getAttribute('data-mode')==='signup'&&agreeBtn){
      agreeBtn.addEventListener('click',function(){
        if(agreeBtn.disabled)return;
        document.querySelectorAll('input[type=checkbox][name^="pledge_"]').forEach(function(c){c.checked=true;});
        g.classList.remove('is-open');
        var st=document.getElementById('terms-status');
        if(st){st.textContent='✓ Terms & Conditions (v'+g.getAttribute('data-version')+') read and accepted — the five pledges below are checked for you.';st.style.color='var(--mint)';}
      });
    }
  });
  document.querySelectorAll('.js-terms-open').forEach(function(opener){
    opener.addEventListener('click',function(e){
      e.preventDefault();
      var g=document.getElementById(opener.getAttribute('data-target')||'terms-signup');
      if(!g)return;
      g.classList.add('is-open');
      var tBody=g.querySelector('.terms-modal__body');if(tBody){tBody.scrollTop=0;tBody.dispatchEvent(new Event('scroll'));}
    });
  });
  /* LOI response-deadline countdown — live tick on negotiation views ("Seller must respond within Xd Yh"). */
  var loiPills=document.querySelectorAll('[data-loi-expires]');
  if(loiPills.length){
    var tickLoi=function(){
      var nowMs=Date.now();
      loiPills.forEach(function(p){
        var ms=new Date(p.getAttribute('data-loi-expires')).getTime()-nowMs;
        if(!isFinite(ms))return;
        if(ms<=0){p.textContent='⏰ LOI expired — refresh to see the updated state';p.classList.add('loi-expired');return;}
        var d=Math.floor(ms/86400000), h=Math.floor((ms%86400000)/3600000), m=Math.floor((ms%3600000)/60000);
        p.textContent='⏰ Seller must respond within '+(d>0?d+'d ':'')+h+'h'+(d===0?' '+m+'m':'');
      });
    };
    tickLoi();setInterval(tickLoi,30000);
  }
  // Theme toggle (persists to localStorage); glyph swaps at the 360-degree spin midpoint.
  var btn=document.getElementById('theme-toggle');
  var btnIc=btn?btn.querySelector('.ic'):null;
  function paintIcon(){if(btnIc)btnIc.textContent=root.dataset.theme==='light'?'\\u2600\\uFE0F':'\\uD83C\\uDF19';}
  if(btn){paintIcon();btn.addEventListener('click',function(){
    if(root.dataset.theme==='light'){root.removeAttribute('data-theme');}else{root.dataset.theme='light';}
    try{localStorage.setItem('dz-theme',root.dataset.theme==='light'?'light':'dark');}catch(e){}
    if(RM){paintIcon();}else{setTimeout(paintIcon,325);}
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
  // Stat tiles: count-up 0 -> value over 800ms ease-out (reduced motion: jumps to final).
  // The final frame restores the server's exact formatted label.
  function countUp(el){
    var target=parseFloat(el.getAttribute('data-count'));
    if(!isFinite(target))return;
    var finalText=el.textContent;
    if(RM){el.textContent=finalText;return;}
    var t0=null,dur=800;
    var step=function(ts){
      if(t0===null)t0=ts;
      var p=Math.min(1,(ts-t0)/dur),e=1-Math.pow(1-p,3);
      el.textContent=p<1?String(Math.round(target*e)):finalText;
      if(p<1)requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  /* A) Scroll reveals + charts + donuts + count-ups — one IntersectionObserver, unobserve after fire. */
  var motionEls=document.querySelectorAll('.rv,[data-reveal],.chart,.donut,[data-count]');
  if('IntersectionObserver' in window&&motionEls.length){
    var io=new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        if(!en.isIntersecting)return;
        var t=en.target;
        t.classList.add('is-in');
        if(t.hasAttribute('data-reveal'))t.classList.add('in-view');
        var f=t.querySelector?t.querySelector('.fg[data-p]'):null;
        if(f){var L=2*Math.PI*18;f.style.strokeDasharray=L;f.style.strokeDashoffset=L;
          requestAnimationFrame(function(){requestAnimationFrame(function(){f.style.strokeDashoffset=L*(1-parseFloat(f.getAttribute('data-p'))/100);});});}
        if(t.hasAttribute('data-count')&&!t.getAttribute('data-counted')){t.setAttribute('data-counted','1');countUp(t);}
        io.unobserve(t);
      });
    },{threshold:0.18});
    motionEls.forEach(function(el){io.observe(el);});
  }else{
    motionEls.forEach(function(el){
      el.classList.add('is-in');
      if(el.hasAttribute('data-reveal'))el.classList.add('in-view');
      if(el.hasAttribute('data-count'))countUp(el);
    });
  }
  /* B) Pause the Deal Floor ticker while it is off-screen. */
  var tk=document.querySelector('.ticker__track');
  if(tk&&'IntersectionObserver' in window){
    new IntersectionObserver(function(es){es.forEach(function(e){tk.style.animationPlayState=e.isIntersecting?'':'paused';});}).observe(tk);
  }
  /* C) Tilt + gold glare — fine pointers only; touch devices never get tilt listeners. */
  if(FINE&&!RM)document.querySelectorAll('.js-tilt').forEach(function(t){
    t.addEventListener('pointermove',function(e){
      var r=t.getBoundingClientRect(),
      x=(e.clientX-r.left)/r.width-.5,y=(e.clientY-r.top)/r.height-.5;
      t.classList.add('is-tilting');
      t.style.setProperty('--rx',(-y*8).toFixed(2)+'deg');  /* ±4 deg max */
      t.style.setProperty('--ry',( x*8).toFixed(2)+'deg');
      t.style.setProperty('--gx',(x*130)+'px');t.style.setProperty('--gy',(y*130)+'px');
    });
    t.addEventListener('pointerleave',function(){
      t.classList.remove('is-tilting');
      ['--rx','--ry','--gx','--gy'].forEach(function(p){t.style.removeProperty(p);});
    });
  });
  /* D) Magnetic buttons — 40px halo, <=10px pull, rAF-throttled. */
  var M=[].slice.call(document.querySelectorAll('.js-magnet'));
  if(FINE&&!RM&&M.length){var raf=0;
    addEventListener('pointermove',function(e){
      if(raf)return;
      raf=requestAnimationFrame(function(){raf=0;
        M.forEach(function(b){
          var r=b.getBoundingClientRect(),dx=e.clientX-(r.left+r.width/2),dy=e.clientY-(r.top+r.height/2),
          d=Math.hypot(dx,dy),halo=Math.max(r.width,r.height)/2+40;
          if(d<halo){
            var tx=dx*.22,ty=dy*.22,m=Math.hypot(tx,ty);
            if(m>10){tx=tx/m*10;ty=ty/m*10;}
            b.style.transform='translate('+tx.toFixed(1)+'px,'+ty.toFixed(1)+'px)';
          }else{b.style.transform='';}
        });
      });
    },{passive:true});
  }
  /* E) Delegated clicks: ripple, like burst, coin re-flip, theme spin, send kick, seal slam, page-out. */
  addEventListener('click',function(e){
    var tgt=e.target&&e.target.closest?e.target:null;
    if(!tgt)return;
    var b=tgt.closest('.btn');
    if(b&&!RM){var r=b.getBoundingClientRect(),d=Math.max(r.width,r.height)*1.1,s=document.createElement('span');
      s.className='ripple';
      s.style.cssText='width:'+d+'px;height:'+d+'px;left:'+(e.clientX-r.left-d/2)+'px;top:'+(e.clientY-r.top-d/2)+'px';
      b.appendChild(s);s.addEventListener('animationend',function(){s.remove();});}
    var lk=tgt.closest('.btn-like');
    if(lk){lk.classList.toggle('is-on');
      if(!RM&&lk.classList.contains('is-on'))for(var i=0;i<6;i++){
        var sp=document.createElement('span'),an=i*60+Math.random()*24;
        sp.className='spark';
        sp.style.setProperty('--sx',Math.cos(an*Math.PI/180)*34+'px');
        sp.style.setProperty('--sy',Math.sin(an*Math.PI/180)*34+'px');
        lk.appendChild(sp);sp.addEventListener('animationend',function(){this.remove();});}}
    var coin=tgt.closest('.coin-hero');
    if(coin&&!RM){coin.classList.remove('is-flip');void coin.offsetWidth;coin.classList.add('is-flip');}
    var th=tgt.closest('.js-theme');
    if(th&&!RM){th.classList.add('is-spin');setTimeout(function(){th.classList.remove('is-spin');},650);}
    var sd=tgt.closest('.js-send');
    if(sd&&!RM){sd.classList.remove('is-sent');void sd.offsetWidth;sd.classList.add('is-sent');}
    /* Wax-stamp slam on mailbox send — pre-submit visual only, never blocks submission. */
    var sl=tgt.closest('.js-sealsend');
    if(sl&&!RM){var fm=sl.closest('form');var wx=fm?fm.querySelector('.wax-seal--fx'):null;
      if(wx){wx.classList.remove('wax-seal--stamp');void wx.offsetWidth;wx.classList.add('wax-seal--stamp');}}
    /* MPA page-out: 170ms fade/slide before same-origin navigations (bfcache restores via pageshow). */
    var a=tgt.closest('a[href]');
    if(a&&!RM&&!a.target&&!e.metaKey&&!e.ctrlKey&&!a.hasAttribute('download')){
      var href=a.getAttribute('href')||'';
      if(href.charAt(0)!=='#'&&new URL(a.href,location.href).origin===location.origin){
        e.preventDefault();document.body.classList.add('is-leaving');
        if(dzLoader)dzLoader.classList.add('is-on'); /* brief loader flash on internal navigation */
        setTimeout(function(){location.href=a.href;},170);
      }
    }
  });
  addEventListener('pageshow',function(){document.body.classList.remove('is-leaving');dzLoaderOff();});
  /* F) Send fly-off — dzFly(lastBubbleEl); auto-wired to the chat form (optimistic bubble). */
  window.dzFly=function(el){if(RM||!el)return;
    var r=el.getBoundingClientRect(),c=el.cloneNode(true);
    c.classList.add('fly-clone');
    c.style.cssText='left:'+r.left+'px;top:'+r.top+'px;width:'+r.width+'px';
    document.body.appendChild(c);c.addEventListener('animationend',function(){c.remove();});};
  /* G) Live tick helper — call after updating a stat/badge: dzTick(el) */
  window.dzTick=function(el){if(RM||!el)return;el.classList.remove('tick');void el.offsetWidth;el.classList.add('tick');};
  var chatForm=document.getElementById('chatform');
  if(chatForm)chatForm.addEventListener('submit',function(){
    if(RM)return;
    setTimeout(function(){
      var box=document.getElementById('chatbox');
      var last=box?box.querySelector('.bubble.mine:last-child'):null;
      if(last)window.dzFly(last);
    },0);
  });
  /* H) Back-to-top — shows after 600px of scroll, smooth-scrolls to the top. */
  var btt=document.getElementById('back-to-top');
  if(btt){
    var bttSync=function(){btt.classList.toggle('is-show',(window.pageYOffset||document.documentElement.scrollTop||0)>600);};
    addEventListener('scroll',bttSync,{passive:true});bttSync();
    btt.addEventListener('click',function(){window.scrollTo({top:0,behavior:RM?'auto':'smooth'});});
  }
  /* I) Zo — the 24/7 assistant widget. All rendering via createElement/textContent
     (never innerHTML): user text and server text are inserted as text nodes, and the
     server's optional links array becomes internal-only anchor buttons. */
  var zoRoot=document.getElementById('zo');
  if(zoRoot){
    zoRoot.hidden=false;
    var zoFab=document.getElementById('zo-fab'),zoPanel=document.getElementById('zo-panel'),
        zoLog=document.getElementById('zo-log'),zoChips=document.getElementById('zo-chips'),
        zoForm=document.getElementById('zo-form'),zoInput=document.getElementById('zo-input'),
        zoClose=document.getElementById('zo-close');
    var zoOpen=false,zoBusy=false,zoWelcomed=false;
    function zoBubble(text,who,links){
      var wrap=document.createElement('div');wrap.className='zo-msg zo-'+who;
      var bub=document.createElement('div');bub.className='zo-bubble';
      String(text==null?'':text).split('\\n').forEach(function(line,i){
        if(i>0)bub.appendChild(document.createElement('br'));
        bub.appendChild(document.createTextNode(line));
      });
      wrap.appendChild(bub);
      if(links&&links.length){
        var row=document.createElement('div');row.className='zo-links';
        links.forEach(function(l){
          if(!l||typeof l.href!=='string'||l.href.charAt(0)!=='/')return; /* internal links only */
          var a=document.createElement('a');a.className='zo-link';a.href=l.href;
          a.textContent=String(l.label||l.href);
          row.appendChild(a);
        });
        if(row.childNodes.length)wrap.appendChild(row);
      }
      zoLog.appendChild(wrap);zoLog.scrollTop=zoLog.scrollHeight;
      return wrap;
    }
    function zoTyping(on){
      var t=document.getElementById('zo-typing');
      if(on&&!t){
        t=document.createElement('div');t.className='zo-msg zo-zo';t.id='zo-typing';
        var bb=document.createElement('div');bb.className='zo-bubble zo-typing';
        for(var i=0;i<3;i++)bb.appendChild(document.createElement('span'));
        t.appendChild(bb);zoLog.appendChild(t);zoLog.scrollTop=zoLog.scrollHeight;
      }else if(!on&&t){t.remove();}
    }
    function zoSuggest(list){
      zoChips.textContent='';
      (list||[]).slice(0,4).forEach(function(s){
        var c=document.createElement('button');c.type='button';c.className='zo-chip';
        c.textContent=String(s);
        c.addEventListener('click',function(){zoSend(String(s));});
        zoChips.appendChild(c);
      });
    }
    function zoSend(text){
      text=String(text||'').replace(/\s+$/,'').slice(0,500);
      if(!text||zoBusy)return;
      zoBubble(text,'me');zoSuggest([]);
      zoBusy=true;zoTyping(true);
      var start=Date.now();
      fetch('/assistant/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:text})})
        .then(function(r){return r.json();})
        .then(function(d){
          var wait=Math.max(0,600-(Date.now()-start)); /* typing indicator shows ~600ms */
          setTimeout(function(){
            zoTyping(false);zoBusy=false;
            zoBubble(d&&d.reply?d.reply:'Sorry — something went wrong on my side. Please try again.','zo',d&&d.links);
            zoSuggest(d&&d.suggestions);
          },wait);
        })
        .catch(function(){
          zoTyping(false);zoBusy=false;
          zoBubble('Connection hiccup — please try again in a moment.','zo');
        });
    }
    function zoToggle(open){
      zoOpen=open;
      zoPanel.hidden=!open;
      zoFab.setAttribute('aria-expanded',open?'true':'false');
      zoRoot.classList.toggle('is-open',open);
      if(open&&!zoWelcomed){
        zoWelcomed=true;
        zoBubble("Hi! I'm Zo — your 24/7 Dealzoin guide. Ask me about deals, signing, commission, tracking… anything.",'zo');
        zoSuggest(['How do I post a deal?','How does signing work?','What is the commission?']);
      }
      if(open&&!RM)setTimeout(function(){zoInput.focus();},260);
    }
    zoFab.addEventListener('click',function(){zoToggle(!zoOpen);});
    zoClose.addEventListener('click',function(){zoToggle(false);});
    document.addEventListener('keydown',function(e){if(e.key==='Escape'&&zoOpen)zoToggle(false);});
    zoForm.addEventListener('submit',function(e){e.preventDefault();var v=zoInput.value;zoInput.value='';zoSend(v);});
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
// Incoterms: CIF / FOB / CFR — all platform-tracked. (FOP was removed; legacy values migrate to CIF at boot.)
const DEAL_INCOTERMS = ['CIF', 'FOB', 'CFR'];
const INCOTERM_EXPLAINERS = {
  CIF: 'CIF — Cost, Insurance & Freight: the seller pays shipping and insurance to the destination port. Platform tracking enabled.',
  FOB: 'FOB — Free on Board: the seller delivers the goods on board the vessel at the origin port; the buyer takes over from there. Platform tracking enabled.',
  CFR: 'CFR — Cost & Freight: the seller pays freight to the destination port; insurance is on the buyer. Platform tracking enabled.'
};
// Cargo capacity on deal publish (Batch A) — quantity + unit.
const DEAL_CARGO_UNITS = ['MT', 'kg', 'containers/TEU', 'CBM', 'pallets', 'units', 'barrels'];

// ============================= BRANDED DOCUMENT LETTERHEAD =============================
// Every downloadable document (contracts, POs, private contracts, Terms & Conditions)
// shares this beige-and-brown Dealzoin letterhead. The default logo is the built-in
// brand mark; the admin can upload their own (Admin dashboard → Brand & documents).
const BRAND_DOC = {
  beige: '#F4EEE0', cream: '#FBF7EC', sand: '#EDE3CE',
  brown: '#5C4033', bronze: '#B08D57', ink: '#3E2C1E', line: '#D9C9A8'
};
const DEFAULT_BRAND_LOGO = 'data:image/png;base64,' + "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";

/** Current brand logo as a data URI — the admin upload wins over the built-in default. */
function brandLogoDataUri() {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('brand_logo');
    if (row && /^data:image\/(png|jpeg);base64,/.test(String(row.value))) return row.value;
  } catch (e) { /* settings table exists from boot; never break documents */ }
  return DEFAULT_BRAND_LOGO;
}

/** Section heading inside a branded document body. */
function docH(text) {
  return `<div style="font-size:12px;letter-spacing:2px;color:${BRAND_DOC.bronze};text-transform:uppercase;font-weight:bold;margin:20px 0 6px">${esc(text)}</div>`;
}
/** Signature row for a branded document (two parties). */
function brandSignatures(leftLabel, rightLabel) {
  const cell = (l) => `<td style="width:45%;border-top:1px solid ${BRAND_DOC.brown};padding-top:6px;color:${BRAND_DOC.brown};font-size:12px">${esc(l)}</td>`;
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:40px"><tr>${cell(leftLabel)}<td style="width:10%"></td>${cell(rightLabel)}</tr></table>`;
}

/**
 * Branded Word-compatible document shell (table-based — Word renders it reliably):
 * beige header band with logo + wordmark, gold rule, cream body with meta block,
 * brown footer with small print. rows = [[label, valueHtml], ...]; bodyHtml is trusted HTML.
 */
function brandedDoc(opts) {
  const { title, docLabel, docNo, rows = [], bodyHtml = '', footnote = '' } = opts;
  const B = BRAND_DOC;
  const metaRows = rows.map(([k, v]) =>
    `<tr><td style="padding:4px 16px 4px 0;color:${B.bronze};font-size:10px;letter-spacing:1.5px;text-transform:uppercase;font-weight:bold;white-space:nowrap;vertical-align:top">${esc(k)}</td>` +
    `<td style="padding:4px 0;color:${B.ink};font-size:13px">${v}</td></tr>`).join('');
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
<head><meta charset="utf-8"><title>${esc(title)}</title></head>
<body style="font-family:Georgia,'Times New Roman',serif;background:#ffffff;margin:0">
<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${B.line}">
  <tr><td style="background:${B.beige};padding:22px 30px;border-bottom:3px solid ${B.bronze}">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="width:74px;vertical-align:middle"><img src="${brandLogoDataUri()}" width="62" height="62" alt="Dealzoin"></td>
      <td style="vertical-align:middle;padding-left:14px">
        <div style="font-size:25px;font-weight:bold;color:${B.brown};letter-spacing:4px">DEALZOIN</div>
        <div style="font-size:10px;color:${B.bronze};letter-spacing:2px;margin-top:3px">THE B2B TRADE NETWORK &middot; DEALZOIN.COM</div>
      </td>
      <td style="vertical-align:middle;text-align:right">
        <div style="font-size:11px;color:${B.bronze};letter-spacing:2px;text-transform:uppercase">${esc(docLabel)}</div>
        <div style="font-size:17px;font-weight:bold;color:${B.brown};margin-top:3px">${esc(docNo)}</div>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="background:${B.cream};padding:26px 30px">
    <h1 style="font-size:21px;color:${B.brown};margin:0">${esc(title)}</h1>
    <div style="width:60px;height:3px;background:${B.bronze};margin:10px 0 18px"></div>
    ${metaRows ? `<table cellpadding="0" cellspacing="0" style="margin-bottom:16px;border-left:3px solid ${B.sand};padding-left:14px">${metaRows}</table>` : ''}
    <div style="color:${B.ink};font-size:13px;line-height:1.6">${bodyHtml}</div>
  </td></tr>
  <tr><td style="background:${B.brown};padding:12px 30px">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="color:${B.beige};font-size:9px;letter-spacing:1.5px">DEALZOIN &middot; B2B TRADE NETWORK</td>
      <td style="color:${B.bronze};font-size:9px;text-align:right">Generated ${esc(now())}${footnote ? ' &middot; ' + esc(footnote) : ''}</td>
    </tr></table>
  </td></tr>
</table>
</body></html>`;
}

// ----- Batch A: per-company platform palettes (composed with the dark/light toggle) -----
// 'titan' = the default Titan Ledger look; each palette ships dark + light variable overrides
// in the CSS ([data-palette="…"] and [data-palette="…"][data-theme="light"]).
const THEME_PALETTES = {
  titan:           { label: 'Titan',         hint: 'Default — ink navy + struck orange', dark: '#F58A3A', light: '#A8490B' },
  'desert-gold':   { label: 'Desert Gold',   hint: 'Warm sand & bronze',                 dark: '#E3B04B', light: '#8A5A13' },
  'midnight-mint': { label: 'Midnight Mint', hint: 'Deep teal-green accent',             dark: '#2FD6A5', light: '#0E6B54' },
  'royal-dune':    { label: 'Royal Dune',    hint: 'Deep navy + copper',                 dark: '#D08A52', light: '#9A4A1F' }
};
// ----- Logo-based custom themes: the client extracts the logo's dominant colors (canvas),
// posts two hex values, and these helpers derive a full dark+light variable set from them. -----
function hexToRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}
function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360; s = Math.min(1, Math.max(0, s)); l = Math.min(1, Math.max(0, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  const to = v => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}
function rgbaStr(rgb, a) { return `rgba(${rgb.r},${rgb.g},${rgb.b},${a})`; }

/** Validated custom theme for a company row; null unless theme_choice='custom' and the primary color is valid. */
function companyCustomTheme(user) {
  if (!user || user.isAdmin || !user.id) return null;
  try {
    const row = db.prepare('SELECT theme_choice, theme_custom FROM companies WHERE id = ?').get(user.id);
    if (!row || row.theme_choice !== 'custom') return null;
    const p = JSON.parse(row.theme_custom || '');
    if (!p || !hexToRgb(p.primary)) return null;
    return { primary: String(p.primary).toLowerCase(), secondary: hexToRgb(p.secondary) ? String(p.secondary).toLowerCase() : null };
  } catch (e) { return null; }
}

/** Validated palette key for a company row ('titan' default; admin sessions always Titan). */
function companyPalette(user) {
  if (!user || user.isAdmin || !user.id) return 'titan';
  try {
    const row = db.prepare('SELECT theme_choice, theme_custom FROM companies WHERE id = ?').get(user.id);
    if (!row) return 'titan';
    if (row.theme_choice === 'custom') {
      try { const p = JSON.parse(row.theme_custom || ''); if (p && hexToRgb(p.primary)) return 'custom'; } catch (e) { /* fall through */ }
      return 'titan';
    }
    return THEME_PALETTES[row.theme_choice] ? row.theme_choice : 'titan';
  } catch (e) { return 'titan'; }
}

/**
 * Derive a complete dark + light CSS variable override block from the logo colors.
 * Primary drives the --gold accent channel; secondary (or a complementary hue) drives --mint.
 * Dark-mode accents are brightened for contrast; light-mode accents are darkened for beige paper.
 * Backgrounds carry a whisper of the logo hue so the whole page feels branded.
 */
function customThemeStyle(theme) {
  if (!theme) return '';
  const p = hexToRgb(theme.primary);
  const hsl = rgbToHsl(p.r, p.g, p.b);
  const hue = hsl.h;
  const sec = theme.secondary ? hexToRgb(theme.secondary) : null;
  const secHsl = sec ? rgbToHsl(sec.r, sec.g, sec.b) : { h: (hue + 160) % 360, s: 0.45, l: 0.5 };
  const clampL = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const clampS = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // Dark mode
  const dSat = clampS(hsl.s, 0.45, 0.9), dLight = clampL(hsl.l, 0.55, 0.72);
  const dAccent = hslToHex(hue, dSat, dLight);
  const dDeep = hslToHex(hue, dSat, Math.max(0.38, dLight - 0.18));
  const dBright = hslToHex(hue, clampS(hsl.s + 0.1, 0, 0.95), Math.min(0.8, dLight + 0.12));
  const sSatD = clampS(secHsl.s, 0.35, 0.85), sLightD = clampL(secHsl.l, 0.5, 0.7);
  const dMint = hslToHex(secHsl.h, sSatD, sLightD);
  const dMintDeep = hslToHex(secHsl.h, sSatD, Math.max(0.34, sLightD - 0.14));
  const dRgb = hexToRgb(dAccent);
  const bg = (l) => hslToHex(hue, Math.min(0.32, dSat * 0.4), l);
  // Light mode (warm paper, never white)
  const lSat = clampS(hsl.s, 0.4, 0.85), lLight = clampL(hsl.l, 0.22, 0.38);
  const lAccent = hslToHex(hue, lSat, lLight);
  const lDeep = hslToHex(hue, lSat, Math.max(0.14, lLight - 0.1));
  const lMint = hslToHex(secHsl.h, clampS(secHsl.s, 0.35, 0.8), clampL(secHsl.l, 0.2, 0.35));
  const lRgb = hexToRgb(lAccent);
  const lw = (l) => hslToHex(hue, Math.min(0.38, lSat * 0.45), l);
  return `<style>
  [data-palette="custom"] {
    --bg-void: ${bg(0.07)}; --bg-elevated: ${bg(0.10)}; --bg-spotlight: ${bg(0.13)};
    --surface-card: ${bg(0.095)}; --surface-deal: linear-gradient(165deg, ${bg(0.12)} 0%, ${bg(0.07)} 60%, ${bg(0.11)} 100%);
    --gold: ${dAccent}; --gold-deep: ${dDeep}; --gold-bright: ${dBright}; --gold-glow: ${rgbaStr(dRgb, 0.14)};
    --mint: ${dMint}; --mint-deep: ${dMintDeep};
    --ink-primary: ${hslToHex(hue, 0.28, 0.92)}; --ink-muted: ${hslToHex(hue, 0.18, 0.68)}; --ink-faint: ${hslToHex(hue, 0.14, 0.52)};
    --border-soft: ${hslToHex(hue, 0.25, 0.2)}; --border-gold: ${rgbaStr(dRgb, 0.42)};
    --gradient-coin: linear-gradient(120deg, ${dDeep} 0%, ${dAccent} 45%, ${hslToHex(hue, dSat, Math.max(0.28, dLight - 0.3))} 100%);
    --nav-bg: ${rgbaStr(hexToRgb(bg(0.07)), 0.85)};
    --bg-glow: radial-gradient(1200px 600px at 50% -10%, ${rgbaStr(dRgb, 0.09)}, transparent 60%);
    --bubble-mine-bg: linear-gradient(160deg, ${hslToHex(hue, dSat * 0.55, 0.2)} 0%, ${hslToHex(hue, dSat * 0.55, 0.14)} 100%);
    --bubble-theirs-bg: ${bg(0.11)};
    --gold-shadow-sm: 0 2px 12px ${rgbaStr(dRgb, 0.20)}; --gold-shadow-md: 0 4px 18px ${rgbaStr(dRgb, 0.16)};
    --gold-shadow-lg: 0 8px 26px ${rgbaStr(dRgb, 0.26)}; --gold-shadow-plus: 0 4px 18px ${rgbaStr(dRgb, 0.20)};
    --gold-shadow-plus-hover: 0 8px 26px ${rgbaStr(dRgb, 0.32)}; --shadow-gold: 0 6px 22px ${rgbaStr(dRgb, 0.24)};
  }
  [data-palette="custom"][data-theme="light"] {
    --bg-void: ${lw(0.92)}; --bg-elevated: ${lw(0.88)}; --bg-spotlight: ${lw(0.95)};
    --surface-card: ${lw(0.955)}; --surface-deal: linear-gradient(165deg, ${lw(0.965)} 0%, ${lw(0.915)} 55%, ${lw(0.94)} 100%);
    --gold: ${lAccent}; --gold-deep: ${lDeep}; --gold-bright: ${lDeep}; --gold-glow: ${rgbaStr(lRgb, 0.14)};
    --mint: ${lMint}; --mint-deep: ${lMint};
    --ink-primary: ${hslToHex(hue, 0.35, 0.13)}; --ink-muted: ${hslToHex(hue, 0.22, 0.33)}; --ink-faint: ${hslToHex(hue, 0.16, 0.46)};
    --border-soft: ${hslToHex(hue, 0.28, 0.79)}; --border-gold: ${rgbaStr(lRgb, 0.45)};
    --gradient-coin: linear-gradient(120deg, ${lDeep} 0%, ${lAccent} 45%, ${lDeep} 100%);
    --nav-bg: ${rgbaStr(hexToRgb(lw(0.955)), 0.88)};
    --bg-glow: radial-gradient(1200px 600px at 50% -10%, ${rgbaStr(lRgb, 0.10)}, transparent 60%);
    --bubble-mine-bg: linear-gradient(160deg, ${hslToHex(hue, lSat * 0.6, 0.85)} 0%, ${hslToHex(hue, lSat * 0.6, 0.78)} 100%);
    --bubble-theirs-bg: ${lw(0.93)};
    --gold-shadow-sm: 0 2px 12px ${rgbaStr(lRgb, 0.22)}; --gold-shadow-md: 0 4px 18px ${rgbaStr(lRgb, 0.18)};
    --gold-shadow-lg: 0 8px 26px ${rgbaStr(lRgb, 0.28)}; --gold-shadow-plus: 0 4px 18px ${rgbaStr(lRgb, 0.22)};
    --gold-shadow-plus-hover: 0 8px 26px ${rgbaStr(lRgb, 0.34)}; --shadow-gold: 0 6px 22px ${rgbaStr(lRgb, 0.26)};
  }
  </style>`;
}
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
/** Themed gold shipment stepper (open → production → dispatched → shipped → delivered).
 *  Commission-gated deals (payment_status pending_payment/paid) behave differently: the stepper
 *  tracks the post-contract SHIPMENT progress instead of forcing all-done, and while the payment
 *  is pending it renders frozen behind a lock overlay. Legacy deals (payment_status 'none') are unchanged. */
function stepperHtml(deal) {
  const gated = paymentGateApplies(deal);
  const locked = deal.payment_status === 'pending_payment';
  const closed = deal.contract_state === 'approved' || deal.status === 'closed';
  const allDone = closed && !gated; // legacy behavior: finalized deals show the whole pipeline done
  const curIdx = DEAL_STATUSES.indexOf(deal.status);
  const doneThrough = allDone ? DEAL_STATUSES.length - 1 : (curIdx < 0 ? 0 : curIdx);
  const nodes = DEAL_STATUSES.map((s, i) => {
    const cls = allDone || i < doneThrough ? 'done' : (i === doneThrough ? (allDone ? 'done' : 'current done') : '');
    return `<div class="step-node ${cls}" style="--i:${i}"><span class="step-dot">${allDone || i <= doneThrough ? '✓' : (i + 1)}</span><span class="step-lbl">${esc(s)}</span></div>`;
  }).join('');
  const fillPct = allDone ? 100 : Math.round((doneThrough / (DEAL_STATUSES.length - 1)) * 100);
  const core = `<div class="stepper" role="list" aria-label="Deal status">${nodes}</div>`
    + `<div class="stepper__bar" aria-hidden="true" style="--p:${fillPct}%"></div>`;
  const lockOverlay = locked ? `<div style="position:relative" aria-label="Tracking locked">
      <div style="opacity:.4;filter:grayscale(.5);pointer-events:none" aria-hidden="true">${core}</div>
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:8px">
        <div style="background:var(--surface-card);border:1px solid var(--border-gold);border-radius:12px;padding:10px 16px;text-align:center;box-shadow:var(--gold-shadow-md);font-weight:600">${PAYMENT_LOCK_MSG}</div>
      </div>
    </div>` : core;
  return lockOverlay
    + (closed ? '<p style="margin-top:8px"><span class="badge badge-contract">Deal closed — contract finalized ✓</span></p>' : '');
}

// ----- Shipment tracking maps (Leaflet 1.9.4 + OpenStreetMap via CDN, no API keys) -----
/** Leaflet assets + leaflet-only theme overrides — loaded ONLY on pages that render a map,
 *  via the page() headExtra slot. No API keys anywhere; tiles come from OpenStreetMap. */
const LEAFLET_HEAD = '<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">\n'
  + '<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>\n'
  + '<style>'
  + '.map-embed .leaflet-tile-pane{filter:saturate(.92)}'
  + 'html:not([data-theme="light"]) .map-embed .leaflet-tile-pane{filter:brightness(.78) saturate(.72) contrast(1.06)}'
  + '.map-embed .leaflet-container{font:inherit;background:var(--bg-elevated)}'
  + '.map-embed .leaflet-popup-content-wrapper{background:var(--surface-card);color:var(--ink-primary);border:1px solid var(--border-gold);border-radius:12px;box-shadow:var(--gold-shadow-md)}'
  + '.map-embed .leaflet-popup-tip{background:var(--surface-card);border:1px solid var(--border-gold)}'
  + '.map-embed .leaflet-popup-content{font:500 0.82rem var(--font-body);color:var(--ink-primary)}'
  + '.map-embed .leaflet-popup-content a{color:var(--gold)}'
  + '.map-embed .leaflet-bar a{background:var(--surface-card);color:var(--gold);border-color:var(--border-soft)}'
  + '.map-embed .leaflet-control-attribution{background:rgba(0,0,0,.35);color:var(--ink-muted);font-size:10px}'
  + '.map-embed .leaflet-control-attribution a{color:var(--gold)}'
  + '</style>';

/** JSON-encode a value for safe embedding in an inline <script>: escapes "<" so an injected
 *  place name can never close the script block or open a tag. */
function jsJson(v) {
  return JSON.stringify(v).replace(/</g, '\\u003c');
}

/** True for a plausible latitude/longitude pair (SQLite NULLs and NaNs fail). */
function validLatLng(lat, lng) {
  return typeof lat === 'number' && typeof lng === 'number'
    && isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

/** Geocode a place name via OSM Nominatim (free, key-less) backed by the permanent geocache table.
 *  Lazy — only called when a map page actually needs coordinates. Any failure (offline, 5s timeout,
 *  no result) resolves to null; callers render the map placeholder instead. Never throws. */
async function geocode(place) {
  const key = String(place || '').trim().slice(0, 200);
  if (!key) return null;
  try {
    const cached = db.prepare('SELECT lat, lng FROM geocache WHERE place = ?').get(key);
    if (cached && validLatLng(cached.lat, cached.lng)) return { lat: cached.lat, lng: cached.lng };
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) { /* already settled */ } }, 5000);
    let rows = null;
    try {
      const resp = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(key), {
        headers: { 'User-Agent': 'Dealzoin/1.0 (contact: admin)', 'Accept': 'application/json' },
        signal: ctrl.signal
      });
      if (resp && resp.ok) rows = await resp.json();
    } finally {
      clearTimeout(timer);
    }
    const lat = rows && rows[0] ? parseFloat(rows[0].lat) : NaN;
    const lng = rows && rows[0] ? parseFloat(rows[0].lon) : NaN;
    if (!validLatLng(lat, lng)) return null;
    try {
      db.prepare('INSERT INTO geocache (place, lat, lng, created_at) VALUES (?,?,?,?) ON CONFLICT(place) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, created_at = excluded.created_at')
        .run(key, lat, lng, now());
    } catch (e) { /* cache write is best-effort */ }
    return { lat, lng };
  } catch (e) {
    return null; // offline / DNS failure / timeout / abort — the map shows its placeholder
  }
}

/** Lazily resolve + persist a deal's origin/destination coordinates (geocoded on first map view,
 *  then cached in the deals row and the geocache table). Never throws — missing pieces stay null. */
async function dealGeo(deal) {
  const geo = { oLat: null, oLng: null, dLat: null, dLng: null };
  try {
    if (validLatLng(deal.origin_lat, deal.origin_lng)) { geo.oLat = deal.origin_lat; geo.oLng = deal.origin_lng; }
    else if (deal.origin) {
      const g = await geocode(deal.origin);
      if (g) {
        geo.oLat = g.lat; geo.oLng = g.lng;
        try { db.prepare('UPDATE deals SET origin_lat = ?, origin_lng = ? WHERE id = ?').run(g.lat, g.lng, deal.id); } catch (e) { /* best-effort */ }
      }
    }
  } catch (e) { /* keep nulls */ }
  try {
    if (validLatLng(deal.dest_lat, deal.dest_lng)) { geo.dLat = deal.dest_lat; geo.dLng = deal.dest_lng; }
    else if (deal.destination) {
      const g = await geocode(deal.destination);
      if (g) {
        geo.dLat = g.lat; geo.dLng = g.lng;
        try { db.prepare('UPDATE deals SET dest_lat = ?, dest_lng = ? WHERE id = ?').run(g.lat, g.lng, deal.id); } catch (e) { /* best-effort */ }
      }
    }
  } catch (e) { /* keep nulls */ }
  return geo;
}

/** Shipment progress fraction (0..1) along the origin→destination route, derived from the current
 *  deal status at render time: open/production 5%, dispatched 35%, shipped 65%, delivered/closed 100%. */
function statusProgress(deal) {
  if (!deal) return 0.05;
  if (paymentGateApplies(deal)) { // gated deals: track post-payment shipment progress (status may still read 'closed' right after final approval)
    if (deal.status === 'delivered') return 1;
    if (deal.status === 'dispatched') return 0.35;
    if (deal.status === 'shipped') return 0.65;
    return 0.05;
  }
  if (deal.contract_state === 'approved' || deal.status === 'closed' || deal.status === 'delivered') return 1;
  if (deal.status === 'dispatched') return 0.35;
  if (deal.status === 'shipped') return 0.65;
  return 0.05; // open | production
}

/** Client-side per-deal map script: origin (gold) + destination (mint) markers, dashed gold route,
 *  and a shipment dot that eases toward the status-derived position with gentle idle bobbing.
 *  Fully defensive: no Leaflet / bad coords / render errors degrade to a themed fallback note. */
const DEAL_MAP_SCRIPT = `<script>(function(){
  var el=document.getElementById('deal-map');
  if(!el)return;
  function escH(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function fallback(msg){el.innerHTML='<div class="map-fallback">'+escH(msg)+'</div>';}
  if(typeof L==='undefined'){fallback('🗺️ Map unavailable — the mapping library could not be loaded (you may be offline).');return;}
  var oLat=parseFloat(el.getAttribute('data-olat')),oLng=parseFloat(el.getAttribute('data-olng'));
  var dLat=parseFloat(el.getAttribute('data-dlat')),dLng=parseFloat(el.getAttribute('data-dlng'));
  var target=parseFloat(el.getAttribute('data-progress'));
  if(!isFinite(oLat)||!isFinite(oLng)||!isFinite(dLat)||!isFinite(dLng)){fallback('Location could not be geocoded yet.');return;}
  if(!isFinite(target))target=0.05;
  var originName=el.getAttribute('data-origin')||'Origin';
  var destName=el.getAttribute('data-dest')||'Destination';
  var dealNum=el.getAttribute('data-dealnum')||'';
  var status=el.getAttribute('data-status')||'';
  try{
    var map=L.map(el,{scrollWheelZoom:false});
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18,attribution:'&copy; OpenStreetMap contributors'}).addTo(map);
    L.marker([oLat,oLng],{icon:L.divIcon({className:'dz-marker dz-marker-gold',iconSize:[16,16],iconAnchor:[8,8]})}).addTo(map)
      .bindPopup('<b>'+escH(originName)+'</b><br>Deal '+escH(dealNum)+' · origin · '+escH(status));
    L.marker([dLat,dLng],{icon:L.divIcon({className:'dz-marker dz-marker-mint',iconSize:[16,16],iconAnchor:[8,8]})}).addTo(map)
      .bindPopup('<b>'+escH(destName)+'</b><br>Deal '+escH(dealNum)+' · destination · '+escH(status));
    L.polyline([[oLat,oLng],[dLat,dLng]],{color:'#E8772A',weight:2.5,dashArray:'7 7',opacity:.9}).addTo(map);
    var ship=L.marker([oLat,oLng],{icon:L.divIcon({className:'dz-ship-dot',iconSize:[14,14],iconAnchor:[7,7]}),interactive:false}).addTo(map);
    map.fitBounds([[oLat,oLng],[dLat,dLng]],{padding:[36,36]});
    function lerp(a,b,t){return a+(b-a)*t;}
    function posAt(t,bob){var lt=lerp(oLat,dLat,t),ln=lerp(oLng,dLng,t);if(bob)lt+=Math.sin(bob)*0.003*(Math.abs(dLng-oLng)+1);return [lt,ln];}
    var reduce=!!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if(reduce){ship.setLatLng(posAt(target,0));}
    else{
      var cur=0,t0=null;
      var frame=function(ts){
        if(t0===null)t0=ts;
        var dt=Math.min(0.05,(ts-t0)/1000);t0=ts;
        cur+=(target-cur)*Math.min(1,dt*1.8);
        if(Math.abs(target-cur)<0.0005)cur=target;
        ship.setLatLng(posAt(cur,ts/900));
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }
  }catch(e){fallback('🗺️ Map could not be rendered here.');}
})();</script>`;

/** Per-deal shipment tracking map section (CIF/FOB/CFR only; caller enforces parties + admin guard).
 *  Returns { html, needsLeaflet }. When either end lacks coordinates a themed placeholder card is
 *  rendered instead — the deal page never errors on geocoding failures. */
function dealMapSection(deal, geo) {
  const hasO = validLatLng(geo.oLat, geo.oLng);
  const hasD = validLatLng(geo.dLat, geo.dLng);
  if (!hasO || !hasD) {
    const bits = [];
    if (!hasO) bits.push(deal.origin ? `origin "${esc(deal.origin)}" could not be geocoded yet` : 'no origin set');
    if (!hasD) bits.push(deal.destination ? `destination "${esc(deal.destination)}" could not be geocoded yet` : 'no destination set yet');
    return { needsLeaflet: false, html: `<div class="card map-placeholder" data-reveal>
      <h3>🗺️ Shipment tracking map</h3>
      <p class="muted" style="margin-top:8px">Map activates once origin &amp; destination are geocoded.</p>
      <p class="muted" style="font-size:12px;margin-top:6px">${bits.join(' · ')}.</p>
    </div>` };
  }
  const statusLabel = (deal.contract_state === 'approved' || deal.status === 'closed') ? 'closed' : (deal.status || 'open');
  return { needsLeaflet: true, html: `<div class="card" data-reveal>
    <h3>🗺️ Shipment tracking map <span class="muted" style="font-weight:400">· ${esc(deal.incoterm || 'CIF')} · ${esc(deal.origin || '?')} → ${esc(deal.destination || '?')}</span></h3>
    <div id="deal-map" class="map-embed" role="img" aria-label="Shipment route map"
      data-olat="${geo.oLat}" data-olng="${geo.oLng}" data-dlat="${geo.dLat}" data-dlng="${geo.dLng}"
      data-progress="${statusProgress(deal)}" data-origin="${esc(deal.origin || 'Origin')}" data-dest="${esc(deal.destination || 'Destination')}"
      data-dealnum="${esc(deal.deal_number || '#' + deal.id)}" data-status="${esc(statusLabel)}"></div>
    ${DEAL_MAP_SCRIPT}
  </div>` };
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
      <label>Destination (optional)</label><input type="text" name="destination" maxlength="160" placeholder="e.g. Jebel Ali, Dubai">
      <p class="muted" style="margin:-6px 0 12px">Sell deals: the buyer's port/city — can be set from the buyer's LOI later. Powers the CIF/FOB/CFR shipment tracking map.</p>
      <label>Incoterm</label>
      <select name="incoterm" id="incoterm-select">${optionsHtml(DEAL_INCOTERMS, 'CIF')}</select>
      <p class="muted" style="margin:-6px 0 12px">${DEAL_INCOTERMS.map(i => esc(INCOTERM_EXPLAINERS[i])).join('<br>')}</p>
      <label>Deal value (e.g. 50,000 / year) — shared privately, never shown on feeds</label><input type="text" name="value" maxlength="80">
      <div class="grid2" style="gap:10px">
        <div><label>Cargo quantity (optional)</label><input type="number" name="cargo_qty" min="0" step="any" placeholder="e.g. 12000" inputmode="decimal"></div>
        <div><label>Cargo unit</label><select name="cargo_unit">${optionsHtml(DEAL_CARGO_UNITS, 'MT')}</select></div>
      </div>
      <p class="muted" style="margin:-6px 0 12px">📦 Cargo capacity is shown only to you, negotiating counterparties and the admin — never on the public timeline.</p>
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
          <label class="file-btn dropzone"><span class="file-btn-text" data-default="📎 Upload product proof (PDF, max 15 MB)">📎 Upload product proof (PDF, max 15 MB)</span>
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
  return `<label class="file-btn dropzone"><span class="file-btn-text" data-default="${esc(def)}">${esc(def)}</span><input type="file" class="file-input" name="media" accept="${MEDIA_ACCEPT}"></label>`;
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
  const c = db.prepare('SELECT id, name, status, lang FROM companies WHERE id = ?').get(sess.company_id);
  if (!c || c.status !== 'approved') return null;
  // Sub-account session: resolve the member (must still be active) and attach attribution info.
  if (sess.member_id) {
    const m = db.prepare(`SELECT id, name, role, status FROM company_members WHERE id = ? AND company_id = ?`).get(sess.member_id, c.id);
    if (!m || m.status !== 'active') return null;
    return { id: c.id, name: c.name, isAdmin: false, memberId: m.id, memberName: m.name, memberRole: m.role, lang: c.lang || 'en' };
  }
  return { id: c.id, name: c.name, isAdmin: false, lang: c.lang || 'en' };
}
/** Paths a company may POST to even when their T&C agreement is stale (else they could never re-agree or log out). */
const TERMS_STALE_POST_WHITELIST = new Set(['/terms/agree', '/logout', '/lang']);
/** Guard: approved company session required. Stale T&C version blocks ALL mutating actions server-side (the popup is enforced, not cosmetic). */
function requireCompany(req, res, next) {
  const user = currentUser(req);
  if (!user || user.isAdmin) return res.redirect('/login?err=' + encodeURIComponent('Please sign in with an approved company account.'));
  if (req.method === 'POST' && !TERMS_STALE_POST_WHITELIST.has(req.path)) {
    try {
      const tv = db.prepare('SELECT agreed_terms_version FROM companies WHERE id = ?').get(user.id);
      if (!tv || (tv.agreed_terms_version || 0) < TERMS_VERSION) {
        audit('ONBOARDING AGENT', 'terms gate enforcement', 'fail', `Blocked POST ${req.path} — "${user.name}" has not agreed to T&C v${TERMS_VERSION}`);
        return res.redirect('/profile?err=' + encodeURIComponent(`Please read and agree to the updated Terms & Conditions (v${TERMS_VERSION}) before continuing.`));
      }
    } catch (e) { /* column may not exist during first-boot migration — do not block */ }
  }
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
  // Real platform statistics — counted live from the database, never invented.
  let stCompanies = 0, stDeals = 0, stClosed = 0, stDocs = 0;
  try {
    stCompanies = db.prepare("SELECT COUNT(*) AS n FROM companies WHERE status='approved'").get().n;
    stDeals     = db.prepare("SELECT COUNT(*) AS n FROM deals").get().n;
    stClosed    = db.prepare("SELECT COUNT(*) AS n FROM deals WHERE contract_state='approved'").get().n;
    stDocs      = db.prepare("SELECT COUNT(*) AS n FROM documents WHERE authenticity_status='pass'").get().n;
  } catch (e) { /* stats are decorative — never break the landing page */ }
  const body = `
  <div class="hero">
    <div class="bg-grid" aria-hidden="true"></div>
    <div class="orb orb--gold" aria-hidden="true"></div>
    <div class="hero-in">
      <div class="coin-hero" role="button" tabindex="0" aria-label="Dealzoin mint coin — activate to flip">Dz</div>
      <div class="kicker a-enter" data-stage="hero" style="--i:0">The B2B deal network</div>
      <h1 class="display-xl"><span class="w" style="--i:0"><span>Verified</span></span> <span class="w" style="--i:1"><span>Partners.</span></span> <span class="w" style="--i:2"><span>Private</span></span> <span class="w" style="--i:3"><span>Rooms.</span></span> <span class="w" style="--i:4"><span>Signed</span></span> <span class="w" style="--i:5"><span>Deals.</span></span></h1>
      <p class="a-enter" data-stage="hero" style="--i:2">Dealzoin is the closed network where vetted companies post opportunities, negotiate in private deal rooms, and sign — every step on the record.</p>
      <div class="a-enter" data-stage="hero" style="--i:3">
      ${user
        ? `<a class="btn js-magnet" href="${user.isAdmin ? '/admin' : '/timeline'}">Enter the Deal Floor &rarr;</a>`
        : `<a class="btn js-magnet" href="/signup">Enter the Deal Floor &rarr;</a>
           &nbsp; <a class="btn btn-outline" href="#why">See how it works</a>`}
      </div>
    </div>
  </div>
  <div id="why">
    <div class="kicker a-enter" data-stage="cards" style="--i:0">Why Dealzoin</div>
    <h2 class="display-lg a-enter" data-stage="cards" style="--i:1;margin:6px 0 16px">Built for companies that mean business..</h2>
  </div>
  <div class="steps">
    <div class="card card--cut js-tilt a-enter" data-stage="cards" style="--i:2" data-num="01"><h3>01 Verified Network</h3><p class="muted">Every company is identity-checked and trade-referenced before it can post. No anonymous offers. Ever.</p></div>
    <div class="card card--cut is-feature js-tilt a-enter" data-stage="cards" style="--i:3" data-num="02"><h3>02 Private Deal Rooms</h3><p>Negotiate terms, exchange documents and message counterparties in encrypted rooms — sealed until both sides sign.</p></div>
    <div class="card card--cut js-tilt a-enter" data-stage="cards" style="--i:4" data-num="03"><h3>03 The Trust Ledger</h3><p class="muted">Every offer, counter-offer and signature is timestamped to an audit trail your compliance team will actually enjoy.</p></div>
  </div>
  <div class="stats">
    <div class="stat card--cut rv" style="--i:0" data-num="01"><div class="num gold" data-count="${stCompanies}">${stCompanies}</div><div class="lbl">Verified companies</div></div>
    <div class="stat card--cut rv" style="--i:1" data-num="02"><div class="num gold" data-count="${stDeals}">${stDeals}</div><div class="lbl">Deals posted</div></div>
    <div class="stat card--cut rv" style="--i:2" data-num="03"><div class="num gold" data-count="${stClosed}">${stClosed}</div><div class="lbl">Deals closed</div></div>
    <div class="stat card--cut rv" style="--i:3" data-num="04"><div class="num gold" data-count="${stDocs}">${stDocs}</div><div class="lbl">Documents verified</div></div>
  </div>`;
  res.send(page('Welcome', body, user, req.query.msg, req.query.err, undefined, undefined, { lang: reqLang(req) }));
});

// ============================= TERMS & CONDITIONS (REGISTRATION) =============================
// Bump TERMS_VERSION whenever the clauses change — companies on an older version must
// re-agree via the blocking modal (agreed_terms_version + agreed_at on companies).
const TERMS_VERSION = 2;
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

/** Terms & Conditions modal markup (Batch A). mode 'signup': opened by a button on the
 *  registration form, agreeing checks the five pledge boxes. mode 'gate': blocking
 *  re-agreement overlay for logged-in companies whose agreed version is outdated —
 *  submits POST /terms/agree. In both modes the Agree button stays disabled until the
 *  terms body is scrolled to the bottom, and there is no Esc/backdrop dismissal. */
function termsGateHtml(mode) {
  const gate = mode === 'gate';
  const id = gate ? 'terms-gate' : 'terms-signup';
  const agreeInner = gate
    ? `<form method="POST" action="/terms/agree" style="margin:0">
         <button class="btn terms-agree-btn" type="submit" disabled>I have read and agree to the Terms &amp; Conditions</button>
       </form>`
    : `<button class="btn terms-agree-btn" type="button" disabled>I have read and agree to the Terms &amp; Conditions</button>`;
  return `<div class="terms-gate${gate ? ' terms-gate--force' : ''}" id="${id}" data-mode="${gate ? 'gate' : 'signup'}" data-version="${TERMS_VERSION}" role="dialog" aria-modal="true" aria-labelledby="${id}-title">
  <div class="terms-modal">
    <div class="terms-modal__head">
      <div class="kicker">Dealzoin legal · version ${TERMS_VERSION}</div>
      <h3 id="${id}-title">📜 Terms &amp; Conditions</h3>
      <p class="muted" style="margin:2px 0 0">${gate ? 'Our Terms & Conditions have been updated. Please read and re-agree to continue using Dealzoin.' : 'Read the full registration agreement. Agreeing here also checks the five pledges in the form.'}</p>
    </div>
    <div class="terms-modal__body" tabindex="0" aria-label="Terms and Conditions text">
      ${termsClauses().map(c => `<p>${esc(c)}</p>`).join('')}
      <p class="muted">— End of the Terms &amp; Conditions (v${TERMS_VERSION}). Accepting here is legally equivalent to signing. —</p>
    </div>
    <div class="terms-modal__foot">
      <span class="terms-scroll-hint">↓ Scroll to the end of the Terms &amp; Conditions to enable agreement</span>
      ${agreeInner}
    </div>
  </div>
</div>`;
}
const COMPANY_CATEGORIES = ['Trading', 'Manufacturing', 'Logistics', 'Technology', 'Agriculture', 'Energy', 'Construction', 'Healthcare', 'Finance', 'Other'];

/** Full registration Terms & Conditions page (public). */
app.get('/legal/terms', (req, res) => {
  const body = `
  <div class="card vault">
    <div class="kicker">Legal · Registration agreement</div>
    <h2 style="margin:6px 0 10px">📜 Dealzoin Terms &amp; Conditions</h2>
    <p class="muted" style="margin-bottom:12px">These terms govern company registration on the Dealzoin B2B network. Every registering company reads and accepts them in the registration popup — the typed legal signature on the form acts as the signature on these Terms.</p>
    ${termsClauses().map(c => `<p style="margin-bottom:10px">${esc(c)}</p>`).join('')}
    <hr class="sep">
    <div class="feed-actions" style="margin-top:12px">
      <a class="btn btn-outline" href="/signup">Back to registration</a>
    </div>
  </div>`;
  res.send(page('Terms & Conditions', body, currentUser(req), req.query.msg, req.query.err));
});

/** Download the Terms & Conditions as a branded Word-compatible reference copy (acceptance happens in the popup — this is for records). */
app.get('/legal/terms/download', (req, res) => {
  const doc = brandedDoc({
    title: 'Registration Terms & Conditions',
    docLabel: 'Terms & Conditions',
    docNo: 'Version ' + TERMS_VERSION,
    rows: [
      ['Version', 'v' + TERMS_VERSION],
      ['Generated', esc(now())],
      ['Applies to', 'All companies registering on the Dealzoin network']
    ],
    bodyHtml:
      docH('The five pledges & terms') +
      termsClauses().map(c => `<p style="margin-bottom:10px">${esc(c)}</p>`).join('') +
      `<p style="margin-top:16px;font-style:italic">Acceptance is recorded digitally: companies read and accept these Terms in the scroll-to-agree registration popup, and the typed legal signature on the registration form acts as the signature on this document.</p>`,
    footnote: 'Terms v' + TERMS_VERSION
  });
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
      <label class="file-btn dropzone"><span class="file-btn-text" data-default="📎 ${esc(label)}">📎 ${esc(label)}</span>
        <input type="file" class="file-input" name="${name}" accept="application/pdf,.pdf"${required ? ' required' : ''}></label>`;
  const body = `
  <div class="card" style="max-width:620px;margin:0 auto" data-reveal>
    <div class="kicker">Compliance-grade registration</div>
    <h2 style="margin:6px 0 8px">Register your company</h2>
    <p class="muted" style="margin-bottom:14px">Companies only — no individual accounts. New companies are reviewed by an admin before they can trade.</p>

    <div class="card" style="background:var(--bg-elevated)">
      <h3 style="margin-bottom:6px">Step 1 — Company profile PDF <span class="muted">(optional, encouraged)</span></h3>
      <p class="muted" style="margin-bottom:10px">Upload your company profile and our agent will auto-fill the form below for you to review.</p>
      <label class="file-btn dropzone"><span class="file-btn-text" id="profile-label" data-default="📎 Upload your company profile (PDF)">📎 Upload your company profile (PDF)</span>
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
      <label>Terms &amp; Conditions (required)</label>
      <p class="muted" style="margin-bottom:8px">
        <button type="button" class="btn btn-sm btn-outline js-terms-open" data-target="terms-signup" style="margin-bottom:8px">📜 Read &amp; accept the Terms &amp; Conditions (v${TERMS_VERSION})</button>
        <span id="terms-status" class="muted" style="display:block;margin-bottom:6px">Opens a scroll-to-agree popup — accepting also checks the five pledges below. Your typed signature at the bottom of this form acts as your legal signature on the Terms.</span></p>
      ${docInput('activity_proof', 'Activity proof (e.g. portfolio, catalog, past invoices)', false)}

      <hr class="sep">
      <h3 style="margin-bottom:6px">Pledges &amp; signature</h3>
      ${pledgeBoxes}
      <label>Typed legal signature — type your full legal name; this acts as your signature</label>
      <input type="text" name="signature_name" required maxlength="120" placeholder="Full legal name of the authorized signatory">
      <p class="muted" style="margin-bottom:12px">Your signature timestamp and IP address are recorded with this registration.</p>
      <button class="btn js-magnet" type="submit">Create company account</button>
    </form>
    <p class="muted" style="margin-top:12px">Already approved? <a href="/login">Sign in</a></p>
    <p class="shield-note">🛡️ Screened by the Onboarding &amp; Document Authenticity agents</p>
  </div>
  ${termsGateHtml('signup')}
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
  for (const docType of ['moa_authority', 'bank_statement']) {
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
              category, activity, trade_license, signature_name, signature_at, signature_ip, agreed_terms_version, agreed_at)
              VALUES (?,?,?,?,?,?, 'pending', ?, ?, ?, ?,?,?,?,?,?,?,?)`)
    .run(nm, em, hashPassword(b.password, salt), salt,
         site, String(b.description || '').trim().slice(0, 2000),
         check.flags.length ? 1 : 0, check.flags.join('; '), now(),
         category, activity, tradeLicense, signatureName, now(), signatureIp,
         TERMS_VERSION, now()); // registration pledges accepted => current terms version recorded
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
  const lang = reqLang(req);
  const body = `
  <div class="card" style="max-width:440px;margin:0 auto">
    <h2>${esc(t(lang, 'auth.welcome'))}</h2>
    <form method="POST" action="/login">
      <label>${esc(t(lang, 'auth.email'))}</label><input type="email" name="email" required>
      <label>${esc(t(lang, 'auth.password'))}</label><input type="password" name="password" required>
      <button class="btn" type="submit">${esc(t(lang, 'auth.signin'))}</button>
    </form>
    <p class="muted" style="margin-top:12px">${esc(t(lang, 'auth.noaccount'))} <a href="/signup">${esc(t(lang, 'auth.register'))}</a></p>
    <p class="muted">Team member? Sign in with your own member email &amp; password.</p>
    <p class="shield-note">🛡️ Protected by Dealzoin security agents</p>
  </div>`;
  res.send(page('Sign in', body, null, req.query.msg, req.query.err, undefined, undefined, { lang }));
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

/** Batch A: record re-agreement to the current Terms & Conditions version (from the
 *  blocking gate modal shown to companies on an outdated terms version). */
app.post('/terms/agree', requireCompany, (req, res) => {
  db.prepare('UPDATE companies SET agreed_terms_version = ?, agreed_at = ? WHERE id = ?').run(TERMS_VERSION, now(), req.user.id);
  audit('ONBOARDING AGENT', 'terms re-agreement', 'pass', `${req.user.name} agreed to Terms & Conditions v${TERMS_VERSION}`);
  res.redirect((req.get('referer') || '/timeline').split('?')[0] + '?msg=' + encodeURIComponent(`Thank you — you have agreed to the Terms & Conditions (v${TERMS_VERSION}).`));
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
           cargo_qty: d.cargo_qty, cargo_unit: d.cargo_unit || '',
           created_at: d.created_at, media_id: d.media_id, author_name: d.author_name || '' };
}
/** Cargo capacity chip — PRIVATE: only the owner, companies with a negotiation on the deal,
 *  and the admin ever see it. Never rendered on public/anonymous surfaces. */
const _cargoNegStmt = db.prepare('SELECT 1 FROM negotiations WHERE deal_id = ? AND (buyer_id = ? OR seller_id = ?) LIMIT 1');
function cargoChipHtml(user, item) {
  const qty = Number(item.cargo_qty);
  if (!isFinite(qty) || qty <= 0 || !user) return '';
  const unit = DEAL_CARGO_UNITS.includes(item.cargo_unit) ? item.cargo_unit : 'units';
  const authorized = user.isAdmin || user.id === item.company_id
    || (!user.isAdmin && !!_cargoNegStmt.get(item.ref_id, user.id, user.id));
  if (!authorized) return '';
  return ` <span class="chip chip-cargo" title="Cargo capacity — visible to deal parties only">📦 ${esc(fmtAmount(qty))} ${esc(unit)}</span>`;
}
/** Render one feed card. kind: 'deal' | 'post' | 'repost'. idx = loop index (entrance stagger). */
function feedCard(item, user, names, idx) {
  const stagger = Math.min(Number.isInteger(idx) ? idx : 0, 8);
  const ownerName = names.get(item.company_id) || 'Unknown';
  const isOwn = user && !user.isAdmin && user.id === item.company_id;
  const lang = (user && user.lang) || 'en';
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
        <button class="btn btn-sm btn-like${soc.liked ? ' liked' : ' btn-outline'}" type="submit" title="Celebrate"><span class="ic">${soc.liked ? 'Liked' : 'Like'} (${soc.likeCount})</span></button>
      </form>
    </div>` : `<p class="muted" style="margin-top:10px">${soc.likeCount} likes</p>`}
  </div>`;
  }

  let head, bodyHtml;
  // Batch C (2): translatable text blocks carry a "🌐 Translate" button (client calls /api/translate).
  const trBtn = (user && !user.isAdmin) ? `<button type="button" class="dz-tr-btn">🌐 ${esc(t(lang, 'tr.translate'))}</button>` : '';
  if (item.kind === 'post') {
    const promoBadge = item.is_promo ? ` <span class="badge badge-promo" title="Published via the Advertising Agent">📣 ${esc(t(lang, 'feed.promoted'))}</span>` : '';
    head = `${avatarHtml(ownerName, companyAvatarMediaId(item.company_id))} <a href="/company/${item.company_id}"><b>${esc(ownerName)}</b></a> <span class="muted">posted</span>${promoBadge}${byLine}`;
    bodyHtml = `<div data-dz-tr><p style="margin-top:8px;white-space:pre-wrap" class="dz-tr-text">${esc(item.body)}</p>${trBtn}</div>`;
  } else if (item.kind === 'deal') {
    head = `${avatarHtml(ownerName, companyAvatarMediaId(item.company_id))} <a href="/company/${item.company_id}"><b>${esc(ownerName)}</b></a> ${starsHtml(companyReputation(item.company_id), true)} <span class="muted">posted a deal</span>${byLine}`;
    bodyHtml = `<h3 style="margin-top:8px"><a href="/deal/${item.ref_id}">${esc(item.title)}</a></h3>
      <div data-dz-tr><p style="margin-top:6px;white-space:pre-wrap" class="dz-tr-text">${esc(item.body)}</p>${trBtn}</div>`;
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
    const chipsLine = `<div style="margin:2px 0">${dealTypeChips(item)} ${dealStatusChip(item)}${cargoChipHtml(user, item)}</div>`;
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
    ? `<a class="btn btn-sm btn-green" href="/deal/${targetId}/loi">${esc(t(lang, 'feed.loi'))}</a>` : '';
  const repostBtn = (item.kind !== 'post' && user && !user.isAdmin && item.orig_company !== user.id && item.company_id !== user.id)
    ? `<form method="POST" action="/repost/${targetId}"><button class="btn btn-sm btn-outline" type="submit">${esc(t(lang, 'feed.repost'))}</button></form>` : '';
  const interact = user && !user.isAdmin ? `
    <div class="feed-actions">
      <form method="POST" action="/like/${targetType}/${targetId}">
        <button class="btn btn-sm btn-like${soc.liked ? ' liked' : ' btn-outline'}" type="submit" title="Back this deal"><span class="ic">${soc.liked ? esc(t(lang, 'feed.liked')) : esc(t(lang, 'feed.like'))} (${soc.likeCount})</span></button>
      </form>
      ${repostBtn}
      ${signBtn}
    </div>
    <div style="margin-top:12px">
      ${commentListHtml(soc.comments, names)}
      <form method="POST" action="/comment/${targetType}/${targetId}" style="margin-top:8px;display:flex;gap:8px">
        <input type="text" name="body" placeholder="${esc(t(lang, 'feed.writecomment'))}" required maxlength="500" style="margin-bottom:0">
        <button class="btn btn-sm" type="submit">${esc(t(lang, 'feed.comment'))}</button>
      </form>
    </div>` : `<p class="muted" style="margin-top:10px">${soc.likeCount} likes · ${soc.comments.length} comments</p>`;

  return `<div class="card${item.kind === 'post' ? '' : ' card-deal js-tilt'}" data-reveal style="--i:${stagger}">
    ${item.kind === 'post' ? '' : '<div class="card__glare" aria-hidden="true"></div>'}
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
             d.author_name, 0 AS is_system, d.cargo_qty, d.cargo_unit, 0 AS is_promo
      FROM deals d ${filterSql}
      UNION ALL
      SELECT 'post', p.id, p.company_id, NULL, p.body, NULL, p.created_at, NULL, NULL, p.media_id,
             NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
             p.author_name, COALESCE(p.is_system, 0), NULL, NULL, COALESCE(p.is_promo, 0)
      FROM posts p ${postFilter ? 'WHERE ' + postFilter : ''}
      UNION ALL
      SELECT 'repost', r.id, r.company_id, d.title, d.description, d.value, r.created_at, d.id, d.company_id, d.media_id,
             d.currency, d.time_period, d.contract_state, d.contract_party,
             d.deal_number, d.deal_type, d.category, d.origin, d.incoterm, d.status,
             d.author_name, 0, d.cargo_qty, d.cargo_unit, 0
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
      <textarea name="body" rows="3" maxlength="2000" placeholder="${esc(t(req.user.lang || 'en', 'feed.shareupdate'))}" required style="margin-bottom:8px"></textarea>
      ${fileButtonHtml()}
      <button class="btn btn-sm" type="submit">${esc(t(req.user.lang || 'en', 'feed.postupdate'))}</button>
      <a class="btn btn-sm btn-outline" href="/deals/new" style="margin-left:8px">${esc(t(req.user.lang || 'en', 'feed.postdeal'))}</a>
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
      <button class="btn js-magnet" type="submit">Publish deal</button>
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
  const destination = String(req.body.destination || '').trim().slice(0, 160);
  const incoterm = DEAL_INCOTERMS.includes(req.body.incoterm) ? req.body.incoterm : 'CIF';
  const proofMode = req.body.proof_mode === 'manual' ? 'manual' : 'pdf';
  const proofText = String(req.body.product_proof_text || '').trim().slice(0, 2000);
  // Cargo capacity (optional): a positive number plus a whitelisted unit.
  const cargoRaw = String(req.body.cargo_qty || '').trim();
  const cargoQty = cargoRaw === '' ? null : Number(cargoRaw);
  const cargoUnit = DEAL_CARGO_UNITS.includes(req.body.cargo_unit) ? req.body.cargo_unit : 'MT';

  if (!title || !desc) return res.redirect('/deals/new?err=' + encodeURIComponent('Title and description are required.'));
  if (!category) return res.redirect('/deals/new?err=' + encodeURIComponent('Please choose a deal category.'));
  if (!origin) return res.redirect('/deals/new?err=' + encodeURIComponent('Origin location is required.'));
  if (cargoQty !== null && (!isFinite(cargoQty) || cargoQty <= 0)) {
    return res.redirect('/deals/new?err=' + encodeURIComponent('Cargo quantity must be a number greater than zero.'));
  }

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
              deal_type, deal_number, category, origin, destination, incoterm, product_proof, product_proof_doc_id, status, author_name, cargo_qty, cargo_unit)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'open', ?, ?, ?)`)
    .run(req.user.id, title.slice(0, 160), desc.slice(0, 4000), value, now(), mediaId, currency, timePeriod,
         dealType, number, category, origin, destination, incoterm,
         dealType === 'sell' && proofMode === 'manual' ? proofText : '', proofDocId, req.user.memberName || null,
         cargoQty, cargoQty !== null ? cargoUnit : '');
  audit('DEAL AGENT', 'deal published', 'pass', `${req.user.name} posted ${dealType.toUpperCase()} deal ${number} "${title.slice(0, 60)}" (${category}, ${incoterm}, origin ${origin}${cargoQty !== null ? `, cargo ${cargoQty} ${cargoUnit}` : ''})`);
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
    ? `<form method="POST" action="/unfollow/${companyId}" style="display:inline"><button class="btn btn-sm btn-outline btn-follow is-following" type="submit">Following ✓</button></form>`
    : `<form method="POST" action="/follow/${companyId}" style="display:inline"><button class="btn btn-sm btn-follow" type="submit">Follow</button></form>`;
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
          return `<div class="card" data-reveal style="--i:${Math.min(idx, 8)}">
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
    return `<div class="card" data-reveal style="--i:${Math.min(idx, 8)}">
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

app.get('/deal/:id', requireCompanyOrAdmin, async (req, res) => {
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

  // ---- Commission payment gate card (finalized deals only; parties + admin — amounts stay private) ----
  let paymentHtml = '';
  if (paymentGateApplies(deal) && (isOwner || isBuyer || req.user.isAdmin)) {
    const bd = dealPaymentBreakdown(deal);
    const paid = deal.payment_status === 'paid';
    const payRows = db.prepare('SELECT * FROM commission_payments WHERE deal_id = ? ORDER BY id DESC LIMIT 50').all(deal.id);
    const latestBy = {};
    for (const r of payRows) { if (!latestBy[r.company_id]) latestBy[r.company_id] = r; }
    const splitLabel = NEG_SPLITS[bd.split] || bd.split;
    const shareLine = isFinite(bd.fee)
      ? `<p style="margin-top:6px">Total commission: <span class="deal-value" style="font-size:1rem">${fmtAmount(bd.fee)} ${esc(bd.cur)}</span>
          <span class="muted">(${bd.pct}% of deal value · split: <b>${esc(splitLabel)}</b>)</span><br>
          <span class="muted">Buyer owes ${fmtAmount(bd.buyerShare)} ${esc(bd.cur)} · Seller owes ${fmtAmount(bd.sellerShare)} ${esc(bd.cur)}</span></p>`
      : `<p class="muted" style="margin-top:6px">Commission: <b>${bd.pct}%</b> of the deal value — split: <b>${esc(splitLabel)}</b>. The administrator confirms the exact amount.</p>`;
    const partyRow = (cid, label, share, owes) => {
      if (!cid || !owes) return '';
      const r = latestBy[cid];
      const st = r ? paymentBadge(r.status) : '<span class="badge">— no confirmation yet</span>';
      const meta = r ? `<br><span class="muted">${r.note ? `“${esc(r.note)}” · ` : ''}${esc(r.created_at.slice(0, 16).replace('T', ' '))} UTC</span>${paymentProofHtml(r, req.user)}` : '';
      return `<div style="padding:6px 0;border-top:1px dashed var(--border-soft)">${label} <b>${esc(names.get(cid) || 'Unknown')}</b> — ${isFinite(share) ? `${fmtAmount(share)} ${esc(bd.cur)}` : 'amount per instructions'} ${st}${meta}</div>`;
    };
    const partiesList = partyRow(bd.buyerId, '🧾 Buyer', bd.buyerShare, bd.buyerOwes)
      + partyRow(bd.sellerId, '🏷️ Seller', bd.sellerShare, bd.sellerOwes);
    // Confirm-payment form for the current party (the amount is computed server-side — never sent by the client).
    let confirmHtml = '';
    if (!req.user.isAdmin && !paid && (isOwner || isBuyer)) {
      const myShare = isOwner ? bd.sellerShare : bd.buyerShare;
      const myOwes = isOwner ? bd.sellerOwes : bd.buyerOwes;
      const mine = latestBy[req.user.id];
      if (myOwes) {
        if (mine && mine.status === 'pending') {
          confirmHtml = `<p class="muted" style="margin-top:10px">⏳ Your payment confirmation${isFinite(mine.amount) && mine.amount > 0 ? ` of ${fmtAmount(mine.amount)} ${esc(mine.currency)}` : ''} is awaiting admin review.</p>`;
        } else {
          confirmHtml = `<hr class="sep">
          <h4 style="margin-bottom:8px">Confirm your payment (${isFinite(myShare) ? `${fmtAmount(myShare)} ${esc(bd.cur)}` : 'amount per instructions'})</h4>
          ${mine && mine.status === 'rejected' ? '<p class="flag-note">Your previous confirmation was rejected by the administrator. You can re-confirm once the transfer is made.</p>' : ''}
          <div class="feed-actions" style="margin:0 0 10px">${applePayHtml()}</div>
          <form method="POST" action="/deal/${deal.id}/payment-confirm">
            <label>Payment reference / note (optional)</label>
            <input type="text" name="note" maxlength="300" placeholder="e.g. Bank transfer ref #TRX-12345, sent today">
            <button class="btn btn-sm btn-green" type="submit">Confirm payment sent</button>
            <p class="muted" style="margin-top:6px">After confirming you can attach the bank-transfer receipt (PDF) as payment proof. The administrator verifies the bank transfer and approves — shipment tracking unlocks once all required shares are approved.</p>
          </form>`;
        }
      } else {
        confirmHtml = '<p class="muted" style="margin-top:10px">Under the agreed split your party owes no commission — the other party’s approved payment unlocks the deal.</p>';
      }
    }
    paymentHtml = `<div class="card vault" data-reveal>
      <h3>💰 Commission payment ${paid ? '<span class="badge badge-contract">paid ✓</span>' : '<span class="badge badge-sealed">awaiting payment</span>'} ${FLOW_PREVIEW_BADGE}</h3>
      ${shareLine}
      ${partiesList}
      ${bankDetailsCardHtml(`${deal.deal_number || 'DZ-' + deal.id} commission`)}
      ${paid ? '<p style="margin-top:10px"><span class="badge badge-contract">Commission fully paid ✓ — shipment tracking is live 🚢</span></p>' : confirmHtml}
    </div>`;
  }

  // ---- Status & shipment tracking (CIF/FOB/CFR — all platform-tracked) ----
  let statusHtml;
  {
    const tracking = (deal.tracking_number || deal.tracking_url) ? `
      <p style="margin-top:10px">🚚 <b>Tracking:</b> ${deal.tracking_number ? `<span class="deal-num">${esc(deal.tracking_number)}</span>` : ''}
        ${deal.tracking_url ? ` · <a href="${esc(deal.tracking_url)}" rel="noopener noreferrer nofollow">Track shipment →</a>` : ''}</p>` : '';
    const note = deal.status_note ? `<p class="muted" style="margin-top:8px">📝 ${esc(deal.status_note)}</p>` : '';
    // Commission gate: finalized deals stay locked until payment_status='paid'; legacy deals keep the old rule.
    const canUpdate = (isOwner || isBuyer || req.user.isAdmin)
      && (paymentGateApplies(deal) ? deal.payment_status === 'paid' : (deal.contract_state !== 'approved' && deal.status !== 'closed'));
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

  // ---- Shipment tracking map (CIF/FOB/CFR only; parties + admin — the deal's insider audience:
  // owner, negotiating/contracted buyer, admin — same parties the status stepper controls serve).
  // Coordinates are geocoded lazily here (first map view), never on deal creation; failures render a placeholder.
  let mapHtml = '', mapHead = '';
  if (canViewDealTerms(req.user, deal)) {
    if (deal.payment_status === 'pending_payment') {
      // Commission gate: the per-deal map stays hidden behind a lock card until the admin approves payment.
      mapHtml = `<div class="card map-placeholder" data-reveal><h3>🗺️ Shipment tracking map</h3>
        <p class="muted" style="margin-top:8px">${PAYMENT_LOCK_MSG}.</p></div>`;
    } else {
    try {
      const geo = await dealGeo(deal);
      const section = dealMapSection(deal, geo);
      mapHtml = section.html;
      if (section.needsLeaflet) mapHead = LEAFLET_HEAD;
    } catch (e) {
      mapHtml = `<div class="card map-placeholder" data-reveal><h3>🗺️ Shipment tracking map</h3>
        <p class="muted" style="margin-top:8px">Map activates once origin &amp; destination are geocoded.</p></div>`;
    }
    }
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
        <label class="file-btn dropzone"><span class="file-btn-text" data-default="📎 Attach PDF or image">📎 Attach PDF or image</span>
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
  <div class="card card-deal js-tilt">
    <div class="card__glare" aria-hidden="true"></div>
    <div class="feed-head"><h2>${esc(deal.title)}</h2>
      ${dealValueHtml}</div>
    <div style="margin:8px 0 4px">
      ${deal.deal_number ? `<span class="deal-num" style="font-size:1rem">Deal № ${esc(deal.deal_number)}</span> · ` : ''}
      ${dealTypeChips(deal)}
      <span class="chip" title="${esc(INCOTERM_EXPLAINERS[deal.incoterm] || INCOTERM_EXPLAINERS.CIF)}">⚓ ${esc(deal.incoterm || 'CIF')}</span>
      ${deal.origin ? ` <span class="chip">📍 ${esc(deal.origin)}</span>` : ''}
      ${canSeeValue && Number(deal.cargo_qty) > 0 ? ` <span class="chip chip-cargo" title="Cargo capacity — visible to deal parties only">📦 ${esc(fmtAmount(Number(deal.cargo_qty)))} ${esc(DEAL_CARGO_UNITS.includes(deal.cargo_unit) ? deal.cargo_unit : 'units')}</span>` : ''}
    </div>
    <p class="muted">by ${avatarHtml(owner ? owner.name : '?', owner ? owner.avatar_media_id : null)}<a href="/company/${deal.company_id}"><b>${esc(owner ? owner.name : 'Unknown')}</b></a> ${starsHtml(companyReputation(deal.company_id), true)}</p>
    <div data-dz-tr><p style="margin-top:12px;white-space:pre-wrap" class="dz-tr-text">${esc(deal.description)}</p>
    ${req.user.isAdmin ? '' : `<button type="button" class="dz-tr-btn">🌐 ${esc(t((req.user.lang || 'en'), 'tr.translate'))}</button>`}</div>
    ${deal.contract_state === 'approved' ? `<div style="margin-top:12px"><span class="badge badge-contract">Contract approved ✓${deal.contract_party ? ' (with ' + esc(deal.contract_party) + ')' : ''}</span></div>` : ''}
    ${mediaHtml(deal.media_id)}
    <div class="feed-actions">${signBtn}</div>
  </div>
  ${paymentHtml}
  ${escrowPanelHtml(deal, req.user, isOwner, isBuyer)}
  ${statusHtml}
  ${mapHtml}
  ${receivingAgentCardHtml(deal, req.user, isOwner, isBuyer)}
  ${proofHtml}
  ${contractHtml}
  ${docsHtml}`;
  res.send(page(deal.title, body, req.user, req.query.msg, req.query.err, undefined, mapHead));
});

// ----- POST /deal/:id/status — owner, contracted buyer or admin advances the pipeline (CIF/FOB/CFR only) -----
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
  // Commission gate: finalized deals are locked until the admin approves the commission payment.
  if (deal.payment_status === 'pending_payment') {
    audit('PAYMENT AGENT', 'status update locked', 'fail', `${user.isAdmin ? 'Admin' : user.name} tried to advance deal ${deal.deal_number || '#' + deal.id} before commission payment approval`);
    return res.redirect(back + '?err=' + encodeURIComponent(PAYMENT_LOCK_MSG + '.'));
  }
  if (!paymentGateApplies(deal) && (deal.contract_state === 'approved' || deal.status === 'closed')) {
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
  // Payment-milestone hook: reaching an agreed milestone's stage raises an admin release request.
  try { triggerMilestoneReleases(deal, newStatus, user); } catch (e) { /* never break the status update */ }
  audit('DEAL AGENT', 'status update', 'pass', `${user.isAdmin ? 'Admin' : user.name} advanced deal ${deal.deal_number || '#' + deal.id} to "${newStatus}"${note ? ` — note: ${note}` : ''}${trackingNumber ? ` — tracking ${trackingNumber}` : ''}`);
  // Notify the other party (admin updates notify both parties).
  const label = `${user.isAdmin ? 'The platform' : user.name} updated deal ${deal.deal_number || '#' + deal.id} ("${deal.title}") to "${newStatus.toUpperCase()}"${note ? ` — ${note}` : ''}`;
  if (user.isAdmin || isBuyer) notify(deal.company_id, 'deal_status', label, `/deal/${deal.id}`);
  if (user.isAdmin || isOwner) { if (buyerId) notify(buyerId, 'deal_status', label, `/deal/${deal.id}`); }
  res.redirect(back + '?msg=' + encodeURIComponent(`Deal status updated to "${newStatus}".`));
});

// ----- POST /deal/:id/payment-confirm — a deal party confirms it sent its commission share (bank transfer) -----
app.post('/deal/:id/payment-confirm', requireCompany, (req, res) => {
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!deal) return res.redirect('/timeline?err=' + encodeURIComponent('Deal not found.'));
  const back = `/deal/${deal.id}`;
  if (deal.payment_status !== 'pending_payment') {
    return res.redirect(back + '?err=' + encodeURIComponent('No commission payment is currently pending for this deal.'));
  }
  const bd = dealPaymentBreakdown(deal);
  const isOwner = req.user.id === deal.company_id;
  const isBuyer = !!bd.buyerId && bd.buyerId === req.user.id;
  if (!isOwner && !isBuyer) {
    audit('PAYMENT AGENT', 'payment confirm guard', 'fail', `${req.user.name} attempted to confirm a commission payment on deal #${deal.id} without being a party`);
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Parties only</h2><p class="muted">Only the two deal parties can confirm commission payments.</p></div>', req.user));
  }
  const myOwes = isOwner ? bd.sellerOwes : bd.buyerOwes;
  const myShare = isOwner ? bd.sellerShare : bd.buyerShare;
  if (!myOwes) {
    return res.redirect(back + '?err=' + encodeURIComponent('Under the agreed split your party owes no commission on this deal.'));
  }
  // One pending confirmation per party per deal (re-confirm is allowed after a rejection).
  const existing = db.prepare(`SELECT id FROM commission_payments WHERE deal_id = ? AND company_id = ? AND status = 'pending'`).get(deal.id, req.user.id);
  if (existing) {
    return res.redirect(back + '?err=' + encodeURIComponent('Your payment confirmation is already awaiting admin review.'));
  }
  const note = String(req.body.note || '').trim().slice(0, 300);
  const amount = isFinite(myShare) ? Math.round(myShare * 100) / 100 : 0; // computed server-side — never trusted from the client
  db.prepare(`INSERT INTO commission_payments (deal_id, private_contract_id, company_id, amount, currency, note, status, created_at)
              VALUES (?, NULL, ?, ?, ?, ?, 'pending', ?)`)
    .run(deal.id, req.user.id, amount, bd.cur, note, now());
  audit('PAYMENT AGENT', 'payment confirmation submitted', 'pass', `${req.user.name} confirmed a commission payment of ${isFinite(myShare) ? `${fmtAmount(amount)} ${bd.cur}` : 'amount TBC'} on deal ${deal.deal_number || '#' + deal.id}${note ? ` — note: ${note}` : ''}`);
  res.redirect(back + '?msg=' + encodeURIComponent('Payment confirmation submitted — the administrator will verify your transfer and approve it.'));
});

// ----- BATCH B (1a): payment-proof PDF upload — the paying party attaches a bank-transfer receipt -----
/** Multer middleware for a single "proof" PDF field (magic bytes checked in the route). */
function proofUploadMw(req, res, next) {
  pdfUpload.single('proof')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Document too large — max 15 MB.' : (err.message || PDF_RULES_MSG);
      return res.redirect((req.get('referer') || '/timeline').split('?')[0] + '?err=' + encodeURIComponent(msg));
    }
    next();
  });
}
/** Back-link for a commission_payment row: its deal page or its private-contract page. */
function paymentBackLink(p) {
  return p.deal_id ? `/deal/${p.deal_id}` : `/contracts/${p.private_contract_id}`;
}
app.post('/payments/:id/proof', requireCompany, proofUploadMw, (req, res) => {
  const p = db.prepare('SELECT * FROM commission_payments WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!p) return res.redirect('/timeline?err=' + encodeURIComponent('Payment confirmation not found.'));
  const back = paymentBackLink(p);
  if (p.company_id !== req.user.id) {
    audit('PAYMENT AGENT', 'proof upload guard', 'fail', `${req.user.name} attempted to attach a payment proof to payment #${p.id} owned by company #${p.company_id}`);
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Parties only</h2><p class="muted">Only the paying company can attach a payment proof to its own confirmation.</p></div>', req.user));
  }
  if (p.status !== 'pending') {
    return res.redirect(back + '?err=' + encodeURIComponent('Proofs can only be attached while the payment awaits admin review.'));
  }
  const f = req.file;
  if (!f) return res.redirect(back + '?err=' + encodeURIComponent('Choose a PDF receipt to upload.'));
  if (!isPdfBuffer(f.buffer)) {
    audit('PAYMENT AGENT', 'proof upload check', 'fail', `"${f.originalname || 'file'}" rejected for payment #${p.id} — not a real PDF`);
    return res.redirect(back + '?err=' + encodeURIComponent('Upload rejected: the payment proof must be a real PDF file.'));
  }
  const mediaId = saveMedia(req.user.id, f);
  if (p.proof_media_id) { try { db.prepare('DELETE FROM media WHERE id = ?').run(p.proof_media_id); } catch (e) { /* best-effort */ } } // re-upload replaces
  db.prepare('UPDATE commission_payments SET proof_media_id = ?, proof_filename = ? WHERE id = ?')
    .run(mediaId, String(f.originalname || 'receipt.pdf').slice(0, 200), p.id);
  audit('PAYMENT AGENT', 'payment proof uploaded', 'pass', `${req.user.name} attached proof "${String(f.originalname || 'receipt.pdf').slice(0, 80)}" to payment #${p.id}`);
  res.redirect(back + '?msg=' + encodeURIComponent('Payment proof attached — the administrator can review it before approving.'));
});
// ----- Admin (or the paying party) downloads the payment-proof PDF -----
app.get('/payments/:id/proof', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.redirect('/login?err=' + encodeURIComponent('Please sign in.'));
  const p = db.prepare('SELECT * FROM commission_payments WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!p || !p.proof_media_id) return res.status(404).send(page('Not found', '<div class="card"><h2>Payment proof not found</h2></div>', user));
  if (!user.isAdmin && p.company_id !== user.id) {
    audit('PAYMENT AGENT', 'proof download guard', 'fail', `Unauthorized proof download attempt on payment #${p.id} by ${user.name}`);
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Private payment proof</h2><p class="muted">Only the paying company and the admin can download this receipt.</p></div>', user));
  }
  const m = db.prepare('SELECT * FROM media WHERE id = ?').get(p.proof_media_id);
  if (!m) return res.status(404).send(page('Not found', '<div class="card"><h2>Payment proof not found</h2></div>', user));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', m.data.length);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', `attachment; filename="${String(p.proof_filename || 'receipt.pdf').replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  res.send(m.data);
});

// ----- BATCH B (4): the buyer confirms receipt of goods (REAL data — releases the final escrow milestone) -----
app.post('/deal/:id/confirm-receipt', requireCompany, (req, res) => {
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!deal) return res.redirect('/timeline?err=' + encodeURIComponent('Deal not found.'));
  const back = `/deal/${deal.id}`;
  const buyerId = dealBuyerId(deal);
  if (!buyerId || buyerId !== req.user.id) {
    audit('ESCROW AGENT', 'receipt confirmation guard', 'fail', `${req.user.name} attempted to confirm receipt on deal ${deal.deal_number || '#' + deal.id} without being the buyer`);
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Buyer only</h2><p class="muted">Only the contracted buyer can confirm receipt of goods.</p></div>', req.user));
  }
  if (deal.status !== 'delivered') {
    return res.redirect(back + '?err=' + encodeURIComponent('Receipt can only be confirmed once the deal status is "delivered".'));
  }
  if (deal.buyer_received_confirmed_at) {
    return res.redirect(back + '?err=' + encodeURIComponent('Receipt was already confirmed for this deal.'));
  }
  const ts = now();
  db.prepare('UPDATE deals SET buyer_received_confirmed_at = ? WHERE id = ?').run(ts, deal.id);
  // Receipt confirmation is the delivery gate — re-run the milestone trigger so the
  // final (delivered) milestone raises its admin release request now.
  try { triggerMilestoneReleases(deal, 'delivered', req.user); } catch (e) { /* never break the confirmation */ }
  audit('ESCROW AGENT', 'buyer confirmed receipt', 'pass', `${req.user.name} confirmed receipt of goods on deal ${deal.deal_number || '#' + deal.id} at ${ts} — final escrow milestone release requested (admin approves)`);
  notify(deal.company_id, 'receipt_confirmed', `${req.user.name} confirmed receipt of goods on deal ${deal.deal_number || '#' + deal.id} ("${deal.title}") — the final milestone release now awaits admin approval.`, back);
  res.redirect(back + '?msg=' + encodeURIComponent('Receipt confirmed — thank you! The final milestone release now awaits admin approval.'));
});
// ----- BATCH B (4): either party raises a dispute — pauses the release design and alerts the admin -----
app.post('/deal/:id/escrow-dispute', requireCompany, (req, res) => {
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!deal) return res.redirect('/timeline?err=' + encodeURIComponent('Deal not found.'));
  const back = `/deal/${deal.id}`;
  const buyerId = dealBuyerId(deal);
  const isOwner = req.user.id === deal.company_id;
  const isBuyer = !!buyerId && buyerId === req.user.id;
  if (!isOwner && !isBuyer) {
    audit('ESCROW AGENT', 'dispute guard', 'fail', `${req.user.name} attempted to dispute deal ${deal.deal_number || '#' + deal.id} without being a party`);
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Parties only</h2><p class="muted">Only the two deal parties can raise a dispute.</p></div>', req.user));
  }
  if (deal.escrow_dispute_at) {
    return res.redirect(back + '?err=' + encodeURIComponent('A dispute is already open on this deal — the platform team is on it.'));
  }
  const ts = now();
  db.prepare('UPDATE deals SET escrow_dispute_at = ? WHERE id = ?').run(ts, deal.id);
  audit('ESCROW AGENT', 'dispute raised', 'flag', `${req.user.name} raised a dispute on deal ${deal.deal_number || '#' + deal.id} at ${ts} — escrow release paused (flow preview)`);
  const other = isOwner ? buyerId : deal.company_id;
  if (other) notify(other, 'escrow_dispute', `${req.user.name} raised a dispute on deal ${deal.deal_number || '#' + deal.id} ("${deal.title}"). The platform team has been alerted and will mediate.`, back);
  res.redirect(back + '?msg=' + encodeURIComponent('Dispute raised — the platform team has been alerted (admin dashboard + audit log).'));
});

// ----- BATCH B (6): receiving-country shipment agent — nominate / remove / log updates -----
/** Guard helper: load deal + require a party (owner/buyer) or admin. Returns { deal, isOwner, buyerId } or null. */
function dealPartyGuard(req, res, agentLabel) {
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!deal) { res.redirect('/timeline?err=' + encodeURIComponent('Deal not found.')); return null; }
  const buyerId = dealBuyerId(deal);
  const isOwner = !req.user.isAdmin && req.user.id === deal.company_id;
  const isBuyer = !req.user.isAdmin && !!buyerId && buyerId === req.user.id;
  if (!req.user.isAdmin && !isOwner && !isBuyer) {
    audit('SHIPMENT AGENT', agentLabel + ' guard', 'fail', `${req.user.name} attempted a receiving-agent action on deal ${deal.deal_number || '#' + deal.id} without being a party`);
    res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Parties only</h2><p class="muted">Only the deal parties and the admin can manage the receiving agent.</p></div>', req.user));
    return null;
  }
  return { deal, isOwner, isBuyer, buyerId };
}
app.post('/deal/:id/receiving-agent', requireCompanyOrAdmin, (req, res) => {
  const g = dealPartyGuard(req, res, 'agent nomination');
  if (!g) return;
  const { deal, buyerId } = g;
  const back = `/deal/${deal.id}`;
  const name = String(req.body.agent_name || '').trim().slice(0, 160);
  const country = String(req.body.agent_country || '').trim().slice(0, 120);
  if (!name || !country) return res.redirect(back + '?err=' + encodeURIComponent('Agent company name and receiving country are required.'));
  const email = String(req.body.agent_email || '').trim().slice(0, 160);
  if (email && !EMAIL_RE.test(email)) return res.redirect(back + '?err=' + encodeURIComponent('The agent email address looks invalid.'));
  const prev = parseReceivingAgent(deal);
  const agent = {
    name,
    contact: String(req.body.agent_contact || '').trim().slice(0, 120),
    phone: String(req.body.agent_phone || '').trim().slice(0, 60),
    email,
    country,
    nominated_by: req.user.isAdmin ? 0 : req.user.id,
    nominated_at: now()
  };
  db.prepare('UPDATE deals SET receiving_agent = ? WHERE id = ?').run(JSON.stringify(agent), deal.id);
  audit('SHIPMENT AGENT', prev ? 'receiving agent updated' : 'receiving agent nominated', 'pass',
    `${req.user.isAdmin ? 'Admin' : req.user.name} ${prev ? 'updated' : 'nominated'} receiving agent "${name}" (${country}) on deal ${deal.deal_number || '#' + deal.id}`);
  const label = `${req.user.isAdmin ? 'The platform' : req.user.name} ${prev ? 'updated' : 'nominated'} the receiving-country agent on deal ${deal.deal_number || '#' + deal.id} ("${deal.title}"): ${name} (${country}).`;
  if (req.user.isAdmin || g.isBuyer) notify(deal.company_id, 'receiving_agent', label, back);
  if (req.user.isAdmin || g.isOwner) { if (buyerId) notify(buyerId, 'receiving_agent', label, back); }
  res.redirect(back + '?msg=' + encodeURIComponent(prev ? 'Receiving agent updated.' : 'Receiving agent nominated.'));
});
app.post('/deal/:id/receiving-agent/remove', requireCompanyOrAdmin, (req, res) => {
  const g = dealPartyGuard(req, res, 'agent removal');
  if (!g) return;
  const { deal, buyerId } = g;
  const back = `/deal/${deal.id}`;
  const prev = parseReceivingAgent(deal);
  if (!prev) return res.redirect(back + '?err=' + encodeURIComponent('No receiving agent is nominated on this deal.'));
  db.prepare('UPDATE deals SET receiving_agent = NULL WHERE id = ?').run(deal.id);
  audit('SHIPMENT AGENT', 'receiving agent removed', 'flag', `${req.user.isAdmin ? 'Admin' : req.user.name} removed receiving agent "${prev.name}" (${prev.country}) from deal ${deal.deal_number || '#' + deal.id}`);
  const label = `${req.user.isAdmin ? 'The platform' : req.user.name} removed the receiving-country agent (${prev.name}) from deal ${deal.deal_number || '#' + deal.id} ("${deal.title}").`;
  if (req.user.isAdmin || g.isBuyer) notify(deal.company_id, 'receiving_agent', label, back);
  if (req.user.isAdmin || g.isOwner) { if (buyerId) notify(buyerId, 'receiving_agent', label, back); }
  res.redirect(back + '?msg=' + encodeURIComponent('Receiving-agent nomination removed.'));
});
app.post('/deal/:id/receiving-update', requireCompanyOrAdmin, (req, res) => {
  const g = dealPartyGuard(req, res, 'receiving update');
  if (!g) return;
  const { deal, buyerId } = g;
  const back = `/deal/${deal.id}`;
  const agent = parseReceivingAgent(deal);
  if (!agent) return res.redirect(back + '?err=' + encodeURIComponent('Nominate the receiving agent before logging updates.'));
  // Only the party who nominated the agent (or the admin) logs receiving-side updates.
  if (!req.user.isAdmin && agent.nominated_by && agent.nominated_by !== req.user.id) {
    audit('SHIPMENT AGENT', 'receiving update guard', 'fail', `${req.user.name} attempted to log a receiving update on deal ${deal.deal_number || '#' + deal.id} without having nominated the agent`);
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Nominating party only</h2><p class="muted">Receiving-side updates are logged by the party who nominated the agent, or the admin.</p></div>', req.user));
  }
  const note = String(req.body.note || '').trim().slice(0, 300);
  if (note.length < 2) return res.redirect(back + '?err=' + encodeURIComponent('Please describe the receiving-side update.'));
  db.prepare('INSERT INTO receiving_updates (deal_id, company_id, note, created_at) VALUES (?,?,?,?)')
    .run(deal.id, req.user.isAdmin ? null : req.user.id, note, now());
  audit('SHIPMENT AGENT', 'receiving update logged', 'pass', `${req.user.isAdmin ? 'Admin' : req.user.name} logged a receiving-side update on deal ${deal.deal_number || '#' + deal.id} (agent ${agent.name}, ${agent.country}): "${note.slice(0, 120)}"`);
  const label = `Receiving agent update (${agent.country}) on deal ${deal.deal_number || '#' + deal.id} ("${deal.title}"): "${note.slice(0, 140)}"`;
  if (req.user.isAdmin || g.isBuyer) notify(deal.company_id, 'receiving_update', label, back);
  if (req.user.isAdmin || g.isOwner) { if (buyerId) notify(buyerId, 'receiving_update', label, back); }
  res.redirect(back + '?msg=' + encodeURIComponent('Receiving-side update logged on the shipment timeline.'));
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
  const doc = brandedDoc({
    title: deal.title,
    docLabel: 'B2B Contract',
    docNo: '№ ' + dealNum,
    rows: [
      ['Provider', esc(owner ? owner.name : 'Unknown')],
      ['Counterparty', esc(counterpartyName)],
      ...(deal.value ? [['Deal value', `<b>${esc(deal.value)} ${esc(deal.currency || 'USD')}</b>`]] : []),
      ['Commission', esc(feeLineText(deal))],
      ['Generated', esc(now())]
    ],
    bodyHtml:
      docH('Deal terms') + `<p style="white-space:pre-wrap">${esc(deal.description)}</p>` +
      docH('Standard B2B terms') + clauses +
      brandSignatures('Provider signature', 'Counterparty signature'),
    footnote: 'Deal № ' + dealNum
  });
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
      <button class="btn btn-green js-magnet" type="submit">Sign contract</button>
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
    ORDER BY n.updated_at DESC LIMIT 100`).all(myId, myId)
    // Batch A: lazily flip lapsed LOI deadlines to EXPIRED (keeps the join columns).
    .map(n => { const r = negExpireIfNeeded(n); return r === n ? n : { ...r, deal_title: n.deal_title, deal_number: n.deal_number }; });
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
    return `<div class="card" data-reveal style="--i:${Math.min(i, 8)}">
      <div class="feed-head">
        <h3>🤝 <a href="/negotiation/${n.id}">${esc(n.deal_title || 'Deal #' + n.deal_id)}</a></h3>
        ${statusBadge(n.state)}
      </div>
      <p class="muted" style="margin-top:6px">You are the <b>${role}</b> · with <a href="/company/${role === 'buyer' ? n.seller_id : n.buyer_id}"><b>${esc(otherName)}</b></a>
        · Deal № ${esc(n.deal_number || String(n.deal_id))} · round ${n.round}
        ${n.offer_value ? ` · offer <b>${esc(n.offer_value)} ${esc(n.offer_currency || 'USD')}</b>` : ''}
        ${n.offer_incoterm ? ` · incoterm <b>${esc(n.offer_incoterm)}</b>` : ''}
        · updated ${esc(n.updated_at.slice(0, 16).replace('T', ' '))} UTC</p>
      ${loiCountdownHtml(n)}
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
  'SIGNED', 'OWNER_APPROVED', 'SPLIT_NEGO', 'PENDING_ADMIN', 'DONE', 'REJECTED', 'EXPIRED'];
const NEG_OPEN_STATES = NEG_STATES.filter(s => s !== 'DONE' && s !== 'REJECTED' && s !== 'EXPIRED');
const NEG_SPLITS = { '50-50': '50 / 50 shared', 'buyer-pays': 'Buyer pays 100%', 'seller-pays': 'Seller pays 100%' };
// Batch A: LOI response deadlines. Allowed day counts + the states still governed by the LOI clock
// (once the PO is issued the LOI phase is over and the deadline no longer applies).
const LOI_DEADLINE_DAYS = [3, 7, 14, 30];
const LOI_DEADLINE_STATES = ['LOI_SENT', 'OFFER_SENT', 'COUNTER_SENT', 'BUYER_APPROVED'];
/** Compute the LOI expiry ISO timestamp N days from now. */
function loiExpiryFrom(days) {
  return new Date(Date.now() + days * 86400000).toISOString();
}
/** Lazily expire a negotiation whose LOI response deadline has passed (pre-PO states only).
 *  Transitions to EXPIRED, logs a timeline event + NEGOTIATION AGENT audit entry and notifies
 *  both parties. Returns the (possibly reloaded) negotiation row. */
function negExpireIfNeeded(neg) {
  if (!neg || !neg.loi_expires_at) return neg;
  if (!LOI_DEADLINE_STATES.includes(neg.state)) return neg;
  if (neg.loi_expires_at > now()) return neg;
  negSetState(neg.id, 'EXPIRED');
  negEvent(neg.id, null, 'expired', { note: `The LOI response deadline (${neg.loi_expires_at.slice(0, 16).replace('T', ' ')} UTC) passed without reaching a Purchase Order.` });
  audit('NEGOTIATION AGENT', 'LOI expired', 'flag', `Negotiation #${neg.id} expired — LOI deadline ${neg.loi_expires_at} passed in state ${neg.state}; the buyer must re-issue the LOI`);
  notify(neg.seller_id, 'loi_expired', `Negotiation #${neg.id} expired — the LOI response deadline passed. The buyer can re-issue the LOI.`, `/negotiation/${neg.id}`);
  notify(neg.buyer_id, 'loi_expired', `Your LOI on negotiation #${neg.id} expired before a Purchase Order was issued. You can re-issue it with a fresh deadline.`, `/negotiation/${neg.id}`);
  return getNegotiation(neg.id);
}
/** Live countdown pill for the LOI response deadline (ticked by the shared page script). */
function loiCountdownHtml(neg) {
  if (!neg.loi_expires_at) return '';
  if (neg.state === 'EXPIRED') {
    return `<span class="loi-countdown loi-expired">⏰ LOI expired ${esc(neg.loi_expires_at.slice(0, 16).replace('T', ' '))} UTC — the buyer must re-issue</span>`;
  }
  if (!LOI_DEADLINE_STATES.includes(neg.state)) return '';
  return `<span class="loi-countdown" data-loi-expires="${esc(neg.loi_expires_at)}" role="timer">⏰ Seller must respond within …</span>`;
}
/** The negotiation's governing incoterm: the seller's offer choice, else the deal's. */
function negIncoterm(neg, deal) {
  const v = (neg && neg.offer_incoterm) || (deal && deal.incoterm) || 'CIF';
  return DEAL_INCOTERMS.includes(v) ? v : 'CIF';
}

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
                     AND state NOT IN ('DONE','REJECTED','EXPIRED') ORDER BY id DESC LIMIT 1`).get(dealId, buyerId);
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
    admin_approved: '🏛️ Final admin approval', admin_rejected: '🏛️ Admin rejected',
    expired: '⏰ LOI expired', loi_reissued: '📨 LOI re-issued'
  }[kind] || kind;
}
/** Timeline-style rounds list (staggered reveal). */
function negTimelineHtml(negId, names, lang) {
  const trLang = lang || 'en';
  const events = db.prepare('SELECT * FROM negotiation_events WHERE negotiation_id = ? ORDER BY id ASC LIMIT 200').all(negId);
  if (!events.length) return '<p class="muted">No events yet.</p>';
  return `<div class="tl">${events.map((e, i) => {
    const actor = e.actor_id ? (names.get(e.actor_id) || 'Unknown') : 'Dealzoin';
    const valLine = e.value ? `<div class="deal-value" style="font-size:1rem;margin:4px 0">${esc(e.value)} ${esc(e.currency || '')}</div>` : '';
    const termsLine = e.terms ? `<div data-dz-tr><p class="muted dz-tr-text" style="white-space:pre-wrap;margin-top:4px">${esc(e.terms.slice(0, 600))}</p><button type="button" class="dz-tr-btn">🌐 ${esc(t(trLang, 'tr.translate'))}</button></div>` : '';
    const noteLine = e.note ? `<p class="muted" style="margin-top:4px">${esc(e.note)}</p>` : '';
    return `<div class="tl-item" data-reveal style="--i:${Math.min(i, 8)}">
      <div class="tl-dot"></div>
      <div class="tl-body">
        <div class="feed-head" style="margin:0"><b>${negEventLabel(e.kind)}</b>
          <span class="muted">${esc(actor)} · ${esc(e.created_at.slice(0, 16).replace('T', ' '))} UTC</span></div>
        ${valLine}${termsLine}${noteLine}
      </div>
    </div>`;
  }).join('')}</div>`;
}

/** (5) Four editable milestone rows for the SPLIT_NEGO form — prefilled from the current proposal
 *  (or the sensible 10/20/70 default). Percentages must sum to exactly 100 (server-validated). */
function milestoneFormRowsHtml(prefill) {
  const ms = (prefill && prefill.length ? prefill : DEFAULT_MILESTONES);
  const presetKeys = Object.keys(MILESTONE_PRESETS);
  let rows = '';
  for (let i = 0; i < 4; i++) {
    const m = ms[i];
    const presetKey = m
      ? (presetKeys.find(k => k !== 'custom' && MILESTONE_PRESETS[k].label === m.label && MILESTONE_PRESETS[k].status === m.status) || 'custom')
      : '';
    rows += `<div class="ms-edit-row">
      <select name="ms_label_${i + 1}" aria-label="Milestone ${i + 1} label">
        <option value="">— unused —</option>
        ${presetKeys.map(k => `<option value="${k}"${k === presetKey ? ' selected' : ''}>${esc(MILESTONE_PRESETS[k].label)}</option>`).join('')}
      </select>
      <input type="text" name="ms_custom_${i + 1}" maxlength="60" placeholder="Custom label" value="${m && presetKey === 'custom' ? esc(m.label) : ''}" aria-label="Milestone ${i + 1} custom label">
      <select name="ms_status_${i + 1}" aria-label="Milestone ${i + 1} unlock status" title="Unlock status (applies to Custom milestones — presets carry their own)">${optionsHtml(DEAL_STATUSES, m ? m.status : 'delivered')}</select>
      <input type="number" name="ms_pct_${i + 1}" min="1" max="100" step="1" placeholder="%" value="${m ? m.pct : ''}" aria-label="Milestone ${i + 1} percent" style="max-width:86px">
    </div>`;
  }
  return `<div class="ms-edit-head" aria-hidden="true"><span>Label</span><span>Custom label</span><span>Unlocks at (custom)</span><span>%</span></div>${rows}
    <p class="muted" style="margin:4px 0 10px">1–4 milestones, each 1–100% — the percentages must sum to exactly 100. Presets carry their own unlock status (Before loading → production, After loading → dispatched, On dispatch → shipped, On delivery → delivered).</p>`;
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
      <label>Seller response deadline *</label>
      <select name="loi_deadline_days" required>${optionsHtml(LOI_DEADLINE_DAYS.map(d => String(d)), '7')}</select>
      <p class="muted" style="margin:-6px 0 12px">Days the seller has to respond (3 / 7 / 14 / 30). If the deadline passes before a Purchase Order, the negotiation expires and you can re-issue the LOI.</p>
      <button class="btn btn-green js-magnet" type="submit">Send Letter of Intent →</button>
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
  const loiDays = LOI_DEADLINE_DAYS.includes(Number(req.body.loi_deadline_days)) ? Number(req.body.loi_deadline_days) : 7;
  const loiExpiresAt = loiExpiryFrom(loiDays);
  const ts = now();
  const negId = db.prepare(`INSERT INTO negotiations (deal_id, buyer_id, seller_id, state, round, loi_text, loi_location, loi_quantity, loi_wishes, commission_split, loi_expires_at, created_at, updated_at)
    VALUES (?,?,?, 'LOI_SENT', 0, ?,?,?,?, '50-50', ?, ?, ?)`)
    .run(deal.id, req.user.id, deal.company_id, loiText, loiLoc, loiQty, loiWishes, loiExpiresAt, ts, ts).lastInsertRowid;
  negEvent(negId, req.user.id, 'loi', { note: `Location: ${loiLoc}${loiQty ? ` · Quantity: ${loiQty}` : ''} · Response deadline: ${loiDays} days (${loiExpiresAt.slice(0, 16).replace('T', ' ')} UTC)`, terms: loiText + (loiWishes ? `\nWishes: ${loiWishes}` : '') });
  audit('DEAL AGENT', 'LOI sent', 'pass', `${req.user.name} sent an LOI on deal ${deal.deal_number || '#' + deal.id} (negotiation #${negId}, location: ${loiLoc}, deadline ${loiDays}d)`);
  notify(deal.company_id, 'loi', `${req.user.name} expressed interest in your deal "${deal.title}" (LOI, from ${loiLoc}). Review and send a private offer.`, `/negotiation/${negId}`);
  res.redirect(`/negotiation/${negId}?msg=` + encodeURIComponent('Letter of Intent sent — the seller has been notified.'));
});

// ----- Unified negotiation thread (role-aware actions for buyer / seller; admin read-only) -----
app.get('/negotiation/:id', requireCompanyOrAdmin, (req, res) => {
  let neg = getNegotiation(req.params.id);
  if (!neg) return res.status(404).send(page('Not found', '<div class="card"><h2>Negotiation not found</h2></div>', req.user));
  if (!isNegParty(req.user, neg)) {
    audit('DEAL AGENT', 'negotiation access', 'fail', `Unauthorized negotiation #${neg.id} view attempt by ${req.user.isAdmin ? 'admin?' : req.user.name}`);
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Private negotiation</h2><p class="muted">Only the two negotiating parties and the admin can view this page.</p></div>', req.user));
  }
  // Batch A: apply the LOI response deadline before rendering (lazy expiry transition).
  neg = negExpireIfNeeded(neg);
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
  // Batch A: the seller picks the governing incoterm on every (re-)offer — it flows to the
  // PO, the deal page and the tracking logic.
  const curIncoterm = negIncoterm(neg, deal);
  const incotermFieldHtml = `
    <label>Incoterm *</label>
    <select name="incoterm" required>${optionsHtml(DEAL_INCOTERMS, curIncoterm)}</select>
    <p class="muted" style="margin:-6px 0 12px">${DEAL_INCOTERMS.map(i => `<b>${esc(i)}</b> — ${esc(INCOTERM_EXPLAINERS[i])}`).join('<br>')}</p>`;
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
        ${incotermFieldHtml}
        <button class="btn" type="submit">Send offer →</button>
      </form>
      <form method="POST" action="/negotiation/${neg.id}/decline" style="margin-top:8px">
        <button class="btn btn-sm btn-danger" type="submit">Decline this LOI</button>
      </form>
    </div>`;
  } else if (st === 'OFFER_SENT' && isBuyer) {
    actionHtml = `<div class="card" data-reveal>
      <h3>💱 Answer the offer</h3>
      <p class="muted" style="margin:6px 0 10px">Seller's offer: <b>${esc(neg.offer_value)} ${esc(neg.offer_currency || 'USD')}</b> · Incoterm: <b>${esc(curIncoterm)}</b> — ${esc(INCOTERM_EXPLAINERS[curIncoterm] || '')}</p>
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
        ${incotermFieldHtml}
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
    const proposedMs = parseMilestoneJson(neg.milestone_proposal);
    const proposeForm = `
      <form method="POST" action="/negotiation/${neg.id}/split">
        <label>Commission split</label>
        <select name="split">${optionsHtml(Object.keys(NEG_SPLITS), NEG_SPLITS[neg.commission_split] ? neg.commission_split : '50-50')}</select>
        <p class="muted" style="margin:4px 0 10px">${Object.entries(NEG_SPLITS).map(([k, v]) => `<b>${esc(k)}</b> = ${esc(v)}`).join(' · ')}</p>
        <label>Payment milestone schedule (escrow release)</label>
        ${milestoneFormRowsHtml(proposedMs)}
        <button class="btn" type="submit">${st === 'SPLIT_NEGO' ? 'Counter-propose split &amp; milestones' : 'Propose split &amp; milestones'} →</button>
      </form>`;
    const msSummary = proposedMs
      ? `<p class="muted" style="margin:6px 0 10px">Milestones: <b>${esc(milestoneSummaryText(proposedMs))}</b></p>`
      : '';
    const acceptForm = (st === 'SPLIT_NEGO' && !iProposed) ? `
      <form method="POST" action="/negotiation/${neg.id}/split-accept" style="margin-bottom:10px">
        <button class="btn btn-green" type="submit">Accept "${esc(current)}" + the milestone schedule — send to admin for final approval</button>
      </form>` : '';
    actionHtml = `<div class="card" data-reveal>
      <h3>⚖️ Commission split &amp; payment milestones</h3>
      ${negFeeHtml(neg)}
      ${st === 'SPLIT_NEGO'
        ? `<p class="muted">Proposed by <b>${esc(names.get(neg.split_proposed_by) || 'the other party')}</b>: <b>${esc(current)}</b>. ${iProposed ? 'Waiting for the other party to accept or counter.' : 'Accept it or counter-propose below.'}</p>${msSummary}`
        : '<p class="muted">Default split is <b>50-50</b>. Either party may propose how the platform commission is shared — and the payment milestone schedule the escrow flow will follow — before final admin approval.</p>'}
      ${acceptForm}
      ${iProposed ? '' : proposeForm}
    </div>`;
  } else if (st === 'PENDING_ADMIN') {
    const pms = parseMilestoneJson(neg.milestone_proposal);
    actionHtml = `<div class="card" data-reveal><h3>🏛️ Awaiting admin final approval</h3>${negFeeHtml(neg)}
      ${pms ? `<p class="muted">Milestones: <b>${esc(milestoneSummaryText(pms))}</b></p>` : ''}
      <p class="muted">The admin sees the agreed split and amounts in the final-approval queue.</p></div>`;
  } else if (st === 'DONE') {
    const dms = parseMilestoneJson(neg.milestone_proposal);
    actionHtml = `<div class="card card-announce" data-reveal><h3>🎉 Deal closed</h3>${negFeeHtml(neg)}
      ${dms ? `<p class="muted">Milestones: <b>${esc(milestoneSummaryText(dms))}</b></p>` : ''}
      <p class="muted">The platform commission is due before deal processing. Congratulations to both parties!</p></div>`;
  } else if (st === 'REJECTED') {
    actionHtml = `<div class="card" data-reveal><h3>⛔ Negotiation ended</h3><p class="muted">This negotiation was closed without a contract.</p></div>`;
  } else if (st === 'EXPIRED') {
    actionHtml = `<div class="card" data-reveal>
      <h3>⏰ LOI expired</h3>
      <p class="muted">The LOI response deadline${neg.loi_expires_at ? ` (${esc(neg.loi_expires_at.slice(0, 16).replace('T', ' '))} UTC)` : ''} passed before a Purchase Order was issued.</p>
      ${isBuyer ? `
      <hr class="sep">
      <h4 style="margin-bottom:8px">📨 Re-issue the LOI</h4>
      <p class="muted" style="margin-bottom:10px">Send a fresh LOI round on the same negotiation — this resets the seller's response deadline.</p>
      <form method="POST" action="/negotiation/${neg.id}/reissue-loi">
        <label>New seller response deadline *</label>
        <select name="loi_deadline_days" required>${optionsHtml(LOI_DEADLINE_DAYS.map(String), '7')}</select>
        <p class="muted" style="margin:-6px 0 12px">Days the seller has to respond (3 / 7 / 14 / 30).</p>
        <button class="btn btn-green" type="submit">Re-issue LOI →</button>
      </form>` : '<p class="muted" style="margin-top:8px">Waiting for the buyer to re-issue the LOI with a fresh deadline.</p>'}
    </div>`;
  } else {
    actionHtml = waiting(isBuyer ? sellerName : buyerName);
  }

  const loiCard = `
  <div class="card" data-reveal>
    <h3>📨 Letter of Intent</h3>
    <div data-dz-tr><p style="margin-top:8px;white-space:pre-wrap" class="dz-tr-text">${esc(neg.loi_text)}</p>
    ${req.user.isAdmin ? '' : `<button type="button" class="dz-tr-btn">🌐 ${esc(t((req.user.lang || 'en'), 'tr.translate'))}</button>`}</div>
    <p class="muted" style="margin-top:8px">📍 Buyer location: <b>${esc(neg.loi_location)}</b>${neg.loi_quantity ? ` · Quantity: ${esc(neg.loi_quantity)}` : ''}</p>
    ${neg.loi_wishes ? `<p class="muted" style="white-space:pre-wrap">💭 Wishes: ${esc(neg.loi_wishes)}</p>` : ''}
    ${neg.loi_expires_at ? `<p class="muted" style="margin-top:8px">⏰ Seller response deadline: <b>${esc(neg.loi_expires_at.slice(0, 16).replace('T', ' '))} UTC</b></p>` : ''}
  </div>`;

  const stateIdx = NEG_STATES.indexOf(st);
  const pipeline = ['LOI_SENT', 'OFFER_SENT', 'BUYER_APPROVED', 'PO_SENT', 'SIGNED', 'OWNER_APPROVED', 'PENDING_ADMIN', 'DONE'];
  const curPipe = (st === 'REJECTED' || st === 'EXPIRED') ? -1 : pipeline.indexOf(st === 'COUNTER_SENT' ? 'OFFER_SENT' : st === 'SIGNING' ? 'PO_SENT' : st === 'SPLIT_NEGO' ? 'OWNER_APPROVED' : st);
  const pipelineHtml = `<div class="stepper" role="list" aria-label="Negotiation pipeline">${pipeline.map((s, i) =>
    `<div class="step-node ${(st === 'REJECTED' || st === 'EXPIRED') ? '' : i < curPipe ? 'done' : i === curPipe ? 'current done' : ''}" style="--i:${i}">
      <span class="step-dot">${i < curPipe ? '✓' : i + 1}</span><span class="step-lbl">${esc(s.replace(/_/g, ' '))}</span>
    </div>`).join('')}</div>
    ${st === 'REJECTED' ? '<p style="margin-top:8px"><span class="badge badge-rejected">rejected</span></p>' : ''}
    ${st === 'EXPIRED' ? '<p style="margin-top:8px"><span class="badge badge-rejected">expired</span></p>' : ''}`;

  const body = `
  <div class="feed-head" style="margin-bottom:4px">
    <div><div class="kicker">Negotiation #${neg.id} · round ${neg.round}</div>
      <h1 style="font-size:1.6rem;margin-top:4px">🤝 ${esc(deal ? deal.title : 'Deal #' + neg.deal_id)}</h1></div>
    <a class="btn btn-sm btn-outline" href="/deals/inbox">← Deal inbox</a>
  </div>
  <p class="muted" style="margin-bottom:14px">
    Buyer: <a href="/company/${neg.buyer_id}"><b>${esc(buyerName)}</b></a> · Seller: <a href="/company/${neg.seller_id}"><b>${esc(sellerName)}</b></a>
    · Deal № ${esc(deal ? (deal.deal_number || String(deal.id)) : String(neg.deal_id))} · ${statusBadge(st)}
    · Incoterm: <b>${esc(curIncoterm)}</b>
    · <a href="/deal/${neg.deal_id}">view deal</a>
    ${['PO_SENT', 'SIGNING', 'SIGNED', 'OWNER_APPROVED', 'SPLIT_NEGO', 'PENDING_ADMIN', 'DONE'].includes(st) ? ` · <a href="/negotiation/${neg.id}/po.doc">PO (.doc)</a>` : ''}
  </p>
  <div style="margin-bottom:14px">${loiCountdownHtml(neg)}</div>
  <div class="card" data-reveal><h3>Pipeline</h3>${pipelineHtml}</div>
  ${actionHtml}
  <h3 class="sec-h">Rounds</h3>
  ${negTimelineHtml(neg.id, names, req.user.isAdmin ? 'en' : (req.user.lang || 'en'))}
  ${loiCard}`;
  res.send(page(`Negotiation #${neg.id}`, body, req.user, req.query.msg, req.query.err));
});

// ----- Negotiation actions (party-guarded, state-machine enforced) -----
/** Load neg + check party + expected state; on failure redirects and returns null. */
function negGuard(req, res, states, role) {
  let neg = getNegotiation(req.params.id);
  const back = neg ? `/negotiation/${neg.id}` : '/deals/inbox';
  if (!neg) { res.redirect('/deals/inbox?err=' + encodeURIComponent('Negotiation not found.')); return null; }
  if (req.user.isAdmin || (req.user.id !== neg.buyer_id && req.user.id !== neg.seller_id)) {
    res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Private negotiation</h2></div>', req.user));
    return null;
  }
  if (role === 'seller' && req.user.id !== neg.seller_id) { res.redirect(back + '?err=' + encodeURIComponent('Only the seller can do that.')); return null; }
  if (role === 'buyer' && req.user.id !== neg.buyer_id) { res.redirect(back + '?err=' + encodeURIComponent('Only the buyer can do that.')); return null; }
  // Batch A: apply the LOI response deadline first — once it lapses the negotiation flips
  // to EXPIRED and respond/counter/PO actions are refused until the buyer re-issues the LOI.
  neg = negExpireIfNeeded(neg);
  if (neg.state === 'EXPIRED') { res.redirect(back + '?err=' + encodeURIComponent('LOI expired — ask the buyer to re-issue.')); return null; }
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
  // Batch A: the seller picks the governing incoterm on the offer (was a mere confirm checkbox).
  const incoterm = DEAL_INCOTERMS.includes(req.body.incoterm) ? req.body.incoterm : 'CIF';
  const isReoffer = neg.state === 'COUNTER_SENT';
  const round = neg.round + 1; // the initial offer is round 1, the first re-offer after a counter is round 2, …
  db.prepare(`UPDATE negotiations SET state = 'OFFER_SENT', round = ?, offer_value = ?, offer_currency = ?, offer_terms = ?, offer_incoterm = ?, updated_at = ? WHERE id = ?`)
    .run(round, String(num), currency, terms, incoterm, now(), neg.id);
  // The offer's incoterm governs the deal page + tracking logic.
  try { db.prepare('UPDATE deals SET incoterm = ? WHERE id = ?').run(incoterm, neg.deal_id); } catch (e) { /* incoterm column always present on current schema */ }
  negEvent(neg.id, req.user.id, 'offer', { value: String(num), currency, terms, note: `${isReoffer ? `Re-offer — round ${round}` : 'Initial offer'} · Incoterm: ${incoterm}` });
  audit('DEAL AGENT', isReoffer ? 're-offer sent' : 'offer sent', 'pass', `${req.user.name} offered ${num} ${currency} on negotiation #${neg.id} (round ${round}, incoterm ${incoterm})`);
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
  negEvent(neg.id, req.user.id, 'counter', { value: String(num), currency, terms, note: `Counter — Incoterm unchanged: ${neg.offer_incoterm || 'CIF'}` });
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

// Buyer re-issues the LOI after expiry — resets the clock and reopens the negotiation.
app.post('/negotiation/:id/reissue-loi', requireCompany, (req, res) => {
  let neg = getNegotiation(req.params.id);
  if (!neg || req.user.isAdmin || (req.user.id !== neg.buyer_id && req.user.id !== neg.seller_id)) {
    return res.redirect('/deals/inbox?err=' + encodeURIComponent('Negotiation not found.'));
  }
  if (req.user.id !== neg.buyer_id) {
    return res.redirect(`/negotiation/${neg.id}?err=` + encodeURIComponent('Only the buyer can re-issue the LOI.'));
  }
  neg = negExpireIfNeeded(neg); // ensure a stale deadline is honoured even if not yet flipped
  if (neg.state !== 'EXPIRED') {
    return res.redirect(`/negotiation/${neg.id}?err=` + encodeURIComponent('The LOI can only be re-issued after it has expired.'));
  }
  const days = LOI_DEADLINE_DAYS.includes(Number(req.body.loi_deadline_days)) ? Number(req.body.loi_deadline_days) : 7;
  const expiresAt = loiExpiryFrom(days);
  db.prepare(`UPDATE negotiations SET state = 'LOI_SENT', loi_expires_at = ?, updated_at = ? WHERE id = ?`).run(expiresAt, now(), neg.id);
  negEvent(neg.id, req.user.id, 'loi_reissued', { note: `LOI re-issued — new seller response deadline: ${days} days (${expiresAt.slice(0, 16).replace('T', ' ')} UTC)` });
  audit('NEGOTIATION AGENT', 'LOI re-issued', 'pass', `${req.user.name} re-issued the LOI on negotiation #${neg.id} with a ${days}-day deadline`);
  notify(neg.seller_id, 'loi_reissued', `${req.user.name} re-issued the LOI on negotiation #${neg.id} — you have ${days} days to respond.`, `/negotiation/${neg.id}`);
  res.redirect(`/negotiation/${neg.id}?msg=` + encodeURIComponent(`LOI re-issued — the seller now has ${days} days to respond.`));
});

// Seller approves & issues the Purchase Order (document generated on demand via /po.doc).
app.post('/negotiation/:id/send-po', requireCompany, (req, res) => {
  const neg = negGuard(req, res, ['BUYER_APPROVED'], 'seller');
  if (!neg) return;
  negSetState(neg.id, 'PO_SENT');
  // Shipment map: auto-copy the buyer's LOI location into the deal destination (only when unset).
  try {
    if (neg.loi_location) {
      db.prepare(`UPDATE deals SET destination = ? WHERE id = ? AND (destination IS NULL OR destination = '')`).run(neg.loi_location, neg.deal_id);
    }
  } catch (e) { /* destination column may be missing on very old databases */ }
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
  const doc = brandedDoc({
    title: deal ? deal.title : 'Deal',
    docLabel: 'Purchase Order',
    docNo: '№ ' + dealNum,
    rows: [
      ['Buyer', esc(buyerName) + (neg.loi_location ? ` (${esc(neg.loi_location)})` : '')],
      ['Seller', esc(sellerName)],
      ['Deal number', esc(dealNum)],
      ['Agreed value', `<b>${esc(neg.offer_value)} ${esc(neg.offer_currency || 'USD')}</b>`],
      ['Incoterm', esc(negIncoterm(neg, deal))],
      ['Negotiation rounds', String(neg.round)],
      ['Issued', esc(now())]
    ],
    bodyHtml:
      docH('Agreed terms') + `<p style="white-space:pre-wrap">${esc(neg.offer_terms)}</p>` +
      docH('Platform commission') + `<p>${esc(feeClause)}</p>` +
      brandSignatures('Buyer signature', 'Seller signature'),
    footnote: 'Deal № ' + dealNum
  });
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

// Either party proposes (or counter-proposes) the commission split + the payment milestone schedule.
app.post('/negotiation/:id/split', requireCompany, (req, res) => {
  const neg = negGuard(req, res, ['OWNER_APPROVED', 'SPLIT_NEGO']);
  if (!neg) return;
  if (neg.state === 'SPLIT_NEGO' && neg.split_proposed_by === req.user.id) {
    return res.redirect(`/negotiation/${neg.id}?err=` + encodeURIComponent('You made the current proposal — wait for the other party.'));
  }
  const split = String(req.body.split || '');
  if (!NEG_SPLITS[split]) return res.redirect(`/negotiation/${neg.id}?err=` + encodeURIComponent('Invalid split option.'));
  // (5) The milestone schedule rides along with the split proposal — validated server-side (1–4 rows, sum = 100).
  const ms = parseMilestonesInput(req.body);
  if (ms.error) {
    audit('DEAL AGENT', 'milestone proposal validation', 'fail', `${req.user.name} proposed invalid milestones on negotiation #${neg.id}: ${ms.error}`);
    return res.redirect(`/negotiation/${neg.id}?err=` + encodeURIComponent(ms.error));
  }
  const msJson = JSON.stringify(ms.milestones);
  db.prepare(`UPDATE negotiations SET commission_split = ?, split_proposed_by = ?, milestone_proposal = ?, state = 'SPLIT_NEGO', updated_at = ? WHERE id = ?`)
    .run(split, req.user.id, msJson, now(), neg.id);
  negEvent(neg.id, req.user.id, 'split', { note: `Proposed split: ${NEG_SPLITS[split]} · Milestones: ${milestoneSummaryText(ms.milestones)}` });
  audit('DEAL AGENT', 'commission split proposed', 'pass', `${req.user.name} proposed split "${split}" + milestones (${milestoneSummaryText(ms.milestones)}) on negotiation #${neg.id}`);
  const other = req.user.id === neg.buyer_id ? neg.seller_id : neg.buyer_id;
  notify(other, 'split_proposed', `${req.user.name} proposed a commission split of "${NEG_SPLITS[split]}" and a payment milestone schedule on negotiation #${neg.id}. Accept or counter-propose.`, `/negotiation/${neg.id}`);
  res.redirect(`/negotiation/${neg.id}?msg=` + encodeURIComponent('Split & milestone schedule proposed — the other party has been notified.'));
});

// The other party accepts the proposed split + milestone schedule → PENDING_ADMIN.
app.post('/negotiation/:id/split-accept', requireCompany, (req, res) => {
  const neg = negGuard(req, res, ['SPLIT_NEGO']);
  if (!neg) return;
  if (neg.split_proposed_by === req.user.id) {
    return res.redirect(`/negotiation/${neg.id}?err=` + encodeURIComponent('You made the current proposal — the other party must accept it.'));
  }
  // Defense in depth: the accepted milestone schedule must still be valid (1–4 rows, sum = 100).
  const ms = parseMilestoneJson(neg.milestone_proposal);
  if (!ms) {
    return res.redirect(`/negotiation/${neg.id}?err=` + encodeURIComponent('No valid milestone schedule on the table — propose one first.'));
  }
  negSetState(neg.id, 'PENDING_ADMIN');
  negEvent(neg.id, req.user.id, 'split_accept', { note: `Accepted split: ${NEG_SPLITS[neg.commission_split] || neg.commission_split} · Milestones: ${milestoneSummaryText(ms)}` });
  audit('DEAL AGENT', 'commission split accepted', 'pass', `${req.user.name} accepted split "${neg.commission_split}" + milestones (${milestoneSummaryText(ms)}) on negotiation #${neg.id} — pending admin final approval`);
  const other = req.user.id === neg.buyer_id ? neg.seller_id : neg.buyer_id;
  notify(other, 'split_accepted', `${req.user.name} accepted the commission split and milestone schedule on negotiation #${neg.id} — awaiting admin final approval.`, `/negotiation/${neg.id}`);
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
      <span class="wax-seal wax-seal--fx" aria-hidden="true"><span>Dz</span></span><button class="btn js-sealsend js-magnet" type="submit">Seal &amp; send</button>
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
        data-reveal style="--i:${Math.min(idx, 8)}"
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
  </div>
  ${pcPaymentCardHtml(pc, user)}`;
  res.send(page('Private contract — ' + pc.title, body, user, req.query.msg, req.query.err, user.isAdmin ? undefined : 'contracts'));
});

// ----- POST /contracts/:id/payment-confirm — sender/recipient confirms their 50% commission share -----
app.post('/contracts/:id/payment-confirm', requireCompany, (req, res) => {
  const pc = getPrivateContract(req.params.id);
  if (!pc) return res.redirect('/contracts?err=' + encodeURIComponent('Contract not found.'));
  const back = `/contracts/${pc.id}`;
  if (pc.status !== 'approved' || !(Number(pc.value) > 0)) {
    return res.redirect(back + '?err=' + encodeURIComponent('No commission payment is currently pending for this contract.'));
  }
  const isParty = req.user.id === pc.sender_company_id || req.user.id === pc.recipient_company_id;
  if (!isParty) {
    audit('PAYMENT AGENT', 'payment confirm guard', 'fail', `${req.user.name} attempted to confirm a commission payment on private contract #${pc.id} without being a party`);
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Parties only</h2><p class="muted">Only the two contract parties can confirm commission payments.</p></div>', req.user));
  }
  const existing = db.prepare(`SELECT id FROM commission_payments WHERE private_contract_id = ? AND company_id = ? AND status = 'pending'`).get(pc.id, req.user.id);
  if (existing) {
    return res.redirect(back + '?err=' + encodeURIComponent('Your payment confirmation is already awaiting admin review.'));
  }
  const pcb = pcPaymentBreakdown(pc);
  const myShare = req.user.id === pc.sender_company_id ? pcb.senderShare : pcb.recipientShare;
  const note = String(req.body.note || '').trim().slice(0, 300);
  const amount = isFinite(myShare) ? Math.round(myShare * 100) / 100 : 0; // computed server-side
  db.prepare(`INSERT INTO commission_payments (deal_id, private_contract_id, company_id, amount, currency, note, status, created_at)
              VALUES (NULL, ?, ?, ?, ?, ?, 'pending', ?)`)
    .run(pc.id, req.user.id, amount, pcb.cur, note, now());
  audit('PAYMENT AGENT', 'payment confirmation submitted', 'pass', `${req.user.name} confirmed a commission payment of ${isFinite(myShare) ? `${fmtAmount(amount)} ${pcb.cur}` : 'amount TBC'} on private contract #${pc.id}${note ? ` — note: ${note}` : ''}`);
  res.redirect(back + '?msg=' + encodeURIComponent('Payment confirmation submitted — the administrator will verify your transfer and approve it.'));
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
  const doc = brandedDoc({
    title: pc.title,
    docLabel: 'Private Contract',
    docNo: '№ PC-' + pc.id,
    rows: [
      ['From (sender)', esc(names.get(pc.sender_company_id) || 'Unknown')],
      ['To (recipient)', esc(names.get(pc.recipient_company_id) || 'Unknown')],
      ...(Number(pc.value) > 0 ? [['Value', `<b>${esc(fmtAmount(Number(pc.value)))} ${esc(pc.currency || 'USD')}</b>`]] : []),
      ['Commission', esc(pcFeeLineText(pc))],
      ['Status', esc(pc.status.replace(/_/g, ' '))],
      ['Sealed', esc(pc.created_at)],
      ...(pc.signed_at ? [['Signed', esc(pc.signed_at)]] : []),
      ...(pc.decided_at ? [['Decided', esc(pc.decided_at)]] : [])
    ],
    bodyHtml:
      docH('Terms of the offer') + `<p style="white-space:pre-wrap">${esc(pc.terms)}</p>` +
      docH('Platform fee clause') + `<p>${esc(pcFeeClauseText())}</p>` +
      brandSignatures('Sender signature', 'Recipient signature'),
    footnote: 'Private Contract № PC-' + pc.id
  });
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
      <button class="btn btn-green js-magnet" type="submit">Sign contract</button>
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
    <div class="card card-deal create-card js-tilt">
      <div class="card__glare" aria-hidden="true"></div>
      <div class="big-ic">📄</div>
      <h2>Post a deal</h2>
      <p class="muted">Title, value, description — plus an optional photo or video.</p>
      <form method="POST" action="/deals" enctype="multipart/form-data" style="margin-top:14px;text-align:left">
        ${dealFormFieldsHtml()}
        <label>Photo or video (optional — image ≤ 5 MB, video ≤ 25 MB)</label>${mediaInput}
        <button class="btn js-magnet" type="submit">Publish deal</button>
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
    <div class="card create-card js-tilt">
      <div class="big-ic">📣</div>
      <h2>Promote</h2>
      <p class="muted">The ADVERTISING AGENT drafts a polished marketing post for your product or service — you review, edit and publish it.</p>
      <a class="btn js-magnet" href="/promote" style="margin-top:14px">Open the Advertising Agent →</a>
    </div>
  </div>`;
  res.send(page('Create', body, req.user, req.query.msg, req.query.err, 'new'));
});

// ============================= PROFILE (/profile) =============================
app.get('/profile', requireCompany, (req, res) => {
  const lang = req.user.lang || 'en';
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
    ? posts.map((p, idx) => feedCard({ kind: 'post', ref_id: p.id, company_id: p.company_id, body: p.body, created_at: p.created_at, media_id: p.media_id, author_name: p.author_name || '', is_system: p.is_system || 0, is_promo: p.is_promo || 0 }, req.user, names, idx)).join('')
    : '<div class="card"><p class="muted">No posts yet — share an update from the <a href="/new">create menu</a>.</p></div>';

  const coverHtml = c.header_media_id ? `<img class="profile-cover" src="/media/${c.header_media_id}" alt="${esc(c.name)} header image" loading="lazy">` : '';
  const body = `
  <div class="card">
    ${coverHtml}
    <div class="feed-head"><h2>${avatarHtml(c.name, c.avatar_media_id, 'avatar-lg')}${esc(c.name)}</h2>
      <a class="btn btn-sm btn-outline" href="/company/${c.id}">View public profile</a></div>
    <p style="margin-top:6px">${starsHtml(c.reputation)}</p>
    <p style="margin-top:6px">${bankKycBadgeHtml(c, lang)}${c.bank_kyc_notes && c.bank_kyc_status !== 'verified' ? `<br><span class="muted" style="font-size:12px">${esc(c.bank_kyc_notes)}</span>` : ''}</p>
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
  <div class="card" data-reveal>
    <h3>🏦 ${esc(t(lang, 'bank.title'))}</h3>
    <p class="muted">Used for commission payouts and counterparty invoicing. The BANK RESEARCH AGENT validates them automatically (SWIFT structure, IBAN checksum, completeness) and shows the verdict as a badge on your profile. Full details stay private to you and the platform admin.</p>
    ${req.user.memberId ? '<p class="muted">Team members cannot change bank details — ask the main company account.</p>' : `
    <form method="POST" action="/profile/bank">
      <div class="grid2" style="gap:10px">
        <div><label>${esc(t(lang, 'bank.name'))}</label><input type="text" name="bank_name" maxlength="120" value="${esc(c.bank_name || '')}" placeholder="e.g. Emirates NBD"></div>
        <div><label>${esc(t(lang, 'bank.swift'))}</label><input type="text" name="bank_swift" maxlength="11" value="${esc(c.bank_swift || '')}" placeholder="e.g. EBILAEAD" style="text-transform:uppercase"></div>
      </div>
      <div class="grid2" style="gap:10px">
        <div><label>${esc(t(lang, 'bank.iban'))}</label><input type="text" name="bank_iban" maxlength="34" value="${esc(c.bank_iban || '')}" placeholder="e.g. AE070331234567890123456"></div>
        <div><label>${esc(t(lang, 'bank.country'))}</label><input type="text" name="bank_country" maxlength="60" value="${esc(c.bank_country || '')}" placeholder="e.g. United Arab Emirates"></div>
      </div>
      <label>${esc(t(lang, 'bank.holder'))}</label><input type="text" name="bank_holder" maxlength="120" value="${esc(c.bank_holder || '')}" placeholder="Legal account holder name">
      <button class="btn" type="submit">${esc(t(lang, 'bank.save'))}</button>
    </form>`}
  </div>
  <div class="card" data-reveal>
    <h3>🎨 Platform theme</h3>
    <p class="muted">Pick your company's palette — applied to every page of your sessions and composed with the dark/light toggle (top right). Takes effect on the next page load.</p>
    <form method="POST" action="/profile/theme">
      <div class="palette-grid">
        ${Object.entries(THEME_PALETTES).map(([key, p]) => `
        <label class="palette-opt">
          <input type="radio" name="theme_choice" value="${esc(key)}"${(THEME_PALETTES[c.theme_choice] ? c.theme_choice : 'titan') === key ? ' checked' : ''}>
          <span class="palette-card">
            <span class="palette-swatch"><span style="background:${esc(p.dark)}"></span><span style="background:${esc(p.light)}"></span></span>
            <span class="palette-name">${esc(p.label)}${key === 'titan' ? ' · default' : ''}</span><br>
            <span class="palette-hint">${esc(p.hint)}</span>
          </span>
        </label>`).join('')}
      </div>
      <button class="btn btn-sm" type="submit">Apply theme</button>
    </form>
    <hr class="sep">
    <h4 style="margin:0 0 6px">🖼️ Theme from my logo</h4>
    <p class="muted" style="margin:0 0 10px">Upload your company logo (or any brand image) — Dealzoin reads its dominant colors and builds a theme around your brand. Works in both dark and light mode.${c.avatar_media_id ? ' You can also use the logo already on your profile.' : ''}</p>
    <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
      ${c.avatar_media_id ? `<div style="text-align:center"><img src="/media/${c.avatar_media_id}" alt="My logo" style="width:64px;height:64px;object-fit:cover;border-radius:14px;border:1px solid var(--border-soft);display:block"><button type="button" class="btn btn-sm btn-outline" id="lt-use-avatar" data-src="/media/${c.avatar_media_id}" style="margin-top:6px">Use my profile logo</button></div>` : ''}
      <label class="file-btn dropzone" style="flex:1;min-width:220px"><span class="file-btn-text" data-default="📎 Upload a logo image to read its colors">📎 Upload a logo image to read its colors</span>
        <input type="file" class="file-input" id="lt-file" accept="image/png,image/jpeg,image/webp,image/gif"></label>
    </div>
    <div id="lt-preview" style="display:none;margin-top:12px">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <span class="muted">Extracted brand colors:</span>
        <span id="lt-sw1" style="width:44px;height:44px;border-radius:12px;border:1px solid var(--border-soft);display:inline-block"></span>
        <span id="lt-sw2" style="width:44px;height:44px;border-radius:12px;border:1px solid var(--border-soft);display:inline-block"></span>
        <span id="lt-hex" class="muted" style="font-size:12px"></span>
      </div>
      <form method="POST" action="/profile/theme/logo" style="margin-top:10px">
        <input type="hidden" name="primary" id="lt-primary">
        <input type="hidden" name="secondary" id="lt-secondary">
        <button class="btn btn-sm" type="submit">✨ Apply my logo theme</button>
      </form>
    </div>
    <div id="lt-none" class="muted" style="display:none;margin-top:10px">Couldn't find brand colors in that image (is it fully white/black?) — try a different picture.</div>
    ${c.theme_choice === 'custom' ? `<p class="muted" style="margin-top:10px">✓ Your custom logo theme is active. Pick one of the palettes above and Apply to leave it.</p>` : ''}
    <script>(function(){
      var file=document.getElementById('lt-file');
      var avatarBtn=document.getElementById('lt-use-avatar');
      function hueOf(o){var r=o.r/255,g=o.g/255,b=o.b/255;var mx=Math.max(r,g,b),mn=Math.min(r,g,b);if(mx===mn)return 0;var d=mx-mn;var h;if(mx===r)h=((g-b)/d+(g<b?6:0));else if(mx===g)h=(b-r)/d+2;else h=(r-g)/d+4;return h*60;}
      function hexOf(o){return '#'+[o.r,o.g,o.b].map(function(v){return Math.round(v).toString(16).padStart(2,'0');}).join('');}
      function extract(srcUrl){
        var img=new Image();
        img.onload=function(){
          try{
            var cv=document.createElement('canvas');cv.width=64;cv.height=64;
            var cx=cv.getContext('2d');cx.drawImage(img,0,0,64,64);
            var d=cx.getImageData(0,0,64,64).data;
            var buckets={},i,key;
            for(i=0;i<d.length;i+=4){
              var r=d[i],g=d[i+1],b=d[i+2],a=d[i+3];
              if(a<128)continue;
              var mx=Math.max(r,g,b),mn=Math.min(r,g,b);
              if(mx>242||mx<18)continue;      // skip near-white / near-black
              if(mx-mn<24)continue;            // skip greys
              key=(r>>4)+','+(g>>4)+','+(b>>4);
              var bk=buckets[key]||(buckets[key]={n:0,r:0,g:0,b:0});
              bk.n++;bk.r+=r;bk.g+=g;bk.b+=b;
            }
            var arr=Object.keys(buckets).map(function(k){var o=buckets[k];return{n:o.n,r:o.r/o.n,g:o.g/o.n,b:o.b/o.n};});
            var prev=document.getElementById('lt-preview'), none=document.getElementById('lt-none');
            if(!arr.length){ if(prev)prev.style.display='none'; if(none)none.style.display='block'; return; }
            arr.sort(function(a,b){return b.n-a.n;});
            var primary=arr[0], pHue=hueOf(primary), secondary=null;
            for(i=1;i<arr.length;i++){ var dh=Math.abs(hueOf(arr[i])-pHue); dh=Math.min(dh,360-dh); if(dh>40){secondary=arr[i];break;} }
            document.getElementById('lt-primary').value=hexOf(primary);
            document.getElementById('lt-secondary').value=secondary?hexOf(secondary):'';
            document.getElementById('lt-sw1').style.background=hexOf(primary);
            var sw2=document.getElementById('lt-sw2');
            sw2.style.background=secondary?hexOf(secondary):'transparent';
            sw2.style.border=secondary?'1px solid var(--border-soft)':'1px dashed var(--border-soft)';
            document.getElementById('lt-hex').textContent=hexOf(primary)+(secondary?' + '+hexOf(secondary):' (single color)');
            if(none)none.style.display='none'; if(prev)prev.style.display='block';
          }catch(e){ var none=document.getElementById('lt-none'); if(none)none.style.display='block'; }
        };
        img.onerror=function(){ var none=document.getElementById('lt-none'); if(none)none.style.display='block'; };
        img.src=srcUrl;
      }
      if(file){file.addEventListener('change',function(){
        var f=file.files&&file.files[0]; if(!f)return;
        extract(URL.createObjectURL(f));
      });}
      if(avatarBtn){avatarBtn.addEventListener('click',function(){ extract(avatarBtn.getAttribute('data-src')); });}
    })();</script>
  </div>
  <div class="stats">
    <div class="stat card--cut js-tilt" data-reveal style="--i:0" data-num="01"><div class="num gold" data-count="${deals.length}">${deals.length}</div><div class="lbl">My deals</div></div>
    <div class="stat card--cut js-tilt" data-reveal style="--i:1" data-num="02"><div class="num" data-count="${posts.length}">${posts.length}</div><div class="lbl">My posts</div></div>
    <div class="stat card--cut js-tilt" data-reveal style="--i:2" data-num="03"><div class="num mint" data-count="${fc.followers}">${fc.followers}</div><div class="lbl">Followers</div></div>
    <div class="stat card--cut js-tilt" data-reveal style="--i:3" data-num="04"><div class="num" data-count="${fc.following}">${fc.following}</div><div class="lbl">Following</div></div>
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

// Logo-derived custom theme: the profile page extracts the logo's dominant colors client-side
// (canvas) and posts up to two hex values; the server validates and derives the palette per page load.
app.post('/profile/theme/logo', requireCompany, (req, res) => {
  const primary = String(req.body.primary || '').trim().toLowerCase();
  let secondary = String(req.body.secondary || '').trim().toLowerCase();
  if (!hexToRgb(primary)) return res.redirect('/profile?err=' + encodeURIComponent('Invalid primary color — try extracting from the logo again.'));
  if (!hexToRgb(secondary)) secondary = null;
  db.prepare("UPDATE companies SET theme_choice = 'custom', theme_custom = ? WHERE id = ?")
    .run(JSON.stringify(secondary ? { primary, secondary } : { primary }), req.user.id);
  audit('THEME AGENT', 'logo theme applied', 'pass', `${req.user.name} applied a custom logo theme (primary ${primary}${secondary ? ', secondary ' + secondary : ''})`);
  res.redirect('/profile?msg=' + encodeURIComponent('Your logo theme is live — every page now wears your brand colors.'));
});

// Batch A: per-company platform palette. Persisted on companies.theme_choice and applied
// via <html data-palette="…"> on the next page load (composed with the dark/light toggle).
app.post('/profile/theme', requireCompany, (req, res) => {
  const choice = String(req.body.theme_choice || 'titan');
  if (!THEME_PALETTES[choice]) return res.redirect('/profile?err=' + encodeURIComponent('Unknown palette.'));
  db.prepare('UPDATE companies SET theme_choice = ? WHERE id = ?').run(choice, req.user.id);
  res.redirect('/profile?msg=' + encodeURIComponent(`Theme set to ${THEME_PALETTES[choice].label} — applied across your sessions.`));
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
  const lang = req.user.lang || 'en';
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
    [t(lang, 'dash.mydeals'), stats.deals, ' gold'], [t(lang, 'dash.myposts'), stats.posts, ''], [t(lang, 'dash.followers'), stats.followers, ' mint'],
    [t(lang, 'dash.likes'), stats.likesReceived, ' gold'], [t(lang, 'dash.comments'), stats.commentsReceived, ''],
    [t(lang, 'dash.contractssigned'), stats.signedPending + ' pending · ' + stats.signedApproved + ' approved', ''],
    [t(lang, 'dash.contractsonmine'), stats.minePending + ' pending · ' + stats.mineApproved + ' approved', '']
  ];
  const tilesHtml = `<div class="stats">${tiles.map(([l, n, cls], ti) => `<div class="stat card--cut js-tilt" data-reveal style="--i:${Math.min(ti, 8)}" data-num="${String(ti + 1).padStart(2, '0')}"><div class="num${cls}"${typeof n === 'number' ? ` data-count="${n}"` : ''}>${n}</div><div class="lbl">${l}</div></div>`).join('')}</div>`;

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
    var ink = v('--ink-muted', '#A3ACC2'), soft = v('--border-soft', '#24304A'), primary = v('--ink-primary', '#F4F1E8');
    var gold = v('--gold', '#F58A3A'), mint = v('--mint', '#3FE0B0'), warn = v('--warning', '#FFB454'), dgr = v('--danger', '#FF6B85'), faint = v('--ink-faint', '#6E7A95'), bgv = v('--bg-void', '#0D1321');
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

  // Batch C (4)+(5): Accounting & Warehouse quick cards.
  const whItems = count('SELECT COUNT(*) AS n FROM warehouse_items WHERE company_id = ?', myId);
  const whLow = count('SELECT COUNT(*) AS n FROM warehouse_items WHERE company_id = ? AND quantity <= reorder_level', myId);
  const openInv = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s, currency FROM invoices WHERE company_id = ? AND status IN ('sent','overdue') GROUP BY currency ORDER BY currency`).all(myId);
  const openInvText = openInv.length ? openInv.map(r => `${fmtAmount(r.s)} ${esc(r.currency)}`).join(' · ') : '—';
  const batchCCards = `
  <div class="grid2">
    <div class="card card--cut js-tilt" data-reveal style="--i:5" data-num="AC">
      <h3>📒 ${esc(t(lang, 'dash.accounting'))}</h3>
      <p class="muted">${esc(t(lang, 'acct.receivables'))}: <b>${openInvText}</b></p>
      <a class="btn btn-sm btn-outline" href="/accounting">${esc(t(lang, 'acct.title'))} →</a>
    </div>
    <div class="card card--cut js-tilt" data-reveal style="--i:6" data-num="WH">
      <h3>📦 ${esc(t(lang, 'dash.warehouse'))}</h3>
      <p class="muted"><b>${whItems}</b> ${esc(t(lang, 'dash.items'))} · ${whLow ? `<span style="color:var(--danger);font-weight:700">${whLow} ${esc(t(lang, 'dash.lowstock'))} ⚠️</span>` : `0 ${esc(t(lang, 'dash.lowstock'))} ✓`}</p>
      <a class="btn btn-sm btn-outline" href="/warehouse">${esc(t(lang, 'wh.title'))} →</a>
    </div>
  </div>`;

  const body = `
  <h2 class="sec-h" style="margin-top:0;margin-bottom:14px">📊 ${esc(t(lang, 'dash.title'))}</h2>
  <div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
    <div><h3 style="margin-bottom:2px">📥 ${esc(t(lang, 'dash.inbox'))}</h3>
      <p class="muted">Contracts and counter offers on your deals awaiting your decision.</p></div>
    <a class="btn btn-sm${stats.inboxActions ? '' : ' btn-outline'}" href="/deals/inbox">${esc(t(lang, 'dash.openinbox'))}${stats.inboxActions ? ` <span class="unread-chip" style="margin-left:6px">${stats.inboxActions}</span>` : ''}</a>
  </div>
  ${batchCCards}
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
    return `<div class="bubble ${mine ? 'mine' : 'theirs'}" data-dz-tr>
      ${senderLine}
      <span class="dz-tr-text">${esc(m.body)}</span>
      <div class="bubble-meta">${esc(m.created_at.slice(0, 16).replace('T', ' '))}${user.isAdmin ? '' : ` · <button type="button" class="dz-tr-btn">🌐 ${esc(t((user.lang || 'en'), 'tr.translate'))}</button>`}</div>
    </div>`;
  }).join('') : '<p class="muted">No messages yet — say hello.</p>';

  const sendForm = user.isAdmin
    ? '<p class="muted">Admin view — conversations are read-only for admins.</p>'
    : `<form method="POST" action="/chat/${conv.id}/send" class="chat-send" id="chatform">
         <input type="text" name="body" required maxlength="2000" placeholder="Write a message…" autocomplete="off">
         <button class="btn js-send" type="submit">Send</button>
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
      div.setAttribute('data-dz-tr','');
      if(m.sender_company_id!==ME&&(ISGROUP||m.author_name)){
        var s=document.createElement('div');s.className='bubble-sender';
        s.textContent=(m.sender_name||'')+(m.author_name?' — by '+m.author_name:'');
        div.appendChild(s);
      }
      var txt=document.createElement('span');txt.className='dz-tr-text';txt.textContent=m.body;
      div.appendChild(txt);
      var meta=document.createElement('div');meta.className='bubble-meta';
      meta.textContent=(m.created_at||'').slice(0,16).replace('T',' ')+(optimistic?' · sending…':'');
      if(!optimistic){
        var tb=document.createElement('button');tb.type='button';tb.className='dz-tr-btn';
        tb.textContent=' 🌐 '+DZ_TR.btnLabel;meta.appendChild(tb);
      }
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
      <span style="display:flex;gap:8px">${!user.isAdmin && member ? `<a class="btn btn-sm btn-green" href="/call/chat-${conv.id}">📹 Call</a>` : ''}
      <a class="btn btn-sm btn-outline" href="/chats">← All chats</a></span></div>
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
    return `<div class="card" data-reveal style="--i:${Math.min(i, 8)}" id="ev-${e.id}">
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
      <p class="muted" style="margin-top:6px">Every event gets a private in-platform video room (WebRTC — no external provider), visible to participants and the admin only.</p>
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
    // Legacy slug kept for schema/back-compat; the call itself is a native room at /call/event-<id>.
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
  // Native in-platform call room (WebRTC) — no external provider. Old /calendar/join/:id links keep working.
  res.redirect('/call/event-' + ev.id);
});

// ============================= NATIVE VIDEO CALLS (WebRTC signaling) =============================
/* In-platform 1:1 / group video calls — no external provider (Jitsi fully replaced).
 * NOTE: camera/microphone capture (getUserMedia) requires a secure context, so serve Dealzoin
 * over HTTPS in production — http://localhost is a browser exception and still works for dev.
 * Signaling state is in-memory (fine for a single dyno); the media itself flows peer-to-peer
 * (mesh: one RTCPeerConnection per peer, comfortable up to ~6 participants). */
const callRooms = new Map();        // roomKey -> Map(peerId -> { res, name })
const CALL_MAX_SIGNAL_DATA = 32 * 1024; // sanity cap on relayed SDP/ICE payloads

/** Resolve "event-<id>" / "chat-<id>" to its backing object plus the join-guard verdict. */
function resolveCallRoom(roomId, user) {
  const m = /^(event|chat)-(\d{1,9})$/.exec(String(roomId || ''));
  if (!m || !user) return null;
  const id = parseInt(m[2], 10);
  if (m[1] === 'event') {
    const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
    if (!ev) return null;
    return { key: 'event-' + id, kind: 'event', id, title: ev.title,
      backUrl: '/calendar#ev-' + id, allowed: canJoinEvent(user, ev) };
  }
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  if (!conv) return null;
  const names = companyNameMap();
  return { key: 'chat-' + id, kind: 'chat', id, title: convDisplayName(conv, user.isAdmin ? 0 : user.id, names),
    backUrl: '/chat/' + id, allowed: !!(user.isAdmin || isMember(id, user.id)) };
}
/** Names of the companies allowed in a room — rendered as the roster on the call page. */
function callRoomRoster(room) {
  try {
    if (room.kind === 'event') {
      const names = companyNameMap();
      const ids = new Set();
      const ev = db.prepare('SELECT creator_company_id FROM events WHERE id = ?').get(room.id);
      if (ev) ids.add(ev.creator_company_id);
      for (const p of db.prepare('SELECT company_id FROM event_participants WHERE event_id = ?').all(room.id)) ids.add(p.company_id);
      return [...ids].map(cid => names.get(cid) || 'Unknown');
    }
    return db.prepare(`SELECT c.name FROM conversation_members cm JOIN companies c ON c.id = cm.company_id
      WHERE cm.conversation_id = ? ORDER BY c.name`).all(room.id).map(r => r.name);
  } catch (e) { return []; }
}
/** Push a JSON payload to the connected peers of a room (except `exceptPeer` when given). */
function callBroadcast(roomKey, payload, exceptPeer) {
  const peers = callRooms.get(roomKey);
  if (!peers || !peers.size) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const [pid, p] of [...peers]) {
    if (pid === exceptPeer) continue;
    try { p.res.write(data); } catch (e) { try { p.res.end(); } catch (_) {} peers.delete(pid); }
  }
}
/**
 * "📹 X started a call — Join": fired once per call (first peer in an empty room).
 * Chat rooms get a system message in the conversation (+ live SSE push); event rooms notify
 * participants/creator through the bell with a clickable Join link. Announcement failures
 * must never break the call itself, so callers wrap this in try/catch.
 */
function announceCallStart(room, user) {
  const link = '/call/' + room.key;
  const who = (user.name + (user.memberName ? ` (${user.memberName})` : '')).slice(0, 120);
  if (room.kind === 'chat') {
    const text = `📹 ${who} started a call — Join: ${link}`;
    const ts = now();
    const info = db.prepare('INSERT INTO messages (conversation_id, sender_company_id, body, created_at, author_name) VALUES (?,?,?,?,?)')
      .run(room.id, user.isAdmin ? 0 : user.id, text, ts, user.memberName || null);
    sseBroadcast(room.id, {
      id: Number(info.lastInsertRowid), conversation_id: room.id,
      sender_company_id: user.isAdmin ? 0 : user.id, sender_name: user.name,
      author_name: user.memberName || '', body: text, created_at: ts, cid: ''
    });
    for (const m of db.prepare('SELECT company_id FROM conversation_members WHERE conversation_id = ?').all(room.id)) {
      if (user.isAdmin || m.company_id !== user.id) notify(m.company_id, 'call', `📹 ${who} started a call in your chat — tap to join.`, link);
    }
  } else {
    const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(room.id);
    if (!ev) return;
    const ids = new Set([ev.creator_company_id]);
    for (const p of db.prepare('SELECT company_id FROM event_participants WHERE event_id = ?').all(room.id)) ids.add(p.company_id);
    for (const cid of ids) {
      if (user.isAdmin || cid !== user.id) notify(cid, 'call', `📹 ${who} started a call for "${ev.title.slice(0, 60)}" — tap to join.`, link);
    }
  }
}

/**
 * Full-screen dark call UI (Titan Ledger palette) + the entire WebRTC client in vanilla JS.
 * Defensive throughout: every async step is wrapped, remote names are only ever assigned via
 * textContent (never innerHTML), and one bad signal/message cannot kill the call.
 */
function callPage(room, user) {
  const roster = callRoomRoster(room);
  const title = (room.kind === 'event' ? '📅 ' : '💬 ') + room.title;
  const myName = user.name + (user.memberName ? ' · ' + user.memberName : '');
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>📹 ${esc(title)} — Dealzoin Call</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0}
[hidden]{display:none!important}
html,body{height:100%}
body{background:#0D1321;color:#F4F1E8;font-family:Inter,system-ui,sans-serif;display:flex;flex-direction:column;height:100vh;overflow:hidden}
.ctop{display:flex;align-items:center;gap:16px;padding:12px 18px;background:rgba(13,19,33,.92);border-bottom:1px solid #24304A;flex-wrap:wrap}
.cbrand{display:flex;align-items:center;gap:8px;color:#F4F1E8;text-decoration:none;font-family:'Space Grotesk',Inter,sans-serif;font-weight:700}
.ccoin{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:linear-gradient(120deg,#F08A3C 0%,#FFB37A 45%,#D0611C 100%);color:#160E04;font-size:13px;font-weight:700}
.clive{background:#C93A56;color:#FFF7F0;font-size:10px;letter-spacing:1.5px;padding:3px 7px;border-radius:5px;margin-left:4px}
.ctitle{flex:1;min-width:180px;display:flex;flex-direction:column;gap:2px}
.croster{color:#A3ACC2;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46vw}
.cstatus{display:flex;align-items:center;gap:8px;font-size:13px;color:#A3ACC2}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block}
.dot-ok{background:#3FE0B0;box-shadow:0 0 8px rgba(63,224,176,.7)}
.dot-warn{background:#FFB454;animation:dzpulse 1.2s infinite}
.dot-off{background:#FF6B85}
@keyframes dzpulse{50%{opacity:.3}}
.ccount{margin-left:10px}
.cstage{flex:1;position:relative;overflow:hidden;padding:14px}
.cgrid{display:grid;gap:14px;height:100%;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));grid-auto-rows:1fr;align-content:center}
.tile{position:relative;background:#0A0F1C;border:1px solid #24304A;border-radius:14px;overflow:hidden;min-height:180px}
.tile video{width:100%;height:100%;object-fit:cover;display:block}
.tile-name{position:absolute;left:10px;bottom:10px;background:rgba(13,19,33,.78);border:1px solid #24304A;padding:3px 10px;border-radius:20px;font-size:12px}
.cwaiting{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
.cwait-card{display:flex;flex-direction:column;align-items:center;gap:10px;color:#A3ACC2;text-align:center;padding:20px;max-width:420px}
.cwait-card b{color:#F4F1E8;font-family:'Space Grotesk',Inter,sans-serif;font-size:18px}
.cwait-card span{font-size:13px}
.cwait-pulse{width:16px;height:16px;border-radius:50%;background:#F58A3A;animation:dzpulse 1.4s infinite;box-shadow:0 0 14px rgba(245,138,58,.8)}
.pip{position:fixed;right:18px;bottom:96px;width:220px;max-width:38vw;background:#0A0F1C;border:1px solid rgba(245,138,58,.38);border-radius:14px;overflow:hidden;box-shadow:0 12px 32px rgba(0,0,0,.5);z-index:5}
.pip video{width:100%;aspect-ratio:4/3;object-fit:cover;display:block;background:#0A0F1C;transform:scaleX(-1)}
.pip-name{position:absolute;left:8px;bottom:8px;background:rgba(13,19,33,.78);padding:2px 8px;border-radius:16px;font-size:11px}
.pip-audio{display:flex;align-items:center;justify-content:center;padding:26px 8px;color:#A3ACC2;font-size:13px}
.ccontrols{display:flex;justify-content:center;gap:14px;padding:14px;background:rgba(13,19,33,.92);border-top:1px solid #24304A}
.cbtn{width:56px;height:56px;border-radius:50%;border:1px solid #24304A;background:#141D31;color:#F4F1E8;font-size:22px;cursor:pointer;transition:transform .12s,background .12s}
.cbtn:hover{transform:translateY(-2px);background:#16203A}
.cbtn.ctl-off{background:#3A1A24;border-color:#C93A56}
.cbtn-hang{background:#C93A56;border-color:#FF6B85}
.cbtn-hang:hover{background:#FF6B85}
.perm{position:fixed;inset:0;background:rgba(9,13,24,.92);display:flex;align-items:center;justify-content:center;z-index:20;padding:16px}
.perm-card{max-width:460px;background:#141D31;border:1px solid rgba(245,138,58,.38);border-radius:18px;padding:28px;text-align:center}
.perm-icon{font-size:34px}
.perm-card h2{font-family:'Space Grotesk',Inter,sans-serif;margin:10px 0 6px}
.perm-card p{color:#A3ACC2;font-size:14px}
.perm-steps{text-align:left;color:#A3ACC2;font-size:13px;margin:14px 0 14px 22px;display:flex;flex-direction:column;gap:6px}
.perm-btns{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:6px}
.cbtn2{padding:10px 18px;border-radius:12px;border:none;cursor:pointer;font-weight:600;font-size:14px;font-family:Inter,sans-serif}
.cbtn2-gold{background:linear-gradient(120deg,#F08A3C 0%,#FFB37A 45%,#D0611C 100%);color:#160E04}
.cbtn2-outline{background:transparent;border:1px solid #24304A;color:#F4F1E8}
.toasts{position:fixed;top:14px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;gap:8px;z-index:30;max-width:90vw}
.toast{background:#141D31;border:1px solid #24304A;color:#F4F1E8;padding:9px 16px;border-radius:12px;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.45)}
.toast-err{border-color:#C93A56}
@media(max-width:640px){.pip{width:120px;bottom:86px}.cbtn{width:48px;height:48px;font-size:18px}.croster{max-width:60vw}}
</style></head>
<body>
<header class="ctop">
  <a class="cbrand" href="${esc(room.backUrl)}" title="Back"><span class="ccoin">Dz</span>Dealzoin<span class="clive">CALL</span></a>
  <div class="ctitle"><b>${esc(title)}</b><span class="croster">👥 ${esc(roster.join(', ') || 'participants only')}</span></div>
  <div class="cstatus"><span class="dot dot-warn" id="statusDot"></span><span id="statusText">starting…</span><span class="ccount">👤 <span id="peerCount">1</span></span></div>
</header>
<main class="cstage">
  <div class="cgrid" id="grid"></div>
  <div class="cwaiting" id="waiting">
    <div class="cwait-card">
      <div class="cwait-pulse"></div>
      <b>Waiting for others to join…</b>
      <span>Participants get a “📹 Join” prompt in their chats and notifications. This room is private to the invited companies.</span>
    </div>
  </div>
</main>
<div class="pip" id="pipWrap">
  <video id="localVideo" autoplay muted playsinline></video>
  <div class="pip-audio" id="pipAudio" hidden>🎙️ audio only</div>
  <span class="pip-name">${esc(myName)} (you)</span>
</div>
<div class="perm" id="permOverlay" hidden>
  <div class="perm-card">
    <div class="perm-icon">🎥 🎙️</div>
    <h2>Camera &amp; microphone needed</h2>
    <p id="permMsg">Your browser will ask for permission — press <b>Allow</b> to join the call with video.</p>
    <ol class="perm-steps">
      <li>Click the lock / tune icon in the browser address bar.</li>
      <li>Set <b>Camera</b> and <b>Microphone</b> to Allow for this site.</li>
      <li>Come back here and press <b>Retry</b> (or continue audio-only).</li>
    </ol>
    <div class="perm-btns">
      <button class="cbtn2 cbtn2-gold" id="btnRetry" type="button">↻ Retry</button>
      <button class="cbtn2 cbtn2-outline" id="btnAudioOnly" type="button">🎙️ Continue audio-only</button>
    </div>
  </div>
</div>
<div class="ccontrols">
  <button class="cbtn" id="btnMic" type="button" title="Mute / unmute microphone" aria-label="Mute microphone" aria-pressed="false">🎙️</button>
  <button class="cbtn" id="btnCam" type="button" title="Camera on / off" aria-label="Toggle camera" aria-pressed="false">🎥</button>
  <button class="cbtn cbtn-hang" id="btnHang" type="button" title="Hang up" aria-label="Hang up">🔴</button>
</div>
<div class="toasts" id="toasts" aria-live="polite"></div>
<script>(function(){
'use strict';
/* Dealzoin native call client — WebRTC mesh with perfect negotiation.
 * getUserMedia needs a secure context (HTTPS); http://localhost is a browser exception. */
var ROOM = ${jsonForHtml(room.key)};
var BACK = ${jsonForHtml(room.backUrl)};
var ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
var myId = 'p' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
var peers = {};           // peerId -> { pc, name, makingOffer, ignoreOffer, polite, stream, tile, video, restartTimer }
var localStream = null;
var es = null;
var micOn = true, camOn = true, audioOnly = false, hungUp = false;

function $(id){ return document.getElementById(id); }
function toast(msg, isErr){
  var box = $('toasts'); if(!box) return;
  var t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' toast-err' : '');
  t.textContent = String(msg);           // textContent only — remote data never becomes HTML
  box.appendChild(t);
  setTimeout(function(){ if(t.parentNode) t.parentNode.removeChild(t); }, 5000);
}
function setStatus(txt, cls){
  var dot = $('statusDot'), label = $('statusText');
  if(dot) dot.className = 'dot ' + (cls || 'dot-warn');
  if(label) label.textContent = txt;
}
function updateConnStatus(){
  var ids = Object.keys(peers);
  if(!ids.length){ if(!hungUp) setStatus('in room — waiting for peers', 'dot-warn'); return; }
  var anyConn = false, anyTrying = false;
  for(var i = 0; i < ids.length; i++){
    var s = peers[ids[i]].pc.iceConnectionState;
    if(s === 'connected' || s === 'completed') anyConn = true;
    else if(s === 'new' || s === 'checking' || s === 'disconnected') anyTrying = true;
  }
  if(anyConn) setStatus('connected', 'dot-ok');
  else if(anyTrying) setStatus('connecting…', 'dot-warn');
  else setStatus('connection lost — retrying…', 'dot-off');
}
function updateWaiting(){
  var n = Object.keys(peers).length;
  var w = $('waiting'); if(w) w.style.display = n ? 'none' : 'flex';
  var c = $('peerCount'); if(c) c.textContent = String(n + 1);
}
function sendSignal(to, data){
  fetch('/call/' + encodeURIComponent(ROOM) + '/signal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: to, from: myId, data: data })
  }).then(function(r){ if(!r.ok) toast('Signaling hiccup — the connection will retry automatically.', true); })
    .catch(function(){ toast('Signaling connection lost — retrying…', true); });
}

// ----- Media capture (with permission-denied fallback UI) -----
function showPerm(msg){
  var o = $('permOverlay'), m = $('permMsg');
  if(m && msg) m.textContent = msg;
  if(o) o.hidden = false;
}
function hidePerm(){ var o = $('permOverlay'); if(o) o.hidden = true; }
function startMedia(audioOnlyMode){
  audioOnly = !!audioOnlyMode;
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    showPerm('Camera and microphone need a secure (HTTPS) page — on http://localhost they work by browser exception.');
    return;
  }
  var constraints = audioOnly
    ? { audio: { echoCancellation: true, noiseSuppression: true }, video: false }
    : { audio: { echoCancellation: true, noiseSuppression: true }, video: { width: { ideal: 1280 }, height: { ideal: 720 } } };
  navigator.mediaDevices.getUserMedia(constraints).then(function(stream){
    localStream = stream;
    var lv = $('localVideo');
    if(lv){ lv.srcObject = stream; lv.style.display = audioOnly ? 'none' : 'block'; }
    var pa = $('pipAudio'); if(pa) pa.hidden = !audioOnly;
    var bc = $('btnCam'); if(bc && audioOnly) bc.classList.add('ctl-off');
    camOn = !audioOnly;
    hidePerm();
    connectSignaling();
  }).catch(function(err){
    var msg = (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError'))
      ? 'Permission denied — allow the camera & microphone in the browser address bar, then press Retry (or continue audio-only).'
      : 'Could not access the camera/microphone' + (err && err.message ? ': ' + err.message : '');
    showPerm(msg);
  });
}

// ----- Signaling channel (SSE) -----
function connectSignaling(){
  if(es) return;
  try { es = new EventSource('/call/' + encodeURIComponent(ROOM) + '/stream?peer=' + encodeURIComponent(myId)); }
  catch(e){ toast('Live signaling is not supported in this browser.', true); return; }
  es.onopen = function(){ updateConnStatus(); };
  es.onerror = function(){ setStatus('reconnecting to room…', 'dot-warn'); }; // EventSource retries automatically
  es.onmessage = function(ev){
    var m; try { m = JSON.parse(ev.data); } catch(e){ return; }
    if(!m || typeof m !== 'object') return;
    try {
      if(m.type === 'peers'){
        var list = m.peers || [];
        for(var i = 0; i < list.length; i++){ if(list[i] && list[i].id) addPeer(String(list[i].id), String(list[i].name || 'Guest')); }
      } else if(m.type === 'join' && m.peer && m.peer.id){
        addPeer(String(m.peer.id), String(m.peer.name || 'Guest'));
        toast('👋 ' + String(m.peer.name || 'Someone') + ' joined the call');
      } else if(m.type === 'leave'){
        removePeer(String(m.id || ''));
      } else if(m.type === 'signal'){
        onSignal(String(m.from || ''), m.data);
      }
    } catch(e){ /* one bad frame must never kill the call */ }
  };
}

// ----- Mesh peer connections (perfect negotiation; polite peer = lower id) -----
function addPeer(peerId, name){
  if(peerId === myId || peers[peerId]) return;
  if(typeof RTCPeerConnection === 'undefined'){ toast('WebRTC is not supported in this browser.', true); return; }
  var st = { name: name, makingOffer: false, ignoreOffer: false, polite: myId < peerId, stream: null, tile: null, video: null, restartTimer: null, pc: null };
  var pc;
  try { pc = new RTCPeerConnection({ iceServers: ICE_SERVERS }); }
  catch(e){ toast('Could not open a peer connection.', true); return; }
  st.pc = pc;
  peers[peerId] = st;

  pc.onnegotiationneeded = function(){
    st.makingOffer = true;
    pc.setLocalDescription().then(function(){
      sendSignal(peerId, { description: pc.localDescription });
      st.makingOffer = false;
    }).catch(function(){ st.makingOffer = false; });
  };
  pc.onicecandidate = function(ev){ if(ev.candidate) sendSignal(peerId, { candidate: ev.candidate }); };
  pc.ontrack = function(ev){
    if(ev.streams && ev.streams[0]) st.stream = ev.streams[0];
    attachTile(peerId);
  };
  pc.oniceconnectionstatechange = function(){
    var s = pc.iceConnectionState;
    if(s === 'connected' || s === 'completed'){
      if(st.restartTimer){ clearTimeout(st.restartTimer); st.restartTimer = null; }
    } else if(s === 'failed'){
      toast('Connection to ' + st.name + ' failed — restarting…', true);
      safeRestart(pc);
    } else if(s === 'disconnected'){
      // Auto-reconnect: give ICE a moment to recover on its own, then restart ICE.
      if(st.restartTimer) clearTimeout(st.restartTimer);
      st.restartTimer = setTimeout(function(){ if(pc.iceConnectionState === 'disconnected') safeRestart(pc); }, 4000);
    }
    updateConnStatus();
  };
  if(localStream){
    localStream.getTracks().forEach(function(t){ try { pc.addTrack(t, localStream); } catch(e){} });
  }
  updateWaiting(); updateConnStatus();
}
function safeRestart(pc){ try { pc.restartIce(); } catch(e){} }

function onSignal(from, data){
  if(!from || !data || typeof data !== 'object') return;
  var st = peers[from];
  if(!st || !st.pc) return;                    // stale/unknown peer — ignore defensively
  var pc = st.pc;
  if(data.description){
    var desc = data.description;
    var collision = desc.type === 'offer' && (st.makingOffer || pc.signalingState !== 'stable');
    st.ignoreOffer = !st.polite && collision;  // impolite peer rolls back on glare
    if(st.ignoreOffer) return;
    pc.setRemoteDescription(desc).then(function(){
      if(desc.type === 'offer'){
        return pc.setLocalDescription().then(function(){ sendSignal(from, { description: pc.localDescription }); });
      }
    }).catch(function(){ toast('Signaling error with ' + st.name, true); });
  } else if(data.candidate){
    pc.addIceCandidate(data.candidate).catch(function(err){
      if(!st.ignoreOffer && window.console && console.error) console.error('ICE candidate error', err);
    });
  }
}

// ----- Remote video tiles -----
function attachTile(peerId){
  var st = peers[peerId];
  if(!st || !st.stream) return;
  if(!st.tile){
    var grid = $('grid'); if(!grid) return;
    var tile = document.createElement('div'); tile.className = 'tile';
    var v = document.createElement('video');
    v.autoplay = true; v.playsInline = true; v.setAttribute('playsinline', '');
    var label = document.createElement('div'); label.className = 'tile-name';
    label.textContent = st.name;               // textContent only
    tile.appendChild(v); tile.appendChild(label);
    grid.appendChild(tile);
    st.tile = tile; st.video = v;
  }
  if(st.video && st.video.srcObject !== st.stream) st.video.srcObject = st.stream;
  updateWaiting();
}
function removePeer(peerId){
  var st = peers[peerId];
  if(!st) return;
  toast('👋 ' + st.name + ' left the call');
  if(st.restartTimer) clearTimeout(st.restartTimer);
  try { st.pc.close(); } catch(e){}
  if(st.tile && st.tile.parentNode) st.tile.parentNode.removeChild(st.tile);
  delete peers[peerId];
  updateWaiting(); updateConnStatus();
}

// ----- Controls -----
function cleanup(){
  try { if(es) es.close(); } catch(e){}
  Object.keys(peers).forEach(function(id){ try { peers[id].pc.close(); } catch(e){} });
  if(localStream) localStream.getTracks().forEach(function(t){ try { t.stop(); } catch(e){} });
}
function hangUp(){
  if(hungUp) return; hungUp = true;
  cleanup();
  setStatus('call ended', 'dot-off');
  window.location.href = BACK;               // back to the event / chat
}
function bindControls(){
  var bm = $('btnMic'), bc = $('btnCam'), bh = $('btnHang'), br = $('btnRetry'), ba = $('btnAudioOnly');
  if(bm) bm.addEventListener('click', function(){
    micOn = !micOn;
    if(localStream) localStream.getAudioTracks().forEach(function(t){ t.enabled = micOn; });
    bm.classList.toggle('ctl-off', !micOn);
    bm.setAttribute('aria-pressed', micOn ? 'false' : 'true');
  });
  if(bc) bc.addEventListener('click', function(){
    camOn = !camOn;
    if(localStream) localStream.getVideoTracks().forEach(function(t){ t.enabled = camOn; });
    bc.classList.toggle('ctl-off', !camOn);
    bc.setAttribute('aria-pressed', camOn ? 'false' : 'true');
  });
  if(bh) bh.addEventListener('click', hangUp);
  if(br) br.addEventListener('click', function(){ startMedia(audioOnly); });
  if(ba) ba.addEventListener('click', function(){ startMedia(true); });
  window.addEventListener('pagehide', cleanup);
}

// ----- Boot -----
bindControls();
updateWaiting();
startMedia(false);
})();</script>
</body></html>`;
}

// Call page (party-guarded): event rooms → participants/creator/admin; chat rooms → members/admin.
app.get('/call/:room', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.redirect('/login?err=' + encodeURIComponent('Please sign in.'));
  const room = resolveCallRoom(req.params.room, user);
  if (!room) return res.status(404).send(page('Not found', '<div class="card"><h2>Call not found</h2><p class="muted"><a href="/">Back to home</a></p></div>', user));
  if (!room.allowed) {
    audit('CALL AGENT', 'join call guard', 'fail', `Unauthorized call-room attempt on ${room.key} by ${user.isAdmin ? 'admin?' : user.name}`);
    return res.status(403).send(page('Forbidden', '<div class="card"><h2>403 — Private call</h2><p class="muted">Only the invited participants (and the admin) can join this call.</p></div>', user));
  }
  res.send(callPage(room, user));
});

// Per-room SSE signaling channel: presence (join/leave) + WebRTC offer/answer/ICE relay.
// Same shape as the chat stream (25s heartbeat, in-memory registry, guarded per room).
app.get('/call/:room/stream', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).send('sign-in required');
  const room = resolveCallRoom(req.params.room, user);
  if (!room || !room.allowed) {
    audit('CALL AGENT', 'stream guard', 'fail', `Blocked call stream on ${String(req.params.room).slice(0, 40)} for ${user.name}`);
    return res.status(403).send('forbidden');
  }
  let peerId = String(req.query.peer || '');
  if (!/^[a-zA-Z0-9_-]{4,48}$/.test(peerId)) peerId = crypto.randomBytes(8).toString('hex');
  let peers = callRooms.get(room.key);
  const wasEmpty = !peers || !peers.size;
  if (!peers) { peers = new Map(); callRooms.set(room.key, peers); }
  while (peers.has(peerId)) peerId = (peerId.slice(0, 40) + crypto.randomBytes(2).toString('hex'));
  const displayName = (user.name + (user.memberName ? ' · ' + user.memberName : '')).slice(0, 80);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');
  // Roster of already-connected peers for the newcomer (the newcomer initiates the mesh offers).
  const roster = [...peers].map(([pid, p]) => ({ id: pid, name: p.name }));
  res.write(`data: ${JSON.stringify({ type: 'peers', self: { id: peerId, name: displayName }, peers: roster })}\n\n`);
  peers.set(peerId, { res, name: displayName, owner: readSignedCookie(req, 'dz_session') || '' });
  callBroadcast(room.key, { type: 'join', peer: { id: peerId, name: displayName } }, peerId);
  audit('CALL AGENT', 'join call', 'pass', `${displayName} joined ${room.key} (${peers.size} in room)`);
  // The first peer in an empty room "starts" the call — announce it with a Join link.
  if (wasEmpty) {
    try { announceCallStart(room, user); } catch (e) { /* never break the call on announce failure */ }
    audit('CALL AGENT', 'call started', 'pass', `${displayName} started ${room.key} — participants notified`);
  }
  const heartbeat = setInterval(() => { try { res.write(':ping\n\n'); } catch (e) { /* closed */ } }, 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    const set = callRooms.get(room.key);
    if (set) { set.delete(peerId); if (!set.size) callRooms.delete(room.key); }
    callBroadcast(room.key, { type: 'leave', id: peerId, name: displayName });
    audit('CALL AGENT', 'leave call', 'pass', `${displayName} left ${room.key}`);
  });
});

// Signaling relay: JSON {to?, from, data} → targeted peer or broadcast to the room's other peers.
app.post('/call/:room/signal', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'auth' });
  const room = resolveCallRoom(req.params.room, user);
  if (!room || !room.allowed) return res.status(403).json({ ok: false, error: 'forbidden' });
  const peers = callRooms.get(room.key);
  if (!peers) return res.status(404).json({ ok: false, error: 'room-not-live' });
  const body = req.body || {};
  const to = body.to == null ? null : String(body.to);
  const data = body.data;
  // Sender is stamped server-side from the caller's session — the client-supplied "from" is NEVER trusted (anti-spoofing).
  const myToken = readSignedCookie(req, 'dz_session') || '';
  const mine = [...peers].find(([, p]) => p.owner === myToken);
  if (!mine) return res.status(400).json({ ok: false, error: 'unknown-sender' });
  const from = mine[0];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return res.status(400).json({ ok: false, error: 'bad-data' });
  let payload;
  try { payload = `data: ${JSON.stringify({ type: 'signal', from, data })}\n\n`; } catch (e) { return res.status(400).json({ ok: false, error: 'bad-data' }); }
  if (payload.length > CALL_MAX_SIGNAL_DATA) return res.status(413).json({ ok: false, error: 'too-large' });
  if (to) {
    const target = peers.get(to);
    if (target) { try { target.res.write(payload); } catch (e) { try { target.res.end(); } catch (_) {} peers.delete(to); } }
  } else {
    for (const [pid, p] of [...peers]) {
      if (pid === from) continue;
      try { p.res.write(payload); } catch (e) { try { p.res.end(); } catch (_) {} peers.delete(pid); }
    }
  }
  res.json({ ok: true });
});

// ============================= GLOBAL SHIPMENT TRACKING MAP (/tracking) =============================
/** Client script for the global tracking map: one pulsing marker per in-transit deal
 *  (gold = other companies, mint = mine), popups with route + status, fit-bounds. Defensive:
 *  missing Leaflet or empty marker data degrades to a themed fallback note, never an error. */
const TRACKING_MAP_SCRIPT = `<script>(function(){
  var el=document.getElementById('tracking-map');
  if(!el)return;
  function escH(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function fallback(msg){el.innerHTML='<div class="map-fallback">'+escH(msg)+'</div>';}
  if(typeof L==='undefined'){fallback('🗺️ Map unavailable — the mapping library could not be loaded (you may be offline).');return;}
  var deals=window.DZ_TRACKING_DEALS||[];
  if(!deals.length){fallback('No geocoded shipments in transit right now.');return;}
  try{
    var map=L.map(el,{scrollWheelZoom:true});
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18,attribution:'&copy; OpenStreetMap contributors'}).addTo(map);
    var bounds=[];
    deals.forEach(function(d){
      var lat=parseFloat(d.lat),lng=parseFloat(d.lng);
      if(!isFinite(lat)||!isFinite(lng))return;
      bounds.push([lat,lng]);
      var cls=d.mine?'dz-pulse dz-pulse-mint':'dz-pulse dz-pulse-gold';
      L.marker([lat,lng],{icon:L.divIcon({className:'dz-pulse-wrap',html:'<span class="'+cls+'"></span>',iconSize:[14,14],iconAnchor:[7,7]})}).addTo(map)
        .bindPopup('<b>Deal '+escH(d.num)+'</b> · '+escH(d.type)+'<br>📍 '+escH(d.origin)+' → '+escH(d.dest)+'<br>Status: '+escH(d.status)+'<br><a href="/deal/'+encodeURIComponent(d.id)+'">Open deal →</a>');
    });
    if(bounds.length>1)map.fitBounds(bounds,{padding:[40,40]});
    else if(bounds.length===1)map.setView(bounds[0],6);
    else fallback('No geocoded shipments in transit right now.');
  }catch(e){fallback('🗺️ Map could not be rendered here.');}
})();</script>`;

// Full-width tracking map: every in-transit (dispatched/shipped) CIF/FOB/CFR deal as a pulsing marker.
// Logged-in companies + admin. Coordinates are geocoded lazily; deal values are never shown.
app.get('/tracking', requireCompanyOrAdmin, async (req, res) => {
  let deals = [];
  try {
    // Commission gate: deals awaiting commission payment approval never appear on the tracking map
    // ('none' = legacy/not-yet-finalized deals keep existing behavior; 'paid' = unlocked).
    deals = db.prepare(`SELECT * FROM deals WHERE status IN ('dispatched','shipped') AND COALESCE(payment_status, 'none') != 'pending_payment' ORDER BY id DESC LIMIT 200`).all();
  } catch (e) { deals = []; }
  const markers = [];
  for (const d of deals) {
    try {
      const geo = await dealGeo(d);
      if (!validLatLng(geo.oLat, geo.oLng) || !validLatLng(geo.dLat, geo.dLng)) continue;
      const t = statusProgress(d);
      // "Mine" = my company's deal, my contracted purchase, or a deal I'm negotiating to buy
      // (same insider audience as canViewDealTerms — values are still never shown here).
      const mine = !req.user.isAdmin && (req.user.id === d.company_id || dealBuyerId(d) === req.user.id
        || !!db.prepare('SELECT 1 FROM negotiations WHERE deal_id = ? AND buyer_id = ? LIMIT 1').get(d.id, req.user.id));
      markers.push({
        id: d.id,
        num: d.deal_number || ('#' + d.id),
        type: DEAL_TYPES.includes(d.deal_type) ? d.deal_type : 'sell',
        origin: d.origin || 'Origin',
        dest: d.destination || 'Destination',
        status: d.status || 'open',
        lat: Math.round((geo.oLat + (geo.dLat - geo.oLat) * t) * 1e5) / 1e5,
        lng: Math.round((geo.oLng + (geo.dLng - geo.oLng) * t) * 1e5) / 1e5,
        mine: mine
      });
    } catch (e) { /* deals that fail to geocode are skipped from the map (still listed below) */ }
  }
  const strip = deals.length ? `<div class="track-strip">${deals.map((d, i) => `
    <div class="card track-card" data-reveal style="--i:${Math.min(i, 8)}">
      <h4><a href="/deal/${d.id}">${esc(d.deal_number || '#' + d.id)}</a> ${dealStatusChip(d)}</h4>
      <div class="muted" style="font-size:12px">${esc(d.title.slice(0, 60))}</div>
      <div style="font-size:12px;margin-top:4px">📍 ${esc(d.origin || '?')} → ${esc(d.destination || 'destination TBD')}</div>
    </div>`).join('')}</div>`
    : '<div class="card" data-reveal><p class="muted">No shipments in transit right now. CIF/FOB/CFR deals appear here once they reach <b>dispatched</b> or <b>shipped</b>.</p></div>';
  const mapHtml = markers.length
    ? `<div id="tracking-map" class="map-embed map-full" role="img" aria-label="Global shipment tracking map"></div>
       <script>window.DZ_TRACKING_DEALS=${jsJson(markers)};</script>
       ${TRACKING_MAP_SCRIPT}`
    : `<div class="card map-placeholder" data-reveal style="margin-top:14px"><h3>🗺️ Global tracking map</h3>
       <p class="muted" style="margin-top:8px">${deals.length ? 'Map activates once origin &amp; destination are geocoded for the in-transit deals.' : 'Map activates once CIF/FOB/CFR deals are dispatched or shipped.'}</p></div>`;
  const body = `
  <div class="card" data-reveal>
    <div class="kicker">Live logistics</div>
    <h2>🌍 Shipment tracking</h2>
    <p class="muted">Every in-transit CIF/FOB/CFR deal on the network — <span style="color:var(--mint)">mint</span> markers are your shipments,
      <span style="color:var(--gold)">gold</span> markers are other companies'. Deal values are never shown.</p>
  </div>
  ${strip}
  ${mapHtml}`;
  res.send(page('Shipment tracking', body, req.user, req.query.msg, req.query.err, 'globe', markers.length ? LEAFLET_HEAD : ''));
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
  const bankCfg = bankDetails() || {}; // Batch B — structured receiving bank details for the settings form
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
  // Payments tile: commission collected (approved confirmations) per currency + pending count.
  const collectedRows = db.prepare(`SELECT currency, SUM(amount) AS s FROM commission_payments WHERE status = 'approved' GROUP BY currency ORDER BY currency`).all();
  const collectedText = collectedRows.length ? collectedRows.map(r => `${esc(r.currency)} ${fmtAmount(r.s || 0)}`).join(' · ') : '—';
  const pendingPayCount = count(`SELECT COUNT(*) AS n FROM commission_payments WHERE status = 'pending'`);
  const statsHtml = `<div class="stats">${[
    ['Total companies', stats.companies, ''], ['Pending', stats.pending, ''], ['Approved', stats.approved, ' mint'],
    ['Flagged ⚠️', stats.flagged, ''], ['Deals', stats.deals, ' gold'], ['Contracts pending', stats.contractsPending, ' gold'],
    ['Follows', stats.follows, '']
  ].map(([l, n, cls], ti) => `<div class="stat card--cut js-tilt" data-reveal style="--i:${Math.min(ti, 8)}" data-num="${String(ti + 1).padStart(2, '0')}"><div class="num${cls}" data-count="${n}">${n}</div><div class="lbl">${l}</div></div>`).join('')}
    <div class="stat card--cut js-tilt" data-reveal style="--i:7" data-num="08"><div class="num gold" style="font-size:1.15rem;line-height:1.4">${commissionText}</div><div class="lbl">Platform commission (approved deals) · ${feePct}%</div></div>
    <div class="stat card--cut js-tilt" data-reveal style="--i:8" data-num="09"><div class="num gold" style="font-size:1.15rem;line-height:1.4">${collectedText}</div><div class="lbl">💰 Commission collected · ${pendingPayCount} payment${pendingPayCount === 1 ? '' : 's'} pending</div></div></div>`;

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
    const negMs = parseMilestoneJson(n.milestone_proposal);
    const msLine = negMs ? `<br><span class="muted">📊 ${esc(milestoneSummaryText(negMs))}</span>` : '';
    return `<tr>
      <td><b>${esc(deal ? deal.title : '(deal removed)')}</b> <span class="muted">№ ${esc(deal ? (deal.deal_number || String(n.deal_id)) : String(n.deal_id))} · neg #${n.id} · round ${n.round}</span></td>
      <td>${esc(names.get(n.seller_id) || '?')} ⇄ ${esc(names.get(n.buyer_id) || '?')}</td>
      <td><b>${esc(splitLabel)}</b><br><span class="muted">${amounts}</span>${msLine}</td>
      <td style="white-space:nowrap">
        <a class="btn btn-sm btn-outline" href="/negotiation/${n.id}">View</a>
        <form method="POST" action="/admin/negotiations/${n.id}/approve" style="display:inline"><button class="btn btn-sm btn-green">Approve</button></form>
        <form method="POST" action="/admin/negotiations/${n.id}/reject" style="display:inline"><button class="btn btn-sm btn-danger">Reject</button></form>
      </td>
    </tr>`;
  });
  const negsTableHtml = negRows.length ? negRows.join('') : '<tr><td colspan="4" class="muted">No negotiations awaiting final approval. Negotiations land here once both parties agree the commission split.</td></tr>';

  // 💰 Commission payments — pending party confirmations awaiting admin verification (bank transfer).
  const pendingPayments = db.prepare(`SELECT * FROM commission_payments WHERE status = 'pending' ORDER BY created_at ASC LIMIT 100`).all();
  const paymentRows = pendingPayments.map(p => {
    let ref;
    if (p.deal_id) {
      const d = db.prepare('SELECT title, deal_number FROM deals WHERE id = ?').get(p.deal_id);
      ref = d
        ? `<a href="/deal/${p.deal_id}"><b>${esc(d.title)}</b></a> <span class="muted">№ ${esc(d.deal_number || String(p.deal_id))}</span>`
        : `<span class="muted">(deal #${p.deal_id} removed)</span>`;
    } else {
      const pcRow = db.prepare('SELECT title FROM private_contracts WHERE id = ?').get(p.private_contract_id);
      ref = pcRow
        ? `<a href="/contracts/${p.private_contract_id}"><b>${esc(pcRow.title)}</b></a> <span class="badge badge-sealed">Private contract #${p.private_contract_id}</span>`
        : `<span class="muted">(private contract #${p.private_contract_id} removed)</span>`;
    }
    return `<tr>
      <td>${ref}</td>
      <td>${esc(names.get(p.company_id) || '?')}</td>
      <td><b>${fmtAmount(p.amount)} ${esc(p.currency)}</b></td>
      <td class="muted">${p.note ? esc(p.note) : '—'}</td>
      <td>${p.proof_media_id ? `<a class="btn btn-sm btn-outline" href="/payments/${p.id}/proof">📄 ${esc(p.proof_filename || 'receipt.pdf')}</a>` : '<span class="muted">— none</span>'}</td>
      <td class="muted" style="white-space:nowrap">${esc(p.created_at.slice(0, 16).replace('T', ' '))}</td>
      <td style="white-space:nowrap">
        <form method="POST" action="/admin/payments/${p.id}/approve" style="display:inline"><button class="btn btn-sm btn-green">Approve</button></form>
        <form method="POST" action="/admin/payments/${p.id}/reject" style="display:inline-flex;gap:4px;align-items:center">
          <input type="text" name="reason" maxlength="200" placeholder="Reason (optional)" style="max-width:150px;padding:4px 8px;font-size:12px">
          <button class="btn btn-sm btn-danger">Reject</button>
        </form>
      </td>
    </tr>`;
  });
  const paymentsTableHtml = paymentRows.length ? paymentRows.join('') : '<tr><td colspan="7" class="muted">No payment confirmations awaiting review. Parties confirm their bank transfers from the deal page.</td></tr>';

  // ⚠️ Open escrow disputes (Batch B) — party-flagged deals surface here for mediation.
  let openDisputes = [];
  try { openDisputes = db.prepare('SELECT id, title, deal_number, escrow_dispute_at FROM deals WHERE escrow_dispute_at IS NOT NULL ORDER BY escrow_dispute_at DESC LIMIT 20').all(); } catch (e) { openDisputes = []; }
  // 💸 Milestone payment release requests (raised when a deal's shipment status reaches an agreed milestone).
  let pendingReleases = [];
  try {
    pendingReleases = db.prepare(`SELECT r.*, d.title AS deal_title, d.deal_number, d.company_id, d.buyer_received_confirmed_at
      FROM milestone_releases r JOIN deals d ON d.id = r.deal_id
      WHERE r.status = 'pending_admin' ORDER BY r.created_at DESC LIMIT 30`).all();
  } catch (e) { pendingReleases = []; }
  const namesForReleases = companyNameMap();
  const releasesHtml = pendingReleases.length ? `<div class="card" data-reveal><h3>💸 Payment release requests</h3>
    <p class="muted" style="margin:0 0 10px">A deal's shipment status reached an agreed payment milestone. Approve the escrow release or deny it with a reason — both parties are notified either way.</p>
    <table><tr><th>Deal</th><th>Milestone</th><th>Amount (flow)</th><th>Triggered by</th><th>Receipt</th><th></th></tr>${pendingReleases.map(r => `<tr>
      <td><a href="/deal/${r.deal_id}"><b>${esc(r.deal_title)}</b></a><br><span class="muted">№ ${esc(r.deal_number || String(r.deal_id))}</span></td>
      <td><b>${esc(r.label)}</b> <span class="muted">(${r.pct}%)</span></td>
      <td>${r.amount ? `<b>${esc(fmtAmount(r.amount))} ${esc(r.currency)}</b>` : '<span class="muted">—</span>'}</td>
      <td class="muted">${esc(r.triggered_by || '—')}<br>${esc((r.created_at || '').slice(0, 16).replace('T', ' '))} UTC</td>
      <td>${r.buyer_received_confirmed_at ? '<span class="badge badge-contract">✅ confirmed</span>' : '<span class="muted">not yet</span>'}</td>
      <td style="white-space:nowrap">
        <form method="POST" action="/admin/milestones/${r.id}/approve" style="display:inline" onsubmit="return confirm('Approve this escrow release? Both parties are notified.')"><button class="btn btn-sm btn-green">Approve</button></form>
        <form method="POST" action="/admin/milestones/${r.id}/deny" style="display:inline-flex;gap:4px;margin-left:4px" onsubmit="return confirm('Deny this release? The note is shown to both parties.')"><input type="text" name="note" maxlength="200" placeholder="reason" required style="width:110px"><button class="btn btn-sm btn-danger">Deny</button></form>
      </td>
    </tr>`).join('')}</table></div>` : '';

  const disputesHtml = openDisputes.length ? `<div class="card" data-reveal><h3>⚠️ Open escrow disputes</h3>
    <table><tr><th>Deal</th><th>Raised (UTC)</th><th></th></tr>${openDisputes.map(d => `<tr>
      <td><b>${esc(d.title)}</b> <span class="muted">№ ${esc(d.deal_number || String(d.id))}</span></td>
      <td class="muted">${esc(d.escrow_dispute_at.slice(0, 16).replace('T', ' '))}</td>
      <td><a class="btn btn-sm btn-outline" href="/deal/${d.id}">Open deal</a></td>
    </tr>`).join('')}</table>
    <p class="muted" style="margin-top:8px">Disputes pause the escrow release design. Mediate with the parties, then resolve off-platform (flow preview).</p></div>` : '';

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
  <div class="card" data-reveal><h3>💰 Commission payments ${pendingPayCount ? `<span class="badge badge-sealed">${pendingPayCount} pending</span>` : ''}</h3>
    <p class="muted" style="margin-bottom:8px">Verify each bank transfer — open the receipt PDF first when one is attached — then approve. A deal's shipment tracking unlocks once every required share (per the agreed split) is approved.</p>
    <table><tr><th>Deal / contract</th><th>Company</th><th>Amount</th><th>Note</th><th>Proof</th><th>Date (UTC)</th><th>Actions</th></tr>${paymentsTableHtml}</table></div>
  ${releasesHtml}
  ${disputesHtml}
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
    </form>
    <hr class="sep">
    <h4 style="margin:0 0 8px">🏦 Dealzoin receiving bank details</h4>
    <p class="muted" style="margin:0 0 10px">Shown as an elegant copy-to-clipboard card on every commission payment card. The payment reference with the deal number is added automatically. Save all fields empty to fall back to the default note.</p>
    <form method="POST" action="/admin/settings/bank-details" style="max-width:560px">
      <div class="grid2" style="gap:10px">
        <div><label>Bank name</label><input type="text" name="bank_name" maxlength="120" value="${esc(bankCfg.bank_name || '')}" placeholder="e.g. First Emirates Bank"></div>
        <div><label>Account name</label><input type="text" name="bank_account" maxlength="120" value="${esc(bankCfg.bank_account || '')}" placeholder="e.g. Dealzoin Ltd"></div>
      </div>
      <div class="grid2" style="gap:10px">
        <div><label>IBAN</label><input type="text" name="bank_iban" maxlength="60" value="${esc(bankCfg.bank_iban || '')}" placeholder="e.g. AE07 0331 2345 6789 0123 456"></div>
        <div><label>SWIFT / BIC</label><input type="text" name="bank_swift" maxlength="20" value="${esc(bankCfg.bank_swift || '')}" placeholder="e.g. EBILAEAD"></div>
      </div>
      <div class="grid2" style="gap:10px">
        <div><label>Currency</label><select name="bank_currency">${optionsHtml([''].concat(DEAL_CURRENCIES), bankCfg.bank_currency || '')}</select></div>
        <div><label>Reference instructions</label><input type="text" name="bank_ref" maxlength="200" value="${esc(bankCfg.bank_ref || '')}" placeholder="e.g. Always quote the deal number"></div>
      </div>
      <label>Legacy free-text instructions (optional fallback, shown when the fields above are empty)</label>
      <textarea name="admin_bank_details" rows="3" maxlength="1000" placeholder="e.g. Dealzoin Ltd · IBAN DE00 1234 5678 9000 0000 00 · SWIFT DEUTDEFF · Reference: deal number">${esc((db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_bank_details') || {}).value || '')}</textarea>
      <button class="btn btn-sm" type="submit">Update bank details</button>
      <p class="muted" style="margin-top:8px">Changes are audit-logged. Parties copy each field with one click on the deal page.</p>
    </form></div>
  <div class="card" data-reveal><h3>🎨 Brand &amp; documents</h3>
    <p class="muted" style="margin:0 0 12px">This logo appears on the letterhead of every downloadable document — contracts, purchase orders, private contracts and the Terms &amp; Conditions. PNG or JPEG, max 1 MB.</p>
    <div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
      <div style="background:#F4EEE0;border:1px solid var(--line);border-radius:16px;padding:14px;line-height:0"><img src="${brandLogoDataUri()}" alt="Brand logo" style="width:76px;height:76px;border-radius:12px"></div>
      <form method="POST" action="/admin/settings/brand-logo" enctype="multipart/form-data" style="flex:1;min-width:240px">
        <label class="file-btn dropzone"><span class="file-btn-text" data-default="📎 Upload your logo (PNG/JPEG, max 1 MB)">📎 Upload your logo (PNG/JPEG, max 1 MB)</span>
          <input type="file" class="file-input" name="logo" accept="image/png,image/jpeg" required></label>
        <button class="btn btn-sm" type="submit" style="margin-top:8px">Save logo</button>
      </form>
      <form method="POST" action="/admin/settings/brand-logo/reset" onsubmit="return confirm('Reset to the default Dealzoin logo?')">
        <button class="btn btn-sm btn-outline" type="submit">Reset to default</button>
      </form>
    </div>
    <p class="muted" style="margin-top:10px">The letterhead keeps the beige-and-brown Dealzoin theme; only the logo mark changes. Audit-logged.</p>
  </div>
  <div class="card" data-reveal><h3>🤖 Agent activity (latest 50)</h3>
    <table><tr><th>Time (UTC)</th><th>Agent</th><th>Action</th><th>Result</th><th>Details</th></tr>${auditHtml}</table></div>`;
  res.send(page('Admin dashboard', body, req.user, req.query.msg, req.query.err));
});

// ----- Brand logo for documents: uploaded once, embedded in every .doc letterhead -----
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024, files: 1 } });
app.post('/admin/settings/brand-logo', requireAdmin, (req, res) => {
  logoUpload.single('logo')(req, res, (err) => {
    if (err) return res.redirect('/admin/dashboard?err=' + encodeURIComponent(err.code === 'LIMIT_FILE_SIZE' ? 'Logo too large — max 1 MB.' : 'Logo upload failed.'));
    const f = req.file;
    if (!f) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Choose a PNG or JPEG logo file.'));
    const buf = f.buffer;
    const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
    const isJpg = buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
    if (!isPng && !isJpg) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Logo must be a real PNG or JPEG image.'));
    const uri = `data:image/${isPng ? 'png' : 'jpeg'};base64,${buf.toString('base64')}`;
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('brand_logo', uri);
    audit('ADMIN', 'brand logo update', 'pass', 'Admin updated the document brand logo');
    res.redirect('/admin/dashboard?msg=' + encodeURIComponent('Brand logo updated — it now appears on all downloadable documents.'));
  });
});
app.post('/admin/settings/brand-logo/reset', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM settings WHERE key = ?').run('brand_logo');
  audit('ADMIN', 'brand logo reset', 'pass', 'Document brand logo reset to the default Dealzoin mark');
  res.redirect('/admin/dashboard?msg=' + encodeURIComponent('Logo reset to the default Dealzoin mark.'));
});

// ----- Milestone payment releases: the admin approves or denies each unlocked release -----
app.post('/admin/milestones/:id/approve', requireAdmin, (req, res) => {
  const rel = db.prepare('SELECT * FROM milestone_releases WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!rel) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Release request not found.'));
  if (rel.status !== 'pending_admin') return res.redirect('/admin/dashboard?err=' + encodeURIComponent('This release was already decided.'));
  const ts = now();
  db.prepare("UPDATE milestone_releases SET status = 'released', decided_at = ?, admin_note = '' WHERE id = ?").run(ts, rel.id);
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(rel.deal_id);
  const dealNum = deal ? (deal.deal_number || String(deal.id)) : String(rel.deal_id);
  const amt = rel.amount ? ` ≈ ${fmtAmount(rel.amount)} ${rel.currency}` : '';
  audit('PAYMENT AGENT', 'milestone release approved', 'pass', `Admin approved release of "${rel.label}" (${rel.pct}%${amt}) on deal ${dealNum}`);
  // Notify BOTH parties.
  const msg = `✅ Payment release approved: "${rel.label}" (${rel.pct}%${amt}) on deal ${dealNum}${deal ? ` ("${deal.title}")` : ''} — released from escrow (flow preview).`;
  if (deal) {
    notify(deal.company_id, 'milestone_release', msg, `/deal/${deal.id}`);
    const buyerId = dealBuyerId(deal);
    if (buyerId) notify(buyerId, 'milestone_release', msg, `/deal/${deal.id}`);
  }
  res.redirect('/admin/dashboard?msg=' + encodeURIComponent(`Release approved: ${rel.label} (${rel.pct}%).`));
});
app.post('/admin/milestones/:id/deny', requireAdmin, (req, res) => {
  const rel = db.prepare('SELECT * FROM milestone_releases WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!rel) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Release request not found.'));
  if (rel.status !== 'pending_admin') return res.redirect('/admin/dashboard?err=' + encodeURIComponent('This release was already decided.'));
  const note = String(req.body.note || '').trim().slice(0, 200);
  if (!note) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('A short reason is required when denying a release — the parties will see it.'));
  const ts = now();
  db.prepare("UPDATE milestone_releases SET status = 'denied', decided_at = ?, admin_note = ? WHERE id = ?").run(ts, note, rel.id);
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(rel.deal_id);
  const dealNum = deal ? (deal.deal_number || String(deal.id)) : String(rel.deal_id);
  const amt = rel.amount ? ` ≈ ${fmtAmount(rel.amount)} ${rel.currency}` : '';
  audit('PAYMENT AGENT', 'milestone release denied', 'fail', `Admin denied release of "${rel.label}" (${rel.pct}%${amt}) on deal ${dealNum} — ${note}`);
  const msg = `⛔ Payment release denied: "${rel.label}" (${rel.pct}%${amt}) on deal ${dealNum}${deal ? ` ("${deal.title}")` : ''} — reason: ${note}`;
  if (deal) {
    notify(deal.company_id, 'milestone_release', msg, `/deal/${deal.id}`);
    const buyerId = dealBuyerId(deal);
    if (buyerId) notify(buyerId, 'milestone_release', msg, `/deal/${deal.id}`);
  }
  res.redirect('/admin/dashboard?msg=' + encodeURIComponent(`Release denied: ${rel.label} — the parties were notified.`));
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
      db.prepare('DELETE FROM commission_payments WHERE deal_id = ?').run(d);
      try { db.prepare('DELETE FROM receiving_updates WHERE deal_id = ?').run(d); } catch (e) { /* table predates Batch B on legacy DBs */ }
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
    db.prepare('DELETE FROM commission_payments WHERE company_id = ?').run(id);
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
    <tr data-reveal style="--i:${Math.min(i, 8)}">
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
  // Batch C (3): full bank details + BANK RESEARCH AGENT verdict, admin-only, with override.
  const hasBank = c.bank_name || c.bank_swift || c.bank_iban || c.bank_country || c.bank_holder;
  const kycBadge = c.bank_kyc_status === 'verified' ? '<span class="badge badge-pass">verified ✓</span>'
    : c.bank_kyc_status === 'rejected' ? '<span class="badge badge-rejected">rejected</span>'
    : c.bank_kyc_status === 'warnings' ? '<span class="badge badge-sealed">warnings ⚠️</span>'
    : '<span class="badge">not provided</span>';
  const bankKycCard = `
  <div class="card" style="max-width:560px;margin:18px auto 0" data-reveal>
    <div class="kicker">🏦 BANK RESEARCH AGENT</div>
    <h3 style="margin:6px 0 8px">Bank details &amp; KYC — ${kycBadge}</h3>
    ${hasBank ? `<div class="bank-card">
      ${c.bank_name ? bankFieldRow('Bank name', c.bank_name) : ''}
      ${c.bank_swift ? bankFieldRow('SWIFT / BIC', c.bank_swift) : ''}
      ${c.bank_iban ? bankFieldRow('IBAN / account', c.bank_iban) : ''}
      ${c.bank_country ? bankFieldRow('Bank country', c.bank_country) : ''}
      ${c.bank_holder ? bankFieldRow('Account holder', c.bank_holder) : ''}
    </div>` : '<p class="muted">No bank details provided yet.</p>'}
    ${c.bank_kyc_notes ? `<p class="muted" style="margin-top:8px;white-space:pre-wrap">Agent notes: ${esc(c.bank_kyc_notes)}${c.bank_kyc_at ? ` · checked ${esc(c.bank_kyc_at.slice(0, 16).replace('T', ' '))} UTC` : ''}</p>` : ''}
    ${hasBank ? `<form method="POST" action="/admin/companies/${c.id}/bank-kyc" style="margin-top:10px">
      <label>Admin override</label>
      <div class="grid2" style="gap:10px">
        <select name="kyc_status">${optionsHtml(['verified', 'rejected'], c.bank_kyc_status === 'rejected' ? 'rejected' : 'verified')}</select>
        <input type="text" name="kyc_note" maxlength="300" placeholder="Override note (required)" required>
      </div>
      <button class="btn btn-sm" type="submit">Apply override</button>
    </form>` : ''}
    ${hasBank ? COPY_BTN_SCRIPT : ''}
  </div>`;
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
  </div>
  ${bankKycCard}`;
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

// ----- Batch C (3): admin bank-KYC override (pins the BANK RESEARCH AGENT verdict) -----
app.post('/admin/companies/:id/bank-kyc', requireAdmin, (req, res) => {
  const c = db.prepare('SELECT * FROM companies WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!c) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Company not found.'));
  const status = req.body.kyc_status === 'rejected' ? 'rejected' : 'verified';
  const note = String(req.body.kyc_note || '').trim().slice(0, 300);
  if (!note) return res.redirect(`/admin/companies/${c.id}/research?err=` + encodeURIComponent('An override note is required.'));
  db.prepare('UPDATE companies SET bank_kyc_status = ?, bank_kyc_notes = ?, bank_kyc_at = ? WHERE id = ?')
    .run(status, `Admin override → ${status}: ${note}`, now(), c.id);
  audit('BANK RESEARCH AGENT', 'bank KYC admin override', status === 'verified' ? 'pass' : 'fail',
    `Admin overrode bank KYC for "${c.name}" (#${c.id}) → ${status}: ${note.slice(0, 300)}`);
  res.redirect(`/admin/companies/${c.id}/research?msg=` + encodeURIComponent(`Bank KYC for ${c.name} set to ${status}.`));
});

// ----- Deal moderation -----
app.post('/admin/deals/:id/delete', requireAdmin, (req, res) => {  const d = db.prepare('SELECT * FROM deals WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!d) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Deal not found.'));
  const wipe = db.transaction(() => {
    db.prepare(`DELETE FROM likes WHERE target_type = 'deal' AND target_id = ?`).run(d.id);
    db.prepare(`DELETE FROM comments WHERE target_type = 'deal' AND target_id = ?`).run(d.id);
    db.prepare('DELETE FROM reposts WHERE deal_id = ?').run(d.id);
    db.prepare('DELETE FROM contracts WHERE deal_id = ?').run(d.id);
    db.prepare('DELETE FROM counter_offers WHERE deal_id = ?').run(d.id);
    db.prepare('DELETE FROM deal_documents WHERE deal_id = ?').run(d.id);
    db.prepare('DELETE FROM commission_payments WHERE deal_id = ?').run(d.id);
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
  const dealRow = db.prepare('SELECT title, value, currency FROM deals WHERE id = ?').get(ct.deal_id);
  const dealTitle = dealRow ? dealRow.title : 'deal #' + ct.deal_id;
  // Commission payment gate: freeze the fee (platform % × deal value) + default 50-50 split on the deal.
  const pct = platformFeePct();
  const cur = (dealRow && dealRow.currency) || 'USD';
  const valNum = parseDealValue(dealRow && dealRow.value);
  const fee = isFinite(valNum) && valNum > 0 ? Math.round(valNum * pct) / 100 : null; // pct/100 × value, 2dp
  db.prepare(`UPDATE deals SET contract_state = 'approved', contract_party = ?, contract_party_id = ?, status = 'closed',
              payment_status = 'pending_payment', payment_split = '50-50', payment_fee = ?, payment_currency = ? WHERE id = ?`)
    .run(party, ct.signer_company_id, fee, cur, ct.deal_id);
  // 2) Approved contracts are archived: the row is deleted; the deal carries the state.
  db.prepare('DELETE FROM contracts WHERE id = ?').run(ct.id);
  // TODO PHASE 3 — PAYMENT-ESCROW AGENT: when admin approves a contract, hook Stripe escrow initiation here (create escrow, notify both parties, release funds on delivery confirmation). Not implemented in this version.
  // NOTE: the manual-confirmation flow below (commission_payments + /admin/payments approve/reject) is the interim gate — it will be replaced by Stripe webhook auto-approval.
  audit('CONTRACT AGENT', 'admin approve contract', 'pass', `Contract #${ct.id} (deal #${ct.deal_id}) approved by admin — deal marked approved (party: ${party}); contract record archived (deleted)`);
  audit('PAYMENT AGENT', 'payment gate opened', 'pass', `Deal #${ct.deal_id} enters pending_payment — ${fee != null ? `${fmtAmount(fee)} ${cur}` : `${pct}% of deal value`} due (50 / 50 shared)`);
  // Both parties are notified when the deal is finalized.
  notify(ct.signer_company_id, 'contract_approved', `Final approval granted — your contract on "${dealTitle}" is finalized. Deal closed! 🎉`, `/deal/${ct.deal_id}`);
  notify(ct.owner_company_id, 'contract_approved', `Final approval granted — the contract with ${party} on "${dealTitle}" is finalized. Deal closed! 🎉`, `/deal/${ct.deal_id}`);
  const dueMsg = commissionDueMessage(fee != null ? `${fmtAmount(fee)} ${cur}` : `${pct}% of the deal value`, NEG_SPLITS['50-50'], 'Deal');
  notify(ct.signer_company_id, 'payment_due', dueMsg, `/deal/${ct.deal_id}`);
  notify(ct.owner_company_id, 'payment_due', dueMsg, `/deal/${ct.deal_id}`);
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
  // Commission payment gate: private contracts have no deal row (and no shipment tracking), so the
  // gate lives on the contract page — both parties owe half (50 / 50) and confirm from /contracts/:id.
  const pcb = pcPaymentBreakdown(pc);
  if (isFinite(pcb.fee) && pcb.fee > 0) {
    const dueMsg = commissionDueMessage(`${fmtAmount(pcb.fee)} ${pcb.cur}`, NEG_SPLITS['50-50'], 'Contract');
    notify(pc.sender_company_id, 'payment_due', dueMsg, `/contracts/${pc.id}`);
    notify(pc.recipient_company_id, 'payment_due', dueMsg, `/contracts/${pc.id}`);
    audit('PAYMENT AGENT', 'payment gate opened', 'pass', `Private contract #${pc.id} "${pc.title}" — ${fmtAmount(pcb.fee)} ${pcb.cur} due (50 / 50 shared)`);
  }
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

// ----- Platform settings: Dealzoin receiving bank details (structured fields + legacy free-text fallback) -----
app.post('/admin/settings/bank-details', requireAdmin, (req, res) => {
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const fields = {
    bank_name: String(req.body.bank_name || '').trim().slice(0, 120),
    bank_account: String(req.body.bank_account || '').trim().slice(0, 120),
    bank_iban: String(req.body.bank_iban || '').trim().slice(0, 60),
    bank_swift: String(req.body.bank_swift || '').trim().slice(0, 20),
    bank_currency: DEAL_CURRENCIES.includes(req.body.bank_currency) ? req.body.bank_currency : '',
    bank_ref: String(req.body.bank_ref || '').trim().slice(0, 200)
  };
  const legacy = String(req.body.admin_bank_details || '').trim().slice(0, 1000);
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(fields)) upsert.run(k, v);
    upsert.run('admin_bank_details', legacy);
  });
  tx();
  const structured = Object.values(fields).some(v => v);
  audit('ADMIN', 'bank details change', 'pass', structured
    ? `Receiving bank details updated (${fields.bank_name || '?'} · ${fields.bank_iban || 'no IBAN'} · ${fields.bank_currency || 'currency unset'})`
    : (legacy ? 'Commission payment bank details updated (legacy free-text)' : 'Commission payment bank details reset to default'));
  res.redirect('/admin/dashboard?msg=' + encodeURIComponent('Bank details updated — shown with one-click Copy buttons on all commission payment cards.'));
});

// ----- Commission payment review: approve a party's bank-transfer confirmation -----
app.post('/admin/payments/:id/approve', requireAdmin, (req, res) => {
  const p = db.prepare('SELECT * FROM commission_payments WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!p) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Payment confirmation not found.'));
  if (p.status !== 'pending') return res.redirect('/admin/dashboard?err=' + encodeURIComponent('This payment confirmation was already decided.'));
  db.prepare(`UPDATE commission_payments SET status = 'approved', decided_at = ? WHERE id = ?`).run(now(), p.id);
  const who = db.prepare('SELECT name FROM companies WHERE id = ?').get(p.company_id);
  const whoName = who ? who.name : 'company #' + p.company_id;
  const ref = p.deal_id ? `deal #${p.deal_id}` : `private contract #${p.private_contract_id}`;
  audit('PAYMENT AGENT', 'payment approved', 'pass', `Commission payment #${p.id} approved — ${whoName}, ${fmtAmount(p.amount)} ${p.currency} (${ref})`);
  let completed = false;
  if (p.deal_id) {
    completed = maybeCompleteDealPayment(p.deal_id);
    const deal = db.prepare('SELECT title, deal_number FROM deals WHERE id = ?').get(p.deal_id);
    notify(p.company_id, 'payment_approved', `Your commission payment of ${fmtAmount(p.amount)} ${p.currency} on "${deal ? deal.title : 'deal #' + p.deal_id}" was approved by the administrator.${completed ? ' Shipment tracking is now live 🚢' : ''}`, `/deal/${p.deal_id}`);
  } else {
    completed = maybeCompletePcPayment(p.private_contract_id);
    const pcRow = db.prepare('SELECT title FROM private_contracts WHERE id = ?').get(p.private_contract_id);
    notify(p.company_id, 'payment_approved', `Your commission payment of ${fmtAmount(p.amount)} ${p.currency} on private contract "${pcRow ? pcRow.title : '#' + p.private_contract_id}" was approved by the administrator.`, `/contracts/${p.private_contract_id}`);
  }
  res.redirect('/admin/dashboard?msg=' + encodeURIComponent(completed
    ? 'Payment approved — ALL required shares are now settled. Shipment tracking is live and both parties were notified.'
    : 'Payment approved. Waiting for the other party’s confirmation before tracking unlocks.'));
});

// ----- Commission payment review: reject a confirmation (optional reason, party may re-confirm) -----
app.post('/admin/payments/:id/reject', requireAdmin, (req, res) => {
  const p = db.prepare('SELECT * FROM commission_payments WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!p) return res.redirect('/admin/dashboard?err=' + encodeURIComponent('Payment confirmation not found.'));
  if (p.status !== 'pending') return res.redirect('/admin/dashboard?err=' + encodeURIComponent('This payment confirmation was already decided.'));
  const reason = String(req.body.reason || '').trim().slice(0, 200);
  db.prepare(`UPDATE commission_payments SET status = 'rejected', decided_at = ? WHERE id = ?`).run(now(), p.id);
  const who = db.prepare('SELECT name FROM companies WHERE id = ?').get(p.company_id);
  const whoName = who ? who.name : 'company #' + p.company_id;
  const ref = p.deal_id ? `deal #${p.deal_id}` : `private contract #${p.private_contract_id}`;
  audit('PAYMENT AGENT', 'payment rejected', 'fail', `Commission payment #${p.id} rejected — ${whoName}, ${fmtAmount(p.amount)} ${p.currency} (${ref})${reason ? ` — reason: ${reason}` : ''}`);
  const link = p.deal_id ? `/deal/${p.deal_id}` : `/contracts/${p.private_contract_id}`;
  notify(p.company_id, 'payment_rejected', `Your commission payment confirmation of ${fmtAmount(p.amount)} ${p.currency} was rejected by the administrator${reason ? `: ${reason}` : ''}. You can re-confirm once the transfer is made.`, link);
  res.redirect('/admin/dashboard?msg=' + encodeURIComponent('Payment confirmation rejected — the party was notified and may re-confirm.'));
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
  const msApproved = parseMilestoneJson(neg.milestone_proposal); // (5) frozen onto the deal at finalization
  const feeNote = isFinite(f.fee)
    ? ` Commission due before deal processing: ${fmtAmount(f.fee)} ${f.cur} (${splitLabel} — buyer ${fmtAmount(f.buyer)} ${f.cur}, seller ${fmtAmount(f.seller)} ${f.cur}).`
    : ` The ${f.pct}% platform commission (${splitLabel}) is due before deal processing.`;
  const finalize = db.transaction(() => {
    // 1) Mark the deal as approved, record the buyer on the deal, close the status pipeline.
    //    The commission payment gate opens here: payment_status flips 'none' → 'pending_payment'
    //    and the fee/split are frozen on the deal (later fee-pct changes never rewrite them).
    //    The agreed payment milestone schedule is frozen alongside (drives the escrow panel).
    db.prepare(`UPDATE deals SET contract_state = 'approved', contract_party = ?, contract_party_id = ?, status = 'closed',
                payment_status = 'pending_payment', payment_split = ?, payment_fee = ?, payment_currency = ?, payment_milestones = ? WHERE id = ?`)
      .run(buyerName, neg.buyer_id, f.split, isFinite(f.fee) ? Math.round(f.fee * 100) / 100 : null, f.cur, msApproved ? JSON.stringify(msApproved) : null, neg.deal_id);
    // 2) Archive the signature record (same pattern as the legacy contract queue).
    db.prepare('DELETE FROM contracts WHERE negotiation_id = ?').run(neg.id);
    // 3) Close the negotiation.
    db.prepare(`UPDATE negotiations SET state = 'DONE', updated_at = ? WHERE id = ?`).run(now(), neg.id);
  });
  finalize();
  negEvent(neg.id, null, 'admin_approved', { note: `Split: ${splitLabel}` });
  audit('CONTRACT AGENT', 'admin approve negotiation', 'pass', `Negotiation #${neg.id} (deal ${deal ? deal.deal_number || deal.id : neg.deal_id}) approved by admin — DONE. Split: ${splitLabel}.${isFinite(f.fee) ? ` Fee ${fmtAmount(f.fee)} ${f.cur} (buyer ${fmtAmount(f.buyer)}, seller ${fmtAmount(f.seller)}).` : ''} Commission payment gate opened.`);
  audit('PAYMENT AGENT', 'payment gate opened', 'pass', `Deal ${deal ? (deal.deal_number || '#' + deal.id) : '#' + neg.deal_id} enters pending_payment — ${isFinite(f.fee) ? `${fmtAmount(f.fee)} ${f.cur}` : `${f.pct}% of deal value`} due (${splitLabel})`);
  notify(neg.buyer_id, 'deal_closed', `Final approval granted — "${dealTitle}" is finalized. Deal closed! 🎉${feeNote}`, `/negotiation/${neg.id}`);
  notify(neg.seller_id, 'deal_closed', `Final approval granted — "${dealTitle}" is finalized. Deal closed! 🎉${feeNote}`, `/negotiation/${neg.id}`);
  const dueMsg = commissionDueMessage(isFinite(f.fee) ? `${fmtAmount(f.fee)} ${f.cur}` : `${f.pct}% of the deal value`, splitLabel, 'Deal');
  notify(neg.buyer_id, 'payment_due', dueMsg, `/deal/${neg.deal_id}`);
  notify(neg.seller_id, 'payment_due', dueMsg, `/deal/${neg.deal_id}`);
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

// ============================= ZO — 24/7 PLATFORM ASSISTANT =============================
/* "Zo" powers the floating chat widget. Fully self-contained (zero external dependencies,
 * zero API cost): a curated KNOWLEDGE base + lowercase token-overlap scoring with keyword
 * weights. Replies are server-authored plain text plus an optional links array
 * [{label, href}] — the widget renders everything with textContent/createElement, so user
 * text is never injected as HTML and the message is never reflected back.
 * Scopes: 'public' (answered for anyone, even logged-out landing visitors) ·
 * 'user' (company/sub-account sessions only) · 'admin' (admin sessions only). */

const ZO_MATCH_THRESHOLD = 3;  // minimum weighted score before Zo accepts an intent
const ZO_MAX_MESSAGE = 500;    // hard cap on the incoming question length
const ZO_STARTERS = ['How do I post a deal?', 'How does signing work?', 'What is the commission?'];
const zoAuditThrottle = new Map(); // session/IP key -> last audit ts (max 1 agent_audit row per minute)

/** Tiny live counters for account-aware answers — a handful of indexed COUNTs, computed lazily. */
function zoQuickStats(user) {
  const s = { openDeals: 0, pendingPayments: 0, contracts: 0, unreadChats: 0, unreadNotifs: 0 };
  if (!user || user.isAdmin) return s;
  try { s.openDeals = db.prepare(`SELECT COUNT(*) AS n FROM deals WHERE company_id = ? AND COALESCE(status, 'open') = 'open'`).get(user.id).n; } catch (e) { /* keep 0 */ }
  try { s.pendingPayments = db.prepare(`SELECT COUNT(*) AS n FROM deals WHERE company_id = ? AND payment_status = 'pending_payment'`).get(user.id).n; } catch (e) { /* keep 0 */ }
  try { s.contracts = db.prepare('SELECT COUNT(*) AS n FROM contracts WHERE signer_company_id = ? OR owner_company_id = ?').get(user.id, user.id).n; } catch (e) { /* keep 0 */ }
  try { s.unreadChats = totalUnread(user.id); } catch (e) { /* keep 0 */ }
  try { s.unreadNotifs = unreadNotifications(user.id); } catch (e) { /* keep 0 */ }
  return s;
}

const ZO_KNOWLEDGE = [
  // ----- General / platform (public scope: safe for logged-out visitors too) -----
  { id: 'greeting', scope: 'public',
    kw: [['hello', 3], ['hi', 2], ['hey', 2], ['good morning', 4], ['good afternoon', 4], ['good evening', 4], ['salaam', 3], ['salam', 3], ['greetings', 3], ['hola', 2]],
    reply: (c) => ({ text: `Hi${c.user && !c.user.isAdmin ? ' ' + c.user.name : ''}! I'm Zo, the Dealzoin assistant — online 24/7. Ask me about posting deals, the LOI pipeline, signing, commission, tracking… anything.`,
      links: [], sug: ZO_STARTERS }) },
  { id: 'who_are_you', scope: 'public',
    kw: [['who are you', 6], ['what are you', 4], ['zo', 2], ['assistant', 2], ['bot', 2], ['robot', 2], ['are you ai', 3]],
    reply: () => ({ text: "I'm Zo — Dealzoin's built-in platform guide. I run entirely on the platform's own knowledge base: no external services, no waiting, 24/7. I can explain any feature and point you to the right page.",
      links: [], sug: ['What is Dealzoin?', 'How do I register?', 'What can you help with?'] }) },
  { id: 'what_is_dealzoin', scope: 'public',
    kw: [['what is dealzoin', 8], ['dealzoin', 3], ['about', 2], ['what is this', 3], ['this platform', 3], ['b2b', 2]],
    reply: () => ({ text: 'Dealzoin is a closed B2B deal network for verified companies. Vetted companies post buy/sell opportunities, negotiate in private deal rooms (LOI → offer → PO → signing), and close with OTP-signed contracts — every step on the record and admin-verified.',
      links: [{ label: 'How it works', href: '/#why' }, { label: 'Register', href: '/signup' }], sug: ['How do I register?', 'What is the commission?'] }) },
  { id: 'register', scope: 'public',
    kw: [['register', 4], ['sign up', 5], ['signup', 5], ['join', 3], ['create account', 4], ['registration', 4], ['become a member', 3], ['open an account', 3], ['apply', 2]],
    reply: () => ({ text: 'Registering takes two steps:\n1) Start at the signup page — enter (or auto-parse) your company profile: name, business email, password and details.\n2) Add your company details + KYC documents (PDF), accept the five pledges and type your legal signature.\nThe Onboarding Agent and an admin then review your application — you can sign in as soon as you are approved.',
      links: [{ label: 'Register company', href: '/signup' }, { label: 'Sign in', href: '/login' }], sug: ['Which KYC documents do I need?', 'Why is my account pending?'] }) },
  { id: 'kyc_documents', scope: 'public',
    kw: [['kyc', 5], ['documents do i need', 5], ['which documents', 4], ['what documents', 4], ['moa', 4], ['bank statement', 3], ['required documents', 4], ['signed terms', 3]],
    reply: () => ({ text: 'For registration you need real PDF files (max 15 MB each):\n• MOA & authority document (required)\n• Bank account statement / proof of funds (required)\n• Company profile PDF and activity proof (optional, but they speed up approval).\nThe Terms & Conditions are accepted in the scroll-to-agree popup during registration — no download or signed upload needed. Every file is checked by the Document Authenticity Agent.',
      links: [{ label: 'Terms & Conditions', href: '/legal/terms' }, { label: 'Register', href: '/signup' }], sug: ['Why is my account pending?', 'How do I register?'] }) },
  { id: 'pending_approval', scope: 'public',
    kw: [['pending', 4], ['approval', 3], ['how long', 3], ['waiting', 2], ['approved yet', 3], ['not approved', 3], ['still pending', 4], ['when will', 2]],
    reply: () => ({ text: "New registrations stay 'pending' while the Onboarding Agent reviews your details and the Document Authenticity Agent checks your KYC PDFs — then an admin gives the final approval. You can sign in the moment you are approved. If it takes unusually long or a document was flagged, email the admin with your company name.",
      links: [{ label: 'Sign in', href: '/login' }], sug: ['Which KYC documents do I need?', 'How do I contact the admin?'] }) },
  { id: 'post_deal', scope: 'public',
    kw: [['post a deal', 6], ['create a deal', 6], ['new deal', 4], ['post deal', 5], ['sell', 2], ['buy', 2], ['listing', 2], ['publish', 3], ['how do i post', 5], ['buy vs sell', 5]],
    reply: () => ({ text: 'Open the create page (the + in the nav). Choose the deal type: SELL if you offer goods (a product-proof PDF is required) or BUY if you are looking to purchase. Fill in title, description, value & currency, category, origin/destination and the incoterm, attach a photo or video if you like, and publish — your deal gets its official number instantly.',
      links: [{ label: 'Create a deal', href: '/deals/new' }], sug: ['What are deal numbers?', 'What are incoterms?'] }) },
  { id: 'deal_numbers', scope: 'public',
    kw: [['deal number', 6], ['deal numbers', 6], ['numbering', 3], ['reference number', 3], ['dz', 2]],
    reply: () => ({ text: 'Every deal receives an official number the moment it is published: DZ-<year>-<sequence>, e.g. DZ-2025-0042. Use it in contracts, chats and support requests — it uniquely identifies the deal across the platform.',
      links: [], sug: ['How do I post a deal?'] }) },
  { id: 'loi_pipeline', scope: 'public',
    kw: [['loi', 5], ['letter of intent', 6], ['pipeline', 4], ['negotiation steps', 5], ['deal room', 3], ['how does a deal work', 5], ['process', 3], ['negotiation', 3], ['negotiate', 3]],
    reply: () => ({ text: 'Deal rooms follow a fixed pipeline:\n1) LOI — the buyer sends a Letter of Intent from the deal page.\n2) Offer / counter-offers — both sides negotiate value & terms.\n3) Buyer approval → PO — the buyer issues a Purchase Order.\n4) Signing — both parties sign with an OTP code.\n5) Owner approval → commission split → admin final approval → DONE.\nYou can follow every step on the negotiation page.',
      links: [{ label: 'Deals inbox', href: '/deals/inbox' }, { label: 'Explore deals', href: '/explore' }], sug: ['How do counter offers work?', 'How does signing work?'] }) },
  { id: 'counter_offers', scope: 'public',
    kw: [['counter offer', 6], ['counter-offer', 6], ['counteroffer', 6], ['counter', 3], ['negotiate price', 4], ['new price', 3], ['make an offer', 4]],
    reply: () => ({ text: 'On a deal page (or inside a negotiation) you can send a counter offer with a new value, currency and terms. The offer is confirmed with an OTP code, and the other party can accept or refuse it — every round is recorded on the deal timeline.',
      links: [{ label: 'Explore deals', href: '/explore' }], sug: ['What is the LOI pipeline?', 'How does signing work?'] }) },
  { id: 'purchase_order', scope: 'public',
    kw: [['purchase order', 6], ['po', 3], ['send po', 5]],
    reply: () => ({ text: 'Once the buyer approves the negotiated terms, they issue a Purchase Order from the negotiation room. The PO is downloadable as a .doc document, and sending it moves the deal into the signing stage.',
      links: [], sug: ['What is the LOI pipeline?', 'How does signing work?'] }) },
  { id: 'signing_otp', scope: 'public',
    kw: [['sign', 4], ['signing', 5], ['signature', 4], ['otp', 5], ['sign a contract', 6], ['sign the contract', 6], ['sign contract', 5], ['6-digit', 3]],
    reply: () => ({ text: 'Contracts are signed inside the deal room after the LOI → offer → PO stages. When it is your turn, open the signing page, review the contract, and confirm with the 6-digit OTP code sent to your business email (valid 10 minutes). Both parties sign, the owner approves, then an admin gives the final approval. Every signature is timestamped and auditable.',
      links: [{ label: 'Contracts', href: '/contracts' }, { label: 'Deals inbox', href: '/deals/inbox' }], sug: ['What is the LOI pipeline?', 'What is the commission?'] }) },
  { id: 'commission', scope: 'public',
    kw: [['commission', 6], ['fee', 3], ['platform fee', 6], ['percent', 3], ['percentage', 3], ['how much', 2], ['payment gate', 5], ['bank details', 4], ['bank transfer', 4], ['pay the commission', 5]],
    reply: (c) => ({ text: `Dealzoin charges a ${c.pct}% platform commission on finalized deals (the admin can adjust it — right now it is ${c.pct}%). By default it is split 50/50 between buyer and seller, but the parties can agree the buyer or seller pays 100%. Payment is by bank transfer to the admin's account details, shown on the deal's payment card. Once the admin approves the payment, shipment tracking unlocks. The fee is frozen at final-approval time, so later changes never rewrite a closed deal.`,
      links: [{ label: 'Tracking', href: '/tracking' }], sug: ['How does tracking work?', 'What are incoterms?'] }) },
  { id: 'tracking', scope: 'public',
    kw: [['tracking', 5], ['track', 3], ['shipment', 5], ['shipping', 4], ['vessel', 3], ['cargo', 3], ['map', 3], ['where is my', 3]],
    reply: () => ({ text: 'The Tracking page shows live shipment maps for your finalized deals once the commission payment is approved (the payment gate). Each deal page also has its own shipment tracking map with origin → destination. All incoterms (CIF/FOB/CFR) are tracked on-platform.',
      links: [{ label: 'Shipment tracking', href: '/tracking' }], sug: ['What are incoterms?', 'What is the commission?'] }) },
  { id: 'incoterms', scope: 'public',
    kw: [['incoterm', 6], ['incoterms', 6], ['cif', 4], ['fob', 4], ['cfr', 4], ['freight', 3], ['insurance', 2]],
    reply: () => ({ text: 'Deals use three incoterms, all with platform tracking:\n• CIF — Cost, Insurance & Freight: the seller pays shipping and insurance to the destination port.\n• FOB — Free on Board: the seller delivers on board at the origin port; the buyer takes over from there.\n• CFR — Cost & Freight: the seller pays freight to the destination port; insurance is on the buyer.\nYou pick the incoterm when posting the deal, and the seller confirms or changes it on each private offer.',
      links: [{ label: 'Create a deal', href: '/deals/new' }], sug: ['How does tracking work?', 'How do I post a deal?'] }) },
  { id: 'follow', scope: 'public',
    kw: [['follow', 4], ['unfollow', 4], ['followers', 3], ['following', 3]],
    reply: () => ({ text: 'Open any company profile and hit Follow — their new deals and posts then appear in your timeline, and following companies in a category also improves your Explorer recommendations. You can unfollow any time from the same button.',
      links: [{ label: 'Browse companies', href: '/companies' }], sug: ['Timeline vs Explorer?'] }) },
  { id: 'timeline_explorer', scope: 'public',
    kw: [['timeline', 4], ['explorer', 4], ['explore', 4], ['feed', 3], ['difference', 3]],
    reply: () => ({ text: 'The Timeline is your home feed: posts and deals from you and the companies you follow. The Explorer scans ALL open deals on the network and ranks them for you — by the categories you follow and engage with, trending activity, and reputation. Use the timeline to keep up, the explorer to discover.',
      links: [{ label: 'Timeline', href: '/timeline' }, { label: 'Explorer', href: '/explore' }], sug: ['How do I follow companies?'] }) },
  { id: 'search', scope: 'public',
    kw: [['search', 4], ['filter', 4], ['filters', 4], ['find', 2], ['category', 3], ['categories', 3], ['look for', 2]],
    reply: () => ({ text: 'Use the Search page (magnifier in the nav) to find deals, posts and companies — combine keywords with filters like category and deal type. Deals carry categories, so filtering by category is the fastest way to narrow the floor.',
      links: [{ label: 'Search', href: '/search' }], sug: ['Timeline vs Explorer?'] }) },
  { id: 'chats', scope: 'public',
    kw: [['chat', 4], ['chats', 4], ['message', 3], ['messages', 3], ['group chat', 5], ['conversation', 3], ['dm', 2]],
    reply: () => ({ text: 'Chats live under the speech-bubble icon: private 1-to-1 conversations and group chats with several companies, streaming live without refresh. Start a private chat from a company profile, or create a group from the Chats page. The nav badge shows your total unread messages.',
      links: [{ label: 'Open chats', href: '/chats' }], sug: ['What are private contracts?', 'What are my messages?'] }) },
  { id: 'private_contracts', scope: 'public',
    kw: [['private contract', 6], ['private contracts', 6], ['mailbox', 4], ['contracts inbox', 4], ['send a contract', 5]],
    reply: () => ({ text: 'The Contracts mailbox lets you send a private contract directly to another company — title, value and terms. The recipient signs (or declines), you approve, and an admin gives the final approval. Received contracts awaiting your action show a badge on the Contracts nav icon, and every contract is downloadable.',
      links: [{ label: 'Contracts mailbox', href: '/contracts' }, { label: 'New private contract', href: '/contracts/new' }], sug: ['How does signing work?'] }) },
  { id: 'notifications', scope: 'public',
    kw: [['notification', 4], ['notifications', 4], ['bell', 3], ['alert', 3], ['alerts', 3]],
    reply: () => ({ text: 'The bell icon collects everything that needs your attention: counter offers, LOIs, signing requests, payment updates, document requests and admin decisions. The badge counts unread items — open the page and they mark themselves read.',
      links: [{ label: 'Notifications', href: '/notifications' }], sug: ['What are my notifications?'] }) },
  { id: 'sub_accounts', scope: 'public',
    kw: [['sub-account', 6], ['sub account', 6], ['sub-accounts', 6], ['team member', 5], ['team members', 5], ['staff', 3], ['add user', 3], ['colleague', 3]],
    reply: () => ({ text: 'From your Profile page you can add team members (sub-accounts) with their own name, email, password and role. They sign in with their own credentials + 2FA code and act on behalf of your company — their actions are attributed to them. You can deactivate a member at any time.',
      links: [{ label: 'Profile', href: '/profile' }], sug: ['How do I edit my profile?'] }) },
  { id: 'video_calls', scope: 'public',
    kw: [['video call', 7], ['video calls', 7], ['video meeting', 7], ['how do i call', 7], ['start a call', 7], ['join call', 6], ['join the call', 6], ['call a company', 6], ['call button', 5], ['online call', 6], ['camera', 4], ['microphone', 4], ['webcam', 4], ['webrtc', 5], ['make a call', 6], ['conference call', 6]],
    reply: () => ({ text: 'Video calls run natively inside Dealzoin — no external provider, nothing to install. Open any chat and tap the 📹 Call button in the header, or hit "🎥 Join call" on a calendar event: you enter a private full-screen call room. The browser asks for camera & microphone permission — press Allow, or continue audio-only. You can mute 🎙️, toggle the camera 🎥 and hang up 🔴 from the control bar. Rooms are limited to the invited participants (plus the admin), connect peer-to-peer (comfortable up to ~6 people), and need HTTPS — on http://localhost they work by browser exception.',
      links: [{ label: 'Open chats', href: '/chats' }, { label: 'Calendar', href: '/calendar' }], sug: ['How do I schedule a meeting?', 'How do group chats work?'] }) },
  { id: 'calendar', scope: 'public',
    kw: [['calendar', 5], ['meeting', 4], ['meetings', 4], ['schedule', 3], ['event', 3], ['appointment', 4], ['call', 2]],
    reply: () => ({ text: 'The Calendar lets you schedule meetings and signing events with other companies. Signing events can be linked to a deal, and participants get a Join call button at meeting time — video calls run in a private in-platform room (native WebRTC, no external provider). Month navigation and the upcoming-events list keep everything in view.',
      links: [{ label: 'Calendar', href: '/calendar' }], sug: ['How do video calls work?', 'How does signing work?'] }) },
  { id: 'profile', scope: 'public',
    kw: [['profile', 4], ['avatar', 5], ['bio', 4], ['header image', 4], ['edit profile', 5], ['logo', 3]],
    reply: () => ({ text: 'Your Profile page is your company identity: upload an avatar and a header image (JPG/PNG/GIF/WEBP), edit your company info and bio, manage team sub-accounts, and see your reputation stars. Profiles are visible to other approved companies.',
      links: [{ label: 'My profile', href: '/profile' }], sug: ['What are reputation stars?', 'What are sub-accounts?'] }) },
  { id: 'reputation', scope: 'public',
    kw: [['reputation', 5], ['stars', 4], ['rating', 4], ['trust', 3], ['score', 2]],
    reply: () => ({ text: 'Each company has a 0–5 star reputation, shown on profiles and deal cards. Stars are curated by the platform admin based on verified activity — authentic documents, completed deals and clean conduct push it up. Reputation also feeds the Explorer ranking.',
      links: [], sug: ['How do I edit my profile?'] }) },
  { id: 'documents_request', scope: 'public',
    kw: [['request documents', 6], ['deal documents', 5], ['ask for documents', 5], ['document request', 5], ['request docs', 5]],
    reply: () => ({ text: 'On a deal page you can formally request documents from the other party (certificates, proof of product, etc.). They get a notification and upload PDFs straight to the deal — the files stay private to the two parties and the admin.',
      links: [], sug: ['What is the LOI pipeline?'] }) },
  { id: 'theme', scope: 'public',
    kw: [['dark', 3], ['light', 3], ['theme', 5], ['dark mode', 5], ['light mode', 5], ['night mode', 4], ['colors', 2], ['colours', 2]],
    reply: () => ({ text: 'Tap the moon/sun button in the top nav to switch between the dark navy theme and the warm-paper light theme. Your choice is remembered on this device.',
      links: [], sug: ['What can you help with?'] }) },
  { id: 'media_uploads', scope: 'public',
    kw: [['upload', 4], ['photo', 3], ['video', 3], ['image', 3], ['picture', 3], ['media', 3], ['attachment', 3], ['file', 2]],
    reply: () => ({ text: 'Posts and deals support images (JPG, PNG, GIF, WEBP — max 5 MB) and videos (MP4, WEBM — max 25 MB) via the styled attach button. Every file is magic-byte checked, so renamed files are rejected. Documents (KYC, deal docs, product proof) are PDF-only.',
      links: [], sug: ['How do I post a deal?'] }) },
  { id: 'login_problems', scope: 'public',
    kw: [['password', 4], ['forgot', 4], ['cant log in', 5], ["can't log in", 5], ['cannot log in', 5], ['login problem', 5], ['log in problem', 5], ['locked out', 4], ['cant sign in', 5], ["can't sign in", 5], ['code not working', 4], ['wrong password', 4], ['reset password', 4]],
    reply: () => ({ text: 'Sign-in is two-step: password first, then a 6-digit code valid for 10 minutes. If the code expired, sign in again for a fresh one, and check spam for the email. Pending, rejected or suspended companies cannot sign in until the admin acts. If you forgot your password or are locked out, email the admin to reset it.',
      links: [{ label: 'Sign in', href: '/login' }], sug: ['How do I contact the admin?', 'Why is my account pending?'] }) },
  { id: 'contact_admin', scope: 'public',
    kw: [['contact', 4], ['support', 4], ['help desk', 4], ['human', 3], ['real person', 3], ['email admin', 5], ['admin email', 5], ['reach admin', 4], ['talk to admin', 4], ['contact admin', 6]],
    reply: () => ({ text: `You can reach the platform administrator at ${ADMIN_EMAIL}. For account issues, include your company name and registered email; for deal issues, include the deal number (DZ-…).`,
      links: [], sug: ['I have a login problem', 'Why is my account pending?'] }) },
  { id: 'thanks', scope: 'public',
    kw: [['thanks', 4], ['thank you', 5], ['thx', 3], ['great', 2], ['awesome', 2], ['bye', 3], ['goodbye', 3], ['perfect', 2]],
    reply: () => ({ text: "Anytime! I'm here 24/7 whenever you need a hand with the platform. Good luck with your deals 🤝",
      links: [], sug: ZO_STARTERS }) },
  { id: 'help', scope: 'public',
    kw: [['help', 4], ['what can you do', 5], ['options', 3], ['topics', 3], ['assist', 3], ['guide', 2]],
    reply: () => ({ text: 'I can explain: registration & KYC, posting buy/sell deals, the LOI → PO → signing pipeline, counter offers, commission & the payment gate, shipment tracking & incoterms, chats, private contracts, notifications, calendar & video calls, sub-accounts, reputation, themes and uploads. Just ask in plain words!',
      links: [], sug: ZO_STARTERS }) },
  { id: 'account_needed', scope: 'public', // logged-out visitor asks an account-specific question
    kw: [['my deals', 6], ['my payments', 6], ['my payment', 6], ['my contracts', 6], ['my messages', 6], ['my notifications', 6], ['my account', 5], ['my commission', 6], ['do i owe', 5], ['my unread', 5]],
    reply: (c) => (c.user ? null : { text: "That's account-specific — please sign in and ask me again, and I'll pull up your live numbers.",
      links: [{ label: 'Sign in', href: '/login' }, { label: 'Register', href: '/signup' }], sug: ['How do I register?', 'I have a login problem'] }) },

  // ----- Account-aware (company + sub-account sessions) -----
  { id: 'my_deals', scope: 'user', stats: true,
    kw: [['my deals', 7], ['my open deals', 7], ['how many deals', 6], ['my listings', 5], ['my posts', 5]],
    reply: (c) => ({ text: `You currently have ${c.stats.openDeals} open deal${c.stats.openDeals === 1 ? '' : 's'} on the floor${c.stats.pendingPayments ? `, and ${c.stats.pendingPayments} deal${c.stats.pendingPayments === 1 ? ' is' : 's are'} waiting in the commission-payment gate` : ''}. Your Dashboard has the full picture.`,
      links: [{ label: 'Dashboard', href: '/dashboard' }, { label: 'Create a deal', href: '/deals/new' }], sug: ['What are my payments?', 'How do I post a deal?'] }) },
  { id: 'my_payments', scope: 'user', stats: true,
    kw: [['my payments', 7], ['my payment', 7], ['do i owe', 7], ['payment status', 6], ['my commission', 7], ['owe', 3], ['my fees', 6]],
    reply: (c) => ({ text: c.stats.pendingPayments
        ? `You have ${c.stats.pendingPayments} finalized deal${c.stats.pendingPayments === 1 ? '' : 's'} in the commission-payment gate. Pay your share of the ${c.pct}% platform fee by bank transfer to the admin details shown on the deal card — shipment tracking unlocks once the admin approves.`
        : `Nothing is waiting on you right now — no deals in the commission-payment gate. When a deal closes, the ${c.pct}% platform fee (split as agreed) is paid by bank transfer, and tracking unlocks after admin approval.`,
      links: [{ label: 'Tracking', href: '/tracking' }], sug: ['What is the commission?', 'What are my deals?'] }) },
  { id: 'my_messages', scope: 'user', stats: true,
    kw: [['my messages', 7], ['unread messages', 6], ['my chats', 7], ['new messages', 5], ['any messages', 5]],
    reply: (c) => ({ text: c.stats.unreadChats
        ? `You have ${c.stats.unreadChats} unread message${c.stats.unreadChats === 1 ? '' : 's'} across your chats.`
        : 'Your chats are all caught up — no unread messages.',
      links: [{ label: 'Open chats', href: '/chats' }], sug: ['How do group chats work?'] }) },
  { id: 'my_notifications', scope: 'user', stats: true,
    kw: [['my notifications', 7], ['unread notifications', 6], ['any notifications', 5], ['what is new', 4], ['whats new', 4], ['anything new', 5]],
    reply: (c) => ({ text: c.stats.unreadNotifs
        ? `You have ${c.stats.unreadNotifs} unread notification${c.stats.unreadNotifs === 1 ? '' : 's'} — the bell page has the details.`
        : 'No unread notifications right now — the bell page is all caught up.',
      links: [{ label: 'Notifications', href: '/notifications' }], sug: ['What are my messages?'] }) },
  { id: 'my_contracts', scope: 'user', stats: true,
    kw: [['my contracts', 7], ['my mailbox', 6], ['contracts waiting', 5], ['pending contracts', 5]],
    reply: (c) => ({ text: `You are involved in ${c.stats.contracts} contract${c.stats.contracts === 1 ? '' : 's'} (deal-room signatures and private contracts). The mailbox shows what needs your signature or approval.`,
      links: [{ label: 'Contracts mailbox', href: '/contracts' }], sug: ['How does signing work?'] }) },

  // ----- Admin-only (never answered to companies/members/visitors) -----
  { id: 'admin_approvals', scope: 'admin',
    kw: [['approve companies', 6], ['approve a company', 6], ['company approvals', 6], ['pending companies', 6], ['approve company', 6], ['approvals', 5], ['reject company', 5], ['suspend company', 5], ['reactivate', 4]],
    reply: () => ({ text: 'The admin dashboard lists pending companies with their details, onboarding-agent flags and KYC documents. Review the documents, then Approve or Reject — approved companies can sign in immediately, rejected ones are blocked. You can also suspend or reactivate companies from the same place.',
      links: [{ label: 'Admin dashboard', href: '/admin/dashboard' }], sug: ['How do I check document authenticity?', 'How do I research a company?'] }) },
  { id: 'admin_documents', scope: 'admin',
    kw: [['document authenticity', 7], ['check documents', 6], ['authenticity', 6], ['verify documents', 6], ['document agent', 5]],
    reply: () => ({ text: "The Documents page lists every uploaded KYC file with the Document Authenticity Agent's verdict (pass / flag / fail). You can download each PDF for manual review — flagged documents should be checked before approving the company.",
      links: [{ label: 'Documents', href: '/admin/documents' }], sug: ['How do I approve companies?'] }) },
  { id: 'admin_payments', scope: 'admin',
    kw: [['approve payments', 7], ['approve payment', 7], ['payments', 5], ['payment approval', 6], ['commission payment', 6], ['commission payments', 6], ['mark paid', 5]],
    reply: () => ({ text: 'Commission payments appear in the Payments section of the admin dashboard once a company confirms its bank transfer. Verify the transfer arrived (against your bank details in Settings), then Approve — shipment tracking unlocks for both parties instantly. Rejecting sends the deal back to awaiting payment.',
      links: [{ label: 'Admin dashboard', href: '/admin/dashboard' }], sug: ['How do I set the commission?', 'How do I set bank details?'] }) },
  { id: 'admin_commission', scope: 'admin',
    kw: [['set commission', 7], ['change commission', 7], ['commission setting', 7], ['set the commission', 7], ['fee setting', 6], ['change the fee', 6], ['adjust commission', 6]],
    reply: (c) => ({ text: `Set the platform commission in the Settings card on the admin dashboard — it is currently ${c.pct}% (allowed range 0.1–20). The new rate applies to deals finalized afterwards; already-finalized deals keep the fee frozen at their approval time.`,
      links: [{ label: 'Admin dashboard', href: '/admin/dashboard' }], sug: ['How do I approve payments?'] }) },
  { id: 'admin_bank', scope: 'admin',
    kw: [['set bank details', 7], ['bank account', 5], ['bank transfer details', 6], ['update bank', 5]],
    reply: () => ({ text: 'Your bank-transfer details (shown to companies on commission payment cards) are edited in the Settings card on the admin dashboard, right next to the commission setting.',
      links: [{ label: 'Admin dashboard', href: '/admin/dashboard' }], sug: ['How do I approve payments?'] }) },
  { id: 'admin_research', scope: 'admin',
    kw: [['research agent', 7], ['research company', 6], ['research a company', 7], ['research', 4], ['intel', 4], ['background check', 5]],
    reply: () => ({ text: "The Research Agent runs open-source intel on a company from its admin profile page — it gathers web-presence signals and writes a summary to support your approval decisions. Run it before approving companies you're unsure about.",
      links: [{ label: 'Admin dashboard', href: '/admin/dashboard' }], sug: ['How do I approve companies?'] }) },
  { id: 'admin_deletion', scope: 'admin',
    kw: [['delete company', 7], ['delete a company', 7], ['deletion', 5], ['remove company', 6], ['remove a company', 6], ['delete account', 5]],
    reply: () => ({ text: 'Company deletion is a protected multi-step flow from the company admin page: review the impact summary, confirm with the OTP code, then execute — the company and its data are removed and the action is audit-logged. It cannot be undone.',
      links: [{ label: 'Admin dashboard', href: '/admin/dashboard' }], sug: ['How do I approve companies?'] }) }
];

/** Normalize for matching: lowercase, drop apostrophes ("can't" -> "cant"), keep % and -. */
function zoClean(s) {
  return String(s).toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9%\s-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Score every in-scope intent against the message; best-first list of [score, intent]. */
function zoMatch(message, user) {
  const cleaned = zoClean(message);
  const msg = ' ' + cleaned + ' ';
  const tokens = new Set(cleaned.split(' ').filter(Boolean));
  const inScope = (it) => it.scope === 'public'
    || (it.scope === 'user' && user && !user.isAdmin)
    || (it.scope === 'admin' && user && user.isAdmin);
  const scored = [];
  for (const it of ZO_KNOWLEDGE) {
    if (!inScope(it)) continue;
    let score = 0;
    for (const [rawKw, w] of it.kw) {
      const kw = zoClean(rawKw);
      if (!kw) continue;
      if (kw.indexOf(' ') !== -1) { if (msg.indexOf(' ' + kw + ' ') !== -1) score += w; }
      else if (tokens.has(kw)) score += w;
    }
    if (score >= ZO_MATCH_THRESHOLD) scored.push([score, it]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored;
}

/** Zo endpoint: JSON {message} -> {reply, links, suggestions}. Public mode when logged out. */
app.post('/assistant/ask', (req, res) => {
  const user = currentUser(req); // null = public mode (landing-page visitors)
  const message = String((req.body && req.body.message) || '').replace(/\s+/g, ' ').trim().slice(0, ZO_MAX_MESSAGE);
  res.setHeader('Cache-Control', 'no-store');

  const ctx = { user, pct: platformFeePct(), stats: null };
  const answer = (payload, intentId) => {
    // Throttled audit: max 1 Zo row per session (or IP) per minute — no spam.
    try {
      const key = readSignedCookie(req, 'dz_session')
        || String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'anon');
      const last = zoAuditThrottle.get(key) || 0;
      if (Date.now() - last >= 60000) {
        zoAuditThrottle.set(key, Date.now());
        audit('Zo', 'chat', 'pass', `intent: ${intentId}`);
      }
    } catch (e) { /* auditing must never break the assistant */ }
    res.json(payload);
  };

  if (!message) {
    return answer({ reply: "I didn't catch that — type a question and I'll do my best.", links: [], suggestions: ZO_STARTERS }, 'empty');
  }

  for (const [, intent] of zoMatch(message, user)) {
    if (intent.stats && !ctx.stats) ctx.stats = zoQuickStats(user);
    const r = intent.reply(ctx);
    if (!r) continue; // intent deferred (e.g. account question asked while logged out)
    return answer({
      reply: r.text,
      links: (r.links || []).filter(l => l && typeof l.href === 'string' && l.href.charAt(0) === '/'),
      suggestions: (r.sug || []).slice(0, 4)
    }, intent.id);
  }

  // TODO: LLM BRAIN — if process.env.OPENAI_API_KEY, forward unmatched questions to an LLM before falling back
  const sug = (user && user.isAdmin)
    ? ['How do I approve payments?', 'How do I set the commission?', 'How do I check documents?']
    : user ? ZO_STARTERS : ['What is Dealzoin?', 'How do I register?', 'What is the commission?'];
  return answer({
    reply: `Hmm, I'm not sure about that one — I'm best at Dealzoin platform questions. Try one of these, or email the admin at ${ADMIN_EMAIL} for anything else.`,
    links: [],
    suggestions: sug
  }, 'fallback');
});

// ============================= BATCH C ROUTES =============================
// ----- (7) Language switch -----
app.post('/lang', (req, res) => {
  const lang = String((req.body && req.body.lang) || '');
  if (SUPPORTED_LANGS.includes(lang)) {
    res.setHeader('Set-Cookie', `dz_lang=${lang}; Path=/; Max-Age=${365 * 24 * 3600}; SameSite=Lax`);
    const u = currentUser(req);
    if (u && !u.isAdmin) {
      try { db.prepare('UPDATE companies SET lang = ? WHERE id = ?').run(lang, u.id); } catch (e) { /* cookie still set */ }
    }
  }
  const back = String(req.get('referer') || '/').split('?')[0];
  res.redirect(/^https?:/i.test(back) ? '/' : (back || '/'));
});

// ----- (1) News ticker JSON (60s client polling; markets are cached server-side, DB part is cheap) -----
app.get('/api/ticker', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.json({ ok: true, html: tickerSegmentsHtml(reqLang(req)) });
  } catch (e) {
    res.json({ ok: false, html: '' }); // graceful — the client keeps the stale ticker
  }
});

// ----- (2) Direct translator -----
const translateRate = new Map(); // companyId -> [timestamps] (30 req/min window)
function translateRateOk(companyId) {
  const nowMs = Date.now();
  const arr = (translateRate.get(companyId) || []).filter(ts => nowMs - ts < 60000);
  if (arr.length >= 30) { translateRate.set(companyId, arr); return false; }
  arr.push(nowMs);
  translateRate.set(companyId, arr);
  return true;
}
/** Extract the translated text from the Google gtx nested-array response. */
function parseGoogleTranslate(json) {
  if (!Array.isArray(json) || !Array.isArray(json[0])) return '';
  return json[0].map(seg => (Array.isArray(seg) && seg[0]) ? String(seg[0]) : '').join('').trim();
}
app.post('/api/translate', requireCompany, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const rawText = String((req.body && req.body.text) || '');
  if (rawText.length > 2000) return res.status(413).json({ ok: false, error: 'too_long' });
  const text = rawText;
  let target = String((req.body && req.body.target) || '').trim().toLowerCase();
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(target)) target = 'en';
  if (!text.trim()) return res.status(400).json({ ok: false, error: 'empty' });
  if (!translateRateOk(req.user.id)) return res.status(429).json({ ok: false, error: 'rate_limited' });
  const cacheKey = crypto.createHash('sha256').update(target + '\n' + text).digest('hex');
  try {
    const hit = db.prepare('SELECT result FROM translation_cache WHERE cache_key = ?').get(cacheKey);
    if (hit) return res.json({ ok: true, text: hit.result, target, cached: true });
  } catch (e) { /* cache read failure must not block translation */ }
  // Proxy to the free Google endpoint — 5s timeout, graceful failure (client toasts).
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) { /* settled */ } }, 5000);
    let data = null;
    try {
      const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t&tl='
        + encodeURIComponent(target) + '&q=' + encodeURIComponent(text);
      const resp = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Dealzoin/1.0)' } });
      if (resp && resp.ok) data = await resp.json();
    } finally {
      clearTimeout(timer);
    }
    const out = parseGoogleTranslate(data);
    if (!out) return res.status(502).json({ ok: false, error: 'unavailable' });
    try {
      db.prepare('INSERT OR REPLACE INTO translation_cache (cache_key, target, result, created_at) VALUES (?,?,?,?)')
        .run(cacheKey, target, out.slice(0, 4000), now());
    } catch (e) { /* caching is best-effort */ }
    return res.json({ ok: true, text: out, target });
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'unavailable' });
  }
});

// ----- (3) BANK RESEARCH AGENT — company bank details KYC -----
/** Basic ISO-13616 IBAN mod-97 checksum. Returns true/false; null when the input isn't IBAN-shaped. */
function ibanChecksumOk(iban) {
  const s = String(iban || '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return null;
  const rearr = s.slice(4) + s.slice(0, 4);
  let digits = '';
  for (const ch of rearr) digits += /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
  let rem = 0;
  for (const ch of digits) rem = (rem * 10 + (ch.charCodeAt(0) - 48)) % 97;
  return rem === 1;
}
/** Common bank-country names → ISO 3166-1 alpha-2 (for the IBAN country cross-check). */
const COUNTRY_TO_ISO = {
  'united arab emirates': 'AE', uae: 'AE', emirates: 'AE', 'saudi arabia': 'SA', ksa: 'SA', qatar: 'QA', bahrain: 'BH',
  kuwait: 'KW', oman: 'OM', egypt: 'EG', jordan: 'JO', lebanon: 'LB', 'united states': 'US', usa: 'US', 'united kingdom': 'GB',
  uk: 'GB', britain: 'GB', germany: 'DE', france: 'FR', netherlands: 'NL', spain: 'ES', italy: 'IT', switzerland: 'CH',
  india: 'IN', china: 'CN', 'hong kong': 'HK', singapore: 'SG', turkey: 'TR', 'south africa': 'ZA', nigeria: 'NG', kenya: 'KE'
};
function countryToIso(country) {
  const c = String(country || '').trim();
  if (/^[A-Za-z]{2}$/.test(c)) return c.toUpperCase();
  return COUNTRY_TO_ISO[c.toLowerCase()] || '';
}
/**
 * BANK RESEARCH AGENT: validates a company's saved bank details — SWIFT structure, IBAN
 * checksum, completeness score, IBAN-country vs declared bank-country — then stores the verdict
 * (bank_kyc_status: verified | warnings | rejected + human-readable notes) and audit-logs it.
 * An admin override pins status to verified/rejected and survives re-runs of the agent.
 */
function runBankKycAgent(companyId) {
  const c = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
  if (!c) return null;
  // Admin override is sticky — the agent does not re-judge overridden companies.
  if (c.bank_kyc_status === 'rejected' || (c.bank_kyc_status === 'verified' && /admin override/i.test(c.bank_kyc_notes || ''))) {
    return { status: c.bank_kyc_status, notes: c.bank_kyc_notes };
  }
  const name = (c.bank_name || '').trim(), holder = (c.bank_holder || '').trim();
  const swift = (c.bank_swift || '').replace(/\s+/g, '').toUpperCase();
  const iban = (c.bank_iban || '').replace(/\s+/g, '').toUpperCase();
  const bcountry = (c.bank_country || '').trim();
  const any = name || holder || swift || iban || bcountry;
  if (!any) {
    db.prepare("UPDATE companies SET bank_kyc_status = '', bank_kyc_notes = '', bank_kyc_at = ? WHERE id = ?").run(now(), c.id);
    return { status: '', notes: '' };
  }
  const notes = [];
  const filled = [name, holder, swift, iban, bcountry].filter(Boolean).length;
  // SWIFT/BIC: 8 or 11 chars — 4 bank + 2 country + 2 location (+ 3 branch).
  if (swift) {
    if (!/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(swift)) notes.push('SWIFT format invalid (expected 8 or 11 chars: BANKCCLL[BBB])');
  } else notes.push('SWIFT/BIC missing');
  // IBAN: checksum where applicable; plain account numbers are accepted but noted.
  const ibanOk = ibanChecksumOk(iban);
  if (iban) {
    if (ibanOk === false) notes.push('IBAN checksum failed — please re-check the number');
    else if (ibanOk === null) notes.push('Not an IBAN-shaped account number — treated as a local account (no checksum possible)');
  } else notes.push('IBAN / account number missing');
  // Country cross-check: IBAN prefix vs the declared bank country.
  const iso = countryToIso(bcountry);
  if (ibanOk !== null && iso && iban.slice(0, 2) !== iso) notes.push(`Country mismatch: IBAN country (${iban.slice(0, 2)}) ≠ declared bank country (${iso})`);
  if (!bcountry) notes.push('Bank country missing');
  if (!name) notes.push('Bank name missing');
  if (!holder) notes.push('Account holder missing');
  const score = Math.round((filled / 5) * 100);
  notes.push(`Completeness: ${score}% (${filled}/5 fields)`);
  // When every field is filled and valid, only the completeness note remains → verified.
  const finalStatus = notes.length === 1 ? 'verified' : 'warnings';
  const noteText = notes.join(' · ');
  db.prepare('UPDATE companies SET bank_kyc_status = ?, bank_kyc_notes = ?, bank_kyc_at = ? WHERE id = ?')
    .run(finalStatus, noteText.slice(0, 500), now(), c.id);
  audit('BANK RESEARCH AGENT', 'bank KYC check', finalStatus === 'verified' ? 'pass' : 'flag',
    `Bank KYC for "${c.name}" (#${c.id}): ${finalStatus} — ${noteText.slice(0, 380)}`);
  return { status: finalStatus, notes: noteText };
}
/** Verification badge for the company's OWN profile. */
function bankKycBadgeHtml(c, lang) {
  const st = c.bank_kyc_status || '';
  if (!st) return `<span class="badge">${esc(t(lang, 'bank.verified'))}: ${esc(t(lang, 'bank.notset'))}</span>`;
  if (st === 'verified') return `<span class="badge badge-pass">🏦 ${esc(t(lang, 'bank.verified'))}: ${esc(t(lang, 'bank.passed'))} ✓</span>`;
  if (st === 'rejected') return `<span class="badge badge-rejected">🏦 ${esc(t(lang, 'bank.verified'))}: ${esc(t(lang, 'bank.rejected'))}</span>`;
  return `<span class="badge badge-sealed" title="${esc(c.bank_kyc_notes || '')}">🏦 ${esc(t(lang, 'bank.verified'))}: ${esc(t(lang, 'bank.warnings'))} ⚠️</span>`;
}
/** Profile settings: save bank details, then the BANK RESEARCH AGENT re-checks them. */
app.post('/profile/bank', requireCompany, (req, res) => {
  if (req.user.memberId) return res.redirect('/profile?err=' + encodeURIComponent('Team members cannot change bank details.'));
  db.prepare('UPDATE companies SET bank_name = ?, bank_swift = ?, bank_iban = ?, bank_country = ?, bank_holder = ? WHERE id = ?')
    .run(String(req.body.bank_name || '').trim().slice(0, 120),
         String(req.body.bank_swift || '').trim().slice(0, 11),
         String(req.body.bank_iban || '').trim().slice(0, 34),
         String(req.body.bank_country || '').trim().slice(0, 60),
         String(req.body.bank_holder || '').trim().slice(0, 120),
         req.user.id);
  const verdict = runBankKycAgent(req.user.id);
  const msg = verdict && verdict.status === 'verified'
    ? 'Bank details saved — all BANK RESEARCH AGENT checks passed ✓'
    : 'Bank details saved — agent notes: ' + ((verdict && verdict.notes) || '').slice(0, 220);
  res.redirect('/profile?' + (verdict && verdict.status === 'verified' ? 'msg=' : 'err=') + encodeURIComponent(msg));
});

// ----- (4) ACCOUNTING AGENT (lite Odoo): invoices, expenses, ledger, CSV export -----
const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'overdue'];
const EXPENSE_CATEGORIES = ['General', 'Logistics', 'Salaries', 'Marketing', 'Operations', 'Travel', 'Software', 'Customs & duties', 'Other'];
/** Lazy status maintenance: sent invoices past their due date flip to overdue (date-only compare). */
function accountingSweep(companyId) {
  const today = now().slice(0, 10);
  const r = db.prepare(`UPDATE invoices SET status = 'overdue' WHERE company_id = ? AND status = 'sent' AND due_date != '' AND due_date < ?`).run(companyId, today);
  if (r.changes > 0) {
    agentInsight(companyId, 'ACCOUNTING AGENT', 'warn', `${r.changes} invoice(s) auto-marked overdue as of ${today} — consider sending a payment reminder.`);
    audit('ACCOUNTING AGENT', 'overdue sweep', 'flag', `Company #${companyId}: ${r.changes} invoice(s) auto-marked overdue`);
  }
}
/** ACCOUNTING AGENT checks on a new invoice: duplicate amount+client within 7 days. */
function accountingAgentInvoice(companyId, inv) {
  try {
    const dup = db.prepare(`SELECT id FROM invoices WHERE company_id = ? AND id != ? AND client = ? AND ABS(amount - ?) < 0.005
      AND created_at >= datetime('now', '-7 days') LIMIT 1`).get(companyId, inv.id, inv.client, inv.amount);
    if (dup) {
      agentInsight(companyId, 'ACCOUNTING AGENT', 'warn', `Possible duplicate invoice: #${inv.id} matches #${dup.id} (same client "${inv.client}" + amount ${fmtAmount(inv.amount)} ${inv.currency}) within 7 days.`);
    }
  } catch (e) { /* agent must never break the flow */ }
}
/** ACCOUNTING AGENT checks on a new expense: > 50% of the trailing monthly average. */
function accountingAgentExpense(companyId, exp) {
  try {
    const rows = db.prepare(`SELECT substr(COALESCE(NULLIF(spent_on,''), created_at), 1, 7) AS ym, SUM(amount) AS s
      FROM expenses WHERE company_id = ? AND id != ? AND currency = ? GROUP BY ym`).all(companyId, exp.id, exp.currency);
    if (rows.length < 2) return; // not enough history for a meaningful average
    const avg = rows.reduce((a, r) => a + (r.s || 0), 0) / rows.length;
    if (avg > 0 && exp.amount > avg * 0.5) {
      agentInsight(companyId, 'ACCOUNTING AGENT', 'warn', `Unusual expense: ${fmtAmount(exp.amount)} ${exp.currency} in "${exp.category}" is above 50% of your monthly average (${fmtAmount(avg)} ${exp.currency}).`);
    }
  } catch (e) { /* best-effort */ }
}
/** Small status chip for invoices. */
function invoiceStatusBadge(status) {
  const cls = status === 'paid' ? 'badge-pass' : status === 'overdue' ? 'badge-rejected' : status === 'sent' ? 'badge-sealed' : '';
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}
app.get('/accounting', requireCompany, (req, res) => {
  const lang = req.user.lang || 'en';
  const myId = req.user.id;
  accountingSweep(myId);
  const invoices = db.prepare('SELECT * FROM invoices WHERE company_id = ? ORDER BY created_at DESC, id DESC LIMIT 200').all(myId);
  const expenses = db.prepare("SELECT * FROM expenses WHERE company_id = ? ORDER BY COALESCE(NULLIF(spent_on, ''), created_at) DESC, id DESC LIMIT 200").all(myId);
  const myDeals = db.prepare('SELECT id, title, deal_number FROM deals WHERE company_id = ? ORDER BY created_at DESC LIMIT 50').all(myId);

  // Summary cards (per-currency sums; most companies use a single currency — mixed sums are listed per currency).
  const sumBy = (rows, pred) => {
    const out = {};
    for (const r of rows) if (pred(r)) out[r.currency] = (out[r.currency] || 0) + r.amount;
    return Object.entries(out).sort().map(([c, v]) => `${fmtAmount(v)} ${esc(c)}`).join('<br>') || '—';
  };
  const receivables = sumBy(invoices, i => i.status === 'sent' || i.status === 'overdue');
  const paidSum = sumBy(invoices, i => i.status === 'paid');
  const overdueSum = sumBy(invoices, i => i.status === 'overdue');
  const expenseSum = sumBy(expenses, () => true);
  const netSum = (() => {
    const m = {};
    for (const i of invoices) if (i.status === 'paid') m[i.currency] = (m[i.currency] || 0) + i.amount;
    for (const e of expenses) m[e.currency] = (m[e.currency] || 0) - e.amount;
    return Object.entries(m).sort().map(([c, v]) => `${fmtAmount(v)} ${esc(c)}`).join('<br>') || '—';
  })();

  const invoiceRows = invoices.length ? invoices.map(i => {
    const actions = [];
    if (i.status === 'draft') actions.push(['sent', 'sent']);
    if (i.status === 'sent' || i.status === 'overdue') actions.push(['paid', 'paid']);
    return `<tr>
      <td>#${i.id} <b>${esc(i.client)}</b>${i.deal_id ? `<br><a class="muted" href="/deal/${i.deal_id}">🔗 linked deal</a>` : ''}${i.notes ? `<br><span class="muted">${esc(i.notes)}</span>` : ''}</td>
      <td class="qty">${fmtAmount(i.amount)} ${esc(i.currency)}</td>
      <td class="muted">${esc(i.due_date || '—')}</td>
      <td>${invoiceStatusBadge(i.status)}</td>
      <td>${actions.map(([s, label]) => `<form method="POST" action="/accounting/invoices/${i.id}/status" style="display:inline"><input type="hidden" name="status" value="${s}"><button class="btn btn-sm btn-outline" type="submit">${esc(t(lang, 'acct.mark'))} ${esc(label)}</button></form>`).join(' ')}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="5" class="muted">${esc(t(lang, 'common.none'))}</td></tr>`;

  const expenseRows = expenses.length ? expenses.map(e => `<tr>
      <td><b>${esc(e.category)}</b>${e.notes ? `<br><span class="muted">${esc(e.notes)}</span>` : ''}</td>
      <td class="qty">−${fmtAmount(e.amount)} ${esc(e.currency)}</td>
      <td class="muted">${esc(e.spent_on || e.created_at.slice(0, 10))}</td>
    </tr>`).join('') : `<tr><td colspan="3" class="muted">${esc(t(lang, 'common.none'))}</td></tr>`;

  // Ledger: invoices (+) and expenses (−) merged chronologically with a running balance.
  const entries = [];
  for (const i of invoices) entries.push({ date: (i.due_date || i.created_at.slice(0, 10)), text: `Invoice #${i.id} — ${i.client} (${i.status})`, amount: i.amount, currency: i.currency, kind: 'invoice' });
  for (const e of expenses) entries.push({ date: (e.spent_on || e.created_at.slice(0, 10)), text: `Expense — ${e.category}${e.notes ? ': ' + e.notes : ''}`, amount: -e.amount, currency: e.currency, kind: 'expense' });
  entries.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  let running = 0;
  const ledgerRows = entries.length ? entries.map(en => {
    running += en.amount;
    return `<tr><td class="muted">${esc(en.date)}</td><td>${esc(en.text)}</td>
      <td class="qty" style="color:${en.amount >= 0 ? 'var(--mint)' : 'var(--danger)'}">${en.amount >= 0 ? '+' : ''}${fmtAmount(en.amount)} ${esc(en.currency)}</td>
      <td class="qty">${fmtAmount(running)}</td></tr>`;
  }).join('') : `<tr><td colspan="4" class="muted">${esc(t(lang, 'common.none'))}</td></tr>`;

  const insights = db.prepare(`SELECT * FROM agent_insights WHERE company_id = ? AND agent = 'ACCOUNTING AGENT' ORDER BY id DESC LIMIT 5`).all(myId);
  const insightsHtml = insights.length
    ? `<div class="card agent-insights" data-reveal><h3>🤖 ${esc(t(lang, 'acct.insights'))}</h3><ul>${insights.map(g => `<li>${g.level === 'warn' ? '⚠️' : 'ℹ️'} ${esc(g.text)} <span class="muted">· ${esc(g.created_at.slice(0, 10))}</span></li>`).join('')}</ul></div>` : '';

  const dealOpts = `<option value="">—</option>` + myDeals.map(d => `<option value="${d.id}">${esc(d.deal_number || ('#' + d.id))} ${esc(d.title.slice(0, 40))}</option>`).join('');
  const body = `
  <div class="feed-head" style="margin-bottom:12px"><h2 class="sec-h" style="margin:0">📒 ${esc(t(lang, 'acct.title'))}</h2>
    <a class="btn btn-sm btn-outline" href="/accounting/export.csv">⬇ ${esc(t(lang, 'acct.export'))}</a></div>
  <div class="stats">
    <div class="stat card--cut" data-reveal style="--i:0" data-num="01"><div class="num gold" style="font-size:1.15rem">${receivables}</div><div class="lbl">${esc(t(lang, 'acct.receivables'))}</div></div>
    <div class="stat card--cut" data-reveal style="--i:1" data-num="02"><div class="num mint" style="font-size:1.15rem">${paidSum}</div><div class="lbl">${esc(t(lang, 'acct.paid'))}</div></div>
    <div class="stat card--cut" data-reveal style="--i:2" data-num="03"><div class="num" style="font-size:1.15rem;color:var(--danger)">${overdueSum}</div><div class="lbl">${esc(t(lang, 'acct.overdue'))}</div></div>
    <div class="stat card--cut" data-reveal style="--i:3" data-num="04"><div class="num" style="font-size:1.15rem">${expenseSum}</div><div class="lbl">${esc(t(lang, 'acct.expenses'))}</div></div>
    <div class="stat card--cut" data-reveal style="--i:4" data-num="05"><div class="num gold" style="font-size:1.15rem">${netSum}</div><div class="lbl">${esc(t(lang, 'acct.net'))}</div></div>
  </div>
  ${insightsHtml}
  <div class="grid2" style="align-items:start">
    <div class="card" data-reveal><h3>🧾 ${esc(t(lang, 'acct.newinvoice'))}</h3>
      <form method="POST" action="/accounting/invoices">
        <label>${esc(t(lang, 'acct.client'))} *</label><input type="text" name="client" required maxlength="160">
        <div class="grid2" style="gap:10px">
          <div><label>${esc(t(lang, 'common.amount'))} *</label><input type="number" name="amount" min="0.01" step="any" required></div>
          <div><label>${esc(t(lang, 'common.currency'))}</label><select name="currency">${optionsHtml(DEAL_CURRENCIES, 'USD')}</select></div>
        </div>
        <label>${esc(t(lang, 'acct.duedate'))}</label><input type="date" name="due_date">
        <label>${esc(t(lang, 'acct.linkeddeal'))} (${esc(t(lang, 'common.optional'))})</label><select name="deal_id">${dealOpts}</select>
        <label>${esc(t(lang, 'common.notes'))}</label><textarea name="notes" rows="2" maxlength="500"></textarea>
        <button class="btn" type="submit">${esc(t(lang, 'common.save'))}</button>
      </form>
    </div>
    <div class="card" data-reveal><h3>💸 ${esc(t(lang, 'acct.recordexpense'))}</h3>
      <form method="POST" action="/accounting/expenses">
        <label>${esc(t(lang, 'common.category'))} *</label><select name="category">${optionsHtml(EXPENSE_CATEGORIES, 'General')}</select>
        <div class="grid2" style="gap:10px">
          <div><label>${esc(t(lang, 'common.amount'))} *</label><input type="number" name="amount" min="0.01" step="any" required></div>
          <div><label>${esc(t(lang, 'common.currency'))}</label><select name="currency">${optionsHtml(DEAL_CURRENCIES, 'USD')}</select></div>
        </div>
        <label>${esc(t(lang, 'acct.spenton'))}</label><input type="date" name="spent_on">
        <label>${esc(t(lang, 'common.notes'))}</label><textarea name="notes" rows="2" maxlength="500"></textarea>
        <button class="btn" type="submit">${esc(t(lang, 'common.save'))}</button>
      </form>
    </div>
  </div>
  <div class="card" data-reveal><h3>🧾 ${esc(t(lang, 'acct.invoices'))}</h3>
    <table><tr><th>${esc(t(lang, 'acct.client'))}</th><th>${esc(t(lang, 'common.amount'))}</th><th>${esc(t(lang, 'acct.duedate'))}</th><th>${esc(t(lang, 'common.status'))}</th><th></th></tr>${invoiceRows}</table></div>
  <div class="card" data-reveal><h3>💸 ${esc(t(lang, 'acct.expenses'))}</h3>
    <table><tr><th>${esc(t(lang, 'common.category'))}</th><th>${esc(t(lang, 'common.amount'))}</th><th>${esc(t(lang, 'common.date'))}</th></tr>${expenseRows}</table></div>
  <div class="card" data-reveal><h3>📚 ${esc(t(lang, 'acct.ledger'))}</h3>
    <table><tr><th>${esc(t(lang, 'common.date'))}</th><th>Entry</th><th>${esc(t(lang, 'common.amount'))}</th><th>${esc(t(lang, 'acct.balance'))}</th></tr>${ledgerRows}</table></div>`;
  res.send(page(t(lang, 'acct.title'), body, req.user, req.query.msg, req.query.err, 'dashboard'));
});

app.post('/accounting/invoices', requireCompany, (req, res) => {
  const client = String(req.body.client || '').trim().slice(0, 160);
  const amount = parseFloat(req.body.amount);
  if (!client || !isFinite(amount) || amount <= 0) return res.redirect('/accounting?err=' + encodeURIComponent('Client and a positive amount are required.'));
  const currency = DEAL_CURRENCIES.includes(req.body.currency) ? req.body.currency : 'USD';
  const due = /^\d{4}-\d{2}-\d{2}$/.test(req.body.due_date || '') ? req.body.due_date : '';
  const notes = String(req.body.notes || '').trim().slice(0, 500);
  const dealId = parseInt(req.body.deal_id, 10);
  const linked = dealId && db.prepare('SELECT id FROM deals WHERE id = ? AND company_id = ?').get(dealId, req.user.id) ? dealId : null;
  const r = db.prepare('INSERT INTO invoices (company_id, client, amount, currency, due_date, notes, deal_id, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(req.user.id, client, amount, currency, due, notes, linked, 'draft', now());
  accountingAgentInvoice(req.user.id, { id: r.lastInsertRowid, client, amount, currency });
  audit('ACCOUNTING AGENT', 'invoice created', 'pass', `Company #${req.user.id} created invoice #${r.lastInsertRowid} for "${client.slice(0, 60)}"`);
  res.redirect('/accounting?msg=' + encodeURIComponent('Invoice #' + r.lastInsertRowid + ' created (draft).'));
});

app.post('/accounting/invoices/:id/status', requireCompany, (req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ? AND company_id = ?').get(parseInt(req.params.id, 10), req.user.id);
  if (!inv) return res.redirect('/accounting?err=' + encodeURIComponent('Invoice not found.'));
  const next = String(req.body.status || '');
  const allowed = { draft: ['sent'], sent: ['paid'], overdue: ['paid'], paid: [] };
  if (!(allowed[inv.status] || []).includes(next)) return res.redirect('/accounting?err=' + encodeURIComponent(`Cannot move an invoice from ${inv.status} to ${next}.`));
  db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(next, inv.id);
  audit('ACCOUNTING AGENT', 'invoice status', 'pass', `Invoice #${inv.id} (${req.user.name}) ${inv.status} → ${next}`);
  if (next === 'paid') agentInsight(req.user.id, 'ACCOUNTING AGENT', 'info', `Invoice #${inv.id} from "${inv.client}" marked paid — ${fmtAmount(inv.amount)} ${inv.currency} received.`);
  res.redirect('/accounting?msg=' + encodeURIComponent(`Invoice #${inv.id} marked ${next}.`));
});

app.post('/accounting/expenses', requireCompany, (req, res) => {
  const category = String(req.body.category || '').trim().slice(0, 60) || 'General';
  const amount = parseFloat(req.body.amount);
  if (!isFinite(amount) || amount <= 0) return res.redirect('/accounting?err=' + encodeURIComponent('A positive amount is required.'));
  const currency = DEAL_CURRENCIES.includes(req.body.currency) ? req.body.currency : 'USD';
  const spent = /^\d{4}-\d{2}-\d{2}$/.test(req.body.spent_on || '') ? req.body.spent_on : '';
  const notes = String(req.body.notes || '').trim().slice(0, 500);
  const r = db.prepare('INSERT INTO expenses (company_id, category, amount, currency, spent_on, notes, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(req.user.id, category, amount, currency, spent, notes, now());
  accountingAgentExpense(req.user.id, { id: r.lastInsertRowid, category, amount, currency });
  audit('ACCOUNTING AGENT', 'expense recorded', 'pass', `Company #${req.user.id} recorded ${fmtAmount(amount)} ${currency} expense (${category})`);
  res.redirect('/accounting?msg=' + encodeURIComponent('Expense recorded.'));
});

/** CSV export of the combined ledger (invoices + expenses). */
app.get('/accounting/export.csv', requireCompany, (req, res) => {
  const myId = req.user.id;
  const csvCell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const lines = [['type', 'id', 'date', 'party_or_category', 'amount', 'currency', 'status', 'notes'].map(csvCell).join(',')];
  for (const i of db.prepare('SELECT * FROM invoices WHERE company_id = ? ORDER BY created_at ASC').all(myId)) {
    lines.push(['invoice', i.id, i.due_date || i.created_at.slice(0, 10), i.client, i.amount, i.currency, i.status, i.notes].map(csvCell).join(','));
  }
  for (const e of db.prepare('SELECT * FROM expenses WHERE company_id = ? ORDER BY created_at ASC').all(myId)) {
    lines.push(['expense', e.id, e.spent_on || e.created_at.slice(0, 10), e.category, -e.amount, e.currency, '', e.notes].map(csvCell).join(','));
  }
  audit('ACCOUNTING AGENT', 'ledger export', 'pass', `Company #${myId} exported the accounting ledger CSV (${lines.length - 1} rows)`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="dealzoin-ledger-${now().slice(0, 10)}.csv"`);
  res.send('﻿' + lines.join('\r\n') + '\r\n');
});

// ----- (5) WAREHOUSE AGENT (lite Zoho): items, stock movements, low-stock alerts -----
app.get('/warehouse', requireCompany, (req, res) => {
  const lang = req.user.lang || 'en';
  const myId = req.user.id;
  const items = db.prepare('SELECT * FROM warehouse_items WHERE company_id = ? ORDER BY name ASC LIMIT 300').all(myId);
  const lowCount = items.filter(i => i.quantity <= i.reorder_level).length;
  const myDeals = db.prepare('SELECT id, title, deal_number FROM deals WHERE company_id = ? ORDER BY created_at DESC LIMIT 50').all(myId);
  const dealOpts = `<option value="">—</option>` + myDeals.map(d => `<option value="${d.id}">${esc(d.deal_number || ('#' + d.id))} ${esc(d.title.slice(0, 40))}</option>`).join('');

  const filterItem = parseInt(req.query.item, 10) || 0;
  const moves = filterItem
    ? db.prepare('SELECT m.*, i.name AS item_name, i.sku FROM warehouse_movements m JOIN warehouse_items i ON i.id = m.item_id WHERE m.company_id = ? AND m.item_id = ? ORDER BY m.id DESC LIMIT 100').all(myId, filterItem)
    : db.prepare('SELECT m.*, i.name AS item_name, i.sku FROM warehouse_movements m JOIN warehouse_items i ON i.id = m.item_id WHERE m.company_id = ? ORDER BY m.id DESC LIMIT 50').all(myId);

  const itemRows = items.length ? items.map(i => {
    const low = i.quantity <= i.reorder_level;
    return `<tr${low ? ' class="row-lowstock"' : ''}>
      <td><b>${esc(i.sku)}</b></td>
      <td><b>${esc(i.name)}</b>${i.location ? `<br><span class="muted">📍 ${esc(i.location)}</span>` : ''}</td>
      <td class="qty">${fmtAmount(i.quantity)} ${esc(i.unit)}${low ? ` <span class="badge badge-rejected">${esc(t(lang, 'wh.lowstock'))}</span>` : ''}</td>
      <td class="muted">${fmtAmount(i.reorder_level)} ${esc(i.unit)}</td>
      <td>
        <form method="POST" action="/warehouse/items/${i.id}/move" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <select name="direction" style="margin:0"><option value="IN">${esc(t(lang, 'wh.in'))}</option><option value="OUT">${esc(t(lang, 'wh.out'))}</option></select>
          <input type="number" name="quantity" min="0.01" step="any" required placeholder="0" style="width:90px;margin:0">
          <input type="text" name="note" maxlength="200" placeholder="${esc(t(lang, 'common.notes'))} (${esc(t(lang, 'common.optional'))})" style="width:150px;margin:0">
          <select name="deal_id" style="margin:0">${dealOpts}</select>
          <button class="btn btn-sm" type="submit">${esc(t(lang, 'wh.movement'))}</button>
          <a class="btn btn-sm btn-outline" href="/warehouse?item=${i.id}#history">${esc(t(lang, 'wh.history'))}</a>
        </form>
      </td>
    </tr>`;
  }).join('') : `<tr><td colspan="5" class="muted">${esc(t(lang, 'common.none'))}</td></tr>`;

  const moveRows = moves.length ? moves.map(m => `<tr>
      <td class="muted">${esc(m.created_at.slice(0, 16).replace('T', ' '))}</td>
      <td><b>${esc(m.sku)}</b> ${esc(m.item_name)}</td>
      <td><span class="badge ${m.direction === 'IN' ? 'badge-pass' : 'badge-sealed'}">${m.direction === 'IN' ? '⬆ IN' : '⬇ OUT'}</span> ${fmtAmount(m.quantity)}</td>
      <td>${m.deal_id ? `<a href="/deal/${m.deal_id}">🔗 deal</a> ` : ''}<span class="muted">${esc(m.note || '')}</span></td>
    </tr>`).join('') : `<tr><td colspan="4" class="muted">${esc(t(lang, 'common.none'))}</td></tr>`;

  const insights = db.prepare(`SELECT * FROM agent_insights WHERE company_id = ? AND agent = 'WAREHOUSE AGENT' ORDER BY id DESC LIMIT 5`).all(myId);
  const insightsHtml = insights.length
    ? `<div class="card agent-insights" data-reveal><h3>🤖 ${esc(t(lang, 'acct.insights'))}</h3><ul>${insights.map(g => `<li>${g.level === 'warn' ? '⚠️' : 'ℹ️'} ${esc(g.text)} <span class="muted">· ${esc(g.created_at.slice(0, 10))}</span></li>`).join('')}</ul></div>` : '';

  const body = `
  <h2 class="sec-h" style="margin-top:0">📦 ${esc(t(lang, 'wh.title'))}</h2>
  <div class="stats">
    <div class="stat card--cut" data-reveal style="--i:0" data-num="01"><div class="num gold" data-count="${items.length}">${items.length}</div><div class="lbl">${esc(t(lang, 'wh.items'))}</div></div>
    <div class="stat card--cut" data-reveal style="--i:1" data-num="02"><div class="num${lowCount ? '" style="color:var(--danger)' : ' mint'}" data-count="${lowCount}">${lowCount}</div><div class="lbl">${esc(t(lang, 'wh.lowstock'))}</div></div>
  </div>
  ${insightsHtml}
  <div class="card" data-reveal><h3>➕ ${esc(t(lang, 'wh.additem'))}</h3>
    <form method="POST" action="/warehouse/items">
      <div class="grid2" style="gap:10px">
        <div><label>${esc(t(lang, 'wh.name'))} *</label><input type="text" name="name" required maxlength="160"></div>
        <div><label>${esc(t(lang, 'wh.unit'))}</label><input type="text" name="unit" maxlength="30" value="units" placeholder="units / kg / pallets…"></div>
      </div>
      <div class="grid2" style="gap:10px">
        <div><label>${esc(t(lang, 'wh.quantity'))} (initial)</label><input type="number" name="quantity" min="0" step="any" value="0"></div>
        <div><label>${esc(t(lang, 'wh.reorder'))}</label><input type="number" name="reorder_level" min="0" step="any" value="0"></div>
      </div>
      <label>${esc(t(lang, 'wh.location'))}</label><input type="text" name="location" maxlength="160" placeholder="e.g. JAFZA warehouse 4, rack B-12">
      <button class="btn" type="submit">${esc(t(lang, 'wh.additem'))}</button>
      <span class="muted" style="margin-inline-start:8px">SKU is auto-generated (DZ-…)</span>
    </form>
  </div>
  <div class="card" data-reveal><h3>🗃️ ${esc(t(lang, 'wh.items'))}</h3>
    <table><tr><th>SKU</th><th>${esc(t(lang, 'wh.name'))}</th><th>${esc(t(lang, 'wh.current'))}</th><th>${esc(t(lang, 'wh.reorder'))}</th><th>${esc(t(lang, 'wh.movement'))}</th></tr>${itemRows}</table></div>
  <div class="card" data-reveal id="history"><h3>🧾 ${esc(t(lang, 'wh.history'))}${filterItem ? ` — <a href="/warehouse#history">${esc(t(lang, 'common.back'))}</a>` : ''}</h3>
    <table><tr><th>${esc(t(lang, 'common.date'))}</th><th>${esc(t(lang, 'wh.items'))}</th><th>${esc(t(lang, 'wh.movement'))}</th><th>${esc(t(lang, 'common.notes'))}</th></tr>${moveRows}</table></div>`;
  res.send(page(t(lang, 'wh.title'), body, req.user, req.query.msg, req.query.err, 'dashboard'));
});

app.post('/warehouse/items', requireCompany, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 160);
  if (!name) return res.redirect('/warehouse?err=' + encodeURIComponent('Item name is required.'));
  const unit = String(req.body.unit || 'units').trim().slice(0, 30) || 'units';
  const qty = Math.max(0, parseFloat(req.body.quantity) || 0);
  const reorder = Math.max(0, parseFloat(req.body.reorder_level) || 0);
  const location = String(req.body.location || '').trim().slice(0, 160);
  const sku = nextSku(req.user.id);
  db.prepare('INSERT INTO warehouse_items (company_id, sku, name, unit, quantity, reorder_level, location, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(req.user.id, sku, name, unit, qty, reorder, location, now());
  audit('WAREHOUSE AGENT', 'item created', 'pass', `Company #${req.user.id} added item ${sku} "${name.slice(0, 60)}" (qty ${qty} ${unit}, reorder at ${reorder})`);
  if (qty <= reorder) {
    agentInsight(req.user.id, 'WAREHOUSE AGENT', 'warn', `New item ${sku} "${name}" starts at/below its reorder level (${fmtAmount(qty)} ≤ ${fmtAmount(reorder)} ${unit}).`);
  }
  res.redirect('/warehouse?msg=' + encodeURIComponent(`Item ${sku} added.`));
});

app.post('/warehouse/items/:id/move', requireCompany, (req, res) => {
  const item = db.prepare('SELECT * FROM warehouse_items WHERE id = ? AND company_id = ?').get(parseInt(req.params.id, 10), req.user.id);
  if (!item) return res.redirect('/warehouse?err=' + encodeURIComponent('Item not found.'));
  const dir = req.body.direction === 'OUT' ? 'OUT' : 'IN';
  const qty = parseFloat(req.body.quantity);
  if (!isFinite(qty) || qty <= 0) return res.redirect('/warehouse?err=' + encodeURIComponent('A positive quantity is required.'));
  if (dir === 'OUT' && qty > item.quantity) return res.redirect('/warehouse?err=' + encodeURIComponent(`Not enough stock — only ${fmtAmount(item.quantity)} ${item.unit} available.`));
  const note = String(req.body.note || '').trim().slice(0, 200);
  const dealId = parseInt(req.body.deal_id, 10);
  const linked = dealId && db.prepare('SELECT id FROM deals WHERE id = ? AND company_id = ?').get(dealId, req.user.id) ? dealId : null;
  const before = item.quantity;
  const after = dir === 'IN' ? before + qty : before - qty;
  const tx = db.transaction(() => {
    db.prepare('UPDATE warehouse_items SET quantity = ? WHERE id = ?').run(after, item.id);
    db.prepare('INSERT INTO warehouse_movements (item_id, company_id, direction, quantity, note, deal_id, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(item.id, req.user.id, dir, qty, note, linked, now());
  });
  tx();
  // WAREHOUSE AGENT: low-stock alert + unusual-movement flag.
  if (after <= item.reorder_level && before > item.reorder_level) {
    agentInsight(req.user.id, 'WAREHOUSE AGENT', 'warn', `Low stock: ${item.sku} "${item.name}" is at ${fmtAmount(after)} ${item.unit} (reorder level ${fmtAmount(item.reorder_level)}).`);
    notify(req.user.id, 'warehouse_low_stock', `⚠️ Low stock: ${item.sku} "${item.name}" — ${fmtAmount(after)} ${item.unit} left (reorder at ${fmtAmount(item.reorder_level)}).`, '/warehouse');
  }
  if (dir === 'OUT' && before > 0 && qty > before * 0.8) {
    agentInsight(req.user.id, 'WAREHOUSE AGENT', 'warn', `Unusual movement: a single OUT of ${fmtAmount(qty)} ${item.unit} removed over 80% of the stock of ${item.sku} "${item.name}"${note ? ` (note: ${note})` : ''}.`);
  }
  audit('WAREHOUSE AGENT', 'stock movement', 'pass', `${item.sku} ${dir} ${qty} ${item.unit} → ${fmtAmount(after)} in stock (company #${req.user.id})`);
  res.redirect('/warehouse?msg=' + encodeURIComponent(`${item.sku}: ${dir} ${fmtAmount(qty)} ${item.unit} — ${fmtAmount(after)} in stock.`));
});

// ----- (6) ADVERTISING AGENT — local template-based marketing copy generator -----
const AD_TONES = {
  professional: {
    openings: [
      'We are pleased to present {product} — built for organizations operating in {market}.',
      'For decision-makers in {market}: {product} is now available through our Dealzoin storefront.',
      '{product} represents our continued commitment to excellence in {market}.',
      'Serious businesses in {market} choose substance over noise. That is exactly what {product} delivers.'
    ],
    cta: ['Contact us via Dealzoin to discuss terms.', 'Message us here on Dealzoin for a structured quotation.', 'Open a negotiation with us — we respond within one business day.']
  },
  bold: {
    openings: [
      '{market}, meet {product}. This changes the game.',
      'Stop settling. {product} just raised the bar for {market}.',
      'The wait is over: {product} has landed in {market}.',
      '{product} is not an upgrade. It is a statement — now available for {market}.'
    ],
    cta: ['First movers win — open a negotiation today.', 'DM us on Dealzoin before your competitors do.', 'Dealzoin members get priority allocation. Move fast.']
  },
  friendly: {
    openings: [
      'Hello {market}! 👋 We would love to introduce you to {product}.',
      'Good news for {market}: {product} is here, and we think you will love it.',
      'We built {product} with partners in {market} in mind — come take a look!',
      'A warm hello to our friends in {market} — {product} is officially available.'
    ],
    cta: ['Say hello in our Dealzoin chat — we are happy to help.', 'Drop us a message and let’s talk details.', 'Curious? Send us an LOI and we’ll take it from there.']
  }
};
const AD_HASHTAGS = ['#B2B', '#Trade', '#Dealzoin', '#GlobalTrade', '#Business'];
const AD_BEST_TIMES = [
  'Tuesday 09:00–11:00 (your market’s local time) — mid-morning decision window',
  'Wednesday 13:00–15:00 — post-lunch procurement browsing peak',
  'Sunday 08:00–10:00 (Gulf markets) — start-of-week planning window',
  'Thursday 10:00–12:00 — pre-weekend deal-making surge'
];
/** Deterministic pick (stable per input) so "Regenerate" varies only with the seed. */
function adPick(arr, seed) { return arr[Math.abs(seed) % arr.length]; }
/** ADVERTISING AGENT: compose a polished marketing post locally — no external AI API. */
function generateAdCopy(product, market, benefits, tone, seed) {
  const tonePack = AD_TONES[tone] || AD_TONES.professional;
  const p = product.trim(), m = market.trim();
  const benefitList = benefits.split(/[\n,;]+/).map(b => b.trim()).filter(Boolean).slice(0, 6);
  const opening = adPick(tonePack.openings, seed).replaceAll('{product}', p).replaceAll('{market}', m);
  const benefitBlock = benefitList.length
    ? (tone === 'bold' ? 'Why it wins:' : tone === 'friendly' ? 'What you’ll appreciate:' : 'Key advantages:') + '\n'
      + benefitList.map(b => `✔ ${b.replace(/^[•\-✔]\s*/, '')}`).join('\n')
    : '';
  const cta = adPick(tonePack.cta, seed + 1);
  const tags = [...AD_HASHTAGS, '#' + m.replace(/[^A-Za-z0-9]/g, '')].filter((v, i, a) => v.length > 1 && a.indexOf(v) === i).join(' ');
  return { copy: `${opening}\n\n${benefitBlock ? benefitBlock + '\n\n' : ''}${cta}\n\n${tags}`, bestTime: adPick(AD_BEST_TIMES, seed + 2) };
}
app.get('/promote', requireCompany, (req, res) => {
  const lang = req.user.lang || 'en';
  const body = `
  <div class="card" style="max-width:620px;margin:0 auto" data-reveal>
    <div class="kicker">📣 ADVERTISING AGENT</div>
    <h2 style="margin:6px 0 10px">${esc(t(lang, 'promo.title'))}</h2>
    <p class="muted" style="margin-bottom:12px">Describe your offer — the ADVERTISING AGENT drafts a polished marketing post locally (no external AI). You review and edit it before anything is published. Promotional posts carry a subtle "Promoted" badge.</p>
    <form method="POST" action="/promote/preview">
      <label>${esc(t(lang, 'promo.product'))} *</label><input type="text" name="product" required maxlength="120" placeholder="e.g. Cold-chain logistics for pharma">
      <label>${esc(t(lang, 'promo.market'))} *</label><input type="text" name="market" required maxlength="120" placeholder="e.g. GCC healthcare distributors">
      <label>${esc(t(lang, 'promo.benefits'))} (${esc(t(lang, 'common.optional'))}, one per line)</label>
      <textarea name="benefits" rows="4" maxlength="800" placeholder="GDP-certified fleet&#10;Real-time temperature telemetry&#10;48h GCC delivery"></textarea>
      <label>${esc(t(lang, 'promo.tone'))}</label>
      <select name="tone">${optionsHtml(['professional', 'bold', 'friendly'], 'professional')}</select>
      <button class="btn" type="submit">✨ ${esc(t(lang, 'promo.generate'))}</button>
    </form>
  </div>`;
  res.send(page(t(lang, 'promo.title'), body, req.user, req.query.msg, req.query.err, 'new'));
});
app.post('/promote/preview', requireCompany, (req, res) => {
  const lang = req.user.lang || 'en';
  const product = String(req.body.product || '').trim().slice(0, 120);
  const market = String(req.body.market || '').trim().slice(0, 120);
  const benefits = String(req.body.benefits || '').slice(0, 800);
  const tone = AD_TONES[req.body.tone] ? req.body.tone : 'professional';
  const seed = parseInt(req.body.seed, 10) || 0;
  if (!product || !market) return res.redirect('/promote?err=' + encodeURIComponent('Product and target market are required.'));
  const { copy, bestTime } = generateAdCopy(product, market, benefits, tone, seed);
  const body = `
  <div class="card" style="max-width:640px;margin:0 auto" data-reveal>
    <div class="kicker">📣 ADVERTISING AGENT · ${esc(tone)}</div>
    <h2 style="margin:6px 0 10px">${esc(t(lang, 'promo.preview'))}</h2>
    <form method="POST" action="/promote/publish">
      <textarea name="body" rows="10" maxlength="2000" required style="white-space:pre-wrap">${esc(copy)}</textarea>
      <input type="hidden" name="product" value="${esc(product)}">
      <input type="hidden" name="market" value="${esc(market)}">
      <input type="hidden" name="tone" value="${esc(tone)}">
      <input type="hidden" name="benefits" value="${esc(benefits)}">
      <p class="muted" style="margin:6px 0 12px">🕒 ${esc(t(lang, 'promo.besttime'))}: <b>${esc(bestTime)}</b> (suggested by the agent — just for fun)</p>
      <button class="btn btn-green" type="submit">🚀 ${esc(t(lang, 'promo.publish'))}</button>
      <button class="btn btn-outline" type="submit" formaction="/promote/preview" name="seed" value="${seed + 1}" formnovalidate>🔄 ${esc(t(lang, 'promo.regenerate'))}</button>
      <a class="btn btn-outline" href="/promote" style="margin-inline-start:8px">${esc(t(lang, 'common.back'))}</a>
    </form>
  </div>`;
  res.send(page(t(lang, 'promo.title'), body, req.user, null, null, 'new'));
});
app.post('/promote/publish', requireCompany, (req, res) => {
  const bodyTxt = String(req.body.body || '').trim().slice(0, 2000);
  if (!bodyTxt) return res.redirect('/promote?err=' + encodeURIComponent('The post cannot be empty.'));
  const product = String(req.body.product || '').trim().slice(0, 120);
  const market = String(req.body.market || '').trim().slice(0, 120);
  const tone = AD_TONES[req.body.tone] ? req.body.tone : 'professional';
  db.prepare('INSERT INTO posts (company_id, body, created_at, author_name, is_promo) VALUES (?,?,?,?,1)')
    .run(req.user.id, bodyTxt, now(), req.user.memberName || null);
  audit('ADVERTISING AGENT', 'promo post published', 'pass', `"${req.user.name}" published a promotional post (${tone}) for "${product.slice(0, 60)}" targeting "${market.slice(0, 60)}"`);
  res.redirect('/timeline?msg=' + encodeURIComponent('Promotional post published to the feed 🚀'));
});

// ============================= 404 & SERVER START =============================
app.use((req, res) => {
  res.status(404).send(page('Not found', '<div class="card"><h2>404 — page not found</h2><p class="muted"><a href="/">Back to home</a></p></div>', currentUser(req)));
});

app.listen(PORT, () => {
  console.log(`Dealzoin listening on http://localhost:${PORT}`);
  console.log(`Admin login: ${ADMIN_EMAIL} (env-configured)${BREVO_API_KEY ? '' : ' — DEMO MODE: verification codes shown on screen'}`);
});
