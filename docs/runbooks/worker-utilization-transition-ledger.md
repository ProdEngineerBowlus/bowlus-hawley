# Worker Utilization, Transition, And Phase Ledger

## Purpose

Hawley should make the Worker Daily App more than a fast worker page. The target
is a durable production ledger that explains where the day went by worker,
phase, task, transition, assignment churn, blocker, and app compliance signal.

Asana remains the line-lead assignment board and formal execution record. The
Worker Daily App remains the worker-facing execution surface. Hawley/Postgres is
the operational ledger, calculation layer, manager review queue, and
agent-readable production history.

## Source Boundaries

- Asana is the assignment authority and formal task record.
- Hawley is the worker event ledger, reporting layer, and calculation truth.
- Airtable remains a legacy/human-readable mirror while it is phased down.
- Worker-facing controls should stay simple: start, stop, complete, SOP.
- Gap classification is manager-only in the first version.

## Event Flow

1. Line leads assign or reassign work in Asana.
2. Hawley polls Asana events and assignment state about every minute.
3. Assignment snapshots and changes are stored in Postgres.
4. Workers start, stop, release, or complete task sessions in the Worker Daily App.
5. The app writes events and session state to Postgres first.
6. Hawley generates transition gaps between stopped and started sessions.
7. Hawley queues approved Asana writebacks for time/status/comment updates.
8. The sync worker posts to Asana and records success or failure.
9. Managers classify transition gaps in real time or later in review mode.
10. Reporting views calculate utilization, transition burden, phase labor,
    assignment churn, queue starvation, app compliance signals, and blockers.

## Database Objects

Migration:

```text
db/migrations/012_worker_utilization_ledger.sql
```

Reporting views:

```text
db/views/005_worker_utilization_reporting.sql
```

Core event tables:

- `core.assignment_events`
- `core.worker_task_events`
- `core.time_sessions`
- `core.task_transition_events`
- `core.transition_reviews`
- `core.worker_day_schedule`
- `sync.asana_writeback_queue`

Reference catalogs:

- `core.transition_gap_buckets`
- `core.transition_category_catalog`

First reporting views:

- `reporting.worker_time_sessions`
- `reporting.transition_event_detail`
- `reporting.worker_daily_utilization`
- `reporting.worker_transition_summary`
- `reporting.worker_unaccounted_time`
- `reporting.phase_day_summary`
- `reporting.worker_phase_day_summary`
- `reporting.phase_worker_labor_detail`
- `reporting.assignment_churn_by_worker`
- `reporting.assignment_churn_by_phase`
- `reporting.queue_starvation_events`
- `reporting.lead_dispatch_delays`
- `reporting.assigned_but_not_started`
- `reporting.actual_vs_estimated_by_task`
- `reporting.actual_vs_estimated_by_phase`
- `reporting.transition_gap_cause_summary`
- `reporting.unreviewed_transition_queue`
- `reporting.daily_owner_action_list`

## Transition Gap Model

A transition gap is the time between one task session ending and the next task
session starting for the same worker/day.

Store every gap. Review the meaningful gaps. Escalate only the abnormal gaps.

Default buckets:

| Bucket | Range | Default Review |
| --- | ---: | --- |
| Micro Transition | 0-2 min | no |
| Normal Transition | 2-5 min | no |
| Extended Transition | 5-10 min | no |
| Alert Transition | 10-20 min | yes |
| Material Utilization Gap | 20-45 min | yes |
| Major Gap | 45+ min | yes |

The raw transition event is immutable operational evidence. Manager
classification is explanation metadata and must not overwrite the raw event.

## Manager Categories

Worker-controlled:

- Worker Delayed Start
- App / Time Tracking Compliance Issue

Lead-controlled:

- Waiting for Lead
- No Task Available
- Assignment Churn

System-controlled:

- Waiting for Parts / Materials
- Waiting for Engineering Clarification
- Waiting for QC
- Tool / Equipment Issue

Valid work:

- Helping Another Worker
- Rework / Unplanned Work
- Meeting / Training
- Normal Transition
- Break / Lunch

Unknown:

- Unknown / Needs Review

## Review Rules

Set `review_required = true` when any of these are true:

- `raw_gap_minutes >= 10`
- `excess_gap_minutes > 0`
- next task was assigned before the gap and the gap is at least 10 minutes
- assignment changed during the gap
- worker has repeated medium gaps in the same day
- the gap is connected to a critical phase/cycle
- the gap is connected to an over-estimate alert
- the gap is connected to a logged-out alert
- a manager manually flags it

## Phase Mapping

Every session and transition should carry phase context:

- task -> phase/work area through `reporting.task_work_area_inference`
- time session -> `phase_key` and `phase_name`
- transition -> `previous_phase`, `next_phase`, and `reporting_phase`

Initial reporting rule:

```text
reporting_phase = previous_phase
```

Store both previous and next phase so future reports can assign transition time
to previous phase, next phase, or split it without losing evidence.

## Metric Definitions

Productive utilization:

```text
productive_task_minutes / scheduled_minutes
```

Task efficiency:

```text
estimated_minutes_for_worked_or_completed_tasks / actual_task_minutes
```

Accounted utilization:

```text
(productive_task_minutes + transition_minutes + planned_break_minutes) / scheduled_minutes
```

Unaccounted time:

```text
scheduled_minutes - productive_task_minutes - transition_minutes - planned_break_minutes
```

Assigned vs completed:

```text
completed_assigned_tasks / assigned_tasks
```

Efficiency and utilization are not interchangeable. Efficiency compares estimate
to actual task time. Utilization compares actual task time to the scheduled day.

## Manager UI Target

Navigation:

```text
Historical Ledger
-> Day View
-> Phase Summary View
-> Phase Detail View
-> Worker Detail View
-> Task / Transition Detail View
```

Day View:

- phase name
- total actual task hours
- total transition time
- total estimated hours
- efficiency percent
- assigned and completed task count
- assigned vs completed percent
- task churn count
- worker count
- assigned worker count
- gaps requiring review
- over-estimate alerts
- logged-out alerts
- top transition category
- top manager category group

Phase Detail View:

- workers who worked in the phase
- hours per worker
- estimated minutes per worker
- efficiency percent
- started and completed tasks
- transition time
- gap count by bucket
- gaps requiring review
- task churn
- app compliance and over-estimate alerts
- manager-classified transition categories
- unaccounted time where available

Worker Detail View:

- scheduled hours
- total task hours
- task hours by phase
- transition time
- excess transition time
- productive utilization
- accounted utilization
- unaccounted time
- assigned, started, and completed tasks
- task sessions
- transition gaps
- app compliance alerts
- over-estimate alerts
- assignment changes
- manager notes/reviews

Task / Transition Detail View:

- worker
- phase
- previous task
- next task
- previous task end time
- next task start time
- raw gap
- excess gap
- bucket
- assignment context
- existing system alerts
- auto-category suggestion
- manager category buttons
- manager notes
- reviewed by
- reviewed at

## Hidden Manager Buttons

Manager classification buttons should appear only when:

- the page is in manager mode, not worker `?employee=` mode
- the app reports manager control enabled
- the selected object is a transition event
- the transition is unreviewed or the manager has permission to revise it

The first UI can use the category catalog from
`core.transition_category_catalog` and post reviews to an endpoint that writes
`core.transition_reviews` and updates the rollup fields on
`core.task_transition_events`.

Worker pages should not expose these controls.

## First Prototype Scope

Build the first prototype around these endpoints:

- `GET /api/utilization-report?date=YYYY-MM-DD`
- `GET /api/utilization-report?date=YYYY-MM-DD&phase=<phase_key>`
- `GET /api/utilization-report?date=YYYY-MM-DD&phase=<phase_key>&worker=<worker_key>`
- `GET /api/transition-review-queue?date=YYYY-MM-DD`
- `POST /api/transition-review`

Implemented pilot behavior:

- Hawley worker `start` writes `core.worker_task_events` and opens
  `core.time_sessions`.
- Hawley worker `stop`, `release`, and `complete` close the current
  `core.time_sessions` row when a live start timestamp is present.
- The next `start` for the same worker/day creates a
  `core.task_transition_events` gap from the previous stopped session to the
  new session.
- The line view reads `/api/utilization-report` for actuals, phase/worker
  transition metrics, and review metrics, while planned assigned hours/tasks
  remain based on the Hawley assignment read model so the visible day totals and
  phase rows use the same denominator.
- The debug payload panel is hidden in normal live use. Append `?debug=1` to the
  line-view URL when raw payload inspection is needed.
- Manager classification buttons stay hidden until a transition row is selected;
  reviews write only to Hawley's review tables and do not write to Asana or
  Airtable.
- The reporting view excludes live Hawley app `core.time_sessions` rows from
  productive-time rollups when a matching `hb.worker_daily_task_actuals` row
  exists, preventing double-counting. Transition rows still use the session
  ledger for gap timing.

The first screen should answer:

```text
Are we short on labor, poorly dispatched, blocked by materials/engineering,
losing time in transitions, dealing with app compliance issues, suffering from
task churn, or just not getting a full day of accountable work?
```

## Implementation Order

1. Apply the schema migration and reporting views.
2. Add a Postgres-first event write for start, stop, release, and complete.
3. Keep Asana writeback through an explicit queue.
4. Generate transition events after every stop/start sequence.
5. Add passive auto-suggestions and review flags.
6. Add manager-only review endpoints.
7. Add the historical ledger day/phase/worker drilldown UI.
8. Compare reports against current Asana actual time and Worker Daily Task
   Actuals until the report is trusted.
9. Move legacy Airtable-facing reporting behind Hawley views.

## Open Decisions

- Whether planned breaks should be schedule-derived only or manager-classified
  transition time can also satisfy the break bucket.
- Whether lead dispatch delay should start at task completion, timer stop, or
  "no remaining assigned work" detection.
- Whether transition time should report to previous phase, next phase, or both
  for different report modes.
- Whether task efficiency should use assigned estimate, batch estimate, average
  observed time, or a future standard-time model.
