// CNC part revisions (migration 055) against real PostgreSQL (embedded PGlite): seed from the Airtable mirror,
// VIN effectivity and the change history trigger.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// Migrations may be checked out with CRLF line endings; tableSql looks for "\n);".
const sql = async path => (await readFile(new URL(`../../../db/${path}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const tableSql = async (file, table) => {
  const text = await sql(`migrations/${file}`);
  const start = text.indexOf(`create table if not exists ${table} (`);
  return text.slice(start, text.indexOf("\n);", start) + 3);
};

async function database(parts = []) {
  const db = new PGlite();
  await db.exec("create role bowlus_app; create role bowlus_sync; create role bowlus_readonly; create schema hb;");
  await db.exec(await tableSql("029_task_template_parts_bom.sql", "hb.cnc_parts_master"));
  for (const [id, number, name, retired = false, sheets = []] of parts) {
    await db.query("insert into hb.cnc_parts_master (part_record_id, part_number, part_name, retired, cnc_sheet_record_ids) values ($1, $2, $3, $4, $5)",
      [id, number, name, retired, sheets]);
  }
  await db.exec(await sql("migrations/055_cnc_part_revisions.sql"));
  return db;
}

const rows = async (db, text, params) => (await db.query(text, params)).rows;

test("seed splits revision letters, collapses duplicate part numbers and releases the latest letter", async () => {
  const db = await database([
    ["rec1", "01201A", "Bathroom Floor"],
    ["rec2", "01201B", "Bathroom Floor", false, ["sheetX"]],
    ["rec3", "DT1A", "Door Trim", false, ["s1"]],
    ["rec4", "DT1A", "Door Trim", false, ["s2"]],
    ["rec5", "24616B", "Bracket", true],
    ["rec6", "24616C", "Bracket"]
  ]);
  assert.deepEqual(await rows(db, "select part_base, revision, part_number, status, airtable_record_ids from parts.cnc_part_revisions order by part_number"), [
    { part_base: "01201", revision: "A", part_number: "01201A", status: "superseded", airtable_record_ids: ["rec1"] },
    { part_base: "01201", revision: "B", part_number: "01201B", status: "released", airtable_record_ids: ["rec2"] },
    { part_base: "24616", revision: "B", part_number: "24616B", status: "retired", airtable_record_ids: ["rec5"] },
    { part_base: "24616", revision: "C", part_number: "24616C", status: "released", airtable_record_ids: ["rec6"] },
    { part_base: "DT1A", revision: "", part_number: "DT1A", status: "released", airtable_record_ids: ["rec3", "rec4"] }
  ]);
  assert.deepEqual((await rows(db, "select cnc_sheet_record_ids from parts.cnc_part_revisions where part_number = 'DT1A'"))[0].cnc_sheet_record_ids.sort(), ["s1", "s2"]);
  assert.deepEqual((await rows(db, "select part_number from parts.cnc_parts_current order by part_base")).map(r => r.part_number), ["01201B", "24616C", "DT1A"]);
  assert.equal((await rows(db, "select count(*)::int n from parts.cnc_part_history where changed_by = 'migration 055 seed from Airtable'"))[0].n, 8);

  // Re-running the migration never re-seeds.
  await db.exec(await sql("migrations/055_cnc_part_revisions.sql"));
  assert.equal((await rows(db, "select count(*)::int n from parts.cnc_part_revisions"))[0].n, 5);
});

test("a new revision applies from its VIN on, and every change is logged with who made it", async () => {
  const db = await database([["rec1", "01201A", "Bathroom Floor"]]);
  await db.exec(`begin; set local hawley.actor = 'jacob@bowlus.com';
    insert into parts.cnc_part_revisions (part_base, revision, status, change_reason) values ('01201', 'B', 'draft', 'Thicker floor');
    commit;`);
  await db.exec(`begin; set local hawley.actor = 'erick@bowlus.com';
    update parts.cnc_part_revisions set status = 'released', effective_from_vin = 340, released_by = 'erick@bowlus.com', released_at = now() where part_number = '01201B';
    update parts.cnc_part_revisions set status = 'superseded' where part_number = '01201A';
    commit;`);

  const forVin = async vin => (await rows(db, "select part_number from parts.cnc_revisions_for_vin($1)", [vin])).map(r => r.part_number);
  assert.deepEqual(await forVin(339), ["01201A"]);
  assert.deepEqual(await forVin(340), ["01201B"]);
  assert.deepEqual(await forVin(400), ["01201B"]);
  assert.equal((await rows(db, "select part_number from parts.cnc_parts_current"))[0].part_number, "01201B");

  const history = await rows(db, `select operation, changed_fields, changed_by, new_row->>'part_number' as part_number
                                    from parts.cnc_part_history where changed_by <> 'migration 055 seed from Airtable' order by history_id`);
  assert.deepEqual(history, [
    { operation: "insert", changed_fields: [], changed_by: "jacob@bowlus.com", part_number: "01201B" },
    { operation: "update", changed_fields: ["effective_from_vin", "released_at", "released_by", "status"], changed_by: "erick@bowlus.com", part_number: "01201B" },
    { operation: "update", changed_fields: ["status"], changed_by: "erick@bowlus.com", part_number: "01201A" }
  ]);

  // A no-op update leaves no history row; a delete is logged with the old row.
  await db.exec("update parts.cnc_part_revisions set change_reason = change_reason where part_number = '01201B'");
  await db.exec("delete from parts.cnc_part_revisions where part_number = '01201B'");
  const last = (await rows(db, "select operation, old_row->>'revision' as revision from parts.cnc_part_history order by history_id desc limit 1"))[0];
  assert.deepEqual(last, { operation: "delete", revision: "B" });
  assert.equal((await rows(db, "select count(*)::int n from parts.cnc_part_history where operation = 'update'"))[0].n, 2);
});

test("revision letters stay unique per part and statuses are checked", async () => {
  const db = await database([["rec1", "01201A", "Bathroom Floor"]]);
  await assert.rejects(db.query("insert into parts.cnc_part_revisions (part_base, revision) values ('01201', 'A')"), /unique|duplicate/i);
  await assert.rejects(db.query("insert into parts.cnc_part_revisions (part_base, revision, status) values ('01201', 'C', 'approved')"), /check/i);
  await assert.rejects(db.query("insert into parts.cnc_part_revisions (part_base, revision) values ('99999', 'A')"), /foreign key/i);
});
