// === VARIABLE BLOCK ===

const tableName = "Cycles";
const startDateField = "Start Date";
const endDateField = "End Date";
const durationField = "Days In Cycle";
const quarterField = "Quarter";
const holidayField = "Holidays";
const cycleNumberField = "Cycle Number";

// =====================
// INPUT HELPERS
// =====================

function parseUserDate(s) {
  // Accept "YYYY-MM-DD" or "M/D/YYYY"
  s = (s || "").trim();
  if (s.includes("-")) {
    const [yy, mm, dd] = s.split("-").map(n => parseInt(n, 10));
    return new Date(yy, mm - 1, dd);
  }
  if (s.includes("/")) {
    const [mm, dd, yy] = s.split("/").map(n => parseInt(n, 10));
    return new Date(yy, mm - 1, dd);
  }
  // fallback
  const d = new Date(s);
  return d;
}

function parseOverrides(str) {
  // "4=16, 5=16" -> {4:16,5:16}
  let out = {};
  if (!str) return out;
  str.split(",").forEach(pair => {
    const p = pair.trim();
    if (!p) return;
    const [k, v] = p.split("=").map(x => x.trim());
    const ck = parseInt(k, 10);
    const cv = parseInt(v, 10);
    if (!Number.isNaN(ck) && !Number.isNaN(cv)) out[ck] = cv;
  });
  return out;
}

// =====================
// HOLIDAY HELPERS
// =====================

function getFixedHoliday(year, month, day) {
  return new Date(year, month - 1, day);
}
function getNthWeekdayInMonth(year, month, weekday, n) {
  let d = new Date(year, month - 1, 1), c = 0;
  while (true) {
    if (d.getDay() === weekday && ++c === n) return new Date(d);
    d.setDate(d.getDate() + 1);
  }
}
function getLastWeekdayInMonth(year, month, weekday) {
  let d = new Date(year, month, 0);
  while (d.getDay() !== weekday) d.setDate(d.getDate() - 1);
  return d;
}

const holidayObjects = [
  { name: "New Year's Day", rule: y => getFixedHoliday(y, 1, 1) },
  { name: "Independence Day", rule: y => getFixedHoliday(y, 7, 3) },
  { name: "Christmas Day", rule: y => getFixedHoliday(y, 12, 25) },
  { name: "Thanksgiving", rule: y => getNthWeekdayInMonth(y, 11, 4, 4) },
  { name: "Day After Thanksgiving", rule: y => getNthWeekdayInMonth(y, 11, 5, 4) },
  { name: "Labor Day", rule: y => getNthWeekdayInMonth(y, 9, 1, 1) },
  { name: "Memorial Day", rule: y => getLastWeekdayInMonth(y, 5, 1) }
];

function isHoliday(d) {
  return holidayObjects
    .map(h => h.rule(d.getFullYear()))
    .some(h => h.toDateString() === d.toDateString());
}

function getQuarter(d) {
  const m = d.getMonth() + 1;
  return m <= 3 ? "Q1" : m <= 6 ? "Q2" : m <= 9 ? "Q3" : "Q4";
}

function collectBusinessDays(start, end) {
  let out = [];
  let d = new Date(start);
  while (d <= end) {
    if (d.getDay() !== 0 && d.getDay() !== 6 && !isHoliday(d)) {
      out.push(new Date(d));
    }
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function getHolidaysInRange(start, end) {
  let out = [];
  for (let y = start.getFullYear(); y <= end.getFullYear(); y++) {
    for (let h of holidayObjects) {
      let d = h.rule(y);
      if (d >= start && d <= end) out.push(`${h.name} (${d.toLocaleDateString()})`);
    }
  }
  return out.join(", ");
}

// =====================
// USER INPUTS
// =====================

let userStartDateStr = await input.textAsync("Enter starting update date (YYYY-MM-DD or M/D/YYYY):");
const userStartDate = parseUserDate(userStartDateStr);

if (isNaN(userStartDate.getTime())) {
  throw new Error("Invalid start date. Use YYYY-MM-DD or M/D/YYYY.");
}

let startSeqStr = await input.textAsync(
  "Enter Cycle Number for that start date (usually 1):"
);
let startSeq = parseInt(startSeqStr, 10);
if (Number.isNaN(startSeq)) startSeq = 1;

let totalCyclesStr = await input.textAsync("Enter TOTAL cycles in full year (e.g., 25):");
let totalCycles = parseInt(totalCyclesStr, 10);
if (Number.isNaN(totalCycles) || totalCycles < 1) {
  throw new Error("Total cycles must be a positive number.");
}

let explicitInput = await input.textAsync(
  "Enter explicit cycle overrides (format: 4=16,5=16) or press Enter:"
);
let explicitCycleOverrides = parseOverrides(explicitInput);

async function askQuarterOverride(q) {
  const yes = await input.textAsync(`Override cycle length for ${q}? (y/n)`);
  if (yes?.toLowerCase().startsWith("y")) {
    const d = await input.textAsync(`Enter Days In Cycle for ${q}:`);
    const v = parseInt(d, 10);
    return Number.isNaN(v) ? null : v;
  }
  return null;
}

const quarterOverrides = {
  Q1: await askQuarterOverride("Q1"),
  Q2: await askQuarterOverride("Q2"),
  Q3: await askQuarterOverride("Q3"),
  Q4: await askQuarterOverride("Q4")
};

// =====================
// MAIN
// =====================

const table = base.getTable(tableName);
let records = (await table.selectRecordsAsync()).records;

// Ensure enough records exist
if (records.length < totalCycles) {
  await table.createRecordsAsync(
    Array.from({ length: totalCycles - records.length }, () => ({ fields: {} }))
  );
  records = (await table.selectRecordsAsync()).records;
}

// Build business-day calendar to year end
const yearEnd = new Date(userStartDate.getFullYear(), 11, 31);
const businessDays = collectBusinessDays(userStartDate, yearEnd);

// ---- Iterative solver so quarter overrides apply to *actual* start dates ----

let lens = Array(totalCycles).fill(null);

// Seed lengths:
// explicit overrides take priority
for (let c = 1; c <= totalCycles; c++) {
  if (explicitCycleOverrides[c] != null) lens[c - 1] = explicitCycleOverrides[c];
}

// For cycles before startSeq, if startSeq > 1: we still generate them;
// (most of the time startSeq is 1, which matches your table output)
function buildScheduleWithLens(lensArr) {
  let idx = 0;
  let schedule = [];
  for (let i = 0; i < totalCycles; i++) {
    const cycleNum = startSeq + i; // label cycles from startSeq onward
    const start = businessDays[idx];
    if (!start) return { schedule, ok: false };

    // Determine quarter by actual start date
    const q = getQuarter(start);

    // Determine length
    let len = lensArr[i];

    // If no explicit len, and quarter override exists for this start quarter, force it
    if (len == null && quarterOverrides[q] != null) len = quarterOverrides[q];

    // If still null, leave as null (we’ll balance later)
    if (len == null) {
      schedule.push({ i, cycleNum, q, startIdx: idx, len: null });
      // don't advance idx yet until we assign a len
      // We'll advance using a temporary placeholder later in the balance pass
      return { schedule, ok: false, needsBalance: true };
    }

    const end = businessDays[idx + len - 1];
    if (!end) return { schedule, ok: false };

    schedule.push({ i, cycleNum, q, startIdx: idx, len, endIdx: idx + len - 1 });
    idx += len;
  }
  return { schedule, ok: true };
}

// Balance pass that assigns all remaining null lens based on remaining business days
function balanceRemaining(lensArr) {
  // First, walk sequentially and identify which cycles are fixed (explicit or quarter-forced)
  let idx = 0;
  let fixed = Array(totalCycles).fill(false);

  for (let i = 0; i < totalCycles; i++) {
    const start = businessDays[idx];
    if (!start) throw new Error("Not enough business days for requested plan.");

    const q = getQuarter(start);

    if (lensArr[i] != null) {
      fixed[i] = true;
    } else if (quarterOverrides[q] != null) {
      lensArr[i] = quarterOverrides[q];
      fixed[i] = true;
    }

    const lenNow = lensArr[i];
    // If still null, we cannot advance idx yet (unknown length)
    // So we stop here and handle remaining as flexible
    if (lenNow == null) break;

    idx += lenNow;
  }

  // Now compute remaining business days from current idx to year end
  const remainingBusinessDays = businessDays.length - idx;

  // Remaining cycles count
  let remainingCycles = 0;
  for (let i = 0; i < totalCycles; i++) if (lensArr[i] == null) remainingCycles++;

  if (remainingCycles === 0) return;

  if (remainingBusinessDays < remainingCycles) {
    throw new Error("Not enough remaining business days to allocate at least 1 day per remaining cycle.");
  }

  const baseLen = Math.floor(remainingBusinessDays / remainingCycles);
  let remainder = remainingBusinessDays % remainingCycles;

  for (let i = 0; i < totalCycles; i++) {
    if (lensArr[i] == null) {
      lensArr[i] = baseLen + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;
    }
  }
}

// Iterate a couple times until quarters/overrides stabilize
for (let iter = 0; iter < 5; iter++) {
  // Assign any quarter overrides that are now determinable + balance the rest
  balanceRemaining(lens);

  // Now validate we can walk the whole year without running out of business days
  let idx = 0;
  let ok = true;
  for (let i = 0; i < totalCycles; i++) {
    const start = businessDays[idx];
    const len = lens[i];
    const end = businessDays[idx + len - 1];
    if (!start || !end) { ok = false; break; }
    idx += len;
  }
  if (ok) break;
}

// Final build + write
let idx = 0;

for (let i = 0; i < totalCycles; i++) {
  const cycleNum = startSeq + i;
  const start = businessDays[idx];
  const len = lens[i];
  const end = businessDays[idx + len - 1];

  if (!start || !end) {
    throw new Error("Plan exceeds available business days. Reduce fixed lengths or total cycles.");
  }

  const q = getQuarter(start);

  await table.updateRecordAsync(records[i].id, {
    [cycleNumberField]: cycleNum,
    [startDateField]: start,
    [endDateField]: end,
    [durationField]: len,
    [quarterField]: q,
    [holidayField]: getHolidaysInRange(start, end)
  });

  idx += len;
}

output.text("✅ Cycles generated (explicit overrides + quarter overrides + balanced remainder).");