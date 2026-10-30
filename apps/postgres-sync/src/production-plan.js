// Deterministic production (VIN position) generator. Ports the Airtable "Production Simulation With
// Offset - Rev ANT.9" rules; pure functions, no database access.
//
// Per cycle, in process order: FAB bucket (no VIN), A1/A2 for the cycle's VIN pair, Frame bucket (no VIN),
// install phases B-H at pair[0] - 2 ... pair[0] - 8, CNC bucket (no VIN). Odd ("set 1") cycles use A1 and the
// -A buckets; even ("set 2") cycles use A2 and the -B buckets. Odd cycles take the next two VINs ascending;
// even cycles reverse the previous pair without advancing. Parity continues across year boundaries.
// The original script read Task Offset but never applied it; neither does this port.

export const INSTALL_PHASES = ["B", "C", "D", "E", "F", "G", "H"];

// State after a cycle: its parity and VIN pair, plus the next VIN an odd cycle would take.
export function stateFromCycleRows(rows) {
  const aRows = rows.filter(row => row.phase_name === "A1" || row.phase_name === "A2");
  const vins = aRows.map(row => Number(row.vin)).filter(Number.isInteger);
  if (!aRows.length || vins.length !== 2) return null;
  const parity = aRows[0].phase_name === "A1" ? "odd" : "even";
  const low = Math.min(...vins);
  const high = Math.max(...vins);
  return { parity, pair: parity === "odd" ? [low, high] : [high, low], nextVin: high + 1 };
}

export function initialState(startVin, startParity) {
  // Mirrors computeFramePair with no previous pair: odd emits [n, n+1]; even emits [n+1, n]. Both advance by two.
  const vin = Number(startVin);
  return startParity === "even"
    ? { parity: "even", pair: [vin + 1, vin], nextVin: vin + 2 }
    : { parity: "odd", pair: [vin, vin + 1], nextVin: vin + 2 };
}

export function advanceState(state) {
  if (state.parity === "odd") return { parity: "even", pair: [state.pair[1], state.pair[0]], nextVin: state.nextVin };
  return { parity: "odd", pair: [state.nextVin, state.nextVin + 1], nextVin: state.nextVin + 2 };
}

// Phase lookup with the original fallback order: exact model, base model, no model, any. Anything other
// than an exact (or intended generic) match is reported so a wrong model cannot be picked silently.
export function resolvePhase(phases, name, modelId, baseModelIds = []) {
  const candidates = phases.filter(phase => phase.phase_name === name);
  if (!candidates.length) return { phase: null, match: "missing" };
  const modelOf = phase => (Array.isArray(phase.model_type) ? phase.model_type : [phase.model_type]).filter(Boolean);
  const pick = (match, phase) => ({ phase, match, ambiguous: false });
  if (modelId) {
    const exact = candidates.filter(phase => modelOf(phase).includes(modelId));
    if (exact.length) return { ...pick("exact", exact[0]), ambiguous: exact.length > 1 };
  }
  const base = candidates.filter(phase => modelOf(phase).some(id => baseModelIds.includes(id)));
  if (base.length) return pick("base", base[0]);
  const generic = candidates.filter(phase => !modelOf(phase).length);
  if (generic.length) return pick("generic", generic[0]);
  return { ...pick("fallback", candidates[0]), ambiguous: candidates.length > 1 };
}

// cycles: ordered [{ key, year, cycle, ... }]. state: the state after the cycle before cycles[0].
export function generateProductionPlan({ cycles, state, phases, vins, baseModelIds = [] }) {
  const vinByNumber = new Map(vins.map(vin => [Number(vin.vin), vin]));
  const rows = [];
  const conflicts = [];
  const warnings = [];
  const missingVins = new Set();
  const fallbackPhases = new Set();
  let current = state;

  const addRow = (cycle, phaseName, vinNumber) => {
    const vin = vinNumber == null ? null : vinByNumber.get(vinNumber) || null;
    if (vinNumber != null && !vin) missingVins.add(vinNumber);
    const modelId = vin ? (vin.model_type_record_ids || [])[0] || null : null;
    const resolved = resolvePhase(phases, phaseName, modelId, baseModelIds);
    if (!resolved.phase) {
      conflicts.push({ code: "phase_missing", message: `Phase ${phaseName} is not in Hawley's phase list (C${cycle.cycle}.${String(cycle.year).slice(-2)}).`, cycles: [cycle.cycle] });
      return;
    }
    if (vinNumber != null && vin && (resolved.match !== "exact" || resolved.ambiguous)) fallbackPhases.add(`${phaseName} for VIN ${vinNumber} (${resolved.match})`);
    rows.push({
      cycleKey: cycle.key,
      year: cycle.year,
      cycle: cycle.cycle,
      kind: vinNumber == null ? "bucket" : "vin",
      phaseName,
      phaseRecordId: resolved.phase.phase_record_id,
      sectionColumn: resolved.phase.section_column || null,
      processOrder: resolved.phase.process_order ?? null,
      vin: vinNumber == null ? null : String(vinNumber),
      vinRecordId: vin?.vin_record_id || null,
      modelType: modelId
    });
  };

  for (const cycle of cycles) {
    current = advanceState(current);
    const suffix = current.parity === "odd" ? "A" : "B";
    addRow(cycle, `FAB-${suffix}`, null);
    for (const vin of current.pair) addRow(cycle, current.parity === "odd" ? "A1" : "A2", vin);
    addRow(cycle, `Frame-${suffix}`, null);
    INSTALL_PHASES.forEach((phase, index) => addRow(cycle, phase, current.pair[0] - (index + 2)));
    addRow(cycle, `CNC-${suffix}`, null);
    cycle.parity = current.parity;
    cycle.pair = [...current.pair];
  }

  if (missingVins.size) {
    const sorted = [...missingVins].sort((a, b) => a - b);
    warnings.push({ code: "vins_not_in_hawley", message: `VINs ${sorted[0]}-${sorted.at(-1)} (${sorted.length}) are not in Hawley yet; their rows are planned without a VIN record or model.` });
  }
  if (fallbackPhases.size) {
    warnings.push({ code: "phase_model_fallback", message: `No exact model match, used fallback phase: ${[...fallbackPhases].slice(0, 6).join("; ")}${fallbackPhases.size > 6 ? "…" : ""}` });
  }
  return { rows, conflicts, warnings, endState: current };
}

// Matches planned rows to existing schedule rows so rows keep their IDs (and task links) when they move
// to another cycle. VIN rows match on phase + VIN. Bucket rows (no VIN) first stay in their own cycle,
// then the remaining ones match by phase in cycle order.
export function matchScheduleRows(plannedRows, existingRows, cycleOrder) {
  const order = key => cycleOrder.get(key) ?? Number.MAX_SAFE_INTEGER;
  const unused = new Map(existingRows.map(row => [row.production_record_id, row]));
  const byVinPhase = new Map();
  const bucketsByPhase = new Map();
  for (const row of [...existingRows].sort((a, b) => order(a.cycle_record_id) - order(b.cycle_record_id))) {
    if (row.vin) {
      const key = `${row.phase_name}|${row.vin}`;
      if (!byVinPhase.has(key)) byVinPhase.set(key, row);
    } else {
      bucketsByPhase.set(row.phase_name, [...(bucketsByPhase.get(row.phase_name) || []), row]);
    }
  }
  const take = row => { unused.delete(row.production_record_id); return row; };
  const matches = plannedRows.map(planned => {
    if (!planned.vin) return { planned, existing: null };
    const candidate = byVinPhase.get(`${planned.phaseName}|${planned.vin}`);
    return { planned, existing: candidate && unused.has(candidate.production_record_id) ? take(candidate) : null };
  });
  for (const match of matches.filter(m => !m.planned.vin)) {
    const same = (bucketsByPhase.get(match.planned.phaseName) || []).find(row => row.cycle_record_id === match.planned.cycleKey && unused.has(row.production_record_id));
    if (same) match.existing = take(same);
  }
  for (const match of matches.filter(m => !m.planned.vin && !m.existing)) {
    const next = (bucketsByPhase.get(match.planned.phaseName) || []).find(row => unused.has(row.production_record_id));
    if (next) match.existing = take(next);
  }
  return { matches, leftovers: [...unused.values()] };
}
