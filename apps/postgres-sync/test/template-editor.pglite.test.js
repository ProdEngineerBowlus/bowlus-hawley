// Template editing (migrations 039-041 + template-editor.js) against real PostgreSQL (embedded PGlite).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

import { listTemplates, promoteTemplateVersions, saveTemplateVersion, templateDetail, templateEditorOptions } from "../src/template-editor.js";

const migration = name => readFile(new URL(`../../../db/migrations/${name}`, import.meta.url), "utf8");
const tableSql = async (file, table) => {
  const text = await migration(file);
  const start = text.indexOf(`create table if not exists ${table} (`);
  return text.slice(start, text.indexOf("\n);", start) + 3);
};
const FILE = { bucket: "bowlus-hawley-attachments", key: "airtable/attachments/att1/abc", sha256: "abc", verified: true, filename: "shower.pdf" };

async function database() {
  const db = new PGlite();
  await db.exec("create role bowlus_app; create role bowlus_sync; create role bowlus_readonly; create schema hb; create schema core;");
  for (const [file, table] of [["009_hb_rev1_brain.sql", "hb.rev1_task_instances"], ["009_hb_rev1_brain.sql", "hb.cycles"], ["009_hb_rev1_brain.sql", "hb.phases"],
    ["015_project_creator_source_tables.sql", "hb.task_templates"], ["016_project_creator_native_sources.sql", "hb.models"], ["034_task_attachment_catalog.sql", "core.task_attachment_catalog"]]) {
    await db.exec(await tableSql(file, table));
  }
  await db.exec(`alter table hb.task_templates add column if not exists model_type_record_ids text[] not null default '{}'::text[],
                   add column if not exists model_type_names text[] not null default '{}'::text[], add column if not exists required_skill_level numeric(12, 4),
                   add column if not exists avg_time_seconds integer, add column if not exists avg_time_input_count integer`);
  await db.query(`insert into hb.phases (phase_record_id, phase_name, process_order) values ('ph-F', 'F', 7), ('ph-G', 'G', 8)`);
  await db.query(`insert into hb.models (model_record_id, model_name) values ('recFrontier', 'Frontier')`);
  await db.query(`insert into hb.cycles (cycle_record_id, cycle_number, start_date, end_date) values ('c24', 24, '2026-12-02', '2026-12-31'), ('c1-27', 1, '2027-01-04', '2027-01-15'), ('c2-27', 2, '2027-01-18', '2027-01-29')`);
  await db.query(`insert into hb.task_templates (task_record_id, tasks_key, task_name, primary_phase_record_id, primary_phase_name, estimated_task_time_seconds, active, model_type_record_ids, model_type_names)
                  values ('recShower', 'recShower', 'Install Shower L-Track', 'ph-F', 'F', 1800, true, '{recFrontier}', '{Frontier}')`);
  await db.query(`insert into core.task_attachment_catalog (task_record_id, source_base_id, source_table_id, source_field_id, source_snapshot, attachment_files)
                  values ('recShower', 'app', 'tbl', 'fld', 'snap', $1::jsonb)`, [JSON.stringify([FILE])]);
  for (const name of ["039_task_definitions_occurrences.sql", "040_task_mapping_rules.sql", "041_template_versions_editing.sql"]) await db.exec(await migration(name));
  return db;
}

const TODAY = "2026-12-10";

test("version 1 carries the catalog attachments and current template fields", async () => {
  const db = await database();
  const [row] = await listTemplates(db, { search: "shower" });
  assert.deepEqual([row.version_number, row.current_version_number, row.attachment_files_json[0].sha256, row.model_type_names], [1, 1, "abc", ["Frontier"]]);
});

test("an edit that applies now updates the live template; a future edit waits for its cycle", async () => {
  const db = await database();
  const now = await saveTemplateVersion(db, { taskDefinitionId: "recShower", estimateMinutes: 40, sopLink: "https://sop/shower", note: "faster" }, { actor: "a@x", today: TODAY });
  assert.deepEqual([now.versionNumber, now.inEffect], [2, true]);
  let live = await db.query("select estimated_task_time_seconds, document_link, source_system from hb.task_templates where task_record_id = 'recShower'");
  assert.deepEqual(live.rows[0], { estimated_task_time_seconds: 2400, document_link: "https://sop/shower", source_system: "hawley_template_editor" });

  const later = await saveTemplateVersion(db, { taskDefinitionId: "recShower", taskName: "Install Shower L-Track (v2 bracket)", appliesFrom: { year: 2027, cycle: 2 } }, { today: TODAY });
  assert.deepEqual([later.versionNumber, later.inEffect], [3, false]);
  live = await db.query("select task_name from hb.task_templates where task_record_id = 'recShower'");
  assert.equal(live.rows[0].task_name, "Install Shower L-Track", "future version not live yet");

  assert.deepEqual(await promoteTemplateVersions(db, "2027-01-18"), ["recShower"]);
  live = await db.query("select task_name, estimated_task_time_seconds from hb.task_templates where task_record_id = 'recShower'");
  assert.deepEqual(live.rows[0], { task_name: "Install Shower L-Track (v2 bracket)", estimated_task_time_seconds: 2400 });
  const detail = await templateDetail(db, "recShower");
  assert.deepEqual([detail.currentVersionNumber, detail.versions.map(v => v.version_number)], [3, [3, 2, 1]]);
  assert.deepEqual(await promoteTemplateVersions(db, "2027-01-20"), [], "already current");
});

test("new templates get a definition, a live template row and an explicit catalog entry; retiring deactivates", async () => {
  const db = await database();
  const created = await saveTemplateVersion(db, { taskName: "Install Starlink Mount", phaseRecordId: "ph-G", modelTypeRecordIds: ["recFrontier"], estimateMinutes: 90, attachmentFiles: [FILE] }, { today: TODAY });
  assert.match(created.taskDefinitionId, /^hawley-task:/);
  const live = await db.query("select task_name, primary_phase_name, active, model_type_names from hb.task_templates where task_record_id = $1", [created.taskDefinitionId]);
  assert.deepEqual(live.rows[0], { task_name: "Install Starlink Mount", primary_phase_name: "G", active: true, model_type_names: ["Frontier"] });
  const catalog = await db.query("select attachment_files from core.task_attachment_catalog where task_record_id = $1", [created.taskDefinitionId]);
  assert.equal(catalog.rows[0].attachment_files[0].sha256, "abc");

  await saveTemplateVersion(db, { taskDefinitionId: created.taskDefinitionId, retired: true, note: "Package discontinued" }, { today: TODAY });
  const retired = await db.query("select active from hb.task_templates where task_record_id = $1", [created.taskDefinitionId]);
  assert.equal(retired.rows[0].active, false);
  assert.equal((await listTemplates(db, { search: "starlink" })).length, 0);
  assert.equal((await listTemplates(db, { search: "starlink", includeRetired: true })).length, 1);
});

test("invalid edits are refused", async () => {
  const db = await database();
  await assert.rejects(saveTemplateVersion(db, { taskName: "x" }, { today: TODAY }), /Choose a phase/);
  await assert.rejects(saveTemplateVersion(db, { taskDefinitionId: "recShower", sopLink: "file://x" }, { today: TODAY }), /SOP link/);
  await assert.rejects(saveTemplateVersion(db, { taskDefinitionId: "recShower", attachmentFiles: [{ key: "x" }] }, { today: TODAY }), /verified stored files/);
  await assert.rejects(saveTemplateVersion(db, { taskDefinitionId: "recShower", appliesFrom: { year: 2027, cycle: 30 } }, { today: TODAY }), /does not exist/);
  const options = await templateEditorOptions(db, TODAY);
  assert.deepEqual([options.phases.length, options.cycles.map(c => c.cycle), options.files.length], [2, [24, 1, 2], 1]);
});
