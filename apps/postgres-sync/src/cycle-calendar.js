// Deterministic company calendar and cycle planner. Pure functions: no database or network access.
// Dates are ISO "YYYY-MM-DD" strings computed in UTC so local time zones cannot shift a day.

const DAY_MS = 86400000;

// Company closures supplied by the user on 2026-10-29. Weekend observance is a default policy
// (Saturday -> Friday, Sunday -> Monday) and applies only to fixed-date holidays.
export const DEFAULT_COMPANY_CALENDAR = Object.freeze({
  weekendDays: [0, 6],
  rules: [
    { key: "new_years_day", name: "New Year's Day", rule: { type: "fixed", month: 1, day: 1 }, observe: "nearest_weekday" },
    { key: "memorial_day", name: "Memorial Day", rule: { type: "last_weekday", month: 5, weekday: 1 } },
    { key: "independence_day", name: "Independence Day", rule: { type: "fixed", month: 7, day: 4 }, observe: "nearest_weekday" },
    { key: "labor_day", name: "Labor Day", rule: { type: "nth_weekday", month: 9, weekday: 1, n: 1 } },
    { key: "thanksgiving_day", name: "Thanksgiving Day", rule: { type: "nth_weekday", month: 11, weekday: 4, n: 4 } },
    { key: "day_after_thanksgiving", name: "Day After Thanksgiving", rule: { type: "after", holiday: "thanksgiving_day", days: 1 } },
    { key: "christmas_day", name: "Christmas Day", rule: { type: "fixed", month: 12, day: 25 }, observe: "nearest_weekday" }
  ],
  // Per-date overrides: "open" removes a closure, "closed" adds a one-off closure.
  exceptions: [
    { date: "2026-11-27", action: "open", note: "No day-after-Thanksgiving closure in 2026." }
  ]
});

export function parseIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? time : null;
}

const isoFromTime = time => new Date(time).toISOString().slice(0, 10);
const isoOf = (year, month, day) => isoFromTime(Date.UTC(year, month - 1, day));
export const addDays = (iso, days) => isoFromTime(parseIsoDate(iso) + days * DAY_MS);
export const weekdayOf = iso => new Date(parseIsoDate(iso)).getUTCDay();

function ruleDate(rule, year, resolved) {
  switch (rule.type) {
    case "fixed":
      return isoOf(year, rule.month, rule.day);
    case "nth_weekday": {
      const first = isoOf(year, rule.month, 1);
      return addDays(first, ((rule.weekday - weekdayOf(first) + 7) % 7) + 7 * (rule.n - 1));
    }
    case "last_weekday": {
      const last = addDays(rule.month === 12 ? isoOf(year + 1, 1, 1) : isoOf(year, rule.month + 1, 1), -1);
      return addDays(last, -((weekdayOf(last) - rule.weekday + 7) % 7));
    }
    case "after":
      return resolved[rule.holiday] ? addDays(resolved[rule.holiday], rule.days) : null;
    default:
      throw new Error(`Unknown holiday rule type: ${rule.type}`);
  }
}

function observedDate(actual, observe) {
  if (observe !== "nearest_weekday") return actual;
  const day = weekdayOf(actual);
  return day === 6 ? addDays(actual, -1) : day === 0 ? addDays(actual, 1) : actual;
}

// Weekday company closures between two dates (inclusive), with exceptions applied.
export function companyClosures(fromIso, toIso, calendar = DEFAULT_COMPANY_CALENDAR) {
  const weekend = new Set(calendar.weekendDays);
  const fromYear = Number(fromIso.slice(0, 4));
  const toYear = Number(toIso.slice(0, 4));
  const byDate = new Map();
  // Neighbouring years are included because an observed date can cross a year boundary.
  for (let year = fromYear - 1; year <= toYear + 1; year++) {
    const resolved = {};
    for (const holiday of calendar.rules) {
      const actual = ruleDate(holiday.rule, year, resolved);
      if (!actual) continue;
      resolved[holiday.key] = actual;
      const date = observedDate(actual, holiday.observe);
      byDate.set(date, { date, key: holiday.key, name: date === actual ? holiday.name : `${holiday.name} (observed)`, actualDate: actual });
    }
  }
  for (const exception of calendar.exceptions || []) {
    if (exception.action === "open") byDate.delete(exception.date);
    if (exception.action === "closed") {
      byDate.set(exception.date, { date: exception.date, key: exception.key || "company_closure", name: exception.name || "Company closure", actualDate: exception.date });
    }
  }
  return [...byDate.values()]
    .filter(closure => closure.date >= fromIso && closure.date <= toIso && !weekend.has(weekdayOf(closure.date)))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function workingDays(fromIso, toIso, calendar = DEFAULT_COMPANY_CALENDAR) {
  const weekend = new Set(calendar.weekendDays);
  const closed = new Set(companyClosures(fromIso, toIso, calendar).map(closure => closure.date));
  const days = [];
  for (let date = fromIso; date <= toIso; date = addDays(date, 1)) {
    if (!weekend.has(weekdayOf(date)) && !closed.has(date)) days.push(date);
  }
  return days;
}

const quarterOf = iso => `Q${Math.ceil(Number(iso.slice(5, 7)) / 3)}`;
const isPositiveInteger = value => Number.isInteger(value) && value > 0;

function expandLengthConstraints(constraints) {
  const out = [];
  for (const constraint of constraints || []) {
    const from = constraint.cycle ?? constraint.fromCycle;
    const to = constraint.cycle ?? constraint.toCycle ?? from;
    for (let cycle = from; cycle <= to; cycle++) out.push({ ...constraint, cycle });
  }
  return out;
}

// Plans one year's cycles over working days. Locked cycles keep their exact dates. Fixed lengths are
// reserved first; the remaining working days in each span are spread over flexible cycles so their
// lengths differ by at most one day; earlier cycles take the extra days, so lengths descend. Problems are returned as
// conflicts instead of being silently adjusted.
export function planCycles({
  year,
  startDate,
  endDate,
  firstCycleNumber = 1,
  cycleCount,
  lengths = [],
  baseline = [],
  calendar = DEFAULT_COMPANY_CALENDAR
}) {
  const conflicts = [];
  const warnings = [];
  const fail = (code, message, cycles = []) => conflicts.push({ code, message, cycles });

  if (parseIsoDate(startDate) === null) fail("invalid_input", `Start date "${startDate}" must be YYYY-MM-DD.`);
  const horizonEnd = endDate ?? (parseIsoDate(startDate) === null ? null : `${startDate.slice(0, 4)}-12-31`);
  if (parseIsoDate(horizonEnd) === null) fail("invalid_input", `End date "${endDate}" must be YYYY-MM-DD.`);
  if (!isPositiveInteger(cycleCount)) fail("invalid_input", "Cycle count must be a positive whole number.");
  if (!isPositiveInteger(firstCycleNumber)) fail("invalid_input", "First cycle number must be a positive whole number.");
  if (conflicts.length) return { ok: false, year, cycles: [], conflicts, warnings };
  if (horizonEnd < startDate) {
    fail("invalid_input", "End date is before start date.");
    return { ok: false, year, cycles: [], conflicts, warnings };
  }

  const planYear = year ?? Number(startDate.slice(0, 4));
  const days = workingDays(startDate, horizonEnd, calendar);
  if (days[0] && days[0] !== startDate) warnings.push({ code: "start_moved", message: `${startDate} is not a working day; the first cycle starts ${days[0]}.` });
  const indexOf = new Map(days.map((date, index) => [date, index]));
  const numbers = Array.from({ length: cycleCount }, (_, index) => firstCycleNumber + index);
  const inPlan = new Set(numbers);
  const baselineByCycle = new Map(baseline.filter(row => inPlan.has(row.cycle)).map(row => [row.cycle, row]));

  // Locked cycles become fixed anchors on the working-day list.
  const anchors = new Map();
  for (const row of baselineByCycle.values()) {
    if (!row.locked) continue;
    if (row.startDate < startDate || row.endDate > horizonEnd) {
      fail("locked_outside_horizon", `Locked cycle ${row.cycle} (${row.startDate} to ${row.endDate}) is outside the planning range.`, [row.cycle]);
      continue;
    }
    const covered = days.filter(date => date >= row.startDate && date <= row.endDate);
    if (!covered.length) {
      fail("locked_without_working_days", `Locked cycle ${row.cycle} has no working days.`, [row.cycle]);
      continue;
    }
    anchors.set(row.cycle, { startIndex: indexOf.get(covered[0]), endIndex: indexOf.get(covered.at(-1)), row });
  }
  let previous = null;
  for (const cycle of numbers) {
    const anchor = anchors.get(cycle);
    if (!anchor) continue;
    // Overlapping history is reported but kept as-is: locked dates are never rewritten. Any flexible
    // cycle squeezed between overlapping locked cycles still fails with not_enough_days below.
    if (previous && anchor.startIndex <= previous.anchor.endIndex) {
      warnings.push({ code: "locked_overlap", message: `Locked cycles ${previous.cycle} and ${cycle} overlap or are out of order; their dates are kept as published.`, cycles: [previous.cycle, cycle] });
    }
    previous = { cycle, anchor };
  }

  // A cycle that has started but not ended keeps its start date, unless that start overlaps an earlier
  // locked cycle; then it starts the next working day after it. By default it keeps its published end
  // date; a length rule can extend or shorten it.
  const currentStarts = new Map();
  for (const row of baselineByCycle.values()) {
    if (row.locked || !row.startLocked) continue;
    let startIndex = days.findIndex(date => date >= row.startDate);
    if (row.startDate < startDate || startIndex < 0) {
      fail("current_outside_horizon", `Current cycle ${row.cycle} starts ${row.startDate}, outside the planning range.`, [row.cycle]);
      continue;
    }
    const earlierLockedEnd = Math.max(-1, ...[...anchors].filter(([number]) => number < row.cycle).map(([, anchor]) => anchor.endIndex));
    if (startIndex <= earlierLockedEnd) {
      startIndex = earlierLockedEnd + 1;
      warnings.push({ code: "current_start_moved", message: `Current cycle ${row.cycle} started ${row.startDate}, overlapping an earlier cycle; it now starts ${days[startIndex]}.`, cycles: [row.cycle] });
    }
    const publishedDays = days.filter(date => date >= days[startIndex] && date <= row.endDate).length;
    currentStarts.set(row.cycle, { startIndex, publishedDays: Math.max(1, publishedDays) });
  }

  const fixed = new Map();
  for (const constraint of expandLengthConstraints(lengths)) {
    const { cycle } = constraint;
    if (!inPlan.has(cycle)) {
      fail("unknown_cycle", `Cycle ${cycle} is not in this plan.`, [cycle]);
      continue;
    }
    if (anchors.has(cycle)) {
      fail("locked_cycle_constraint", `Cycle ${cycle} has ended and is locked; its dates cannot be changed.`, [cycle]);
      continue;
    }
    let length = constraint.days;
    if (constraint.extendBy !== undefined) {
      const current = baselineByCycle.get(cycle);
      const currentDays = currentStarts.get(cycle)?.publishedDays
        ?? current?.days
        ?? (current ? workingDays(current.startDate, current.endDate, calendar).length : null);
      if (!currentDays) {
        fail("missing_baseline", `Cycle ${cycle} has no current length to extend.`, [cycle]);
        continue;
      }
      length = currentDays + constraint.extendBy;
    }
    if (!isPositiveInteger(length)) {
      fail("invalid_length", `Cycle ${cycle} length must be a positive whole number of working days.`, [cycle]);
      continue;
    }
    if (fixed.has(cycle) && fixed.get(cycle) !== length) fail("conflicting_lengths", `Cycle ${cycle} was given two different lengths.`, [cycle]);
    fixed.set(cycle, length);
  }
  const currentDefaults = new Set();
  for (const [cycle, current] of currentStarts) {
    if (fixed.has(cycle)) continue;
    fixed.set(cycle, current.publishedDays);
    currentDefaults.add(cycle);
  }

  // Split into spans separated by locked cycles (and the start of a current cycle) and solve each
  // span independently.
  const spans = [];
  let span = { start: 0, cycles: [] };
  let lockedThrough = -1;
  for (const cycle of numbers) {
    const anchor = anchors.get(cycle);
    const current = currentStarts.get(cycle);
    if (current) {
      spans.push({ ...span, end: current.startIndex - 1, trailing: false, leading: !spans.length });
      span = { start: current.startIndex, cycles: [cycle] };
      continue;
    }
    if (!anchor) {
      span.cycles.push(cycle);
      continue;
    }
    spans.push({ ...span, end: anchor.startIndex - 1, trailing: false, leading: !spans.length });
    lockedThrough = Math.max(lockedThrough, anchor.endIndex);
    span = { start: lockedThrough + 1, cycles: [] };
  }
  spans.push({ ...span, end: days.length - 1, trailing: true });

  const assigned = new Map();
  for (const { start, end, cycles, trailing, leading } of spans) {
    const available = Math.max(0, end - start + 1);
    const flexible = cycles.filter(cycle => !fixed.has(cycle));
    const reserved = cycles.reduce((sum, cycle) => sum + (fixed.get(cycle) || 0), 0);
    const remaining = available - reserved;
    const label = cycles.length ? `cycles ${cycles[0]}-${cycles.at(-1)}` : "the gap between locked cycles";
    if (remaining < 0) {
      fail("fixed_exceeds_available", `Fixed lengths for ${label} need ${reserved} working days but only ${available} are available.`, cycles);
      continue;
    }
    if (!flexible.length && remaining > 0) {
      if (trailing) {
        warnings.push({ code: "unassigned_days", message: `${remaining} working days after cycle ${numbers.at(-1)} are not in any cycle.` });
      } else if (leading && !cycles.length) {
        warnings.push({ code: "unassigned_days", message: `${remaining} working days before cycle ${numbers[0]} are not in any cycle.` });
      } else {
        fail("gap_before_locked_cycle", `${label} leave ${remaining} working days uncovered before the next locked cycle.`, cycles);
        continue;
      }
    }
    if (flexible.length && remaining < flexible.length) {
      fail("not_enough_days", `${flexible.length} flexible cycles in ${label} need at least ${flexible.length} working days but only ${remaining} remain after fixed lengths.`, cycles);
      continue;
    }
    const base = flexible.length ? Math.floor(remaining / flexible.length) : 0;
    let extra = flexible.length ? remaining % flexible.length : 0;
    let index = start;
    for (const cycle of cycles) {
      let length = fixed.get(cycle);
      const source = currentDefaults.has(cycle) ? "current" : length ? "fixed" : "flexible";
      if (!length) {
        length = base + (extra > 0 ? 1 : 0);
        if (extra > 0) extra--;
      }
      assigned.set(cycle, { startDate: days[index], endDate: days[index + length - 1], days: length, source });
      index += length;
    }
  }

  const cycles = [];
  for (const cycle of numbers) {
    const anchor = anchors.get(cycle);
    const plan = anchor
      ? { startDate: anchor.row.startDate, endDate: anchor.row.endDate, days: anchor.endIndex - anchor.startIndex + 1, source: "locked" }
      : assigned.get(cycle);
    if (!plan) continue;
    cycles.push({
      year: planYear,
      cycle,
      ...plan,
      quarter: quarterOf(plan.startDate),
      holidays: companyClosures(plan.startDate, plan.endDate, calendar).map(({ date, name }) => ({ date, name }))
    });
  }

  return { ok: conflicts.length === 0, year: planYear, workingDayCount: days.length, cycles, conflicts, warnings };
}

// Lists cycles whose dates or length differ between a published plan and a proposal.
export function diffCyclePlans(before, after) {
  const beforeByCycle = new Map(before.map(row => [row.cycle, row]));
  const afterByCycle = new Map(after.map(row => [row.cycle, row]));
  const cycles = [...new Set([...beforeByCycle.keys(), ...afterByCycle.keys()])].sort((a, b) => a - b);
  const pick = row => (row ? { startDate: row.startDate, endDate: row.endDate, days: row.days } : null);
  return cycles
    .map(cycle => ({ cycle, before: pick(beforeByCycle.get(cycle)), after: pick(afterByCycle.get(cycle)) }))
    .filter(({ before: a, after: b }) => JSON.stringify(a) !== JSON.stringify(b));
}
