# Hawley — agent instructions

Hawley is Bowlus's planning system and the record of what happened. Asana runs the day-to-day shop work, and Hawley releases that work into Asana. Read `ONBOARDING.md` for how releases, gates and departments work.

## Rules (non-negotiable)
- **Never put credential values** in files, commits, GitHub, chat or agent messages. Don't print secrets to the terminal output you report. Fetch credentials at runtime with `doctl`, as `scripts/hawley-db.mjs` does.
- Sign in the normal way. Never pull tokens out of browser sessions. Never type passwords for the user.
- Don't reset old checkouts that have uncommitted work, overwrite backups, turn Airtable jobs back on, cancel accounts, or delete history to save time. **Airtable is not approved for cancellation.**
- Don't create work that workers can see without a controlled test plan.
- **Production writes have one owner at a time.** This covers releases, gate passes, role changes and data fixes. Check with Jacob or Erick before writing.
- **Every merge to `main` deploys to production** on DigitalOcean. Work on a branch, open a PR, and merge only after the user says "Allowed, merge it" (or clearly approves).
- Keep replies short, 2–3 sentences, unless asked for more.

## Commands
- `npm test` runs the unit tests and the embedded-Postgres checks (PGlite). They must pass before a PR. Put temporary tests in `apps/postgres-sync/test/_tmp_*.mjs` and delete them afterwards.
- `gh` is signed in as the shared ProdEngineerBowlus account. The repo is `ProdEngineerBowlus/bowlus-hawley`.
- `doctl`:
  - App: `b56a733a-3704-4537-8e43-560675c9cdae`
  - Database: `3173c8b8-455b-423f-a86f-a90a322a18ef` (db `bowlus_ops`)
  - Deploys: `doctl apps list-deployments <app>`
  - Logs: `doctl apps logs <app> --type run`

## Production database
- Read-only queries (safe at any time): `node scripts/hawley-db.mjs query <file.sql>`
  - These run as `bowlus_readonly`, which can't read the `raw`, `core` or `sync` schemas.
- Admin commands: `node scripts/hawley-db.mjs admin -- <command>`
  - These run with `HAWLEY_SYNC_DATABASE_URL` set to the admin connection. They are production writes, so confirm with the user first.
  - List app users: `node scripts/hawley-db.mjs admin -- npm run pg:hawley-auth-user -- list`
  - Change a role: `node scripts/hawley-db.mjs admin -- npm run pg:hawley-auth-user -- set-role <email> <worker|manager|admin>`
  - First-time password: the user sets `HAWLEY_AUTH_PASSWORD` in their own shell, then runs `set-password <email> --active --role=<role>`.
- Startup applies new `db/migrations/*.sql` once, then re-applies `db/views`. Schema changes go in a new numbered migration.

## Code map
- `apps/hawley-worker-page/server.js`: the worker page, admin API and background jobs (automatic release, Frames gate auto-pass).
- `apps/hawley-worker-page/public/admin.js` and `admin.html`: the Admin UI. Bump the `admin.js?v=` cache key when you change it.
- `apps/hawley-worker-page/phase-release.js` and `handoffs.js`: pure logic, each with tests in `apps/hawley-worker-page/test/`.
- `apps/postgres-sync/src`: Asana and Airtable pulls, the HB build (`build-hb.js`) and the auth CLI (`hawley-auth-user.js`).
- `docs/runbooks/`: operating runbooks. `docs/hawley-database-schema.md` describes the tables.
