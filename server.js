/* ============================================================
   Dealzoin — real backend
   - Company sign-up (goes to PENDING until admin approves)
   - Admin sign-in + managerial dashboard (approve registrations
     and contracts, stats) + change password
   - Approved companies sign in, create deals (goes to PENDING
     contracts until admin approves)
   Run:  npm install && npm start   →  http://localhost:3000
   ============================================================ */
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@dealzoin.com').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Dealzoin@2026';

/* ---------- database ---------- */
const db = new Database(path.join(__dirname, 'dealzoin.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  country TEXT NOT NULL,
  industry TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL,
  value_usd REAL NOT NULL,
  terms TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);

/* ---------- security helpers ---------- */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const candidate = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// tiny in-memory login rate limiter: 10 fails / 10 min per key
const fails = {};
function tooMany(key) {
  const f = fails[key];
  if (!f) return false;
  if (Date.now() - f.t > 600000) { delete fails[key]; return false; }
  return f.n >= 10;
}
function recordFail(key) {
  const f = fails[key] || { n: 0, t: Date.now() };
  f.n++; fails[key] = f;
}

/* ---------- seed admin (first run) ---------- */
if (!db.prepare('SELECT id FROM admins').get()) {
  const { salt, hash } = hashPassword(ADMIN_PASSWORD);
  db.prepare('INSERT INTO admins (email, pass_hash, salt) VALUES (?,?,?)').run(ADMIN_EMAIL, hash, salt);
  console.log('==========================================================');
  console.log('Admin account created:');
  console.log('  email:    ' + ADMIN_EMAIL);
  console.log('  password: ' + ADMIN_PASSWORD);
  console.log('  >>> Sign in and change this password immediately. <<<');
  console.log('==========================================================');
}

/* ---------- middleware ---------- */
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 }
}));

function requireAdmin(req, res, next) {
  if (!req.session.adminId) return res.redirect('/signin');
  next();
}
function requireApprovedCompany(req, res, next) {
  if (!req.session.companyId) return res.redirect('/signin');
  const c = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.session.companyId);
  if (!c) { req.session.destroy(() => res.redirect('/signin')); return; }
  if (c.status !== 'approved') {
    return res.send(layout('Awaiting approval', banner(c.status) +
      '<div class="card"><h2>Registration ' + c.status + '</h2><p class="mut">Your company registration is <b>' + c.status + '</b> by the platform owner. ' +
      (c.status === 'pending' ? 'You will be able to sign in and post deals once approved.' : 'Contact the platform owner to re-apply.') +
      '</p><a class="btn" href="/signout">Sign out</a></div>'));
  }
  req.company = c;
  next();
}

/* ---------- page layout ---------- */
const esc = (s) => String(s || '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
function layout(title, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Dealzoin — ${esc(title)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#0b1220;color:#e2e8f0;min-height:100vh}
a{color:#a78bfa}
.wrap{max-width:960px;margin:0 auto;padding:32px 16px}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:26px}
.logo{width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#7c3aed,#6b21a8);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:22px;color:#fff}
.brand b{font-size:22px;color:#fff}
.card{background:#111a2e;border:1px solid #243152;border-radius:14px;padding:26px;margin-bottom:16px}
h2{color:#fff;margin-bottom:6px;font-size:20px}
.mut{color:#94a3b8;font-size:14px}
label{display:block;font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin:14px 0 6px}
input,select,textarea{width:100%;background:#0b1425;border:1px solid #2b3a5e;border-radius:10px;padding:11px 13px;color:#e2e8f0;font:inherit}
input:focus,select:focus,textarea:focus{outline:none;border-color:#7c3aed}
.btn{display:inline-block;background:#7c3aed;color:#fff;border:none;border-radius:10px;padding:11px 20px;font-weight:700;font-size:14px;cursor:pointer;text-decoration:none;margin-top:18px}
.btn:hover{background:#6d28d9}
.btn.ghost{background:transparent;border:1px solid #33436b;color:#cbd5e1}
.btn.sm{padding:7px 13px;font-size:13px;margin-top:0;border-radius:8px}
.btn.green{background:#059669}.btn.green:hover{background:#047857}
.btn.red{background:#dc2626}.btn.red:hover{background:#b91c1c}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
table{width:100%;border-collapse:collapse;font-size:13.5px;margin-top:8px}
th{text-align:left;color:#94a3b8;font-size:11.5px;text-transform:uppercase;letter-spacing:.5px;padding:8px 6px}
td{padding:10px 6px;border-top:1px solid #223155;vertical-align:middle}
.pill{font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px}
.pill.pend{background:#78350f;color:#fbbf24}
.pill.ok{background:#064e3b;color:#34d399}
.pill.no{background:#7f1d1d;color:#f87171}
.nav{display:flex;gap:14px;align-items:center;margin-bottom:20px;font-size:14px}
.nav a{color:#cbd5e1;text-decoration:none;font-weight:600}
.nav a:hover{color:#fff}
.flash{background:#312e81;border:1px solid:#4f46e5;color:#e0e7ff;padding:11px 15px;border-radius:10px;margin-bottom:14px;font-size:14px}
.banner{padding:12px 16px;border-radius:10px;margin-bottom:16px;font-size:14px;font-weight:600}
.banner.pending{background:#78350f33;border:1px solid #b45309;color:#fbbf24}
.banner.approved{background:#064e3b33;border:1px solid #059669;color:#34d399}
.banner.rejected{background:#7f1d1d33;border:1px solid #dc2626;color:#f87171}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:16px}
.kpi{background:#111a2e;border:1px solid #243152;border-radius:12px;padding:16px}
.kpi .v{font-size:26px;font-weight:800;color:#fff}
.kpi .l{font-size:12px;color:#94a3b8;font-weight:600}
.center{max-width:440px;margin:8vh auto 0}
</style></head><body><div class="wrap">${body}</div></body></html>`;
}
function navFor(session) {
  if (session.adminId) return `<div class="nav"><div class="logo" style="width:30px;height:30px;font-size:16px">D</div><b style="color:#fff">Owner dashboard</b><span style="flex:1"></span><a href="/admin">Approvals</a><a href="/admin/password">Change password</a><a href="/signout">Sign out</a></div>`;
  if (session.companyId) return `<div class="nav"><div class="logo" style="width:30px;height:30px;font-size:16px">D</div><b style="color:#fff">Dealzoin</b><span style="flex:1"></span><a href="/dashboard">My deals</a><a href="/password">Change password</a><a href="/signout">Sign out</a></div>`;
  return '';
}
function banner(status) {
  const m = { pending: 'Your registration is awaiting owner approval.', approved: 'Your company is verified and approved.', rejected: 'Your registration was rejected by the owner.' };
  return `<div class="banner ${status}">${m[status] || ''}</div>`;
}
const flashBox = (req) => req.session.flash ? `<div class="flash">${esc(req.session.flash)}</div>` + (delete req.session.flash, '') : '';

/* ---------- AUTH PAGES (first page = sign in / sign up) ---------- */
app.get('/', (req, res) => {
  if (req.session.adminId) return res.redirect('/admin');
  if (req.session.companyId) return res.redirect('/dashboard');
  res.redirect('/signin');
});

app.get('/signin', (req, res) => {
  if (req.session.adminId) return res.redirect('/admin');
  if (req.session.companyId) return res.redirect('/dashboard');
  res.send(layout('Sign in', `<div class="center">
    <div class="brand"><div class="logo">D</div><b>Dealzoin</b></div>
    ${flashBox(req)}
    <div class="card">
      <h2>Sign in</h2><p class="mut">Companies &amp; platform owner</p>
      <form method="POST" action="/signin">
        <label>Email</label><input name="email" type="email" required autocomplete="username">
        <label>Password</label><input name="password" type="password" required autocomplete="current-password">
        <button class="btn" style="width:100%">Sign in</button>
      </form>
      <p class="mut" style="margin-top:18px;text-align:center">New company? <a href="/signup">Register your company</a></p>
    </div></div>`));
});

app.post('/signin', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const key = email + '|' + req.ip;
  if (tooMany(key)) return res.redirect('/signin?locked=1');
  // admin?
  const admin = db.prepare('SELECT * FROM admins WHERE email = ?').get(email);
  if (admin && verifyPassword(password, admin.salt, admin.pass_hash)) {
    req.session.regenerate(() => { req.session.adminId = admin.id; res.redirect('/admin'); });
    return;
  }
  const company = db.prepare('SELECT * FROM companies WHERE email = ?').get(email);
  if (company && verifyPassword(password, company.salt, company.pass_hash)) {
    req.session.regenerate(() => { req.session.companyId = company.id; res.redirect('/dashboard'); });
    return;
  }
  recordFail(key);
  req.session.flash = 'Invalid email or password.';
  res.redirect('/signin');
});

app.get('/signup', (req, res) => {
  res.send(layout('Sign up', `<div class="center">
    <div class="brand"><div class="logo">D</div><b>Dealzoin</b></div>
    <div class="card">
      <h2>Register your company</h2><p class="mut">The platform owner approves every registration before you can trade.</p>
      <form method="POST" action="/signup">
        <label>Company name</label><input name="name" required maxlength="120">
        <label>Business email</label><input name="email" type="email" required>
        <label>Password (min 8 characters)</label><input name="password" type="password" minlength="8" required autocomplete="new-password">
        <label>Country</label><input name="country" required maxlength="60">
        <label>Industry</label><input name="industry" required maxlength="80" placeholder="e.g. Logistics & supply chain">
        <button class="btn" style="width:100%">Submit for approval</button>
      </form>
      <p class="mut" style="margin-top:18px;text-align:center">Already registered? <a href="/signin">Sign in</a></p>
    </div></div>`));
});

app.post('/signup', (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const country = String(req.body.country || '').trim();
  const industry = String(req.body.industry || '').trim();
  if (!name || !country || !industry || !isEmail(email) || password.length < 8) {
    req.session.flash = 'Please fill all fields correctly (password min 8 characters).';
    return res.redirect('/signup');
  }
  const exists = db.prepare('SELECT id FROM companies WHERE email = ?').get(email)
            || db.prepare('SELECT id FROM admins WHERE email = ?').get(email);
  if (exists) { req.session.flash = 'An account with this email already exists.'; return res.redirect('/signup'); }
  const { salt, hash } = hashPassword(password);
  db.prepare('INSERT INTO companies (name,email,pass_hash,salt,country,industry) VALUES (?,?,?,?,?,?)')
    .run(name, email, hash, salt, country, industry);
  req.session.flash = 'Registration submitted. It will appear in the owner dashboard as PENDING until approved.';
  res.redirect('/signin');
});

app.get('/signout', (req, res) => req.session.destroy(() => res.redirect('/signin')));

/* ---------- COMPANY AREA ---------- */
app.get('/dashboard', requireApprovedCompany, (req, res) => {
  const deals = db.prepare('SELECT * FROM deals WHERE company_id = ? ORDER BY id DESC').all(req.company.id);
  const pill = (s) => `<span class="pill ${s === 'approved' ? 'ok' : s === 'rejected' ? 'no' : 'pend'}">${s}</span>`;
  res.send(layout('Dashboard', navFor(req.session) + banner('approved') + `
    <div class="card">
      <h2>Post a new deal</h2><p class="mut">Deals enter the owner's <b>pending contracts</b> queue until approved, then appear in the marketplace feed.</p>
      <form method="POST" action="/deals">
        <label>Deal title</label><input name="title" required maxlength="160">
        <label>Deal value (USD)</label><input name="value" type="number" min="1" step="any" required>
        <label>Terms</label><textarea name="terms" rows="3" required placeholder="Delivery, payment schedule, escrow terms…"></textarea>
        <button class="btn">Submit deal for approval</button>
      </form>
    </div>
    <div class="card">
      <h2>My deals</h2>
      ${deals.length ? `<table><tr><th>Title</th><th>Value</th><th>Status</th><th>Submitted</th></tr>
        ${deals.map(d => `<tr><td>${esc(d.title)}</td><td>$${Number(d.value_usd).toLocaleString()}</td><td>${pill(d.status)}</td><td class="mut">${d.created_at}</td></tr>`).join('')}</table>`
      : '<p class="mut">No deals yet.</p>'}
    </div>`));
});

app.post('/deals', requireApprovedCompany, (req, res) => {
  const title = String(req.body.title || '').trim();
  const value = Number(req.body.value);
  const terms = String(req.body.terms || '').trim();
  if (!title || !terms || !(value > 0)) { req.session.flash = 'Invalid deal.'; return res.redirect('/dashboard'); }
  db.prepare('INSERT INTO deals (company_id,title,value_usd,terms) VALUES (?,?,?,?)').run(req.company.id, title, value, terms);
  req.session.flash = 'Deal submitted — it is now in the owner\'s pending contracts queue.';
  res.redirect('/dashboard');
});

/* ---------- ADMIN (OWNER) AREA ---------- */
app.get('/admin', requireAdmin, (req, res) => {
  const pendingCos = db.prepare("SELECT * FROM companies WHERE status='pending' ORDER BY id").all();
  const pendingDeals = db.prepare(`SELECT d.*, c.name AS company FROM deals d JOIN companies c ON c.id=d.company_id WHERE d.status='pending' ORDER BY d.id`).all();
  const approvedCos = db.prepare("SELECT * FROM companies WHERE status='approved' ORDER BY id DESC LIMIT 20").all();
  const allDeals = db.prepare(`SELECT d.*, c.name AS company FROM deals d JOIN companies c ON c.id=d.company_id ORDER BY d.id DESC LIMIT 20`).all();
  const counts = {
    pendingCos: db.prepare("SELECT COUNT(*) n FROM companies WHERE status='pending'").get().n,
    approvedCos: db.prepare("SELECT COUNT(*) n FROM companies WHERE status='approved'").get().n,
    pendingDeals: db.prepare("SELECT COUNT(*) n FROM deals WHERE status='pending'").get().n,
    gmv: db.prepare("SELECT COALESCE(SUM(value_usd),0) n FROM deals WHERE status='approved'").get().n
  };
  const pill = (s) => `<span class="pill ${s === 'approved' ? 'ok' : s === 'rejected' ? 'no' : 'pend'}">${s}</span>`;
  res.send(layout('Owner dashboard', navFor(req.session) + flashBox(req) + `
    <div class="grid">
      <div class="kpi"><div class="v">${counts.pendingCos}</div><div class="l">Pending registrations</div></div>
      <div class="kpi"><div class="v">${counts.approvedCos}</div><div class="l">Approved companies</div></div>
      <div class="kpi"><div class="v">${counts.pendingDeals}</div><div class="l">Pending contracts</div></div>
      <div class="kpi"><div class="v num">$${Number(counts.gmv).toLocaleString()}</div><div class="l">Approved contract value</div></div>
    </div>

    <div class="card">
      <h2>Pending registrations (${pendingCos.length})</h2>
      ${pendingCos.length ? `<table><tr><th>Company</th><th>Country</th><th>Industry</th><th>Email</th><th>Applied</th><th></th></tr>
      ${pendingCos.map(c => `<tr><td><b>${esc(c.name)}</b></td><td>${esc(c.country)}</td><td>${esc(c.industry)}</td><td>${esc(c.email)}</td><td class="mut">${c.created_at}</td>
        <td class="row"><form method="POST" action="/admin/company/${c.id}/approve"><button class="btn sm green">Approve</button></form>
        <form method="POST" action="/admin/company/${c.id}/reject"><button class="btn sm red">Reject</button></form></td></tr>`).join('')}</table>`
      : '<p class="mut">No pending registrations.</p>'}
    </div>

    <div class="card">
      <h2>Pending contracts (${pendingDeals.length})</h2>
      ${pendingDeals.length ? pendingDeals.map(d => `<div style="border:1px solid #243152;border-radius:10px;padding:14px;margin-top:10px">
        <div class="row" style="justify-content:space-between"><b>${esc(d.title)}</b><span class="pill pend">$${Number(d.value_usd).toLocaleString()}</span></div>
        <p class="mut" style="margin:6px 0">${esc(d.terms)}</p>
        <p class="mut" style="font-size:12.5px">by <b style="color:#cbd5e1">${esc(d.company)}</b> · ${d.created_at}</p>
        <div class="row" style="margin-top:10px">
          <form method="POST" action="/admin/deal/${d.id}/approve"><button class="btn sm green">Approve contract</button></form>
          <form method="POST" action="/admin/deal/${d.id}/reject"><button class="btn sm red">Reject</button></form>
        </div></div>`).join('')
      : '<p class="mut">No pending contracts.</p>'}
    </div>

    <div class="grid" style="grid-template-columns:1fr 1fr">
      <div class="card">
        <h2>Approved companies</h2>
        ${approvedCos.length ? `<table><tr><th>Name</th><th>Status</th></tr>${approvedCos.map(c => `<tr><td>${esc(c.name)}</td><td>${pill(c.status)}</td></tr>`).join('')}</table>` : '<p class="mut">None yet.</p>'}
      </div>
      <div class="card">
        <h2>All contracts</h2>
        ${allDeals.length ? `<table><tr><th>Deal</th><th>Company</th><th>Value</th><th>Status</th></tr>
          ${allDeals.map(d => `<tr><td>${esc(d.title)}</td><td class="mut">${esc(d.company)}</td><td class="num">$${Number(d.value_usd).toLocaleString()}</td><td>${pill(d.status)}</td></tr>`).join('')}</table>` : '<p class="mut">None yet.</p>'}
      </div>
    </div>`));
});

app.post('/admin/company/:id/approve', requireAdmin, (req, res) => {
  db.prepare("UPDATE companies SET status='approved' WHERE id=? AND status='pending'").run(req.params.id);
  req.session.flash = 'Company approved — it can now sign in and post deals.';
  res.redirect('/admin');
});
app.post('/admin/company/:id/reject', requireAdmin, (req, res) => {
  db.prepare("UPDATE companies SET status='rejected' WHERE id=? AND status='pending'").run(req.params.id);
  req.session.flash = 'Company rejected.';
  res.redirect('/admin');
});
app.post('/admin/deal/:id/approve', requireAdmin, (req, res) => {
  db.prepare("UPDATE deals SET status='approved' WHERE id=? AND status='pending'").run(req.params.id);
  req.session.flash = 'Contract approved — it now appears in the marketplace.';
  res.redirect('/admin');
});
app.post('/admin/deal/:id/reject', requireAdmin, (req, res) => {
  db.prepare("UPDATE deals SET status='rejected' WHERE id=? AND status='pending'").run(req.params.id);
  req.session.flash = 'Contract rejected.';
  res.redirect('/admin');
});

/* ---------- CHANGE PASSWORD (admin + company) ---------- */
function changePasswordPage(req, back) {
  return layout('Change password', navFor(req.session) + flashBox(req) + `
    <div class="center" style="margin-top:0;max-width:480px">
    <div class="card">
      <h2>Change password</h2><p class="mut">Minimum 8 characters.</p>
      <form method="POST" action="${back}">
        <label>Current password</label><input name="current" type="password" required autocomplete="current-password">
        <label>New password</label><input name="next" type="password" minlength="8" required autocomplete="new-password">
        <label>Confirm new password</label><input name="confirm" type="password" minlength="8" required autocomplete="new-password">
        <button class="btn" style="width:100%">Update password</button>
      </form>
    </div></div>`);
}
function doChange(req, table, idCol, redirectTo) {
  const cur = String(req.body.current || ''), next = String(req.body.next || ''), conf = String(req.body.confirm || '');
  const row = db.prepare(`SELECT * FROM ${table} WHERE ${idCol}=?`).get(req.session[table === 'admins' ? 'adminId' : 'companyId']);
  if (!row || !verifyPassword(cur, row.salt, row.pass_hash)) { req.session.flash = 'Current password is incorrect.'; return res.redirect(redirectTo); }
  if (next.length < 8 || next !== conf) { req.session.flash = 'New passwords do not match (min 8 characters).'; return res.redirect(redirectTo); }
  const { salt, hash } = hashPassword(next);
  db.prepare(`UPDATE ${table} SET pass_hash=?, salt=? WHERE ${idCol}=?`).run(hash, salt, row[idCol]);
  req.session.flash = 'Password changed successfully.';
  res.redirect(redirectTo);
}
app.get('/admin/password', requireAdmin, (req, res) => res.send(changePasswordPage(req, '/admin/password')));
app.post('/admin/password', requireAdmin, (req, res) => doChange(req, 'admins', 'id', '/admin/password'));
app.get('/password', requireApprovedCompany, (req, res) => res.send(changePasswordPage(req, '/password')));
app.post('/password', requireApprovedCompany, (req, res) => doChange(req, 'companies', 'id', '/password'));

app.listen(PORT, () => console.log('Dealzoin running → http://localhost:' + PORT));
