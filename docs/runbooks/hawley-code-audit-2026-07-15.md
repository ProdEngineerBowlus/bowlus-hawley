# Hawley Code Audit Review - 2026-07-15

This is the verified follow-up to the 2026-07-15 source audit. It reflects the
current `main` branch, including the non-disruptive hardening release
`d5e5b3c`.

## Deployed Non-Disruptive Fixes

- Static assets are confined with `path.relative(...)` rather than a fragile
  prefix comparison.
- SCRAM/SASL database configuration failures return Hawley's generic Postgres
  credentials message rather than the underlying driver text.

These changes do not alter worker actions, scheduling, source data, or runtime
permissions.

## Confirmed Current Risks

- The web process builds normal pools from the sync-capable database URL. A
  runtime-role split needs deliberate grants or stored procedures for the
  Project Creator before it can be changed safely.
- Production startup applies migrations/views by default and logs a startup
  migration failure while continuing to serve.
- Assignment and utilization GET routes enforce timer schedule state, so a
  read request can close/adjust timer ledger rows.
- The worker `release` action is presented as manager-only in the UI but is not
  yet server-restricted to manager/admin actors.
- Task completion writes an Asana time entry inline; the durable idempotent
  writeback queue remains design-only for this path.
- The utilization view can combine Hawley live actuals and Airtable/bootstrap
  rows. The productive-day denominator also needs one explicit gross/net-break
  definition.
- Current phase pace uses the production-schedule-linked mirror when available.

These require intentional behavior, schema, credential, or scheduling changes
and were not changed in the non-disruptive pass.

## Findings Already Resolved Before This Review

The original audit described earlier code for the following items:

- `todayIso()` already uses `America/Los_Angeles`.
- True pace uses fractional current-shop-day elapsed and remaining capacity, so
  the current day is not counted as a full day in both directions.
- The pace sparkline begins at full load and burns after its start boundary.
- Project Creator blocks scopes with pending/failed native Hawley runs.
- Project Creator normalizes real en/em dashes before key matching.
- `db/views/003_hawley_worker_page.sql` has no large blank tail.
- On 2026-07-23, the Admin debt matrix was changed to prefer the live
  `hb.phase_cycle_load_rev1` model. The Airtable Phase Cycle Load mirror is now
  used only as a recovery fallback.

## Current Production Shape

- Web app: DigitalOcean App Platform, `bowlus-hawley`.
- Database: managed Postgres `hawley-pg-prod` in `SFO3`.
- Freshness: Asana events and Worker Daily Actuals mirror run every 60 seconds.
- Nightly: full HB refresh at 1:00 a.m. Pacific, followed by the Airtable worker
  actuals archive export.

Use `/api/health` and `/api/sync-status` for current service/watcher state.
