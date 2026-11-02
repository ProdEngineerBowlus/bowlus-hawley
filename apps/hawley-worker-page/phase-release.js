// Phase-by-phase release for pilot VINs (ramp step 4): pure scheduling rules, no database or Asana.
// A VIN's production rows give one phase per cycle (A1@C22, A2@C23, B@C24, ...). Each phase is due for
// release a few working days before its cycle starts, and phases release in order.
import { addDays, workingDays } from "../postgres-sync/src/cycle-calendar.js";

// The working day `leadWorkingDays` working days before cycleStart (0 = the start date itself).
export function releaseDueDate(cycleStart, leadWorkingDays) {
  if (!cycleStart) return null;
  const lead = Math.max(0, Number(leadWorkingDays) || 0);
  if (lead === 0) return cycleStart;
  const before = workingDays(addDays(cycleStart, -(lead * 3 + 14)), addDays(cycleStart, -1));
  return before[before.length - lead] || before[0] || cycleStart;
}

// scheduleRows: { phase_name, production_record_id, cycle_label, start_date } for one VIN.
// releases: hb.phase_releases rows joined with their run status ({ phase_name, run_status, task_count, ... }).
export function releasePlan(scheduleRows, releases, { today, leadWorkingDays = 2 } = {}) {
  const releaseByPhase = new Map((releases || []).map(row => [row.phase_name, row]));
  const phases = [...(scheduleRows || [])]
    .filter(row => row.phase_name)
    .sort((a, b) => String(a.start_date || "").localeCompare(String(b.start_date || "")) || String(a.phase_name).localeCompare(String(b.phase_name)));
  let previousReleased = true;
  return phases.map(row => {
    const release = releaseByPhase.get(row.phase_name) || null;
    const cycleStart = row.start_date ? String(row.start_date).slice(0, 10) : null;
    const due = releaseDueDate(cycleStart, leadWorkingDays);
    let status;
    if (release) {
      status = release.run_status === "success" ? "released" : release.run_status === "failed" ? "failed" : "releasing";
    } else if (!previousReleased) {
      status = "waiting";
    } else {
      status = due && today >= due ? "due" : "upcoming";
    }
    previousReleased = Boolean(release) && release.run_status === "success";
    return {
      phase: row.phase_name,
      productionRecordId: row.production_record_id || null,
      cycleLabel: row.cycle_label || "",
      cycleStart,
      releaseDue: due,
      status,
      canRelease: status === "due" || status === "upcoming" || status === "failed",
      runId: release?.project_creation_run_id || null,
      taskCount: release ? Number(release.task_count || 0) : null,
      releasedAt: release?.released_at || null,
      releasedBy: release?.released_by || ""
    };
  });
}
