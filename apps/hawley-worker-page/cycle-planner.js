// Admin cycle + production planner. One preview and one publish cover the cycle calendar for a year and
// the next year, plus the VIN position schedule (hb.production_schedule) for every future cycle.
// Calendar arithmetic lives in postgres-sync/cycle-calendar, VIN positions in postgres-sync/production-plan;
// this file adds database reads, lock rules, row matching and the publish transaction.
//
// Hawley is the planning source: publishing commits the plan, then (with the admin's confirmation) pushes
// moved tasks' Cycle field to Asana once. Afterwards the Asana sync drives day-to-day changes as before.
import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_COMPANY_CALENDAR, companyClosures, diffCyclePlans, planCycles } from "../postgres-sync/src/cycle-calendar.js";
import { HB_BUILD_LOCK_KEY, HB_BUILD_LOCK_NAMESPACE } from "../postgres-sync/src/hb-build-transaction.js";
import { generateProductionPlan, initialState, matchScheduleRows, stateFromCycleRows } from "../postgres-sync/src/production-plan.js";

const MAX_CYCLES = 60;

function plannerError(message, statusCode, details = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
}

// "22-25=8, 20+4, 3=12" -> fixed ranges, extensions and single fixed lengths.
export function parseLengthRules(text) {
  const lengths = [];
  const errors = [];
  for (const part of String(text || "").split(/[,;\n]+/).map(value => value.trim()).filter(Boolean)) {
    const match = /^c?(\d+)(?:\s*-\s*c?(\d+))?\s*(=|\+)\s*(\d+)$/i.exec(part);
    if (!match) {
      errors.push(`"${part}" is not a rule. Use 22-25=8, 20=12 or 20+4.`);
      continue;
    }
    const [, from, to, operator, value] = match;
    const range = to ? { fromCycle: Number(from), toCycle: Number(to) } : { cycle: Number(from) };
    if (to && Number(to) < Number(from)) {
      errors.push(`"${part}" has its range backwards.`);
      continue;
    }
    lengths.push(operator === "=" ? { ...range, days: Number(value) } : { ...range, extendBy: Number(value) });
  }
  return { lengths, errors };
}

export function plannerInputs(body = {}, today) {
  const year = Number(body.year);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) throw plannerError("Year must be between 2020 and 2100.", 400, { code: "YEAR_REQUIRED" });
  const cycleCount = Number(body.cycleCount);
  if (!Number.isInteger(cycleCount) || cycleCount < 1 || cycleCount > MAX_CYCLES) {
    throw plannerError(`Cycle count must be between 1 and ${MAX_CYCLES}.`, 400, { code: "CYCLE_COUNT_REQUIRED" });
  }
  const startDate = String(body.startDate || `${year}-01-01`).slice(0, 10);
  if (!startDate.startsWith(String(year))) throw plannerError(`Start date must be in ${year}.`, 400, { code: "START_DATE_YEAR" });
  return {
    year,
    startDate,
    endDate: `${year}-12-31`,
    firstCycleNumber: Number(body.firstCycleNumber) || 1,
    cycleCount,
    lengthRules: String(body.lengthRules || "").trim().slice(0, 2000),
    today
  };
}

function iso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

export async function loadPublishedCycles(db, year, { forUpdate = false } = {}) {
  const result = await db.query(
    `select cycle_record_id, cycle_number, cycle_label, start_date::text as start_date, end_date::text as end_date,
            days_in_cycle, quarter, holidays, source_system
       from hb.cycles
      where cycle_number is not null
        and extract(year from start_date)::int = $1::int
      order by cycle_number, start_date${forUpdate ? " for update" : ""}`,
    [year]
  );
  return result.rows.map(row => ({ ...row, start_date: iso(row.start_date), end_date: iso(row.end_date) }));
}

// Past cycles (ended before today) are never moved. The current cycle keeps its start date but can be
// extended or shortened.
export function baselineFromPublished(rows, today) {
  return rows.map(row => ({
    cycle: Number(row.cycle_number),
    startDate: row.start_date,
    endDate: row.end_date,
    days: row.days_in_cycle == null ? undefined : Number(row.days_in_cycle),
    locked: Boolean(row.end_date && row.end_date < today),
    startLocked: Boolean(row.start_date && row.start_date <= today),
    cycleRecordId: row.cycle_record_id,
    cycleLabel: row.cycle_label
  }));
}

function hashOf(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 32);
}

// New rows follow the label style already in hb.cycles ("C12"); the year comes from the start date,
// and the app derives keys such as "C12.27" from it. Existing rows keep their label and ID.
export function cycleLabelFor(cycleNumber) {
  return `C${cycleNumber}`;
}

// The Asana Cycle field uses year-qualified options such as "C1.27".
export function asanaCycleLabel(year, cycleNumber) {
  return `C${cycleNumber}.${String(year).slice(-2)}`;
}

export function newCycleRecordId(year, cycleNumber) {
  return `hawley-cycle:${year}-${String(cycleNumber).padStart(2, "0")}`;
}

export function holidayText(holidays) {
  return holidays.map(holiday => `${holiday.name} (${holiday.date})`).join(", ");
}

async function cycleImpacts(db, cycleRecordIds) {
  if (!cycleRecordIds.length) return new Map();
  const result = await db.query(
    `select ids.cycle_record_id,
            (select count(*)::int from hb.production_schedule ps where ps.cycle_record_id = ids.cycle_record_id) as schedule_rows,
            (select count(distinct v)::int from hb.production_schedule ps, unnest(ps.vin_values) v where ps.cycle_record_id = ids.cycle_record_id) as vins,
            (select count(*)::int from hb.rev1_task_instances ti where ti.cycle_record_id = ids.cycle_record_id) as task_instances
       from unnest($1::text[]) as ids(cycle_record_id)`,
    [cycleRecordIds]
  );
  return new Map(result.rows.map(row => [row.cycle_record_id, row]));
}

// One year's calendar. Production effects are added by previewCombined.
async function previewYear(db, inputs, published, calendar) {
  const baseline = baselineFromPublished(published, inputs.today);
  const { lengths, errors } = parseLengthRules(inputs.lengthRules);
  const plan = planCycles({ ...inputs, lengths, baseline, calendar });
  const conflicts = [...errors.map(message => ({ code: "invalid_rule", message, cycles: [], year: inputs.year })), ...plan.conflicts.map(c => ({ ...c, year: inputs.year }))];

  // Published cycles outside the plan's range are candidates for removal (future cycles only).
  const removalCandidates = [];
  for (const row of baseline.filter(r => r.cycle < inputs.firstCycleNumber || r.cycle >= inputs.firstCycleNumber + inputs.cycleCount)) {
    const label = row.cycleLabel || cycleLabelFor(row.cycle);
    if (row.locked || row.startLocked) {
      conflicts.push({ code: "cycle_removal_started", message: `${label} (${inputs.year}) has started and cannot be removed.`, cycles: [row.cycle], year: inputs.year });
      continue;
    }
    removalCandidates.push({ year: inputs.year, cycle: row.cycle, cycleRecordId: row.cycleRecordId, cycleLabel: label, startDate: row.startDate, endDate: row.endDate, days: row.days ?? null, status: "removed", source: "removed" });
  }

  const baselineByCycle = new Map(baseline.map(row => [row.cycle, row]));
  // Past cycles keep their stored length even if today's calendar would count it differently.
  for (const cycle of plan.cycles) {
    const stored = baselineByCycle.get(cycle.cycle)?.days;
    if (cycle.source === "locked" && stored) cycle.days = stored;
  }
  const changes = diffCyclePlans(baseline, plan.cycles).filter(change => !baselineByCycle.get(change.cycle)?.locked);
  const impacts = await cycleImpacts(db, changes.map(change => baselineByCycle.get(change.cycle)?.cycleRecordId).filter(Boolean));
  const changedSet = new Set(changes.map(change => change.cycle));

  const cycles = plan.cycles.map(cycle => {
    const current = baselineByCycle.get(cycle.cycle);
    const impact = current ? impacts.get(current.cycleRecordId) : null;
    return {
      ...cycle,
      year: inputs.year,
      key: current?.cycleRecordId || `new:${inputs.year}:${cycle.cycle}`,
      kept: Boolean(current && (current.locked || current.startLocked)),
      cycleRecordId: current?.cycleRecordId || null,
      cycleLabel: current?.cycleLabel || cycleLabelFor(cycle.cycle),
      status: current ? (changedSet.has(cycle.cycle) ? "changed" : "unchanged") : "new",
      published: current ? { startDate: current.startDate, endDate: current.endDate, days: current.days ?? null } : null,
      impact: impact ? { scheduleRows: impact.schedule_rows, vins: impact.vins, taskInstances: impact.task_instances } : null
    };
  });

  return {
    inputs,
    baseline,
    published,
    cycles,
    removalCandidates,
    conflicts,
    warnings: plan.warnings.map(w => ({ ...w, year: inputs.year })),
    workingDayCount: plan.workingDayCount ?? null,
    closures: companyClosures(`${inputs.year}-01-01`, `${inputs.year}-12-31`, calendar)
  };
}

async function loadReferenceData(db) {
  const [phases, vins, models] = await Promise.all([
    db.query(`select phase_record_id, phase_name, section_column, process_order, model_type from hb.phases where phase_name is not null`),
    db.query(`select vin, vin_record_id, model_type_record_ids from hb.vins where vin is not null`),
    db.query(`select model_record_id from hb.models where lower(coalesce(model_name, '')) = 'base model'`)
  ]);
  return { phases: phases.rows, vins: vins.rows, baseModelIds: models.rows.map(row => row.model_record_id) };
}

async function loadScheduleRows(db, cycleRecordIds) {
  if (!cycleRecordIds.length) return [];
  const result = await db.query(
    `select ps.production_record_id, ps.cycle_record_id, ps.cycle_number, ps.phase_name, ps.phase_record_id, ps.vin,
            ps.vin_record_ids, ps.model_type,
            (select count(*)::int from hb.rev1_task_instances t where t.line_schedule_record_id = ps.production_record_id) as task_count
       from hb.production_schedule ps
      where ps.cycle_record_id = any($1::text[])`,
    [cycleRecordIds]
  );
  return result.rows;
}

// State after the last cycle that is not regenerated: the latest kept cycle, else the latest earlier cycle.
async function productionStartState(db, keptCycles, firstRegenerated, inputs) {
  let anchorId = keptCycles.at(-1)?.cycleRecordId || null;
  if (!anchorId && firstRegenerated) {
    const prior = await db.query(
      `select c.cycle_record_id from hb.cycles c
        where c.start_date < $1::date
          and exists (select 1 from hb.production_schedule ps where ps.cycle_record_id = c.cycle_record_id and ps.phase_name in ('A1','A2'))
        order by c.start_date desc limit 1`,
      [firstRegenerated.startDate]
    );
    anchorId = prior.rows[0]?.cycle_record_id || null;
  }
  if (anchorId) {
    const rows = await db.query(`select phase_name, vin from hb.production_schedule where cycle_record_id = $1 and phase_name in ('A1','A2')`, [anchorId]);
    const state = stateFromCycleRows(rows.rows);
    if (state) return { state, anchorId };
  }
  if (Number.isInteger(inputs.startVin) && inputs.startVin > 0) {
    // initialState describes the first cycle itself; step back so generateProductionPlan's advance lands on it.
    const first = initialState(inputs.startVin, inputs.startParity);
    const before = first.parity === "odd"
      ? { parity: "even", pair: [first.pair[1] - 2, first.pair[0] - 2], nextVin: first.pair[0] }
      : { parity: "odd", pair: [first.pair[1], first.pair[0]], nextVin: first.nextVin };
    return { state: before, anchorId: null };
  }
  return { state: null, anchorId };
}

function scheduleFields(planned, cycle) {
  return {
    cycle_number: cycle.cycle,
    cycle_label: cycle.cycleLabel,
    short_cycle_label: cycleLabelFor(cycle.cycle),
    schedule_name: `${cycle.cycle}-${planned.phaseName}-${planned.vin || ""}`,
    schedule_key: [asanaCycleLabel(cycle.year, cycle.cycle), planned.vin, planned.phaseRecordId].filter(Boolean).join("::"),
    phase_record_id: planned.phaseRecordId,
    phase_name: planned.phaseName,
    section_column: planned.sectionColumn,
    vin: planned.vin,
    vin_values: planned.vin ? [planned.vin] : [],
    vin_record_ids: planned.vinRecordId ? [planned.vinRecordId] : [],
    model_type: planned.modelType,
    start_date: cycle.startDate,
    end_date: cycle.endDate,
    days_in_cycle: cycle.days
  };
}

// Builds the combined preview from already-loaded published rows. ctx.asanaCycleOptions is a Set of
// normalized Asana Cycle option names, or null when Asana is unavailable.
async function previewCombined(db, inputs, publishedByYear, calendar, ctx = {}) {
  const years = [await previewYear(db, inputs.main, publishedByYear.main, calendar)];
  if (inputs.next) years.push(await previewYear(db, inputs.next, publishedByYear.next, calendar));
  const conflicts = years.flatMap(y => y.conflicts);
  const warnings = years.flatMap(y => y.warnings);

  const allCycles = years.flatMap(y => y.cycles);
  const kept = years[0].cycles.filter(c => c.kept);
  const regenerated = allCycles.filter(c => !c.kept);
  const removalCandidates = years.flatMap(y => y.removalCandidates);
  const cycleByKey = new Map(allCycles.map(c => [c.key, c]));
  const cycleOrder = new Map(allCycles.map((c, index) => [c.key, index]));
  removalCandidates.forEach((c, index) => cycleOrder.set(c.cycleRecordId, -1000 + index));

  const production = { anchor: null, rows: [], moves: [], creates: 0, updates: 0, deletes: [], relinks: [] };
  if (regenerated.length && inputs.includeProduction) {
    const { state, anchorId } = await productionStartState(db, kept, regenerated[0], inputs);
    if (!state) {
      conflicts.push({ code: "production_start_unknown", message: "No earlier cycle has an A1/A2 VIN pair to continue from. Enter a starting VIN and set." });
    } else {
      production.anchor = { cycleRecordId: anchorId, parity: state.parity, pair: state.pair };
      const reference = await loadReferenceData(db);
      const generated = generateProductionPlan({ cycles: regenerated.map(c => ({ key: c.key, year: c.year, cycle: c.cycle })), state, ...reference });
      conflicts.push(...generated.conflicts);
      warnings.push(...generated.warnings);

      const existingIds = [
        ...regenerated.map(c => c.cycleRecordId).filter(Boolean),
        ...removalCandidates.map(c => c.cycleRecordId)
      ];
      const existingRows = await loadScheduleRows(db, existingIds);
      const { matches, leftovers } = matchScheduleRows(generated.rows, existingRows, cycleOrder);

      for (const { planned, existing } of matches) {
        const cycle = cycleByKey.get(planned.cycleKey);
        const fields = scheduleFields(planned, cycle);
        let action = "create";
        if (existing) {
          const moved = existing.cycle_record_id !== cycle.cycleRecordId;
          const changed = existing.phase_record_id !== fields.phase_record_id
            || (existing.vin_record_ids || [])[0] !== fields.vin_record_ids[0]
            || (existing.model_type || null) !== (fields.model_type || null);
          action = moved ? "move" : changed ? "update" : "keep";
        }
        production.rows.push({ cycleKey: planned.cycleKey, year: cycle.year, cycle: cycle.cycle, phaseName: planned.phaseName, vin: planned.vin, action, productionRecordId: existing?.production_record_id || null, fromCycleRecordId: existing?.cycle_record_id || null, taskCount: existing?.task_count || 0, fields });
        if (action === "move") production.moves.push({ productionRecordId: existing.production_record_id, phaseName: planned.phaseName, vin: planned.vin, fromCycleRecordId: existing.cycle_record_id, toCycleKey: planned.cycleKey, taskCount: existing.task_count });
        if (action === "create") production.creates += 1;
        if (action === "update") production.updates += 1;
      }
      for (const row of leftovers) {
        if (row.task_count > 0) {
          conflicts.push({ code: "schedule_row_unplaced", message: `Schedule row ${row.phase_name}${row.vin ? ` VIN ${row.vin}` : ""} has ${row.task_count} tasks but no place in the new plan. Plan more cycles so it lands somewhere.` });
        } else {
          production.deletes.push({ productionRecordId: row.production_record_id, phaseName: row.phase_name, vin: row.vin, cycleRecordId: row.cycle_record_id });
        }
      }

      // Tasks follow their schedule row; Asana is told once via the Cycle field push.
      const movedIds = production.moves.map(move => move.productionRecordId);
      if (movedIds.length) {
        const tasks = await db.query(
          `select rev1_task_instance_id, asana_task_gid, line_schedule_record_id, cycle_record_id, cycle_label, phase_record_id, vin, task_name
             from hb.rev1_task_instances where line_schedule_record_id = any($1::text[])`,
          [movedIds]
        );
        const moveById = new Map(production.moves.map(move => [move.productionRecordId, move]));
        for (const task of tasks.rows) {
          const target = cycleByKey.get(moveById.get(task.line_schedule_record_id).toCycleKey);
          if (task.cycle_record_id === target.cycleRecordId && target.cycleRecordId) continue;
          production.relinks.push({
            rev1TaskInstanceId: task.rev1_task_instance_id,
            asanaTaskGid: task.asana_task_gid,
            phaseRecordId: task.phase_record_id,
            vin: task.vin,
            taskName: task.task_name,
            fromCycleRecordId: task.cycle_record_id,
            fromLabel: task.cycle_label,
            toCycleKey: target.key,
            toAsanaLabel: asanaCycleLabel(target.year, target.cycle)
          });
        }
      }
    }
  }

  // Removal is allowed once the plan moves everything off the cycle (derived load tables are rebuilt).
  const relinkedIds = new Set(production.relinks.map(r => r.rev1TaskInstanceId));
  const movedRowIds = new Set([...production.moves.map(m => m.productionRecordId), ...production.deletes.map(d => d.productionRecordId)]);
  const removedCycles = [];
  for (const candidate of removalCandidates) {
    const links = await db.query(
      `select
         (select count(*)::int from hb.production_schedule where cycle_record_id = $1 and not (production_record_id = any($2::text[]))) as schedule_rows,
         (select count(*)::int from hb.rev1_task_instances where cycle_record_id = $1 and not (rev1_task_instance_id::text = any($3::text[]))) as tasks,
         (select count(*)::int from hb.project_creation_runs where cycle_record_id = $1) as project_runs`,
      [candidate.cycleRecordId, [...movedRowIds], [...relinkedIds].map(String)]
    );
    const { schedule_rows: rows, tasks, project_runs: runs } = links.rows[0] || {};
    const blocking = [rows ? `${rows} schedule rows` : "", tasks ? `${tasks} tasks` : "", runs ? `${runs} project runs` : ""].filter(Boolean).join(", ");
    if (blocking) {
      conflicts.push({ code: "cycle_removal_linked", message: `${candidate.cycleLabel} (${candidate.year}) cannot be removed yet: ${blocking} still point to it and the plan does not move them.`, cycles: [candidate.cycle], year: candidate.year });
    } else {
      removedCycles.push(candidate);
    }
  }

  if (production.relinks.length) {
    const needed = [...new Set(production.relinks.map(r => r.toAsanaLabel))];
    if (!ctx.asanaCycleOptions) {
      conflicts.push({ code: "asana_unavailable", message: `${production.relinks.length} Asana tasks change cycle, but Hawley cannot read the Asana Cycle field right now.` });
    } else {
      const missing = needed.filter(label => !ctx.asanaCycleOptions.has(label.toLowerCase()));
      if (missing.length) conflicts.push({ code: "asana_cycle_option_missing", message: `Add these options to the Asana "Cycle" field before publishing: ${missing.join(", ")}.` });
    }
  }

  // Per-cycle VIN summary for the preview table.
  const rowsByCycle = new Map();
  for (const row of production.rows) rowsByCycle.set(row.cycleKey, [...(rowsByCycle.get(row.cycleKey) || []), row]);
  for (const cycle of allCycles) {
    const rows = rowsByCycle.get(cycle.key);
    cycle.production = rows
      ? { status: "planned", rows: rows.map(r => ({ phase: r.phaseName, vin: r.vin, action: r.action, taskCount: r.taskCount })) }
      : { status: cycle.kept ? "kept" : "none", rows: [] };
  }

  const changedCycles = years.flatMap(y => y.cycles.filter(c => c.status !== "unchanged"));
  const productionChanges = production.rows.filter(r => r.action !== "keep").length + production.deletes.length;
  const hash = hashOf({
    years: years.map(y => ({
      inputs: { ...y.inputs, today: undefined },
      baseline: y.baseline.map(({ cycle, startDate, endDate, locked }) => ({ cycle, startDate, endDate, locked })),
      cycles: y.cycles.map(({ cycle, startDate, endDate, days }) => ({ cycle, startDate, endDate, days }))
    })),
    removed: removedCycles.map(c => c.cycleRecordId),
    production: production.rows.map(r => [r.cycleKey, r.phaseName, r.vin, r.productionRecordId, r.action]),
    deletes: production.deletes.map(d => d.productionRecordId),
    relinks: production.relinks.map(r => [r.rev1TaskInstanceId, r.toCycleKey])
  });

  return {
    ok: conflicts.length === 0,
    today: inputs.main.today,
    years: years.map(y => ({
      year: y.inputs.year,
      inputs: { ...y.inputs, today: undefined },
      workingDayCount: y.workingDayCount,
      closures: y.closures,
      cycles: y.cycles,
      removedCycles: removedCycles.filter(c => c.year === y.inputs.year)
    })),
    // Single-year fields kept for the main year so existing callers keep working.
    cycles: years[0].cycles,
    removedCycles,
    closures: years[0].closures,
    workingDayCount: years[0].workingDayCount,
    conflicts,
    warnings,
    production: {
      anchor: production.anchor,
      moves: production.moves.length,
      movedTasks: production.relinks.length,
      creates: production.creates,
      updates: production.updates,
      deletes: production.deletes.length,
      relinks: production.relinks.slice(0, 50).map(r => ({ vin: r.vin, taskName: r.taskName, from: r.fromLabel, to: r.toAsanaLabel })),
      relinkCount: production.relinks.length
    },
    changedCycleNumbers: [...changedCycles.map(c => c.cycle), ...removedCycles.map(c => c.cycle)],
    changeCount: changedCycles.length + removedCycles.length + productionChanges,
    planHash: hash,
    _internal: { years, production, removedCycles }
  };
}

export function combinedInputs(body = {}, today, publishedNext = []) {
  const main = plannerInputs(body, today);
  let next = null;
  if (body.includeNextYear !== false) {
    const nb = body.nextYear || {};
    const year = main.year + 1;
    next = plannerInputs({
      year,
      cycleCount: Number(nb.cycleCount) || publishedNext.length || 25,
      startDate: nb.startDate || publishedNext[0]?.start_date || `${year}-01-01`,
      firstCycleNumber: Number(nb.firstCycleNumber) || 1,
      lengthRules: nb.lengthRules || ""
    }, today);
  }
  return {
    main,
    next,
    // Calendar-only previews skip the VIN schedule; the admin tab always includes it.
    includeProduction: body.includeProduction !== false,
    startVin: body.startVin ? Number(body.startVin) : null,
    startParity: body.startParity === "even" ? "even" : "odd"
  };
}

function publicPreview(preview) {
  const { _internal, ...rest } = preview;
  return rest;
}

export async function buildCyclePreview(db, body, today, calendar = DEFAULT_COMPANY_CALENDAR, ctx = {}) {
  const year = Number(body.year);
  const publishedMain = await loadPublishedCycles(db, year);
  const publishedNext = body.includeNextYear === false ? [] : await loadPublishedCycles(db, year + 1);
  const inputs = combinedInputs(body, today, publishedNext);
  return publicPreview(await previewCombined(db, inputs, { main: publishedMain, next: publishedNext }, calendar, ctx));
}

export async function cyclePlannerOverview(db, year, today, calendar = DEFAULT_COMPANY_CALENDAR) {
  const published = await loadPublishedCycles(db, year);
  const publishedNext = await loadPublishedCycles(db, year + 1);
  const versions = await db.query(
    `select cycle_plan_version_id, plan_year, changed_cycle_numbers, note, published_by, published_at::text as published_at
       from hb.cycle_plan_versions where plan_year in ($1::int, $1::int + 1) order by published_at desc limit 20`,
    [year]
  );
  // hb.cycles is the source of cycle dates; any schedule row disagreeing with its cycle is surfaced.
  const mismatches = await db.query(
    `select count(*)::int as count
       from hb.production_schedule ps
       join hb.cycles c using (cycle_record_id)
      where extract(year from c.start_date)::int = $1::int
        and (ps.start_date is distinct from c.start_date or ps.end_date is distinct from c.end_date
             or ps.days_in_cycle is distinct from c.days_in_cycle)`,
    [year]
  );
  const toRows = (rows, y) => baselineFromPublished(rows, today).map(row => ({ ...row, year: y, quarter: rows.find(p => p.cycle_record_id === row.cycleRecordId)?.quarter || null }));
  return {
    year,
    today,
    scheduleDateMismatches: mismatches.rows[0]?.count ?? 0,
    closures: companyClosures(`${year}-01-01`, `${year}-12-31`, calendar),
    published: toRows(published, year),
    nextYear: { year: year + 1, published: toRows(publishedNext, year + 1), closures: companyClosures(`${year + 1}-01-01`, `${year + 1}-12-31`, calendar) },
    versions: versions.rows
  };
}

async function writeYearCycles(client, yearPreview, versionId) {
  const ids = new Map();
  for (const cycle of yearPreview.cycles) {
    ids.set(cycle.key, cycle.cycleRecordId || newCycleRecordId(cycle.year, cycle.cycle));
    if (cycle.status === "unchanged") continue;
    if (cycle.source === "locked") throw plannerError(`Cycle ${cycle.cycle} has ended and cannot be changed.`, 409, { code: "CYCLE_LOCKED" });
    const holidays = holidayText(cycle.holidays);
    if (cycle.cycleRecordId) {
      await client.query(
        `update hb.cycles
            set start_date = $2::date, end_date = $3::date, days_in_cycle = $4::int, quarter = $5, holidays = $6,
                source_system = 'hawley_cycle_planner', normalized_at = now()
          where cycle_record_id = $1`,
        [cycle.cycleRecordId, cycle.startDate, cycle.endDate, cycle.days, cycle.quarter, holidays]
      );
      // Migration 036's trigger copies cycle dates to hb.production_schedule. This explicit update is a
      // no-op when the trigger ran, and keeps the copies consistent if that migration has not applied.
      await client.query(
        `update hb.production_schedule
            set start_date = $2::date, end_date = $3::date, days_in_cycle = $4::int, normalized_at = now()
          where cycle_record_id = $1
            and (start_date is distinct from $2::date or end_date is distinct from $3::date or days_in_cycle is distinct from $4::int)`,
        [cycle.cycleRecordId, cycle.startDate, cycle.endDate, cycle.days]
      );
    } else {
      await client.query(
        `insert into hb.cycles (cycle_record_id, cycle_number, cycle_label, start_date, end_date, quarter, days_in_cycle,
                                holidays, fields_json, source_system, normalized_at)
         values ($1, $2::int, $3, $4::date, $5::date, $6, $7::int, $8, $9::jsonb, 'hawley_cycle_planner', now())`,
        [ids.get(cycle.key), cycle.cycle, cycle.cycleLabel, cycle.startDate, cycle.endDate, cycle.quarter, cycle.days, holidays, JSON.stringify({ createdByCyclePlanVersion: versionId })]
      );
    }
  }
  return ids;
}

async function writeProduction(client, production, cycleIds, years) {
  const cycleByKey = new Map(years.flatMap(y => y.cycles).map(c => [c.key, c]));
  for (const row of production.rows) {
    if (row.action === "keep") continue;
    const f = row.fields;
    const values = [cycleIds.get(row.cycleKey), f.cycle_number, f.cycle_label, f.short_cycle_label, f.schedule_name, f.schedule_key, f.phase_record_id, f.phase_name, f.section_column, f.vin, f.vin_values, f.vin_record_ids, f.model_type, f.start_date, f.end_date, f.days_in_cycle];
    if (row.productionRecordId) {
      await client.query(
        `update hb.production_schedule
            set cycle_record_id = $2, cycle_number = $3::int, cycle_label = $4, short_cycle_label = $5, schedule_name = $6,
                schedule_key = $7, phase_record_id = $8, phase_name = $9, section_column = $10, vin = $11, vin_values = $12::text[],
                vin_record_ids = $13::text[], model_type = $14, start_date = $15::date, end_date = $16::date, days_in_cycle = $17::int,
                source_system = 'hawley_production_generator', normalized_at = now()
          where production_record_id = $1`,
        [row.productionRecordId, ...values]
      );
    } else {
      await client.query(
        `insert into hb.production_schedule (production_record_id, cycle_record_id, cycle_number, cycle_label, short_cycle_label,
                schedule_name, schedule_key, phase_record_id, phase_name, section_column, vin, vin_values, vin_record_ids,
                model_type, start_date, end_date, days_in_cycle, source_system, normalized_at)
         values ($1, $2, $3::int, $4, $5, $6, $7, $8, $9, $10, $11, $12::text[], $13::text[], $14, $15::date, $16::date, $17::int,
                 'hawley_production_generator', now())`,
        [`hawley-prod:${randomUUID()}`, ...values]
      );
    }
  }
  for (const row of production.deletes) {
    await client.query("delete from hb.production_schedule where production_record_id = $1", [row.productionRecordId]);
  }
  for (const relink of production.relinks) {
    const cycle = cycleByKey.get(relink.toCycleKey);
    const cycleId = cycleIds.get(relink.toCycleKey);
    const key = relink.phaseRecordId ? `${relink.phaseRecordId}::${cycleId}` : null;
    // Load/allocation links are recomputed by the HB rebuild that follows publishing.
    await client.query(
      `update hb.rev1_task_instances
          set cycle_record_id = $2, cycle_label = $3, days_in_cycle = $4::int, phase_cycle_bucket_key = $5, phase_cycle_key = $5,
              phase_cycle_load_record_id = null, worker_phase_allocation_record_id = null, normalized_at = now()
        where rev1_task_instance_id = $1`,
      [relink.rev1TaskInstanceId, cycleId, cycle.cycleLabel, cycle.days, key]
    );
  }
}

// Recomputes the plan inside one transaction and refuses to publish if anything differs from the
// preview the admin approved (planHash), so concurrent edits cannot be overwritten silently.
// Returns the Asana pushes the caller must perform (moved tasks' Cycle field).
export async function publishCyclePlan(pool, body, { today, actorEmail = "", calendar = DEFAULT_COMPANY_CALENDAR, asanaCycleOptions = null } = {}) {
  const expectedHash = String(body.planHash || "");
  if (!expectedHash) throw plannerError("Preview the plan before publishing.", 400, { code: "PLAN_HASH_REQUIRED" });
  const year = Number(body.year);
  plannerInputs(body, today);

  const client = await pool.connect();
  try {
    await client.query("begin");
    // Same gate as HB rebuilds, which also update hb.cycles: wait for them instead of deadlocking.
    await client.query("select pg_advisory_xact_lock($1::integer, $2::integer)", [HB_BUILD_LOCK_NAMESPACE, HB_BUILD_LOCK_KEY]);
    const publishedMain = await loadPublishedCycles(client, year, { forUpdate: true });
    const publishedNext = body.includeNextYear === false ? [] : await loadPublishedCycles(client, year + 1, { forUpdate: true });
    const inputs = combinedInputs(body, today, publishedNext);
    const preview = await previewCombined(client, inputs, { main: publishedMain, next: publishedNext }, calendar, { asanaCycleOptions });
    if (!preview.ok) throw plannerError("The plan has conflicts and cannot be published.", 409, { code: "PLAN_CONFLICTS", conflicts: preview.conflicts });
    if (preview.planHash !== expectedHash) {
      throw plannerError("The plan inputs or published data changed since this preview. Preview again before publishing.", 409, { code: "PLAN_STALE" });
    }
    if (!preview.changeCount) throw plannerError("Nothing to publish: the plan matches what is published.", 409, { code: "PLAN_UNCHANGED" });
    const { years, production, removedCycles } = preview._internal;
    if (production.relinks.length && body.pushToAsana !== true) {
      throw plannerError(`${production.relinks.length} Asana tasks change cycle. Confirm the Asana push to publish.`, 409, { code: "ASANA_PUSH_REQUIRED" });
    }

    const groupId = `cycle-plan-group:${randomUUID()}`;
    const cycleIds = new Map();
    const versionIds = years.map(y => `cycle-plan:${randomUUID()}:${y.inputs.year}`);
    for (const [index, y] of years.entries()) {
      for (const [key, id] of await writeYearCycles(client, y, versionIds[index])) cycleIds.set(key, id);
    }
    await writeProduction(client, production, cycleIds, years);
    for (const cycle of removedCycles) {
      await client.query("delete from hb.cycles where cycle_record_id = $1", [cycle.cycleRecordId]);
    }

    const pushes = production.relinks.map(r => ({ rev1TaskInstanceId: r.rev1TaskInstanceId, asanaTaskGid: r.asanaTaskGid, label: r.toAsanaLabel, status: r.asanaTaskGid ? "pending" : "no_asana_task" }));
    for (const [index, y] of years.entries()) {
      const yearCycles = y.cycles.filter(c => c.status !== "unchanged");
      const yearRemoved = removedCycles.filter(c => c.year === y.inputs.year);
      const yearRows = production.rows.filter(r => r.year === y.inputs.year && r.action !== "keep");
      await client.query(
        `insert into hb.cycle_plan_versions (cycle_plan_version_id, plan_year, plan_hash, inputs_json, cycles_json,
                                            previous_cycles_json, changed_cycle_numbers, note, published_by, plan_group_id,
                                            production_json, asana_push_json)
         values ($1, $2::int, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::int[], $8, $9, $10, $11::jsonb, $12::jsonb)`,
        [
          versionIds[index],
          y.inputs.year,
          preview.planHash,
          JSON.stringify({ ...y.inputs, today: undefined }),
          JSON.stringify(y.cycles.map(({ production: _p, ...cycle }) => ({ ...cycle, cycleRecordId: cycleIds.get(cycle.key) }))),
          JSON.stringify(y.published),
          [...yearCycles.map(c => c.cycle), ...yearRemoved.map(c => c.cycle)],
          String(body.note || "").trim().slice(0, 1000),
          actorEmail,
          groupId,
          JSON.stringify({
            anchor: index === 0 ? production.anchor : undefined,
            rows: yearRows.map(r => ({ cycle: r.cycle, phase: r.phaseName, vin: r.vin, action: r.action, productionRecordId: r.productionRecordId, fromCycleRecordId: r.fromCycleRecordId })),
            deletes: index === 0 ? production.deletes : []
          }),
          JSON.stringify(index === 0 ? pushes : [])
        ]
      );
    }
    await client.query("commit");
    return {
      ok: true,
      planGroupId: groupId,
      cyclePlanVersionId: versionIds[0],
      cyclePlanVersionIds: versionIds,
      changedCycleNumbers: preview.changedCycleNumbers,
      removedCycleNumbers: removedCycles.map(c => c.cycle),
      production: { moves: production.moves.length, creates: production.creates, updates: production.updates, deletes: production.deletes.length },
      asanaPushes: pushes
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function recordAsanaPushResults(pool, versionId, pushes) {
  await pool.query(`update hb.cycle_plan_versions set asana_push_json = $2::jsonb where cycle_plan_version_id = $1`, [versionId, JSON.stringify(pushes)]);
}

export async function pendingAsanaPushes(pool, versionId) {
  const result = await pool.query(`select asana_push_json from hb.cycle_plan_versions where cycle_plan_version_id = $1`, [versionId]);
  if (!result.rows[0]) throw plannerError("Cycle plan version not found.", 404, { code: "VERSION_NOT_FOUND" });
  return result.rows[0].asana_push_json || [];
}
