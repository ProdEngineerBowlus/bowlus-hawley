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

Account login support is installed but inactive by default. Keep
`HAWLEY_AUTH_ACTIVE=false` until a manager approves login testing. The auth
migration creates `core.app_users`, `core.app_sessions`, and
`core.app_auth_events`, and seeds inactive user rows from active
`hb.work_force` workers with email addresses. No seeded worker account can sign
in until it is activated and given a password hash.

When login testing is approved, set `HAWLEY_AUTH_ACTIVE=true`, configure
manager/admin emails with `HAWLEY_AUTH_MANAGER_EMAILS` or
`HAWLEY_AUTH_ADMIN_EMAILS`, and use the temporary bootstrap env values only long
enough to create the first admin password:

```text
HAWLEY_AUTH_BOOTSTRAP_ENABLED=true
HAWLEY_AUTH_BOOTSTRAP_EMAIL=<manager email>
HAWLEY_AUTH_BOOTSTRAP_PASSWORD=<secret>
```

After the first admin can sign in, remove the bootstrap password env value and
redeploy. Runtime sessions use the HTTP-only `hawley_session` cookie; browser
JavaScript does not store session tokens.

Sessions are persistent by default. Each app load renews the browser cookie and
the matching server-side session for 400 days. A session ends when the user
chooses Logout, an administrator revokes the account/session, or the account is
deactivated. Set `HAWLEY_AUTH_PERSISTENT_SESSIONS=false` to restore fixed-hour
expiry through `HAWLEY_AUTH_SESSION_TTL_HOURS`; the renewal period can be
changed with `HAWLEY_AUTH_PERSISTENT_SESSION_DAYS`.

To activate a specific employee for testing after auth is enabled, set a
temporary password in the shell and run the admin CLI:

```powershell
$env:HAWLEY_AUTH_PASSWORD="<temporary password>"
npm run pg:hawley-auth-user -- set-password worker@example.com --active --role=worker
```

The CLI stores only a salted hash, marks the account active only when `--active`
is supplied, and can list or deactivate accounts with:

```powershell
npm run pg:hawley-auth-user -- list
npm run pg:hawley-auth-user -- deactivate worker@example.com
```

For the first shop-floor login pilot, the auth CLI can activate and verify the
full active workforce roster in one pass. It reads active employees from
`hb.work_force`, sets the shell-provided temporary password hash for each
account, makes Erick T, Jacob R, and `prodengineering@bowlusroadchief.com`
admins, makes Cesar Z a manager, and leaves everyone else as a worker:

```powershell
$env:HAWLEY_AUTH_PASSWORD="<temporary pilot password>"
npm run pg:hawley-auth-user -- setup-pilot-roster
npm run pg:hawley-auth-user -- verify-passwords
Remove-Item Env:\HAWLEY_AUTH_PASSWORD
```

Both commands print the active account roster with name, email, role, active
state, temporary-password flag, and password verification status.

Manager control mode uses the same live endpoint. From the manager dashboard,
selecting a worker opens the manager detail view with Start, Stop, End Session,
SOP, and Complete controls for that worker's assigned tasks. These controls
write to Hawley first and only push to Asana on Complete. End Session is
manager-only: it clears a running/paused timer session, keeps the logged actual
minutes on today's Hawley row, and leaves the task open. The legacy `Refresh
tracker` and `Adopt new tasks` buttons remain disabled server-side because
those belong to the old Daily Assignment Tracker/Airtable write path.

The live Hawley worker app does not read Airtable for worker actuals and does
not write to Airtable from the web request path. Airtable is downstream legacy
human-readable output only. Feed it from Hawley with a separate overnight
backfill/export job after the live day is complete.

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

Worker actuals for the live page come from Hawley-owned rows in:

```sql
hb.worker_daily_task_actuals
```

The runtime app filters these rows to `source_system = 'hawley_worker_live_pilot'`
so legacy Airtable imports cannot change the live Worker Page math.

`Actual today` and the manager `Line utilization` signal must use only completed
same-day task actuals from Hawley's worker actuals ledger
(`hb.worker_daily_task_actuals`). Open or running WIP timer minutes may appear on
the task card as timer state, but they must not roll into aggregate `Actual
today`. Asana task `actual_time_minutes` is cumulative over the life of the task,
so it should stay available as total task context but must not be counted as
same-day logged time.
Likewise, `Asana Posted Minutes` proves writeback but is not a same-day
productive-time source for live utilization displays. The production UI should
not allow live utilization above the elapsed available-time denominator; if raw
source rows exceed that denominator, treat the source data as invalid for live
capacity math instead of displaying an impossible over-100% real-time score.

The Hawley Reporting View should keep the visible day totals congruent with the phase
rows it renders: planned assigned hours/tasks come from
`reporting.hawley_worker_page_assignments`, while actual time and transition
signals come from Hawley's worker actual/session reporting views. The raw debug
payload panel is hidden by default and is available only with `?debug=1`.

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

Backfill Hawley worker actuals into Airtable only as a separate overnight export:

```powershell
npm run pg:backfill:airtable-worker-actuals -- --apply
```

That command is dry-run by default. It writes only when
`HAWLEY_ALLOW_SOURCE_WRITES=true`, `HAWLEY_DRY_RUN=false`, and `--apply` are all
present. The production web service now chains this export after the 1:00 a.m.
HB refresh when `HAWLEY_NIGHTLY_AIRTABLE_BACKFILL_ENABLED=true`. The scheduler
injects the write gates only for the child backfill process, so normal web
requests remain DB-only.

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

Task-control safe reporting view:

```text
http://127.0.0.1:5273/beta.html
```

The reporting view is intentionally not a worker control surface. It is opened
from the manager cycle/day history rail after choosing a workday and does not
expose Start, Stop, Complete, End Session, Refresh tracker, or Adopt tasks. Most
of the page uses GET requests against existing Hawley APIs. When manager
transition reviews are enabled, a selected transition gap can be classified with
buttons that write only to Hawley's `core.transition_reviews` and
`core.task_transition_events` review fields.
Use it for diagnostics, phase summaries, freshness checks, transition review,
and side-by-side report testing without giving the shop another active task
control page.

The reporting-view layout is multi-tiered by design. The first screen is the day/line
bird's-eye view by phase, without a global employee list. Selecting a phase
opens a phase/worker rail view for that day: it shows all workers who worked or
were assigned in that phase, plus placeholder rail boxes for transition data
that will come from Hawley's richer utilization ledger. Task rows are one layer
deeper: use the phase rail to see all phase tasks, or select a worker to see
that worker's tasks for the phase/day.

The phase rail reads Hawley's utilization report for transition fields. `Task
switches`, `Handoff gaps`, and `Review flags` are generated from
`core.time_sessions` and `core.task_transition_events`. The numbers become
trustworthy from the point Hawley live worker actions started writing session
events forward; older actual rows may still lack exact start/stop boundaries.

The reporting-view phase overview uses canonical operational phase buckets for known
nomenclature drift. For example, `FAB-B` rolls into `FAB 1-3`, and `Frame-A`
rolls into `Frames / Phase A`. The original task labels remain in the payload
for debugging, but the phase list should show the canonical production bucket.
Worker rows inside a phase drill-in should show the selected task phase/bucket,
not the worker's home or configured capability label.

Task drill-ins separate same-day time from task history. `Actual today` is the
selected work date only. `Worker total` sums Hawley's
`hb.worker_daily_task_actuals` rows for that worker/task across recorded dates.
`Team total` sums all recorded workers on the same Asana task across recorded
dates. The full task estimate is shown as `Task estimate`; it should not be
treated as a same-day efficiency denominator for multi-day or team tasks. In the
reporting-view task list, rows are visually marked as team tasks only when Hawley's
recorded actuals show more than one worker on that task; solo rows remain
unmarked and use `Task total` instead of `Team total`.

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
GET /api/auth/me
POST /api/auth/login
POST /api/auth/logout
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
Asana event watcher state, the nightly HB refresh scheduler, the latest
Airtable backfill run, and latest `sync.run_log` rows. It is the fastest way to
confirm that the worker page is reading a fresh Hawley Brain instead of silently
leaning on Airtable or live Asana.

## Configuration

```text
HAWLEY_WORKER_HOST=127.0.0.1
HAWLEY_WORKER_PORT=5273
HAWLEY_DAILY_TRACKER_PROJECT_GID=1214157321063250
HAWLEY_WORKER_INCLUDE_NO_WORK=false
HAWLEY_WORKER_ACTUALS_WATCH_IN_WEB=true
HAWLEY_AIRTABLE_BACKFILL_WINDOW_DAYS=2
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
HB assignment rows. A fresh assignment should flow Asana -> Hawley/Postgres
through the Asana pull/event path and HB rebuild, not through Airtable.

If task lists match but `Actual today` is low, check Hawley's own
`hb.worker_daily_task_actuals` rows for the selected `Work Date` and
`source_system = 'hawley_worker_live_pilot'`. Do not use
`raw.airtable_worker_daily_actuals` to fix the live Worker Page; that table is
legacy/audit input only.
