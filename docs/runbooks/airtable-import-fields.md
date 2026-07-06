# Airtable Import Fields

Hawley imports Airtable without a `fields[]` filter. That is intentional: the
API should return every populated field visible to the token, including hidden
formula/helper fields. Empty fields may be omitted by Airtable, so downstream
logic must tolerate missing keys.

## Imported Tables

- `Task Instances Rev1` -> `raw.airtable_task_instances`
- `Cycles` -> `raw.airtable_cycles`
- `Work Force` -> `raw.airtable_work_force`
- `Phase Cycle Load Rev1` -> `raw.airtable_phase_cycle_load`
- `Worker Cycle Bank Rev1` -> `raw.airtable_worker_cycle_bank`
- `Phases` -> `raw.airtable_phases`
- `Worker Phase Allocation Rev1` -> `raw.airtable_worker_phase_allocation`

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

The `Task Instances Rev1` mirror saw 67 distinct populated field names. This is
the expected sign that Hawley imported the broad Airtable record payload,
including helper/formula/hidden fields visible through the API, rather than only
the smaller worker-page field list above.
