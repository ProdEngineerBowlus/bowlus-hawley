import test from "node:test";
import assert from "node:assert/strict";

import { planCycles } from "../../postgres-sync/src/cycle-calendar.js";
import { buildCyclePreview, parseLengthRules, publishCyclePlan } from "../cycle-planner.js";

const TODAY = "2026-10-29";

function publishedYear(year, count = 25) {
  return planCycles({ startDate: `${year}-01-01`, cycleCount: count }).cycles.map(cycle => ({
    cycle_record_id: `rec-${year}-${cycle.cycle}`,
    cycle_number: cycle.cycle,
    cycle_label: `C${cycle.cycle}.${String(year).slice(-2)}`,
    start_date: cycle.startDate,
    end_date: cycle.endDate,
    days_in_cycle: cycle.days,
    quarter: cycle.quarter,
    holidays: "",
    source_system: "airtable_bootstrap"
  }));
}

function fakeDatabase(cycles = []) {
  const state = { cycles: structuredClone(cycles), calls: [], versions: [], scheduleUpdates: [] };
  const client = {
    async query(sql, params = []) {
      state.calls.push({ sql: sql.trim().split(/\s+/).slice(0, 3).join(" "), params });
      if (/^(begin|commit|rollback)$/i.test(sql.trim())) return { rows: [] };
      if (/from hb\.cycles/.test(sql) && /^\s*select/i.test(sql)) {
        return { rows: state.cycles.filter(row => Number(row.start_date.slice(0, 4)) === params[0]).sort((a, b) => a.start_date.localeCompare(b.start_date)) };
      }
      if (/from unnest\(\$1::text\[\]\)/.test(sql)) {
        return { rows: params[0].map(id => ({ cycle_record_id: id, schedule_rows: 9, vins: 9, task_instances: 120 })) };
      }
      if (/from hb\.cycle_plan_versions/.test(sql)) return { rows: state.versions };
      if (/^\s*update hb\.cycles/.test(sql)) {
        const row = state.cycles.find(cycle => cycle.cycle_record_id === params[0]);
        Object.assign(row, { start_date: params[1], end_date: params[2], days_in_cycle: params[3], quarter: params[4], holidays: params[5], source_system: "hawley_cycle_planner" });
        return { rows: [] };
      }
      if (/^\s*update hb\.production_schedule/.test(sql)) {
        state.scheduleUpdates.push(params);
        return { rows: [] };
      }
      if (/^\s*insert into hb\.cycles/.test(sql)) {
        const [cycle_record_id, cycle_number, cycle_label, start_date, end_date, quarter, days_in_cycle, holidays] = params;
        state.cycles.push({ cycle_record_id, cycle_number, cycle_label, start_date, end_date, quarter, days_in_cycle, holidays, source_system: "hawley_cycle_planner" });
        return { rows: [] };
      }
      if (/^\s*insert into hb\.cycle_plan_versions/.test(sql)) {
        state.versions.push(params);
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {}
  };
  return { state, client, pool: { connect: async () => client } };
}

const writes = state => state.calls.filter(call => /^(update|insert)/i.test(call.sql));

test("length rules accept fixed ranges, single cycles and extensions and report bad rules", () => {
  assert.deepEqual(parseLengthRules("22-25=8, c20+4; 3=12"), {
    lengths: [{ fromCycle: 22, toCycle: 25, days: 8 }, { cycle: 20, extendBy: 4 }, { cycle: 3, days: 12 }],
    errors: []
  });
  assert.equal(parseLengthRules("25-22=8, eight").errors.length, 2);
});

test("preview locks started cycles, shows changes with their schedule impact, and writes nothing", async () => {
  const db = fakeDatabase(publishedYear(2026));
  const preview = await buildCyclePreview(db.client, { year: 2026, cycleCount: 25, lengthRules: "23+2" }, TODAY);
  assert.equal(preview.ok, true, JSON.stringify(preview.conflicts));
  const started = preview.cycles.filter(cycle => cycle.startDate <= TODAY);
  assert.ok(started.length >= 21 && started.every(cycle => cycle.source === "locked" && cycle.status === "unchanged"));
  assert.ok(preview.changedCycleNumbers.includes(23));
  assert.equal(preview.cycles.find(cycle => cycle.cycle === 23).impact.taskInstances, 120);
  assert.equal(preview.cycles.at(-1).endDate, "2026-12-31");
  assert.equal(writes(db.state).length, 0);
});

test("a started cycle whose stored length differs from the calendar is shown unchanged", async () => {
  const cycles = publishedYear(2026);
  cycles[4].days_in_cycle += 1;
  const db = fakeDatabase(cycles);
  const preview = await buildCyclePreview(db.client, { year: 2026, cycleCount: 25 }, TODAY);
  assert.equal(preview.cycles[4].status, "unchanged");
  assert.equal(preview.cycles[4].days, cycles[4].days_in_cycle);
  assert.deepEqual(preview.changedCycleNumbers, []);
});

test("overlapping started cycles (as in live 2026 data) are kept and later cycles still plan", async () => {
  const cycles = publishedYear(2026);
  // Live data: C20 starts before C19 and runs Oct 1 - Nov 2 (23 working days).
  Object.assign(cycles[19], { start_date: "2026-10-01", end_date: "2026-11-02", days_in_cycle: 23 });
  Object.assign(cycles[20], { start_date: "2026-11-03", end_date: "2026-11-12", days_in_cycle: 8 });
  const db = fakeDatabase(cycles);
  const preview = await buildCyclePreview(db.client, { year: 2026, cycleCount: 25 }, TODAY);
  assert.equal(preview.ok, true, JSON.stringify(preview.conflicts));
  assert.ok(preview.warnings.some(warning => warning.code === "locked_overlap"));
  assert.deepEqual([preview.cycles[19].startDate, preview.cycles[19].endDate, preview.cycles[19].status], ["2026-10-01", "2026-11-02", "unchanged"]);
  assert.deepEqual(preview.cycles.slice(20).map(c => [c.startDate, c.days]), [["2026-11-03", 9], ["2026-11-16", 8], ["2026-11-27", 8], ["2026-12-09", 8], ["2026-12-21", 8]]);
  assert.equal(preview.cycles.at(-1).endDate, "2026-12-31");
});

test("working days before a locked first cycle are a warning, not a conflict", async () => {
  const cycles = publishedYear(2026);
  Object.assign(cycles[0], { start_date: "2026-01-12" });
  const db = fakeDatabase(cycles);
  const preview = await buildCyclePreview(db.client, { year: 2026, startDate: "2026-01-01", cycleCount: 25 }, TODAY);
  assert.equal(preview.ok, true, JSON.stringify(preview.conflicts));
  assert.ok(preview.warnings.some(warning => warning.code === "unassigned_days" && /before cycle 1/.test(warning.message)));
});

test("publishing a started cycle is refused as a conflict", async () => {
  const db = fakeDatabase(publishedYear(2026));
  const preview = await buildCyclePreview(db.client, { year: 2026, cycleCount: 25, lengthRules: "2=15" }, TODAY);
  assert.equal(preview.ok, false);
  assert.equal(preview.conflicts[0].code, "locked_cycle_constraint");
  await assert.rejects(publishCyclePlan(db.pool, { year: 2026, cycleCount: 25, lengthRules: "2=15", planHash: preview.planHash }, { today: TODAY }), { code: "PLAN_CONFLICTS" });
  assert.equal(writes(db.state).length, 0);
});

test("publish updates only unlocked changed cycles in place, their schedule rows, and records a version", async () => {
  const db = fakeDatabase(publishedYear(2026));
  const before = structuredClone(db.state.cycles);
  const body = { year: 2026, cycleCount: 25, lengthRules: "23+2", note: "Changeover" };
  const preview = await buildCyclePreview(db.client, body, TODAY);
  const result = await publishCyclePlan(db.pool, { ...body, planHash: preview.planHash }, { today: TODAY, actorEmail: "admin@example.test" });

  assert.deepEqual(result.changedCycleNumbers, preview.changedCycleNumbers);
  for (const row of before.filter(cycle => cycle.start_date <= TODAY)) {
    assert.deepEqual(db.state.cycles.find(cycle => cycle.cycle_record_id === row.cycle_record_id), row);
  }
  const c23 = db.state.cycles.find(cycle => cycle.cycle_number === 23);
  assert.equal(c23.cycle_record_id, "rec-2026-23");
  assert.equal(c23.days_in_cycle, before.find(cycle => cycle.cycle_number === 23).days_in_cycle + 2);
  assert.equal(db.state.scheduleUpdates.length, preview.changedCycleNumbers.length);
  assert.equal(db.state.versions.length, 1);
  assert.equal(db.state.versions[0][1], 2026);
  assert.equal(db.state.versions[0][8], "admin@example.test");
  assert.equal(db.state.cycles.length, 25);
  assert.equal(db.state.calls.at(-1).sql, "commit");
});

test("a stale preview is rejected and rolled back without writes", async () => {
  const db = fakeDatabase(publishedYear(2026));
  const preview = await buildCyclePreview(db.client, { year: 2026, cycleCount: 25, lengthRules: "23+2" }, TODAY);
  await assert.rejects(
    publishCyclePlan(db.pool, { year: 2026, cycleCount: 25, lengthRules: "23+3", planHash: preview.planHash }, { today: TODAY }),
    { code: "PLAN_STALE", statusCode: 409 }
  );
  assert.equal(writes(db.state).length, 0);
  assert.equal(db.state.calls.at(-1).sql, "rollback");
});

test("a new year is created with the existing label style and stable IDs", async () => {
  const db = fakeDatabase(publishedYear(2026));
  const body = { year: 2027, cycleCount: 25, lengthRules: "" };
  const preview = await buildCyclePreview(db.client, body, TODAY);
  assert.equal(preview.ok, true);
  assert.ok(preview.cycles.every(cycle => cycle.status === "new"));
  await publishCyclePlan(db.pool, { ...body, planHash: preview.planHash }, { today: TODAY });
  const created = db.state.cycles.filter(cycle => cycle.start_date.startsWith("2027"));
  assert.equal(created.length, 25);
  assert.equal(created[0].cycle_label, "C1");
  assert.equal(created[0].cycle_record_id, "hawley-cycle:2027-01");
  assert.equal(created.at(-1).end_date, "2027-12-30");
  assert.match(created.find(cycle => cycle.holidays.includes("Day After Thanksgiving")).holidays, /2027-11-26/);
});

test("publishing an unchanged plan or one that drops published cycles is refused", async () => {
  const db = fakeDatabase(publishedYear(2026));
  const same = await buildCyclePreview(db.client, { year: 2026, cycleCount: 25 }, TODAY);
  assert.deepEqual(same.changedCycleNumbers, []);
  await assert.rejects(publishCyclePlan(db.pool, { year: 2026, cycleCount: 25, planHash: same.planHash }, { today: TODAY }), { code: "PLAN_UNCHANGED" });

  const fewer = await buildCyclePreview(db.client, { year: 2026, cycleCount: 24 }, TODAY);
  assert.ok(fewer.conflicts.some(conflict => conflict.code === "published_cycle_outside_plan"));
});
