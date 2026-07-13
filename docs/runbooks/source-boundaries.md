# Source Boundaries

Hawley starts as a mirror and reporting model, then gradually becomes the
shop-floor execution system.

## Asana

Asana remains the human execution source of truth for:

- task ownership
- due dates
- completion state
- comments
- subtasks
- final time tracking records

## Airtable

Airtable remains the human planning and control surface for:

- production simulation and schedule planning
- task templates
- VIN/model/frame planning data
- cycle setup
- VIN and phase planning while migration is in progress
- manual overrides
- high-level operational review

Airtable should not be the live worker-actuals source. Worker actuals are
written to Hawley/Postgres first and can be exported back to Airtable overnight
for legacy human-readable review.

## Postgres

Postgres becomes the local authority for:

- mirrored source data
- cross-system joins
- heavy calculations
- historical snapshots
- worker-page reporting views
- live worker timers and actuals
- app login/account state
- admin-only view overlays
- admin project-creation run logs
- sync logs and failure diagnosis

## Worker App Direction

The future worker app should read current assignments from Postgres and write
local timer/session events to Postgres first. A separate verified sync should
then push final time/completion records to Asana.

## Admin Direction

The Hawley Admin Dashboard should recreate the useful PLH pacing visuals from
Postgres/HB data. It should not depend on the legacy Daily Assignment Tracker
runtime flow to know current shop pacing.

The Hawley Project Creator uses Airtable planning mirrors as editable source
inputs during migration, but the create decision and audit trail should be
Postgres-first:

- `hb.production_schedule` for schedule rows
- `hb.task_templates` for task definitions and estimates
- `hb.vins` and `hb.models` for VIN/model/frame filtering
- `hb.project_creation_runs` for run history
- `hb.rev1_task_instances` for native pending/generated task rows

When the create path is enabled, Asana receives the generated project/tasks and
Hawley records the resulting Asana GIDs back into Postgres.
