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
HAWLEY_ASANA_EVENT_INTERVAL_MS=60000
HAWLEY_ASANA_EVENT_BUILD_HB=true
HAWLEY_ASANA_INCLUDE_SUBTASKS=true
HAWLEY_ASANA_SUBTASK_DEPTH=1
HAWLEY_ASANA_COMPLETED_SINCE=1970-01-01T00:00:00.000Z
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

## Health Checks

Root page:

```text
GET /
```

Expected: `200 OK` with the Daily Assignments shell.

Database health:

```text
GET /api/health
```

Expected after migration/load: `ok: true` plus row counts for the worker read
model, Daily Assignment Tracker mirror, workforce mirror, and HB actuals.
