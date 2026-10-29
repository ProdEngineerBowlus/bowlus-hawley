# Cycle calendar generator

Replaces the Airtable Cycles script (`original-airtable-cycles.js`) with deterministic, tested calendar arithmetic in `apps/postgres-sync/src/cycle-calendar.js`. This first slice is a pure library: it reads and writes no database and changes nothing in production. Persisting, previewing and publishing plans in Hawley is the next slice. Tracks #4.

## Company closures

Confirmed by the user on 2026-10-29: New Year's Day, Memorial Day, Independence Day, Labor Day, Thanksgiving Day, Day After Thanksgiving and Christmas Day. Dates are calculated for each year; nothing is hard-coded per year.

- Fixed-date holidays that fall on a weekend are observed Saturday -> Friday and Sunday -> Monday. This is a default policy pending company confirmation. Example: July 4, 2026 is a Saturday, so July 3 is closed. New Year's Day 2028 is a Saturday, so December 31, 2027 is closed.
- Per-date exceptions open or close single days. The default calendar opens 2026-11-27: the handoff states there is no day-after-Thanksgiving closure in 2026.

## Planning rules

`planCycles` takes a start date, an optional end date (default December 31), the first cycle number, the cycle count, optional fixed lengths and an optional baseline of published cycles.

- Baseline cycles marked `locked` keep their exact dates. Requests to resize them are conflicts.
- Fixed lengths are `{cycle, days}`, `{fromCycle, toCycle, days}` or `{cycle, extendBy}` (relative to the baseline).
- Locked cycles split the year into spans. In each span, fixed lengths are reserved first, then the remaining working days are spread over flexible cycles so their lengths differ by at most one day. Earlier cycles take the extra days.
- Impossible requests return `conflicts` with a code (`fixed_exceeds_available`, `not_enough_days`, `gap_before_locked_cycle`, `locked_cycle_constraint`, `missing_baseline`, ...). Nothing is silently adjusted.
- `diffCyclePlans` lists cycles whose dates or length would change, for preview before publishing.

Intentional differences from the Airtable script: no hard-coded July 3, no quarter-wide overrides (use cycle ranges instead), balancing spans the whole year instead of only after the first unfixed cycle, and constraint problems are reported rather than thrown mid-write.

## Validation

`npm test` covers 2026 and 2027 closure dates, an even 25-cycle 2026 plan (255 working days), fixing cycles 22-25 at eight days, extending two upcoming cycles by four days with completed cycles locked, a locked cycle mid-year, and each conflict type.
