import pg from "pg";
import { getDatabaseConfig } from "./config.js";

const { Client } = pg;
const AIRTABLE_API_BASE = "https://api.airtable.com/v0";
const SHOP_TIME_ZONE = "America/Los_Angeles";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}.`);
  return value;
}

function todayIso() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SHOP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date()).reduce((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function requestedDate() {
  const dateArgIndex = process.argv.indexOf("--date");
  const value = dateArgIndex >= 0 ? String(process.argv[dateArgIndex + 1] || "") : todayIso();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("--date must use YYYY-MM-DD.");
  return value;
}

function tableUrl(baseId, tableName, date, offset = "") {
  const url = new URL(`${AIRTABLE_API_BASE}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableName)}`);
  url.searchParams.set("pageSize", "100");
  // Assigned On is the line-lead scheduling field.  Pull only its live workday
  // slice; the nightly full mirror remains responsible for the complete archive.
  url.searchParams.set("filterByFormula", `DATETIME_FORMAT({Assigned On}, 'YYYY-MM-DD') = '${date}'`);
  if (offset) url.searchParams.set("offset", offset);
  return url;
}

async function fetchRecords(baseId, token, tableName, date) {
  const records = [];
  let offset = "";
  do {
    const response = await fetch(tableUrl(baseId, tableName, date, offset), {
      headers: { Authorization: `Bearer ${token}` }
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Airtable current-assignment pull failed ${response.status}: ${body.slice(0, 500)}`);
    const payload = JSON.parse(body);
    records.push(...(payload.records || []));
    offset = payload.offset || "";
  } while (offset);
  return records;
}

function modifiedAtFromFields(fields) {
  for (const key of ["Last Modified", "Last Modified Time", "Last Modified At", "Updated At", "Modified At"]) {
    if (fields[key]) return fields[key];
  }
  return null;
}

async function main() {
  const baseId = requiredEnv("AIRTABLE_BASE");
  const token = requiredEnv("AIRTABLE_PAT");
  const tableName = process.env.HAWLEY_AIRTABLE_TASK_INSTANCES_TABLE || "Task Instances Rev1";
  const date = requestedDate();
  const client = new Client(getDatabaseConfig({ useSyncUrl: true }));
  await client.connect();
  let runId = null;
  const summary = { date, table: tableName, recordsRead: 0, recordsWritten: 0, errorCount: 0 };

  try {
    runId = (await client.query(
      "insert into sync.run_log (job_name, mode, status) values ('pull_airtable_current_assignments', 'live-readonly', 'running') returning id"
    )).rows[0].id;
    const records = await fetchRecords(baseId, token, tableName, date);
    summary.recordsRead = records.length;
    await client.query("begin");
    for (const record of records) {
      await client.query(
        `
          insert into raw.airtable_task_instances
            (record_id, fields_json, airtable_created_at, modified_at, source_table_name, synced_at)
          values ($1, $2::jsonb, $3, $4, $5, now())
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
          tableName
        ]
      );
      summary.recordsWritten += 1;
    }
    await client.query("commit");
    await client.query(
      "update sync.run_log set status='success', ended_at=now(), records_read=$2, records_written=$3, error_count=0, summary=$4::jsonb where id=$1",
      [runId, summary.recordsRead, summary.recordsWritten, JSON.stringify(summary)]
    );
    console.log(`Mirrored ${summary.recordsWritten} current Airtable assignment(s) for ${date}.`);
  } catch (error) {
    await client.query("rollback").catch(() => {});
    summary.errorCount = 1;
    summary.errorMessage = error.message;
    if (runId) {
      await client.query(
        "update sync.run_log set status='failed', ended_at=now(), records_read=$2, records_written=$3, error_count=1, summary=$4::jsonb where id=$1",
        [runId, summary.recordsRead, summary.recordsWritten, JSON.stringify(summary)]
      );
    }
    throw error;
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
