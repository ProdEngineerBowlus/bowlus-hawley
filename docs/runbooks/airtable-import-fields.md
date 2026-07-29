# Airtable Import Fields

Hawley imports Airtable in two layers:

1. Schema metadata into `raw.airtable_schema_tables` and
   `raw.airtable_schema_fields`, which captures every defined field visible to
   the token.
2. Record payloads into `raw.airtable_*` tables without a `fields[]` filter.
   This captures every populated field value Airtable returns, including
   hidden/formula/helper fields visible through the API.

Empty-everywhere fields may be absent from Airtable record payloads, but they
remain represented in the schema catalog.

## Imported Tables

- `Task Instances Rev1` -> `raw.airtable_task_instances`
- `Tasks` -> `raw.airtable_tasks`
- `Production` -> `raw.airtable_production`
- `Cycles` -> `raw.airtable_cycles`
- `Work Force` -> `raw.airtable_work_force`
- `Phase Cycle Load Rev1` -> `raw.airtable_phase_cycle_load`
- `Worker Cycle Bank Rev1` -> `raw.airtable_worker_cycle_bank`
- `Phases` -> `raw.airtable_phases`
- `Worker Phase Allocation Rev1` -> `raw.airtable_worker_phase_allocation`
- `CNC Parts Master` -> `raw.airtable_cnc_parts_master`
- `CNC Sheets` -> `raw.airtable_cnc_sheets`

## Fields The Existing Bowlus Scripts Rely On

`DailyAssignmentSync.js` reads these task-instance signals for worker-page
assignment logic:

- `Assigned Worker`
- `Cycle`
- `Task Completed?`
- `Actual time`
- `Completed On`
- `Assigned On`
- `Asana Task GID`
- `Asana Project GID`
- `Estimated Task Time`
- `PhaseCycleBucketKey`
- `Phase`
- `Start Date`
- `End Date`
- `Task Order`
- `VIN`
- `Section/Column`
- `Email`

It also reads:

- `Work Force`: `Name`, `Assignee`, `Actively Employed`, `Hours Per Day`
- `Worker Cycle Bank Rev1`: `Worker`, `Cycle`, `WorkerCycleKey`, `Assigned Hours Total`, `Remaining Hours`, `Cycle Capacity`, `Days In Cycle`, `Effective Hours Bank`, `Actively Employed`
- `Phase Cycle Load Rev1`: `PhaseCycleBucketKey`, `Phase`, `Cycle`, `Total Load Hrs.`, `Completed Task Hours`, `Remaining Task Hours`, `Completion %`
- `Cycles`: cycle start/end, cycle number, workday, holiday, and current-cycle fields
- `Phases`: `Name`, `Section/Column`

The admin project-creator path also mirrors:

- `Tasks`: `Task Name`, `Parent Task`, `Task Order`, `Quantity`,
  `Estimated Task Time`, `Estimated Batched Task Time`, `TasksKey`,
  `Document Link`, `Diagrams & Utilities`, `Task Description`, `Assignee`,
  `Name`, and `Phase`
- `Production`: `Schedule Name`, `Cycle Number`,
  `Cycle Number (from Cycle)`, `Cycle`, `Phase`, `Section/Column`,
  `Asana Section`, `VIN`, `VIN (from VIN)`, `Start Date`, `End Date`,
  `Days in Cycle (from Cycle)`, `Task Instances Rev1`, and `Model Type`

Those records normalize into `hb.task_templates` and
`hb.production_schedule` for Postgres-backed admin features.

## Task Parts, Materials, and CNC Sheets

The task-template BOM is sourced from Airtable, not maintained separately in
Hawley. The relevant relationships are:

- `Tasks`: `Parts Master`, `CNC Sheets`, and the derived `Material` lookup.
- `CNC Parts Master`: `Tasks`, `CNC Sheets`, `Material`, `Sheet Material`,
  quantities, component context, and model context.
- `CNC Sheets`: `Parts On Sheet`, `Tasks 2`, `Material`, dimensions, cost,
  and inventory context.

The nightly import mirrors all three records and `pg:build:hb` builds the
many-to-many task/part, task/sheet, and task/material bridges. Query
`reporting.task_template_bom` for the compact task-centric output. This is
read-model context only; it does not alter project creation, pacing, task
assignment, or Airtable source records.

## Phase Template Assignment Propagation

For bulk phase ownership changes, Airtable is the administrative control
surface. Update the `Tasks` template's linked worker; its `Assignee` lookup is
the intended owner for that template. Hawley then applies that owner to open
`Task Instances Rev1` rows and their linked Asana tasks. Completed tasks are
deliberately excluded so their historical worker and recorded time remain
intact.

Use a dry run first, then the explicitly gated apply command:

```powershell
node ./apps/postgres-sync/src/propagate-template-assignees.js --min-vin 325
$env:HAWLEY_ALLOW_SOURCE_WRITES='true'
node ./apps/postgres-sync/src/propagate-template-assignees.js --apply --min-vin 325
```

The command writes Airtable `Assigned Worker`, `Email`, `Assignee Name`, and
`Assignee Email` first, then aligns the linked Asana task assignee. During the
HB rebuild, a populated Airtable `Assigned Worker` link takes precedence over
the imported Asana owner; Asana remains the source for live task state,
completion, and elapsed time.

The admin creator follows the same scope rules as the established project
creator: VIN projects use only Production rows directly linked to that VIN;
Fabrication projects use the selected cycle's no-VIN FAB, CNC, and Frames
rows. It preserves parent/child task ordering, applies model and frame filters,
maps assignees by email, copies document and diagram attachments, reuses the
template's matching sections, and blocks the entire scope when any selected
Production row already has Task Instances Rev1 links. After a successful Asana
create and Postgres link update, Hawley immediately rebuilds the downstream
Rev1 pacing tables.

`rev1-rebuild-downstream.mjs` additionally depends on:

- `Assigned Worker`
- `PhaseCycleBucketKey`
- `Worker Phase Allocation Rev1`
- `Worker Cycle Bank Rev1`

## Normalization Notes

`core.task_instances` is currently a practical first normalized model. It maps
one Airtable `Task Instances Rev1` record to one local task-instance row and
fills the worker, cycle, and phase labels from the mirrored support tables when
linked-record IDs are present.

The first reporting view, `reporting.daily_worker_assignments`, reads from
`core.task_instances`. It is not yet a replacement for the live worker page; it
is the comparison surface for proving Hawley can answer the same question from
Postgres.

## First Import Baseline

First SW_Machine import run: 2026-07-06.

Imported counts:

- `raw.airtable_task_instances`: 8,324
- `raw.airtable_cycles`: 25
- `raw.airtable_work_force`: 22
- `raw.airtable_phase_cycle_load`: 163
- `raw.airtable_worker_cycle_bank`: 186
- `raw.airtable_phases`: 20
- `raw.airtable_worker_phase_allocation`: 264
- `core.task_instances`: 8,324
- `reporting.daily_worker_assignments`: 5,161

The `Task Instances Rev1` schema catalog saw 90 defined fields. The record
payload mirror saw 67 distinct populated field names. The 23-field difference is
expected for fields that are defined in the table but absent from the current
record payload because Airtable omits empty values.
