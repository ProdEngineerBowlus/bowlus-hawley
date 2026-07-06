# Asana Portfolio Import

Hawley mirrors the same 2026 Asana scope that `Task Instances Rev1` imports:

- `Fabrication - 2026` (`1212620750946278`)
- `VINs - 2026` (`1212620750946276`)

The source import is read-only against Asana. It writes only to local Postgres.

## Command

```powershell
npm run pg:pull:asana
```

Useful scoped checks:

```powershell
npm run pg:pull:asana -- --portfolio fabrication --limit-projects 1
npm run pg:pull:asana -- --portfolio vin --skip-subtasks
```

## Mirrored Tables

- `raw.asana_portfolios`
- `raw.asana_portfolio_projects`
- `raw.asana_projects`
- `raw.asana_tasks`
- `raw.asana_task_project_memberships`

`raw.asana_tasks.raw_json` keeps the full requested task payload. The importer
also breaks out the fields needed for fast worker/reporting queries: task name,
parent task, assignee, completion state, completed date, start/due dates,
actual time, project, modified time, permalink, subtask count, and custom field
payload.

`raw.asana_task_project_memberships` is intentionally separate from
`raw.asana_tasks.project_gid` because Asana tasks can live in multiple projects
and sections. This keeps Hawley from prematurely flattening Asana's model while
we build the faster worker page.

## Rev1 Alignment Notes

The existing Shop Ops Rev1 bootstrap script maps these portfolios this way:

- Fabrication portfolio -> `Cycle Project`
- VIN portfolio -> `VIN Project`

Hawley stores that `task_type` on `raw.asana_portfolio_projects` so the later
normalization layer can reproduce the Rev1 distinctions instead of treating all
Asana projects as identical.

The importer requests completed tasks using:

```text
completed_since=1970-01-01T00:00:00.000Z
```

That is deliberate. The fast worker/reporting layer needs historical completed
tasks and actual time, not only open tasks.

## Field Coverage

Asana does not have Airtable-style hidden fields, but the API only returns fields
that are explicitly requested. Hawley currently requests:

- task identity, subtype, parent, created/modified timestamps
- completion state, completed timestamp, start/due dates
- assignee GID/name/email
- `actual_time_minutes`
- `num_subtasks`
- project/section memberships
- custom field identity, display value, text/number/date values, enum values
- notes and permalink

The first importer follows Rev1's practical model and pulls top-level project
tasks plus first-level subtasks by default. Increase `HAWLEY_ASANA_SUBTASK_DEPTH`
or pass `--subtask-depth N` if nested subtask depth becomes operationally
important.
