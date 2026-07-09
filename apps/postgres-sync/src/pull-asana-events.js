import { spawn } from "node:child_process";
import pg from "pg";
import { getDatabaseConfig } from "./config.js";

const { Client } = pg;

const ASANA_API_BASE = "https://app.asana.com/api/1.0";
const DEFAULT_INTERVAL_MS = 60000;

const TASK_OPT_FIELDS = [
  "gid",
  "name",
  "resource_type",
  "resource_subtype",
  "created_at",
  "modified_at",
  "completed",
  "completed_at",
  "due_on",
  "due_at",
  "start_on",
  "start_at",
  "assignee.gid",
  "assignee.name",
  "assignee.email",
  "actual_time_minutes",
  "num_subtasks",
  "parent.gid",
  "parent.name",
  "memberships.project.gid",
  "memberships.project.name",
  "memberships.section.gid",
  "memberships.section.name",
  "custom_fields.gid",
  "custom_fields.name",
  "custom_fields.resource_subtype",
  "custom_fields.type",
  "custom_fields.display_value",
  "custom_fields.text_value",
  "custom_fields.number_value",
  "custom_fields.date_value",
  "custom_fields.enum_value.gid",
  "custom_fields.enum_value.name",
  "custom_fields.multi_enum_values.gid",
  "custom_fields.multi_enum_values.name",
  "notes",
  "permalink_url"
].join(",");

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}.`);
  return value;
}

function parseArgs(argv) {
  const args = {
    loop: false,
    intervalMs: Number(process.env.HAWLEY_ASANA_EVENT_INTERVAL_MS || DEFAULT_INTERVAL_MS),
    build: process.env.HAWLEY_ASANA_EVENT_BUILD_HB !== "false",
    initOnly: false,
    limitProjects: 0
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--loop") args.loop = true;
    else if (arg === "--interval-ms") args.intervalMs = Number(argv[++index] || args.intervalMs);
    else if (arg.startsWith("--interval-ms=")) args.intervalMs = Number(arg.slice("--interval-ms=".length));
    else if (arg === "--skip-build") args.build = false;
    else if (arg === "--init-only") args.initOnly = true;
    else if (arg === "--limit-projects") args.limitProjects = Number(argv[++index] || 0);
    else if (arg.startsWith("--limit-projects=")) args.limitProjects = Number(arg.slice("--limit-projects=".length));
    else if (arg === "-h" || arg === "--help") {
      console.log([
        "Usage: npm run pg:pull:asana-events -- [options]",
        "",
        "Options:",
        "  --loop              Poll continuously.",
        "  --interval-ms N     Loop interval. Default 60000.",
        "  --skip-build        Do not rebuild HB after changed task rows.",
        "  --init-only         Establish missing Asana event cursors, then exit.",
        "  --limit-projects N  Limit project count for testing."
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.intervalMs) || args.intervalMs < 15000) {
    throw new Error("--interval-ms must be at least 15000.");
  }
  if (!Number.isFinite(args.limitProjects) || args.limitProjects < 0) {
    throw new Error("--limit-projects must be a non-negative number.");
  }

  return args;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function asanaDate(value) {
  return value || null;
}

class AsanaClient {
  constructor(token) {
    this.token = token;
  }

  async request(pathOrUrl, options = {}, retry = 0) {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${ASANA_API_BASE}${pathOrUrl}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          ...(options.headers || {})
        }
      });
      const text = await response.text();

      if ((response.status === 429 || response.status >= 500) && retry < 6) {
        const retryAfter = Number(response.headers.get("retry-after") || 0);
        const waitMs = retryAfter ? retryAfter * 1000 : 1000 * Math.pow(2, retry);
        await sleep(waitMs);
        return this.request(pathOrUrl, options, retry + 1);
      }

      const body = text ? JSON.parse(text) : {};
      if (response.status === 412) {
        const error = new Error("Asana event sync token initialized.");
        error.status = 412;
        error.body = body;
        throw error;
      }
      if (!response.ok) {
        const error = new Error(`Asana ${options.method || "GET"} failed (${response.status}): ${text.slice(0, 700)}`);
        error.status = response.status;
        error.body = body;
        throw error;
      }

      return body;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getEvents(resourceGid, syncToken) {
    const params = new URLSearchParams({
      resource: resourceGid,
      opt_fields: "action,type,created_at,resource.gid,resource.name,resource.resource_type,user.gid,user.name"
    });
    if (syncToken) params.set("sync", syncToken);
    return this.request(`/events?${params.toString()}`);
  }

  async getTask(taskGid) {
    const jsonResult = await this.request(`/tasks/${taskGid}?opt_fields=${TASK_OPT_FIELDS}`);
    return jsonResult.data;
  }
}

async function startRun(client, mode) {
  const result = await client.query(
    `
      insert into sync.run_log (job_name, mode, status)
      values ('pull_asana_events', $1, 'running')
      returning id
    `,
    [mode]
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
      status === "failed" ? 1 : 0,
      JSON.stringify(summary)
    ]
  );
}

async function eventProjects(client, limitProjects) {
  const result = await client.query(
    `
      select distinct on (portfolio_project.project_gid)
        portfolio_project.project_gid,
        coalesce(project.name, portfolio_project.project_name) as project_name,
        portfolio_project.portfolio_gid,
        portfolio_project.portfolio_name,
        project.raw_json as project_raw_json
      from raw.asana_portfolio_projects portfolio_project
      left join raw.asana_projects project on project.gid = portfolio_project.project_gid
      order by portfolio_project.project_gid, portfolio_project.portfolio_gid
      ${limitProjects > 0 ? "limit $1" : ""}
    `,
    limitProjects > 0 ? [limitProjects] : []
  );
  return result.rows;
}

function freshSyncToken(errorBody) {
  return (
    errorBody?.sync ||
    errorBody?.data?.sync ||
    errorBody?.errors?.find(error => error?.sync)?.sync ||
    ""
  );
}

async function upsertCursor(client, project, patch) {
  await client.query(
    `
      insert into sync.asana_project_event_cursors
        (
          project_gid,
          project_name,
          portfolio_gid,
          portfolio_name,
          sync_token,
          initialized_at,
          last_polled_at,
          last_success_at,
          last_event_at,
          last_event_count,
          last_changed_task_count,
          needs_full_recrawl,
          error_count,
          last_error,
          updated_at
        )
      values
        ($1, $2, $3, $4, $5, coalesce($6, now()), $7, $8, $9, $10, $11, $12, $13, $14, now())
      on conflict (project_gid) do update set
        project_name = excluded.project_name,
        portfolio_gid = excluded.portfolio_gid,
        portfolio_name = excluded.portfolio_name,
        sync_token = coalesce(excluded.sync_token, sync.asana_project_event_cursors.sync_token),
        initialized_at = coalesce(sync.asana_project_event_cursors.initialized_at, excluded.initialized_at),
        last_polled_at = coalesce(excluded.last_polled_at, sync.asana_project_event_cursors.last_polled_at),
        last_success_at = coalesce(excluded.last_success_at, sync.asana_project_event_cursors.last_success_at),
        last_event_at = coalesce(excluded.last_event_at, sync.asana_project_event_cursors.last_event_at),
        last_event_count = excluded.last_event_count,
        last_changed_task_count = excluded.last_changed_task_count,
        needs_full_recrawl = excluded.needs_full_recrawl,
        error_count = excluded.error_count,
        last_error = excluded.last_error,
        updated_at = now()
    `,
    [
      project.project_gid,
      project.project_name,
      project.portfolio_gid,
      project.portfolio_name,
      patch.syncToken ?? null,
      patch.initializedAt ?? null,
      patch.lastPolledAt ?? null,
      patch.lastSuccessAt ?? null,
      patch.lastEventAt ?? null,
      patch.lastEventCount ?? 0,
      patch.lastChangedTaskCount ?? 0,
      patch.needsFullRecrawl ?? false,
      patch.errorCount ?? 0,
      patch.lastError ?? null
    ]
  );
}

async function cursorForProject(client, projectGid) {
  const result = await client.query(
    "select * from sync.asana_project_event_cursors where project_gid = $1",
    [projectGid]
  );
  return result.rows[0] || null;
}

function parentGid(task) {
  return task.parent?.gid || null;
}

function taskMembershipRows(task, sourceProject) {
  const rows = new Map();

  function addRow(membership, isSourceProject) {
    const project = membership.project || sourceProject;
    if (!project?.gid) return;
    const section = membership.section || null;
    const sectionGid = section?.gid || "";
    const key = `${task.gid}:${project.gid}:${sectionGid}`;
    rows.set(key, {
      taskGid: task.gid,
      projectGid: project.gid,
      sectionGid,
      sectionName: section?.name || null,
      isSourceProject,
      raw: membership
    });
  }

  for (const membership of task.memberships || []) {
    addRow(membership, membership.project?.gid === sourceProject.gid);
  }

  if (![...rows.values()].some(row => row.projectGid === sourceProject.gid)) {
    addRow({
      project: { gid: sourceProject.gid, name: sourceProject.name },
      section: null
    }, true);
  }

  return [...rows.values()];
}

async function upsertTask(client, task, sourceProject) {
  await client.query(
    `
      insert into raw.asana_tasks
        (
          gid,
          project_gid,
          parent_gid,
          name,
          assignee_gid,
          assignee_name,
          assignee_email,
          completed,
          completed_at,
          due_on,
          due_at,
          start_on,
          start_at,
          actual_time_minutes,
          num_subtasks,
          custom_fields_json,
          created_at,
          modified_at,
          permalink_url,
          raw_json,
          synced_at
        )
      values
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18, $19, $20::jsonb, now())
      on conflict (gid) do update set
        project_gid = excluded.project_gid,
        parent_gid = excluded.parent_gid,
        name = excluded.name,
        assignee_gid = excluded.assignee_gid,
        assignee_name = excluded.assignee_name,
        assignee_email = excluded.assignee_email,
        completed = excluded.completed,
        completed_at = excluded.completed_at,
        due_on = excluded.due_on,
        due_at = excluded.due_at,
        start_on = excluded.start_on,
        start_at = excluded.start_at,
        actual_time_minutes = excluded.actual_time_minutes,
        num_subtasks = excluded.num_subtasks,
        custom_fields_json = excluded.custom_fields_json,
        created_at = excluded.created_at,
        modified_at = excluded.modified_at,
        permalink_url = excluded.permalink_url,
        raw_json = excluded.raw_json,
        synced_at = now()
    `,
    [
      task.gid,
      sourceProject.gid,
      parentGid(task),
      task.name || null,
      task.assignee?.gid || null,
      task.assignee?.name || null,
      task.assignee?.email || null,
      task.completed ?? null,
      asanaDate(task.completed_at),
      task.due_on || null,
      asanaDate(task.due_at),
      task.start_on || null,
      asanaDate(task.start_at),
      task.actual_time_minutes ?? null,
      task.num_subtasks ?? null,
      json(task.custom_fields || []),
      asanaDate(task.created_at),
      asanaDate(task.modified_at),
      task.permalink_url || null,
      json(task)
    ]
  );
}

async function upsertMembership(client, membership) {
  await client.query(
    `
      insert into raw.asana_task_project_memberships
        (task_gid, project_gid, section_gid, section_name, is_source_project, raw_json, synced_at)
      values
        ($1, $2, $3, $4, $5, $6::jsonb, now())
      on conflict (task_gid, project_gid, section_gid) do update set
        section_name = excluded.section_name,
        is_source_project = raw.asana_task_project_memberships.is_source_project or excluded.is_source_project,
        raw_json = excluded.raw_json,
        synced_at = now()
    `,
    [
      membership.taskGid,
      membership.projectGid,
      membership.sectionGid,
      membership.sectionName,
      membership.isSourceProject,
      json(membership.raw)
    ]
  );
}

function taskGidsFromEvents(events) {
  return Array.from(new Set(
    events
      .filter(event => event?.resource?.resource_type === "task" && event.resource.gid)
      .map(event => event.resource.gid)
  ));
}

async function processChangedTasks(client, asana, project, taskGids, summary) {
  const sourceProject = {
    gid: project.project_gid,
    name: project.project_name || project.project_gid
  };
  let changed = 0;

  for (const taskGid of taskGids) {
    try {
      const task = await asana.getTask(taskGid);
      summary.recordsRead += 1;
      await upsertTask(client, task, sourceProject);
      summary.recordsWritten += 1;
      changed += 1;

      const memberships = taskMembershipRows(task, sourceProject);
      for (const membership of memberships) {
        await upsertMembership(client, membership);
        summary.membershipRows += 1;
        summary.recordsWritten += 1;
      }
    } catch (error) {
      if (error.status === 404) {
        summary.missingTasks += 1;
        continue;
      }
      throw error;
    }
  }

  return changed;
}

async function pollProject(client, asana, project, args, summary) {
  const cursor = await cursorForProject(client, project.project_gid);
  const events = [];
  let syncToken = cursor?.sync_token || "";
  let initialized = false;

  try {
    while (true) {
      const response = await asana.getEvents(project.project_gid, syncToken);
      const pageEvents = response.data || [];
      events.push(...pageEvents);
      summary.recordsRead += pageEvents.length;
      syncToken = response.sync || syncToken;
      if (!response.has_more) break;
      if (!syncToken) break;
    }
  } catch (error) {
    if (error.status === 412) {
      syncToken = freshSyncToken(error.body);
      if (!syncToken) throw new Error(`Asana did not return an event sync token for project ${project.project_gid}.`);
      initialized = true;
    } else {
      const errorCount = Number(cursor?.error_count || 0) + 1;
      await upsertCursor(client, project, {
        syncToken,
        lastPolledAt: new Date().toISOString(),
        lastEventCount: 0,
        lastChangedTaskCount: 0,
        needsFullRecrawl: false,
        errorCount,
        lastError: error.message
      });
      throw error;
    }
  }

  const taskGids = args.initOnly || initialized ? [] : taskGidsFromEvents(events);
  const changedTasks = await processChangedTasks(client, asana, project, taskGids, summary);
  const lastEventAt = events
    .map(event => event.created_at)
    .filter(Boolean)
    .sort()
    .at(-1) || null;

  await upsertCursor(client, project, {
    syncToken,
    initializedAt: initialized ? new Date().toISOString() : null,
    lastPolledAt: new Date().toISOString(),
    lastSuccessAt: new Date().toISOString(),
    lastEventAt,
    lastEventCount: events.length,
    lastChangedTaskCount: changedTasks,
    needsFullRecrawl: initialized,
    errorCount: 0,
    lastError: null
  });

  summary.projects += 1;
  summary.events += events.length;
  summary.changedTaskEvents += taskGids.length;
  summary.changedTasks += changedTasks;
  if (initialized) summary.initializedProjects += 1;
  return changedTasks;
}

function runBuildHb() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["./apps/postgres-sync/src/build-hb.js"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", data => {
      stdout += data.toString();
    });
    child.stderr.on("data", data => {
      stderr += data.toString();
    });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`HB build failed with exit code ${code}: ${stderr || stdout}`));
      }
    });
  });
}

async function pollOnce(args) {
  const asana = new AsanaClient(requiredEnv("ASANA_PAT"));
  const client = new Client(getDatabaseConfig({ useSyncUrl: true }));
  await client.connect();

  const summary = {
    mode: args.initOnly ? "init-only" : "events",
    projects: 0,
    initializedProjects: 0,
    events: 0,
    changedTaskEvents: 0,
    changedTasks: 0,
    missingTasks: 0,
    membershipRows: 0,
    hbRebuilt: false,
    recordsRead: 0,
    recordsWritten: 0
  };
  const runId = await startRun(client, summary.mode);

  try {
    const projects = await eventProjects(client, args.limitProjects);
    summary.projectScope = projects.length;
    for (const project of projects) {
      await pollProject(client, asana, project, args, summary);
    }

    if (args.build && summary.changedTasks > 0) {
      await client.end();
      await runBuildHb();
      summary.hbRebuilt = true;
      const logClient = new Client(getDatabaseConfig({ useSyncUrl: true }));
      await logClient.connect();
      await finishRun(logClient, runId, "success", summary);
      await logClient.end();
    } else {
      await finishRun(client, runId, "success", summary);
      await client.end();
    }

    return summary;
  } catch (error) {
    try {
      await finishRun(client, runId, "failed", {
        ...summary,
        error: error.message
      });
    } catch {
      // Preserve the original failure.
    }
    await client.end().catch(() => {});
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.loop) {
    const summary = await pollOnce(args);
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(JSON.stringify({
    status: "watching",
    intervalMs: args.intervalMs,
    writes: "hawley_db_only",
    asanaWrites: false,
    airtableWrites: false
  }));

  while (true) {
    const startedAt = Date.now();
    try {
      const summary = await pollOnce(args);
      console.log(JSON.stringify({
        at: new Date().toISOString(),
        ...summary
      }));
    } catch (error) {
      console.error(JSON.stringify({
        at: new Date().toISOString(),
        status: "failed",
        error: error.message
      }));
    }
    const elapsed = Date.now() - startedAt;
    await sleep(Math.max(1000, args.intervalMs - elapsed));
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
