# SW_Machine Postgres Setup

This runbook prepares `SW_Machine` as the first H.A.W.L.E. ("Hawley") host.

## Boundaries

- Do not store raw credentials in this repo.
- Do not run live Asana or Airtable writes during phase 1.
- Do not expose Postgres outside the local network unless explicitly approved.
- Do not enable scheduled sync until manual health checks pass.

## Install

Install PostgreSQL natively on `SW_Machine` using the official Windows installer:

```text
https://www.postgresql.org/download/windows/
```

Recommended defaults:

- database service enabled at startup
- local-only listening at first
- database name: `bowlus_ops`

If the EDB installer fails from an SSH/non-desktop session with an
`Invalid account WORKGROUP\...` installer log entry, use the repo script instead:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-sw-machine-postgres.ps1
```

The script downloads the official EDB Windows binary zip, initializes the
cluster, registers `HawleyPostgres17`, and creates the first Hawley roles and
database.

## Bootstrap Database

Create roles:

```sql
create role bowlus_app login password 'CHANGE_ME';
create role bowlus_sync login password 'CHANGE_ME';
create role bowlus_readonly login password 'CHANGE_ME';
create database bowlus_ops owner bowlus_sync;
```

After migrations:

```sql
grant usage on schema reporting, calc to bowlus_readonly;
grant select on all tables in schema reporting, calc to bowlus_readonly;
```

## Verify

From the repo on `SW_Machine`:

```powershell
npm install
npm run pg:health
npm run pg:migrate
```

## Backup

Use `pg_dump` to create regular backups outside the repo:

```powershell
pg_dump -Fc -d bowlus_ops -f C:\HawleyBackups\bowlus_ops_%DATE%.dump
```
