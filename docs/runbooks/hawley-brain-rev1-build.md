# Hawley Brain Rev1 Build

Date: 2026-07-08

Hawley Brain now has first-class Postgres tables for the Rev1 production ledger and support calculations. These tables are the path away from Airtable as the calculation engine.

## Boundary

`pg:build:hb` writes only to the Hawley Postgres database. It does not write to Airtable or Asana.

Current source shape:

- Airtable Rev1 raw tables remain the legacy/bootstrap copy so hidden fields and old planning context are preserved.
- Asana portfolio mirrors now overlay the volatile task truth into `hb.rev1_task_instances`: assignee, assigned date, completion, actual time, due/start dates, section, phase, cycle, VIN, task name, and project metadata.
- Asana-only tasks are also inserted into `hb.rev1_task_instances` with `source_system = 'asana_portfolio'` when Hawley sees them in the VINs/Fabrication portfolios before Airtable has a Rev1 row.

This lets the worker app run from HB while Airtable is phased toward a legacy overnight/human-readable mirror.

## HB Tables

Base tables:

- `hb.rev1_task_instances`
- `hb.work_force`
- `hb.cycles`
- `hb.phases`
- `hb.worker_daily_task_actuals`

Derived calculation tables:

- `hb.phase_cycle_load_rev1`
- `hb.worker_phase_allocation_rev1`
- `hb.worker_cycle_bank_rev1`

The reporting views used by the cloned worker page now read from HB tables:

- `reporting.daily_worker_assignments`
- `reporting.task_work_area_inference`
- `reporting.hawley_worker_page_assignments`
- `reporting.hawley_cycle_calendar`

## Command

Fast worker-page refresh:

```powershell
npm run pg:refresh-worker-read-model
```

This runs:

1. `pg:pull:asana`
2. `pg:build:hb`
3. `pg:pull:daily-tracker`

The Daily Tracker pull is read-only and is kept for comparison/fallback. The cloned worker app defaults to the HB read model, not DAT snapshots.

One-minute incremental Asana refresh:

```powershell
npm run pg:watch:asana-events
```

This uses Asana project event sync tokens for the 30 VIN/Fabrication portfolio projects. Each poll reads Asana events, fetches changed task rows, updates Hawley Postgres raw Asana tables, and rebuilds HB only when changed task rows are found.

Safety boundary:

- Asana writes: no
- Airtable reads/writes: no
- Hawley Postgres writes: yes

The first event call for a project establishes its sync token. Use this sequence for a clean baseline:

```powershell
npm run pg:pull:asana-events -- --init-only
npm run pg:pull:asana
npm run pg:build:hb
npm run pg:pull:asana-events
```

The active local pilot process logs to `runtime-output/hawley-asana-events.out.log`. It is a local background process, not a persistent Windows scheduled task yet.

HB local rebuild only:

```powershell
npm run pg:build:hb
```

This command:

1. Normalizes Work Force, Cycles, Phases, Task Instances Rev1, Asana portfolio tasks, and Worker Daily Task Actuals into `hb.*`.
2. Rebuilds phase/cycle load, worker phase allocation, and worker cycle bank tables inside `hb.*`.
3. Keeps `Actual Efficiency` as the legacy batch-based calculation:
   `actual_time_seconds / estimated_batch_task_time_seconds`.

## Current Build Result

Latest verified build on 2026-07-08:

| Table | Rows |
| --- | ---: |
| `hb.work_force` | 18 |
| `hb.cycles` | 25 |
| `hb.phases` | 20 |
| `hb.rev1_task_instances` | 10891 |
| `hb.worker_daily_task_actuals` | 211 |
| `hb.phase_cycle_load_rev1` | 190 |
| `hb.worker_phase_allocation_rev1` | 307 |
| `hb.worker_cycle_bank_rev1` | 199 |

Build detail from the same run:

- Airtable-backed Task Instances: 8324
- Airtable-backed rows overlaid with Asana truth: 8267
- Asana-only Task Instances: 2567
- Reporting worker assignment rows: 4515

The full read refresh is dominated by the Asana network pull. On 2026-07-08 it fetched 10,830 distinct source tasks across 30 VIN/Fabrication projects.

Asana event baseline verified on 2026-07-08:

- Event cursor projects: 30
- Initialized cursor projects: 30
- First post-baseline event poll: 0 changes
- One-minute watcher: running locally with 60000 ms interval

## Worker App Wiring

`apps/hawley-worker-page/server.js` defaults to the HB read model:

- configured workers come from `hb.work_force`
- daily actuals come from `hb.worker_daily_task_actuals`
- assignments come from `reporting.hawley_worker_page_assignments`
- DAT snapshots are used only when `HAWLEY_WORKER_USE_DAT_SNAPSHOTS=true` or when no HB rows are available

Verified on 2026-07-08:

- API source: `hawley-brain`
- API mode: `hawley-read-model`
- C11 selected day: Day 9 on 2026-07-08
- Worker count: 18
- Workers with work: 7

## Next Step

Move the Airtable pull to an overnight/legacy cadence and, after the pilot is trusted, move the Asana event watcher from this local session into the official host/service plan.
