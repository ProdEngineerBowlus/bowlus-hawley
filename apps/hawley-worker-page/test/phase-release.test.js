import test from "node:test";
import assert from "node:assert/strict";

import { releaseDueDate, releasePlan } from "../phase-release.js";

test("release is due the chosen number of working days before the cycle starts", () => {
  assert.equal(releaseDueDate("2026-11-16", 2), "2026-11-12", "Mon start: Thu and Fri before");
  assert.equal(releaseDueDate("2026-11-30", 2), "2026-11-24", "Thanksgiving and the day after are skipped");
  assert.equal(releaseDueDate("2026-11-16", 0), "2026-11-16");
  assert.equal(releaseDueDate(null, 2), null);
});

test("phases release in schedule order; later phases wait for earlier ones", () => {
  const rows = [
    { phase_name: "B", production_record_id: "p3", cycle_label: "C24", start_date: "2026-12-07" },
    { phase_name: "A1", production_record_id: "p1", cycle_label: "C22", start_date: "2026-11-16" },
    { phase_name: "A2", production_record_id: "p2", cycle_label: "C23", start_date: "2026-11-30" }
  ];
  let plan = releasePlan(rows, [], { today: "2026-11-02", leadWorkingDays: 2 });
  assert.deepEqual(plan.map(p => [p.phase, p.status, p.releaseDue]), [
    ["A1", "upcoming", "2026-11-12"],
    ["A2", "waiting", "2026-11-24"],
    ["B", "waiting", "2026-12-03"]
  ]);
  assert.deepEqual(plan.map(p => p.canRelease), [true, false, false]);

  plan = releasePlan(rows, [{ phase_name: "A1", run_status: "success", task_count: 40, project_creation_run_id: "r1" }], { today: "2026-11-25", leadWorkingDays: 2 });
  assert.deepEqual(plan.map(p => [p.phase, p.status]), [["A1", "released"], ["A2", "due"], ["B", "waiting"]]);
  assert.equal(plan[0].taskCount, 40);

  plan = releasePlan(rows, [{ phase_name: "A1", run_status: "failed", project_creation_run_id: "r1" }], { today: "2026-11-25" });
  assert.deepEqual(plan.map(p => [p.status, p.canRelease]), [["failed", true], ["waiting", false], ["waiting", false]], "a failed release can be retried and blocks the next phase");
});

test("fabrication projects are due before each upcoming cycle and never re-created when they already exist", async () => {
  const { fabricationReleasePlan } = await import("../phase-release.js");
  const cycles = [
    { cycle_key: "C20.26", start_date: "2026-10-26" },
    { cycle_key: "C21.26", start_date: "2026-11-09" },
    { cycle_key: "C22.26", start_date: "2026-11-24" },
    { cycle_key: "C23.26", start_date: "2026-12-09" }
  ];
  const projectNameFor = cycle => `F${cycle.cycle_key.slice(1)}`;
  let plan = fabricationReleasePlan(cycles, [], { today: "2026-11-05", existingProjectNames: new Set(["F20.26"]), projectNameFor });
  assert.deepEqual(plan.map(p => [p.projectName, p.releaseDue, p.status]), [
    ["F21.26", "2026-11-05", "due"],
    ["F22.26", "2026-11-20", "upcoming"],
    ["F23.26", "2026-12-07", "upcoming"]
  ], "past cycles are not offered; F21 is due two working days before Nov 9");

  plan = fabricationReleasePlan(cycles, [{ cycle_key: "C21.26", run_status: "success", task_count: 120 }], { today: "2026-11-06", existingProjectNames: new Set(["F22.26"]), projectNameFor });
  assert.deepEqual(plan.map(p => [p.projectName, p.status, p.canRelease]), [
    ["F21.26", "released", false],
    ["F22.26", "exists", false],
    ["F23.26", "upcoming", true]
  ]);
});

test("Frames stage: A1/A2 go to the cycle's Frames project and Phase B waits for the Frames gate", async () => {
  const { framesGateStatus, framesProjectName } = await import("../phase-release.js");
  const rows = [
    { phase_name: "A1", cycle_label: "C22.26", start_date: "2026-11-24" },
    { phase_name: "A2", cycle_label: "C23.26", start_date: "2026-12-09" },
    { phase_name: "B", cycle_label: "C24.26", start_date: "2026-12-21" },
    { phase_name: "C", cycle_label: "C1.27", start_date: "2027-01-04" }
  ];
  const released = [{ phase_name: "A1", run_status: "success" }, { phase_name: "A2", run_status: "success" }];
  let plan = releasePlan(rows, released, { today: "2026-12-18", framesStage: true });
  assert.deepEqual(plan.map(p => [p.phase, p.target, p.projectName, p.status, p.canRelease]), [
    ["A1", "frames", "FR22.26", "released", false],
    ["A2", "frames", "FR23.26", "released", false],
    ["B", "vin", null, "gate", false],
    ["C", "vin", null, "waiting", false]
  ]);
  assert.deepEqual(framesGateStatus(plan, { total: 30, complete: 29 }).status, "open", "one task still open");
  assert.equal(framesGateStatus(plan, { total: 30, complete: 29 }).canOverride, true, "an admin can pass anyway with a reason");
  assert.deepEqual(framesGateStatus(plan, { total: 30, complete: 30 }), { status: "ready", total: 30, complete: 30, released: true, canPass: true, canOverride: false, result: null, checklist: [] });
  assert.equal(releasePlan(rows, released, { today: "2026-12-18", framesStage: true, framesPhases: ["A1"], framesProjectPattern: "Frames {cycle}" })[1].target, "vin", "stage phases come from the workflow");
  assert.equal(framesProjectName("C22.26", "Frames {cycle}"), "Frames 22.26");

  plan = releasePlan(rows, released, { today: "2026-12-18", framesStage: true, framesGatePassed: true });
  assert.equal(plan[2].status, "due", "after the gate, Phase B releases as usual");
  plan = releasePlan(rows, [], { today: "2026-11-02" });
  assert.deepEqual(plan.map(p => p.target), ["vin", "vin", "vin", "vin"], "without the Frames stage everything stays in the VIN project");
  assert.equal(framesProjectName("C1.27"), "FR1.27");
});
