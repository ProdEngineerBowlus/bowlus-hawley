import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  buildCycleIndex,
  dateValue,
  fabricationProjectCycleLabel,
  findCycleByReference,
  parseCycleReference,
  qualifyCycleReference,
  resolveAsanaCompletion,
  resolveCycleAttachment,
  splitTaskHours
} from "../src/hb-calculation-rules.js";

const c12_2025 = {
  cycle_record_id: "rec-c12-25",
  cycle_number: 12,
  cycle_label: "C12",
  start_date: "2025-06-16",
  end_date: "2025-06-27"
};

const c12_2026 = {
  cycle_record_id: "rec-c12-26",
  cycle_number: 12,
  cycle_label: "C12",
  start_date: "2026-06-15",
  end_date: "2026-06-26"
};

const c13_2026 = {
  cycle_record_id: "rec-c13-26",
  cycle_number: 13,
  cycle_label: "C13",
  start_date: "2026-06-29",
  end_date: "2026-07-10"
};

test("cycle references retain their two- or four-digit year", () => {
  assert.deepEqual(parseCycleReference("C12.25"), {
    number: 12,
    year: 2025,
    canonicalLabel: "C12.25"
  });
  assert.deepEqual(parseCycleReference("c 12 . 26"), {
    number: 12,
    year: 2026,
    canonicalLabel: "C12.26"
  });
  assert.deepEqual(parseCycleReference("C12.2026"), {
    number: 12,
    year: 2026,
    canonicalLabel: "C12.26"
  });
  assert.equal(fabricationProjectCycleLabel("F12.26"), "C12.26");
  assert.equal(qualifyCycleReference("C12", "VINs - 2025"), "C12.25");
  assert.equal(qualifyCycleReference("C12.26", "VINs - 2025"), "C12.26");
});

test("qualified cycle lookup is correct and independent of row order", () => {
  for (const cycles of [
    [c12_2025, c12_2026, c13_2026],
    [c13_2026, c12_2026, c12_2025]
  ]) {
    const index = buildCycleIndex(cycles);
    assert.equal(findCycleByReference(index, "C12.25")?.cycle_record_id, "rec-c12-25");
    assert.equal(findCycleByReference(index, "C12.26")?.cycle_record_id, "rec-c12-26");
    assert.equal(findCycleByReference(index, "C12.2026")?.cycle_record_id, "rec-c12-26");
  }
});

test("unknown or ambiguous cycle references never fall into another year", () => {
  const index = buildCycleIndex([c12_2025, c12_2026, c13_2026]);
  assert.equal(findCycleByReference(index, "C12.27"), null);
  assert.equal(findCycleByReference(index, "C12"), null);
  assert.equal(findCycleByReference(index, "C13")?.cycle_record_id, "rec-c13-26");
  assert.equal(findCycleByReference(index, "C12", "C12.25")?.cycle_record_id, "rec-c12-25");
});

test("cycle attachment switches only on an exact year and clears an unknown year", () => {
  const index = buildCycleIndex([c12_2025, c12_2026]);
  assert.deepEqual(resolveCycleAttachment(index, "C12.25", "rec-c12-26"), {
    cycle: c12_2025,
    cycleRecordId: "rec-c12-25",
    cycleLabel: "C12",
    clearExisting: false
  });
  assert.deepEqual(resolveCycleAttachment(index, "C12.26", "rec-c12-25"), {
    cycle: c12_2026,
    cycleRecordId: "rec-c12-26",
    cycleLabel: "C12",
    clearExisting: false
  });
  assert.deepEqual(resolveCycleAttachment(index, "C12.27", "rec-c12-26"), {
    cycle: null,
    cycleRecordId: null,
    cycleLabel: "C12.27",
    clearExisting: true
  });
  assert.deepEqual(resolveCycleAttachment(index, "C12", "rec-c12-25"), {
    cycle: null,
    cycleRecordId: "rec-c12-25",
    cycleLabel: "C12",
    clearExisting: false
  });
});

test("a Date returned by Postgres preserves its calendar completion date", () => {
  assert.equal(dateValue(new Date("2026-07-10T19:45:00.000Z")), "2026-07-10");
  assert.equal(dateValue("2026-07-10T19:45:00.000Z"), "2026-07-10");
  assert.equal(dateValue({ date: "2026-07-10" }), "2026-07-10");
});

test("an open subtask inherits completion and date from its completed parent", () => {
  assert.deepEqual(resolveAsanaCompletion({
    completed: false,
    parent_completed: true,
    parent_completed_at: new Date("2026-07-10T19:45:00.000Z")
  }), {
    completed: true,
    directCompleted: false,
    parentCompleted: true,
    inheritedFromParent: true,
    completedOn: "2026-07-10"
  });
});

test("joined parent state overrides a stale embedded parent snapshot", () => {
  const result = resolveAsanaCompletion({
    completed: false,
    parent_completed: false,
    raw_json: {
      parent: { completed: true, completed_at: "2026-07-10T19:45:00.000Z" }
    }
  });
  assert.equal(result.completed, false);
  assert.equal(result.inheritedFromParent, false);
  assert.equal(result.completedOn, null);
});

test("embedded parent completion is used when the joined parent is unavailable", () => {
  const result = resolveAsanaCompletion({
    completed: false,
    raw_json: {
      parent: { completed: true, completed_at: "2026-07-10T19:45:00.000Z" }
    }
  });
  assert.equal(result.completed, true);
  assert.equal(result.inheritedFromParent, true);
  assert.equal(result.completedOn, "2026-07-10");
});

test("reopening a parent reopens inherited work and clears its inherited date", () => {
  const result = resolveAsanaCompletion({
    completed: false,
    parent_completed: false
  }, "2026-07-10");
  assert.equal(result.completed, false);
  assert.equal(result.inheritedFromParent, false);
  assert.equal(result.completedOn, null);
});

test("a child's direct completion remains authoritative", () => {
  const result = resolveAsanaCompletion({
    completed: true,
    completed_at: new Date("2026-07-11T08:00:00.000Z"),
    parent_completed: false
  });
  assert.equal(result.completed, true);
  assert.equal(result.inheritedFromParent, false);
  assert.equal(result.completedOn, "2026-07-11");
});

test("completed subtasks move all accompanied task hours out of remaining", () => {
  assert.deepEqual(splitTaskHours(6.75, true), {
    totalHours: 6.75,
    completedHours: 6.75,
    remainingHours: 0
  });
  assert.deepEqual(splitTaskHours(6.75, false), {
    totalHours: 6.75,
    completedHours: 0,
    remainingHours: 6.75
  });
});

test("every Asana raw-task writer requests parent completion fields", async () => {
  const writerFiles = [
    "pull-asana.js",
    "pull-asana-events.js",
    "pull-daily-tracker.js"
  ];
  for (const filename of writerFiles) {
    const source = await readFile(new URL(`../src/${filename}`, import.meta.url), "utf8");
    assert.match(source, /"parent\.completed"/);
    assert.match(source, /"parent\.completed_at"/);
  }
});
