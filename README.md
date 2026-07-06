# H.A.W.L.E. ("Hawley")

Historical Asana/Airtable Workflow Layer for Engineering.

Hawley is the local production engineering brain for Bowlus shop operations. It
is named after Hawley Bowlus, the aircraft designer and original Bowlus inventor.

The first version is a Postgres-backed mirror, calculation, and reporting layer
between Asana, Airtable, the Daily Worker App, dashboards, and Codex/agent tools.

## System Boundaries

- Asana remains the human task execution source of truth.
- Airtable remains the human-editable planning and control surface.
- Postgres becomes the fast local mirror, calculation layer, historical memory,
  and app-readable reporting model.
- Hawley reads source systems first, calculates locally, and only pushes selected
  summaries or verified time/completion data back after explicit implementation.

Phase 1 is mirror/read-model only. It does not perform live Asana or Airtable
writes.

## Target Host

The intended production host is `SW_Machine`.

Recommended first deployment:

- Native PostgreSQL Windows service on `SW_Machine`
- Node.js sync scripts from this repo
- scheduled dry-run/import jobs only after Postgres health checks pass
- regular `pg_dump` backups

Docker may be useful later for development, but the shop host should start with
native Postgres for simpler service startup and backups.

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
```

`pg:health` only checks the database connection. It does not contact Asana or
Airtable.

`pg:pull:asana` reads the `Fabrication - 2026` and `VINs - 2026` portfolios
from Asana and mirrors portfolios, portfolio-project membership, projects,
tasks, subtasks, custom fields, and task project/section memberships into the
local Postgres `raw` schema.

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
