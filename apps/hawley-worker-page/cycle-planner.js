// Admin cycle planner: previews and publishes a year's cycle calendar into hb.cycles.
// Calendar arithmetic lives in the pure postgres-sync/cycle-calendar module; this file only adds
// database reads, lock rules and the publish transaction.
import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_COMPANY_CALENDAR, companyClosures, diffCyclePlans, planCycles } from "../postgres-sync/src/cycle-calendar.js";
import { HB_BUILD_LOCK_KEY, HB_BUILD_LOCK_NAMESPACE } from "../postgres-sync/src/hb-build-transaction.js";

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
  if (!startDate.startsWith(String(year))) throw plannerError("Start date must be in the selected year.", 400, { code: "START_DATE_YEAR" });
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

// Cycles that have started are never moved by the planner.
export function baselineFromPublished(rows, today) {
  return rows.map(row => ({
    cycle: Number(row.cycle_number),
    startDate: row.start_date,
    endDate: row.end_date,
    days: row.days_in_cycle == null ? undefined : Number(row.days_in_cycle),
    locked: Boolean(row.start_date && row.start_date <= today),
    cycleRecordId: row.cycle_record_id,
    cycleLabel: row.cycle_label
  }));
}

export function planHash(inputs, baseline, cycles) {
  const payload = {
    inputs: { ...inputs, today: undefined },
    baseline: baseline.map(({ cycle, startDate, endDate, locked }) => ({ cycle, startDate, endDate, locked })),
    cycles: cycles.map(({ cycle, startDate, endDate, days }) => ({ cycle, startDate, endDate, days }))
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 32);
}

// New rows follow the label style already in hb.cycles ("C12"); the year comes from the start date,
// and the app derives keys such as "C12.27" from it. Existing rows keep their label and ID.
export function cycleLabelFor(cycleNumber) {
  return `C${cycleNumber}`;
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

export async function buildCyclePreview(db, body, today, calendar = DEFAULT_COMPANY_CALENDAR) {
  const inputs = plannerInputs(body, today);
  const published = await loadPublishedCycles(db, inputs.year);
  return previewFromPublished(db, inputs, published, calendar);
}

async function previewFromPublished(db, inputs, published, calendar) {
  const baseline = baselineFromPublished(published, inputs.today);
  const { lengths, errors } = parseLengthRules(inputs.lengthRules);
  const plan = planCycles({ ...inputs, lengths, baseline, calendar });
  const conflicts = [...errors.map(message => ({ code: "invalid_rule", message, cycles: [] })), ...plan.conflicts];

  const planned = new Set(plan.cycles.map(cycle => cycle.cycle));
  for (const row of baseline) {
    if (!planned.has(row.cycle) && (row.cycle < inputs.firstCycleNumber || row.cycle >= inputs.firstCycleNumber + inputs.cycleCount)) {
      conflicts.push({ code: "published_cycle_outside_plan", message: `Published cycle ${row.cycle} is not in this plan. Cycles are never deleted; widen the cycle range.`, cycles: [row.cycle] });
    }
  }

  const baselineByCycle = new Map(baseline.map(row => [row.cycle, row]));
  // Started cycles keep their stored length even if today's calendar would count it differently.
  for (const cycle of plan.cycles) {
    const stored = baselineByCycle.get(cycle.cycle)?.days;
    if (cycle.source === "locked" && stored) cycle.days = stored;
  }
  const changes = diffCyclePlans(baseline, plan.cycles).filter(change => !baselineByCycle.get(change.cycle)?.locked);
  const changedIds = changes.map(change => baselineByCycle.get(change.cycle)?.cycleRecordId).filter(Boolean);
  const impacts = await cycleImpacts(db, changedIds);
  const changedSet = new Set(changes.map(change => change.cycle));

  const cycles = plan.cycles.map(cycle => {
    const current = baselineByCycle.get(cycle.cycle);
    const impact = current ? impacts.get(current.cycleRecordId) : null;
    return {
      ...cycle,
      cycleRecordId: current?.cycleRecordId || null,
      cycleLabel: current?.cycleLabel || cycleLabelFor(cycle.cycle),
      status: current ? (changedSet.has(cycle.cycle) ? "changed" : "unchanged") : "new",
      published: current ? { startDate: current.startDate, endDate: current.endDate, days: current.days ?? null } : null,
      impact: impact ? { scheduleRows: impact.schedule_rows, vins: impact.vins, taskInstances: impact.task_instances } : null
    };
  });

  return {
    ok: conflicts.length === 0,
    inputs: { ...inputs, today: undefined },
    today: inputs.today,
    workingDayCount: plan.workingDayCount ?? null,
    closures: companyClosures(`${inputs.year}-01-01`, `${inputs.year}-12-31`, calendar),
    cycles,
    conflicts,
    warnings: plan.warnings,
    changedCycleNumbers: cycles.filter(cycle => cycle.status !== "unchanged").map(cycle => cycle.cycle),
    planHash: planHash(inputs, baseline, plan.cycles)
  };
}

export async function cyclePlannerOverview(db, year, today, calendar = DEFAULT_COMPANY_CALENDAR) {
  const published = await loadPublishedCycles(db, year);
  const versions = await db.query(
    `select cycle_plan_version_id, plan_year, changed_cycle_numbers, note, published_by, published_at::text as published_at
       from hb.cycle_plan_versions where plan_year = $1::int order by published_at desc limit 20`,
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
  return {
    year,
    today,
    scheduleDateMismatches: mismatches.rows[0]?.count ?? 0,
    closures: companyClosures(`${year}-01-01`, `${year}-12-31`, calendar),
    published: baselineFromPublished(published, today).map(row => ({ ...row, quarter: published.find(p => p.cycle_record_id === row.cycleRecordId)?.quarter || null })),
    versions: versions.rows
  };
}

// Recomputes the plan inside one transaction and refuses to publish if anything differs from the
// preview the admin approved (planHash), so concurrent edits cannot be overwritten silently.
export async function publishCyclePlan(pool, body, { today, actorEmail = "", calendar = DEFAULT_COMPANY_CALENDAR } = {}) {
  const inputs = plannerInputs(body, today);
  const expectedHash = String(body.planHash || "");
  if (!expectedHash) throw plannerError("Preview the plan before publishing.", 400, { code: "PLAN_HASH_REQUIRED" });

  const client = await pool.connect();
  try {
    await client.query("begin");
    // Same gate as HB rebuilds, which also update hb.cycles: wait for them instead of deadlocking.
    await client.query("select pg_advisory_xact_lock($1::integer, $2::integer)", [HB_BUILD_LOCK_NAMESPACE, HB_BUILD_LOCK_KEY]);
    const published = await loadPublishedCycles(client, inputs.year, { forUpdate: true });
    const preview = await previewFromPublished(client, inputs, published, calendar);
    if (!preview.ok) throw plannerError("The plan has conflicts and cannot be published.", 409, { code: "PLAN_CONFLICTS", conflicts: preview.conflicts });
    if (preview.planHash !== expectedHash) {
      throw plannerError("The plan inputs or published cycles changed since this preview. Preview again before publishing.", 409, { code: "PLAN_STALE" });
    }
    const changed = preview.cycles.filter(cycle => cycle.status !== "unchanged");
    if (!changed.length) throw plannerError("Nothing to publish: the plan matches the published cycles.", 409, { code: "PLAN_UNCHANGED" });

    const versionId = `cycle-plan:${randomUUID()}`;
    for (const cycle of changed) {
      if (cycle.source === "locked") throw plannerError(`Cycle ${cycle.cycle} has started and cannot be changed.`, 409, { code: "CYCLE_LOCKED" });
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
          [
            `hawley-cycle:${inputs.year}-${String(cycle.cycle).padStart(2, "0")}`,
            cycle.cycle,
            cycle.cycleLabel,
            cycle.startDate,
            cycle.endDate,
            cycle.quarter,
            cycle.days,
            holidays,
            JSON.stringify({ createdByCyclePlanVersion: versionId })
          ]
        );
      }
    }

    await client.query(
      `insert into hb.cycle_plan_versions (cycle_plan_version_id, plan_year, plan_hash, inputs_json, cycles_json,
                                          previous_cycles_json, changed_cycle_numbers, note, published_by)
       values ($1, $2::int, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::int[], $8, $9)`,
      [
        versionId,
        inputs.year,
        preview.planHash,
        JSON.stringify(preview.inputs),
        JSON.stringify(preview.cycles),
        JSON.stringify(published),
        changed.map(cycle => cycle.cycle),
        String(body.note || "").trim().slice(0, 1000),
        actorEmail
      ]
    );
    await client.query("commit");
    return { ok: true, cyclePlanVersionId: versionId, year: inputs.year, changedCycleNumbers: changed.map(cycle => cycle.cycle) };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
