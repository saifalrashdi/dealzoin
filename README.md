# Dealzoin — real platform (v1)

A working B2B platform: company registration with **owner approval**, company login,
deal/contract submission with **owner approval**, and an **owner dashboard**.
Real database, hashed passwords, sessions — no demo tricks.

## Run locally

    npm install
    npm start          → http://localhost:3000

On first run the owner account is created and printed to the console:

    email:    admin@dealzoin.com
    password: Dealzoin@2026

**Sign in as admin and change the password immediately** (top right → Change password).
Override defaults before first run instead:

    ADMIN_EMAIL=you@dealzoin.com ADMIN_PASSWORD='a-long-secret' npm start

## The flow

1. `/signup` — company registers → status **pending** (cannot sign in to trade yet)
2. You sign in at `/signin` → **Owner dashboard** shows:
   - Pending registrations → Approve / Reject
   - Pending contracts → Approve / Reject
   - Approved companies, all contracts, KPIs
3. Approved company signs in → posts a deal → appears in your **pending contracts** queue
4. You approve → the deal is live (marketplace feed comes next)

## Deploy (so dealzoin.com serves THIS, not the demo)

Any Node host works. On **Render** (free tier OK):
1. New → Web Service → connect your repo (push this folder to GitHub first)
2. Build command: `npm install` · Start command: `node server.js`
3. Environment variables: `ADMIN_EMAIL`, `ADMIN_PASSWORD` (strong!), `SESSION_SECRET` (long random), `PORT=3000`
4. Add a persistent disk (mount `/var/data`) and set the DB path via env if you want data to survive redeploys — or move to managed Postgres later
5. Custom domain: add `dealzoin.com` in Render → point DNS (A/CNAME per Render's instructions) → HTTPS automatic

## Production checklist before real companies join

- [ ] Change admin password / set strong env credentials
- [ ] Set `SESSION_SECRET` and add `cookie: { secure: true }` behind HTTPS (one-line change in server.js once SSL is on)
- [ ] Replace in-memory session store with Redis/pg when you scale (sessions drop on restart otherwise)
- [ ] Email notifications on approval/rejection (Mailgun/Resend — ~20 lines)
- [ ] Backups of `dealzoin.db` (nightly copy — it IS your business data)
- [ ] Then: marketplace feed, escrow payments, the three AI agents (specs in /connectb2b)

## Files

    server.js        entire app: db, auth, admin, company routes, UI
    package.json     dependencies (express, express-session, better-sqlite3)
    .env.example     which env vars to set
    dealzoin.db      created automatically on first run (SQLite)
