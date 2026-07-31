import crypto from "node:crypto";
import pg from "pg";
import { getDatabaseConfig } from "./config.js";

const { Client } = pg;

const AIRTABLE_API_BASE = "https://api.airtable.com/v0";
const JOB_NAME = "writeback_airtable_task_times";
const TASK_INSTANCES_TABLE = process.env.HAWLEY_AIRTABLE_TASK_INSTANCES_TABLE || "Task Instances Rev1";
const TASKS_TABLE = process.env.HAWLEY_AIRTABLE_TASKS_TABLE || "Tasks";
const DEFAULT_INTERVAL_MS = 60000;
const AIRTABLE_BATCH_SIZE = 10;
const AIRTABLE_REQUEST_DELAY_MS = 225;

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

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) throw new Error(`${label} must be at least 1.`);
  return Math.trunc(number);
}

function parseArgs(argv) {
  const args = { apply: false, loop: false, intervalMs: DEFAULT_INTERVAL_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--loop") args.loop = true;
    else if (arg === "--interval-ms") args.intervalMs = positiveInteger(argv[++index], "--interval-ms");
    else if (arg.startsWith("--interval-ms=")) args.intervalMs = positiveInteger(arg.slice("--interval-ms=".length), "--interval-ms");
    else if (arg === "-h" || arg === "--help") {
      console.log([
        "Usage: npm run pg:writeback:airtable-task-times -- [options]",
        "",
        "Reconciles Hawley's canonical task time and completion state into Airtable.",
        "It also recalculates Tasks.Avg. Time, Avg. Time Input Count, and Avg. Time Quality.",
        "",
        "Dry-run is the default. To write, pass --apply and set:",
        "  HAWLEY_ALLOW_SOURCE_WRITES=true",
        "  HAWLEY_DRY_RUN=false",
        "",
        "Options:",
        "  --apply                 Write after the source-write safety gates pass.",
        "  --loop                  Repeat at the configured interval.",
        "  --interval-ms N         Loop interval; default 60000 (minimum 15000)."
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (args.loop && args.intervalMs < 15000) throw new Error("--interval-ms must be at least 15000 in loop mode.");
  return args;
}

function canWrite(args) {
  return args.apply && booleanEnv("HAWLEY_ALLOW_SOURCE_WRITES", false) && !booleanEnv("HAWLEY_DRY_RUN", true);
}

function compactFields(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

function sameValue(left, right) {
  if (left === null || left === undefined || left === "") return right === null || right === undefined || right === "";
  if (right === null || right === undefined || right === "") return false;
  if (typeof left === "number" || typeof right === "number") return Number(left) === Number(right);
  return String(left) === String(right);
}

function numeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function hashPayload(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function batches(values, size = AIRTABLE_BATCH_SIZE) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function airtableRequest(url, token, options = {}, attempts = 0) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const body = await response.text();
  if (response.ok) return body ? JSON.parse(body) : {};
  if ((response.status === 429 || response.status >= 500) && attempts < 4) {
    const retryAfter = Number(response.headers.get("retry-after") || 0);
    await sleep(Math.max(retryAfter * 1000, 500 * (attempts + 1)));
    return airtableRequest(url, token, options, attempts + 1);
  }
  throw new Error(`Airtable request failed ${response.status}: ${body.slice(0, 800)}`);
}

async function writeAirtableUpdates({ baseId, tableName, token, updates }) {
  let written = 0;
  const chunks = batches(updates);
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const url = new URL(`${AIRTABLE_API_BASE}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableName)}`);
    await airtableRequest(url, token, {
      method: "PATCH",
      body: JSON.stringify({ typecast: true, records: chunk.map(item => ({ id: item.id, fields: item.fields })) })
    });
    written += chunk.length;
    if (index < chunks.length - 1) await sleep(AIRTABLE_REQUEST_DELAY_MS);
  }
  return written;
}

async function startRun(client, summary) {
  const result = await client.query(
    `insert into sync.run_log (job_name, mode, status, summary)
     values ($1, $2, 'running', $3::jsonb) returning id`,
    [JOB_NAME, summary.mode, JSON.stringify(summary)]
  );
  return result.rows[0].id;
}

async function finishRun(client, id, status, summary) {
  await client.query(
    `update sync.run_log
     set status = $2, ended_at = now(), records_read = $3, records_written = $4,
         error_count = $5, summary = $6::jsonb
     where id = $1`,
    [id, status, summary.recordsRead || 0, summary.recordsWritten || 0, summary.errorCount || 0, JSON.stringify(summary)]
  );
}

async function taskInstanceCandidates(client) {
  const result = await client.query(`
    select
      h.airtable_record_id,
      h.asana_task_gid,
      h.actual_time_seconds,
      h.last_synced_at,
      r.fields_json as airtable_fields
    from hb.rev1_task_instances h
    join raw.airtable_task_instances r on r.record_id = h.airtable_record_id
    where h.airtable_record_id like 'rec%'
      and nullif(h.asana_task_gid, '') is not null
  `);

  return result.rows.map(row => {
    const raw = row.airtable_fields || {};
    const fields = {};
    const canonicalSeconds = numeric(row.actual_time_seconds);
    if (canonicalSeconds !== null && !sameValue(canonicalSeconds, numeric(raw["Actual time"]))) {
      fields["Actual time"] = Math.round(canonicalSeconds);
    }

    if (!Object.keys(fields).length) return null;
    fields["Last Synced At"] = new Date().toISOString();
    return { id: row.airtable_record_id, fields, targetTable: TASK_INSTANCES_TABLE };
  }).filter(Boolean);
}

function qualityForCount(count) {
  if (count <= 0) return "No Data";
  if (count === 1) return "Very Low";
  if (count <= 3) return "Low";
  if (count <= 6) return "Medium";
  if (count <= 8) return "High";
  return "Very High";
}

async function taskAverageCandidates(client) {
  const result = await client.query(`
    with qualifying as (
      select
        tasks_record_id,
        actual_time_seconds::numeric as actual_seconds
      from hb.rev1_task_instances
      where nullif(tasks_record_id, '') is not null
        and coalesce(actual_time_seconds, 0) > 0
        and (
          estimated_task_time_seconds is null
          or actual_time_seconds <= estimated_task_time_seconds + 18000
        )
    ), aggregates as (
      select tasks_record_id, count(*)::integer as input_count, round(avg(actual_seconds), 4) as avg_seconds
      from qualifying
      group by tasks_record_id
    )
    select
      t.task_record_id,
      r.fields_json as airtable_fields,
      coalesce(a.input_count, 0)::integer as input_count,
      a.avg_seconds
    from hb.task_templates t
    join raw.airtable_tasks r on r.record_id = t.task_record_id
    left join aggregates a on a.tasks_record_id = t.task_record_id
  `);

  return result.rows.map(row => {
    const raw = row.airtable_fields || {};
    const inputCount = Number(row.input_count || 0);
    const avgSeconds = inputCount ? Number(row.avg_seconds) : null;
    const quality = qualityForCount(inputCount);
    const fields = compactFields({
      "Avg. Time": !sameValue(avgSeconds, numeric(raw["Avg. Time"])) ? avgSeconds : undefined,
      "Avg. Time Input Count": !sameValue(inputCount, numeric(raw["Avg. Time Input Count"])) ? inputCount : undefined,
      "Avg. Time Quality": !sameValue(quality, raw["Avg. Time Quality"]) ? quality : undefined
    });
    if (!Object.keys(fields).length) return null;
    return { id: row.task_record_id, fields, targetTable: TASKS_TABLE };
  }).filter(Boolean);
}

async function recordWritebackState(client, runId, candidates) {
  for (const candidate of candidates) {
    const payloadHash = hashPayload(candidate.fields);
    await client.query(
      `insert into sync.airtable_task_time_writeback_state
         (target_table, target_record_id, payload_hash, payload, last_written_at, last_run_id)
       values ($1, $2, $3, $4::jsonb, now(), $5)
       on conflict (target_table, target_record_id) do update set
         payload_hash = excluded.payload_hash,
         payload = excluded.payload,
         last_written_at = excluded.last_written_at,
         last_run_id = excluded.last_run_id`,
      [candidate.targetTable, candidate.id, payloadHash, JSON.stringify(candidate.fields), runId]
    );
  }
}

async function updateLocalAirtableMirror(client, candidates) {
  for (const candidate of candidates) {
    const rawTable = candidate.targetTable === TASK_INSTANCES_TABLE
      ? "raw.airtable_task_instances"
      : "raw.airtable_tasks";
    await client.query(
      `update ${rawTable}
       set fields_json = coalesce(fields_json, '{}'::jsonb) || $2::jsonb,
           synced_at = now()
       where record_id = $1`,
      [candidate.id, JSON.stringify(candidate.fields)]
    );
  }
}

async function runOnce(args) {
  const writeEnabled = canWrite(args);
  const summary = {
    mode: writeEnabled ? "apply" : "dry-run",
    target: "Airtable Task Instances Rev1 + Tasks averages",
    recordsRead: 0,
    recordsWritten: 0,
    taskInstanceUpdates: 0,
    taskAverageUpdates: 0,
    plannedTaskInstanceUpdates: 0,
    plannedTaskAverageUpdates: 0,
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
    const [instanceCandidates, averageCandidates] = await Promise.all([
      taskInstanceCandidates(client),
      taskAverageCandidates(client)
    ]);
    summary.recordsRead = instanceCandidates.length + averageCandidates.length;
    summary.plannedTaskInstanceUpdates = instanceCandidates.length;
    summary.plannedTaskAverageUpdates = averageCandidates.length;

    if (writeEnabled) {
      const baseId = requiredEnv("AIRTABLE_BASE");
      const token = requiredEnv("AIRTABLE_PAT");
      summary.taskInstanceUpdates = await writeAirtableUpdates({
        baseId, tableName: TASK_INSTANCES_TABLE, token, updates: instanceCandidates
      });
      summary.taskAverageUpdates = await writeAirtableUpdates({
        baseId, tableName: TASKS_TABLE, token, updates: averageCandidates
      });
      const written = [...instanceCandidates, ...averageCandidates];
      // A successful Airtable PATCH is immediately reflected in the local raw
      // mirror. The next minute therefore only writes a genuinely new Hawley
      // change; it does not resend this same payload until the nightly pull.
      await updateLocalAirtableMirror(client, written);
      await recordWritebackState(client, runId, written);
      summary.recordsWritten = summary.taskInstanceUpdates + summary.taskAverageUpdates;
    }

    await finishRun(client, runId, "success", summary);
    console.log(JSON.stringify(summary));
    return summary;
  } catch (error) {
    summary.errorCount = 1;
    summary.error = error.message;
    await finishRun(client, runId, "error", summary);
    throw error;
  } finally {
    await client.end();
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  do {
    await runOnce(args);
    if (args.loop) await sleep(args.intervalMs);
  } while (args.loop);
}

run().catch(error => {
  console.error(error.message);
  process.exit(1);
});
