/* ============================================================
   Dealzoin — v2 (real platform)
   Companies: sign up → owner approves → post deals instantly to
   every company's timeline, like/comment/repost, search deals &
   companies, follow companies (instagram-style), sign contract →
   terms page + document download → private closed room → owner
   approves the contract.
   Run: npm install && npm start  →  http://localhost:3000
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
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL REFERENCES companies(id),
  following_id INTEGER NOT NULL REFERENCES companies(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (follower_id, following_id)
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL,
  value_usd REAL NOT NULL,
  terms TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS likes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  post_id INTEGER REFERENCES posts(id),
  deal_id INTEGER REFERENCES deals(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  post_id INTEGER REFERENCES posts(id),
  deal_id INTEGER REFERENCES deals(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS reposts (
  deal_id INTEGER NOT NULL REFERENCES deals(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (deal_id, company_id)
);
CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL REFERENCES deals(id),
  requester_id INTEGER NOT NULL REFERENCES companies(id),
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL REFERENCES deals(id),
  sender_company_id INTEGER REFERENCES companies(id),
  sender_admin INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);

/* ---------- security helpers ---------- */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function verifyPassword(password, salt, hash) {
  const c = crypto.scryptSync(password, salt, 64);
  const s = Buffer.from(hash, 'hex');
  return c.length === s.length && crypto.timingSafeEqual(c, s);
}
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const fails = {};
const tooMany = (k) => fails[k] && Date.now() - fails[k].t < 600000 && fails[k].n >= 10;
function recordFail(k) { const f = fails[k] || { n: 0, t: Date.now() }; f.n++; fails[k] = f; }

/* ---------- seed admin ---------- */
if (!db.prepare('SELECT id FROM admins').get()) {
  const { salt, hash } = hashPassword(ADMIN_PASSWORD);
  db.prepare('INSERT INTO admins (email, pass_hash, salt) VALUES (?,?,?)').run(ADMIN_EMAIL, hash, salt);
  console.log('==========================================================');
  console.log('Admin account created —  email: ' + ADMIN_EMAIL + '  password: ' + ADMIN_PASSWORD);
  console.log('>>> Sign in and change this password immediately. <<<');
  console.log('==========================================================');
}

/* ---------- middleware ---------- */
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false, saveUninitialized: false,
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
    return res.send(layout('Awaiting approval', '<div class="card"><h2>Registration ' + c.status + '</h2><p class="mut">Your registration is <b>' + c.status + '</b>. ' +
      (c.status === 'pending' ? 'The platform owner must approve it before you can trade.' : 'Contact the platform owner to re-apply.') +
      '</p><a class="btn" href="/signout">Sign out</a></div>'));
  }
  req.company = c;
  next();
}

/* ---------- page layout ---------- */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const usd = (n) => '$' + Number(n).toLocaleString();
const pill = (s) => `<span class="pill ${s === 'approved' ? 'ok' : s === 'rejected' ? 'no' : 'pend'}">${s}</span>`;
function navFor(s) {
  if (s.adminId) return `<div class="nav"><div class="logo" style="width:30px;height:30px;font-size:16px">D</div><b style="color:#fff">Owner dashboard</b><span style="flex:1"></span><a href="/admin">Approvals</a><a href="/admin/password">Change password</a><a href="/signout">Sign out</a></div>`;
  if (s.companyId) return `<div class="nav"><div class="logo" style="width:30px;height:30px;font-size:16px">D</div><b style="color:#fff">Dealzoin</b><span style="flex:1"></span><a href="/feed">Timeline</a><a href="/companies">Companies</a><a href="/search">Search</a><a href="/dashboard">My deals</a><a href="/password">Change password</a><a href="/signout">Sign out</a></div>`;
  return '';
}
const flashBox = (req) => req.session.flash ? `<div class="flash">${esc(req.session.flash)}</div>` + (delete req.session.flash, '') : '';
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
.card{background:#111a2e;border:1px solid #243152;border-radius:14px;padding:22px;margin-bottom:16px}
h2{color:#fff;margin-bottom:6px;font-size:20px}
h3{color:#fff;font-size:16px}
.mut{color:#94a3b8;font-size:14px}
label{display:block;font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin:14px 0 6px}
input,select,textarea{width:100%;background:#0b1425;border:1px solid #2b3a5e;border-radius:10px;padding:11px 13px;color:#e2e8f0;font:inherit}
input:focus,select:focus,textarea:focus{outline:none;border-color:#7c3aed}
.btn{display:inline-block;background:#7c3aed;color:#fff;border:none;border-radius:10px;padding:11px 20px;font-weight:700;font-size:14px;cursor:pointer;text-decoration:none;margin-top:18px}
.btn:hover{background:#6d28d9}
.btn.ghost{background:transparent;border:1px solid #33436b;color:#cbd5e1}
.btn.ghost:hover{background:#1a2540}
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
.nav{display:flex;gap:14px;align-items:center;margin-bottom:20px;font-size:14px;flex-wrap:wrap}
.nav a{color:#cbd5e1;text-decoration:none;font-weight:600}
.nav a:hover{color:#fff}
.flash{background:#312e81;border:1px solid #4f46e5;color:#e0e7ff;padding:11px 15px;border-radius:10px;margin-bottom:14px;font-size:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:16px}
.kpi{background:#111a2e;border:1px solid #243152;border-radius:12px;padding:16px}
.kpi .v{font-size:26px;font-weight:800;color:#fff}
.kpi .l{font-size:12px;color:#94a3b8;font-weight:600}
.center{max-width:440px;margin:8vh auto 0}
.post{border:1px solid #243152;border-radius:12px;padding:16px;margin-bottom:12px;background:#111a2e}
.post .who{font-weight:700;color:#fff}
.post .body{margin:10px 0;font-size:14.5px;line-height:1.55;white-space:pre-wrap}
.acts{display:flex;gap:6px;margin:8px 0;flex-wrap:wrap;align-items:center}
.like-on{background:#831843;border-color:#be185d;color:#fff}
.repost-on{background:#0c4a6e;border-color:#0284c7;color:#fff}
.cmt{border-top:1px solid #1e2b47;padding:8px 0;font-size:13px;color:#94a3b8}
.cmt b{color:#cbd5e1}
.cform{display:flex;gap:8px;margin-top:10px}
.cform input{flex:1}
.deal-card{border:1px solid #3b2f63;border-left:4px solid #7c3aed;border-radius:12px;padding:16px;margin-bottom:12px;background:#111a2e}
.msg{border:1px solid #243152;border-radius:12px;padding:10px 14px;margin-bottom:10px;font-size:14px}
.msg .who{font-size:12px;font-weight:700;color:#a78bfa}
.msg.me{border-color:#7c3aed}
.doc{background:#f8fafc;color:#1e293b;border-radius:12px;padding:30px;font-size:14px;line-height:1.6}
.doc h1{font-size:20px;text-align:center;margin-bottom:4px;color:#0f172a}
.doc .sub{text-align:center;color:#64748b;font-size:12px;margin-bottom:18px}
.doc h4{margin:16px 0 4px;color:#0f172a}
.doc p{margin-bottom:8px}
</style></head><body><div class="wrap">${body}</div></body></html>`;
}

/* ---------- AUTH PAGES ---------- */
app.get('/', (req, res) => {
  if (req.session.adminId) return res.redirect('/admin');
  if (req.session.companyId) return res.redirect('/feed');
  res.redirect('/signin');
});
app.get('/signin', (req, res) => {
  if (req.session.adminId) return res.redirect('/admin');
  if (req.session.companyId) return res.redirect('/feed');
  res.send(layout('Sign in', `<div class="center">
    <div class="brand"><div class="logo">D</div><b>Dealzoin</b></div>${flashBox(req)}
    <div class="card">
      <h2>Sign in</h2><p class="mut">Companies &amp; platform owner</p>
      <form method="POST" action="/signin">
        <label>Email</label><input name="email" type="email" required>
        <label>Password</label><input name="password" type="password" required>
        <button class="btn" style="width:100%">Sign in</button>
      </form>
      <p class="mut" style="margin-top:18px;text-align:center">New company? <a href="/signup">Register your company</a></p>
    </div></div>`));
});
app.post('/signin', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const key = email + '|' + req.ip;
  if (tooMany(key)) { req.session.flash = 'Too many attempts — try again in 10 minutes.'; return res.redirect('/signin'); }
  const admin = db.prepare('SELECT * FROM admins WHERE email = ?').get(email);
  if (admin && verifyPassword(password, admin.salt, admin.pass_hash)) {
    return req.session.regenerate(() => { req.session.adminId = admin.id; res.redirect('/admin'); });
  }
  const company = db.prepare('SELECT * FROM companies WHERE email = ?').get(email);
  if (company && verifyPassword(password, company.salt, company.pass_hash)) {
    return req.session.regenerate(() => { req.session.companyId = company.id; res.redirect('/feed'); });
  }
  recordFail(key);
  req.session.flash = 'Invalid email or password.';
  res.redirect('/signin');
});
app.get('/signup', (req, res) => {
  res.send(layout('Sign up', `<div class="center">
    <div class="brand"><div class="logo">D</div><b>Dealzoin</b></div>${flashBox(req)}
    <div class="card">
      <h2>Register your company</h2><p class="mut">The platform owner approves every registration before you can trade.</p>
      <form method="POST" action="/signup">
        <label>Company name</label><input name="name" required maxlength="120">
        <label>Business email</label><input name="email" type="email" required>
        <label>Password (min 8 characters)</label><input name="password" type="password" minlength="8" required>
        <label>Country</label><input name="country" required maxlength="60">
        <label>Industry</label><input name="industry" required maxlength="80">
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
    req.session.flash = 'Please fill all fields correctly (password min 8 characters).'; return res.redirect('/signup');
  }
  if (db.prepare('SELECT id FROM companies WHERE email = ?').get(email) || db.prepare('SELECT id FROM admins WHERE email = ?').get(email)) {
    req.session.flash = 'An account with this email already exists.'; return res.redirect('/signup');
  }
  const { salt, hash } = hashPassword(password);
  db.prepare('INSERT INTO companies (name,email,pass_hash,salt,country,industry) VALUES (?,?,?,?,?,?)').run(name, email, hash, salt, country, industry);
  req.session.flash = 'Registration submitted. The platform owner will review it shortly.';
  res.redirect('/signin');
});
app.get('/signout', (req, res) => req.session.destroy(() => res.redirect('/signin')));

/* ---------- SOCIAL DATA HELPERS ---------- */
function socialSets(companyId) {
  return {
    likedPosts: new Set(db.prepare('SELECT post_id FROM likes WHERE company_id=? AND post_id IS NOT NULL').all(companyId).map(r => r.post_id)),
    likedDeals: new Set(db.prepare('SELECT deal_id FROM likes WHERE company_id=? AND deal_id IS NOT NULL').all(companyId).map(r => r.deal_id)),
    reposted: new Set(db.prepare('SELECT deal_id FROM reposts WHERE company_id=?').all(companyId).map(r => r.deal_id)),
    following: new Set(db.prepare('SELECT following_id FROM follows WHERE follower_id=?').all(companyId).map(r => r.following_id))
  };
}
function countsBy(sql) { const m = {}; db.prepare(sql).all().forEach(r => m[r.k] = r.n); return m; }
function commentsGrouped() {
  const g = {};
  db.prepare(`SELECT cm.*, c.name AS company FROM comments cm JOIN companies c ON c.id=cm.company_id ORDER BY cm.id`).all()
    .forEach(cm => { const key = (cm.deal_id ? 'd' + cm.deal_id : 'p' + cm.post_id); (g[key] = g[key] || []).push(cm); });
  return g;
}

/* ---------- TIMELINE (posts + deals, live for all) ---------- */
function dealCardHtml(d, me, S) {
  const liked = S.likedDeals.has(d.id), reposted = S.reposted.has(d.id);
  const lc = S.likeCounts['d' + d.id] || 0, rc = S.repostCounts[d.id] || 0;
  const cms = (S.comments['d' + d.id] || []).map(cm => `<div class="cmt"><b>${esc(cm.company)}</b> — ${esc(cm.body)}</div>`).join('');
  return `<div class="deal-card">
    <div class="row" style="justify-content:space-between">
      <div><span class="who">◆ ${esc(d.company)}</span> <span class="mut" style="font-size:12px">· ${esc(d.industry)} · ${d.created_at}</span></div>
      <span class="pill ok">${usd(d.value_usd)}</span>
    </div>
    <h3 style="margin:8px 0 4px">${esc(d.title)}</h3>
    <p class="mut">${esc(d.terms)}</p>
    <div class="acts">
      <form method="POST" action="/feed/like/deal/${d.id}" style="display:inline"><button class="btn sm ghost ${liked ? 'like-on' : ''}">❤ ${lc}</button></form>
      <form method="POST" action="/feed/repost/${d.id}" style="display:inline"><button class="btn sm ghost ${reposted ? 'repost-on' : ''}">🔁 ${rc}</button></form>
      <a class="btn sm ghost" href="/deal/${d.id}">✍️ Sign contract</a>
    </div>${cms}
    <form class="cform" method="POST" action="/feed/comment/deal/${d.id}">
      <input name="body" placeholder="Comment on this deal..." maxlength="300" required>
      <button class="btn sm">Comment</button>
    </form></div>`;
}
function postCardHtml(p, me, S) {
  const liked = S.likedPosts.has(p.id);
  const lc = S.likeCounts['p' + p.id] || 0;
  const cms = (S.comments['p' + p.id] || []).map(cm => `<div class="cmt"><b>${esc(cm.company)}</b> — ${esc(cm.body)}</div>`).join('');
  return `<div class="post">
    <div><span class="who">${esc(p.company)}</span> <span class="mut" style="font-size:12px">· ${esc(p.industry)} · ${p.created_at}</span></div>
    <div class="body">${esc(p.body)}</div>
    <div class="acts"><form method="POST" action="/feed/like/post/${p.id}" style="display:inline"><button class="btn sm ghost ${liked ? 'like-on' : ''}">❤ ${lc}</button></form></div>${cms}
    <form class="cform" method="POST" action="/feed/comment/post/${p.id}">
      <input name="body" placeholder="Write a comment..." maxlength="300" required>
      <button class="btn sm">Comment</button>
    </form></div>`;
}
app.get('/feed', requireApprovedCompany, (req, res) => {
  const me = req.company.id;
  const S = socialSets(me);
  S.likeCounts = countsBy(`SELECT COALESCE('p'||post_id, 'd'||deal_id) AS k, COUNT(*) n FROM likes GROUP BY 1`);
  S.repostCounts = countsBy('SELECT deal_id AS k, COUNT(*) n FROM reposts GROUP BY deal_id');
  S.comments = commentsGrouped();
  const posts = db.prepare(`SELECT p.*, c.name AS company, c.industry FROM posts p JOIN companies c ON c.id=p.company_id ORDER BY p.id DESC LIMIT 50`).all();
  const deals = db.prepare(`SELECT d.*, c.name AS company, c.industry FROM deals d JOIN companies c ON c.id=d.company_id ORDER BY d.id DESC LIMIT 50`).all();
  const items = [
    ...posts.map(p => ({ t: p.created_at, html: postCardHtml(p, me, S) })),
    ...deals.map(d => ({ t: d.created_at, html: dealCardHtml(d, me, S) }))
  ].sort((a, b) => (a.t < b.t ? 1 : -1)).map(x => x.html).join('');

  res.send(layout('Timeline', navFor(req.session) + flashBox(req) + `
    <div class="card">
      <h2>Timeline</h2><p class="mut">Post an update or a deal — everything is visible to all companies instantly.</p>
      <form method="POST" action="/feed/post">
        <textarea name="body" rows="2" maxlength="600" placeholder="Share an update from ${esc(req.company.name)}..." required></textarea>
        <button class="btn">Post</button>
      </form>
      <form method="POST" action="/deals" style="margin-top:10px;border-top:1px solid #243152;padding-top:14px">
        <h3>Post a deal</h3>
        <div class="row" style="align-items:flex-end">
          <div style="flex:2;min-width:200px"><label>Deal title</label><input name="title" required maxlength="160"></div>
          <div style="flex:1;min-width:120px"><label>Value (USD)</label><input name="value" type="number" min="1" step="any" required></div>
        </div>
        <label>Terms</label><input name="terms" required maxlength="300" placeholder="Delivery, payment, escrow terms...">
        <button class="btn">Publish deal to all companies</button>
      </form>
    </div>
    ${items || '<p class="mut">Nothing here yet — post the first update or deal.</p>'}`));
});
app.post('/feed/post', requireApprovedCompany, (req, res) => {
  const body = String(req.body.body || '').trim();
  if (body) db.prepare('INSERT INTO posts (company_id, body) VALUES (?,?)').run(req.company.id, body);
  res.redirect('/feed');
});
app.post('/deals', requireApprovedCompany, (req, res) => {
  const title = String(req.body.title || '').trim();
  const value = Number(req.body.value);
  const terms = String(req.body.terms || '').trim();
  if (!title || !terms || !(value > 0)) { req.session.flash = 'Invalid deal.'; return res.redirect('/feed'); }
  db.prepare('INSERT INTO deals (company_id,title,value_usd,terms) VALUES (?,?,?,?)').run(req.company.id, title, value, terms);
  req.session.flash = 'Your deal is now live in every company\'s timeline.';
  res.redirect('/feed');
});
app.post('/feed/like/:kind/:id', requireApprovedCompany, (req, res) => {
  const id = Number(req.params.id);
  const col = req.params.kind === 'deal' ? 'deal_id' : 'post_id';
  const other = col === 'deal_id' ? 'post_id' : 'deal_id';
  const existing = db.prepare(`SELECT id FROM likes WHERE company_id=? AND ${col}=?`).get(req.company.id, id);
  if (existing) db.prepare('DELETE FROM likes WHERE id=?').run(existing.id);
  else db.prepare(`INSERT INTO likes (company_id,${col}) VALUES (?,?)`).run(req.company.id, id);
  res.redirect('/feed');
});
app.post('/feed/repost/:id', requireApprovedCompany, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT 1 x FROM reposts WHERE deal_id=? AND company_id=?').get(id, req.company.id);
  if (existing) db.prepare('DELETE FROM reposts WHERE deal_id=? AND company_id=?').run(id, req.company.id);
  else db.prepare('INSERT INTO reposts (deal_id,company_id) VALUES (?,?)').run(id, req.company.id);
  res.redirect('/feed');
});
app.post('/feed/comment/:kind/:id', requireApprovedCompany, (req, res) => {
  const body = String(req.body.body || '').trim();
  const id = Number(req.params.id);
  if (body) {
    if (req.params.kind === 'deal') db.prepare('INSERT INTO comments (company_id,deal_id,body) VALUES (?,?,?)').run(req.company.id, id, body);
    else db.prepare('INSERT INTO comments (company_id,post_id,body) VALUES (?,?,?)').run(req.company.id, id, body);
  }
  res.redirect('/feed');
});

/* ---------- COMPANIES + FOLLOW (instagram-style) + SEARCH ---------- */
function companyCard(c, S) {
  const foll = S.followerCounts[c.id] || 0;
  const isFollowing = S.following.has(c.id);
  return `<div class="card" style="display:flex;gap:14px;align-items:center;padding:16px">
    <div class="logo" style="width:46px;height:46px;font-size:18px">${esc(c.name.charAt(0).toUpperCase())}</div>
    <div style="flex:1"><b style="color:#fff">${esc(c.name)}</b><br><span class="mut" style="font-size:12.5px">${esc(c.industry)} · ${esc(c.country)} · <span class="num">${foll}</span> followers</span></div>
    <form method="POST" action="/follow/${c.id}"><button class="btn sm ${isFollowing ? 'ghost' : ''}">${isFollowing ? '✓ Following' : '+ Follow'}</button></form>
  </div>`;
}
app.get('/companies', requireApprovedCompany, (req, res) => {
  const q = String(req.query.q || '').trim();
  const S = socialSets(req.company.id);
  S.followerCounts = countsBy('SELECT following_id AS k, COUNT(*) n FROM follows GROUP BY following_id');
  let rows = db.prepare("SELECT * FROM companies WHERE status='approved' AND id != ? ORDER BY name").all(req.company.id);
  if (q) rows = rows.filter(c => (c.name + ' ' + c.industry + ' ' + c.country).toLowerCase().includes(q.toLowerCase()));
  const myFollowers = db.prepare('SELECT COUNT(*) n FROM follows WHERE following_id=?').get(req.company.id).n;
  const myFollowing = S.following.size;
  res.send(layout('Companies', navFor(req.session) + `
    <div class="card"><h2>Companies</h2><p class="mut">Follow companies to grow your network — you have <b class="num">${myFollowers}</b> followers and follow <b class="num">${myFollowing}</b>.</p>
      <form method="GET" action="/companies" class="cform"><input name="q" value="${esc(q)}" placeholder="Search companies by name, industry, country..."><button class="btn sm">Search</button></form>
    </div>
    ${rows.map(c => companyCard(c, S)).join('') || '<p class="mut">No companies found.</p>'}`));
});
app.post('/follow/:id', requireApprovedCompany, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.company.id) return res.redirect('/companies');
  const existing = db.prepare('SELECT 1 x FROM follows WHERE follower_id=? AND following_id=?').get(req.company.id, id);
  if (existing) db.prepare('DELETE FROM follows WHERE follower_id=? AND following_id=?').run(req.company.id, id);
  else db.prepare('INSERT INTO follows (follower_id,following_id) VALUES (?,?)').run(req.company.id, id);
  res.redirect(req.get('referer') || '/companies');
});
app.get('/search', requireApprovedCompany, (req, res) => {
  const q = String(req.query.q || '').trim();
  const S = socialSets(req.company.id);
  S.followerCounts = countsBy('SELECT following_id AS k, COUNT(*) n FROM follows GROUP BY following_id');
  S.likeCounts = countsBy(`SELECT COALESCE('p'||post_id, 'd'||deal_id) AS k, COUNT(*) n FROM likes GROUP BY 1`);
  S.repostCounts = countsBy('SELECT deal_id AS k, COUNT(*) n FROM reposts GROUP BY deal_id');
  S.comments = commentsGrouped();
  let dealRows = [], coRows = [];
  if (q) {
    const like = '%' + q + '%';
    dealRows = db.prepare(`SELECT d.*, c.name AS company, c.industry FROM deals d JOIN companies c ON c.id=d.company_id WHERE d.title LIKE ? OR d.terms LIKE ? ORDER BY d.id DESC LIMIT 30`).all(like, like);
    coRows = db.prepare("SELECT * FROM companies WHERE status='approved' AND id != ? AND (name LIKE ? OR industry LIKE ? OR country LIKE ?) ORDER BY name LIMIT 30").all(req.company.id, like, like, like);
  }
  res.send(layout('Search', navFor(req.session) + `
    <div class="card"><h2>Search</h2><p class="mut">Find deals and companies across the whole network.</p>
      <form method="GET" action="/search" class="cform"><input name="q" value="${esc(q)}" placeholder="e.g. logistics, pharma, Dubai..."><button class="btn sm">Search</button></form>
    </div>
    ${q ? `<h2 style="margin:6px 0 10px">Deals matching "${esc(q)}"</h2>` + (dealRows.map(d => dealCardHtml(d, req.company.id, S)).join('') || '<p class="mut">No deals found.</p>')
      + `<h2 style="margin:20px 0 10px">Companies matching "${esc(q)}"</h2>` + (coRows.map(c => companyCard(c, S)).join('') || '<p class="mut">No companies found.</p>')
    : ''}`));
});

/* ---------- CONTRACT: terms page → download → sign → closed room ---------- */
app.get('/deal/:id', requireApprovedCompany, (req, res) => {
  const d = db.prepare(`SELECT d.*, c.name AS company, c.industry, c.country FROM deals d JOIN companies c ON c.id=d.company_id WHERE d.id=?`).get(req.params.id);
  if (!d) return res.redirect('/feed');
  const contract = db.prepare('SELECT * FROM contracts WHERE deal_id=?').get(d.id);
  const mine = d.company_id === req.company.id;
  let action = '';
  if (!mine && !contract) {
    action = `<form method="POST" action="/deal/${d.id}/sign"><button class="btn" style="width:100%;padding:14px;font-size:16px">Proceed with signing</button></form>
      <p class="mut" style="text-align:center;margin-top:8px">This opens a private negotiation room with ${esc(d.company)} and sends the contract to the platform owner for approval.</p>`;
  } else if (contract) {
    action = `<div class="row" style="justify-content:center">${pill(contract.status)} <a class="btn" href="/deal/${d.id}/room">Open negotiation room</a></div>`;
  } else {
    action = `<p class="mut" style="text-align:center">This is your deal. Contracts signed by others appear here for tracking.</p>`;
  }
  res.send(layout('Contract terms', navFor(req.session) + `
    <div class="card">
      <div class="row" style="justify-content:space-between;margin-bottom:14px">
        <a class="btn sm ghost" href="/feed">← Timeline</a>
        <a class="btn sm ghost" href="/deal/${d.id}/download">⬇ Download contract (.doc)</a>
      </div>
      <div class="doc">
        <h1>DEAL CONTRACT</h1>
        <div class="sub">Dealzoin Platform · Contract Ref DZ-${String(d.id).padStart(4, '0')} · Generated ${d.created_at}</div>
        <h4>1. Parties</h4>
        <p><b>Party A (Deal owner):</b> ${esc(d.company)}, ${esc(d.country)} — ${esc(d.industry)}</p>
        <p><b>Party B (Signatory):</b> ${esc(req.company.name)} (you)</p>
        <h4>2. Subject</h4>
        <p>${esc(d.title)}</p>
        <h4>3. Contract Value</h4>
        <p>${usd(d.value_usd)} (USD)</p>
        <h4>4. Terms &amp; Conditions</h4>
        <p>${esc(d.terms)}</p>
        <h4>5. Platform Terms</h4>
        <p>5.1 This contract is executed on the Dealzoin platform and becomes binding upon platform owner approval.</p>
        <p>5.2 Both parties confirm they are verified companies with signing authority.</p>
        <p>5.3 Payments are to be arranged through platform-approved escrow. The platform fee is deducted from the contract value upon completion as per the platform owner's current rate.</p>
        <p>5.4 The negotiation room (post-signing) is private to both parties; the platform administrator may view it for dispute resolution.</p>
        <p>5.5 Governing law: the jurisdiction of Party A's registered address, unless otherwise agreed in the negotiation room.</p>
      </div>
      <div style="margin-top:18px">${action}</div>
    </div>`));
});
app.get('/deal/:id/download', requireApprovedCompany, (req, res) => {
  const d = db.prepare(`SELECT d.*, c.name AS company, c.industry, c.country FROM deals d JOIN companies c ON c.id=d.company_id WHERE d.id=?`).get(req.params.id);
  if (!d) return res.redirect('/feed');
  const html = `<html xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>Dealzoin Contract DZ-${d.id}</title>
<style>body{font-family:Georgia,serif;font-size:12pt;line-height:1.5}h1{text-align:center;font-size:18pt}h4{margin-bottom:4px}</style></head><body>
<h1>DEAL CONTRACT</h1><p style="text-align:center">Dealzoin Platform · Ref DZ-${String(d.id).padStart(4, '0')} · ${d.created_at}</p>
<h4>1. Parties</h4><p>Party A (Deal owner): ${d.company}, ${d.country}</p><p>Party B (Signatory): to be completed upon signing</p>
<h4>2. Subject</h4><p>${d.title}</p><h4>3. Contract Value</h4><p>${usd(d.value_usd)} (USD)</p>
<h4>4. Terms &amp; Conditions</h4><p>${d.terms}</p>
<h4>5. Platform Terms</h4><p>5.1 Binding upon platform owner approval. 5.2 Verified companies only. 5.3 Platform-approved escrow; platform fee deducted on completion. 5.4 Private negotiation room; administrator may view for dispute resolution.</p>
</body></html>`;
  res.setHeader('Content-Type', 'application/msword');
  res.setHeader('Content-Disposition', `attachment; filename="Dealzoin-Contract-DZ-${String(d.id).padStart(4, '0')}.doc"`);
  res.send(html);
});
app.post('/deal/:id/sign', requireApprovedCompany, (req, res) => {
  const d = db.prepare('SELECT * FROM deals WHERE id=?').get(req.params.id);
  if (!d) return res.redirect('/feed');
  if (d.company_id === req.company.id) { req.session.flash = 'You cannot sign your own deal.'; return res.redirect('/deal/' + d.id); }
  const existing = db.prepare('SELECT * FROM contracts WHERE deal_id=?').get(d.id);
  if (existing) return res.redirect('/deal/' + d.id + '/room');
  db.prepare('INSERT INTO contracts (deal_id,requester_id) VALUES (?,?)').run(d.id, req.company.id);
  db.prepare('INSERT INTO messages (deal_id,sender_company_id,body) VALUES (?,?,?)')
    .run(d.id, req.company.id, 'Contract request submitted. This room is private between both parties; the platform administrator can view it. Awaiting owner approval of the contract.');
  req.session.flash = 'Contract sent to the platform owner for approval. You can now negotiate in the closed room.';
  res.redirect('/deal/' + d.id + '/room');
});
function roomAccess(req, deal, contract) {
  if (req.session.adminId) return true;
  const cid = req.session.companyId;
  return deal.company_id === cid || (contract && contract.requester_id === cid);
}
app.get('/deal/:id/room', (req, res) => {
  const d = db.prepare(`SELECT d.*, c.name AS company FROM deals d JOIN companies c ON c.id=d.company_id WHERE d.id=?`).get(req.params.id);
  if (!d) return res.redirect('/');
  const contract = db.prepare('SELECT * FROM contracts WHERE deal_id=?').get(d.id);
  if (!roomAccess(req, d, contract)) return res.redirect('/signin');
  const requester = contract ? db.prepare('SELECT name FROM companies WHERE id=?').get(contract.requester_id) : null;
  const msgs = db.prepare(`SELECT m.*, c.name AS company FROM messages m LEFT JOIN companies c ON c.id=m.sender_company_id WHERE m.deal_id=? ORDER BY m.id`).all(d.id);
  const canPost = req.session.adminId || (contract && (contract.status !== 'rejected'));
  const isAdmin = !!req.session.adminId;
  const msgHtml = msgs.map(m => {
    const who = m.sender_admin ? 'Administrator' : m.company;
    const mine = !isAdmin && m.sender_company_id === req.session.companyId;
    return `<div class="msg ${mine ? 'me' : ''}"><div class="who">${esc(who)} · ${m.created_at}</div>${esc(m.body)}</div>`;
  }).join('');
  res.send(layout('Negotiation room', navFor(req.session) + flashBox(req) + `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <div><a class="btn sm ghost" href="/deal/${d.id}">← Contract terms</a></div>
        ${contract ? pill(contract.status) : '<span class="pill pend">no contract</span>'}
      </div>
      <h2 style="margin-top:10px">Closed room — ${esc(d.title)}</h2>
      <p class="mut">Participants: <b style="color:#cbd5e1">${esc(d.company)}</b> (deal owner) &amp; <b style="color:#cbd5e1">${requester ? esc(requester.name) : '—'}</b> (signatory). ${isAdmin ? 'You are viewing as administrator.' : 'Only the platform administrator can also view this room.'}</p>
      <div style="border-top:1px solid #243152;padding-top:14px;margin-top:10px">
        ${msgHtml || '<p class="mut">No messages yet.</p>'}
      </div>
      ${canPost && !isAdmin ? `<form class="cform" method="POST" action="/deal/${d.id}/room/message">
        <input name="body" placeholder="Write a message..." maxlength="500" required>
        <button class="btn sm">Send</button></form>` : ''}
      ${isAdmin ? `<p class="mut" style="margin-top:10px;font-size:12px">Administrator view — read access. Approve or reject the contract from the owner dashboard.</p>` : ''}
    </div>`));
});
app.post('/deal/:id/room/message', requireApprovedCompany, (req, res) => {
  const d = db.prepare('SELECT * FROM deals WHERE id=?').get(req.params.id);
  const contract = d && db.prepare('SELECT * FROM contracts WHERE deal_id=?').get(d.id);
  if (!d || !roomAccess(req, d, contract)) return res.redirect('/signin');
  const body = String(req.body.body || '').trim();
  if (body) db.prepare('INSERT INTO messages (deal_id,sender_company_id,body) VALUES (?,?,?)').run(d.id, req.company.id, body);
  res.redirect('/deal/' + d.id + '/room');
});

/* ---------- MY DEALS ---------- */
app.get('/dashboard', requireApprovedCompany, (req, res) => {
  const deals = db.prepare(`SELECT d.*,
      (SELECT COUNT(*) FROM contracts ct WHERE ct.deal_id=d.id) AS contracts,
      (SELECT COUNT(*) FROM likes l WHERE l.deal_id=d.id) AS likes,
      (SELECT COUNT(*) FROM reposts r WHERE r.deal_id=d.id) AS reposts
    FROM deals d WHERE d.company_id=? ORDER BY d.id DESC`).all(req.company.id);
  res.send(layout('My deals', navFor(req.session) + flashBox(req) + `
    <div class="card"><h2>My deals</h2><p class="mut">Published instantly to all companies. Track signings below.</p>
    ${deals.length ? `<table><tr><th>Title</th><th>Value</th><th>Likes</th><th>Reposts</th><th>Contract requests</th><th></th></tr>
      ${deals.map(d => `<tr><td>${esc(d.title)}</td><td class="num">${usd(d.value_usd)}</td><td>${d.likes}</td><td>${d.reposts}</td><td>${d.contracts}</td>
      <td><a class="btn sm ghost" href="/deal/${d.id}">View</a></td></tr>`).join('')}</table>`
    : '<p class="mut">No deals yet — publish one from the Timeline.</p>'}</div>`));
});

/* ---------- CHANGE PASSWORD ---------- */
function changePasswordPage(req, action) {
  return layout('Change password', navFor(req.session) + flashBox(req) + `
    <div class="center" style="margin-top:0;max-width:480px"><div class="card">
      <h2>Change password</h2><p class="mut">Minimum 8 characters.</p>
      <form method="POST" action="${action}">
        <label>Current password</label><input name="current" type="password" required>
        <label>New password</label><input name="next" type="password" minlength="8" required>
        <label>Confirm new password</label><input name="confirm" type="password" minlength="8" required>
        <button class="btn" style="width:100%">Update password</button>
      </form></div></div>`);
}
function doChange(req, table, idCol, sessionKey, redirectTo) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE ${idCol}=?`).get(req.session[sessionKey]);
  if (!row || !verifyPassword(String(req.body.current || ''), row.salt, row.pass_hash)) {
    req.session.flash = 'Current password is incorrect.'; return res.redirect(redirectTo);
  }
  const next = String(req.body.next || '');
  if (next.length < 8 || next !== String(req.body.confirm || '')) {
    req.session.flash = 'New passwords do not match (min 8 characters).'; return res.redirect(redirectTo);
  }
  const { salt, hash } = hashPassword(next);
  db.prepare(`UPDATE ${table} SET pass_hash=?, salt=? WHERE ${idCol}=?`).run(hash, salt, row[idCol]);
  req.session.flash = 'Password changed successfully.';
  res.redirect(redirectTo);
}
app.get('/admin/password', requireAdmin, (req, res) => res.send(changePasswordPage(req, '/admin/password')));
app.post('/admin/password', requireAdmin, (req, res) => doChange(req, 'admins', 'id', 'adminId', '/admin/password'));
app.get('/password', requireApprovedCompany, (req, res) => res.send(changePasswordPage(req, '/password')));
app.post('/password', requireApprovedCompany, (req, res) => doChange(req, 'companies', 'id', 'companyId', '/password'));

/* ---------- ADMIN (OWNER) DASHBOARD ---------- */
app.get('/admin', requireAdmin, (req, res) => {
  const pendingCos = db.prepare("SELECT * FROM companies WHERE status='pending' ORDER BY id").all();
  const approvedCos = db.prepare("SELECT * FROM companies WHERE status='approved' ORDER BY id DESC LIMIT 30").all();
  const contracts = db.prepare(`SELECT ct.*, d.title, d.value_usd, o.name AS owner, r.name AS requester
      FROM contracts ct JOIN deals d ON d.id=ct.deal_id
      JOIN companies o ON o.id=d.company_id JOIN companies r ON r.id=ct.requester_id
      ORDER BY ct.id DESC LIMIT 50`).all();
  const pendingContracts = contracts.filter(c => c.status === 'pending');
  const counts = {
    pcos: db.prepare("SELECT COUNT(*) n FROM companies WHERE status='pending'").get().n,
    acos: db.prepare("SELECT COUNT(*) n FROM companies WHERE status='approved'").get().n,
    pctr: db.prepare("SELECT COUNT(*) n FROM contracts WHERE status='pending'").get().n,
    gmv: db.prepare("SELECT COALESCE(SUM(value_usd),0) n FROM contracts ct JOIN deals d ON d.id=ct.deal_id WHERE ct.status='approved'").get().n
  };
  res.send(layout('Owner dashboard', navFor(req.session) + flashBox(req) + `
    <div class="grid">
      <div class="kpi"><div class="v">${counts.pcos}</div><div class="l">Pending registrations</div></div>
      <div class="kpi"><div class="v">${counts.acos}</div><div class="l">Approved companies</div></div>
      <div class="kpi"><div class="v">${counts.pctr}</div><div class="l">Pending contracts</div></div>
      <div class="kpi"><div class="v num">${usd(counts.gmv)}</div><div class="l">Approved contract value</div></div>
    </div>

    <div class="card"><h2>Pending registrations (${pendingCos.length})</h2>
      ${pendingCos.length ? `<table><tr><th>Company</th><th>Country</th><th>Industry</th><th>Email</th><th>Applied</th><th></th></tr>
      ${pendingCos.map(c => `<tr><td><b>${esc(c.name)}</b></td><td>${esc(c.country)}</td><td>${esc(c.industry)}</td><td>${esc(c.email)}</td><td class="mut">${c.created_at}</td>
        <td class="row"><form method="POST" action="/admin/company/${c.id}/approve"><button class="btn sm green">Approve</button></form>
        <form method="POST" action="/admin/company/${c.id}/reject"><button class="btn sm red">Reject</button></form></td></tr>`).join('')}</table>`
      : '<p class="mut">No pending registrations.</p>'}</div>

    <div class="card"><h2>Pending contracts (${pendingContracts.length})</h2>
      ${pendingContracts.length ? pendingContracts.map(c => `<div style="border:1px solid #243152;border-radius:10px;padding:14px;margin-top:10px">
        <div class="row" style="justify-content:space-between"><b>${esc(c.title)}</b><span class="pill ok">${usd(c.value_usd)}</span></div>
        <p class="mut" style="margin:6px 0">${esc(c.owner)} ⇄ ${esc(c.requester)} · requested ${c.created_at}</p>
        <div class="row" style="margin-top:10px">
          <a class="btn sm ghost" href="/deal/${c.deal_id}">Contract terms</a>
          <a class="btn sm ghost" href="/deal/${c.deal_id}/room">View closed room</a>
          <form method="POST" action="/admin/contract/${c.id}/approve"><button class="btn sm green">Approve contract</button></form>
          <form method="POST" action="/admin/contract/${c.id}/reject"><button class="btn sm red">Reject</button></form>
        </div></div>`).join('')
      : '<p class="mut">No pending contracts.</p>'}</div>

    <div class="grid" style="grid-template-columns:1fr 1fr">
      <div class="card"><h2>Approved companies</h2>
        ${approvedCos.length ? `<table><tr><th>Name</th><th>Industry</th><th>Joined</th></tr>
        ${approvedCos.map(c => `<tr><td>${esc(c.name)}</td><td class="mut">${esc(c.industry)}</td><td class="mut">${c.created_at}</td></tr>`).join('')}</table>` : '<p class="mut">None yet.</p>'}</div>
      <div class="card"><h2>All contracts</h2>
        ${contracts.length ? `<table><tr><th>Deal</th><th>Parties</th><th>Value</th><th>Status</th></tr>
        ${contracts.map(c => `<tr><td>${esc(c.title)}</td><td class="mut">${esc(c.owner)} ⇄ ${esc(c.requester)}</td><td class="num">${usd(c.value_usd)}</td><td>${pill(c.status)}</td></tr>`).join('')}</table>` : '<p class="mut">None yet.</p>'}</div>
    </div>`));
});
app.post('/admin/company/:id/approve', requireAdmin, (req, res) => {
  db.prepare("UPDATE companies SET status='approved' WHERE id=? AND status='pending'").run(req.params.id);
  req.session.flash = 'Company approved — it can now sign in and trade.'; res.redirect('/admin');
});
app.post('/admin/company/:id/reject', requireAdmin, (req, res) => {
  db.prepare("UPDATE companies SET status='rejected' WHERE id=? AND status='pending'").run(req.params.id);
  req.session.flash = 'Company rejected.'; res.redirect('/admin');
});
app.post('/admin/contract/:id/approve', requireAdmin, (req, res) => {
  db.prepare("UPDATE contracts SET status='approved' WHERE id=? AND status='pending'").run(req.params.id);
  const ct = db.prepare('SELECT deal_id FROM contracts WHERE id=?').get(req.params.id);
  if (ct) db.prepare('INSERT INTO messages (deal_id,sender_admin,body) VALUES (?,?,?)')
    .run(ct.deal_id, 1, 'The platform owner has APPROVED this contract. It is now binding. Arrange payment via platform escrow.');
  req.session.flash = 'Contract approved — both parties have been notified in their room.'; res.redirect('/admin');
});
app.post('/admin/contract/:id/reject', requireAdmin, (req, res) => {
  db.prepare("UPDATE contracts SET status='rejected' WHERE id=? AND status='pending'").run(req.params.id);
  const ct = db.prepare('SELECT deal_id FROM contracts WHERE id=?').get(req.params.id);
  if (ct) db.prepare('INSERT INTO messages (deal_id,sender_admin,body) VALUES (?,?,?)')
    .run(ct.deal_id, 1, 'The platform owner has REJECTED this contract request. You may renegotiate in this room.');
  req.session.flash = 'Contract rejected — parties notified in their room.'; res.redirect('/admin');
});

app.listen(PORT, () => console.log('Dealzoin v2 running → http://localhost:' + PORT));
