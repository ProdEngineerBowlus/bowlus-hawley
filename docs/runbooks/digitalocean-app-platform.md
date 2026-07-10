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
HAWLEY_ASANA_PORTFOLIO_SCOPE=both
HAWLEY_ASANA_EVENT_WATCH_IN_WEB=true
HAWLEY_ASANA_EVENT_INTERVAL_MS=60000
HAWLEY_ASANA_EVENT_BUILD_HB=true
HAWLEY_ASANA_INCLUDE_SUBTASKS=true
HAWLEY_ASANA_SUBTASK_DEPTH=1
HAWLEY_ASANA_COMPLETED_SINCE=1970-01-01T00:00:00.000Z
HAWLEY_NIGHTLY_REFRESH_ENABLED=true
HAWLEY_NIGHTLY_REFRESH_TIME=01:00
HAWLEY_NIGHTLY_REFRESH_TIME_ZONE=America/Los_Angeles
HAWLEY_NIGHTLY_REFRESH_SCRIPT=pg:refresh-worker-read-model
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

The web service also starts the fast Worker Daily Task Actuals watcher in
production. It is read-only against Airtable and keeps Hawley's logged-time
overlay fresher without running the full Airtable bootstrap mirror every minute.

That watcher runs:

```powershell
node ./apps/postgres-sync/src/pull-worker-daily-actuals.js --loop --interval-ms 60000
```

It pulls only Airtable `Worker Daily Task Actuals` rows in a recent Work Date
window into `raw.airtable_worker_daily_actuals` and
`hb.worker_daily_task_actuals`. This is the bridge path while the current shop
worker app still writes timer actuals to Airtable first.

Startup rules:

- `NODE_ENV=production` starts the watcher by default.
- `HAWLEY_ASANA_EVENT_WATCH_IN_WEB=false` disables it.
- `HAWLEY_ASANA_EVENT_WATCH_IN_WEB=true` enables it explicitly.
- `HAWLEY_WORKER_ACTUALS_WATCH_IN_WEB=false` disables the Worker Daily Task
  Actuals watcher.
- `HAWLEY_WORKER_ACTUALS_INTERVAL_MS=60000` sets its one-minute cadence.
- `HAWLEY_WORKER_ACTUALS_WINDOW_DAYS=14` limits the past Work Date window.
- `HAWLEY_WORKER_ACTUALS_FUTURE_DAYS=2` keeps near-future rows in the mirror.
- `ASANA_PAT` and `HAWLEY_SYNC_DATABASE_URL` or
  `HAWLEY_MIGRATION_DATABASE_URL` must be present.

Status endpoints:

```text
GET /api/health
GET /api/sync-status
```

`/api/sync-status` returns watcher pid/running states plus the latest
`sync.run_log` entries for Airtable, Worker Daily Task Actuals, Asana, Asana
events, and Daily Assignment Tracker mirroring. The manager dashboard also shows
these signals in the `HB freshness` panel.

Later, after cost/ownership is confirmed, the same watcher can move to a
separate App Platform Worker component with:

```powershell
npm run pg:watch:asana-events
```

A nightly legacy Airtable refresh can be added as an App Platform scheduled job
running:

```powershell
npm run pg:refresh-legacy-airtable-bootstrap
```

Do not add the Worker component or scheduled job without explicit approval,
because either can change the App Platform bill or resource layout.

The web service also schedules a nightly Hawley worker read-model refresh at
1:00 AM Pacific by default in production:

```powershell
npm run pg:refresh-worker-read-model
```

That refresh runs `pg:pull:asana`, `pg:build:hb`, and `pg:pull:daily-tracker`.
It writes only to Hawley/Postgres mirror and read-model tables; it does not
write to Asana or Airtable. `/api/sync-status` reports the scheduler state under
`watchers.nightlyRefresh`, including the next scheduled run time.

## Health Checks

Root page:

```text
GET /
```

Expected: `200 OK` with the Daily Assignments shell.

Read-only beta/debug page:

```text
GET /beta.html
```

Expected: `200 OK` with the Hawley Beta Lab. This page is safe for diagnostics
because it only calls GET endpoints and does not expose worker task controls or
refresh/adoption controls.

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
current Asana event and Worker Daily Task Actuals watcher states.
