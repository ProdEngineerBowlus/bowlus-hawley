# H.A.W.L.E. ("Hawley")

Historical Analytics & Workflow Logic Engine.

Hawley is the local production engineering brain for Bowlus shop operations. It
is named after Hawley Bowlus, the aircraft designer and original Bowlus inventor.

Hawley is a Postgres-backed mirror, calculation, reporting, and shop-floor
execution layer between Asana, Airtable, the Worker App, dashboards, and
Codex/agent tools.

## System Boundaries

- Asana remains the human task execution source of truth.
- Airtable remains the legacy/human-readable planning mirror during migration.
- Postgres becomes the fast local mirror, calculation layer, historical memory,
  and app-readable reporting model.
- Hawley owns live worker timer/session events in Postgres. A completed worker
  task posts its verified elapsed time and completion to Asana.
- Airtable worker actuals are an overnight archive/export target, not the live
  execution source.

The worker app is live for approved worker writes. Planning and project-creation
writes remain separately gated.

## Target Host

The production host is DigitalOcean App Platform:

```text
https://bowlus-hawley-9s6iw.ondigitalocean.app
```

`SW_Machine` is no longer the Hawley runtime dependency. It may still host
legacy shop tooling, but Hawley freshness, worker pages, admin pages, and the
managed Postgres database run in DigitalOcean.

Current deployment:

- App Platform web service runs `npm run worker:hawley`.
- Managed Postgres cluster is `hawley-pg-prod` in `SFO3`.
- Asana events and the Worker Daily Actuals mirror refresh every minute.
- The full HB refresh runs nightly at 1:00 a.m. Pacific, followed by the
  Airtable worker-actuals archive export.

See `docs/runbooks/digitalocean-app-platform.md` for the current deployment
configuration and health checks.

## Repo Layout

```text
apps/postgres-sync/   Node sync/import scripts
db/migrations/        Versioned Postgres schema migrations
db/views/             Reporting and calculation SQL views
db/seeds/             Safe bootstrap-only seed files
docs/runbooks/        Setup, operations, backup, and recovery notes
scripts/              Local setup and health helpers
```

## First Commands

```powershell
npm install
npm run pg:health
npm run pg:migrate
npm run pg:pull:asana
npm run pg:refresh-worker-read-model
```

`pg:health` only checks the database connection. It does not contact Asana or
Airtable.

`pg:pull:asana` reads the `Fabrication - 2026` and `VINs - 2026` portfolios
from Asana and mirrors portfolios, portfolio-project membership, projects,
tasks, subtasks, custom fields, and task project/section memberships into the
local Postgres `raw` schema.

`pg:refresh-worker-read-model` is the fast worker-page path. It pulls Asana and
rebuilds HB tables. It does not pull or write Airtable. The broader
`pg:refresh-hawley-read-model` command also pulls Airtable and normalizes the
legacy planning mirror.

`pg:watch:asana-events` is the one-minute pilot updater. It reads Asana project
events for the VINs/Fabrication portfolio projects, fetches changed task rows,
updates HB/Postgres, and rebuilds HB only when changed tasks are found. It does
not write to Asana or Airtable.

Hawley's operational capability map lives in the `ops` schema and reporting
views. It combines Airtable `Work Force` skill levels, observed Rev1/Asana task
assignment history, and local-only owner hints for scheduling/routing support.
See `docs/runbooks/operational-capability-map.md`.

The current Postgres schema map and data-layer rules are documented in
`docs/hawley-database-schema.md`.

The Hawley Admin Dashboard and Project Creator are documented in
`docs/runbooks/hawley-admin-operations.md`. The admin page recreates the useful
PLH pacing visuals from Postgres/HB data, supports non-destructive true phase
pacing overlays, and has a preview-first project creator for VIN and
Fabrication Asana projects.

The Admin Phase-Cycle Burn-Down uses `hb.phase_cycle_load_rev1` as its primary
source. This HB model is rebuilt after changed Asana task events; the legacy
Airtable Phase Cycle Load mirror is retained only as a recovery fallback.

The Rev1 Airtable field and calculation migration audit is documented in
`docs/runbooks/rev1-airtable-calculation-audit.md`.

The Hawley Brain Rev1 build path and HB-owned tables are documented in
`docs/runbooks/hawley-brain-rev1-build.md`.

The Hawley worker app is served from DigitalOcean and reads Postgres only. By
default it uses the HB read model; set
`HAWLEY_WORKER_USE_DAT_SNAPSHOTS=true` only when intentionally comparing against
the legacy Daily Assignment Tracker snapshot shape:

```powershell
npm run worker:hawley
```

The worker web app also includes a read-only beta/debug page at `/beta.html`.
It is meant for diagnostics and report prototypes; it uses existing GET APIs
only and does not expose worker task controls. The beta page is intentionally
multi-tiered: the first view is a day/line phase overview, and individual
worker/task performance appears only after drilling into a phase.

The production utilization, transition gap, phase reporting, manager review,
and Asana writeback-queue design is documented in
`docs/runbooks/worker-utilization-transition-ledger.md`. The first database
foundation lives in `db/migrations/012_worker_utilization_ledger.sql` and
`db/views/005_worker_utilization_reporting.sql`.

The verified July 15 production audit status and deferred architecture work are
documented in `docs/runbooks/hawley-code-audit-2026-07-15.md`.

## Secret Rules

Do not commit:

- `.env`
- database passwords
- Airtable tokens
- Asana tokens
- raw data exports
- local runtime output
- backups

Use `.env.example` for variable names only.
