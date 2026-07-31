# Task Average-Time Model

## Current Source and Writeback

Hawley calculates the historical task baseline from its canonical task-instance
history. Airtable retains the existing `Task Instances Rev1` records, template
links, and planning controls. Hawley writes only the current actual-time value
and the three derived average fields below.

| Airtable Tasks field | Hawley field | Meaning |
| --- | --- | --- |
| `Avg. Time` | `avg_time_seconds` | Arithmetic mean of qualifying actual times, stored as seconds. |
| `Avg. Time Input Count` | `avg_time_input_count` | Count of qualifying observations behind the average. |
| `Avg. Time Quality` | `avg_time_quality` | Confidence band derived from the qualifying observation count. |

## Airtable Qualification Rule

An input is a linked `Task Instances Rev1` record whose `Actual time` is greater
than zero and is not more than five hours above that task's `Estimated Task
Time`. This intentionally filters blank/zero entries and obvious duration
anomalies before the arithmetic mean is calculated.

The quality bands are: `No Data` for 0 inputs, `Very Low` for 1, `Low` for 2-3,
`Medium` for 4-6, `High` for 7-8, and `Very High` for 9 or more.

## Writeback and Safety

`pg:writeback:airtable-task-times` is dry-run by default. With `--apply`,
`HAWLEY_ALLOW_SOURCE_WRITES=true`, and `HAWLEY_DRY_RUN=false`, it:

- updates `Task Instances Rev1.Actual time` from Hawley's canonical cumulative
  Asana-backed task actual when it differs; and
- recalculates `Tasks.Avg. Time`, `Avg. Time Input Count`, and `Avg. Time
  Quality` with the qualification rule above.

Successful writes are recorded in `sync.airtable_task_time_writeback_state` and
in `sync.run_log`. The production web service runs the writeback every minute
as a supervised sidecar. A no-change pass makes no Airtable requests, so the
legacy history remains intact and Airtable stays fresh without needless edits.
