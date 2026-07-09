import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { getDatabaseConfig } from "../postgres-sync/src/config.js";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const appDir = path.dirname(__filename);
const repoRoot = path.resolve(appDir, "..", "..");
const staticDir = path.join(appDir, "public");

const HOST = process.env.HAWLEY_WORKER_HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const PORT = Number(process.env.PORT || process.env.HAWLEY_WORKER_PORT || 5273);
const DAILY_TRACKER_PROJECT_ID = process.env.HAWLEY_DAILY_TRACKER_PROJECT_GID || "1214157321063250";
const USE_DAT_SNAPSHOTS = process.env.HAWLEY_WORKER_USE_DAT_SNAPSHOTS === "true";
const INCLUDE_NO_WORK_WORKERS = process.env.HAWLEY_WORKER_INCLUDE_NO_WORK === "true";
const ASANA_EVENT_WATCH_INTERVAL_MS = Number(process.env.HAWLEY_ASANA_EVENT_INTERVAL_MS || 60000);
const ASANA_EVENT_WATCH_RESTART_MS = Number(process.env.HAWLEY_ASANA_EVENT_WATCH_RESTART_MS || 30000);
const WORKER_ACTUALS_WATCH_INTERVAL_MS = Number(process.env.HAWLEY_WORKER_ACTUALS_INTERVAL_MS || 60000);
const WORKER_ACTUALS_WATCH_RESTART_MS = Number(process.env.HAWLEY_WORKER_ACTUALS_WATCH_RESTART_MS || 30000);
const JACOB_R_WORKER_ID = process.env.HAWLEY_JACOB_R_WORKER_ID || "asana-asana-bowlus-com";
const JACOB_R_WORKER_NAME = process.env.HAWLEY_JACOB_R_NAME || "Jacob R";
const JACOB_R_WORKER_EMAIL = process.env.HAWLEY_JACOB_R_EMAIL || "asana@bowlus.com";
const JACOB_R_WORKER_PHASE = process.env.HAWLEY_JACOB_R_PHASE || "Management";
const WORKER_WRITES_ENABLED = booleanEnv("HAWLEY_WORKER_WRITES_ENABLED", true);
const WORKER_WRITES_ALL = booleanEnv("HAWLEY_WORKER_WRITES_ALL", true) || String(process.env.HAWLEY_WORKER_WRITE_IDS || "").trim() === "*";
const WORKER_WRITE_IDS = new Set(
  envList(process.env.HAWLEY_WORKER_WRITE_IDS || (WORKER_WRITES_ALL ? "" : JACOB_R_WORKER_ID))
    .map(canonicalWorkerIdForWrites)
    .filter(Boolean)
);
const LIVE_WORKER_SOURCE = "hawley_worker_live_pilot";

const pool = new Pool(getDatabaseConfig());
const writePool = new Pool(getDatabaseConfig({ useSyncUrl: true }));

const asanaEventWatcherState = {
  enabled: false,
  requested: false,
  running: false,
  pid: null,
  startedAt: "",
  lastOutputAt: "",
  lastExit: null,
  lastError: "",
  intervalMs: ASANA_EVENT_WATCH_INTERVAL_MS,
  restartMs: ASANA_EVENT_WATCH_RESTART_MS,
  mode: "web-service-sidecar",
  reason: ""
};
let asanaEventWatcherProcess = null;
let asanaEventWatcherRestartTimer = null;
let asanaEventWatcherStopping = false;

const workerActualsWatcherState = {
  enabled: false,
  requested: false,
  running: false,
  pid: null,
  startedAt: "",
  lastOutputAt: "",
  lastExit: null,
  lastError: "",
  intervalMs: WORKER_ACTUALS_WATCH_INTERVAL_MS,
  restartMs: WORKER_ACTUALS_WATCH_RESTART_MS,
  mode: "web-service-sidecar",
  reason: ""
};
let workerActualsWatcherProcess = null;
let workerActualsWatcherRestartTimer = null;
let workerActualsWatcherStopping = false;

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
  if (/hawley_worker_page_assignments|hawley_cycle_calendar|task_work_area_inference|work_force_capability_levels|airtable_worker_daily_actuals|jsonb_display_text/.test(message)) {
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

function booleanEnv(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  return ["1", "true", "yes", "y", "on"].includes(String(value).trim().toLowerCase());
}

function envList(value) {
  return String(value || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
}

function canonicalWorkerIdForWrites(value) {
  const id = String(value || "").trim();
  if (["hawley-jacob-r", "jacob-r", "jacob-rhodes", JACOB_R_WORKER_EMAIL].includes(id.toLowerCase())) {
    return JACOB_R_WORKER_ID;
  }
  return id;
}

function isJacobRWorker(worker) {
  return Boolean(
    canonicalWorkerIdForWrites(worker?.id) === JACOB_R_WORKER_ID ||
    String(worker?.email || "").trim().toLowerCase() === JACOB_R_WORKER_EMAIL.toLowerCase()
  );
}

function workerWritesAllowed(workerId) {
  const id = canonicalWorkerIdForWrites(workerId);
  if (!WORKER_WRITES_ENABLED || !id || id === "worker-unknown") return false;
  if (WORKER_WRITES_ALL) return true;
  return WORKER_WRITE_IDS.has(id);
}

function workerWriteIds() {
  return WORKER_WRITES_ALL ? ["*"] : Array.from(WORKER_WRITE_IDS);
}

function shouldStartAsanaEventWatcher() {
  if (process.env.HAWLEY_ASANA_EVENT_WATCH_IN_WEB !== undefined) {
    return booleanEnv("HAWLEY_ASANA_EVENT_WATCH_IN_WEB", false);
  }
  return process.env.NODE_ENV === "production";
}

function shouldStartWorkerActualsWatcher() {
  if (process.env.HAWLEY_WORKER_ACTUALS_WATCH_IN_WEB !== undefined) {
    return booleanEnv("HAWLEY_WORKER_ACTUALS_WATCH_IN_WEB", false);
  }
  return process.env.NODE_ENV === "production";
}

function syncDatabaseConfigured() {
  return Boolean(process.env.HAWLEY_SYNC_DATABASE_URL || process.env.HAWLEY_MIGRATION_DATABASE_URL);
}

function asanaEventWatcherStatus() {
  return { ...asanaEventWatcherState };
}

function workerActualsWatcherStatus() {
  return { ...workerActualsWatcherState };
}

function watcherStatuses() {
  return {
    asanaEvents: asanaEventWatcherStatus(),
    workerDailyActuals: workerActualsWatcherStatus()
  };
}

function logWatcherStream(streamName, chunk) {
  const lines = String(chunk)
    .split(/\r?\n/)
    .filter(Boolean);
  for (const line of lines) {
    asanaEventWatcherState.lastOutputAt = new Date().toISOString();
    if (streamName === "stderr") {
      asanaEventWatcherState.lastError = line.slice(0, 1000);
      console.error(`[hawley-asana-events] ${line}`);
    } else {
      console.log(`[hawley-asana-events] ${line}`);
    }
  }
}

function logWorkerActualsWatcherStream(streamName, chunk) {
  const lines = String(chunk)
    .split(/\r?\n/)
    .filter(Boolean);
  for (const line of lines) {
    workerActualsWatcherState.lastOutputAt = new Date().toISOString();
    if (streamName === "stderr") {
      workerActualsWatcherState.lastError = line.slice(0, 1000);
      console.error(`[hawley-worker-actuals] ${line}`);
    } else {
      console.log(`[hawley-worker-actuals] ${line}`);
    }
  }
}

function startAsanaEventWatcher() {
  asanaEventWatcherState.requested = shouldStartAsanaEventWatcher();
  asanaEventWatcherState.enabled = false;
  asanaEventWatcherState.reason = "";

  if (!asanaEventWatcherState.requested) {
    asanaEventWatcherState.reason = "disabled";
    return;
  }

  if (!process.env.ASANA_PAT) {
    asanaEventWatcherState.reason = "missing ASANA_PAT";
    console.warn("Hawley Asana event watcher disabled: missing ASANA_PAT.");
    return;
  }

  if (!syncDatabaseConfigured()) {
    asanaEventWatcherState.reason = "missing HAWLEY_SYNC_DATABASE_URL or HAWLEY_MIGRATION_DATABASE_URL";
    console.warn("Hawley Asana event watcher disabled: missing sync database URL.");
    return;
  }

  if (!Number.isFinite(ASANA_EVENT_WATCH_INTERVAL_MS) || ASANA_EVENT_WATCH_INTERVAL_MS < 15000) {
    asanaEventWatcherState.reason = "invalid HAWLEY_ASANA_EVENT_INTERVAL_MS";
    console.warn("Hawley Asana event watcher disabled: interval must be at least 15000 ms.");
    return;
  }

  asanaEventWatcherState.enabled = true;
  asanaEventWatcherState.reason = "running";
  spawnAsanaEventWatcher();
}

function spawnAsanaEventWatcher() {
  if (asanaEventWatcherStopping || asanaEventWatcherProcess) return;

  const args = [
    "./apps/postgres-sync/src/pull-asana-events.js",
    "--loop",
    "--interval-ms",
    String(ASANA_EVENT_WATCH_INTERVAL_MS)
  ];

  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  asanaEventWatcherProcess = child;
  asanaEventWatcherState.running = true;
  asanaEventWatcherState.pid = child.pid || null;
  asanaEventWatcherState.startedAt = new Date().toISOString();
  asanaEventWatcherState.lastExit = null;
  asanaEventWatcherState.lastError = "";
  asanaEventWatcherState.reason = "running";

  child.stdout.on("data", chunk => logWatcherStream("stdout", chunk));
  child.stderr.on("data", chunk => logWatcherStream("stderr", chunk));
  child.on("error", error => {
    asanaEventWatcherState.lastError = error.message;
    asanaEventWatcherState.reason = "spawn failed";
    console.error(`Hawley Asana event watcher failed to start: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    asanaEventWatcherProcess = null;
    asanaEventWatcherState.running = false;
    asanaEventWatcherState.pid = null;
    asanaEventWatcherState.lastExit = {
      code,
      signal,
      at: new Date().toISOString()
    };

    if (asanaEventWatcherStopping || !asanaEventWatcherState.enabled) {
      asanaEventWatcherState.reason = "stopped";
      return;
    }

    asanaEventWatcherState.reason = "restarting";
    const restartMs = Number.isFinite(ASANA_EVENT_WATCH_RESTART_MS) && ASANA_EVENT_WATCH_RESTART_MS >= 0
      ? ASANA_EVENT_WATCH_RESTART_MS
      : 30000;
    console.warn(`Hawley Asana event watcher exited; restarting in ${restartMs} ms.`);
    asanaEventWatcherRestartTimer = setTimeout(() => {
      asanaEventWatcherRestartTimer = null;
      spawnAsanaEventWatcher();
    }, restartMs);
    asanaEventWatcherRestartTimer.unref?.();
  });
}

function stopAsanaEventWatcher(signal = "SIGTERM") {
  asanaEventWatcherStopping = true;
  if (asanaEventWatcherRestartTimer) {
    clearTimeout(asanaEventWatcherRestartTimer);
    asanaEventWatcherRestartTimer = null;
  }
  if (asanaEventWatcherProcess && !asanaEventWatcherProcess.killed) {
    asanaEventWatcherProcess.kill(signal);
  }
}

function startWorkerActualsWatcher() {
  workerActualsWatcherState.requested = shouldStartWorkerActualsWatcher();
  workerActualsWatcherState.enabled = false;
  workerActualsWatcherState.reason = "";

  if (!workerActualsWatcherState.requested) {
    workerActualsWatcherState.reason = "disabled";
    return;
  }

  if (!process.env.AIRTABLE_PAT || !process.env.AIRTABLE_BASE) {
    workerActualsWatcherState.reason = "missing AIRTABLE_PAT or AIRTABLE_BASE";
    console.warn("Hawley Worker Daily Task Actuals watcher disabled: missing Airtable configuration.");
    return;
  }

  if (!syncDatabaseConfigured()) {
    workerActualsWatcherState.reason = "missing HAWLEY_SYNC_DATABASE_URL or HAWLEY_MIGRATION_DATABASE_URL";
    console.warn("Hawley Worker Daily Task Actuals watcher disabled: missing sync database URL.");
    return;
  }

  if (!Number.isFinite(WORKER_ACTUALS_WATCH_INTERVAL_MS) || WORKER_ACTUALS_WATCH_INTERVAL_MS < 15000) {
    workerActualsWatcherState.reason = "invalid HAWLEY_WORKER_ACTUALS_INTERVAL_MS";
    console.warn("Hawley Worker Daily Task Actuals watcher disabled: interval must be at least 15000 ms.");
    return;
  }

  workerActualsWatcherState.enabled = true;
  workerActualsWatcherState.reason = "running";
  spawnWorkerActualsWatcher();
}

function spawnWorkerActualsWatcher() {
  if (workerActualsWatcherStopping || workerActualsWatcherProcess) return;

  const args = [
    "./apps/postgres-sync/src/pull-worker-daily-actuals.js",
    "--loop",
    "--interval-ms",
    String(WORKER_ACTUALS_WATCH_INTERVAL_MS)
  ];

  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  workerActualsWatcherProcess = child;
  workerActualsWatcherState.running = true;
  workerActualsWatcherState.pid = child.pid || null;
  workerActualsWatcherState.startedAt = new Date().toISOString();
  workerActualsWatcherState.lastExit = null;
  workerActualsWatcherState.lastError = "";
  workerActualsWatcherState.reason = "running";

  child.stdout.on("data", chunk => logWorkerActualsWatcherStream("stdout", chunk));
  child.stderr.on("data", chunk => logWorkerActualsWatcherStream("stderr", chunk));
  child.on("error", error => {
    workerActualsWatcherState.lastError = error.message;
    workerActualsWatcherState.reason = "spawn failed";
    console.error(`Hawley Worker Daily Task Actuals watcher failed to start: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    workerActualsWatcherProcess = null;
    workerActualsWatcherState.running = false;
    workerActualsWatcherState.pid = null;
    workerActualsWatcherState.lastExit = {
      code,
      signal,
      at: new Date().toISOString()
    };

    if (workerActualsWatcherStopping || !workerActualsWatcherState.enabled) {
      workerActualsWatcherState.reason = "stopped";
      return;
    }

    workerActualsWatcherState.reason = "restarting";
    const restartMs = Number.isFinite(WORKER_ACTUALS_WATCH_RESTART_MS) && WORKER_ACTUALS_WATCH_RESTART_MS >= 0
      ? WORKER_ACTUALS_WATCH_RESTART_MS
      : 30000;
    console.warn(`Hawley Worker Daily Task Actuals watcher exited; restarting in ${restartMs} ms.`);
    workerActualsWatcherRestartTimer = setTimeout(() => {
      workerActualsWatcherRestartTimer = null;
      spawnWorkerActualsWatcher();
    }, restartMs);
    workerActualsWatcherRestartTimer.unref?.();
  });
}

function stopWorkerActualsWatcher(signal = "SIGTERM") {
  workerActualsWatcherStopping = true;
  if (workerActualsWatcherRestartTimer) {
    clearTimeout(workerActualsWatcherRestartTimer);
    workerActualsWatcherRestartTimer = null;
  }
  if (workerActualsWatcherProcess && !workerActualsWatcherProcess.killed) {
    workerActualsWatcherProcess.kill(signal);
  }
}

async function applyRuntimeReadGrants() {
  if (!process.env.HAWLEY_SYNC_DATABASE_URL && !process.env.HAWLEY_MIGRATION_DATABASE_URL) return;

  const client = new pg.Client(getDatabaseConfig({ useSyncUrl: true }));
  await client.connect();
  try {
    const grantStatements = [
      "grant usage on schema raw, core, calc, reporting, sync, hb, ops to bowlus_app",
      "grant select on all tables in schema raw, sync, hb, ops, calc, reporting to bowlus_app",
      "grant select on all tables in schema hb, ops, calc, reporting to bowlus_readonly",
      "alter default privileges in schema raw, sync, hb, ops, calc, reporting grant select on tables to bowlus_app",
      "alter default privileges in schema hb, ops, calc, reporting grant select on tables to bowlus_readonly"
    ];

    for (const statement of grantStatements) {
      await client.query(statement);
    }
    console.log("Hawley runtime read grants verified.");
  } finally {
    await client.end();
  }
}

function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function booleanQuery(value) {
  return ["1", "true", "yes", "y"].includes(String(value || "").trim().toLowerCase());
}

function dateFromIso(value) {
  if (!isIsoDate(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoDateFromDate(date) {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function cycleNumberFromName(value) {
  const match = String(value || "").match(/\d+/);
  return match ? Number(match[0]) : null;
}

function normalizedIsoDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
  return isoDateFromDate(date);
}

function holidayDatesFromField(value, fallbackYear) {
  const holidays = new Set();
  const year = Number(String(fallbackYear || "").slice(0, 4)) || new Date().getFullYear();

  const addFromText = (text) => {
    const source = String(text || "");
    for (const match of source.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) {
      const iso = normalizedIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));
      if (iso) holidays.add(iso);
    }
    for (const match of source.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)) {
      const parsedYear = match[3]
        ? Number(match[3].length === 2 ? `20${match[3]}` : match[3])
        : year;
      const iso = normalizedIsoDate(parsedYear, Number(match[1]), Number(match[2]));
      if (iso) holidays.add(iso);
    }
  };

  const visit = (item) => {
    if (Array.isArray(item)) {
      item.forEach(visit);
    } else if (item && typeof item === "object") {
      Object.values(item).forEach(visit);
    } else {
      addFromText(item);
    }
  };

  visit(value);
  return holidays;
}

function cycleWorkdays(startDate, endDate, holidays, daysInCycle) {
  const start = dateFromIso(startDate);
  if (!start) return [];

  const end = dateFromIso(endDate);
  const limit = Number(daysInCycle || 0);
  const dates = [];
  let cursor = start;
  let guard = 0;

  while (guard < 400 && (end ? cursor <= end : !limit || dates.length < limit)) {
    const iso = isoDateFromDate(cursor);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6 && !holidays.has(iso)) {
      dates.push(iso);
    }
    cursor = addUtcDays(cursor, 1);
    guard += 1;
  }

  return limit ? dates.slice(0, limit) : dates;
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

function cleanDisplayList(value) {
  const seen = new Set();
  return String(value || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean)
    .filter(item => {
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(", ");
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function formatCycleName(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^c\d+$/i.test(text)) return `C${text.replace(/^c/i, "")}`;
  if (/^\d+$/.test(text)) return `C${text}`;
  return text;
}

function formatPhaseName(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^phase\s+[a-z]$/i.test(text)) return `Phase ${text.slice(-1).toUpperCase()}`;
  if (/^[a-z]$/i.test(text)) return `Phase ${text.toUpperCase()}`;
  return text;
}

function formatPhaseList(value) {
  return cleanDisplayList(value)
    .split(",")
    .map(item => formatPhaseName(item))
    .filter(Boolean)
    .join(", ");
}

function taskFromRow(row) {
  const estimatedHours = Number(row.estimated_hours || 0);
  const phase = formatPhaseName(row.phase_name || row.inferred_work_area_name);
  const workArea = formatPhaseName(row.inferred_work_area_name || row.phase_name || row.section_column || "Unspecified");
  return {
    id: taskId(row),
    taskInstanceId: row.task_instance_id,
    airtableRecordId: row.airtable_record_id,
    asanaTaskGid: row.asana_task_gid,
    title: row.task_name || "(Untitled task)",
    completed: Boolean(row.completed),
    status: row.completed ? "Done" : "Open",
    phase,
    workArea,
    workAreaKey: row.inferred_work_area_key || "",
    cycle: formatCycleName(row.cycle_name),
    vin: row.vin || "",
    assignedHours: round(estimatedHours),
    targetHours: round(estimatedHours),
    estimatedHours: round(estimatedHours),
    estimatedMinutes: minutesFromHours(estimatedHours),
    actualTimeMinutes: Number(row.actual_time_minutes || 0),
    actualTimeOnDateMinutes: Number(row.actual_time_minutes || 0),
    sourceUrl: publicLink(row.asana_permalink_url),
    trackerUrl: "",
    sopUrl: publicLink(row.sop_link || row.document_link),
    sourceSyncedAt: row.source_synced_at,
    inferenceSource: row.inference_source || ""
  };
}

function emptyWorkerFromRow(row) {
  const id = slugifyWorker({
    workerEmail: row.worker_email,
    workerName: row.worker_name
  });

  return {
    id,
    name: row.worker_name || row.worker_email || "Unassigned",
    email: row.worker_email || "",
    phase: formatPhaseList(row.home_section_column || row.work_area_name),
    cycle: "",
    workBlock: "",
    trackerStatus: "No Work",
    trackerUrl: "",
    targetHours: Number(row.hours_per_day || 7.5),
    tasks: [],
    assignedHours: 0,
    completedHours: 0,
    remainingHours: 0,
    actualTimeMinutes: 0,
    actualTimeLoggedMinutes: 0,
    completedTaskCount: 0,
    taskCount: 0,
    lastSyncedAt: null,
    status: "No Work"
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
        phase: formatPhaseName(row.inferred_work_area_name || row.phase_name),
        cycle: formatCycleName(row.cycle_name),
        workBlock: formatPhaseName(row.inferred_work_area_name || row.phase_name),
        trackerStatus: "No Work",
        trackerUrl: "",
        targetHours: 7.5,
        tasks: [],
        assignedHours: 0,
        completedHours: 0,
        remainingHours: 0,
        actualTimeMinutes: 0,
        actualTimeLoggedMinutes: 0,
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
      trackerStatus: worker.taskCount === 0 ? "No Work" : worker.remainingHours > 0 ? "Assigned" : "Complete",
      actualTimeLoggedMinutes: Number(worker.actualTimeMinutes || 0),
      tasks: worker.tasks.sort((a, b) => Number(a.completed) - Number(b.completed) || a.workArea.localeCompare(b.workArea) || a.title.localeCompare(b.title))
    }))
    .sort((a, b) => {
      const openDelta = Number(b.remainingHours > 0) - Number(a.remainingHours > 0);
      if (openDelta) return openDelta;
      return a.name.localeCompare(b.name);
    });
}

function mergeConfiguredWorkers(workers, configuredRows) {
  const assignedById = new Map(workers.map(worker => [worker.id, { ...worker }]));
  const byId = new Map();

  for (const row of configuredRows) {
    const configured = emptyWorkerFromRow(row);
    if (!configured.id || configured.id === "worker-unknown") continue;

    const assigned = assignedById.get(configured.id);
    const worker = assigned ? { ...assigned } : configured;

    worker.name = worker.name || configured.name;
    worker.email = worker.email || configured.email;
    worker.phase = worker.phase || configured.phase;
    worker.targetHours = configured.targetHours || worker.targetHours;
    byId.set(configured.id, worker);
  }

  return Array.from(byId.values()).sort((a, b) => {
    const openDelta = Number(b.remainingHours > 0) - Number(a.remainingHours > 0);
    if (openDelta) return openDelta;
    const workDelta = Number(b.taskCount > 0) - Number(a.taskCount > 0);
    if (workDelta) return workDelta;
    return a.name.localeCompare(b.name);
  });
}

function workerHasVisibleWork(worker) {
  return Boolean(
    isJacobRWorker(worker) ||
    Number(worker.assignedHours || 0) > 0 ||
    Number(worker.remainingHours || 0) > 0 ||
    Number(worker.completedHours || 0) > 0 ||
    Number(worker.taskCount || 0) > 0 ||
    (worker.tasks || []).length > 0 ||
    Number(worker.actualTimeLoggedMinutes || worker.actualTimeMinutes || 0) > 0 ||
    (worker.dailyEfficiency && Number(worker.dailyEfficiency.loggedMinutes || 0) > 0)
  );
}

function visibleWorkersForRequest(workers, employee, includeNoWork) {
  return (workers || []).filter(worker => {
    if (employee) return worker.id === employee;
    if (includeNoWork) return true;
    return workerHasVisibleWork(worker);
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
  const workerList = Array.isArray(workers) ? workers : [];
  const workersWithWork = workerList.filter(worker => Number(worker.assignedHours || 0) > 0 || worker.tasks.some(task => !task.completed));
  const openWorkers = workerList.filter(worker => worker.remainingHours > 0);
  const noWorkWorkers = workerList.filter(worker => worker.taskCount === 0);
  const openTasks = workers.reduce((sum, worker) => sum + worker.tasks.filter(task => !task.completed).length, 0);
  const actualTimeLoggedMinutes = workerList.reduce((sum, worker) => sum + Number(worker.actualTimeLoggedMinutes || worker.actualTimeMinutes || 0), 0);
  const targetMinutes = workersWithWork.length * 7.5 * 60;

  return {
    workerCount: workerList.length,
    workersWithWork: workersWithWork.length,
    openWorkers: openWorkers.length,
    completeWorkers: workerList.filter(worker => worker.taskCount > 0 && worker.remainingHours <= 0).length,
    noWorkWorkers: noWorkWorkers.length,
    openTasks,
    openTaskCount: openTasks,
    runningCount: 0,
    remainingHours: round(workerList.reduce((sum, worker) => sum + Number(worker.remainingHours || 0), 0)),
    actualTimeLoggedMinutes,
    actualTimeLoggedHours: round(actualTimeLoggedMinutes / 60),
    targetMinutes,
    targetHours: round(targetMinutes / 60),
    pacingDeltaMinutes: actualTimeLoggedMinutes - targetMinutes,
    outlierCount: 0,
    outliers: [],
    totalWorkers: workerList.length
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function fieldsByName(fields) {
  return asArray(fields).reduce((result, field) => {
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

function numberValue(field) {
  if (!field || field.number_value === null || field.number_value === undefined) return 0;
  return Number(field.number_value);
}

function dateValue(field) {
  if (!field) return "";
  if (field.date_value?.date) return field.date_value.date;
  return field.display_value ? String(field.display_value).slice(0, 10) : "";
}

function numberFromField(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return value;
  const cleaned = String(value).replace(/[^0-9.\-]+/g, "");
  return cleaned ? Number(cleaned) : 0;
}

function booleanFromField(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined) return false;
  return /^(true|1|yes|y|checked)$/i.test(String(value).trim());
}

function displayPhaseLabel(phaseLabel, phaseBucket) {
  const explicit = String(phaseLabel || "").trim();
  const bucket = String(phaseBucket || "").trim();
  if (explicit && !/^rec[A-Za-z0-9]{14,}$/i.test(explicit)) return formatPhaseName(explicit);

  const bucketPhase = bucket
    .split("-")
    .slice(1)
    .join("-")
    .trim();
  return formatPhaseName(bucketPhase) || explicit;
}

function sourceTaskUrl(taskId) {
  return `https://app.asana.com/1/829365006370166/task/${taskId}`;
}

function taskIdFromUrl(value) {
  const match = String(value || "").match(/task\/(\d+)/);
  return match ? match[1] : "";
}

function parseSnapshotPayload(value) {
  const text = String(value || "").trim();
  if (!text.startsWith("[")) return [];

  try {
    return JSON.parse(text).map(item => ({
      id: item.gid,
      title: item.taskName || `Source task ${item.gid}`,
      assignedHours: Number(item.estimatedHours || 0),
      targetHours: Number(item.estimatedHours || 0),
      cycle: Array.isArray(item.taskCycleLabels) ? item.taskCycleLabels.map(formatCycleName).join(", ") : "",
      phase: displayPhaseLabel(item.phaseLabel, item.phaseBucketKey),
      phaseBucket: item.phaseBucketKey || "",
      order: item.taskOrder,
      vin: item.vin,
      sourceUrl: item.gid ? sourceTaskUrl(item.gid) : "",
      trackerUrl: "",
      completed: false
    }));
  } catch (error) {
    return [];
  }
}

function parseAssignedTaskBreakdown(notes) {
  const lines = String(notes || "").split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === "Assigned Task Breakdown");
  if (start === -1) return [];

  const rows = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    if (/^[A-Z][A-Za-z ]+$/.test(line) && !line.startsWith("- ")) break;
    if (!line.startsWith("- [")) continue;

    const columns = line.replace(/^- /, "").split(" | ");
    const completed = columns[0].includes("[x]");
    const hasOutlier = columns.length >= 8;
    const cycleIndex = hasOutlier ? 2 : 1;
    const hoursIndex = hasOutlier ? 3 : 2;
    const targetIndex = hasOutlier ? 4 : 3;
    const titleIndex = hasOutlier ? 5 : 4;
    const trackerIndex = hasOutlier ? 6 : 5;
    const sourceIndex = hasOutlier ? 7 : 6;
    const sourceUrl = columns[sourceIndex] || columns[trackerIndex] || "";

    rows.push({
      id: taskIdFromUrl(sourceUrl) || taskIdFromUrl(columns[trackerIndex]) || slugify(columns[titleIndex] || ""),
      completed,
      outlierFlag: hasOutlier ? columns[1] : "",
      cycle: formatCycleName(columns[cycleIndex] || ""),
      assignedHours: Number(String(columns[hoursIndex] || 0).replace(/[^0-9.\-]+/g, "")),
      targetHours: Number(String(columns[targetIndex] || 0).replace(/[^0-9.\-]+/g, "")),
      title: columns[titleIndex] || "Untitled task",
      trackerUrl: publicLink(columns[trackerIndex]),
      sourceUrl: publicLink(sourceUrl)
    });
  }

  return rows;
}

function chooseTaskTitle(noteTask, payloadTask) {
  const noteTitle = String(noteTask?.title || "").trim();
  const payloadTitle = String(payloadTask?.title || "").trim();
  const noteIsFallback = /^Source task \d+$/i.test(noteTitle);
  const payloadIsFallback = /^Source task \d+$/i.test(payloadTitle);

  if (noteTitle && !noteIsFallback) return noteTitle;
  if (payloadTitle && !payloadIsFallback) return payloadTitle;
  return noteTitle || payloadTitle || "Untitled task";
}

function mergeTaskRows(noteTasks, payloadTasks) {
  if (!noteTasks.length) return payloadTasks;
  const payloadById = new Map(payloadTasks.map(task => [task.id, task]));

  return noteTasks.map(task => ({
    ...(payloadById.get(task.id) || {}),
    ...task,
    title: chooseTaskTitle(task, payloadById.get(task.id))
  }));
}

function normalizeTrackerSnapshot(row) {
  const raw = row.raw_json || {};
  const fields = fieldsByName(asArray(row.custom_fields_json).length ? row.custom_fields_json : raw.custom_fields);
  const sectionNames = asArray(raw.memberships)
    .map(membership => membership.section?.name)
    .filter(Boolean);

  return {
    gid: row.gid,
    name: row.name,
    notes: raw.notes || "",
    dueOn: row.due_on || "",
    completed: Boolean(row.completed),
    url: publicLink(row.permalink_url),
    sectionNames,
    archivedSection: sectionNames.some(name => /\barchive\b/i.test(name)),
    trackerDate: dateValue(fields["Tracker Date"]) || row.due_on || "",
    trackerType: textValue(fields["Tracker Type"]) || textValue(fields["Tracker Model"]),
    trackerStatus: textValue(fields["Tracker Status"]),
    cycle: formatCycleName(textValue(fields["Cycle Label"])),
    primaryWorker: textValue(fields["Primary Worker"]),
    workerEmail: textValue(fields["Worker Email"]),
    workerCycleKey: textValue(fields["Worker Cycle Key"]),
    phase: formatPhaseName(textValue(fields["Primary Phase"])),
    phaseBucket: textValue(fields["Phase Bucket"]),
    workBlock: formatPhaseName(textValue(fields["Work Block Label"])),
    snapshotPayload: textValue(fields["Snapshot Payload"]),
    assignedHours: numberValue(fields["Assigned Hours"]),
    completedHours: numberValue(fields["Completed Assigned Hours"]),
    actualHours: numberValue(fields["Actual Hours Logged"]),
    remainingHours: numberValue(fields["Remaining Assigned Hours"]),
    taskCount: numberValue(fields["Snapshot Task Count"]) || numberValue(fields["Task Link Count"]),
    completedTaskCount: numberValue(fields["Completed Task Count"]),
    targetHours: numberValue(fields["Target Hours"]),
    capacityHours: numberValue(fields["Capacity Hours"]),
    capacityDeltaHours: numberValue(fields["Capacity Delta Hours"]),
    completionPercent: numberValue(fields["Completion %"]),
    loadCapacityPercent: numberValue(fields["Load / Capacity %"]),
    taskOrderRange: textValue(fields["Task Order Range"]),
    vinRange: textValue(fields["VIN Range"]),
    supportWorkers: textValue(fields["Support Workers"]),
    syncedAt: row.synced_at || null
  };
}

function latestActiveTrackerDate(snapshots) {
  const dates = snapshots
    .map(snapshot => snapshot.trackerDate)
    .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")));
  return dates.length ? dates.sort().at(-1) : "";
}

function snapshotWorkerId(snapshot) {
  const email = snapshot.workerEmail && snapshot.workerEmail !== "Unmapped" ? snapshot.workerEmail : "";
  if (email) return slugifyWorker({ workerEmail: email, workerName: snapshot.primaryWorker });
  return slugify(snapshot.workerCycleKey || snapshot.primaryWorker || snapshot.gid);
}

function snapshotToWorker(snapshot) {
  const payloadTasks = parseSnapshotPayload(snapshot.snapshotPayload);
  const noteTasks = parseAssignedTaskBreakdown(snapshot.notes);
  const tasks = mergeTaskRows(noteTasks, payloadTasks);
  const email = snapshot.workerEmail && snapshot.workerEmail !== "Unmapped" ? snapshot.workerEmail : "";

  return {
    id: snapshotWorkerId(snapshot),
    name: snapshot.primaryWorker || workerNameFromTitle(snapshot.name),
    email,
    cycle: snapshot.cycle,
    phase: snapshot.phase,
    phaseBucket: snapshot.phaseBucket,
    phases: snapshot.phase ? [snapshot.phase] : [],
    workBlock: snapshot.workBlock,
    workBlocks: snapshot.workBlock ? [snapshot.workBlock] : [],
    trackerStatus: snapshot.trackerStatus,
    trackerUrl: snapshot.url,
    trackerUrls: snapshot.url ? [snapshot.url] : [],
    assignedHours: snapshot.assignedHours,
    completedHours: snapshot.completedHours,
    remainingHours: snapshot.remainingHours,
    actualHours: snapshot.actualHours,
    actualTimeLoggedHours: snapshot.actualHours,
    actualTimeLoggedMinutes: minutesFromHours(snapshot.actualHours),
    targetHours: snapshot.targetHours,
    taskCount: snapshot.taskCount || tasks.length,
    completedTaskCount: snapshot.completedTaskCount || tasks.filter(task => task.completed).length,
    taskOrderRange: snapshot.taskOrderRange,
    vinRange: snapshot.vinRange,
    vinRanges: snapshot.vinRange ? [snapshot.vinRange] : [],
    supportWorkers: snapshot.supportWorkers,
    tasks,
    lastSyncedAt: snapshot.syncedAt
  };
}

function workerNameFromTitle(title) {
  const parts = String(title || "").split("|").map(part => part.trim());
  return parts.at(-1) || "Worker";
}

function mergeUnique(existing, incoming) {
  return Array.from(new Set([...(existing || []), ...(incoming || [])].filter(Boolean)));
}

function splitMultiValue(value) {
  if (!value) return [];
  return String(value).split(",").map(item => item.trim()).filter(Boolean);
}

function formatMergedValue(values) {
  const unique = mergeUnique([], values);
  if (!unique.length) return "";
  if (unique.length <= 3) return unique.join(", ");
  return `${unique.length} values`;
}

function mergeStatus(left, right) {
  if (left === right) return left;
  if (left === "Assigned" || right === "Assigned") return "Assigned";
  if (left === "Alert" || right === "Alert") return "Alert";
  return left || right || "";
}

function mergeTaskLists(existingTasks, nextTasks) {
  const tasksById = new Map();

  for (const task of [...(existingTasks || []), ...(nextTasks || [])]) {
    const key = task.id || `${task.title}-${task.cycle}-${task.vin}-${task.order}`;
    if (!tasksById.has(key)) tasksById.set(key, task);
  }

  return Array.from(tasksById.values());
}

function mergeWorkerSnapshot(workers, nextWorker) {
  const existing = workers.find(worker => worker.id === nextWorker.id);
  if (!existing) {
    workers.push(nextWorker);
    return workers;
  }

  existing.assignedHours += Number(nextWorker.assignedHours || 0);
  existing.completedHours += Number(nextWorker.completedHours || 0);
  existing.remainingHours += Number(nextWorker.remainingHours || 0);
  existing.actualHours += Number(nextWorker.actualHours || 0);
  existing.targetHours = Math.max(Number(existing.targetHours || 0), Number(nextWorker.targetHours || 0));
  existing.completedTaskCount += Number(nextWorker.completedTaskCount || 0);
  existing.tasks = mergeTaskLists(existing.tasks, nextWorker.tasks);
  existing.taskCount = existing.tasks.length;
  existing.phases = mergeUnique(existing.phases, splitMultiValue(nextWorker.phase));
  existing.workBlocks = mergeUnique(existing.workBlocks, splitMultiValue(nextWorker.workBlock));
  existing.vinRanges = mergeUnique(existing.vinRanges, splitMultiValue(nextWorker.vinRange));
  existing.trackerUrls = mergeUnique(existing.trackerUrls, nextWorker.trackerUrl ? [nextWorker.trackerUrl] : []);
  existing.phase = formatMergedValue(existing.phases);
  existing.workBlock = formatMergedValue(existing.workBlocks);
  existing.vinRange = formatMergedValue(existing.vinRanges);
  existing.trackerStatus = mergeStatus(existing.trackerStatus, nextWorker.trackerStatus);
  existing.trackerUrl = existing.trackerUrls[0] || existing.trackerUrl;
  existing.lastSyncedAt = [existing.lastSyncedAt, nextWorker.lastSyncedAt].filter(Boolean).sort().at(-1) || null;

  return workers;
}

function createEmptySnapshotWorker(row) {
  const id = slugifyWorker({
    workerEmail: row.worker_email,
    workerName: row.worker_name
  });

  return {
    id,
    name: row.worker_name || row.worker_email || "Unassigned",
    email: row.worker_email || "",
    cycle: "",
    phase: formatPhaseList(row.home_section_column || row.work_area_name),
    phaseBucket: "",
    phases: [],
    workBlock: "",
    workBlocks: [],
    trackerStatus: "No Work",
    trackerUrl: "",
    trackerUrls: [],
    assignedHours: 0,
    completedHours: 0,
    remainingHours: 0,
    actualHours: 0,
    actualTimeLoggedHours: 0,
    actualTimeLoggedMinutes: 0,
    targetHours: Number(row.hours_per_day || 7.5),
    taskCount: 0,
    completedTaskCount: 0,
    taskOrderRange: "",
    vinRange: "",
    vinRanges: [],
    supportWorkers: "",
    tasks: [],
    lastSyncedAt: null,
    status: "No Work"
  };
}

function ensureConfiguredSnapshotWorkers(workers, configuredRows) {
  const merged = [...workers];
  const workerIds = new Set(merged.map(worker => worker.id));

  for (const row of configuredRows) {
    const worker = createEmptySnapshotWorker(row);
    if (!worker.id || worker.id === "worker-unknown" || workerIds.has(worker.id)) continue;
    workerIds.add(worker.id);
    merged.push(worker);
  }

  return merged.sort((a, b) => a.name.localeCompare(b.name));
}

function emptyJacobRWorker() {
  return {
    id: JACOB_R_WORKER_ID,
    name: JACOB_R_WORKER_NAME,
    email: JACOB_R_WORKER_EMAIL,
    cycle: "",
    phase: JACOB_R_WORKER_PHASE,
    phaseBucket: "",
    phases: [],
    workBlock: JACOB_R_WORKER_PHASE,
    workBlocks: [],
    trackerStatus: "No Work",
    trackerUrl: "",
    trackerUrls: [],
    assignedHours: 0,
    completedHours: 0,
    remainingHours: 0,
    actualHours: 0,
    actualTimeLoggedHours: 0,
    actualTimeLoggedMinutes: 0,
    targetHours: 7.5,
    taskCount: 0,
    completedTaskCount: 0,
    taskOrderRange: "",
    vinRange: "",
    vinRanges: [],
    supportWorkers: "",
    tasks: [],
    lastSyncedAt: null,
    status: "No Work"
  };
}

function applyLivePilotWorkerFlags(worker) {
  if (!worker) return worker;
  if (isJacobRWorker(worker)) {
    worker.id = JACOB_R_WORKER_ID;
    worker.name = JACOB_R_WORKER_NAME;
    worker.email = worker.email || JACOB_R_WORKER_EMAIL;
    worker.phase = worker.phase || JACOB_R_WORKER_PHASE;
    worker.workBlock = worker.workBlock || JACOB_R_WORKER_PHASE;
  }
  worker.liveWriteEnabled = workerWritesAllowed(worker.id);
  worker.writeMode = worker.liveWriteEnabled ? "hawley-live-asana-pilot" : "";
  return worker;
}

function ensureLivePilotWorkers(workers) {
  const mergedById = new Map();
  for (const worker of workers || []) {
    const next = applyLivePilotWorkerFlags({ ...worker, tasks: [...(worker.tasks || [])] });
    const existing = mergedById.get(next.id);
    if (!existing) {
      mergedById.set(next.id, next);
      continue;
    }

    existing.tasks = mergeTaskLists(existing.tasks, next.tasks);
    existing.assignedHours = round(Number(existing.assignedHours || 0) + Number(next.assignedHours || 0));
    existing.completedHours = round(Number(existing.completedHours || 0) + Number(next.completedHours || 0));
    existing.remainingHours = round(Number(existing.remainingHours || 0) + Number(next.remainingHours || 0));
    existing.actualTimeLoggedMinutes = Math.max(Number(existing.actualTimeLoggedMinutes || 0), Number(next.actualTimeLoggedMinutes || 0));
    existing.taskCount = existing.tasks.length;
    existing.completedTaskCount = existing.tasks.filter(task => task.completed).length;
    existing.lastSyncedAt = [existing.lastSyncedAt, next.lastSyncedAt].filter(Boolean).sort().at(-1) || null;
    applyLivePilotWorkerFlags(existing);
  }

  if (!mergedById.has(JACOB_R_WORKER_ID)) {
    mergedById.set(JACOB_R_WORKER_ID, applyLivePilotWorkerFlags(emptyJacobRWorker()));
  }

  return Array.from(mergedById.values()).sort((a, b) => {
    const liveDelta = Number(b.liveWriteEnabled) - Number(a.liveWriteEnabled);
    if (liveDelta) return liveDelta;
    const openDelta = Number(b.remainingHours > 0) - Number(a.remainingHours > 0);
    if (openDelta) return openDelta;
    const workDelta = Number(b.taskCount > 0) - Number(a.taskCount > 0);
    if (workDelta) return workDelta;
    return a.name.localeCompare(b.name);
  });
}

function recalculateSnapshotWorkerCompletion(worker) {
  const completedTasks = (worker.tasks || []).filter(task => task.completed);
  worker.taskCount = (worker.tasks || []).length;
  worker.completedTaskCount = completedTasks.length;
  worker.completedHours = completedTasks.reduce((sum, task) => sum + Number(task.assignedHours || 0), 0);
  worker.remainingHours = Math.max(0, Number(worker.assignedHours || 0) - worker.completedHours);
  worker.actualTimeLoggedMinutes = (worker.tasks || []).reduce((sum, task) => sum + Number(task.actualTimeOnDateMinutes || 0), 0);
  worker.actualTimeLoggedHours = round(worker.actualTimeLoggedMinutes / 60);
  worker.actualHours = worker.actualTimeLoggedHours;
  worker.status = worker.taskCount === 0 ? "No Work" : worker.remainingHours > 0 ? "Open" : "Complete";
  worker.trackerStatus = worker.taskCount === 0 ? "No Work" : worker.remainingHours > 0 ? "Assigned" : "Complete";
}

async function enrichSnapshotWorkersFromRaw(workers) {
  const taskIds = Array.from(new Set(
    workers.flatMap(worker => (worker.tasks || []).map(task => String(task.id || ""))).filter(id => /^\d+$/.test(id))
  ));
  if (!taskIds.length) return;

  const result = await pool.query(
    `
      select
        gid,
        name,
        completed,
        actual_time_minutes,
        permalink_url,
        custom_fields_json
      from raw.asana_tasks
      where gid = any($1::text[])
    `,
    [taskIds]
  );
  const byId = new Map(result.rows.map(row => [row.gid, row]));

  for (const worker of workers) {
    for (const task of worker.tasks || []) {
      const row = byId.get(String(task.id || ""));
      if (!row) continue;
      const fields = fieldsByName(row.custom_fields_json);
      const estimatedMinutes =
        numberValue(fields["Estimated time"]) ||
        numberValue(fields["Estimated Time (w/ Qty)"]) ||
        numberValue(fields["Est Time Remaining (Project)"]);

      task.title = row.name || task.title;
      task.completed = Boolean(row.completed);
      task.sourceUrl = publicLink(row.permalink_url) || task.sourceUrl;
      task.actualTimeMinutes = Number(row.actual_time_minutes || 0);
      task.actualTimeOnDateMinutes = Number(row.actual_time_minutes || 0);
      task.sopUrl = publicLink(textValue(fields["SOP Link"]) || task.sopUrl);
      task.estimatedMinutes = estimatedMinutes || task.estimatedMinutes || minutesFromHours(task.assignedHours);
      task.targetHours = Number(task.targetHours || task.assignedHours || 0);
      task.phase = formatPhaseName(task.phase);
      task.cycle = formatCycleName(task.cycle);
    }
    worker.tasks = (worker.tasks || []).sort((a, b) => Number(a.completed) - Number(b.completed) || String(a.phase || "").localeCompare(String(b.phase || "")) || a.title.localeCompare(b.title));
    recalculateSnapshotWorkerCompletion(worker);
  }
}

function normalizeWorkerDailyActual(row) {
  const fields = row.fields_json || {};
  const actualMinutes = numberFromField(fields["Actual Minutes"]);
  const timerMinutes = numberFromField(fields["Timer Minutes"]);
  const asanaPostedMinutes = numberFromField(fields["Asana Posted Minutes"]);

  return {
    id: row.record_id,
    date: fields["Work Date"] || "",
    workerId: fields["Worker Key"] || "",
    workerName: fields["Worker Name"] || "",
    workerEmail: fields["Worker Email"] || "",
    taskId: fields["Asana Task GID"] || "",
    taskName: fields["Task Name"] || "",
    taskUrl: publicLink(fields["Task URL"]),
    vin: fields.VIN || "",
    cycle: formatCycleName(fields.Cycle),
    phase: formatPhaseName(fields.Phase),
    assignedHours: numberFromField(fields["Assigned Hours"]),
    allocatedHours: numberFromField(fields["Allocated Hours"]),
    actualMinutes,
    timerMinutes,
    timerStartedAt: fields["Timer Started At"] || "",
    asanaPostedMinutes,
    loggedMinutes: Math.max(actualMinutes, timerMinutes, asanaPostedMinutes),
    dailyLoggedMinutes: numberFromField(fields["Daily Logged Minutes"]),
    dailyAvailableMinutes: numberFromField(fields["Daily Available Minutes"]),
    dailyEfficiencyPercent: numberFromField(fields["Daily Efficiency Percent"]),
    completed: booleanFromField(fields["Completed?"]),
    completionPending: booleanFromField(fields["Completion Pending?"]),
    timeEntryCreated: booleanFromField(fields["Time Entry Created?"]),
    dailySummary: booleanFromField(fields["Daily Summary?"]),
    source: fields.Source || "",
    syncedAt: row.source_synced_at || ""
  };
}

function workerIdForDailyActual(row) {
  if (row.workerId) return row.workerId;
  return slugifyWorker({
    workerEmail: row.workerEmail,
    workerName: row.workerName
  });
}

function applyWorkerDailyActualRows(workers, actualRows) {
  const workerById = new Map((workers || []).map(worker => [worker.id, worker]));
  const workerByName = new Map((workers || []).map(worker => [slugify(worker.name), worker]));
  const summaryMinutesByWorker = new Map();

  for (const row of actualRows || []) {
    const workerId = workerIdForDailyActual(row);
    const worker = workerById.get(workerId) || workerByName.get(slugify(row.workerName));
    if (!worker) continue;

    if (row.dailySummary || row.taskId === "__daily__") {
      if (row.dailyLoggedMinutes > 0) {
        summaryMinutesByWorker.set(worker.id, Math.max(summaryMinutesByWorker.get(worker.id) || 0, row.dailyLoggedMinutes));
      }
      worker.dailyEfficiency = {
        loggedMinutes: row.dailyLoggedMinutes,
        availableMinutes: row.dailyAvailableMinutes,
        percent: row.dailyEfficiencyPercent,
        source: row.source || "Worker Daily Task Actuals"
      };
      continue;
    }

    const taskIdValue = String(row.taskId || "");
    const hasTimerState = Boolean(row.timerStartedAt) || row.timerMinutes > 0 || row.completed || row.completionPending;
    if (!taskIdValue || (row.loggedMinutes <= 0 && !hasTimerState)) continue;

    const existingTask = (worker.tasks || []).find(task => String(task.id || "") === taskIdValue);
    if (existingTask) {
      existingTask.actualTimeOnDateMinutes = Math.max(Number(existingTask.actualTimeOnDateMinutes || 0), row.loggedMinutes);
      existingTask.actualTimeMinutes = Math.max(Number(existingTask.actualTimeMinutes || 0), row.asanaPostedMinutes);
      existingTask.timerAccumulatedMinutes = Math.max(Number(existingTask.timerAccumulatedMinutes || 0), row.timerMinutes);
      existingTask.timerStartedAt = row.timerStartedAt || existingTask.timerStartedAt || "";
      existingTask.ledgerBackfilled = true;
      existingTask.ledgerSource = row.source || "Worker Daily Task Actuals";
      existingTask.ledgerSyncedAt = row.syncedAt || "";
      if (row.completed) existingTask.completed = true;
      if (!existingTask.title && row.taskName) existingTask.title = row.taskName;
      if (!existingTask.vin && row.vin) existingTask.vin = row.vin;
      if (!existingTask.cycle && row.cycle) existingTask.cycle = row.cycle;
      if (!existingTask.phase && row.phase) existingTask.phase = row.phase;
      continue;
    }

    worker.tasks.push({
      id: taskIdValue,
      title: row.taskName || `Source task ${taskIdValue}`,
      sourceUrl: row.taskUrl || (taskIdValue ? sourceTaskUrl(taskIdValue) : ""),
      trackerUrl: "",
      assignedHours: row.assignedHours,
      targetHours: row.allocatedHours || row.assignedHours,
      actualTimeMinutes: row.asanaPostedMinutes,
      actualTimeOnDateMinutes: row.loggedMinutes,
      timerStartedAt: row.timerStartedAt || "",
      timerAccumulatedMinutes: row.timerMinutes,
      timerElapsedMinutes: 0,
      estimatedMinutes: minutesFromHours(row.allocatedHours || row.assignedHours),
      sopUrl: "",
      completed: row.completed,
      cycle: row.cycle,
      phase: row.phase,
      phaseBucket: "",
      vin: row.vin,
      workedTimeRecovered: true,
      ledgerBackfilled: true,
      recoveredSource: row.source || "Worker Daily Task Actuals",
      ledgerSource: row.source || "Worker Daily Task Actuals",
      ledgerSyncedAt: row.syncedAt || ""
    });
  }

  for (const worker of workers || []) {
    recalculateSnapshotWorkerCompletion(worker);
    const summaryMinutes = summaryMinutesByWorker.get(worker.id) || 0;
    if (summaryMinutes > 0) {
      worker.actualTimeLoggedMinutes = Math.max(Number(worker.actualTimeLoggedMinutes || 0), summaryMinutes);
      worker.actualTimeLoggedHours = round(worker.actualTimeLoggedMinutes / 60);
      worker.actualHours = worker.actualTimeLoggedHours;
    }
  }
}

function snapshotToLineOverview(snapshot) {
  return {
    cycle: snapshot.cycle,
    status: snapshot.trackerStatus,
    assignedHours: snapshot.assignedHours,
    completedHours: snapshot.completedHours,
    remainingHours: snapshot.remainingHours,
    taskCount: snapshot.taskCount,
    completedTaskCount: snapshot.completedTaskCount,
    completionPercent: snapshot.completionPercent,
    capacityHours: snapshot.capacityHours,
    capacityDeltaHours: snapshot.capacityDeltaHours,
    loadCapacityPercent: snapshot.loadCapacityPercent,
    trackerUrl: snapshot.url
  };
}

function selectedCycleFromTrackerSnapshots(activeSnapshots, selectedDate) {
  const selectedSnapshots = activeSnapshots.filter(snapshot => snapshot.trackerDate === selectedDate);
  return (
    selectedSnapshots.find(snapshot => snapshot.trackerType === "Line Overview" && snapshot.cycle)?.cycle ||
    selectedSnapshots.find(snapshot => snapshot.cycle)?.cycle ||
    activeSnapshots
      .filter(snapshot => snapshot.trackerDate && snapshot.cycle)
      .sort((a, b) => String(b.trackerDate).localeCompare(String(a.trackerDate)))[0]?.cycle ||
    ""
  );
}

function cycleDayDateList(byDate, calendar, selectedDate) {
  const dates = calendar?.dates?.length
    ? [...calendar.dates]
    : Array.from(byDate.keys()).sort((a, b) => a.localeCompare(b));

  if (isIsoDate(selectedDate) && !dates.includes(selectedDate)) {
    dates.push(selectedDate);
  }

  return Array.from(new Set(dates)).sort((a, b) => a.localeCompare(b));
}

function cycleDayPayloadFromDateMap(byDate, selectedDate, selectedCycle, calendar, source) {
  const cycle = calendar?.cycle || selectedCycle || "Current";
  return {
    cycle,
    selectedDate,
    source,
    days: cycleDayDateList(byDate, calendar, selectedDate).map((date, index) => {
      const day = byDate.get(date);
      const assignedHours = Number(day?.assignedHours || 0);
      const completedHours = Number(day?.completedHours || 0);
      const taskCount = Number(day?.taskCount || 0);
      const completedTaskCount = Number(day?.completedTaskCount || 0);
      const hoursCompletionPercent = day?.completionPercent !== null && day?.completionPercent !== undefined
        ? Number(day.completionPercent || 0)
        : assignedHours
          ? round((completedHours / assignedHours) * 100, 1)
          : 0;
      const taskCompletionPercent = taskCount
        ? round((completedTaskCount / taskCount) * 100, 1)
        : 0;
      return {
        date,
        cycle: day?.cycle || cycle,
        label: `Day ${index + 1}`,
        dayNumber: index + 1,
        selected: date === selectedDate,
        hasSnapshot: Boolean(day),
        workerCount: Number(day?.workerCount || 0),
        assignedHours: round(assignedHours),
        completedHours: round(completedHours),
        remainingHours: round(day?.remainingHours || 0),
        taskCount,
        completedTaskCount,
        completeTaskLabel: `${completedTaskCount}/${taskCount}`,
        status: day?.status || (day ? "Assigned" : "No Work"),
        completionPercent: taskCompletionPercent,
        taskCompletionPercent,
        hoursCompletionPercent
      };
    })
  };
}

function buildCycleDaysFromTrackerSnapshots(activeSnapshots, selectedDate, calendar = null) {
  const selectedCycle = selectedCycleFromTrackerSnapshots(activeSnapshots, selectedDate);

  const cycleSnapshots = selectedCycle
    ? activeSnapshots.filter(snapshot => snapshot.cycle === selectedCycle)
    : activeSnapshots;
  const byDate = new Map();

  for (const snapshot of cycleSnapshots) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(snapshot.trackerDate || ""))) continue;
    if (!byDate.has(snapshot.trackerDate)) {
      byDate.set(snapshot.trackerDate, {
        date: snapshot.trackerDate,
        cycle: snapshot.cycle || selectedCycle,
        workerCount: 0,
        assignedHours: 0,
        completedHours: 0,
        remainingHours: 0,
        taskCount: 0,
        completedTaskCount: 0,
        alertCount: 0,
        noWorkCount: 0,
        status: "",
        completionPercent: null
      });
    }

    const day = byDate.get(snapshot.trackerDate);
    if (snapshot.trackerType === "Line Overview") {
      day.status = snapshot.trackerStatus || day.status;
      if (snapshot.completionPercent !== null && snapshot.completionPercent !== undefined) {
        day.completionPercent = snapshot.completionPercent;
      }
      continue;
    }

    if (snapshot.trackerType !== "Worker") continue;
    day.workerCount += 1;
    day.assignedHours = round(day.assignedHours + Number(snapshot.assignedHours || 0));
    day.completedHours = round(day.completedHours + Number(snapshot.completedHours || 0));
    day.remainingHours = round(day.remainingHours + Number(snapshot.remainingHours || 0));
    day.taskCount += Number(snapshot.taskCount || 0);
    day.completedTaskCount += Number(snapshot.completedTaskCount || 0);
    if (snapshot.trackerStatus === "Alert") day.alertCount += 1;
    if (snapshot.trackerStatus === "No Work") day.noWorkCount += 1;
  }

  return cycleDayPayloadFromDateMap(byDate, selectedDate, selectedCycle, calendar, "dat-snapshots");
}

function buildCycleDaysFromRows(dayRows, selectedDate, calendar = null) {
  const selectedRow = dayRows.find(row => row.assigned_on === selectedDate) || {};
  const selectedCycle = formatCycleName(selectedRow.cycle_name || dayRows.find(row => row.cycle_name)?.cycle_name) || calendar?.cycle || "Current";
  const byDate = new Map();

  for (const row of dayRows) {
    const assignedHours = Number(row.assigned_hours || 0);
    const completedHours = Number(row.completed_hours || 0);
    const completionPercent = assignedHours ? round((completedHours / assignedHours) * 100, 1) : 0;
    byDate.set(row.assigned_on, {
      date: row.assigned_on,
      cycle: formatCycleName(row.cycle_name) || selectedCycle,
      workerCount: Number(row.worker_count || 0),
      assignedHours: round(assignedHours),
      completedHours: round(completedHours),
      remainingHours: round(row.remaining_hours || 0),
      taskCount: Number(row.task_count || 0),
      completedTaskCount: Number(row.completed_task_count || 0),
      completeTaskLabel: `${Number(row.completed_task_count || 0)}/${Number(row.task_count || 0)}`,
      status: row.open_task_count > 0 ? "Assigned" : "Complete",
      completionPercent
    });
  }

  return cycleDayPayloadFromDateMap(byDate, selectedDate, selectedCycle, calendar, "hawley-read-model");
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
    where job_name in ('pull_airtable', 'pull_worker_daily_actuals', 'pull_asana', 'pull_asana_events', 'pull_daily_tracker')
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

async function configuredWorkers() {
  const result = await pool.query(`
    select
      worker_name,
      worker_email,
      hours_per_day,
      home_section_column,
      null::text as work_area_name
    from hb.work_force
    where actively_employed
      and nullif(coalesce(worker_email, worker_name, ''), '') is not null
    order by worker_name nulls last, worker_email nulls last
  `);

  return result.rows;
}

async function latestAssignmentDate() {
  const result = await pool.query(`
    select max(assigned_on)::text as latest_assignment_date
    from reporting.hawley_worker_page_assignments
  `);

  return result.rows[0]?.latest_assignment_date || "";
}

async function cycleCalendar(cycleName, selectedDate) {
  const cycleNumber = cycleNumberFromName(cycleName);
  const result = await pool.query(
    `
      select
        cycle_number,
        cycle_label,
        start_date::text,
        end_date::text,
        days_in_cycle,
        holidays
      from reporting.hawley_cycle_calendar
      where start_date is not null
        and (
          ($2::int is not null and cycle_number = $2::int)
          or ($2::int is null and $1::date between start_date and coalesce(end_date, start_date))
        )
      order by
        case when $2::int is not null and cycle_number = $2::int then 0 else 1 end,
        start_date desc
      limit 1
    `,
    [selectedDate, cycleNumber]
  );

  const row = result.rows[0];
  if (!row) return null;

  const holidays = holidayDatesFromField(row.holidays, row.start_date);
  const dates = cycleWorkdays(row.start_date, row.end_date, holidays, row.days_in_cycle);
  if (!dates.length) return null;

  return {
    cycle: formatCycleName(row.cycle_label || row.cycle_number),
    startDate: row.start_date,
    endDate: row.end_date,
    daysInCycle: Number(row.days_in_cycle || dates.length),
    holidays: Array.from(holidays).sort(),
    dates
  };
}

async function cycleDays(date) {
  const result = await pool.query(
    `
      with selected as (
        select coalesce(
          (select cycle_name from reporting.hawley_worker_page_assignments where assigned_on = $1::date and cycle_name is not null limit 1),
          (select cycle_name from reporting.hawley_worker_page_assignments where cycle_name is not null order by assigned_on desc limit 1)
        ) as cycle_name
      )
      select
        assigned_on::text,
        coalesce(cycle_name, (select cycle_name from selected), 'Current') as cycle_name,
        count(distinct coalesce(worker_email, worker_name))::int as worker_count,
        count(*)::int as task_count,
        count(*) filter (where completed)::int as completed_task_count,
        count(*) filter (where not completed)::int as open_task_count,
        coalesce(sum(estimated_hours), 0)::numeric as assigned_hours,
        coalesce(sum(estimated_hours) filter (where completed), 0)::numeric as completed_hours,
        coalesce(sum(estimated_hours) filter (where not completed), 0)::numeric as remaining_hours
      from reporting.hawley_worker_page_assignments
      where assigned_on is not null
        and (
          cycle_name = (select cycle_name from selected)
          or (select cycle_name from selected) is null
        )
      group by assigned_on, cycle_name
      order by assigned_on
    `,
    [date]
  );

  const selectedRow = result.rows.find(row => row.assigned_on === date) || result.rows.find(row => row.cycle_name);
  const calendar = await cycleCalendar(formatCycleName(selectedRow?.cycle_name), date);
  return buildCycleDaysFromRows(result.rows, date, calendar);
}

async function dailyTrackerSnapshots() {
  const result = await pool.query(
    `
      select
        gid,
        name,
        completed,
        due_on::text,
        permalink_url,
        custom_fields_json,
        raw_json,
        synced_at::text
      from raw.asana_tasks
      where project_gid = $1
      order by due_on desc nulls last, name
    `,
    [DAILY_TRACKER_PROJECT_ID]
  );

  return result.rows
    .map(normalizeTrackerSnapshot)
    .filter(snapshot => !snapshot.archivedSection);
}

async function workerDailyActualRows(date) {
  const result = await pool.query(
    `
      select
        worker_daily_actual_id::text as record_id,
        source_synced_at::text,
        jsonb_build_object(
          'Work Date', work_date::text,
          'Worker Key', worker_key,
          'Worker Name', worker_name,
          'Worker Email', worker_email,
          'Asana Task GID', asana_task_gid,
          'Task Name', task_name,
          'Task URL', task_url,
          'VIN', vin,
          'Cycle', cycle_label,
          'Phase', phase_label,
          'Assigned Hours', assigned_hours,
          'Allocated Hours', allocated_hours,
          'Actual Minutes', actual_minutes,
          'Timer Minutes', timer_minutes,
          'Timer Started At', fields_json ->> 'Timer Started At',
          'Asana Posted Minutes', asana_posted_minutes,
          'Source', source_label,
          'Completed?', completed,
          'Completion Pending?', fields_json ->> 'Completion Pending?',
          'Time Entry Created?', fields_json ->> 'Time Entry Created?',
          'Daily Summary?', daily_summary,
          'Daily Available Minutes', daily_available_minutes,
          'Daily Logged Minutes', daily_logged_minutes,
          'Daily Efficiency Percent', daily_efficiency_percent
        ) as fields_json
      from hb.worker_daily_task_actuals
      where work_date = $1::date
      order by
        worker_name nulls last,
        task_name nulls last
    `,
    [date]
  );

  return result.rows.map(normalizeWorkerDailyActual);
}

async function dailyAssignmentsPayload(url) {
  const date = url.searchParams.get("date") || todayIso();
  const requestedEmployee = url.searchParams.get("employee") || "";
  const employee = requestedEmployee ? canonicalWorkerIdForWrites(requestedEmployee) : "";
  const includeNoWork = INCLUDE_NO_WORK_WORKERS || booleanQuery(url.searchParams.get("includeNoWork"));
  if (!isIsoDate(date)) {
    const error = new Error("Date must be YYYY-MM-DD.");
    error.statusCode = 400;
    throw error;
  }

  const [rows, configuredRows, latestRuns, latestDate, trackerSnapshots, actualRows] = await Promise.all([
    workerAssignments(date),
    configuredWorkers(),
    latestImportRuns(),
    latestAssignmentDate(),
    dailyTrackerSnapshots(),
    workerDailyActualRows(date)
  ]);
  const selectedTrackerSnapshots = trackerSnapshots.filter(snapshot => snapshot.trackerDate === date);
  const hasTrackerSnapshot = selectedTrackerSnapshots.some(snapshot => snapshot.trackerType === "Worker" || snapshot.trackerType === "Line Overview");
  const useTrackerSnapshot = hasTrackerSnapshot && (USE_DAT_SNAPSHOTS || rows.length === 0);
  const latestTrackerSnapshotDate = latestActiveTrackerDate(trackerSnapshots);

  let allWorkers;
  let lineOverview;
  let cycleDayPayload;

  if (useTrackerSnapshot) {
    allWorkers = ensureConfiguredSnapshotWorkers(
      selectedTrackerSnapshots
        .filter(snapshot => snapshot.trackerType === "Worker")
        .map(snapshotToWorker)
        .reduce(mergeWorkerSnapshot, []),
      configuredRows
    );
    await enrichSnapshotWorkersFromRaw(allWorkers);
    allWorkers = ensureLivePilotWorkers(allWorkers);
    applyWorkerDailyActualRows(allWorkers, actualRows);
    allWorkers = ensureLivePilotWorkers(allWorkers);
    if (!employee) {
      const calendar = await cycleCalendar(selectedCycleFromTrackerSnapshots(trackerSnapshots, date), date);
      cycleDayPayload = buildCycleDaysFromTrackerSnapshots(trackerSnapshots, date, calendar);
    }
    lineOverview = selectedTrackerSnapshots.find(snapshot => snapshot.trackerType === "Line Overview");
  } else {
    allWorkers = mergeConfiguredWorkers(buildWorkers(rows), configuredRows);
    allWorkers = ensureLivePilotWorkers(allWorkers);
    applyWorkerDailyActualRows(allWorkers, actualRows);
    allWorkers = ensureLivePilotWorkers(allWorkers);
    cycleDayPayload = employee ? null : await cycleDays(date);
  }

  const workers = visibleWorkersForRequest(allWorkers, employee, includeNoWork);

  return {
    ok: true,
    source: "hawley-brain",
    mode: useTrackerSnapshot ? "hawley-dat-snapshot-fallback" : "hawley-read-model",
    date,
    employee: employee || null,
    includeNoWork,
    project: {
      id: DAILY_TRACKER_PROJECT_ID,
      name: "Daily Assignment Tracker",
      url: `https://app.asana.com/1/829365006370166/project/${DAILY_TRACKER_PROJECT_ID}`
    },
    lineOverview: employee ? null : lineOverview ? snapshotToLineOverview(lineOverview) : buildLineOverview(workers, date, latestRuns),
    managerSignals: employee ? null : buildManagerSignals(workers),
    cycleDays: cycleDayPayload,
    latestTrackerDate: useTrackerSnapshot ? latestTrackerSnapshotDate || latestDate : latestDate,
    workers,
    latestRuns,
    refreshedAt: new Date().toISOString()
  };
}

function actionError(message, statusCode = 400, details = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      throw actionError("Request body is too large.", 413);
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw actionError("Request body must be valid JSON.", 400);
  }
}

function authStatusPayload() {
  return {
    writePinRequired: false,
    mode: WORKER_WRITES_ENABLED ? "hawley-live-worker-writes" : "hawley-read-only-pilot",
    workerWritesEnabled: WORKER_WRITES_ENABLED,
    workerWritesAll: WORKER_WRITES_ALL,
    writeWorkerIds: workerWriteIds(),
    writeWorkerNames: WORKER_WRITES_ENABLED && !WORKER_WRITES_ALL ? [JACOB_R_WORKER_NAME] : [],
    liveWriteScope: WORKER_WRITES_ALL
      ? "timer rows in Hawley plus Asana completion for assigned worker tasks"
      : "timer rows in Hawley plus Asana completion for approved pilot workers only"
  };
}

function ledgerKeyForWorkerTask(workerId, date, taskId) {
  return `${workerId}::${date}::${taskId}`;
}

function liveTimerFromRow(row) {
  if (!row) return null;
  const fields = row.fields_json || {};
  return {
    ledgerKey: row.ledger_key || "",
    taskId: row.asana_task_gid || fields["Asana Task GID"] || "",
    startedAt: fields["Timer Started At"] || "",
    accumulatedMinutes: Number(row.timer_minutes || fields["Timer Minutes"] || 0),
    actualMinutes: Number(row.actual_minutes || fields["Actual Minutes"] || 0),
    asanaPostedMinutes: Number(row.asana_posted_minutes || fields["Asana Posted Minutes"] || 0),
    completed: Boolean(row.completed) || booleanFromField(fields["Completed?"]),
    completionPending: booleanFromField(fields["Completion Pending?"]),
    timeEntryCreated: booleanFromField(fields["Time Entry Created?"])
  };
}

function liveTimerElapsedMinutes(timer, now) {
  const accumulated = Number(timer?.accumulatedMinutes || 0);
  if (!timer?.startedAt) return accumulated;
  const startedAt = new Date(timer.startedAt);
  if (Number.isNaN(startedAt.getTime())) return accumulated;
  return accumulated + Math.max(1, Math.round((now.getTime() - startedAt.getTime()) / 60000));
}

async function assignedWorkerTaskForWrite(employee, date, taskId) {
  const assignmentUrl = new URL("http://hawley.local/api/daily-assignments");
  assignmentUrl.searchParams.set("date", date);
  assignmentUrl.searchParams.set("employee", employee);
  assignmentUrl.searchParams.set("includeNoWork", "true");
  const payload = await dailyAssignmentsPayload(assignmentUrl);
  const worker = (payload.workers || []).find(item => item.id === employee);
  if (!worker) {
    throw actionError("Worker profile is not available in Hawley for this date.", 404);
  }

  const task = (worker.tasks || []).find(item => String(item.id || "") === String(taskId));
  if (!task) {
    throw actionError("Task is not assigned to this employee for the selected day in Hawley.", 404);
  }

  return { worker, task };
}

async function readLiveActualRow(client, ledgerKey) {
  const result = await client.query(
    `
      select
        ledger_key,
        asana_task_gid,
        actual_minutes,
        timer_minutes,
        asana_posted_minutes,
        completed,
        fields_json
      from hb.worker_daily_task_actuals
      where ledger_key = $1
      limit 1
    `,
    [ledgerKey]
  );
  return liveTimerFromRow(result.rows[0]);
}

async function runningLiveTimerForWorker(client, workerId, date, exceptTaskId = "") {
  const result = await client.query(
    `
      select
        ledger_key,
        asana_task_gid,
        actual_minutes,
        timer_minutes,
        asana_posted_minutes,
        completed,
        fields_json
      from hb.worker_daily_task_actuals
      where worker_key = $1
        and work_date = $2::date
        and coalesce(fields_json ->> 'Timer Started At', '') <> ''
        and coalesce(asana_task_gid, '') <> $3
      order by source_synced_at desc nulls last, worker_daily_actual_id desc
      limit 1
    `,
    [workerId, date, String(exceptTaskId || "")]
  );
  return liveTimerFromRow(result.rows[0]);
}

function liveActualFields(worker, task, date, timer, options = {}) {
  const actualMinutes = Number(options.actualMinutes ?? timer.actualMinutes ?? timer.accumulatedMinutes ?? 0);
  const timerMinutes = Number(options.timerMinutes ?? timer.accumulatedMinutes ?? 0);
  const asanaPostedMinutes = Number(options.asanaPostedMinutes ?? timer.asanaPostedMinutes ?? 0);
  const completed = Boolean(options.completed);
  return {
    "Work Date": date,
    "Worker Key": worker.id,
    "Worker Name": worker.name,
    "Worker Email": worker.email || "",
    "Asana Task GID": String(task.id || ""),
    "Task Name": task.title || "",
    "Task URL": publicLink(task.sourceUrl) || sourceTaskUrl(task.id),
    "VIN": task.vin || "",
    "Cycle": formatCycleName(task.cycle),
    "Phase": formatPhaseName(task.phase || task.workArea),
    "Assigned Hours": Number(task.assignedHours || task.estimatedHours || 0),
    "Allocated Hours": Number(task.targetHours || task.assignedHours || task.estimatedHours || 0),
    "Actual Minutes": actualMinutes,
    "Timer Minutes": timerMinutes,
    "Timer Started At": timer.startedAt || "",
    "Asana Posted Minutes": asanaPostedMinutes,
    "Source": options.sourceLabel || "Hawley live worker pilot",
    "Completed?": completed,
    "Completion Pending?": Boolean(options.completionPending),
    "Time Entry Created?": Boolean(options.timeEntryCreated),
    "Last Seen At": options.seenAt || new Date().toISOString(),
    "Was Assigned In DAT?": true
  };
}

async function upsertLiveWorkerActual(client, worker, task, date, timer, options = {}) {
  const nowIso = options.seenAt || new Date().toISOString();
  const ledgerKey = ledgerKeyForWorkerTask(worker.id, date, task.id);
  const fields = liveActualFields(worker, task, date, timer, { ...options, seenAt: nowIso });
  const result = await client.query(
    `
      insert into hb.worker_daily_task_actuals (
        ledger_key,
        work_date,
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
        last_seen_at,
        fields_json,
        source_system,
        source_synced_at,
        normalized_at
      )
      values (
        $1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, true, $18, $19,
        $20::jsonb, $21, $19, now()
      )
      on conflict (ledger_key) do update set
        work_date = excluded.work_date,
        worker_key = excluded.worker_key,
        worker_name = excluded.worker_name,
        worker_email = excluded.worker_email,
        asana_task_gid = excluded.asana_task_gid,
        task_name = excluded.task_name,
        task_url = excluded.task_url,
        vin = excluded.vin,
        cycle_label = excluded.cycle_label,
        phase_label = excluded.phase_label,
        assigned_hours = excluded.assigned_hours,
        allocated_hours = excluded.allocated_hours,
        actual_minutes = excluded.actual_minutes,
        timer_minutes = excluded.timer_minutes,
        asana_posted_minutes = excluded.asana_posted_minutes,
        source_label = excluded.source_label,
        was_assigned_in_dat = true,
        completed = excluded.completed,
        last_seen_at = excluded.last_seen_at,
        fields_json = coalesce(hb.worker_daily_task_actuals.fields_json, '{}'::jsonb) || excluded.fields_json,
        source_system = excluded.source_system,
        source_synced_at = excluded.source_synced_at,
        normalized_at = now()
      returning
        ledger_key,
        asana_task_gid,
        actual_minutes,
        timer_minutes,
        asana_posted_minutes,
        completed,
        fields_json
    `,
    [
      ledgerKey,
      date,
      worker.id,
      worker.name,
      worker.email || "",
      String(task.id || ""),
      task.title || "",
      publicLink(task.sourceUrl) || sourceTaskUrl(task.id),
      task.vin || "",
      formatCycleName(task.cycle),
      formatPhaseName(task.phase || task.workArea),
      Number(task.assignedHours || task.estimatedHours || 0),
      Number(task.targetHours || task.assignedHours || task.estimatedHours || 0),
      Number(options.actualMinutes ?? timer.actualMinutes ?? timer.accumulatedMinutes ?? 0),
      Number(options.timerMinutes ?? timer.accumulatedMinutes ?? 0),
      Number(options.asanaPostedMinutes ?? timer.asanaPostedMinutes ?? 0),
      options.sourceLabel || "Hawley live worker pilot",
      Boolean(options.completed),
      nowIso,
      JSON.stringify(fields),
      LIVE_WORKER_SOURCE
    ]
  );
  return liveTimerFromRow(result.rows[0]);
}

async function asanaJson(token, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw actionError(`Asana API returned ${response.status}: ${text}`, response.status);
  }

  return response.json();
}

async function createTimeTrackingEntry(token, taskId, durationMinutes, enteredOn) {
  const url = new URL(`https://app.asana.com/api/1.0/tasks/${taskId}/time_tracking_entries`);
  await asanaJson(token, url, {
    method: "POST",
    body: JSON.stringify({
      data: {
        duration_minutes: durationMinutes,
        entered_on: enteredOn
      }
    })
  });
}

async function updateAsanaTask(token, taskId, data) {
  const url = new URL(`https://app.asana.com/api/1.0/tasks/${taskId}`);
  await asanaJson(token, url, {
    method: "PUT",
    body: JSON.stringify({ data })
  });
}

async function createAsanaStory(token, taskId, text) {
  const url = new URL(`https://app.asana.com/api/1.0/tasks/${taskId}/stories`);
  await asanaJson(token, url, {
    method: "POST",
    body: JSON.stringify({ data: { text } })
  });
}

function formatTimerMinutes(minutes) {
  const total = Math.max(0, Math.round(Number(minutes || 0)));
  const hours = Math.floor(total / 60);
  const remainder = total % 60;
  if (hours && remainder) return `${hours}h ${remainder}m`;
  if (hours) return `${hours}h`;
  return `${remainder}m`;
}

async function handleWorkerTaskAction(req) {
  const body = await readJsonBody(req);
  const action = String(body.action || "").trim().toLowerCase();
  const employee = canonicalWorkerIdForWrites(body.employee || "");
  const taskId = String(body.taskId || "").trim();
  const date = String(body.date || todayIso()).trim();

  if (!["start", "stop", "complete"].includes(action)) {
    throw actionError("Action must be start, stop, or complete.", 400);
  }
  if (!employee || !workerWritesAllowed(employee)) {
    throw actionError("Live worker writes are not enabled for this employee.", 403, {
      mode: authStatusPayload().mode,
      writeWorkerIds: workerWriteIds()
    });
  }
  if (!taskId) throw actionError("Task ID is required.", 400);
  if (!isIsoDate(date)) throw actionError("Date must be YYYY-MM-DD.", 400);

  const { worker, task } = await assignedWorkerTaskForWrite(employee, date, taskId);
  const now = new Date();
  const nowIso = now.toISOString();
  const ledgerKey = ledgerKeyForWorkerTask(worker.id, date, task.id);
  const client = await writePool.connect();

  try {
    const current = await readLiveActualRow(client, ledgerKey);

    if (action === "start") {
      if (current?.completed) {
        throw actionError("This task is already completed in the Hawley timer ledger.", 409);
      }
      if (current?.startedAt) {
        return {
          ok: true,
          action,
          taskId,
          startedAt: current.startedAt,
          accumulatedMinutes: current.accumulatedMinutes,
          elapsedMinutes: liveTimerElapsedMinutes(current, now),
          completed: false
        };
      }

      const blocking = await runningLiveTimerForWorker(client, worker.id, date, task.id);
      if (blocking) {
        throw actionError("Stop the running timer before starting another task.", 409, {
          code: "TIMER_SESSION_BLOCKED",
          blockingTaskId: blocking.taskId
        });
      }

      const timer = {
        startedAt: nowIso,
        accumulatedMinutes: Number(current?.accumulatedMinutes || 0),
        actualMinutes: Number(current?.actualMinutes || 0),
        asanaPostedMinutes: Number(current?.asanaPostedMinutes || 0)
      };
      const saved = await upsertLiveWorkerActual(client, worker, task, date, timer, {
        actualMinutes: timer.actualMinutes,
        timerMinutes: timer.accumulatedMinutes,
        asanaPostedMinutes: timer.asanaPostedMinutes,
        sourceLabel: "Hawley timer started",
        seenAt: nowIso
      });

      return {
        ok: true,
        action,
        taskId,
        startedAt: saved.startedAt,
        accumulatedMinutes: saved.accumulatedMinutes,
        elapsedMinutes: liveTimerElapsedMinutes(saved, now),
        completed: false
      };
    }

    if (!current) {
      throw actionError("Start the timer before stopping or completing this task.", 409);
    }

    const elapsedMinutes = liveTimerElapsedMinutes(current, now);
    if (action === "stop") {
      const saved = await upsertLiveWorkerActual(client, worker, task, date, {
        ...current,
        startedAt: "",
        accumulatedMinutes: elapsedMinutes,
        actualMinutes: elapsedMinutes
      }, {
        actualMinutes: elapsedMinutes,
        timerMinutes: elapsedMinutes,
        asanaPostedMinutes: current.asanaPostedMinutes,
        sourceLabel: "Hawley timer stopped",
        seenAt: nowIso
      });

      return {
        ok: true,
        action,
        taskId,
        startedAt: "",
        accumulatedMinutes: saved.accumulatedMinutes,
        elapsedMinutes: saved.accumulatedMinutes,
        completed: false
      };
    }

    if (elapsedMinutes <= 0) {
      throw actionError("Start the timer before completing this task.", 409);
    }
    if (current.completed && current.timeEntryCreated) {
      return {
        ok: true,
        action,
        taskId,
        elapsedMinutes: current.actualMinutes || current.accumulatedMinutes,
        completed: true,
        alreadyCompleted: true
      };
    }

    const token = process.env.ASANA_PAT;
    if (!token) {
      throw actionError("ASANA_PAT is not configured for live completion writes.", 503);
    }

    await upsertLiveWorkerActual(client, worker, task, date, {
      ...current,
      startedAt: "",
      accumulatedMinutes: elapsedMinutes,
      actualMinutes: elapsedMinutes
    }, {
      actualMinutes: elapsedMinutes,
      timerMinutes: elapsedMinutes,
      asanaPostedMinutes: current.asanaPostedMinutes,
      completionPending: true,
      timeEntryCreated: current.timeEntryCreated,
      sourceLabel: "Hawley completion pending",
      seenAt: nowIso
    });

    if (!current.timeEntryCreated) {
      await createTimeTrackingEntry(token, task.id, elapsedMinutes, date);
      await upsertLiveWorkerActual(client, worker, task, date, {
        ...current,
        startedAt: "",
        accumulatedMinutes: elapsedMinutes,
        actualMinutes: elapsedMinutes,
        asanaPostedMinutes: elapsedMinutes
      }, {
        actualMinutes: elapsedMinutes,
        timerMinutes: elapsedMinutes,
        asanaPostedMinutes: elapsedMinutes,
        completionPending: true,
        timeEntryCreated: true,
        sourceLabel: "Hawley Asana time posted",
        seenAt: nowIso
      });
    }

    await updateAsanaTask(token, task.id, { completed: true });
    await createAsanaStory(token, task.id, `Hawley worker pilot timer logged ${formatTimerMinutes(elapsedMinutes)}.`);
    const saved = await upsertLiveWorkerActual(client, worker, task, date, {
      ...current,
      startedAt: "",
      accumulatedMinutes: elapsedMinutes,
      actualMinutes: elapsedMinutes,
      asanaPostedMinutes: Math.max(elapsedMinutes, current.asanaPostedMinutes || 0)
    }, {
      actualMinutes: elapsedMinutes,
      timerMinutes: elapsedMinutes,
      asanaPostedMinutes: Math.max(elapsedMinutes, current.asanaPostedMinutes || 0),
      completed: true,
      completionPending: false,
      timeEntryCreated: true,
      sourceLabel: "Hawley task completed",
      seenAt: nowIso
    });

    return {
      ok: true,
      action,
      taskId,
      elapsedMinutes: saved.actualMinutes || elapsedMinutes,
      completed: true
    };
  } finally {
    client.release();
  }
}

async function healthPayload() {
  const [db, counts, latestRuns] = await Promise.all([
    pool.query("select current_database() as database_name, current_user as user_name, version() as postgres_version"),
    pool.query(`
      select
        (select count(*)::int from reporting.hawley_worker_page_assignments) as assignment_rows,
        (select count(distinct worker_email)::int from reporting.hawley_worker_page_assignments where worker_email is not null) as assigned_worker_count,
        (select count(*)::int from raw.asana_tasks where project_gid = $1) as daily_tracker_rows,
        (select count(*)::int from hb.worker_daily_task_actuals) as worker_daily_actual_rows,
        (
          select count(*)::int
          from hb.work_force
          where actively_employed
            and nullif(coalesce(worker_email, worker_name, ''), '') is not null
        ) as worker_count
    `, [DAILY_TRACKER_PROJECT_ID]),
    latestImportRuns()
  ]);

  return {
    ok: true,
    app: "hawley-worker-page",
    database: db.rows[0],
    counts: counts.rows[0],
    latestRuns,
    watcher: asanaEventWatcherStatus(),
    watchers: watcherStatuses()
  };
}

async function syncStatusPayload() {
  return {
    ok: true,
    app: "hawley-worker-page",
    mode: "hawley-brain",
    watcher: asanaEventWatcherStatus(),
    watchers: watcherStatuses(),
    latestRuns: await latestImportRuns(),
    refreshedAt: new Date().toISOString()
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

    if (url.pathname === "/api/sync-status") {
      sendJson(res, 200, await syncStatusPayload());
      return;
    }

    if (url.pathname === "/api/daily-assignments" || url.pathname === "/api/assignments") {
      sendJson(res, 200, await dailyAssignmentsPayload(url));
      return;
    }

    if (url.pathname === "/api/auth-status" && req.method === "GET") {
      sendJson(res, 200, authStatusPayload());
      return;
    }

    if (url.pathname === "/api/alert-status" && req.method === "GET") {
      sendJson(res, 200, {
        enabled: false,
        channel: "log",
        configuredRecipients: 0,
        thresholdMinutes: 15,
        overEstimateThresholdMinutes: 15,
        workStart: "07:00",
        workEnd: "15:30",
        lunchStart: "11:00",
        lunchEnd: "11:30",
        pauses: [
          { label: "lunch", start: "11:00", end: "11:30" },
          { label: "break", start: "09:00", end: "09:10" },
          { label: "break", start: "13:30", end: "13:40" }
        ],
        timerAutoStopEnabled: false,
        timerScheduleEnforced: false,
        pending: [],
        history: [],
        mode: "hawley-read-only-pilot"
      });
      return;
    }

    if (url.pathname === "/api/refresh-daily-tracker" && req.method === "GET") {
      sendJson(res, 200, {
        running: false,
        message: "",
        startedAt: "",
        step: "",
        outputTail: "",
        mode: "hawley-read-only-pilot"
      });
      return;
    }

    if (url.pathname === "/api/refresh-daily-tracker" && req.method === "POST") {
      sendError(res, 409, "Hawley worker pilot is read-only. Tracker refresh writes are not enabled here.", {
        mode: "hawley-read-only-pilot"
      });
      return;
    }

    if (url.pathname === "/api/worker-task-action" && req.method === "POST") {
      sendJson(res, 200, await handleWorkerTaskAction(req));
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

async function startServer() {
  await applyRuntimeReadGrants();
  startAsanaEventWatcher();
  startWorkerActualsWatcher();
  server.listen(PORT, HOST, () => {
    console.log(`Hawley worker pilot listening on http://${HOST}:${PORT}`);
  });
}

function shutdown(signal) {
  stopAsanaEventWatcher(signal);
  stopWorkerActualsWatcher(signal);
  server.close(() => {
    Promise.all([
      pool.end(),
      writePool.end()
    ])
      .catch(() => {})
      .finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref?.();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

startServer().catch(error => {
  console.error("Failed to start Hawley worker pilot.");
  console.error(error.message);
  process.exitCode = 1;
});
