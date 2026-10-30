// Migration 039 (task definitions, versions, occurrences) against real PostgreSQL (embedded PGlite).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migration = name => readFile(new URL(`../../../db/migrations/${name}`, import.meta.url), "utf8");
const tableSql = async (file, table) => {
  const text = await migration(file);
  const start = text.indexOf(`create table if not exists ${table} (`);
  return text.slice(start, text.indexOf("\n);", start) + 3);
};

async function database() {
  const db = new PGlite();
  await db.exec("create role bowlus_app; create role bowlus_sync; create role bowlus_readonly; create schema hb;");
  await db.exec(await tableSql("009_hb_rev1_brain.sql", "hb.rev1_task_instances"));
  await db.exec(await tableSql("015_project_creator_source_tables.sql", "hb.task_templates"));
  await db.exec("alter table hb.task_templates add column if not exists model_type_record_ids text[] not null default '{}'::text[]");
  await db.query(`insert into hb.task_templates (task_record_id, tasks_key, task_name, primary_phase_name, estimated_task_time_seconds, document_link, model_type_record_ids)
                  values ('recShower', 'recShower', 'Install Shower L-Track', 'F', 1800, 'https://sop/shower', '{recFrontier}'),
                         ('recCnc', 'recCnc', '01-B25_B_Endless', 'CNC-B', 1200, null, '{}')`);
  const tasks = [
    ["recShower", 334, null, true], ["recShower", 335, null, false], ["recShower", 335, null, false],
    ["recCnc", null, "ps-25-CNC-B", true], ["recMissing", 336, null, false], ["recShower", null, null, false]
  ];
  for (const [key, vin, row, done] of tasks) {
    await db.query("insert into hb.rev1_task_instances (tasks_key, vin, line_schedule_record_id, cycle_record_id, task_completed, task_name) values ($1, $2, $3, 'c25', $4, 't')", [key, vin, row, done]);
  }
  return db;
}

test("migration 039 creates version 1 of every template and maps existing tasks to occurrences", async () => {
  const db = await database();
  await db.exec(await migration("039_task_definitions_occurrences.sql"));
  await db.exec(await migration("039_task_definitions_occurrences.sql"));

  const versions = await db.query("select task_definition_id, version_number, task_name, sop_link, phase_name from hb.task_definition_versions order by 1");
  assert.deepEqual(versions.rows.map(v => [v.task_definition_id, v.version_number, v.sop_link]), [["recCnc", 1, null], ["recShower", 1, "https://sop/shower"]]);

  const occ = await db.query("select occurrence_id, subject_kind, subject_key, occurrence_number, status from hb.work_occurrences order by occurrence_id");
  assert.deepEqual(occ.rows.map(o => o.occurrence_id), [
    "occ:recCnc:batch:ps-25-CNC-B:1",
    "occ:recShower:vin:334:1",
    "occ:recShower:vin:335:1",
    "occ:recShower:vin:335:2"
  ]);
  assert.deepEqual(occ.rows.map(o => o.status), ["completed", "completed", "released", "released"]);

  const links = await db.query("select tasks_key, vin, occurrence_id from hb.rev1_task_instances order by rev1_task_instance_id");
  assert.deepEqual(links.rows.map(r => r.occurrence_id), [
    "occ:recShower:vin:334:1", "occ:recShower:vin:335:1", "occ:recShower:vin:335:2", "occ:recCnc:batch:ps-25-CNC-B:1", null, null
  ], "unknown template and no-subject tasks stay unmapped for review");
});

test("HB rebuild linking adds new tasks as the next occurrence and keeps status and cycle current", async () => {
  const { linkTaskOccurrences } = await import("../src/task-occurrences.js");
  const db = await database();
  await db.exec(await migration("039_task_definitions_occurrences.sql"));
  await db.exec(await migration("040_task_mapping_rules.sql"));
  await db.query("insert into hb.rev1_task_instances (tasks_key, vin, cycle_record_id, task_completed, task_name) values ('recShower', 335, 'c1-27', false, 'new')");
  await db.query("update hb.rev1_task_instances set task_completed = true, cycle_record_id = 'c24' where vin = 334");
  const result = await linkTaskOccurrences(db);
  assert.deepEqual(result, { linked: 1, refreshed: 1, teamTasksFolded: 0, emptyOccurrencesRemoved: 0 });
  const occ = await db.query("select occurrence_id, cycle_record_id, status from hb.work_occurrences where subject_key in ('334', '335') order by occurrence_id");
  assert.deepEqual(occ.rows.map(o => [o.occurrence_id, o.cycle_record_id, o.status]), [
    ["occ:recShower:vin:334:1", "c24", "completed"],
    ["occ:recShower:vin:335:1", "c25", "released"],
    ["occ:recShower:vin:335:2", "c25", "released"],
    ["occ:recShower:vin:335:3", "c1-27", "released"]
  ]);
  assert.deepEqual(await linkTaskOccurrences(db), { linked: 0, refreshed: 0, teamTasksFolded: 0, emptyOccurrencesRemoved: 0 }, "second run is a no-op");
});

test("task-time table: averages use the 5-hour rule, last 5 are most recent, columns are newest VINs", async () => {
  const { buildTaskTimeTable, qualifiesForAverage } = await import("../src/task-occurrences.js");
  assert.equal(qualifiesForAverage(3600, 1800), true);
  assert.equal(qualifiesForAverage(1800 + 5 * 3600 + 1, 1800), false);
  const obs = [330, 331, 332, 333, 334, 335, 336].map((vin, i) => ({
    task_definition_id: "recShower", task_name: "Install Shower L-Track", phase_name: "F", estimate_seconds: 1800,
    vin, actual_seconds: 1800 + i * 600, completed_on: `2026-10-${String(10 + i).padStart(2, "0")}`, cycle_key: `C${18 + i}.26`, cycle_order: i
  }));
  obs.push({ ...obs[0], vin: 337, actual_seconds: 30 * 3600, completed_on: "2026-10-30" });
  const table = buildTaskTimeTable(obs, { columns: 3 });
  assert.deepEqual(table.columns, ["337", "336", "335"]);
  const row = table.rows[0];
  assert.equal(row.count, 7);
  assert.equal(row.excluded, 1);
  assert.equal(row.averageSeconds, 3600);
  assert.equal(row.recentAverageSeconds, Math.round((5400 + 4800 + 4200 + 3600 + 3000) / 5));
  assert.deepEqual(row.cells, { 337: 108000, 336: 5400, 335: 4800 });
  assert.deepEqual(buildTaskTimeTable(obs, { mode: "cycle", columns: 2 }).columns, ["C24.26", "C23.26"]);
});

test("review rules map unkeyed tasks (VIN from project name, cycle buckets) and ignore one-offs", async () => {
  const { saveTaskMappingRules, taskMappingGroups, linkTaskOccurrences } = await import("../src/task-occurrences.js");
  const db = await database();
  await db.exec(await migration("039_task_definitions_occurrences.sql"));
  await db.exec(await migration("040_task_mapping_rules.sql"));
  await linkTaskOccurrences(db);
  const add = (name, phase, vin, project, portfolio, cycle, seconds) => db.query(
    "insert into hb.rev1_task_instances (task_name, phase_label, vin, asana_project_name, asana_portfolio_name, cycle_record_id, task_completed, actual_time_seconds) values ($1, $2, $3, $4, $5, $6, true, $7)",
    [name, phase, vin, project, portfolio, cycle, seconds]);
  await add("Install  Shower L-Track ", "F", null, "319 - Frontier", "VINs - 2025", "c10", 2400);
  await add("install shower l-track", "F", 320, "320 - Frontier", "VINs - 2025", "c11", 2000);
  await add("01-B25_B_Endless", "CNC-B", null, "Fabrication C3", "Fabrication - 2026", "c3", 900);
  await add("Fix weld per ECN 12", "B", null, "ECN 12", "Engineering Changes", null, 600);

  const before = await taskMappingGroups(db);
  const shower = before.groups.find(g => g.norm_name === "install shower l-track");
  assert.equal(shower.tasks, 2);
  assert.deepEqual(shower.suggestions.map(x => [x.taskDefinitionId, x.samePhase]), [["recShower", true]]);

  const result = await saveTaskMappingRules(db, [
    { name: "Install Shower L-Track", phase: "F", action: "map", taskDefinitionId: "recShower" },
    { name: "01-B25_B_Endless", phase: "CNC-B", action: "map", taskDefinitionId: "recCnc" },
    { name: "Fix weld per ECN 12", phase: "B", action: "ignore" }
  ], "admin@example.test");
  assert.equal(result.linked, 3);
  const occ = await db.query("select occurrence_id from hb.work_occurrences where source = 'hb rebuild: new task' order by 1");
  assert.deepEqual(occ.rows.map(o => o.occurrence_id), ["occ:recCnc:batch:cycle:c3:CNC-B:1", "occ:recShower:vin:319:1", "occ:recShower:vin:320:1"]);
  const after = await taskMappingGroups(db);
  assert.ok(!after.groups.some(g => g.norm_name.includes("ecn")), "ignored groups leave the review");
  await assert.rejects(saveTaskMappingRules(db, [{ name: "x", phase: "B", action: "map" }]), /Pick a template/);
});

test("duplicated team tasks (one copy per person) fold into one occurrence; same-person repeats stay separate", async () => {
  const { linkTaskOccurrences, buildTaskTimeTable } = await import("../src/task-occurrences.js");
  const db = await database();
  await db.exec(await migration("039_task_definitions_occurrences.sql"));
  await db.exec(await migration("040_task_mapping_rules.sql"));
  const add = (email, done, seconds) => db.query(
    "insert into hb.rev1_task_instances (tasks_key, vin, cycle_record_id, task_completed, actual_time_seconds, worker_email, worker_name, task_name) values ('recShower', 340, 'c24', $1, $2, $3, $3, 'Rivet')",
    [done, seconds, email]);
  await add("mauricer@x.com", true, 4200);
  await add("luisg@x.com", false, 3000);
  await add("mauricer@x.com", true, 600);
  const result = await linkTaskOccurrences(db);
  assert.deepEqual([result.linked, result.teamTasksFolded, result.emptyOccurrencesRemoved], [3, 1, 1]);
  const occ = await db.query("select o.occurrence_id, o.status, count(t.*)::int as tasks from hb.work_occurrences o join hb.rev1_task_instances t on t.occurrence_id = o.occurrence_id where o.subject_key = '340' group by 1, 2 order by 1");
  assert.deepEqual(occ.rows, [
    { occurrence_id: "occ:recShower:vin:340:1", status: "released", tasks: 2 },
    { occurrence_id: "occ:recShower:vin:340:3", status: "completed", tasks: 1 }
  ], "team occurrence stays open until every copy is complete");

  await db.query("update hb.rev1_task_instances set task_completed = true where worker_email = 'luisg@x.com'");
  await linkTaskOccurrences(db);
  const obs = (await db.query(`select t.occurrence_id, 'recShower' as task_definition_id, 'Rivet' as task_name, 'F' as phase_name, 7200 as estimate_seconds,
      t.vin, t.actual_time_seconds as actual_seconds, '2026-10-30' as completed_on, t.worker_name as worker, null::jsonb as session_minutes
      from hb.rev1_task_instances t where t.vin = 340 and t.task_completed`)).rows;
  const row = buildTaskTimeTable(obs).rows[0];
  assert.deepEqual([row.count, row.averageSeconds, row.averageCrew], [2, Math.round((7200 + 600) / 2), 1.5]);
  assert.deepEqual(row.cellPeople["340"], { "mauricer@x.com": 4800, "luisg@x.com": 3000 });
});
