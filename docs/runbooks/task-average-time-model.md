# Task Average-Time Model

## Current Source and Mirror

The Airtable `Tasks` table currently calculates the historical task baseline.
Hawley mirrors the three values below into `hb.task_templates` and exposes them
on worker-task API records. This mirror is read-only with respect to Airtable.

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

## Future Hawley Ownership

Before Hawley becomes the source, implement the same qualification rule against
its normalized task-instance history, compare its results with the Airtable
mirror over multiple refreshes, and only then approve a narrowly scoped Airtable
writeback. Until that verification is complete, Airtable remains authoritative.
