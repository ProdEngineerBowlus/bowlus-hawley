// Combined cycle + production planning against real PostgreSQL (embedded PGlite), using the actual
// migrations and live-shaped 2026 data.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

import { planCycles } from "../../postgres-sync/src/cycle-calendar.js";
import { generateProductionPlan, stateFromCycleRows } from "../../postgres-sync/src/production-plan.js";
import { buildCyclePreview, productionScheduleRows, publishCyclePlan } from "../cycle-planner.js";

const TODAY = "2026-10-29";
const FRONTIER = "recl2xVPOf1X0CkjG";
const PHASE_NAMES = ["A1", "A2", "B", "C", "D", "E", "F", "G", "H", "FAB-A", "FAB-B", "Frame-A", "Frame-B", "CNC-A", "CNC-B"];
const migration = name => readFile(new URL(`../../../db/migrations/${name}`, import.meta.url), "utf8");
const tableSql = async (file, table) => {
  const text = await migration(file);
  const start = text.indexOf(`create table if not exists ${table} (`);
  return text.slice(start, text.indexOf("\n);", start) + 3);
};
const ASANA_OPTIONS = new Set([...Array(26).keys()].flatMap(n => [`c${n}.26`, `c${n}.27`]));

async function liveLikeDatabase() {
  const db = new PGlite();
  await db.exec("create role bowlus_app; create role bowlus_sync; create role bowlus_readonly; create schema hb;");
  for (const [file, table] of [
    ["009_hb_rev1_brain.sql", "hb.cycles"], ["009_hb_rev1_brain.sql", "hb.phases"], ["009_hb_rev1_brain.sql", "hb.rev1_task_instances"],
    ["015_project_creator_source_tables.sql", "hb.production_schedule"], ["016_project_creator_native_sources.sql", "hb.vins"],
    ["016_project_creator_native_sources.sql", "hb.models"], ["016_project_creator_native_sources.sql", "hb.project_creation_runs"]
  ]) await db.exec(await tableSql(file, table));
  for (const file of ["035_cycle_plan_versions.sql", "036_cycles_single_source.sql", "038_cycle_plan_production.sql"]) await db.exec(await migration(file));

  for (const name of PHASE_NAMES) await db.query("insert into hb.phases (phase_record_id, phase_name, section_column, model_type) values ($1, $2, $3, $4)", [`ph-${name}`, name, name, FRONTIER]);
  for (let vin = 300; vin <= 343; vin++) await db.query("insert into hb.vins (vin_record_id, vin, model_type_record_ids) values ($1, $2, $3)", [`vin-${vin}`, vin, [FRONTIER]]);

  // Live 2026 dates (C19 corrected to 12 days; C20 stored from Oct 1).
  const live = [["2026-01-12","2026-01-27",12],["2026-01-28","2026-02-12",12],["2026-02-13","2026-03-02",12],["2026-03-03","2026-03-18",12],["2026-03-19","2026-04-14",19],["2026-04-15","2026-04-28",10],["2026-04-29","2026-05-12",10],["2026-05-13","2026-05-27",10],["2026-05-28","2026-06-10",10],["2026-06-11","2026-06-24",10],["2026-06-25","2026-07-09",10],["2026-07-10","2026-07-22",9],["2026-07-23","2026-08-04",9],["2026-08-05","2026-08-17",9],["2026-08-18","2026-08-28",9],["2026-08-31","2026-09-11",9],["2026-09-14","2026-09-24",9],["2026-09-25","2026-10-07",9],["2026-10-08","2026-10-23",12],["2026-10-01","2026-11-02",23],["2026-11-03","2026-11-12",8],["2026-11-13","2026-11-24",8],["2026-11-25","2026-12-08",8],["2026-12-09","2026-12-18",8],["2026-12-21","2026-12-31",8]];
  for (const [index, [start, end, days]] of live.entries()) {
    await db.query("insert into hb.cycles (cycle_record_id, cycle_number, cycle_label, start_date, end_date, days_in_cycle) values ($1, $2, $3, $4, $5, $6)", [`rec-c${index + 1}`, index + 1, `C${index + 1}`, start, end, days]);
  }
  // Schedule rows C20-C25 exactly as the original script produced them (C20 = A1 335/336).
  const state = stateFromCycleRows([{ phase_name: "A2", vin: "334" }, { phase_name: "A2", vin: "333" }]);
  const phases = (await db.query("select * from hb.phases")).rows;
  const vins = (await db.query("select * from hb.vins")).rows;
  const { rows } = generateProductionPlan({ cycles: [20, 21, 22, 23, 24, 25].map(n => ({ key: `rec-c${n}`, year: 2026, cycle: n })), state, phases, vins });
  for (const row of rows) {
    const c = live[row.cycle - 1];
    await db.query(
      `insert into hb.production_schedule (production_record_id, cycle_record_id, cycle_number, cycle_label, phase_record_id, phase_name, vin, vin_values, vin_record_ids, model_type, start_date, end_date, days_in_cycle)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [`ps-${row.cycle}-${row.phaseName}-${row.vin || "x"}`, row.cycleKey, row.cycle, `C${row.cycle}`, row.phaseRecordId, row.phaseName, row.vin, row.vin ? [row.vin] : [], row.vinRecordId ? [row.vinRecordId] : [], row.modelType, c[0], c[1], c[2]]
    );
  }
  // C25 tasks as live: VINs 332-336 have tasks on their C25 phase rows.
  for (const [phase, vin, count] of [["D", "336", 3], ["E", "335", 2], ["F", "334", 2], ["G", "333", 1], ["H", "332", 2]]) {
    for (let i = 0; i < count; i++) {
      await db.query(
        `insert into hb.rev1_task_instances (asana_task_gid, line_schedule_record_id, cycle_record_id, cycle_label, phase_record_id, vin, task_name)
         values ($1, $2, 'rec-c25', 'C25', $3, $4, $5)`,
        [`gid-${vin}-${i}`, `ps-25-${phase}-${vin}`, `ph-${phase}`, Number(vin), `${phase} task ${i}`]
      );
    }
  }
  const client = { query: (sql, params) => db.query(sql, params), release() {} };
  return { db, client, pool: { connect: async () => client, query: client.query } };
}

const BODY = { year: 2026, startDate: "2026-01-12", cycleCount: 24, nextYear: { cycleCount: 25 } };

test("dropping C25 moves its VIN rows and tasks into 2027 C1 and keeps parity", async () => {
  const { db, client, pool } = await liveLikeDatabase();
  const preview = await buildCyclePreview(client, BODY, TODAY, undefined, { asanaCycleOptions: ASANA_OPTIONS });
  assert.equal(preview.ok, true, JSON.stringify(preview.conflicts));
  assert.deepEqual(preview.removedCycles.map(c => c.cycle), [25]);
  const c1 = preview.years[1].cycles[0];
  assert.equal(c1.status, "new");
  assert.deepEqual(c1.production.rows.map(r => `${r.phase}:${r.vin ?? ""}`).join(" "), "FAB-B: A2:340 A2:339 Frame-B: B:338 C:337 D:336 E:335 F:334 G:333 H:332 CNC-B:");
  assert.ok(c1.production.rows.every(r => r.action === "move"), "C25 rows keep their IDs");
  assert.equal(preview.production.relinkCount, 10);
  assert.ok(preview.production.relinks.every(r => r.to === "C1.27"));
  // 2026 C21-C24 are unchanged in VIN positions.
  assert.ok(preview.years[0].cycles.slice(20).every(c => c.production.rows.every(r => r.action === "keep")));

  await assert.rejects(publishCyclePlan(pool, { ...BODY, planHash: preview.planHash }, { today: TODAY, asanaCycleOptions: ASANA_OPTIONS }), { code: "ASANA_PUSH_REQUIRED" });
  const result = await publishCyclePlan(pool, { ...BODY, planHash: preview.planHash, pushToAsana: true }, { today: TODAY, asanaCycleOptions: ASANA_OPTIONS });
  assert.deepEqual(result.removedCycleNumbers, [25]);
  assert.equal(result.asanaPushes.length, 10);
  assert.ok(result.asanaPushes.every(p => p.label === "C1.27" && p.status === "pending"));

  const c25 = await db.query("select count(*)::int n from hb.cycles where cycle_record_id = 'rec-c25'");
  assert.equal(c25.rows[0].n, 0);
  const moved = await db.query("select ps.cycle_record_id, c.start_date::text s from hb.production_schedule ps join hb.cycles c using (cycle_record_id) where production_record_id = 'ps-25-H-332'");
  assert.deepEqual(moved.rows, [{ cycle_record_id: "hawley-cycle:2027-01", s: "2027-01-04" }]);
  const tasks = await db.query("select distinct cycle_record_id, cycle_label, phase_cycle_key from hb.rev1_task_instances where vin = 332");
  assert.deepEqual(tasks.rows, [{ cycle_record_id: "hawley-cycle:2027-01", cycle_label: "C1", phase_cycle_key: "ph-H::hawley-cycle:2027-01" }]);
  const count2027 = await db.query("select count(*)::int n from hb.production_schedule ps join hb.cycles c using (cycle_record_id) where extract(year from c.start_date) = 2027");
  assert.equal(count2027.rows[0].n, 25 * 12);
  const versions = await db.query("select plan_year, plan_group_id, jsonb_array_length(asana_push_json) pushes from hb.cycle_plan_versions order by plan_year");
  assert.equal(versions.rows.length, 2);
  assert.equal(versions.rows[0].plan_group_id, versions.rows[1].plan_group_id);
  assert.equal(versions.rows[0].pushes, 10);

  // Publishing again with the same inputs is a no-op plan.
  const again = await buildCyclePreview(client, BODY, TODAY, undefined, { asanaCycleOptions: ASANA_OPTIONS });
  assert.equal(again.changeCount, 0, JSON.stringify(again.conflicts));
});

test("missing Asana Cycle options are listed for publishing in plan order, and Asana outages block task moves", async () => {
  const { client, pool } = await liveLikeDatabase();
  const existing = new Set([...Array(26).keys()].map(n => `c${n}.26`));
  const preview = await buildCyclePreview(client, BODY, TODAY, undefined, { asanaCycleOptions: existing });
  assert.equal(preview.ok, true, JSON.stringify(preview.conflicts));
  assert.equal(preview.production.asanaOptionsToAdd.length, 25);
  assert.deepEqual([preview.production.asanaOptionsToAdd[0], preview.production.asanaOptionsToAdd.at(-1)], ["C1.27", "C25.27"]);
  const result = await publishCyclePlan(pool, { ...BODY, planHash: preview.planHash, pushToAsana: true }, { today: TODAY, asanaCycleOptions: existing });
  assert.equal(result.asanaOptionsToAdd.length, 25);
  const fresh = await liveLikeDatabase();
  const offline = await buildCyclePreview(fresh.client, BODY, TODAY, undefined, {});
  assert.ok(offline.conflicts.some(c => c.code === "asana_unavailable"));
});

test("tasks on a dropped cycle without a schedule row block its removal", async () => {
  const { db, client } = await liveLikeDatabase();
  await db.query("insert into hb.rev1_task_instances (asana_task_gid, cycle_record_id, cycle_label, task_name) values ('loose', 'rec-c25', 'C25', 'loose task')");
  const preview = await buildCyclePreview(client, BODY, TODAY, undefined, { asanaCycleOptions: ASANA_OPTIONS });
  const conflict = preview.conflicts.find(c => c.code === "cycle_removal_linked");
  assert.match(conflict.message, /C25 \(2026\) cannot be removed yet: 1 tasks/);
});

test("past cycles cannot be dropped and the current cycle cannot be removed", async () => {
  const { client } = await liveLikeDatabase();
  const preview = await buildCyclePreview(client, { ...BODY, cycleCount: 19 }, TODAY, undefined, { asanaCycleOptions: ASANA_OPTIONS });
  assert.ok(preview.conflicts.some(c => c.code === "cycle_removal_started" && c.cycles[0] === 20));
});

test("keeping 25 cycles changes nothing in production and plans 2027 from C25", async () => {
  const { client } = await liveLikeDatabase();
  const preview = await buildCyclePreview(client, { ...BODY, cycleCount: 25 }, TODAY, undefined, { asanaCycleOptions: ASANA_OPTIONS });
  assert.equal(preview.ok, true, JSON.stringify(preview.conflicts));
  assert.equal(preview.production.relinkCount, 0);
  assert.equal(preview.years[1].cycles[0].production.rows.find(r => r.phase === "A1").vin, "341");
  assert.ok(preview.years[1].cycles[0].production.rows.every(r => r.action === "create"));
});

test("the production table lists each schedule row with its cycle, phase, VIN and task counts", async () => {
  const { client } = await liveLikeDatabase();
  const rows = await productionScheduleRows(client, 2026, 2027);
  assert.equal(rows.length, 6 * 12);
  const h332 = rows.find(row => row.phase_name === "H" && row.vin === "332");
  assert.deepEqual([h332.year, h332.cycle, h332.start_date, h332.tasks, h332.tasksDone], [2026, 25, "2026-12-21", 2, 0]);
  assert.equal(rows[0].cycle, 20);
});
