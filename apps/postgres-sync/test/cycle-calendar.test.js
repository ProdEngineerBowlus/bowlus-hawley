import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_COMPANY_CALENDAR,
  companyClosures,
  diffCyclePlans,
  planCycles,
  weekdayOf,
  workingDays
} from "../src/cycle-calendar.js";

const closureDates = (from, to, calendar) => companyClosures(from, to, calendar).map(closure => closure.date);

function assertContiguous(plan) {
  const days = workingDays(plan.cycles[0].startDate, plan.cycles.at(-1).endDate);
  let index = 0;
  for (const cycle of plan.cycles) {
    assert.equal(cycle.startDate, days[index], `cycle ${cycle.cycle} starts on the next working day`);
    index += cycle.days;
    assert.equal(cycle.endDate, days[index - 1], `cycle ${cycle.cycle} ends after ${cycle.days} working days`);
  }
  assert.equal(index, days.length);
}

const spread = cycles => Math.max(...cycles.map(c => c.days)) - Math.min(...cycles.map(c => c.days));

test("2026 closures use actual dates, observe July 4 on Friday, and keep the day after Thanksgiving open", () => {
  assert.deepEqual(closureDates("2026-01-01", "2026-12-31"), [
    "2026-01-01", "2026-05-25", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"
  ]);
});

test("2027 closures include the day after Thanksgiving and weekend observances across the year boundary", () => {
  assert.deepEqual(closureDates("2027-01-01", "2027-12-31"), [
    "2027-01-01", "2027-05-31", "2027-07-05", "2027-09-06", "2027-11-25", "2027-11-26", "2027-12-24", "2027-12-31"
  ]);
  assert.equal(companyClosures("2027-12-31", "2027-12-31")[0].name, "New Year's Day (observed)");
  assert.deepEqual(closureDates("2028-01-01", "2028-01-31"), []);
});

test("exceptions can add one-off closures", () => {
  const calendar = { ...DEFAULT_COMPANY_CALENDAR, exceptions: [{ date: "2026-12-24", action: "closed", name: "Plant shutdown" }] };
  assert.ok(closureDates("2026-12-01", "2026-12-31", calendar).includes("2026-12-24"));
});

test("a full year spreads every working day evenly and never starts on a weekend or closure", () => {
  const plan = planCycles({ startDate: "2026-01-01", cycleCount: 25 });
  assert.equal(plan.ok, true);
  assert.equal(plan.workingDayCount, 255);
  assert.equal(plan.cycles.length, 25);
  assert.ok(spread(plan.cycles) <= 1);
  assert.equal(plan.cycles.reduce((sum, c) => sum + c.days, 0), 255);
  assert.equal(plan.cycles[0].startDate, "2026-01-02");
  assert.equal(plan.warnings[0].code, "start_moved");
  assert.equal(plan.cycles.at(-1).endDate, "2026-12-31");
  const closed = new Set(closureDates("2026-01-01", "2026-12-31"));
  for (const cycle of plan.cycles) {
    assert.ok(![0, 6].includes(weekdayOf(cycle.startDate)) && !closed.has(cycle.startDate));
  }
  assertContiguous(plan);
});

test("fixing cycles 22-25 at eight days rebalances the earlier flexible cycles", () => {
  const plan = planCycles({ startDate: "2026-01-02", cycleCount: 25, lengths: [{ fromCycle: 22, toCycle: 25, days: 8 }] });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.cycles.slice(21).map(c => [c.days, c.source]), Array(4).fill([8, "fixed"]));
  assert.ok(spread(plan.cycles.slice(0, 21)) <= 1);
  assert.equal(plan.cycles.at(-1).endDate, "2026-12-31");
  assertContiguous(plan);
});

test("extending two upcoming cycles keeps completed cycles locked and rebalances the rest", () => {
  const published = planCycles({ startDate: "2026-01-02", cycleCount: 25 }).cycles;
  const baseline = published.map(c => ({ ...c, locked: c.endDate < "2026-10-29" }));
  const lockedCount = baseline.filter(c => c.locked).length;
  const next = [lockedCount + 1, lockedCount + 2];
  const plan = planCycles({
    startDate: "2026-01-02",
    cycleCount: 25,
    baseline,
    lengths: next.map(cycle => ({ cycle, extendBy: 4 }))
  });
  assert.equal(plan.ok, true, JSON.stringify(plan.conflicts));
  for (const cycle of plan.cycles.slice(0, lockedCount)) {
    const before = published[cycle.cycle - 1];
    assert.deepEqual([cycle.startDate, cycle.endDate, cycle.source], [before.startDate, before.endDate, "locked"]);
  }
  for (const number of next) assert.equal(plan.cycles[number - 1].days, published[number - 1].days + 4);
  assert.ok(spread(plan.cycles.slice(lockedCount + 2)) <= 1);
  assert.equal(plan.cycles.at(-1).endDate, "2026-12-31");
  assertContiguous(plan);
  const changed = diffCyclePlans(published, plan.cycles).map(row => row.cycle);
  assert.ok(changed.length > 0 && changed.every(cycle => cycle > lockedCount));
});

test("impossible fixed lengths are reported instead of silently changed", () => {
  const plan = planCycles({ startDate: "2026-01-02", cycleCount: 25, lengths: [{ fromCycle: 1, toCycle: 25, days: 11 }] });
  assert.equal(plan.ok, false);
  assert.equal(plan.conflicts[0].code, "fixed_exceeds_available");
  assert.equal(plan.cycles.length, 0);

  // December 2026 has 22 working days; 21 fixed leaves one day for two flexible cycles.
  const tooMany = planCycles({ startDate: "2026-12-01", cycleCount: 3, lengths: [{ cycle: 1, days: 21 }] });
  assert.equal(tooMany.conflicts[0].code, "not_enough_days");
});

test("locked cycles cannot be resized and their dates are returned unchanged", () => {
  const published = planCycles({ startDate: "2026-01-02", cycleCount: 25 }).cycles;
  const baseline = published.map(c => ({ ...c, locked: c.cycle <= 3 }));
  const plan = planCycles({ startDate: "2026-01-02", cycleCount: 25, baseline, lengths: [{ cycle: 2, days: 5 }] });
  assert.equal(plan.ok, false);
  assert.equal(plan.conflicts[0].code, "locked_cycle_constraint");
  assert.deepEqual(plan.cycles.slice(0, 3).map(c => c.startDate), published.slice(0, 3).map(c => c.startDate));
});

test("a locked cycle in the middle splits the year into independently balanced spans", () => {
  const published = planCycles({ startDate: "2026-01-02", cycleCount: 25 }).cycles;
  const baseline = published.map(c => ({ ...c, locked: c.cycle === 13 }));
  const plan = planCycles({ startDate: "2026-01-02", cycleCount: 25, baseline, lengths: [{ cycle: 2, days: 15 }] });
  assert.equal(plan.ok, true);
  assert.deepEqual([plan.cycles[12].startDate, plan.cycles[12].endDate], [published[12].startDate, published[12].endDate]);
  assert.ok(spread(plan.cycles.slice(0, 12).filter(c => c.cycle !== 2)) <= 1);
  assertContiguous(plan);

  const gap = planCycles({
    startDate: "2026-01-02",
    cycleCount: 25,
    baseline,
    lengths: [{ fromCycle: 1, toCycle: 12, days: 5 }]
  });
  assert.equal(gap.conflicts[0].code, "gap_before_locked_cycle");
});

test("extending a cycle without a current length is a conflict", () => {
  const plan = planCycles({ startDate: "2026-01-02", cycleCount: 5, lengths: [{ cycle: 1, extendBy: 4 }] });
  assert.equal(plan.conflicts[0].code, "missing_baseline");
});
