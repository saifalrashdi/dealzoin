# Dealzoin — real platform (v2)

Working B2B network. Companies register → owner approves → they post deals live to
every company's timeline, like/comment/repost, search deals & companies, follow
companies (instagram-style), sign contracts through a terms page with document
download, negotiate in a private closed room, and the owner gives final approval.

## Run locally

    npm install
    npm start          → http://localhost:3000

First-run admin (printed to console): `admin@dealzoin.com` / `Dealzoin@2026` —
override with env vars ADMIN_EMAIL / ADMIN_PASSWORD, and change the password after
first sign-in.

## Feature map

| # | You asked | Where |
|---|---|---|
| 1-3 | Post deals, visible to all instantly | Timeline composer (publish deal) |
| 4 | See all companies' deals | Timeline + Companies + Search |
| 5 | Search deals | Search page (title & terms) |
| 6 | Search companies, follow (instagram) | Companies page — instant Follow, counts |
| 7 | Like / repost / comment / sign on deals | Every deal card in the timeline |
| 8 | Terms page + download + Proceed | `/deal/:id` → Download (.doc) → Proceed with signing |
| 9 | Closed room: both parties + admin view | `/deal/:id/room` (others are bounced to sign-in) |
| 10 | Contract goes to admin for approval | Owner dashboard → Pending contracts → Approve/Reject (parties get notified in the room) |

Admin dashboard also shows: pending registrations, approve/reject companies,
approved companies, all contracts, approved contract value.

## Deploy

Push to GitHub → Render web service (build `npm install`, start `node server.js`) →
custom domain dealzoin.com. Env vars: ADMIN_EMAIL, ADMIN_PASSWORD, SESSION_SECRET, PORT, NODE_VERSION=20.

## Known limits (free Render tier)

- SQLite file lives on Render's ephemeral disk → data resets on redeploys. Fine for
  testing; before real users, move the DB to persistent disk or managed Postgres.
- Sessions are in-memory → everyone is logged out when the server restarts.
- No email notifications yet (flash messages inside the app only).
- Next: platform fee % on approved contracts + the three AI agents.
