import pg from "pg";
import { getDatabaseConfig } from "./config.js";

const { Client } = pg;

const AIRTABLE_API_BASE = "https://api.airtable.com/v0";
const ASANA_API_BASE = "https://app.asana.com/api/1.0";
const PAGE_SIZE = 100;

const AIRTABLE_TABLES = Object.freeze([
  {
    envKey: "HAWLEY_AIRTABLE_TASK_INSTANCES_TABLE",
    sourceName: "Task Instances Rev1",
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
    envKey: "HAWLEY_AIRTABLE_CYCLES_TABLE",
    sourceName: "Cycles",
    targetTable: "raw.airtable_cycles"
  },
  {
    envKey: "HAWLEY_AIRTABLE_WORK_FORCE_TABLE",
    sourceName: "Work Force",
    targetTable: "raw.airtable_work_force"
  },
  {
    envKey: "HAWLEY_AIRTABLE_PHASE_CYCLE_LOAD_TABLE",
    sourceName: "Phase Cycle Load Rev1",
    targetTable: "raw.airtable_phase_cycle_load"
  },
  {
    envKey: "HAWLEY_AIRTABLE_WORKER_CYCLE_BANK_TABLE",
    sourceName: "Worker Cycle Bank Rev1",
    targetTable: "raw.airtable_worker_cycle_bank"
  },
  {
    envKey: "HAWLEY_AIRTABLE_PHASES_TABLE",
    sourceName: "Phases",
    targetTable: "raw.airtable_phases"
  },
  {
    envKey: "HAWLEY_AIRTABLE_WORKER_PHASE_ALLOCATION_TABLE",
    sourceName: "Worker Phase Allocation Rev1",
    targetTable: "raw.airtable_worker_phase_allocation"
  },
  {
    envKey: "HAWLEY_AIRTABLE_WORKER_DAILY_ACTUALS_TABLE",
    sourceName: "Worker Daily Task Actuals",
    targetTable: "raw.airtable_worker_daily_actuals"
  }
]);

const ASANA_PORTFOLIOS = Object.freeze([
  {
    key: "fabrication",
    gidEnv: "HAWLEY_ASANA_FABRICATION_PORTFOLIO_GID",
    defaultGid: "1212620750946278",
    expectedName: "Fabrication - 2026"
  },
  {
    key: "vin",
    gidEnv: "HAWLEY_ASANA_VIN_PORTFOLIO_GID",
    defaultGid: "1212620750946276",
    expectedName: "VINs - 2026"
  }
]);

const DAILY_TRACKER_PROJECT_GID = process.env.HAWLEY_DAILY_TRACKER_PROJECT_GID || "1214157321063250";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}.`);
  return value;
}

function failOnMismatch() {
  return !process.argv.includes("--no-fail");
}

function airtableTableName(config) {
  return process.env[config.envKey] || config.sourceName;
}

async function fetchJson(url, headers, label, retry = 0) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers
    });
    const text = await response.text();

    if ((response.status === 429 || response.status >= 500) && retry < 5) {
      const retryAfter = Number(response.headers.get("retry-after") || 0);
      const waitMs = retryAfter ? retryAfter * 1000 : 1000 * Math.pow(2, retry);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      return fetchJson(url, headers, label, retry + 1);
    }

    if (!response.ok) {
      throw new Error(`${label} failed (${response.status}): ${text.slice(0, 500)}`);
    }

    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAirtableCount({ baseId, token, tableName }) {
  let offset = "";
  let count = 0;

  do {
    const url = new URL(`${AIRTABLE_API_BASE}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableName)}`);
    url.searchParams.set("pageSize", String(PAGE_SIZE));
    if (offset) url.searchParams.set("offset", offset);

    const json = await fetchJson(
      url,
      { Authorization: `Bearer ${token}` },
      `Airtable ${tableName}`
    );
    count += (json.records || []).length;
    offset = json.offset || "";
  } while (offset);

  return count;
}

async function fetchAsanaPaginated({ token, path, params }) {
  const rows = [];
  let offset = "";

  do {
    const url = new URL(`${ASANA_API_BASE}${path}`);
    url.searchParams.set("limit", String(PAGE_SIZE));
    for (const [key, value] of Object.entries(params || {})) {
      url.searchParams.set(key, value);
    }
    if (offset) url.searchParams.set("offset", offset);

    const json = await fetchJson(
      url,
      {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      `Asana ${path}`
    );
    rows.push(...(json.data || []));
    offset = json.next_page?.offset || "";
  } while (offset);

  return rows;
}

async function fetchAsanaObject({ token, path, params }) {
  const url = new URL(`${ASANA_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params || {})) {
    url.searchParams.set(key, value);
  }
  const json = await fetchJson(
    url,
    {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    `Asana ${path}`
  );
  return json.data || {};
}

async function tableCount(client, fullTableName) {
  const [schemaName, tableName] = fullTableName.split(".");
  const result = await client.query(`select count(*)::int as count from "${schemaName}"."${tableName}"`);
  return result.rows[0]?.count || 0;
}

async function latestRuns(client) {
  const result = await client.query(`
    select distinct on (job_name)
      job_name,
      status,
      ended_at,
      records_read,
      records_written,
      error_count
    from sync.run_log
    where job_name in ('pull_airtable', 'pull_asana', 'pull_daily_tracker')
    order by job_name, id desc
  `);
  return Object.fromEntries(result.rows.map(row => [row.job_name, row]));
}

function compareCount({ label, sourceCount, hawleyCount }) {
  const delta = Number(sourceCount || 0) - Number(hawleyCount || 0);
  let status = "match";
  if (delta > 0) status = "hawley_missing_rows";
  else if (delta < 0) status = "hawley_has_extra_rows";
  return {
    label,
    sourceCount,
    hawleyCount,
    delta,
    status
  };
}

function rollupStatus(checks) {
  return checks.every(check => check.status === "match") ? "ok" : "stale";
}

function fieldsByName(task) {
  return (task.custom_fields || task.custom_fields_json || []).reduce((result, field) => {
    if (field?.name) result[field.name] = field;
    return result;
  }, {});
}

function textValue(field) {
  if (!field) return "";
  if (field.enum_value?.name) return field.enum_value.name;
  if (field.text_value !== undefined && field.text_value !== null) return field.text_value;
  return field.display_value || "";
}

function sectionNames(task) {
  const memberships = task.memberships || task.raw_json?.memberships || [];
  return memberships.map(membership => membership.section?.name || "").filter(Boolean);
}

function isDailyTrackerSnapshotTask(task) {
  const fields = fieldsByName(task);
  const trackerType = textValue(fields["Tracker Type"]) || textValue(fields["Tracker Model"]);
  if (!trackerType) return false;
  return !sectionNames(task).some(name => /\barchive\b/i.test(name));
}

async function airtableHealth(client) {
  const baseId = requiredEnv("AIRTABLE_BASE");
  const token = requiredEnv("AIRTABLE_PAT");
  const checks = [];

  for (const config of AIRTABLE_TABLES) {
    const sourceName = airtableTableName(config);
    const [sourceCount, hawleyCount] = await Promise.all([
      fetchAirtableCount({ baseId, token, tableName: sourceName }),
      tableCount(client, config.targetTable)
    ]);
    checks.push(compareCount({
      label: config.sourceName,
      sourceCount,
      hawleyCount
    }));
  }

  return {
    status: rollupStatus(checks),
    sourceTotal: checks.reduce((sum, check) => sum + check.sourceCount, 0),
    hawleyTotal: checks.reduce((sum, check) => sum + check.hawleyCount, 0),
    checks
  };
}

async function asanaHealth(client) {
  const token = requiredEnv("ASANA_PAT");
  const portfolioChecks = [];

  for (const config of ASANA_PORTFOLIOS) {
    const portfolioGid = process.env[config.gidEnv] || config.defaultGid;
    const portfolio = await fetchAsanaObject({
      token,
      path: `/portfolios/${portfolioGid}`,
      params: { opt_fields: "gid,name" }
    });
    const items = await fetchAsanaPaginated({
      token,
      path: `/portfolios/${portfolioGid}/items`,
      params: { opt_fields: "gid,name,resource_type" }
    });
    const sourceProjects = items.filter(item => item.resource_type === "project");
    const dbResult = await client.query(
      "select count(*)::int as count from raw.asana_portfolio_projects where portfolio_gid = $1",
      [portfolioGid]
    );
    portfolioChecks.push(compareCount({
      label: portfolio.name || config.expectedName,
      sourceCount: sourceProjects.length,
      hawleyCount: dbResult.rows[0]?.count || 0
    }));
  }

  const trackerProject = await fetchAsanaObject({
    token,
    path: `/projects/${DAILY_TRACKER_PROJECT_GID}`,
    params: { opt_fields: "gid,name" }
  });
  const sourceTrackerTasks = await fetchAsanaPaginated({
    token,
    path: "/tasks",
    params: {
      project: DAILY_TRACKER_PROJECT_GID,
      opt_fields: [
        "gid",
        "name",
        "custom_fields.gid",
        "custom_fields.name",
        "custom_fields.display_value",
        "custom_fields.text_value",
        "custom_fields.enum_value.name",
        "memberships.section.name"
      ].join(",")
    }
  });
  const trackerResult = await client.query(
    `
      select gid, name, custom_fields_json, raw_json
      from raw.asana_tasks
      where project_gid = $1
    `,
    [DAILY_TRACKER_PROJECT_GID]
  );
  const dailyTracker = compareCount({
    label: `${trackerProject.name || "Daily Assignment Tracker"} snapshots`,
    sourceCount: sourceTrackerTasks.filter(isDailyTrackerSnapshotTask).length,
    hawleyCount: trackerResult.rows.filter(isDailyTrackerSnapshotTask).length
  });

  const checks = portfolioChecks.concat(dailyTracker);
  return {
    status: rollupStatus(checks),
    portfolioChecks,
    dailyTracker
  };
}

async function main() {
  const client = new Client(getDatabaseConfig({ useSyncUrl: true }));
  await client.connect();

  try {
    const [airtable, asana, runs] = await Promise.all([
      airtableHealth(client),
      asanaHealth(client),
      latestRuns(client)
    ]);

    const status = airtable.status === "ok" && asana.status === "ok" ? "ok" : "stale";
    const payload = {
      checkedAt: new Date().toISOString(),
      status,
      latestRuns: runs,
      airtable,
      asana
    };

    console.log(JSON.stringify(payload, null, 2));
    if (status !== "ok" && failOnMismatch()) {
      process.exitCode = 2;
    }
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error("Hawley source health check failed.");
  console.error(error.message);
  process.exitCode = 1;
});
