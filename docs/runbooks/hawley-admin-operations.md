# Hawley Admin Operations

Last updated: 2026-07-13

The Hawley Admin page is the operations control layer for shop-floor execution.
It lives in the Hawley worker web app at:

```text
/admin.html
```

The current admin surface has two active sections:

- Dashboard
- Project Creator

It is intentionally built as a place for more admin-only features over time.

## Last Two Days Of Changes

Recent work moved Hawley closer to a Postgres-first shop execution system:

- Employee account login was added behind `HAWLEY_AUTH_ACTIVE`.
- Nightly HB refresh and nightly Airtable worker-actuals backfill were added.
- Airtable `Tasks`, `Production`, `VINs`, and `Models` are mirrored into
  Postgres/HB tables for admin project creation.
- The Admin Dashboard now recreates the PLH-style pacing visuals from
  Postgres/HB data instead of the Daily Assignment Tracker runtime flow.
- Redundant admin summary panels were removed, leaving the visual pacing panels
  and a collapsed Configuration drawer for diagnostics.
- The dashboard now supports non-destructive true phase pacing overlays by cycle
  and phase.
- The Project Creator now supports both VIN and Fabrication project scopes,
  with preview-first behavior and a guarded Asana write path.

## Admin Dashboard

The dashboard is a Postgres-native version of the useful PLH dashboard signals.
It does not call the legacy Daily Assignment Tracker at runtime.

The main dashboard panels are:

- `Phase Pace Projection`
- `Phase-Cycle Burn-Down`
- shop efficiency gauges by Frames, Fab, Installation, and Shop
- collapsed Configuration drawer for source proof, schedule alignment, source
  runs, and true pace controls

Primary data sources:

- `hb.cycles`
- `hb.production_schedule`
- `hb.rev1_task_instances`
- `hb.phase_cycle_load_rev1`
- `hb.worker_phase_allocation_rev1`
- `hb.worker_cycle_bank_rev1`
- `hb.phase_cycle_pace_overrides`
- `raw.asana_tasks`
- `reporting.worker_daily_utilization`

The dashboard may still read raw Airtable mirrors as fallback/proof tables, but
the admin app should not depend on the legacy Daily Assignment Tracker to know
whether the shop is on pace.

The Admin Dashboard automatically requests fresh dashboard data every 60
seconds while the page is visible. Returning to a backgrounded tab triggers an
immediate catch-up request. The refresh updates only dashboard state, so it does
not reset unsaved Project Creator input. Worker and manager assignment views use
the same 60-second refresh cadence.

Phase pace sparklines use the green line for ideal productive burn-down at 7
hours 40 minutes per assigned worker per workday. This comes from the 7:00 a.m.
to 3:30 p.m. shift less two 10-minute breaks and one 30-minute lunch. The yellow
line is the projection at the current completion rate. A dashed capacity
projection begins at today's open work. When remaining capacity cannot cover
that work, it ends above zero with a red endpoint and the unresolved hour gap
is labeled explicitly. Each phase uses its own vertical hour scale, and the area
between ideal burn-down and capacity projection is shaded red for a gap or blue
for a cushion so smaller differences remain visible.

Phase rows intentionally separate capacity from schedule pace. `On Track` and
`Off Track` are capacity decisions: a row is off track only when remaining work
exceeds remaining capacity. A separate `On Pace` or `Behind Pace` chip compares
completion with the phase's standard or true-phase target. This allows a phase
to be capacity-covered while still showing that work needs to accelerate.

## True Phase Pacing

True pacing lets an admin shift the start date for a phase within a cycle
without changing source schedule rows, task data, or actual work history.

This handles cases where management intentionally delays a phase start because
available labor is being used to recover debt elsewhere. Without this overlay,
the phase can appear behind pace even when it has not actually been released to
start its current-cycle work.

The overlay table is:

```sql
hb.phase_cycle_pace_overrides
```

Important rules:

- Overrides are keyed by cycle number and normalized phase label.
- `true_start_date` must be a workday inside the selected cycle.
- Saving an override changes only the dashboard pacing view.
- It does not rewrite `hb.production_schedule`, `hb.rev1_task_instances`,
  Asana, Airtable, worker actuals, or historical debt.
- Resetting an override removes that phase/cycle overlay and returns the phase
  to the cycle default start date.

Dashboard behavior:

- The phase status can show `Queued` before the true start date.
- The phase card displays a shift chip such as `Shifted +2d`.
- The sparkline timeline shows the shifted start marker and pre-start window.
- Pace deltas are calculated against the phase-specific true workday progress,
  not the global cycle progress, when an override is active.

## Project Creator

The Project Creator is preview-first. It reads Hawley/Postgres data, builds the
proposed Asana project shape, and only writes when explicitly enabled.

Safety gate:

```text
HAWLEY_ADMIN_PROJECT_CREATE_ENABLED=false
```

Set it to `true` only for an approved test/create window.

Shared sources:

- `hb.production_schedule` remains the production schedule source.
- `hb.task_templates` supplies task names, estimates, phases, workers, SOP
  links, model/frame filters, support phase, support offset, and parent/child
  task shape.
- `hb.vins` and `hb.models` provide VIN model/frame context.
- `hb.rev1_task_instances` is checked to avoid creating against already-linked
  legacy or Asana task instances.

### VIN Projects

VIN projects are selected by VIN.

The creator scans the production schedule for that VIN across its planned
phase/cycle rows, matches task templates by phase/model/frame, and previews the
tasks that belong in the VIN project.

Default name:

```text
VIN <number>
```

Target portfolio:

```text
HAWLEY_ASANA_VIN_PORTFOLIO_GID
```

### Fabrication Projects

Fabrication projects are selected by cycle.

The creator uses the production schedule to find fabrication support rows for
the selected cycle. Current support buckets are:

- `FAB-A`
- `FAB-B`
- `FRAME-A`
- `FRAME-B`
- `CNC-A`
- `CNC-B`

Task templates can use supported phase and offset logic to anchor fabrication
support work to the VIN that is in a given phase for that cycle.

Default name:

```text
C<cycle> - Fabrication
```

Target portfolio:

```text
HAWLEY_ASANA_FABRICATION_PORTFOLIO_GID
```

## Asana Create Path

When the write gate is enabled, the create path:

1. Requires an admin user.
2. Requires `ASANA_PAT`.
3. Instantiates the configured Asana template project from
   `HAWLEY_ASANA_PROJECT_TEMPLATE_GID`.
4. Adds the new project to the VIN or Fabrication portfolio.
5. Creates Asana sections from the preview phase/section labels.
6. Creates root tasks and subtasks from the Postgres preview.
7. Writes pending native rows into `hb.rev1_task_instances` with
   `source_system = 'hawley_project_creator'`.
8. Records the run in `hb.project_creation_runs`.
9. Updates Hawley rows with the new Asana project/task GIDs after success.

The create path refuses to create a project when the selected scope already has
Asana-linked or legacy task instances. Use clean future test scopes for initial
validation.

## Environment Variables

```text
HAWLEY_ADMIN_PROJECT_CREATE_ENABLED=false
HAWLEY_AIRTABLE_TASKS_TABLE=Tasks
HAWLEY_AIRTABLE_PRODUCTION_TABLE=Production
HAWLEY_AIRTABLE_VINS_TABLE=VINs
HAWLEY_AIRTABLE_MODELS_TABLE=Models
HAWLEY_ASANA_PROJECT_TEMPLATE_GID=1211664083967075
HAWLEY_ASANA_FABRICATION_PORTFOLIO_GID=1212620750946278
HAWLEY_ASANA_VIN_PORTFOLIO_GID=1212620750946276
HAWLEY_ADMIN_PLH_BASELINE_CYCLE=C5
HAWLEY_ADMIN_PLH_PHASES=
```

`HAWLEY_ADMIN_PLH_PHASES` can be left blank to use the default dashboard phase
filtering. Use it only when a deployment needs an explicit comma-separated phase
allowlist.

## Routine Admin Refresh

After changing Airtable planning tables such as `Tasks`, `Production`, `VINs`,
or `Models`, refresh Hawley before using the Project Creator:

```powershell
npm run pg:refresh-hawley-read-model
```

For app/schema changes:

```powershell
npm run pg:migrate
npm run pg:refresh-hawley-read-model
```

For source health checks without writes:

```powershell
npm run pg:source-health
```
