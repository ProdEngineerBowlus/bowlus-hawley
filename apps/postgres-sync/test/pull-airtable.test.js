// Airtable pull selection: app-owned tables are never refreshed by accident, extra tables exclude what Hawley already
// mirrors, and the dry-run diff counts new, changed and removed records.
import test from "node:test";
import assert from "node:assert/strict";
import { diffRecords, extraTables, parseArgs, selectTables } from "../src/pull-airtable.js";

test("default and selective pulls skip or refuse tables the app owns", () => {
  const all = selectTables(parseArgs([]), {});
  assert.deepEqual(all.skipped, ["Task Instances Rev1", "Work Force", "Worker Daily Task Actuals"]);
  assert.ok(!all.selected.some(table => table.appOwned));
  assert.ok(all.selected.some(table => table.sourceName === "CNC Parts Master"));

  const cnc = selectTables(parseArgs(["--tables", "CNC Parts Master,CNC Sheets", "--extra"]), {});
  assert.deepEqual(cnc.selected.map(table => table.sourceName), ["CNC Parts Master", "CNC Sheets"]);

  assert.throws(() => selectTables(parseArgs(["--tables=Work Force"]), {}), /app owns this data/);
  assert.throws(() => selectTables(parseArgs(["--tables=Nope"]), {}), /Not a configured Airtable table/);
  assert.equal(selectTables(parseArgs(["--allow-app-owned"]), {}).selected.length, 11);
  assert.throws(() => parseArgs(["--everything"]), /Unknown option/);
});

test("extra tables are the ones Hawley doesn't mirror and that aren't retired", () => {
  const { configured } = selectTables(parseArgs([]), {});
  const schema = { tables: [{ id: "t1", name: "CNC Parts Master" }, { id: "t2", name: "Engineering Changes" }, { id: "t3", name: "Worker Cycle Bank Rev1" }, { id: "t4", name: "Suppliers" }] };
  assert.deepEqual(extraTables(schema, configured).map(table => table.name), ["Engineering Changes", "Suppliers"]);
});

test("diff counts new, changed and removed records, ignoring key order", () => {
  const current = [
    { record_id: "a", fields_json: { Name: "A", Qty: 1 } },
    { record_id: "b", fields_json: { Qty: 2, Name: "B" } },
    { record_id: "c", fields_json: { Name: "C" } }
  ];
  const incoming = [
    { id: "a", fields: { Qty: 1, Name: "A" } },
    { id: "b", fields: { Name: "B", Qty: 3 } },
    { id: "d", fields: { Name: "D" } }
  ];
  assert.deepEqual(diffRecords(current, incoming), { airtable: 3, hawley: 3, added: 1, changed: 1, removed: 1 });
});
