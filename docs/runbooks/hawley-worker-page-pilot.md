# Hawley Worker Page Pilot

The Hawley worker page is a read-only pilot clone of the Daily Worker App. It
uses Hawley/Postgres instead of live Airtable and live Asana reads.

## Boundary

This pilot does not start timers, complete tasks, create Asana time tracking
entries, or rebuild Daily Assignment Tracker. It reads local Hawley tables and
reporting views only.

Timer and completion writes should be added only after Hawley has a first-class
worker session ledger and an approved Asana push path.

## Read Model

The app prefers Hawley's HB worker-page read model:

```sql
reporting.hawley_worker_page_assignments
```

That view is built from HB-owned Rev1 task rows with fresh Asana portfolio
overlays for assignment, completion, source-task estimates, actual time, cycle,
phase, VIN, and source links. This keeps the cloned worker page DB-only while
making Hawley the fast source of truth instead of Airtable or the legacy Daily
Assignment Tracker snapshot.

Mirrored Daily Assignment Tracker rows still exist in Hawley/Postgres:

```sql
raw.asana_tasks
```

where `project_gid` is the Daily Assignment Tracker project
`1214157321063250`. Those rows are used as a fallback when HB has no dated
assignment rows, for cycle/day comparison, and for parity debugging against the
current worker app. The worker page must not call the Asana API at runtime.

Daily efficiency also depends on mirrored worker actuals from:

```sql
raw.airtable_worker_daily_actuals
```

Those rows come from Airtable `Worker Daily Task Actuals`. Hawley overlays task
actuals and daily summary logged minutes from that table so the worker detail
page does not under-report a person who has same-day WIP or recovered timer
minutes outside completed source-task time.

Cycle day chips come from Hawley's reporting calendar:

```sql
reporting.hawley_cycle_calendar
```

That view is built inside Hawley/Postgres from mirrored source data. The worker
page reads this view so the UI uses a Hawley-owned calendar boundary rather than
live Airtable or raw source-table logic.

If no DAT snapshot exists for the selected date, the app falls back to:

```sql
reporting.hawley_worker_page_assignments
reporting.work_force_capability_levels
```

That view enriches `reporting.daily_worker_assignments` with:

- source Asana permalink
- Airtable SOP/document links
- Asana completion state
- inferred work area from the operational capability map
- source sync timestamp

Manager mode uses active records from Hawley's mirrored `Work Force` data in
`raw.airtable_work_force`, as the strict employee roster. Dated assignment
rows are attached only to those Work Force workers. By default, the API returns
only workers with visible work for the selected day so manager output matches
the current worker app. Add `includeNoWork=true`, or set
`HAWLEY_WORKER_INCLUDE_NO_WORK=true`, when a full active-roster health check is
needed.

Hawley source-task hours can intentionally differ from the legacy worker app
when the Daily Assignment Tracker snapshot is stale. In that case, task IDs and
completion state should be compared first; DAT-only assigned-hour differences
mean the legacy snapshot needs a rebuild or should be treated as stale.

The browser assets in `apps/hawley-worker-page/public` are intentionally copied
from the current Shop Ops `apps/daily-worker-app` UI so the pilot looks and
behaves like the existing worker page while the backend reads Hawley/Postgres.

## Commands

Apply database migrations/views first:

```powershell
npm run pg:migrate
```

Refresh the read model after Airtable changes:

```powershell
npm run pg:pull:airtable
npm run pg:normalize
```

Refresh Asana completion/permalink context and DAT snapshots:

```powershell
npm run pg:pull:asana
npm run pg:pull:daily-tracker
```

`pg:pull:daily-tracker` also refreshes source tasks referenced by the DAT
snapshot payload so worker-page completion status can match the current app
without a full portfolio pull.

For the DB-only worker page pilot, the repeatable freshness command is:

```powershell
npm run pg:refresh-worker-read-model
```

That updates Airtable support tables, normalizes Hawley task rows, then mirrors
the Daily Assignment Tracker snapshot and referenced source tasks. Use the
broader command when the full Asana portfolio mirror also needs to be refreshed:

```powershell
npm run pg:refresh-all
```

Start the pilot:

```powershell
npm run worker:hawley
```

Default URL:

```text
http://127.0.0.1:5273
```

Worker pages use the familiar pattern:

```text
http://127.0.0.1:5273?employee=<worker-slug>
```

## API

```text
GET /api/health
GET /api/daily-assignments?date=YYYY-MM-DD
GET /api/daily-assignments?date=YYYY-MM-DD&includeNoWork=true
GET /api/daily-assignments?date=YYYY-MM-DD&employee=<worker-slug>
GET /api/auth-status
GET /api/alert-status
GET /api/refresh-daily-tracker
POST /api/refresh-daily-tracker
POST /api/worker-task-action
```

The `POST` endpoints intentionally return read-only pilot errors.

## Configuration

```text
HAWLEY_WORKER_HOST=127.0.0.1
HAWLEY_WORKER_PORT=5273
HAWLEY_DAILY_TRACKER_PROJECT_GID=1214157321063250
HAWLEY_WORKER_INCLUDE_NO_WORK=false
```

The app uses the same Postgres environment variables as the Hawley sync scripts:

```text
PGHOST
PGPORT
PGDATABASE
PGUSER
PGPASSWORD
DATABASE_URL
```

## Source Health

The worker page must stay DB-only. Do not add live Airtable or Asana fallback
reads to the page itself, because that would hide stale Hawley data during the
pilot.

Use the read-only source health check to compare Hawley's mirror against live
Airtable and Asana counts:

```powershell
npm run pg:source-health
```

The check reads source systems and Hawley/Postgres, but does not write to
Airtable, Asana, or Postgres. It exits with code `2` when Hawley counts differ
from the source counts. Use `-- --no-fail` when a human-readable JSON report is
needed without failing a scheduled monitor.

## Blank Task Triage

If the employee list appears but workers are blank, first check whether Hawley's
DAT mirror has been refreshed:

```powershell
npm run pg:pull:daily-tracker
```

If the DAT project has no snapshot for the selected date, the page falls back to
mirrored `Task Instances Rev1`. In that fallback mode, a fresh assignment in
Airtable will not show until `pg:pull:airtable` and `pg:normalize` have run.

If task lists match but daily efficiency is low, check that
`raw.airtable_worker_daily_actuals` has current rows for the selected `Work Date`.
The current Daily Worker App can show higher efficiency than task-only Asana
minutes because it recovers work from local worker logs/timers and writes those
summaries into `Worker Daily Task Actuals`.
