import test from "node:test";
import assert from "node:assert/strict";

import {
  advanceState,
  generateProductionPlan,
  initialState,
  matchScheduleRows,
  resolvePhase,
  stateFromCycleRows
} from "../src/production-plan.js";

const FRONTIER = "recl2xVPOf1X0CkjG";
const PHASES = ["A1", "A2", "B", "C", "D", "E", "F", "G", "H", "FAB-A", "FAB-B", "Frame-A", "Frame-B", "CNC-A", "CNC-B"]
  .map((name, index) => ({ phase_record_id: `ph-${name}`, phase_name: name, section_column: name, process_order: index + 1, model_type: FRONTIER }));
const VINS = Array.from({ length: 30 }, (_, index) => ({ vin: 320 + index, vin_record_id: `vin-${320 + index}`, model_type_record_ids: [FRONTIER] }));
const cycles = (year, from, to) => Array.from({ length: to - from + 1 }, (_, index) => ({ key: `c-${year}-${from + index}`, year, cycle: from + index }));
const summary = (rows, cycle) => rows.filter(row => row.cycle === cycle).map(row => `${row.phaseName}${row.vin ? `:${row.vin}` : ""}`).join(" ");

test("continuing from live C20 (A1 335/336) reproduces the live C24 and C25 schedule", () => {
  const state = stateFromCycleRows([{ phase_name: "A1", vin: "336" }, { phase_name: "A1", vin: "335" }]);
  assert.deepEqual(state, { parity: "odd", pair: [335, 336], nextVin: 337 });
  const plan = generateProductionPlan({ cycles: cycles(2026, 21, 25), state, phases: PHASES, vins: VINS });
  assert.deepEqual(plan.conflicts, []);
  assert.equal(summary(plan.rows, 24), "FAB-A A1:339 A1:340 Frame-A B:337 C:336 D:335 E:334 F:333 G:332 H:331 CNC-A");
  assert.equal(summary(plan.rows, 25), "FAB-B A2:340 A2:339 Frame-B B:338 C:337 D:336 E:335 F:334 G:333 H:332 CNC-B");
  assert.equal(plan.rows.length, 5 * 12);
});

test("parity continues across the year boundary when a cycle is dropped", () => {
  const state = stateFromCycleRows([{ phase_name: "A1", vin: "339" }, { phase_name: "A1", vin: "340" }]);
  const plan = generateProductionPlan({ cycles: cycles(2027, 1, 2), state, phases: PHASES, vins: VINS });
  // What was C25 2026 becomes C1 2027.
  assert.equal(summary(plan.rows, 1), "FAB-B A2:340 A2:339 Frame-B B:338 C:337 D:336 E:335 F:334 G:333 H:332 CNC-B");
  assert.equal(summary(plan.rows, 2), "FAB-A A1:341 A1:342 Frame-A B:339 C:338 D:337 E:336 F:335 G:334 H:333 CNC-A");
});

test("initial state mirrors the original first-cycle behaviour for set 1 and set 2", () => {
  assert.deepEqual(advanceState({ ...initialState(341, "odd"), parity: "even" }).pair, [343, 344]);
  assert.deepEqual(initialState(341, "even"), { parity: "even", pair: [342, 341], nextVin: 343 });
});

test("missing VINs and phases are reported instead of skipped", () => {
  const state = stateFromCycleRows([{ phase_name: "A2", vin: "348" }, { phase_name: "A2", vin: "347" }]);
  const phases = PHASES.filter(phase => phase.phase_name !== "CNC-A");
  const plan = generateProductionPlan({ cycles: cycles(2027, 1, 1), state, phases, vins: VINS });
  assert.ok(plan.warnings.some(w => w.code === "vins_not_in_hawley"));
  assert.ok(plan.rows.some(row => row.vin === "350" && row.vinRecordId === null), "row kept without VIN record");
  assert.equal(plan.conflicts[0].code, "phase_missing");
});

test("phase resolution prefers the VIN's model and flags fallbacks", () => {
  const phases = [{ phase_record_id: "x", phase_name: "B", model_type: "other" }, { phase_record_id: "y", phase_name: "B", model_type: FRONTIER }];
  assert.equal(resolvePhase(phases, "B", FRONTIER).phase.phase_record_id, "y");
  assert.equal(resolvePhase(phases, "B", "unknown").match, "fallback");
});

test("matching keeps row IDs for moved VIN rows and buckets, and returns leftovers", () => {
  const existing = [
    { production_record_id: "r1", cycle_record_id: "c25", phase_name: "H", vin: "332" },
    { production_record_id: "r2", cycle_record_id: "c25", phase_name: "FAB-B", vin: null },
    { production_record_id: "r3", cycle_record_id: "c25", phase_name: "Z", vin: "999" }
  ];
  const planned = [
    { cycleKey: "c1-27", phaseName: "H", vin: "332" },
    { cycleKey: "c1-27", phaseName: "FAB-B", vin: null },
    { cycleKey: "c1-27", phaseName: "B", vin: "338" }
  ];
  const { matches, leftovers } = matchScheduleRows(planned, existing, new Map([["c25", 0], ["c1-27", 1]]));
  assert.deepEqual(matches.map(m => m.existing?.production_record_id ?? null), ["r1", "r2", null]);
  assert.deepEqual(leftovers.map(row => row.production_record_id), ["r3"]);
});
