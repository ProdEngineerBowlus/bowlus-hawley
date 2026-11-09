import { pathToFileURL } from "node:url";
import pg from "pg";
import { getDatabaseConfig } from "./config.js";

const { Client } = pg;

const AIRTABLE_API_BASE = "https://api.airtable.com/v0";

const TABLES = Object.freeze([
  {
    envKey: "HAWLEY_AIRTABLE_TASK_INSTANCES_TABLE",
    sourceName: "Task Instances Rev1",
    appOwned: true,
    targetTable: "raw.airtable_task_instances"
  },
  {
    envKey: "HAWLEY_AIRTABLE_TASKS_TABLE",
    sourceName: "Tasks",
    targetTable: "raw.airtable_tasks"
  },
  {
    envKey: "HAWLEY_AIRTABLE_PRODUCTION_TABLE",
    sourceName: "Production",
    targetTable: "raw.airtable_production"
  },
  {
    envKey: "HAWLEY_AIRTABLE_VINS_TABLE",
    sourceName: "VINs",
    targetTable: "raw.airtable_vins"
  },
  {
    envKey: "HAWLEY_AIRTABLE_MODELS_TABLE",
    sourceName: "Models",
    targetTable: "raw.airtable_models"
  },
  {
    envKey: "HAWLEY_AIRTABLE_CYCLES_TABLE",
    sourceName: "Cycles",
    targetTable: "raw.airtable_cycles"
  },
  {
    envKey: "HAWLEY_AIRTABLE_WORK_FORCE_TABLE",
    sourceName: "Work Force",
    appOwned: true,
    targetTable: "raw.airtable_work_force"
  },
  {
    envKey: "HAWLEY_AIRTABLE_PHASES_TABLE",
    sourceName: "Phases",
    targetTable: "raw.airtable_phases"
  },
  {
    envKey: "HAWLEY_AIRTABLE_WORKER_DAILY_ACTUALS_TABLE",
    sourceName: "Worker Daily Task Actuals",
    appOwned: true,
    targetTable: "raw.airtable_worker_daily_actuals"
  },
  {
    envKey: "HAWLEY_AIRTABLE_CNC_PARTS_MASTER_TABLE",
    sourceName: "CNC Parts Master",
    targetTable: "raw.airtable_cnc_parts_master"
  },
  {
    envKey: "HAWLEY_AIRTABLE_CNC_SHEETS_TABLE",
    sourceName: "CNC Sheets",
    targetTable: "raw.airtable_cnc_sheets"
  }
]);

// Airtable tables that already have a raw.airtable_* table but were retired from pulls (Rev1 capacity, 2026-10-29).
const RETIRED_SOURCES = Object.freeze(["Phase Cycle Load Rev1", "Worker Cycle Bank Rev1", "Worker Phase Allocation Rev1"]);

// Usage: pull-airtable.js [--tables "CNC Parts Master,CNC Sheets"] [--extra] [--dry-run] [--allow-app-owned]
//   --tables           only these configured tables (default: all configured tables)
//   --extra            also mirror every other table in the base into raw.airtable_records (Engineering Changes, ...)
//   --dry-run          fetch and compare with what Hawley holds; write nothing
//   --allow-app-owned  include tables whose Hawley data the app now owns (Work Force, Task Instances, Worker Daily
//                      Task Actuals). Without it they are skipped, so a refresh can't overwrite live app data with
//                      Airtable's. Only fresh-database bootstraps pass it.
export function parseArgs(argv) {
  const options = { tables: null, extra: false, dryRun: false, allowAppOwned: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--extra") options.extra = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--allow-app-owned") options.allowAppOwned = true;
    else if (arg === "--tables") options.tables = String(argv[++i] || "").split(",").map(name => name.trim()).filter(Boolean);
    else if (arg.startsWith("--tables=")) options.tables = arg.slice(9).split(",").map(name => name.trim()).filter(Boolean);
    else throw new Error(`Unknown option ${arg}`);
  }
  return options;
}

export function selectTables(options, env = process.env) {
  const configured = TABLES.map(table => ({ ...table, sourceName: env[table.envKey] || table.sourceName }));
  let selected = configured;
  if (options.tables) {
    const unknown = options.tables.filter(name => !configured.some(table => table.sourceName === name));
    if (unknown.length) throw new Error(`Not a configured Airtable table: ${unknown.join(", ")}`);
    selected = configured.filter(table => options.tables.includes(table.sourceName));
  }
  const blocked = selected.filter(table => table.appOwned && !options.allowAppOwned);
  if (blocked.length && options.tables) {
    throw new Error(`${blocked.map(table => table.sourceName).join(", ")}: Hawley's app owns this data now; refreshing from Airtable would overwrite it. Pass --allow-app-owned only for a fresh-database bootstrap.`);
  }
  return { selected: selected.filter(table => !table.appOwned || options.allowAppOwned), skipped: blocked.map(table => table.sourceName), configured };
}

export function extraTables(schema, configured) {
  const known = new Set([...configured.map(table => table.sourceName), ...RETIRED_SOURCES]);
  return (schema.tables || []).filter(table => !known.has(table.name));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

export function diffRecords(currentRows, records) {
  const current = new Map(currentRows.map(row => [row.record_id, stableJson(row.fields_json)]));
  const incoming = new Set();
  let added = 0;
  let changed = 0;
  for (const record of records) {
    incoming.add(record.id);
    const before = current.get(record.id);
    if (before === undefined) added += 1;
    else if (before !== stableJson(record.fields || {})) changed += 1;
  }
  const removed = [...current.keys()].filter(id => !incoming.has(id)).length;
  return { airtable: records.length, hawley: current.size, added, changed, removed };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}.`);
  return value;
}

function airtableTableUrl(baseId, tableName, offset = "") {
  const url = new URL(`${AIRTABLE_API_BASE}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableName)}`);
  url.searchParams.set("pageSize", "100");
  if (offset) url.searchParams.set("offset", offset);
  return url;
}

async function airtableRequest(url, token) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Airtable request failed ${response.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

async function fetchAllAirtableRecords({ baseId, token, tableName }) {
  const records = [];
  let offset = "";

  do {
    const payload = await airtableRequest(airtableTableUrl(baseId, tableName, offset), token);
    records.push(...(payload.records || []));
    offset = payload.offset || "";
  } while (offset);

  return records;
}

async function fetchAirtableSchema({ baseId, token }) {
  const url = `${AIRTABLE_API_BASE}/meta/bases/${encodeURIComponent(baseId)}/tables`;
  return airtableRequest(url, token);
}

function modifiedAtFromFields(fields) {
  for (const key of ["Last Modified", "Last Modified Time", "Last Modified At", "Updated At", "Modified At"]) {
    if (fields[key]) return fields[key];
  }
  return null;
}

async function upsertRawRecords(client, table, records, sourceTableName) {
  const [schemaName, tableName] = table.split(".");
  const fullTable = `"${schemaName}"."${tableName}"`;

  for (const record of records) {
    await client.query(
      `
        insert into ${fullTable}
          (record_id, fields_json, airtable_created_at, modified_at, source_table_name, synced_at)
        values
          ($1, $2::jsonb, $3, $4, $5, now())
        on conflict (record_id) do update set
          fields_json = excluded.fields_json,
          airtable_created_at = excluded.airtable_created_at,
          modified_at = excluded.modified_at,
          source_table_name = excluded.source_table_name,
          synced_at = now()
      `,
      [
        record.id,
        JSON.stringify(record.fields || {}),
        record.createdTime || null,
        modifiedAtFromFields(record.fields || {}),
        sourceTableName
      ]
    );
  }

  const ids = records.map(record => record.id);
  if (ids.length) {
    await client.query(`delete from ${fullTable} where not (record_id = any($1::text[]))`, [ids]);
  }
}

async function upsertGenericRecords(client, table, records) {
  for (let i = 0; i < records.length; i += 200) {
    const batch = records.slice(i, i + 200);
    await client.query(
      `
        insert into raw.airtable_records (table_id, table_name, record_id, fields_json, airtable_created_at, synced_at)
        select $1, $2, r.id, r.fields, r.created, now()
          from jsonb_to_recordset($3::jsonb) as r(id text, fields jsonb, created timestamptz)
        on conflict (table_id, record_id) do update set
          table_name = excluded.table_name,
          fields_json = excluded.fields_json,
          airtable_created_at = excluded.airtable_created_at,
          synced_at = now()
      `,
      [table.id, table.name, JSON.stringify(batch.map(record => ({ id: record.id, fields: record.fields || {}, created: record.createdTime || null })))]
    );
  }
  await client.query("delete from raw.airtable_records where table_id = $1 and not (record_id = any($2::text[]))", [table.id, records.map(record => record.id)]);
}

async function upsertSchemaCatalog(client, schema, tableNames) {
  const wanted = new Set(tableNames);
  const tables = (schema.tables || []).filter(table => wanted.has(table.name));

  for (const table of tables) {
    await client.query(
      `
        insert into raw.airtable_schema_tables
          (table_id, table_name, primary_field_id, raw_json, synced_at)
        values
          ($1, $2, $3, $4::jsonb, now())
        on conflict (table_id) do update set
          table_name = excluded.table_name,
          primary_field_id = excluded.primary_field_id,
          raw_json = excluded.raw_json,
          synced_at = now()
      `,
      [
        table.id,
        table.name,
        table.primaryFieldId || null,
        JSON.stringify(table)
      ]
    );

    for (const field of table.fields || []) {
      await client.query(
        `
          insert into raw.airtable_schema_fields
            (table_id, field_id, table_name, field_name, field_type, field_description, raw_json, synced_at)
          values
            ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
          on conflict (table_id, field_id) do update set
            table_name = excluded.table_name,
            field_name = excluded.field_name,
            field_type = excluded.field_type,
            field_description = excluded.field_description,
            raw_json = excluded.raw_json,
            synced_at = now()
        `,
        [
          table.id,
          field.id,
          table.name,
          field.name,
          field.type || null,
          field.description || null,
          JSON.stringify(field)
        ]
      );
    }

    await client.query(
      "delete from raw.airtable_schema_fields where table_id = $1 and not (field_id = any($2::text[]))",
      [table.id, (table.fields || []).map(field => field.id)]
    );
  }

  await client.query(
    "delete from raw.airtable_schema_tables where table_name = any($1::text[]) and not (table_name = any($2::text[]))",
    [Array.from(wanted), tables.map(table => table.name)]
  );

  return tables;
}

async function startRun(client, jobName = "pull_airtable", mode = "live-readonly") {
  const result = await client.query(
    `
      insert into sync.run_log (job_name, mode, status)
      values ($1, $2, 'running')
      returning id
    `,
    [jobName, mode]
  );
  return result.rows[0].id;
}

async function finishRun(client, id, status, summary) {
  await client.query(
    `
      update sync.run_log
      set status = $2,
          ended_at = now(),
          records_read = $3,
          records_written = $4,
          error_count = $5,
          summary = $6::jsonb
      where id = $1
    `,
    [
      id,
      status,
      summary.recordsRead || 0,
      summary.recordsWritten || 0,
      summary.errorCount || 0,
      JSON.stringify(summary)
    ]
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const baseId = requiredEnv("AIRTABLE_BASE");
  const token = requiredEnv("AIRTABLE_PAT");
  const { selected, skipped, configured } = selectTables(options);
  const client = new Client(getDatabaseConfig({ useSyncUrl: true }));
  await client.connect();

  const selective = Boolean(options.tables || options.extra || !options.allowAppOwned);
  const runId = options.dryRun ? null : await startRun(client, selective ? "pull_airtable_reference" : "pull_airtable");
  const summary = {
    dryRun: options.dryRun,
    tables: {},
    extraTables: {},
    skippedAppOwned: skipped,
    recordsRead: 0,
    recordsWritten: 0,
    errorCount: 0
  };

  try {
    const schema = await fetchAirtableSchema({ baseId, token });
    const extras = options.extra ? extraTables(schema, configured) : [];
    if (!options.dryRun) {
      const schemaTables = await upsertSchemaCatalog(client, schema, [...selected.map(table => table.sourceName), ...extras.map(table => table.name)]);
      summary.schemaTables = Object.fromEntries(schemaTables.map(table => [table.name, { fields: (table.fields || []).length }]));
    }

    for (const tableConfig of selected) {
      const records = await fetchAllAirtableRecords({ baseId, token, tableName: tableConfig.sourceName });
      const current = (await client.query(`select record_id, fields_json from ${tableConfig.targetTable}`)).rows;
      const diff = diffRecords(current, records);
      if (!options.dryRun) await upsertRawRecords(client, tableConfig.targetTable, records, tableConfig.sourceName);
      summary.tables[tableConfig.sourceName] = { targetTable: tableConfig.targetTable, ...diff };
      summary.recordsRead += records.length;
      if (!options.dryRun) summary.recordsWritten += records.length;
      console.log(`${tableConfig.sourceName}: ${records.length} record(s), ${diff.added} new, ${diff.changed} changed, ${diff.removed} removed${options.dryRun ? " (dry run)" : ` -> ${tableConfig.targetTable}`}`);
    }

    for (const table of extras) {
      const records = await fetchAllAirtableRecords({ baseId, token, tableName: table.id });
      const current = (await client.query("select record_id, fields_json from raw.airtable_records where table_id = $1", [table.id])).rows;
      const diff = diffRecords(current, records);
      if (!options.dryRun) await upsertGenericRecords(client, table, records);
      summary.extraTables[table.name] = { tableId: table.id, ...diff };
      summary.recordsRead += records.length;
      if (!options.dryRun) summary.recordsWritten += records.length;
      console.log(`${table.name}: ${records.length} record(s), ${diff.added} new, ${diff.changed} changed${options.dryRun ? " (dry run)" : " -> raw.airtable_records"}`);
    }

    if (runId) await finishRun(client, runId, "success", summary);
    console.log(`HAWLEY_PULL_SUMMARY ${JSON.stringify(summary)}`);
  } catch (error) {
    summary.errorCount += 1;
    summary.errorMessage = error.message;
    if (runId) {
      await client.query(
        `
          insert into sync.errors (run_log_id, source_system, error_type, error_message)
          values ($1, 'airtable', 'pull_airtable', $2)
        `,
        [runId, error.message]
      );
      await finishRun(client, runId, "failed", summary);
    }
    console.log(`HAWLEY_PULL_SUMMARY ${JSON.stringify(summary)}`);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
