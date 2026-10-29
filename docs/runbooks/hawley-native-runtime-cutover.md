# Hawley runtime source ownership - 2026-10-29

Disable the Airtable daily-actuals mirror, task-time writeback, nightly actuals backfill and automatic bending-flag refresh. Live Airtable assignment polling was already retired. Legacy enable flags cannot restart these web-service jobs. The nightly command is pinned to Asana pull plus native HB rebuild, ignoring old deployment overrides.

The HB rebuild now loads workers, cycles, phases and models from HB. It preserves templates, VINs, production schedule, CNC records, BOM links and historical actuals in place. It updates cycle progress from the stored calendar, overlays Asana changes onto existing task IDs and inserts newly discovered Asana tasks. Missing Asana records are retained rather than deleted. Source IDs remain historical provenance. Timer/session writes into Postgres and Asana watching are unchanged. No schema migration is needed.

## Verification

Private snapshot: Shop Ops data/preservation/hawley-cutover-2026-10-29. It covers 15 tables including 23,903 tasks, 3,773 daily actuals and 5,168 sessions. This is a targeted snapshot, not a complete database backup.

A full native rebuild was exercised in a rolled-back live database transaction: 23,837 Asana overlays, zero added tasks, zero changed/lost task identities or origin IDs, zero Airtable reads, 279 phase-cycle loads, 467 allocations, 302 worker-cycle banks, and 1,637 capability rows. Private full-native-rebuild-dry-run.json records the result. Nothing committed in that test.

Tests cover preserving unmatched history, Asana completion on an existing task ID, failing closed on empty master data, and legacy flags not restarting retired jobs. Existing tests also pass. Verify runtime health and Asana activity after deployment; no artificial worker time or external task is created for testing.

Rollback: revert and redeploy. Review Hawley-owned master edits before enabling the old normalizer, which can overwrite those edits. Retain raw tables for recovery.

## Remaining limits

This is runtime disconnection, not cancellation readiness. Cycle/production generation and task-version editing remain under development. Direct Asana event polling remains 60 seconds plus processing/browser latency. Cleared dispatch dates and removed tasks retain the existing overlay semantics; removal reconciliation is unchanged.

Project creation still requests fresh Diagrams & Utilities attachment URLs from Airtable on demand. A durable cloud file source is needed before removing that lookup without losing attachments. Six attachment export failures remain unresolved. Explicit legacy import/recovery CLI commands remain available but are not scheduled by the web service. Raw snapshot/count diagnostics may still show Airtable provenance, without making live Airtable API calls.
