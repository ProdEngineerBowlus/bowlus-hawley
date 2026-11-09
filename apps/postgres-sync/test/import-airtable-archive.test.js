// Airtable archive import: field ids become names, and secret tables/fields never reach Postgres.
import test from "node:test";
import assert from "node:assert/strict";
import { namedFields, planTables } from "../../../scripts/import-airtable-archive.mjs";

test("archive plan skips secret tables and drops secret fields", () => {
  const schema = fields => JSON.stringify({ fields: fields.map(([id, name]) => ({ id, name })) });
  const plan = planTables([
    { base_id: "app1", table_id: "tblEnv", name: "ENV Table", schema_json: schema([["fT", "Token"]]) },
    { base_id: "app2", table_id: "tblSn", name: "Serial Numbers & Deviations ", schema_json: schema([["fA", "Serial"], ["fP", "Information & Passwords"]]) },
    { base_id: "app1", table_id: "tblEco", name: "Engineering Changes", schema_json: schema([["fD", "Change Description"]]) }
  ]);
  assert.deepEqual(plan.map(t => t.excluded), [true, false, false]);
  const serial = plan[1];
  assert.deepEqual(serial.safeSchema.fields.map(f => f.name), ["Serial"]);
  assert.deepEqual(namedFields(JSON.stringify({ fA: "SN-1", fP: "hunter2", fX: 1 }), serial.fieldNames, serial.dropped), { Serial: "SN-1", fX: 1 });
  assert.deepEqual(namedFields(JSON.stringify({ fD: "Bigger radius" }), plan[2].fieldNames, plan[2].dropped), { "Change Description": "Bigger radius" });
});
