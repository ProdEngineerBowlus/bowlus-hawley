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

After saving environment variable changes, redeploy the app and re-check:

```powershell
Invoke-WebRequest https://bowlus-hawley-9s6iw.ondigitalocean.app/api/health
```

## First Data Load

After the deployed app can connect to Postgres, the cloud database still needs
the Hawley schema and mirror data:

```powershell
npm run pg:migrate
npm run pg:refresh-worker-read-model
```

Run these from an App Platform console or trusted cloud job using a database
user with migration/write privileges. Keep `HAWLEY_ALLOW_SOURCE_WRITES=false`;
these commands write to Hawley Postgres only, not back to Airtable or Asana.

If the runtime `bowlus_app` user does not have enough privileges to migrate,
use the sync/migration database user for the load step, then leave the web app
on the lower-privilege runtime user.

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
