# Cycle calendar generator

Replaces the Airtable Cycles script (`original-airtable-cycles.js`) with deterministic, tested calendar arithmetic in `apps/postgres-sync/src/cycle-calendar.js`, plus an admin **Cycles** tab that previews and publishes a year's calendar into `hb.cycles`. Tracks #4.

## Admin Cycles tab

Admin page > Cycles. Pick a year, the first cycle's start date, the first cycle number and the cycle count, add optional length rules, then Preview. The preview lists every cycle with its type (locked, fixed, flexible), the currently published dates, how many VINs, schedule rows and tasks each changed cycle affects, and any problems. Publish is enabled only when there are no problems and something changes.

- Rules: `22-25=8` fixes cycles 22-25 at 8 working days, `20=12` fixes one cycle, `20+4` extends cycle 20 by 4 working days over its published length. Separate rules with commas.
- Past cycles (end date before today, shop time) are locked: never moved, never resized.
- The current cycle (started, not ended) keeps its start date and, by default, its published end date. A rule such as `20+4` or `20=12` extends or shortens it, and later cycles rebalance.
- Published cycles are never deleted. A plan with fewer cycles than are published is refused.
- Publishing recomputes the plan inside one transaction and refuses if anything differs from the approved preview (`PLAN_STALE`).
- Existing cycles are updated in place and keep their `cycle_record_id`; new cycles get `hawley-cycle:<year>-<nn>` and labels like `C1.27`. Written rows are marked `source_system = 'hawley_cycle_planner'`.
- The matching `hb.production_schedule` rows get the new start/end dates and day counts in the same transaction.
- Every publish inserts an append-only row in `hb.cycle_plan_versions` (migration 035): inputs, resulting cycles, the year's previous `hb.cycles` rows, changed cycle numbers, note and publisher. To roll back, use `previous_cycles_json` from that row.
- Not changed by publishing: Asana tasks that already exist keep their dates; task instances keep their cycle links.

## Single source of cycle dates (migration 036)

`hb.cycles` is the only table that owns cycle dates; the generator publishes into it and the app reads it. `hb.production_schedule` keeps copies of each cycle's start date, end date and day count because Project Creator and the dashboard read them (Project Creator writes "Days in Cycle" into new Asana projects). Migration 036:

- adds trigger `cycles_sync_production_schedule_dates`, which copies a cycle's dates and day count to its linked schedule rows whenever they change in `hb.cycles`, whoever makes the change;
- aligns existing copies once. On 2026-10-29 all linked dates matched, but 48 rows for C19-C22 still held older day counts;
- records a baseline `hb.cycle_plan_versions` row per year (`cycle-plan:baseline-<year>`, published by `migration 036`) with the existing cycles, so generator history starts from the current table.

The Cycles tab shows a red notice if any schedule row's dates disagree with its cycle.

Endpoints (admin only): `GET /api/admin/cycle-planner?year=`, `POST /api/admin/cycle-planner/preview`, `POST /api/admin/cycle-planner/publish`.

## Company closures

Confirmed by the user on 2026-10-29: New Year's Day, Memorial Day, Independence Day, Labor Day, Thanksgiving Day, Day After Thanksgiving and Christmas Day. Dates are calculated for each year; nothing is hard-coded per year.

- Fixed-date holidays that fall on a weekend are observed Saturday -> Friday and Sunday -> Monday. This is a default policy pending company confirmation. Example: July 4, 2026 is a Saturday, so July 3 is closed. New Year's Day 2028 is a Saturday, so December 31, 2027 is closed.
- Per-date exceptions open or close single days. None are set: the user confirmed on 2026-10-29 that the day after Thanksgiving is a closure in 2026 too.

## Planning rules

`planCycles` takes a start date, an optional end date (default December 31), the first cycle number, the cycle count, optional fixed lengths and an optional baseline of published cycles.

- Baseline cycles marked `locked` keep their exact dates. Requests to resize them are conflicts.
- Fixed lengths are `{cycle, days}`, `{fromCycle, toCycle, days}` or `{cycle, extendBy}` (relative to the baseline).
- Locked cycles split the year into spans. In each span, fixed lengths are reserved first, then the remaining working days are spread over flexible cycles so their lengths differ by at most one day. Earlier cycles take the extra days.
- Impossible requests return `conflicts` with a code (`fixed_exceeds_available`, `not_enough_days`, `gap_before_locked_cycle`, `locked_cycle_constraint`, `missing_baseline`, ...). Nothing is silently adjusted.
- `diffCyclePlans` lists cycles whose dates or length would change, for preview before publishing.

Intentional differences from the Airtable script: no hard-coded July 3, no quarter-wide overrides (use cycle ranges instead), balancing spans the whole year instead of only after the first unfixed cycle, and constraint problems are reported rather than thrown mid-write.

## Validation

`apps/hawley-worker-page/test/cycle-planner.test.js` covers rule parsing, locking, in-place updates with schedule sync, version records, stale previews, new-year creation and refusal cases. The tab was exercised end to end in a browser against an in-memory database.

Live check, 2026-10-29 (read-only, `bowlus_readonly`): `hb.cycles` holds 25 cycles for 2026 only, labelled `C1`-`C25` with Airtable record IDs; all 308 linked production schedule rows match their cycle's dates. C20 is stored as 2026-10-01 to 2026-11-02 (23 days), overlapping C18 and C19; as a started cycle it is kept and reported as a warning. With 2026-11-27 confirmed as a closure, a no-rule 2026 preview leaves C21-C25 as published. A 2027 preview creates 25 new cycles with no conflicts.

`npm test` also covers 2026 and 2027 closure dates, an even 25-cycle 2026 plan (255 working days), fixing cycles 22-25 at eight days, extending two upcoming cycles by four days with completed cycles locked, a locked cycle mid-year, and each conflict type.
