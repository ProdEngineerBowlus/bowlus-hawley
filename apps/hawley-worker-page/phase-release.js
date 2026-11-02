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

function runStatus(release) {
  return release.run_status === "success" ? "released" : release.run_status === "failed" ? "failed" : "releasing";
}

// Fabrication: one full project per cycle (F21.26), released a few working days before the cycle starts.
// cycles: { cycle_key, cycle_label, start_date }; releases: hb.fabrication_releases rows with run_status;
// existingProjectNames: projects already in Asana/Hawley (made by hand or earlier), which are never re-created.
export function fabricationReleasePlan(cycles, releases, { today, leadWorkingDays = 2, existingProjectNames = new Set(), projectNameFor, limit = 4 } = {}) {
  const releaseByCycle = new Map((releases || []).map(row => [row.cycle_key, row]));
  return [...(cycles || [])]
    .filter(cycle => cycle.start_date && String(cycle.start_date).slice(0, 10) >= today)
    .sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)))
    .slice(0, limit)
    .map(cycle => {
      const cycleStart = String(cycle.start_date).slice(0, 10);
      const due = releaseDueDate(cycleStart, leadWorkingDays);
      const projectName = projectNameFor(cycle);
      const release = releaseByCycle.get(cycle.cycle_key) || null;
      const status = release ? runStatus(release)
        : existingProjectNames.has(projectName) ? "exists"
          : due && today >= due ? "due" : "upcoming";
      return {
        cycleKey: cycle.cycle_key,
        cycleLabel: cycle.cycle_label || cycle.cycle_key,
        projectName,
        cycleStart,
        releaseDue: due,
        status,
        canRelease: status === "due" || status === "upcoming" || status === "failed",
        taskCount: release ? Number(release.task_count || 0) : null,
        releasedAt: release?.released_at || null,
        releasedBy: release?.released_by || ""
      };
    });
}

// Frames stage: its phases (A1/A2 by default; hb.workflow_stages) go to the cycle's Frames project and must pass
// the Frames gate before the next phase.
export const FRAMES_PHASES = Object.freeze(["A1", "A2"]);

// Project names from a stage pattern: {cycle} -> "22.26", {vin}, {model}. "FR{cycle}" + "C22.26" -> "FR22.26".
export function stageProjectName(pattern, { cycleLabel = "", vin = "", model = "" } = {}) {
  const match = /^C?(\d+)\.(\d{2})$/i.exec(String(cycleLabel || "").trim());
  const cycle = match ? `${match[1]}.${match[2]}` : String(cycleLabel || "");
  return String(pattern || "").replaceAll("{cycle}", cycle).replaceAll("{vin}", String(vin)).replaceAll("{model}", String(model)).trim();
}

export function framesProjectName(cycleLabel, pattern = "FR{cycle}") {
  return stageProjectName(pattern, { cycleLabel });
}

// The Frames gate is ready when every Frames phase is released and all of its tasks are complete. Checklist items
// (hb.workflow_gates) must all be ticked when passing.
export function framesGateStatus(plan, { total = 0, complete = 0, gate = null, checklist = [] } = {}) {
  const framesPhases = (plan || []).filter(row => row.target === "frames");
  const released = framesPhases.length > 0 && framesPhases.every(row => row.status === "released");
  const status = gate?.status === "passed" ? "passed"
    : gate?.status === "passing" ? "passing"
      : gate?.status === "failed" ? "failed"
        : released && total > 0 && complete >= total ? "ready" : "open";
  return { status, total, complete, released, canPass: status === "ready" || status === "failed", canOverride: released && status === "open", result: gate?.result || null, checklist: [...checklist] };
}

// scheduleRows: { phase_name, production_record_id, cycle_label, start_date } for one VIN.
// releases: hb.phase_releases rows joined with their run status ({ phase_name, run_status, task_count, ... }).
// framesStage: A1/A2 release into Frames and the first later phase waits for the Frames gate (framesGatePassed).
export function releasePlan(scheduleRows, releases, { today, leadWorkingDays = 2, framesStage = false, framesGatePassed = false, framesPhases = FRAMES_PHASES, framesProjectPattern = "FR{cycle}" } = {}) {
  const releaseByPhase = new Map((releases || []).map(row => [row.phase_name, row]));
  const phases = [...(scheduleRows || [])]
    .filter(row => row.phase_name)
    .sort((a, b) => String(a.start_date || "").localeCompare(String(b.start_date || "")) || String(a.phase_name).localeCompare(String(b.phase_name)));
  let previousReleased = true;
  let gateChecked = false;
  return phases.map(row => {
    const release = releaseByPhase.get(row.phase_name) || null;
    const cycleStart = row.start_date ? String(row.start_date).slice(0, 10) : null;
    const due = releaseDueDate(cycleStart, leadWorkingDays);
    const target = framesStage && framesPhases.includes(row.phase_name) ? "frames" : "vin";
    const waitsForGate = framesStage && target === "vin" && !gateChecked;
    if (target === "vin") gateChecked = true;
    let status;
    if (release) {
      status = runStatus(release);
    } else if (!previousReleased) {
      status = "waiting";
    } else if (waitsForGate && !framesGatePassed) {
      status = "gate";
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
      target,
      projectName: target === "frames" ? framesProjectName(row.cycle_label, framesProjectPattern) : null,
      status,
      canRelease: status === "due" || status === "upcoming" || status === "failed",
      runId: release?.project_creation_run_id || null,
      taskCount: release ? Number(release.task_count || 0) : null,
      releasedAt: release?.released_at || null,
      releasedBy: release?.released_by || ""
    };
  });
}
