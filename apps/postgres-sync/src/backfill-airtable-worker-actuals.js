import pg from "pg";
import { getDatabaseConfig } from "./config.js";

const { Client } = pg;

const AIRTABLE_API_BASE = "https://api.airtable.com/v0";
const LIVE_WORKER_SOURCE = "hawley_worker_live_pilot";
const DEFAULT_WINDOW_DAYS = 2;
const DEFAULT_TIME_ZONE = "America/Los_Angeles";
const JOB_NAME = "backfill_airtable_worker_actuals";
const WORKER_DAILY_ACTUALS_WRITABLE_FIELDS = new Set([
  "Ledger Key",
  "Work Date",
  "Worker Key",
  "Worker Name",
  "Worker Email",
  "Asana Task GID",
  "Task Name",
  "Task URL",
  "VIN",
  "Cycle",
  "Phase",
  "Assigned Hours",
  "Allocated Hours",
  "Actual Minutes",
  "Timer Minutes",
  "Asana Posted Minutes",
  "Source",
  "Completed?",
  "Last Seen At",
  "Was Assigned In DAT?"
]);

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}.`);
  return value;
}

function booleanEnv(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  return ["1", "true", "yes", "y", "on"].includes(String(value).trim().toLowerCase());
}

function parseArgs(argv) {
  const args = {
    apply: false,
    date: "",
    startDate: "",
    endDate: "",
    windowDays: Number(process.env.HAWLEY_AIRTABLE_BACKFILL_WINDOW_DAYS || DEFAULT_WINDOW_DAYS)
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--date") args.date = argv[++index] || "";
    else if (arg.startsWith("--date=")) args.date = arg.slice("--date=".length);
    else if (arg === "--start-date") args.startDate = argv[++index] || "";
    else if (arg.startsWith("--start-date=")) args.startDate = arg.slice("--start-date=".length);
    else if (arg === "--end-date") args.endDate = argv[++index] || "";
    else if (arg.startsWith("--end-date=")) args.endDate = arg.slice("--end-date=".length);
    else if (arg === "--window-days") args.windowDays = Number(argv[++index] || args.windowDays);
    else if (arg.startsWith("--window-days=")) args.windowDays = Number(arg.slice("--window-days=".length));
    else if (arg === "-h" || arg === "--help") {
      console.log([
        "Usage: npm run pg:backfill:airtable-worker-actuals -- [options]",
        "",
        "Backfills Hawley live worker actual rows from Postgres into Airtable.",
        "This script is dry-run by default. To write, pass --apply and set:",
        "  HAWLEY_ALLOW_SOURCE_WRITES=true",
        "  HAWLEY_DRY_RUN=false",
        "",
        "Options:",
        "  --apply              Write to Airtable when env safety gates also allow it.",
        "  --date YYYY-MM-DD    Backfill a single work date.",
        "  --start-date DATE    Backfill from this work date.",
        "  --end-date DATE      Backfill through this work date.",
        "  --window-days N      Default rolling date window. Default 2."
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.windowDays) || args.windowDays < 1) {
    throw new Error("--window-days must be at least 1.");
  }

  return args;
}

function assertIsoDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) {
    throw new Error(`${label} must be YYYY-MM-DD.`);
  }
  return value;
}

function todayInTimeZone(timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateWindow(args) {
  if (args.date) {
    const date = assertIsoDate(args.date, "--date");
    return { startDate: date, endDate: date };
  }

  if (args.startDate || args.endDate) {
    const startDate = assertIsoDate(args.startDate, "--start-date");
    const endDate = assertIsoDate(args.endDate, "--end-date");
    if (startDate > endDate) throw new Error("--start-date must be before --end-date.");
    return { startDate, endDate };
  }

  const endDate = todayInTimeZone(process.env.HAWLEY_NIGHTLY_REFRESH_TIME_ZONE || DEFAULT_TIME_ZONE);
  const startDate = addDays(endDate, -(Math.trunc(args.windowDays) - 1));
  return { startDate, endDate };
}

function canWrite(args) {
  return Boolean(
    args.apply &&
    booleanEnv("HAWLEY_ALLOW_SOURCE_WRITES", false) &&
    !booleanEnv("HAWLEY_DRY_RUN", true)
  );
}

function airtableTableUrl(baseId, tableName) {
  const url = new URL(`${AIRTABLE_API_BASE}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableName)}`);
  url.searchParams.set("pageSize", "100");
  return url;
}

async function airtableRequest(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Airtable request failed ${response.status}: ${text.slice(0, 800)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function fetchExistingAirtableRows({ baseId, tableName, token }) {
  const records = [];
  let offset = "";

  do {
    const url = airtableTableUrl(baseId, tableName);
    if (offset) url.searchParams.set("offset", offset);
    const payload = await airtableRequest(url, token);
    records.push(...(payload.records || []));
    offset = payload.offset || "";
  } while (offset);

  return records;
}

function compactFields(fields) {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  );
}

function writableAirtableFields(fields) {
  return Object.fromEntries(
    Object.entries(compactFields(fields)).filter(([fieldName]) =>
      WORKER_DAILY_ACTUALS_WRITABLE_FIELDS.has(fieldName)
    )
  );
}

function rowLedgerKey(row) {
  return row.ledger_key || `${row.worker_key || ""}::${row.work_date || ""}::${row.asana_task_gid || ""}`;
}

function recordLedgerKey(record) {
  const fields = record.fields || {};
  return fields["Ledger Key"] || `${fields["Worker Key"] || ""}::${fields["Work Date"] || ""}::${fields["Asana Task GID"] || ""}`;
}

function airtableFieldsFromHbRow(row) {
  return writableAirtableFields({
    "Ledger Key": rowLedgerKey(row),
    "Work Date": row.work_date,
    "Worker Key": row.worker_key || "",
    "Worker Name": row.worker_name || "",
    "Worker Email": row.worker_email || "",
    "Asana Task GID": row.asana_task_gid || "",
    "Task Name": row.task_name || "",
    "Task URL": row.task_url || "",
    VIN: row.vin || "",
    Cycle: row.cycle_label || "",
    Phase: row.phase_label || "",
    "Assigned Hours": row.assigned_hours === null ? undefined : Number(row.assigned_hours || 0),
    "Allocated Hours": row.allocated_hours === null ? undefined : Number(row.allocated_hours || 0),
    "Actual Minutes": Number(row.actual_minutes || 0),
    "Timer Minutes": Number(row.timer_minutes || 0),
    "Asana Posted Minutes": Number(row.asana_posted_minutes || 0),
    Source: row.source_label || "Hawley live worker pilot",
    "Completed?": Boolean(row.completed),
    "Last Seen At": row.last_seen_at || null,
    "Was Assigned In DAT?": Boolean(row.was_assigned_in_dat)
  });
}

async function hawleyRows(client, startDate, endDate) {
  const result = await client.query(
    `
      select
        worker_daily_actual_id,
        ledger_key,
        work_date::text,
        worker_key,
        worker_name,
        worker_email,
        asana_task_gid,
        task_name,
        task_url,
        vin,
        cycle_label,
        phase_label,
        assigned_hours,
        allocated_hours,
        actual_minutes,
        timer_minutes,
        asana_posted_minutes,
        source_label,
        was_assigned_in_dat,
        completed,
        last_seen_at::text,
        fields_json
      from hb.worker_daily_task_actuals
      where work_date between $1::date and $2::date
        and source_system = $3
        and not daily_summary
        and nullif(coalesce(worker_key, ''), '') is not null
        and nullif(coalesce(asana_task_gid, ''), '') is not null
      order by work_date, worker_name nulls last, task_name nulls last
    `,
    [startDate, endDate, LIVE_WORKER_SOURCE]
  );
  return result.rows;
}

function batches(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function writeAirtableRows({ baseId, tableName, token, creates, updates }) {
  let recordsCreated = 0;
  let recordsUpdated = 0;

  for (const chunk of batches(updates, 10)) {
    if (!chunk.length) continue;
    const url = new URL(`${AIRTABLE_API_BASE}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableName)}`);
    await airtableRequest(url, token, {
      method: "PATCH",
      body: JSON.stringify({
        typecast: true,
        records: chunk.map(item => ({ id: item.id, fields: item.fields }))
      })
    });
    recordsUpdated += chunk.length;
  }

  for (const chunk of batches(creates, 10)) {
    if (!chunk.length) continue;
    const url = new URL(`${AIRTABLE_API_BASE}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableName)}`);
    await airtableRequest(url, token, {
      method: "POST",
      body: JSON.stringify({
        typecast: true,
        records: chunk.map(item => ({ fields: item.fields }))
      })
    });
    recordsCreated += chunk.length;
  }

  return { recordsCreated, recordsUpdated };
}

async function startRun(client, summary) {
  const result = await client.query(
    `
      insert into sync.run_log (job_name, mode, status, summary)
      values ($1, $2, 'running', $3::jsonb)
      returning id
    `,
    [JOB_NAME, summary.mode, JSON.stringify(summary)]
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

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const { startDate, endDate } = dateWindow(args);
  const writeEnabled = canWrite(args);
  const summary = {
    mode: writeEnabled ? "apply" : "dry-run",
    startDate,
    endDate,
    source: LIVE_WORKER_SOURCE,
    target: "Airtable Worker Daily Task Actuals",
    recordsRead: 0,
    recordsWritten: 0,
    recordsPlanned: 0,
    recordsCreated: 0,
    recordsUpdated: 0,
    recordsToCreate: 0,
    recordsToUpdate: 0,
    errorCount: 0,
    writeGate: {
      applyFlag: args.apply,
      allowSourceWrites: booleanEnv("HAWLEY_ALLOW_SOURCE_WRITES", false),
      dryRun: booleanEnv("HAWLEY_DRY_RUN", true)
    }
  };

  const client = new Client(getDatabaseConfig({ useSyncUrl: true }));
  await client.connect();
  const runId = await startRun(client, summary);

  try {
    const rows = await hawleyRows(client, startDate, endDate);
    summary.recordsRead = rows.length;

    const baseId = requiredEnv("AIRTABLE_BASE");
    const token = requiredEnv("AIRTABLE_PAT");
    const tableName = process.env.HAWLEY_AIRTABLE_WORKER_DAILY_ACTUALS_TABLE || "Worker Daily Task Actuals";
    const existing = await fetchExistingAirtableRows({ baseId, tableName, token });
    const existingByLedger = new Map();
    for (const record of existing) {
      const key = recordLedgerKey(record);
      if (key) existingByLedger.set(key, record);
    }

    const creates = [];
    const updates = [];
    for (const row of rows) {
      const key = rowLedgerKey(row);
      const fields = airtableFieldsFromHbRow(row);
      const existingRecord = existingByLedger.get(key);
      if (existingRecord) {
        updates.push({ id: existingRecord.id, fields });
      } else {
        creates.push({ fields });
      }
    }

    summary.recordsToCreate = creates.length;
    summary.recordsToUpdate = updates.length;
    summary.recordsPlanned = creates.length + updates.length;

    if (writeEnabled) {
      const result = await writeAirtableRows({ baseId, tableName, token, creates, updates });
      summary.recordsCreated = result.recordsCreated;
      summary.recordsUpdated = result.recordsUpdated;
      summary.recordsWritten = result.recordsCreated + result.recordsUpdated;
    }

    await finishRun(client, runId, "success", summary);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    summary.errorCount = 1;
    summary.error = error.message;
    await finishRun(client, runId, "error", summary);
    throw error;
  } finally {
    await client.end();
  }
}

run().catch(error => {
  console.error(error.message);
  process.exit(1);
});
