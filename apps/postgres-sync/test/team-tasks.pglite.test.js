// Team tasks (migration 043, worker view 003, helper sync) against real PostgreSQL (embedded PGlite).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

import { parseTrialEmails, syncTaskHelpers } from "../src/team-tasks.js";

const sql = path => readFile(new URL(`../../../db/${path}`, import.meta.url), "utf8");
const tableSql = async (file, table) => {
  const text = await sql(`migrations/${file}`);
  const start = text.indexOf(`create table if not exists ${table} (`);
  return text.slice(start, text.indexOf("\n);", start) + 3);
};
const FIELD = "helpers-field";

async function database() {
  const db = new PGlite();
  await db.exec(`create role bowlus_app; create role bowlus_sync; create role bowlus_readonly;
    create schema hb; create schema raw; create schema reporting; create schema ops;
    create function ops.jsonb_display_text(value jsonb) returns text language sql immutable as $$ select value #>> '{}' $$;
    create table raw.asana_tasks (gid text primary key, completed boolean, permalink_url text, synced_at timestamptz, custom_fields_json jsonb);`);
  await db.exec(await tableSql("009_hb_rev1_brain.sql", "hb.rev1_task_instances"));
  await db.exec(await tableSql("015_project_creator_source_tables.sql", "hb.task_templates"));
  await db.exec(`alter table hb.task_templates add column if not exists required_skill_level numeric(12, 4);
    create view reporting.task_work_area_inference as select null::bigint as task_instance_id, null::text as inferred_work_area_key, null::text as inferred_work_area_name, null::text as inference_source where false;`);
  await db.exec(await sql("views/001_reporting_daily_worker_assignments.sql"));
  await db.exec(await sql("migrations/043_team_task_helpers.sql"));
  await db.exec(await sql("views/003_hawley_worker_page.sql"));

  await db.query("update hb.team_task_settings set helpers_field_gid = $1", [FIELD]);
  await db.query(`insert into hb.rev1_task_instances (asana_task_gid, task_name, worker_name, worker_email, assigned_on, estimated_task_time_seconds, vin)
                  values ('t1', 'Rivet All Panels', 'Mauricer', 'mauricer@x.com', '2026-10-30', 7200, 336)`);
  const helpers = [{ gid: "u2", name: "Luis G", email: "LuisG@x.com" }, { gid: "u1", name: "Mauricer", email: "mauricer@x.com" }];
  await db.query("insert into raw.asana_tasks (gid, completed, custom_fields_json) values ('t1', false, $1::jsonb)",
    [JSON.stringify([{ gid: "other", name: "VIN", display_value: "336" }, { gid: FIELD, name: "Helpers", people_value: helpers }])]);
  return db;
}

test("helpers sync from the Asana field, follow removals, and the assignee is not listed as a helper", async () => {
  const db = await database();
  assert.equal((await syncTaskHelpers(db)).helpers, 2);
  let view = await db.query("select worker_email, assignment_role, estimated_hours from reporting.hawley_worker_page_assignments order by assignment_role");
  assert.deepEqual(view.rows.map(r => r.assignment_role), ["assignee"], "helpers hidden until trial or rollout");

  await db.query("update hb.team_task_settings set trial_worker_emails = $1", [parseTrialEmails("luisg@x.com, nobody")]);
  view = await db.query("select worker_email, assignment_role, estimated_hours::float as est from reporting.hawley_worker_page_assignments order by assignment_role");
  assert.deepEqual(view.rows, [
    { worker_email: "mauricer@x.com", assignment_role: "assignee", est: 2 },
    { worker_email: "luisg@x.com", assignment_role: "helper", est: 0 }
  ]);

  await db.query(`update raw.asana_tasks set custom_fields_json = '[{"gid": "${FIELD}", "people_value": []}]'::jsonb`);
  const result = await syncTaskHelpers(db);
  assert.deepEqual([result.helpers, result.removed], [0, 2]);
  view = await db.query("select count(*)::int as n from reporting.hawley_worker_page_assignments where assignment_role = 'helper'");
  assert.equal(view.rows[0].n, 0);
});

test("enabled for everyone shows all helpers; sync is skipped until the field is set up", async () => {
  const db = await database();
  await syncTaskHelpers(db);
  await db.query("update hb.team_task_settings set enabled_for_all = true");
  const rows = await db.query("select worker_email from reporting.hawley_worker_page_assignments where assignment_role = 'helper'");
  assert.deepEqual(rows.rows.map(r => r.worker_email), ["luisg@x.com"]);
  await db.query("update hb.team_task_settings set helpers_field_gid = null");
  assert.equal((await syncTaskHelpers(db)).skipped, "Helpers field not set up");
  assert.deepEqual(parseTrialEmails(["A@B.com", "a@b.com", "bad"]), ["a@b.com"]);
});
