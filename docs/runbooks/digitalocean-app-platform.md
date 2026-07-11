# DigitalOcean App Platform Pilot

This runbook tracks the first cloud deployment of the Hawley worker page.

## Current Resources

- DigitalOcean project: `Bowlus Shop Operations`
- App Platform app: `bowlus-hawley`
- Public app URL: `https://bowlus-hawley-9s6iw.ondigitalocean.app`
- Managed Postgres cluster: `hawley-pg-prod`
- Region: `SFO3`
- Database: `bowlus_ops`
- Runtime database user: `bowlus_app`

The app is built from:

```text
ProdEngineerBowlus/bowlus-hawley
```

with:

```text
Build command: npm ci
Run command: npm run worker:hawley
```

## Runtime Environment

Required App Platform runtime variables:

```text
DATABASE_URL=${<database-component-name>.DATABASE_URL}
HAWLEY_SYNC_DATABASE_URL=<sync-or-admin database URL>
NODE_ENV=production
HAWLEY_DRY_RUN=true
HAWLEY_ALLOW_SOURCE_WRITES=false
HAWLEY_WORKER_HOST=0.0.0.0
ASANA_PAT=<secret>
AIRTABLE_PAT=<secret>
AIRTABLE_BASE=<secret>
HAWLEY_AIRTABLE_TASKS_TABLE=Tasks
HAWLEY_AIRTABLE_PRODUCTION_TABLE=Production
HAWLEY_ASANA_PORTFOLIO_SCOPE=both
HAWLEY_ASANA_EVENT_WATCH_IN_WEB=true
HAWLEY_ASANA_EVENT_INTERVAL_MS=60000
HAWLEY_ASANA_EVENT_BUILD_HB=true
HAWLEY_WORKER_ACTUALS_WATCH_IN_WEB=false
HAWLEY_ASANA_INCLUDE_SUBTASKS=true
HAWLEY_ASANA_SUBTASK_DEPTH=1
HAWLEY_ASANA_COMPLETED_SINCE=1970-01-01T00:00:00.000Z
HAWLEY_NIGHTLY_REFRESH_ENABLED=true
HAWLEY_NIGHTLY_REFRESH_TIME=01:00
HAWLEY_NIGHTLY_REFRESH_TIME_ZONE=America/Los_Angeles
HAWLEY_NIGHTLY_REFRESH_SCRIPT=pg:refresh-hawley-read-model
HAWLEY_NIGHTLY_AIRTABLE_BACKFILL_ENABLED=true
HAWLEY_NIGHTLY_AIRTABLE_BACKFILL_APPLY=true
HAWLEY_NIGHTLY_AIRTABLE_BACKFILL_SCRIPT=pg:backfill:airtable-worker-actuals
HAWLEY_NIGHTLY_AIRTABLE_BACKFILL_WINDOW_DAYS=2
HAWLEY_AUTH_ACTIVE=false
HAWLEY_AUTH_SEED_ROSTER_ON_START=true
HAWLEY_AUTH_SESSION_TTL_HOURS=12
HAWLEY_AUTH_MANAGER_EMAILS=
HAWLEY_AUTH_ADMIN_EMAILS=
HAWLEY_AUTH_BOOTSTRAP_ENABLED=false
HAWLEY_AUTH_BOOTSTRAP_EMAIL=
HAWLEY_AUTH_BOOTSTRAP_PASSWORD=
```

Do not commit real token values. Use the Shop Ops `.env` only as a local
credential pointer.

`DATABASE_URL` is the low-privilege runtime connection for the web app. Keep it
on `bowlus_app`.

`HAWLEY_SYNC_DATABASE_URL` is used only by the `apps/postgres-sync` scripts and
should point at a database user that can create schemas/tables and write mirror
data during bootstrap, such as the DigitalOcean admin user or a properly granted
`bowlus_sync` user. Store it as an encrypted App Platform variable. Do not paste
the value into chat or commit it.

`HAWLEY_AUTH_ACTIVE=false` keeps the installed employee login system inactive.
When ready to test account login, set `HAWLEY_AUTH_ACTIVE=true`, configure
`HAWLEY_AUTH_MANAGER_EMAILS` or `HAWLEY_AUTH_ADMIN_EMAILS`, and use the
`HAWLEY_AUTH_BOOTSTRAP_*` values only long enough to create the first active
admin password. Remove the bootstrap password env value after the first admin
login works.

Employee accounts seeded from `hb.work_force` remain inactive until activated.
Use `npm run pg:hawley-auth-user -- list` to inspect users, and set
`HAWLEY_AUTH_PASSWORD` before running this for a test employee:

```powershell
npm run pg:hawley-auth-user -- set-password <email> --active --role=worker
```

## Database URL Binding

DigitalOcean bindable variables must use the database component name from the
App Platform app spec, not the managed database cluster name unless they are the
same. Examples:

```text
DATABASE_URL=${db.DATABASE_URL}
DATABASE_URL=${hawley-pg-prod.DATABASE_URL}
DATABASE_URL=${base.DATABASE_URL}
```

Use the exact component prefix shown by App Platform for the attached database.

If `/api/health` returns this shape:

```json
{
  "ok": false,
  "error": "getaddrinfo ENOTFOUND base",
  "code": "ENOTFOUND"
}
```

then the app is likely receiving a literal bindable value such as
`${base.DATABASE_URL}` instead of the resolved Postgres connection string. Fix
this in the App Platform Settings page by editing `DATABASE_URL` as a normal
environment-variable row/value for the service or app. Also check for duplicate
`DATABASE_URL` entries; component-level variables override app-level variables.

Hawley's shared Postgres config strips DigitalOcean's sample
`/path/to/ca-certificate.crt` SSL file placeholder if it is left in the URL, but
the preferred App Platform value should still omit `sslrootcert` and keep only
`sslmode=require`. The same config adds `uselibpqcompat=true` for
`sslmode=require` URLs so Node's Postgres driver uses encrypted SSL without
requiring a CA bundle file inside the App Platform container.

After saving environment variable changes, redeploy the app and re-check:

```powershell
Invoke-WebRequest https://bowlus-hawley-9s6iw.ondigitalocean.app/api/health
```

## First Data Load

After the deployed app can connect to Postgres, the cloud database still needs
the Hawley schema and mirror data:

```powershell
npm run pg:bootstrap-cloud
```

Run these from an App Platform console or trusted cloud job using a database
user with migration/write privileges. Keep `HAWLEY_ALLOW_SOURCE_WRITES=false`;
these commands write to Hawley Postgres only, not back to Airtable or Asana.

`pg:bootstrap-cloud` runs the first-load sequence in order:

```text
pg:migrate
pg:pull:airtable
pg:normalize
pg:pull:asana
pg:build:hb
pg:pull:daily-tracker
```

After the first bootstrap, use the faster one-minute or manual worker refresh
path:

```powershell
npm run pg:refresh-worker-read-model
```

If the runtime `bowlus_app` user does not have enough privileges to migrate,
set encrypted `HAWLEY_SYNC_DATABASE_URL` to the sync/migration database user.
The web app will continue to use lower-privilege `DATABASE_URL`; the bootstrap
scripts use `HAWLEY_SYNC_DATABASE_URL` when it is present.

The worker web service also verifies runtime read grants at startup when
`HAWLEY_SYNC_DATABASE_URL` is present. This startup step only grants read access
on Hawley/Postgres schemas to `bowlus_app` and `bowlus_readonly`; it does not run
bootstrap imports and does not read or write Airtable or Asana.

## Cloud Freshness

For the first App Platform pilot, the web service starts the Asana event watcher
inside the same container instead of adding a separate App Platform Worker
component. This keeps the pilot on the existing web-service footprint while the
app count is still one instance.

The watcher runs:

```powershell
node ./apps/postgres-sync/src/pull-asana-events.js --loop --interval-ms 60000
```

It reads Asana event streams for the imported portfolio projects, refreshes
changed task rows in Hawley/Postgres, and rebuilds HB when task changes are
found. It does not write to Asana or Airtable.

The web service must not start the old Worker Daily Task Actuals Airtable
puller. Hawley Worker live pages read and write Postgres only. Worker actuals
on screen come from Hawley-owned rows in `hb.worker_daily_task_actuals` with
`source_system = 'hawley_worker_live_pilot'`.

Startup rules:

- `NODE_ENV=production` starts the watcher by default.
- `HAWLEY_ASANA_EVENT_WATCH_IN_WEB=false` disables it.
- `HAWLEY_ASANA_EVENT_WATCH_IN_WEB=true` enables it explicitly.
- `HAWLEY_WORKER_ACTUALS_WATCH_IN_WEB=false` is retained as a safety/env marker;
  the web service ignores this old Airtable puller path.
- `ASANA_PAT` and `HAWLEY_SYNC_DATABASE_URL` or
  `HAWLEY_MIGRATION_DATABASE_URL` must be present.

Status endpoints:

```text
GET /api/health
GET /api/sync-status
```

`/api/sync-status` returns watcher pid/running states plus the latest
`sync.run_log` entries for Asana, Asana events, Daily Assignment Tracker
mirroring, and the overnight Airtable backfill. The manager dashboard also shows
these signals in the `HB freshness` panel.

Later, after cost/ownership is confirmed, the same watcher can move to a
separate App Platform Worker component with:

```powershell
npm run pg:watch:asana-events
```

A nightly legacy Airtable bootstrap pull can be run separately when historical
support-table mirrors need refreshing, but it is not part of Worker Page live
truth:

```powershell
npm run pg:refresh-legacy-airtable-bootstrap
```

The intended Airtable direction for worker actuals is the opposite: Hawley feeds
the legacy Airtable `Worker Daily Task Actuals` table overnight for human
readability. As of July 11, 2026, Jacob approved running this from the existing
web service after the 1:00 a.m. HB refresh succeeds:

```powershell
npm run pg:backfill:airtable-worker-actuals -- --apply
```

The scheduler reports this as `watchers.nightlyAirtableBackfill`. The child
process writes only when `HAWLEY_NIGHTLY_AIRTABLE_BACKFILL_APPLY=true`; the web
request path still does not read from or write to Airtable.

Do not add a separate App Platform Worker component without explicit approval,
because that can change the App Platform bill or resource layout.

The web service also schedules a nightly Hawley worker read-model refresh at
1:00 AM Pacific by default in production:

```powershell
npm run pg:refresh-worker-read-model
```

That refresh runs `pg:pull:asana`, `pg:build:hb`, and `pg:pull:daily-tracker`.
It writes only to Hawley/Postgres mirror and read-model tables; it does not
write to Asana or Airtable. When the refresh exits cleanly, the chained Airtable
backfill exports the latest Hawley-owned worker actual rows to Airtable.
`/api/sync-status` reports the scheduler state under `watchers.nightlyRefresh`
and `watchers.nightlyAirtableBackfill`.

## Health Checks

Root page:

```text
GET /
```

Expected: `200 OK` with the Daily Assignments shell.

Task-control safe reporting view:

```text
GET /beta.html
```

Expected: `200 OK` with the Hawley Reporting View. This page is safe as a task
control surface because it does not expose worker task controls or
refresh/adoption controls. It is opened from manager cycle/day history tiles
after a workday is selected. Its first screen is a day/line phase overview;
worker, task, transition, and review detail appears only after selecting a
phase. Transition review buttons, when enabled, write only to Hawley's Postgres
review tables.

For larger beta work, create a separate App Platform app or component from a
dedicated Git branch such as `beta`. Keep the staging environment pointed at the
same database with a read-only/runtime database user, and set:

```text
HAWLEY_WORKER_WRITES_ENABLED=false
HAWLEY_WORKER_WRITE_IDS=
HAWLEY_ALLOW_SOURCE_WRITES=false
HAWLEY_DRY_RUN=true
```

Do not reuse the live worker-write settings on staging until a specific write
test is approved. Staging should be the place to test new reports, hidden
manager review screens, and page navigation before they move to the active
worker app.

Database health:

```text
GET /api/health
```

Expected after migration/load: `ok: true` plus row counts for the worker read
model, Daily Assignment Tracker mirror, workforce mirror, HB actuals, and the
current Asana event watcher and nightly HB refresh states.
