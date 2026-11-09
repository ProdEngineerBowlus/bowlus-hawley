// Loads a full Airtable export (the recovery SQLite: source_tables + source_records) into Hawley so nothing is lost when
// Airtable is cancelled. Every table of every base goes into raw.airtable_records (migration 056), keyed by Airtable
// table and record id, with field ids turned into field names like the API mirrors use; each table's schema goes into
// raw.airtable_schema_tables. Nothing in the HB build reads raw.airtable_records, so this never overwrites live Hawley
// data, and live mirrors (raw.airtable_cnc_parts_master, …) are not touched. A newer export replaces older rows.
//
// Secrets stay out: tables listed in EXCLUDED_TABLES are skipped, and fields in EXCLUDED_FIELDS are dropped.
//
//   node scripts/hawley-db.mjs admin -- node scripts/import-airtable-archive.mjs <records-only.sqlite> <captured-at ISO> [--dry-run]
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { getDatabaseConfig } from "../apps/postgres-sync/src/config.js";

export const EXCLUDED_TABLES = Object.freeze(["ENV Table"]);
export const EXCLUDED_FIELDS = Object.freeze({ "Serial Numbers & Deviations": ["Information & Passwords"] });

export function readExport(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const tables = db.prepare("select base_id, table_id, name, schema_json from source_tables order by base_id, name").all();
  const records = db.prepare("select base_id, table_id, record_id, created_time, fields_json from source_records");
  return { db, tables, records };
}

// Field-id keys -> field names, minus excluded fields. Unknown ids keep their id so nothing is silently dropped.
export function namedFields(fieldsJson, fieldNames, dropped) {
  const out = {};
  for (const [key, value] of Object.entries(JSON.parse(fieldsJson || "{}"))) {
    const name = fieldNames.get(key) || key;
    if (dropped.has(name)) continue;
    out[name] = value;
  }
  return out;
}

export function planTables(tables) {
  return tables.map(table => {
    const schema = JSON.parse(table.schema_json || "{}");
    const fieldNames = new Map((schema.fields || []).map(field => [field.id, field.name]));
    const dropped = new Set(EXCLUDED_FIELDS[table.name.trim()] || []);
    const excluded = EXCLUDED_TABLES.includes(table.name.trim());
    const safeSchema = { ...schema, base_id: table.base_id, fields: (schema.fields || []).filter(field => !dropped.has(field.name)) };
    return { ...table, fieldNames, dropped, excluded, safeSchema };
  });
}

async function main() {
  const [file, capturedAt, flag] = process.argv.slice(2);
  if (!file || !capturedAt || Number.isNaN(Date.parse(capturedAt))) {
    console.error("Usage: import-airtable-archive.mjs <records-only.sqlite> <captured-at ISO> [--dry-run]");
    process.exitCode = 1;
    return;
  }
  const dryRun = flag === "--dry-run";
  const { db, tables, records } = readExport(file);
  const plan = new Map(planTables(tables).map(table => [table.table_id, table]));
  const client = new pg.Client(getDatabaseConfig({ useSyncUrl: true }));
  await client.connect();
  const counts = { tables: 0, records: 0, skippedTables: [], droppedFields: [], skippedRecords: 0 };
  try {
    await client.query("begin");
    for (const table of plan.values()) {
      if (table.excluded) { counts.skippedTables.push(`${table.base_id} | ${table.name}`); continue; }
      if (table.dropped.size) counts.droppedFields.push(`${table.name}: ${[...table.dropped].join(", ")}`);
      counts.tables += 1;
      await client.query(
        `insert into raw.airtable_schema_tables (table_id, table_name, primary_field_id, raw_json, synced_at)
         values ($1, $2, $3, $4::jsonb, $5)
         on conflict (table_id) do nothing`,
        [table.table_id, table.name, table.safeSchema.primaryFieldId || null, JSON.stringify({ ...table.safeSchema, archived_from: "airtable export" }), capturedAt]
      );
    }
    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      await client.query(
        `insert into raw.airtable_records (table_id, table_name, record_id, fields_json, airtable_created_at, synced_at)
         select r.table_id, r.table_name, r.record_id, r.fields, r.created, $2::timestamptz
           from jsonb_to_recordset($1::jsonb) as r(table_id text, table_name text, record_id text, fields jsonb, created timestamptz)
         on conflict (table_id, record_id) do update set
           table_name = excluded.table_name, fields_json = excluded.fields_json,
           airtable_created_at = excluded.airtable_created_at, synced_at = excluded.synced_at
         where raw.airtable_records.synced_at < excluded.synced_at`,
        [JSON.stringify(batch), capturedAt]
      );
      batch = [];
    };
    for (const row of records.iterate()) {
      const table = plan.get(row.table_id);
      if (!table || table.excluded) { counts.skippedRecords += 1; continue; }
      batch.push({ table_id: row.table_id, table_name: table.name, record_id: row.record_id, fields: namedFields(row.fields_json, table.fieldNames, table.dropped), created: row.created_time || null });
      counts.records += 1;
      if (batch.length >= 500) await flush();
    }
    await flush();
    const stored = (await client.query("select count(*)::int n, count(distinct table_id)::int t from raw.airtable_records")).rows[0];
    await client.query(dryRun ? "rollback" : "commit");
    console.log(JSON.stringify({ ok: true, dryRun, ...counts, storedAfter: stored }));
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    await client.end();
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
