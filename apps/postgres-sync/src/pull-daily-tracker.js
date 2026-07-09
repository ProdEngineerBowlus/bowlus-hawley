import pg from "pg";
import { getDatabaseConfig } from "./config.js";

const { Client } = pg;

const ASANA_API_BASE = "https://app.asana.com/api/1.0";
const ASANA_PAGE_SIZE = 100;
const DAILY_TRACKER_PROJECT_ID = process.env.HAWLEY_DAILY_TRACKER_PROJECT_GID || "1214157321063250";

const PROJECT_OPT_FIELDS = [
  "gid",
  "name",
  "resource_type",
  "archived",
  "created_at",
  "modified_at",
  "permalink_url",
  "workspace.gid",
  "workspace.name",
  "team.gid",
  "team.name",
  "owner.gid",
  "owner.name"
].join(",");

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
        await new Promise(resolve => setTimeout(resolve, waitMs));
        return this.request(pathOrUrl, options, retry + 1);
      }

      let body = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = {};
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

  async fetchPaginated(path, params) {
    const rows = [];
    let offset = "";

    do {
      const search = new URLSearchParams({
        limit: String(ASANA_PAGE_SIZE),
        ...params
      });
      if (offset) search.set("offset", offset);
      const jsonPayload = await this.request(`${path}?${search.toString()}`);
      rows.push(...(jsonPayload.data || []));
      offset = jsonPayload.next_page?.offset || "";
    } while (offset);

    return rows;
  }

  async getProject(projectGid) {
    const jsonPayload = await this.request(`/projects/${projectGid}?opt_fields=${PROJECT_OPT_FIELDS}`);
    return jsonPayload.data;
  }

  async getProjectTasks(projectGid) {
    return this.fetchPaginated("/tasks", {
      project: projectGid,
      opt_fields: TASK_OPT_FIELDS
    });
  }

  async getTask(taskGid) {
    const jsonPayload = await this.request(`/tasks/${taskGid}?opt_fields=${TASK_OPT_FIELDS}`);
    return jsonPayload.data;
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function fieldsByName(fields) {
  return (Array.isArray(fields) ? fields : []).reduce((result, field) => {
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

function collectReferencedSourceTaskGids(task) {
  const ids = new Set();
  const fields = fieldsByName(task.custom_fields || []);
  const snapshotPayload = String(textValue(fields["Snapshot Payload"]) || "").trim();

  if (snapshotPayload.startsWith("[")) {
    try {
      for (const item of JSON.parse(snapshotPayload)) {
        if (item?.gid && /^\d+$/.test(String(item.gid))) ids.add(String(item.gid));
      }
    } catch (error) {
      // The note parser below still catches source URLs if JSON is malformed.
    }
  }

  for (const match of String(task.notes || "").matchAll(/task\/(\d+)/g)) {
    ids.add(match[1]);
  }

  ids.delete(String(task.gid));
  return [...ids];
}

function sourceProjectForTask(task, fallbackProject) {
  const membershipProject = (task.memberships || [])
    .map(membership => membership.project)
    .find(project => project?.gid && project.gid !== DAILY_TRACKER_PROJECT_ID) ||
    (task.memberships || []).map(membership => membership.project).find(project => project?.gid);

  if (membershipProject?.gid) {
    return {
      gid: membershipProject.gid,
      name: membershipProject.name || membershipProject.gid
    };
  }

  return fallbackProject;
}

async function startRun(client) {
  const result = await client.query(`
    insert into sync.run_log (job_name, mode, status)
    values ('pull_daily_tracker', 'live-readonly', 'running')
    returning id
  `);
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

async function upsertProject(client, project) {
  await client.query(
    `
      insert into raw.asana_projects
        (gid, name, archived, created_at, modified_at, workspace_gid, workspace_name, permalink_url, raw_json, synced_at)
      values
        ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now())
      on conflict (gid) do update set
        name = excluded.name,
        archived = excluded.archived,
        created_at = excluded.created_at,
        modified_at = excluded.modified_at,
        workspace_gid = excluded.workspace_gid,
        workspace_name = excluded.workspace_name,
        permalink_url = excluded.permalink_url,
        raw_json = excluded.raw_json,
        synced_at = now()
    `,
    [
      project.gid,
      project.name || null,
      project.archived ?? null,
      asanaDate(project.created_at),
      asanaDate(project.modified_at),
      project.workspace?.gid || null,
      project.workspace?.name || null,
      project.permalink_url || null,
      json(project)
    ]
  );
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
      task.parent?.gid || null,
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

async function pruneProjectRows(client, projectGid, currentTaskGids) {
  await client.query(
    `
      delete from raw.asana_task_project_memberships
      where project_gid = $1
        and not (task_gid = any($2::text[]))
    `,
    [projectGid, currentTaskGids]
  );

  await client.query(
    `
      delete from raw.asana_tasks
      where project_gid = $1
        and not (gid = any($2::text[]))
    `,
    [projectGid, currentTaskGids]
  );
}

async function main() {
  const asana = new AsanaClient(requiredEnv("ASANA_PAT"));
  const client = new Client(getDatabaseConfig({ useSyncUrl: true }));
  await client.connect();

  const summary = {
    projectGid: DAILY_TRACKER_PROJECT_ID,
    projectName: "",
    taskRowsFetched: 0,
    referencedSourceTasksFetched: 0,
    membershipRows: 0,
    recordsRead: 0,
    recordsWritten: 0
  };
  const runId = await startRun(client);

  try {
    const project = await asana.getProject(DAILY_TRACKER_PROJECT_ID);
    summary.projectName = project.name || "Daily Assignment Tracker";
    await upsertProject(client, project);
    summary.recordsRead += 1;
    summary.recordsWritten += 1;

    const tasks = await asana.getProjectTasks(DAILY_TRACKER_PROJECT_ID);
    summary.taskRowsFetched = tasks.length;
    summary.recordsRead += tasks.length;

    for (const task of tasks) {
      await upsertTask(client, task, project);
      summary.recordsWritten += 1;

      for (const membership of taskMembershipRows(task, project)) {
        await upsertMembership(client, membership);
        summary.membershipRows += 1;
        summary.recordsWritten += 1;
      }
    }

    const sourceTaskGids = Array.from(new Set(tasks.flatMap(collectReferencedSourceTaskGids)));
    const sourceTasks = await mapLimit(sourceTaskGids, 6, async taskGid => {
      try {
        return await asana.getTask(taskGid);
      } catch (error) {
        console.warn(`Could not refresh referenced source task ${taskGid}: ${error.message}`);
        return null;
      }
    });
    const fetchedSourceTasks = sourceTasks.filter(Boolean);
    summary.referencedSourceTasksFetched = fetchedSourceTasks.length;
    summary.recordsRead += fetchedSourceTasks.length;

    for (const task of fetchedSourceTasks) {
      const sourceProject = sourceProjectForTask(task, project);
      await upsertTask(client, task, sourceProject);
      summary.recordsWritten += 1;

      for (const membership of taskMembershipRows(task, sourceProject)) {
        await upsertMembership(client, membership);
        summary.membershipRows += 1;
        summary.recordsWritten += 1;
      }
    }

    await pruneProjectRows(client, DAILY_TRACKER_PROJECT_ID, tasks.map(task => task.gid));
    await finishRun(client, runId, "success", summary);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    await finishRun(client, runId, "failed", {
      ...summary,
      error: error.message
    });
    throw error;
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error("Hawley Daily Assignment Tracker pull failed.");
  console.error(error.message);
  process.exitCode = 1;
});
