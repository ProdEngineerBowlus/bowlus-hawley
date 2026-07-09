import pg from "pg";
import { getDatabaseConfig } from "./config.js";

const { Client } = pg;

const AIRTABLE_API_BASE = "https://api.airtable.com/v0";
const DEFAULT_INTERVAL_MS = 60000;
const DEFAULT_WINDOW_DAYS = 14;
const DEFAULT_FUTURE_DAYS = 2;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}.`);
  return value;
}

function parseArgs(argv) {
  const args = {
    loop: false,
    intervalMs: Number(process.env.HAWLEY_WORKER_ACTUALS_INTERVAL_MS || DEFAULT_INTERVAL_MS),
    windowDays: Number(process.env.HAWLEY_WORKER_ACTUALS_WINDOW_DAYS || DEFAULT_WINDOW_DAYS),
    futureDays: Number(process.env.HAWLEY_WORKER_ACTUALS_FUTURE_DAYS || DEFAULT_FUTURE_DAYS),
    all: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--loop") args.loop = true;
    else if (arg === "--interval-ms") args.intervalMs = Number(argv[++index] || args.intervalMs);
    else if (arg.startsWith("--interval-ms=")) args.intervalMs = Number(arg.slice("--interval-ms=".length));
    else if (arg === "--window-days") args.windowDays = Number(argv[++index] || args.windowDays);
    else if (arg.startsWith("--window-days=")) args.windowDays = Number(arg.slice("--window-days=".length));
    else if (arg === "--future-days") args.futureDays = Number(argv[++index] || args.futureDays);
    else if (arg.startsWith("--future-days=")) args.futureDays = Number(arg.slice("--future-days=".length));
    else if (arg === "--all") args.all = true;
    else if (arg === "-h" || arg === "--help") {
      console.log([
        "Usage: npm run pg:pull:worker-actuals -- [options]",
        "",
        "Options:",
        "  --loop              Poll continuously.",
        "  --interval-ms N     Loop interval. Default 60000.",
        "  --window-days N     Pull Work Date from today-N through future window. Default 14.",
        "  --future-days N     Pull Work Date through today+N. Default 2.",
        "  --all               Pull the whole Worker Daily Task Actuals table."
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.intervalMs) || args.intervalMs < 15000) {
    throw new Error("--interval-ms must be at least 15000.");
  }
  if (!Number.isFinite(args.windowDays) || args.windowDays < 0) {
    throw new Error("--window-days must be a non-negative number.");
  }
  if (!Number.isFinite(args.futureDays) || args.futureDays < 0) {
    throw new Error("--future-days must be a non-negative number.");
  }

  return args;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function firstValue(value) {
  const values = toArray(value);
  return values.length ? values[0] : null;
}

function displayText(value) {
  const first = firstValue(value);
  if (first === null || first === undefined) return "";
  if (typeof first === "string") return first.trim();
  if (typeof first === "number" || typeof first === "boolean") return String(first);
  if (typeof first === "object") return String(first.name || first.email || first.value || first.id || "").trim();
  return String(first).trim();
}

function text(value) {
  const result = displayText(value);
  return result || null;
}

function numberValue(value, fallback = null) {
  const raw = firstValue(value);
  if (raw === null || raw === undefined || raw === "") return fallback;
  if (typeof raw === "object") return numberValue(raw.value ?? raw.name ?? raw.id, fallback);
  const parsed = Number(String(raw).replace(/[^0-9.\-]+/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function integerValue(value, fallback = null) {
  const parsed = numberValue(value, fallback);
  return parsed === null || parsed === undefined ? fallback : Math.trunc(parsed);
}

function booleanValue(value) {
  const raw = firstValue(value);
  if (raw === true) return true;
  if (raw === false || raw === null || raw === undefined || raw === "") return false;
  if (typeof raw === "number") return raw !== 0;
  const normalized = String(raw).trim().toLowerCase();
  return ["true", "1", "yes", "y", "checked", "complete", "completed"].includes(normalized);
}

function dateValue(value) {
  const raw = firstValue(value);
  if (!raw) return null;
  if (typeof raw === "object") return dateValue(raw.value ?? raw.name ?? raw.date);
  const normalized = String(raw).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(normalized) ? normalized.slice(0, 10) : null;
}

function timestampValue(value) {
  const raw = firstValue(value);
  if (!raw) return null;
  if (typeof raw === "object") return timestampValue(raw.value ?? raw.name ?? raw.date);
  const normalized = String(raw).trim();
  return normalized ? normalized : null;
}

function addUtcDays(date, days) {
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function airtableFormulaString(value) {
  return String(value).replace(/'/g, "\\'");
}

function workDateWindow(args) {
  const today = new Date();
  const start = isoDate(addUtcDays(today, -args.windowDays));
  const end = isoDate(addUtcDays(today, args.futureDays));
  return { start, end };
}

function workDateFormula({ start, end }) {
  const safeStart = airtableFormulaString(start);
  const safeEnd = airtableFormulaString(end);
  return [
    "AND(",
    "{Work Date},",
    `OR(IS_SAME({Work Date}, '${safeStart}', 'day'), IS_AFTER({Work Date}, '${safeStart}')),`,
    `OR(IS_SAME({Work Date}, '${safeEnd}', 'day'), IS_BEFORE({Work Date}, '${safeEnd}'))`,
    ")"
  ].join("");
}

function airtableTableUrl(baseId, tableName, offset = "", formula = "") {
  const url = new URL(`${AIRTABLE_API_BASE}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableName)}`);
  url.searchParams.set("pageSize", "100");
  if (formula) url.searchParams.set("filterByFormula", formula);
  if (offset) url.searchParams.set("offset", offset);
  return url;
}

async function airtableRequest(url, token) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Airtable request failed ${response.status}: ${body.slice(0, 500)}`);
  }
  return JSON.parse(body);
}

async function fetchAirtableRecords({ baseId, token, tableName, formula }) {
  const records = [];
  let offset = "";

  do {
    const payload = await airtableRequest(airtableTableUrl(baseId, tableName, offset, formula), token);
    records.push(...(payload.records || []));
    offset = payload.offset || "";
  } while (offset);

  return records;
}

function modifiedAtFromFields(fields) {
  for (const key of ["Last Modified", "Last Modified Time", "Last Modified At", "Updated At", "Modified At", "Last Seen At"]) {
    if (fields[key]) return fields[key];
  }
  return null;
}

async function upsertRawRecords(client, records, sourceTableName) {
  for (const record of records) {
    await client.query(
      `
        insert into raw.airtable_worker_daily_actuals
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
}

function actualsRow(record, syncedAt) {
  const fields = record.fields || {};
  return {
    airtable_record_id: record.id,
    ledger_key: text(fields["Ledger Key"]),
    work_date: dateValue(fields["Work Date"]),
    worker_key: text(fields["Worker Key"]),
    worker_name: text(fields["Worker Name"]),
    worker_email: text(fields["Worker Email"]),
    asana_task_gid: text(fields["Asana Task GID"]),
    task_name: text(fields["Task Name"]),
    task_url: text(fields["Task URL"]),
    vin: text(fields.VIN),
    cycle_label: text(fields.Cycle),
    phase_label: text(fields.Phase),
    assigned_hours: numberValue(fields["Assigned Hours"]),
    allocated_hours: numberValue(fields["Allocated Hours"]),
    actual_minutes: integerValue(fields["Actual Minutes"]),
    timer_minutes: integerValue(fields["Timer Minutes"]),
    asana_posted_minutes: integerValue(fields["Asana Posted Minutes"]),
    source_label: text(fields.Source),
    was_assigned_in_dat: booleanValue(fields["Was Assigned In DAT?"]),
    was_recovered: booleanValue(fields["Was Recovered?"]),
    completed: booleanValue(fields["Completed?"]),
    last_seen_at: timestampValue(fields["Last Seen At"]),
    notes: text(fields.Notes),
    daily_summary: booleanValue(fields["Daily Summary?"]),
    daily_available_minutes: integerValue(fields["Daily Available Minutes"]),
    daily_logged_minutes: integerValue(fields["Daily Logged Minutes"]),
    daily_efficiency_percent: numberValue(fields["Daily Efficiency Percent"]),
    daily_efficiency_under_75: booleanValue(fields["Daily Efficiency Under 75?"]),
    efficiency_snapshot_at: timestampValue(fields["Efficiency Snapshot At"]),
    review_month: text(fields["Review Month"]),
    review_year: integerValue(fields["Review Year"]),
    fields_json: JSON.stringify(fields),
    source_system: "airtable_worker_actuals_fast_pull",
    source_synced_at: syncedAt
  };
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function upsertHbRows(client, rows) {
  if (!rows.length) return;

  const columns = Object.keys(rows[0]);
  const updates = columns
    .filter(column => column !== "ledger_key")
    .map(column => `${quoteIdent(column)} = excluded.${quoteIdent(column)}`);

  for (const row of rows) {
    await client.query(
      `
        insert into hb.worker_daily_task_actuals
          (${columns.map(quoteIdent).join(", ")})
        values
          (${columns.map((_, index) => `$${index + 1}`).join(", ")})
        on conflict (ledger_key) do update set
          ${updates.join(", ")}
      `,
      columns.map(column => row[column])
    );
  }
}

async function startRun(client, summary) {
  const result = await client.query(
    `
      insert into sync.run_log (job_name, mode, status, summary)
      values ('pull_worker_daily_actuals', $1, 'running', $2::jsonb)
      returning id
    `,
    [summary.mode, JSON.stringify(summary)]
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

async function runOnce(args) {
  const baseId = requiredEnv("AIRTABLE_BASE");
  const token = requiredEnv("AIRTABLE_PAT");
  const sourceName = process.env.HAWLEY_AIRTABLE_WORKER_DAILY_ACTUALS_TABLE || "Worker Daily Task Actuals";
  const window = workDateWindow(args);
  const formula = args.all ? "" : workDateFormula(window);
  const syncedAt = new Date().toISOString();
  const summary = {
    mode: args.all ? "live-readonly-all" : "live-readonly-window",
    table: sourceName,
    targetTables: ["raw.airtable_worker_daily_actuals", "hb.worker_daily_task_actuals"],
    dateWindow: args.all ? null : window,
    recordsRead: 0,
    recordsWritten: 0,
    errorCount: 0
  };

  const client = new Client(getDatabaseConfig({ useSyncUrl: true }));
  await client.connect();
  const runId = await startRun(client, summary);

  try {
    const records = await fetchAirtableRecords({ baseId, token, tableName: sourceName, formula });
    const actualRows = records.map(record => actualsRow(record, syncedAt)).filter(row => row.ledger_key);

    await client.query("begin");
    await upsertRawRecords(client, records, sourceName);
    await upsertHbRows(client, actualRows);
    await client.query("commit");

    summary.recordsRead = records.length;
    summary.recordsWritten = records.length + actualRows.length;
    summary.normalizedRows = actualRows.length;
    await finishRun(client, runId, "success", summary);
    console.log(`${sourceName}: ${records.length} record(s) refreshed into Worker Daily Task Actuals HB mirror.`);
    return summary;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    summary.errorCount += 1;
    summary.errorMessage = error.message;
    await client.query(
      `
        insert into sync.errors (run_log_id, source_system, error_type, error_message)
        values ($1, 'airtable', 'pull_worker_daily_actuals', $2)
      `,
      [runId, error.message]
    );
    await finishRun(client, runId, "failed", summary);
    throw error;
  } finally {
    await client.end();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  do {
    try {
      await runOnce(args);
    } catch (error) {
      console.error(error.message);
      if (!args.loop) throw error;
    }

    if (args.loop) await sleep(args.intervalMs);
  } while (args.loop);
}

main().catch(() => {
  process.exitCode = 1;
});
