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
