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
