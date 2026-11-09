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
  await db.exec(await sql("migrations/057_part_revision_numbers.sql"));
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

test("CNC Parts Desk requests: new revision, release from a VIN, edit rules, retire, and the requester in history", async () => {
  const { applyRequest, exportSnapshot } = await import("../../../scripts/cnc-parts-desk.mjs");
  const db = await database([["rec1", "01201A", "Bathroom Floor", false, ["sheetX"]]]);
  const run = async request => {
    await db.exec("begin");
    try {
      const summary = await applyRequest(db, { id: "r1", requestedByEmail: "erick@bowlus.com", change_reason: "test", ...request });
      await db.exec("commit");
      return summary;
    } catch (error) {
      await db.exec("rollback");
      throw error;
    }
  };

  assert.match(await run({ type: "new_revision", part_base: "01201", change_reason: "Thicker floor" }), /draft revision 01201B from 01201A/);
  const draft = (await rows(db, "select status, part_name, cnc_sheet_record_ids from parts.cnc_part_revisions where part_number = '01201B'"))[0];
  assert.deepEqual(draft, { status: "draft", part_name: "Bathroom Floor", cnc_sheet_record_ids: ["sheetX"] });

  assert.match(await run({ type: "edit", part_number: "01201B", material_name: "Flooring 1/2" }), /Updated draft/);
  await assert.rejects(run({ type: "edit", part_number: "01201A", material_name: "x" }), /Released revisions don't change/);
  await assert.rejects(run({ type: "release", part_number: "01201B" }), /needs the VIN/);
  await assert.rejects(run({ type: "new_revision", part_base: "01201", change_reason: "" }), /needs a reason/);

  assert.match(await run({ type: "release", part_number: "01201B", effective_from_vin: 340 }), /Released 01201B from VIN 340; 01201A superseded/);
  assert.deepEqual((await rows(db, "select part_number from parts.cnc_revisions_for_vin(339)")).map(r => r.part_number), ["01201A"]);
  assert.deepEqual((await rows(db, "select part_number from parts.cnc_revisions_for_vin(340)")).map(r => r.part_number), ["01201B"]);
  await run({ type: "new_revision", part_base: "01201" });
  await assert.rejects(run({ type: "release", part_number: "01201C", effective_from_vin: 340 }), /pick a later VIN/);

  assert.match(await run({ type: "new_part", part_base: "77001", part_name: "Test Bracket" }), /Created part 77001 with draft revision 77001A/);
  await assert.rejects(run({ type: "new_part", part_base: "77001", part_name: "Again" }), /already exists/);
  assert.match(await run({ type: "retire", part_number: "77001A" }), /Retired 77001A/);

  const actors = (await rows(db, "select distinct changed_by from parts.cnc_part_history where changed_by not like 'migration%'")).map(r => r.changed_by);
  assert.deepEqual(actors, ["erick@bowlus.com (CNC Parts Desk r1)"]);

  const snapshot = await exportSnapshot(db);
  const part = snapshot.parts.find(p => p.part_base === "01201");
  assert.deepEqual(part.revisions.map(r => [r.part_number, r.status, r.effective_from_vin]), [["01201A", "superseded", null], ["01201B", "released", 340], ["01201C", "draft", null]]);
  assert.ok(snapshot.history.length >= 8 && snapshot.history.every(h => !h.changed_by.startsWith("migration")));
});

async function databaseWithEcos(parts, ecos) {
  const db = new PGlite();
  await db.exec("create role bowlus_app; create role bowlus_sync; create role bowlus_readonly; create schema hb; create schema raw; create schema reporting;");
  await db.exec(await tableSql("029_task_template_parts_bom.sql", "hb.cnc_parts_master"));
  await db.exec(await sql("migrations/056_airtable_records.sql"));
  for (const [id, number, name, ecoIds = []] of parts) {
    await db.query("insert into hb.cnc_parts_master (part_record_id, part_number, part_name, engineering_change_record_ids) values ($1, $2, $3, $4)", [id, number, name, ecoIds]);
  }
  for (const [id, fields] of ecos) {
    await db.query("insert into raw.airtable_records (table_id, table_name, record_id, fields_json, airtable_created_at) values ('tblEco', 'Engineering Changes', $1, $2, '2025-01-01')", [id, JSON.stringify(fields)]);
  }
  await db.exec(await sql("migrations/055_cnc_part_revisions.sql"));
  await db.exec(await sql("migrations/057_part_revision_numbers.sql"));
  return db;
}

test("engineering changes seed from the Airtable archive, link to revisions and set the released revision's first VIN", async () => {
  const db = await databaseWithEcos(
    [["p1", "28317A", "Rivet Strip"], ["p2", "28317B", "Rivet Strip", ["eco2"]], ["p3", "40001A", "Bracket"]],
    [
      ["eco1", { "Change Description": "Wider strip", "New Part #": "28317b", "First Trailer (VIN)": "306", Date: "2025-06-11" }],
      ["eco2", { "Change Description": "Hole moved", "First Trailer (VIN)": "Rivet ?" }],
      ["eco3", { "Change Description": "Bracket radius", "Part Number": ["p3"], "New Part #": "40001A", "First Trailer (VIN)": "290" }]
    ]
  );
  const ecos = await rows(db, "select change_number, description, first_vin, first_vin_note, new_part_number, change_date::text from parts.engineering_changes order by eco_id");
  assert.deepEqual(ecos.map(e => [e.change_number, e.first_vin, e.first_vin_note, e.new_part_number]), [["PR-1", 306, "", "28317B"], ["PR-2", null, "Rivet ?", ""], ["PR-3", 290, "", "40001A"]]);
  const links = await rows(db, `select r.part_number, e.change_number, l.link_source from parts.cnc_part_revision_changes l
                                 join parts.cnc_part_revisions r using (revision_id) join parts.engineering_changes e using (eco_id) order by 1, 2`);
  assert.deepEqual(links.map(l => `${l.part_number} ${l.change_number}`), ["28317B PR-1", "28317B PR-2", "40001A PR-3"]);
  const eff = await rows(db, "select part_number, status, effective_from_vin from parts.cnc_part_revisions order by part_number");
  assert.deepEqual(eff.map(r => [r.part_number, r.status, r.effective_from_vin]), [["28317A", "superseded", null], ["28317B", "released", 306], ["40001A", "released", 290]]);
  assert.deepEqual((await rows(db, "select part_number from parts.cnc_revisions_for_vin(305) where part_base = '28317'")).map(r => r.part_number), ["28317A"]);
});

test("the desk records a new engineering change with a change, or links an existing one", async () => {
  const { applyRequest, exportSnapshot } = await import("../../../scripts/cnc-parts-desk.mjs");
  const db = await databaseWithEcos([["p1", "01201A", "Bathroom Floor"]], [["eco1", { "Change Description": "Old change" }]]);
  const run = async request => {
    await db.exec("begin");
    try { const out = await applyRequest(db, { id: "r9", requestedByEmail: "jacob@bowlus.com", change_reason: "Drain cut-out moved", ...request }); await db.exec("commit"); return out; }
    catch (error) { await db.exec("rollback"); throw error; }
  };
  assert.match(await run({ type: "new_revision", part_base: "01201", eco: "new" }), /Created draft revision 01201B.*Recorded as PR-2 \(new\) on 01201B/);
  assert.match(await run({ type: "release", part_number: "01201B", effective_from_vin: 340, eco: "PR-2" }), /Recorded as PR-2 on 01201B/);
  assert.match(await run({ type: "link_change", part_number: "01201A", eco: "1" }), /Linked to 01201A\. Recorded as PR-1/);
  await assert.rejects(run({ type: "link_change", part_number: "01201A", eco: "PR-99" }), /No Part Revision PR-99/);
  const eco = (await rows(db, "select description, new_part_number, created_by from parts.engineering_changes where eco_id = 2"))[0];
  assert.deepEqual(eco, { description: "Drain cut-out moved", new_part_number: "01201B", created_by: "jacob@bowlus.com" });

  const snap = await exportSnapshot(db);
  const b = snap.parts[0].revisions.find(r => r.part_number === "01201B");
  assert.deepEqual(b.eco_ids.map(Number), [2]);
  assert.deepEqual(snap.engineeringChanges.find(e => e.change_number === "PR-2").part_numbers, ["01201B"]);
  assert.deepEqual(snap.sheets, []);
});
