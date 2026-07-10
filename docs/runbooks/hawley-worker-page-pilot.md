# Hawley Worker Page Pilot

The Hawley worker page is a pilot clone of the Daily Worker App. It uses
Hawley/Postgres instead of live Airtable and live Asana reads.

## Boundary

By default this pilot does not start timers, complete tasks, create Asana time
tracking entries, or rebuild Daily Assignment Tracker. It reads local Hawley
tables and reporting views only.

Exception: worker pages are approved for live timer testing on real tasks. A
worker page writes timer state into Hawley's `hb.worker_daily_task_actuals`
ledger. On Complete, Hawley creates the Asana time tracking entry, marks the
source Asana task complete, and adds an Asana story. The live write scope is
reported by `/api/auth-status`; `writeWorkerIds: ["*"]` means all assigned
worker pages use server-backed live writes.

Manager control mode uses the same live endpoint. From the manager dashboard,
selecting a worker opens the manager detail view with Start, Stop, End Session,
SOP, and Complete controls for that worker's assigned tasks. These controls
write to Hawley first and only push to Asana on Complete. End Session is
manager-only: it clears a running/paused timer session, keeps the logged actual
minutes on today's Hawley row, and leaves the task open. The legacy `Refresh
tracker` and `Adopt new tasks` buttons remain disabled server-side because
those belong to the old Daily Assignment Tracker/Airtable write path.

Hawley still does not write to Airtable. The one-minute Airtable
`Worker Daily Task Actuals` pull is a legacy/readable mirror input and does not
overwrite Hawley-owned pilot rows with `source_system = 'hawley_worker_live_pilot'`.

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

`Actual today` and the manager `Line daily efficiency` signal must use only
Hawley's worker actuals ledger (`hb.worker_daily_task_actuals`). Asana task
`actual_time_minutes` is cumulative over the life of the task, so it should stay
available as total task context but must not be counted as same-day logged time.

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

Refresh only the fast worker logged-time ledger:

```powershell
npm run pg:pull:worker-actuals
```

This pulls Airtable `Worker Daily Task Actuals` into:

```sql
raw.airtable_worker_daily_actuals
hb.worker_daily_task_actuals
```

By default it refreshes a recent Work Date window, not the full Airtable mirror.
It is read-only against Airtable and does not write to Airtable, Asana, or the
current shop worker app.

The manager `C# day` gauge is intentionally a task-completion gauge. Its percent
must be `completedTaskCount / taskCount`, matching the adjacent `X/Y tasks
complete` label. Hour-based cycle progress from Daily Assignment Line Overview
or Phase Cycle Load can be exposed separately, but should not be displayed as a
task-completion percent.

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

Read-only beta/debug page:

```text
http://127.0.0.1:5273/beta.html
```

The beta page is intentionally not a worker control surface. It only uses GET
requests against existing Hawley APIs and does not expose Start, Stop, Complete,
End Session, Refresh tracker, or Adopt tasks. Use it for diagnostics, phase
summary prototypes, freshness checks, and side-by-side report testing without
giving the shop another active page.

The beta layout is multi-tiered by design. The first screen is the day/line
bird's-eye view by phase, without a global employee list. Selecting a phase
opens a phase/worker rail view for that day: it shows all workers who worked or
were assigned in that phase, plus placeholder rail boxes for transition data
that will come from Hawley's richer utilization ledger. Task rows are one layer
deeper: use the phase rail to see all phase tasks, or select a worker to see
that worker's tasks for the phase/day.

Task drill-ins separate same-day time from task history. `Actual today` is the
selected work date only. `Worker total` sums Hawley's
`hb.worker_daily_task_actuals` rows for that worker/task across recorded dates.
`Team total` sums all recorded workers on the same Asana task across recorded
dates. The full task estimate is shown as `Task estimate`; it should not be
treated as a same-day efficiency denominator for multi-day or team tasks.

Worker pages use the familiar pattern:

```text
http://127.0.0.1:5273?employee=<worker-slug>
```

## API

```text
GET /api/health
GET /api/sync-status
GET /api/daily-assignments?date=YYYY-MM-DD
GET /api/daily-assignments?date=YYYY-MM-DD&includeNoWork=true
GET /api/daily-assignments?date=YYYY-MM-DD&employee=<worker-slug>
GET /api/auth-status
GET /api/alert-status
GET /api/refresh-daily-tracker
POST /api/refresh-daily-tracker
POST /api/worker-task-action
```

`POST /api/worker-task-action` supports `start`, `stop`, `release`, and
`complete` when live worker writes are enabled. `release` is the manager-only
End Session path. `POST /api/refresh-daily-tracker` intentionally remains a
read-only pilot error because tracker rebuild/adoption belongs to the old Daily
Assignment Tracker/Airtable write path.

`/api/sync-status` reports HB freshness from Postgres only: the in-process
Asana event watcher state, the in-process Worker Daily Task Actuals watcher
state, and latest `sync.run_log` rows. It is the fastest way to confirm that the
worker page is reading a fresh Hawley Brain instead of silently leaning on
Airtable or live Asana.

## Configuration

```text
HAWLEY_WORKER_HOST=127.0.0.1
HAWLEY_WORKER_PORT=5273
HAWLEY_DAILY_TRACKER_PROJECT_GID=1214157321063250
HAWLEY_WORKER_INCLUDE_NO_WORK=false
HAWLEY_WORKER_ACTUALS_WATCH_IN_WEB=false
HAWLEY_WORKER_ACTUALS_INTERVAL_MS=60000
HAWLEY_WORKER_ACTUALS_WINDOW_DAYS=14
HAWLEY_WORKER_ACTUALS_FUTURE_DAYS=2
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
