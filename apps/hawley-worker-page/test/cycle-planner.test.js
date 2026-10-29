import test from "node:test";
import assert from "node:assert/strict";

import { readFile } from "node:fs/promises";

import { planCycles } from "../../postgres-sync/src/cycle-calendar.js";
import { HB_BUILD_LOCK_KEY, HB_BUILD_LOCK_NAMESPACE } from "../../postgres-sync/src/hb-build-transaction.js";
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
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
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

test("preview locks past cycles, keeps the current cycle, shows changes with impact, and writes nothing", async () => {
  const db = fakeDatabase(publishedYear(2026));
  const preview = await buildCyclePreview(db.client, { year: 2026, cycleCount: 25, lengthRules: "23+2" }, TODAY);
  assert.equal(preview.ok, true, JSON.stringify(preview.conflicts));
  const past = preview.cycles.filter(cycle => cycle.endDate < TODAY);
  assert.ok(past.length >= 20 && past.every(cycle => cycle.source === "locked" && cycle.status === "unchanged"));
  const current = preview.cycles.find(cycle => cycle.startDate <= TODAY && cycle.endDate >= TODAY);
  assert.deepEqual([current.source, current.status], ["current", "unchanged"]);
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

test("publish and migration 036 take the HB build gate before touching cycles", async () => {
  const db = fakeDatabase(publishedYear(2026));
  const body = { year: 2026, cycleCount: 25, lengthRules: "23+2" };
  const preview = await buildCyclePreview(db.client, body, TODAY);
  await publishCyclePlan(db.pool, { ...body, planHash: preview.planHash }, { today: TODAY });
  const begin = db.state.calls.findIndex(call => call.sql === "begin");
  assert.equal(db.state.calls[begin + 1].sql, "select pg_advisory_xact_lock($1::integer, $2::integer)");
  assert.deepEqual(db.state.calls[begin + 1].params, [HB_BUILD_LOCK_NAMESPACE, HB_BUILD_LOCK_KEY]);

  const migration = await readFile(new URL("../../../db/migrations/036_cycles_single_source.sql", import.meta.url), "utf8");
  const firstStatement = migration.split(/\r?\n/).find(line => line.trim() && !line.startsWith("--"));
  assert.equal(firstStatement, `select pg_advisory_xact_lock(${HB_BUILD_LOCK_NAMESPACE}, ${HB_BUILD_LOCK_KEY});`);
});

test("a past cycle still cannot be changed", async () => {
  const db = fakeDatabase(publishedYear(2026));
  const preview = await buildCyclePreview(db.client, { year: 2026, cycleCount: 25, lengthRules: "19+1" }, TODAY);
  assert.equal(preview.conflicts[0].code, "locked_cycle_constraint");
});

function liveLike2026() {
  // Live 2026 cycles after the C19 correction (C19 Oct 8-23, 12 days); C20 is stored from Oct 1 to Nov 2.
  const live = [["2026-01-12","2026-01-27",12],["2026-01-28","2026-02-12",12],["2026-02-13","2026-03-02",12],["2026-03-03","2026-03-18",12],["2026-03-19","2026-04-14",19],["2026-04-15","2026-04-28",10],["2026-04-29","2026-05-12",10],["2026-05-13","2026-05-27",10],["2026-05-28","2026-06-10",10],["2026-06-11","2026-06-24",10],["2026-06-25","2026-07-09",10],["2026-07-10","2026-07-22",9],["2026-07-23","2026-08-04",9],["2026-08-05","2026-08-17",9],["2026-08-18","2026-08-28",9],["2026-08-31","2026-09-11",9],["2026-09-14","2026-09-24",9],["2026-09-25","2026-10-07",9],["2026-10-08","2026-10-23",12],["2026-10-01","2026-11-02",23],["2026-11-03","2026-11-12",8],["2026-11-13","2026-11-24",8],["2026-11-25","2026-12-08",8],["2026-12-09","2026-12-18",8],["2026-12-21","2026-12-31",8]];
  return live.map(([start_date, end_date, days_in_cycle], index) => ({
    cycle_record_id: `rec-live-${index + 1}`, cycle_number: index + 1, cycle_label: `C${index + 1}`,
    start_date, end_date, days_in_cycle, quarter: "", holidays: "", source_system: "airtable_bootstrap"
  }));
}

test("a current cycle overlapping a past cycle starts the day after it and keeps its published end", async () => {
  const db = fakeDatabase(liveLike2026());
  const preview = await buildCyclePreview(db.client, { year: 2026, startDate: "2026-01-12", cycleCount: 25 }, TODAY);
  assert.equal(preview.ok, true, JSON.stringify(preview.conflicts));
  assert.ok(preview.warnings.some(warning => warning.code === "current_start_moved"));
  const c20 = preview.cycles[19];
  assert.deepEqual([c20.startDate, c20.endDate, c20.days, c20.source, c20.status], ["2026-10-26", "2026-11-02", 6, "current", "changed"]);
  assert.deepEqual(preview.cycles.slice(20).map(c => [c.startDate, c.days, c.status]), [["2026-11-03", 8, "unchanged"], ["2026-11-13", 8, "unchanged"], ["2026-11-25", 8, "unchanged"], ["2026-12-09", 8, "unchanged"], ["2026-12-21", 8, "unchanged"]]);
});

test("override the current cycle, then later cycles balance longest first, and it publishes", async () => {
  const db = fakeDatabase(liveLike2026());
  const body = { year: 2026, startDate: "2026-01-12", cycleCount: 25, lengthRules: "20=11" };
  const preview = await buildCyclePreview(db.client, body, TODAY);
  assert.equal(preview.ok, true, JSON.stringify(preview.conflicts));
  const c20 = preview.cycles[19];
  assert.deepEqual([c20.startDate, c20.endDate, c20.days, c20.source], ["2026-10-26", "2026-11-09", 11, "fixed"]);
  const rest = preview.cycles.slice(20).map(c => c.days);
  assert.deepEqual(rest, [7, 7, 7, 7, 7]);
  assert.equal(preview.cycles[20].startDate, "2026-11-10");
  assert.equal(preview.cycles.at(-1).endDate, "2026-12-31");
  assert.ok(preview.cycles.slice(0, 19).every(cycle => cycle.source === "locked" && cycle.status === "unchanged"));

  await publishCyclePlan(db.pool, { ...body, planHash: preview.planHash }, { today: TODAY });
  const stored = db.state.cycles.find(cycle => cycle.cycle_number === 20);
  assert.deepEqual([stored.start_date, stored.end_date, stored.days_in_cycle], ["2026-10-26", "2026-11-09", 11]);
});
