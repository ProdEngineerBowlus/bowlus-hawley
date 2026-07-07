import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { getDatabaseConfig } from "../postgres-sync/src/config.js";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const appDir = path.dirname(__filename);
const staticDir = path.join(appDir, "public");

const HOST = process.env.HAWLEY_WORKER_HOST || "127.0.0.1";
const PORT = Number(process.env.HAWLEY_WORKER_PORT || 5273);

const pool = new Pool(getDatabaseConfig());

const CONTENT_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
});

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendError(res, status, message, details = {}) {
  sendJson(res, status, {
    ok: false,
    error: message,
    ...details
  });
}

function publicErrorMessage(error) {
  const message = error.message || "";
  if (/hawley_worker_page_assignments|task_work_area_inference|jsonb_display_text/.test(message)) {
    return {
      status: 503,
      message: "Hawley worker read model is not migrated yet. Run npm run pg:migrate."
    };
  }

  if (error.code === "ECONNREFUSED" || /connect ECONNREFUSED/i.test(message)) {
    return {
      status: 503,
      message: "Hawley Postgres is not reachable from this machine."
    };
  }

  if (error.code === "28P01") {
    return {
      status: 503,
      message: "Hawley Postgres credentials were rejected."
    };
  }

  if (error.code === "3D000") {
    return {
      status: 503,
      message: "Hawley Postgres database was not found."
    };
  }

  return {
    status: error.statusCode || 500,
    message: message || "Unexpected server error."
  };
}

function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function slugifyWorker({ workerEmail, workerName }) {
  const email = String(workerEmail || "").trim().toLowerCase();
  const emailForSlug = email.replace(/^asana\+/, "");
  if (emailForSlug) return `asana-${emailForSlug.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
  return `worker-${String(workerName || "unknown").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
}

function round(value, places = 2) {
  const num = Number(value || 0);
  const factor = 10 ** places;
  return Math.round(num * factor) / factor;
}

function minutesFromHours(hours) {
  return Math.round(Number(hours || 0) * 60);
}

function taskId(row) {
  return row.asana_task_gid || row.airtable_record_id || String(row.task_instance_id);
}

function publicLink(value) {
  const text = String(value || "").trim();
  if (!/^https?:\/\//i.test(text)) return "";
  return text;
}

function taskFromRow(row) {
  const estimatedHours = Number(row.estimated_hours || 0);
  return {
    id: taskId(row),
    taskInstanceId: row.task_instance_id,
    airtableRecordId: row.airtable_record_id,
    asanaTaskGid: row.asana_task_gid,
    title: row.task_name || "(Untitled task)",
    completed: Boolean(row.completed),
    status: row.completed ? "Done" : "Open",
    phase: row.phase_name || row.inferred_work_area_name || "",
    workArea: row.inferred_work_area_name || row.phase_name || row.section_column || "Unspecified",
    workAreaKey: row.inferred_work_area_key || "",
    cycle: row.cycle_name || "",
    vin: row.vin || "",
    estimatedHours: round(estimatedHours),
    estimatedMinutes: minutesFromHours(estimatedHours),
    actualTimeMinutes: Number(row.actual_time_minutes || 0),
    sourceUrl: publicLink(row.asana_permalink_url),
    sopUrl: publicLink(row.sop_link || row.document_link),
    sourceSyncedAt: row.source_synced_at,
    inferenceSource: row.inference_source || ""
  };
}

function buildWorkers(rows) {
  const byWorker = new Map();

  for (const row of rows) {
    const id = slugifyWorker({
      workerEmail: row.worker_email,
      workerName: row.worker_name
    });
    if (!byWorker.has(id)) {
      byWorker.set(id, {
        id,
        name: row.worker_name || row.worker_email || "Unassigned",
        email: row.worker_email || "",
        phase: row.inferred_work_area_name || row.phase_name || "",
        cycle: row.cycle_name || "",
        tasks: [],
        assignedHours: 0,
        completedHours: 0,
        remainingHours: 0,
        actualTimeMinutes: 0,
        completedTaskCount: 0,
        taskCount: 0,
        lastSyncedAt: row.source_synced_at || null
      });
    }

    const worker = byWorker.get(id);
    const task = taskFromRow(row);
    worker.tasks.push(task);
    worker.assignedHours += task.estimatedHours;
    worker.actualTimeMinutes += task.actualTimeMinutes;
    worker.taskCount += 1;
    if (task.completed) {
      worker.completedTaskCount += 1;
      worker.completedHours += task.estimatedHours;
    } else {
      worker.remainingHours += task.estimatedHours;
    }
    if (row.source_synced_at && (!worker.lastSyncedAt || new Date(row.source_synced_at) > new Date(worker.lastSyncedAt))) {
      worker.lastSyncedAt = row.source_synced_at;
    }
  }

  return Array.from(byWorker.values())
    .map(worker => ({
      ...worker,
      assignedHours: round(worker.assignedHours),
      completedHours: round(worker.completedHours),
      remainingHours: round(worker.remainingHours),
      status: worker.taskCount === 0 ? "No Work" : worker.remainingHours > 0 ? "Open" : "Complete",
      tasks: worker.tasks.sort((a, b) => Number(a.completed) - Number(b.completed) || a.workArea.localeCompare(b.workArea) || a.title.localeCompare(b.title))
    }))
    .sort((a, b) => {
      const openDelta = Number(b.remainingHours > 0) - Number(a.remainingHours > 0);
      if (openDelta) return openDelta;
      return a.name.localeCompare(b.name);
    });
}

function buildLineOverview(workers, date, latestRuns) {
  const assignedHours = workers.reduce((sum, worker) => sum + Number(worker.assignedHours || 0), 0);
  const completedHours = workers.reduce((sum, worker) => sum + Number(worker.completedHours || 0), 0);
  const remainingHours = workers.reduce((sum, worker) => sum + Number(worker.remainingHours || 0), 0);
  const taskCount = workers.reduce((sum, worker) => sum + Number(worker.taskCount || 0), 0);
  const completedTaskCount = workers.reduce((sum, worker) => sum + Number(worker.completedTaskCount || 0), 0);

  return {
    date,
    cycle: workers.find(worker => worker.cycle)?.cycle || "Current",
    assignedHours: round(assignedHours),
    completedHours: round(completedHours),
    remainingHours: round(remainingHours),
    taskCount,
    completedTaskCount,
    completionPercent: assignedHours ? round((completedHours / assignedHours) * 100, 1) : 0,
    latestRuns
  };
}

function buildManagerSignals(workers) {
  const openWorkers = workers.filter(worker => worker.remainingHours > 0);
  const noWorkWorkers = workers.filter(worker => worker.taskCount === 0);
  const openTasks = workers.reduce((sum, worker) => sum + worker.tasks.filter(task => !task.completed).length, 0);

  return {
    openWorkers: openWorkers.length,
    completeWorkers: workers.filter(worker => worker.taskCount > 0 && worker.remainingHours <= 0).length,
    noWorkWorkers: noWorkWorkers.length,
    openTasks,
    totalWorkers: workers.length
  };
}

async function latestImportRuns() {
  const result = await pool.query(`
    select distinct on (job_name)
      job_name,
      status,
      ended_at,
      records_read,
      records_written,
      error_count
    from sync.run_log
    where job_name in ('pull_airtable', 'pull_asana')
    order by job_name, id desc
  `);

  return Object.fromEntries(result.rows.map(row => [row.job_name, row]));
}

async function workerAssignments(date) {
  const params = [date];

  const result = await pool.query(
    `
      select *
      from reporting.hawley_worker_page_assignments
      where assigned_on = $1::date
      order by
        worker_name nulls last,
        completed,
        coalesce(inferred_work_area_name, phase_name, section_column, ''),
        task_name
    `,
    params
  );

  return result.rows;
}

async function dailyAssignmentsPayload(url) {
  const date = url.searchParams.get("date") || todayIso();
  const employee = url.searchParams.get("employee") || "";
  if (!isIsoDate(date)) {
    const error = new Error("Date must be YYYY-MM-DD.");
    error.statusCode = 400;
    throw error;
  }

  const [rows, latestRuns] = await Promise.all([
    workerAssignments(date),
    latestImportRuns()
  ]);
  const workers = buildWorkers(rows).filter(worker => !employee || worker.id === employee);

  return {
    ok: true,
    source: "hawley-postgres",
    mode: "read-only-pilot",
    date,
    employee: employee || null,
    lineOverview: employee ? null : buildLineOverview(workers, date, latestRuns),
    managerSignals: employee ? null : buildManagerSignals(workers),
    workers,
    latestRuns,
    refreshedAt: new Date().toISOString()
  };
}

async function healthPayload() {
  const [db, counts, latestRuns] = await Promise.all([
    pool.query("select current_database() as database_name, current_user as user_name, version() as postgres_version"),
    pool.query(`
      select
        (select count(*)::int from reporting.hawley_worker_page_assignments) as assignment_rows,
        (select count(distinct worker_email)::int from reporting.hawley_worker_page_assignments where worker_email is not null) as worker_count
    `),
    latestImportRuns()
  ]);

  return {
    ok: true,
    app: "hawley-worker-page",
    database: db.rows[0],
    counts: counts.rows[0],
    latestRuns
  };
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  const resolved = path.resolve(staticDir, requested);
  if (!resolved.startsWith(staticDir)) {
    sendError(res, 403, "Forbidden.");
    return;
  }

  try {
    const body = await fs.readFile(resolved);
    const ext = path.extname(resolved);
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    res.end(body);
  } catch (error) {
    if (error.code === "ENOENT") sendError(res, 404, "Not found.");
    else throw error;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);

  try {
    if (url.pathname === "/api/health") {
      sendJson(res, 200, await healthPayload());
      return;
    }

    if (url.pathname === "/api/daily-assignments" || url.pathname === "/api/assignments") {
      sendJson(res, 200, await dailyAssignmentsPayload(url));
      return;
    }

    if (url.pathname === "/api/worker-task-action" && req.method === "POST") {
      sendError(res, 409, "Hawley worker pilot is read-only. Timer and completion writes are not enabled yet.", {
        mode: "read-only-pilot"
      });
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendError(res, 405, "Method not allowed.");
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    const publicError = publicErrorMessage(error);
    sendError(res, publicError.status, publicError.message, {
      code: error.code || undefined
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Hawley worker pilot listening on http://${HOST}:${PORT}`);
});
