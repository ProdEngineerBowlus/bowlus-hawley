import pg from "pg";
import { getDatabaseConfig } from "./config.js";

const { Client } = pg;

const ASANA_API_BASE = "https://app.asana.com/api/1.0";
const ASANA_PAGE_SIZE = 100;
const DEFAULT_COMPLETED_SINCE = "1970-01-01T00:00:00.000Z";

const PORTFOLIOS = Object.freeze({
  fabrication: {
    gid: process.env.HAWLEY_ASANA_FABRICATION_PORTFOLIO_GID || "1212620750946278",
    expectedName: "Fabrication - 2026",
    taskType: "Cycle Project"
  },
  vin: {
    gid: process.env.HAWLEY_ASANA_VIN_PORTFOLIO_GID || "1212620750946276",
    expectedName: "VINs - 2026",
    taskType: "VIN Project"
  }
});

const PORTFOLIO_ALIASES = Object.freeze({
  both: ["fabrication", "vin"],
  all: ["fabrication", "vin"],
  cycle: ["fabrication"],
  fabrication: ["fabrication"],
  fab: ["fabrication"],
  vin: ["vin"],
  vins: ["vin"]
});

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

function parseArgs(argv) {
  const args = {
    portfolio: process.env.HAWLEY_ASANA_PORTFOLIO_SCOPE || "both",
    projectGid: "",
    limitProjects: 0,
    includeSubtasks: process.env.HAWLEY_ASANA_INCLUDE_SUBTASKS !== "false",
    subtaskDepth: Number(process.env.HAWLEY_ASANA_SUBTASK_DEPTH || 1),
    completedSince: process.env.HAWLEY_ASANA_COMPLETED_SINCE || DEFAULT_COMPLETED_SINCE
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--portfolio") args.portfolio = argv[++i] || args.portfolio;
    else if (arg.startsWith("--portfolio=")) args.portfolio = arg.slice("--portfolio=".length);
    else if (arg === "--project") args.projectGid = argv[++i] || "";
    else if (arg.startsWith("--project=")) args.projectGid = arg.slice("--project=".length);
    else if (arg === "--limit-projects") args.limitProjects = Number(argv[++i] || 0);
    else if (arg.startsWith("--limit-projects=")) args.limitProjects = Number(arg.slice("--limit-projects=".length));
    else if (arg === "--skip-subtasks") args.includeSubtasks = false;
    else if (arg === "--subtask-depth") args.subtaskDepth = Number(argv[++i] || 1);
    else if (arg.startsWith("--subtask-depth=")) args.subtaskDepth = Number(arg.slice("--subtask-depth=".length));
    else if (arg === "--completed-since") args.completedSince = argv[++i] || DEFAULT_COMPLETED_SINCE;
    else if (arg.startsWith("--completed-since=")) args.completedSince = arg.slice("--completed-since=".length);
    else if (arg === "-h" || arg === "--help") {
      console.log([
        "Usage: npm run pg:pull:asana -- [options]",
        "",
        "Options:",
        "  --portfolio both|fabrication|cycle|vin",
        "  --project GID          Pull one project under the selected portfolio context.",
        "  --limit-projects N     Limit project count for testing.",
        "  --skip-subtasks        Pull top-level project tasks only.",
        "  --subtask-depth N      Pull nested subtasks to this depth. Default: 1.",
        "  --completed-since ISO  Include completed tasks since this timestamp. Default: 1970-01-01."
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!PORTFOLIO_ALIASES[args.portfolio]) {
    throw new Error("--portfolio must be both, fabrication, cycle, or vin.");
  }
  if (args.projectGid && args.limitProjects > 0) {
    throw new Error("--project and --limit-projects cannot be combined.");
  }
  if (!Number.isFinite(args.subtaskDepth) || args.subtaskDepth < 0) {
    throw new Error("--subtask-depth must be a non-negative number.");
  }

  return args;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

      if (!response.ok) {
        throw new Error(`Asana ${options.method || "GET"} failed (${response.status}): ${text.slice(0, 700)}`);
      }

      return text ? JSON.parse(text) : {};
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
      const json = await this.request(`${path}?${search.toString()}`);
      rows.push(...(json.data || []));
      offset = json.next_page?.offset || "";
    } while (offset);

    return rows;
  }

  async getPortfolio(portfolioGid) {
    const json = await this.request(
      `/portfolios/${portfolioGid}?opt_fields=gid,name,workspace.gid,workspace.name`
    );
    return json.data;
  }

  async getPortfolioItems(portfolioGid) {
    const items = await this.fetchPaginated(`/portfolios/${portfolioGid}/items`, {
      opt_fields: "gid,name,resource_type"
    });
    return items.filter(item => item.resource_type === "project");
  }

  async getProject(projectGid) {
    const json = await this.request(`/projects/${projectGid}?opt_fields=${PROJECT_OPT_FIELDS}`);
    return json.data;
  }

  async getProjectTasks(projectGid, completedSince) {
    return this.fetchPaginated(`/projects/${projectGid}/tasks`, {
      completed_since: completedSince,
      opt_fields: TASK_OPT_FIELDS
    });
  }

  async getSubtasks(taskGid) {
    return this.fetchPaginated(`/tasks/${taskGid}/subtasks`, {
      opt_fields: TASK_OPT_FIELDS
    });
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

function json(value) {
  return JSON.stringify(value ?? null);
}

function asanaDate(value) {
  return value || null;
}

function firstMembershipSection(task, projectGid) {
  return (task.memberships || []).find(membership => membership.project?.gid === projectGid)?.section || null;
}

async function collectNestedSubtasks(asana, parentTask, sourceProject, depthRemaining) {
  if (depthRemaining <= 0 || Number(parentTask.num_subtasks || 0) <= 0) return [];

  const subtasks = await asana.getSubtasks(parentTask.gid);
  const parentSection = firstMembershipSection(parentTask, sourceProject.gid);
  const enriched = subtasks.map(subtask => ({
    ...subtask,
    _hawley_parent: {
      gid: parentTask.gid,
      name: parentTask.name,
      section: parentSection
    }
  }));

  if (depthRemaining <= 1) return enriched;

  const childLists = await mapLimit(enriched, 6, subtask =>
    collectNestedSubtasks(asana, subtask, sourceProject, depthRemaining - 1)
  );
  return enriched.concat(childLists.flat());
}

async function getProjectTaskTree(asana, project, args) {
  const topLevelTasks = await asana.getProjectTasks(project.gid, args.completedSince);
  if (!args.includeSubtasks || args.subtaskDepth === 0) return topLevelTasks;

  const parentsWithSubtasks = topLevelTasks.filter(task => Number(task.num_subtasks || 0) > 0);
  const subtaskLists = await mapLimit(parentsWithSubtasks, 6, task =>
    collectNestedSubtasks(asana, task, project, args.subtaskDepth)
  );

  const byGid = new Map();
  for (const task of topLevelTasks.concat(subtaskLists.flat())) {
    if (!byGid.has(task.gid)) byGid.set(task.gid, task);
  }
  return Array.from(byGid.values());
}

function parentGid(task) {
  return task.parent?.gid || task._hawley_parent?.gid || null;
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
      section: task._hawley_parent?.section || null
    }, true);
  }

  return [...rows.values()];
}

async function startRun(client) {
  const result = await client.query(
    `
      insert into sync.run_log (job_name, mode, status)
      values ('pull_asana', 'live-readonly', 'running')
      returning id
    `
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

async function upsertPortfolio(client, portfolio) {
  await client.query(
    `
      insert into raw.asana_portfolios
        (gid, name, workspace_gid, workspace_name, raw_json, synced_at)
      values
        ($1, $2, $3, $4, $5::jsonb, now())
      on conflict (gid) do update set
        name = excluded.name,
        workspace_gid = excluded.workspace_gid,
        workspace_name = excluded.workspace_name,
        raw_json = excluded.raw_json,
        synced_at = now()
    `,
    [
      portfolio.gid,
      portfolio.name || null,
      portfolio.workspace?.gid || null,
      portfolio.workspace?.name || null,
      json(portfolio)
    ]
  );
}

async function upsertPortfolioProject(client, portfolio, project, taskType, item) {
  await client.query(
    `
      insert into raw.asana_portfolio_projects
        (portfolio_gid, project_gid, portfolio_name, project_name, task_type, raw_json, synced_at)
      values
        ($1, $2, $3, $4, $5, $6::jsonb, now())
      on conflict (portfolio_gid, project_gid) do update set
        portfolio_name = excluded.portfolio_name,
        project_name = excluded.project_name,
        task_type = excluded.task_type,
        raw_json = excluded.raw_json,
        synced_at = now()
    `,
    [portfolio.gid, project.gid, portfolio.name || null, project.name || item.name || null, taskType, json(item)]
  );
}

async function prunePortfolioProjects(client, portfolioGid, projectGids) {
  if (!projectGids.length) return;
  await client.query(
    `
      delete from raw.asana_portfolio_projects
      where portfolio_gid = $1
        and not (project_gid = any($2::text[]))
    `,
    [portfolioGid, projectGids]
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

function selectedPortfolioKeys(args) {
  return PORTFOLIO_ALIASES[args.portfolio];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const asana = new AsanaClient(requiredEnv("ASANA_PAT"));
  const client = new Client(getDatabaseConfig());
  await client.connect();

  const summary = {
    portfolioScope: args.portfolio,
    includeSubtasks: args.includeSubtasks,
    subtaskDepth: args.subtaskDepth,
    completedSince: args.completedSince,
    portfolios: [],
    projects: 0,
    taskRowsFetched: 0,
    distinctTasks: 0,
    membershipRows: 0,
    recordsRead: 0,
    recordsWritten: 0
  };
  const distinctTaskGids = new Set();

  const runId = await startRun(client);

  try {
    for (const key of selectedPortfolioKeys(args)) {
      const config = PORTFOLIOS[key];
      const portfolio = await asana.getPortfolio(config.gid);
      await upsertPortfolio(client, portfolio);
      summary.recordsRead += 1;
      summary.recordsWritten += 1;

      const portfolioItems = args.projectGid
        ? [{ gid: args.projectGid, name: args.projectGid, resource_type: "project" }]
        : await asana.getPortfolioItems(config.gid);
      const scopedItems = args.limitProjects > 0 ? portfolioItems.slice(0, args.limitProjects) : portfolioItems;
      const currentProjectGids = scopedItems.map(item => item.gid);

      console.log(`Portfolio ${portfolio.name || config.expectedName}: ${scopedItems.length} projects`);

      for (const item of scopedItems) {
        const project = await asana.getProject(item.gid);
        await upsertProject(client, project);
        await upsertPortfolioProject(client, portfolio, project, config.taskType, item);
        summary.projects += 1;
        summary.recordsRead += 1;
        summary.recordsWritten += 2;

        console.log(`Fetching ${project.name} (${project.gid})`);
        const tasks = await getProjectTaskTree(asana, project, args);
        summary.taskRowsFetched += tasks.length;
        summary.recordsRead += tasks.length;

        for (const task of tasks) {
          distinctTaskGids.add(task.gid);
          await upsertTask(client, task, project);
          summary.recordsWritten += 1;

          const memberships = taskMembershipRows(task, project);
          for (const membership of memberships) {
            await upsertMembership(client, membership);
            summary.membershipRows += 1;
            summary.recordsWritten += 1;
          }
        }
      }

      if (!args.projectGid && args.limitProjects === 0) {
        await prunePortfolioProjects(client, portfolio.gid, currentProjectGids);
      }
      summary.portfolios.push({
        key,
        gid: portfolio.gid,
        name: portfolio.name || config.expectedName,
        projects: scopedItems.length
      });
    }

    summary.distinctTasks = distinctTaskGids.size;
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
  console.error("Hawley Asana pull failed.");
  console.error(error.message);
  process.exitCode = 1;
});
