import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";
import { getDatabaseConfig } from "../postgres-sync/src/config.js";

const { Pool } = pg;
const scryptAsync = promisify(crypto.scrypt);

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
const NIGHTLY_REFRESH_TIME = process.env.HAWLEY_NIGHTLY_REFRESH_TIME || "01:00";
const NIGHTLY_REFRESH_TIME_ZONE = process.env.HAWLEY_NIGHTLY_REFRESH_TIME_ZONE || "America/Los_Angeles";
const NIGHTLY_REFRESH_SCRIPT = process.env.HAWLEY_NIGHTLY_REFRESH_SCRIPT || "pg:refresh-hawley-read-model";
const NIGHTLY_AIRTABLE_BACKFILL_SCRIPT = process.env.HAWLEY_NIGHTLY_AIRTABLE_BACKFILL_SCRIPT || "pg:backfill:airtable-worker-actuals";
const NIGHTLY_AIRTABLE_BACKFILL_WINDOW_DAYS = Number(process.env.HAWLEY_NIGHTLY_AIRTABLE_BACKFILL_WINDOW_DAYS || process.env.HAWLEY_AIRTABLE_BACKFILL_WINDOW_DAYS || 2);
const APPLY_MIGRATIONS_ON_START = booleanEnv("HAWLEY_APPLY_MIGRATIONS_ON_START", process.env.NODE_ENV === "production");
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
const TRANSITION_REVIEWS_ENABLED = booleanEnv("HAWLEY_TRANSITION_REVIEWS_ENABLED", true);
const ADMIN_PROJECT_CREATE_ENABLED = booleanEnv("HAWLEY_ADMIN_PROJECT_CREATE_ENABLED", false);
const ADMIN_PLH_BASELINE_CYCLE = process.env.HAWLEY_ADMIN_PLH_BASELINE_CYCLE || "C5";
const ADMIN_PLH_PHASES = new Set(
  envList(process.env.HAWLEY_ADMIN_PLH_PHASES || "")
    .map(formatPhaseName)
    .filter(Boolean)
);
const LIVE_WORKER_SOURCE = "hawley_worker_live_pilot";
const APP_AUTH_ACTIVE = booleanEnv("HAWLEY_AUTH_ACTIVE", false);
const APP_AUTH_SEED_ROSTER_ON_START = booleanEnv("HAWLEY_AUTH_SEED_ROSTER_ON_START", true);
const APP_AUTH_BOOTSTRAP_ENABLED = booleanEnv("HAWLEY_AUTH_BOOTSTRAP_ENABLED", false);
const APP_AUTH_BOOTSTRAP_EMAIL = String(process.env.HAWLEY_AUTH_BOOTSTRAP_EMAIL || "").trim().toLowerCase();
const APP_AUTH_BOOTSTRAP_PASSWORD = String(process.env.HAWLEY_AUTH_BOOTSTRAP_PASSWORD || "");
const APP_AUTH_COOKIE_NAME = process.env.HAWLEY_AUTH_COOKIE_NAME || "hawley_session";
const APP_AUTH_SESSION_TTL_HOURS = Number(process.env.HAWLEY_AUTH_SESSION_TTL_HOURS || 12);
const APP_AUTH_MANAGER_EMAILS = new Set(envList(process.env.HAWLEY_AUTH_MANAGER_EMAILS).map(normalizeEmail).filter(Boolean));
const APP_AUTH_ADMIN_EMAILS = new Set(envList(process.env.HAWLEY_AUTH_ADMIN_EMAILS).map(normalizeEmail).filter(Boolean));
const SHOP_TIME_ZONE = "America/Los_Angeles";
const SHOP_WORK_START = "07:00";
const SHOP_WORK_END = "15:30";
const SHOP_PAUSES = Object.freeze([
  { label: "break", start: "09:00", end: "09:10" },
  { label: "lunch", start: "11:00", end: "11:30" },
  { label: "break", start: "13:30", end: "13:40" }
]);
const SHOP_WORK_WINDOWS = Object.freeze([
  { start: "07:00", end: "09:00" },
  { start: "09:10", end: "11:00" },
  { start: "11:30", end: "13:30" },
  { start: "13:40", end: "15:30" }
]);
const SHOP_DAILY_AVAILABLE_MINUTES = 460;
const SHOP_DAILY_AVAILABLE_HOURS = SHOP_DAILY_AVAILABLE_MINUTES / 60;
const SHOP_SCHEDULE_CORRECTION_SOURCE = "7:00-15:30 America/Los_Angeles minus 09:00-09:10, 11:00-11:30, 13:30-13:40";
const OVER_CAPACITY_FLAG = "over_daily_capacity";

const runtimeDatabaseConfig = getDatabaseConfig({ useSyncUrl: true });
const pool = new Pool(runtimeDatabaseConfig);
const writePool = new Pool(runtimeDatabaseConfig);
const migrationsDir = path.join(repoRoot, "db", "migrations");
const viewsDir = path.join(repoRoot, "db", "views");

const scheduleCorrectionState = {
  enabled: true,
  lastDate: "",
  lastStartedAt: "",
  lastFinishedAt: "",
  lastCandidateRows: 0,
  lastCandidateSessions: 0,
  lastCorrectedRows: 0,
  lastCorrectedSessions: 0,
  lastSkippedRows: 0,
  lastError: "",
  lastReason: "",
  lastSamples: []
};

const authRuntimeState = {
  lastLoginAt: "",
  lastLoginStep: "",
  lastLoginError: "",
  lastLoginStatus: "",
  lastSessionCheckAt: "",
  lastSessionCheckStep: "",
  lastSessionCheckError: ""
};

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

const nightlyRefreshState = {
  enabled: false,
  requested: false,
  running: false,
  pid: null,
  scheduleTime: NIGHTLY_REFRESH_TIME,
  timeZone: NIGHTLY_REFRESH_TIME_ZONE,
  script: NIGHTLY_REFRESH_SCRIPT,
  nextRunAt: "",
  startedAt: "",
  lastOutputAt: "",
  lastExit: null,
  lastError: "",
  mode: "web-service-sidecar",
  reason: ""
};
let nightlyRefreshProcess = null;
let nightlyRefreshTimer = null;
let nightlyRefreshStopping = false;

const nightlyAirtableBackfillState = {
  enabled: false,
  requested: false,
  running: false,
  pid: null,
  script: NIGHTLY_AIRTABLE_BACKFILL_SCRIPT,
  apply: false,
  windowDays: NIGHTLY_AIRTABLE_BACKFILL_WINDOW_DAYS,
  startedAt: "",
  lastOutputAt: "",
  lastExit: null,
  lastError: "",
  mode: "web-service-sidecar",
  reason: ""
};
let nightlyAirtableBackfillProcess = null;

const CONTENT_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
});

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
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
  if (/hawley_worker_page_assignments|hawley_cycle_calendar|hawley_reporting_day_summary|worker_daily_utilization|phase_cycle_load_rev1|task_work_area_inference|work_force_capability_levels|airtable_worker_daily_actuals|task_templates|production_schedule|airtable_tasks|airtable_production|jsonb_display_text|task_transition_events|time_sessions|transition_category_catalog|app_users|app_sessions|app_auth_events/.test(message)) {
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

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function requestIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "")
    .split(",")[0]
    .trim();
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => {
        const index = part.indexOf("=");
        if (index === -1) return [part, ""];
        return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function cookieHeader(name, value, options = {}) {
  const parts = [
    `${encodeURIComponent(name)}=${encodeURIComponent(value || "")}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax"
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Number(options.maxAge || 0))}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  return parts.join("; ");
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
  return false;
}

function shouldStartNightlyRefreshScheduler() {
  if (process.env.HAWLEY_NIGHTLY_REFRESH_ENABLED !== undefined) {
    return booleanEnv("HAWLEY_NIGHTLY_REFRESH_ENABLED", false);
  }
  return process.env.NODE_ENV === "production";
}

function shouldRunNightlyAirtableBackfill() {
  if (process.env.HAWLEY_NIGHTLY_AIRTABLE_BACKFILL_ENABLED !== undefined) {
    return booleanEnv("HAWLEY_NIGHTLY_AIRTABLE_BACKFILL_ENABLED", false);
  }
  return process.env.NODE_ENV === "production";
}

function shouldApplyNightlyAirtableBackfill() {
  if (process.env.HAWLEY_NIGHTLY_AIRTABLE_BACKFILL_APPLY !== undefined) {
    return booleanEnv("HAWLEY_NIGHTLY_AIRTABLE_BACKFILL_APPLY", false);
  }
  return process.env.NODE_ENV === "production";
}

function syncDatabaseConfigured() {
  return Boolean(process.env.HAWLEY_SYNC_DATABASE_URL || process.env.HAWLEY_MIGRATION_DATABASE_URL);
}

function scheduleCorrectionStatus() {
  return { ...scheduleCorrectionState, lastSamples: [...scheduleCorrectionState.lastSamples] };
}

function asanaEventWatcherStatus() {
  return { ...asanaEventWatcherState };
}

function workerActualsWatcherStatus() {
  return { ...workerActualsWatcherState };
}

function nightlyRefreshStatus() {
  return { ...nightlyRefreshState };
}

function nightlyAirtableBackfillStatus() {
  return { ...nightlyAirtableBackfillState };
}

function watcherStatuses() {
  return {
    asanaEvents: asanaEventWatcherStatus(),
    workerDailyActuals: workerActualsWatcherStatus(),
    nightlyRefresh: nightlyRefreshStatus(),
    nightlyAirtableBackfill: nightlyAirtableBackfillStatus()
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

function parseNightlyRefreshTime(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function localDateTimeParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function addLocalCalendarDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

function timeZoneOffsetMs(timeZone, date) {
  const parts = localDateTimeParts(date, timeZone);
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return localAsUtc - Math.floor(date.getTime() / 1000) * 1000;
}

function localTimeToUtc(parts, timeZone) {
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
  const firstOffset = timeZoneOffsetMs(timeZone, new Date(localAsUtc));
  let candidate = new Date(localAsUtc - firstOffset);
  const secondOffset = timeZoneOffsetMs(timeZone, candidate);
  if (secondOffset !== firstOffset) {
    candidate = new Date(localAsUtc - secondOffset);
  }
  return candidate;
}

function nextNightlyRefreshAt(now = new Date()) {
  const schedule = parseNightlyRefreshTime(NIGHTLY_REFRESH_TIME);
  if (!schedule) return null;

  const localNow = localDateTimeParts(now, NIGHTLY_REFRESH_TIME_ZONE);
  let localDate = {
    year: localNow.year,
    month: localNow.month,
    day: localNow.day
  };
  let next = localTimeToUtc({
    ...localDate,
    hour: schedule.hour,
    minute: schedule.minute,
    second: 0
  }, NIGHTLY_REFRESH_TIME_ZONE);

  if (next.getTime() <= now.getTime() + 1000) {
    localDate = addLocalCalendarDays(localDate, 1);
    next = localTimeToUtc({
      ...localDate,
      hour: schedule.hour,
      minute: schedule.minute,
      second: 0
    }, NIGHTLY_REFRESH_TIME_ZONE);
  }

  return next;
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function logNightlyRefreshStream(streamName, chunk) {
  const lines = String(chunk)
    .split(/\r?\n/)
    .filter(Boolean);
  for (const line of lines) {
    nightlyRefreshState.lastOutputAt = new Date().toISOString();
    if (streamName === "stderr") {
      nightlyRefreshState.lastError = line.slice(0, 1000);
      console.error(`[hawley-nightly-refresh] ${line}`);
    } else {
      console.log(`[hawley-nightly-refresh] ${line}`);
    }
  }
}

function logNightlyAirtableBackfillStream(streamName, chunk) {
  const lines = String(chunk)
    .split(/\r?\n/)
    .filter(Boolean);
  for (const line of lines) {
    nightlyAirtableBackfillState.lastOutputAt = new Date().toISOString();
    if (streamName === "stderr") {
      nightlyAirtableBackfillState.lastError = line.slice(0, 1000);
      console.error(`[hawley-airtable-backfill] ${line}`);
    } else {
      console.log(`[hawley-airtable-backfill] ${line}`);
    }
  }
}

function scheduleNextNightlyRefresh() {
  if (nightlyRefreshStopping || !nightlyRefreshState.enabled) return;
  if (nightlyRefreshTimer) {
    clearTimeout(nightlyRefreshTimer);
    nightlyRefreshTimer = null;
  }

  const nextRunAt = nextNightlyRefreshAt();
  if (!nextRunAt) {
    nightlyRefreshState.enabled = false;
    nightlyRefreshState.reason = "invalid HAWLEY_NIGHTLY_REFRESH_TIME";
    nightlyRefreshState.nextRunAt = "";
    console.warn("Hawley nightly refresh disabled: invalid HAWLEY_NIGHTLY_REFRESH_TIME.");
    return;
  }

  nightlyRefreshState.nextRunAt = nextRunAt.toISOString();
  const delayMs = Math.max(1000, Math.min(nextRunAt.getTime() - Date.now(), 2147483647));
  nightlyRefreshTimer = setTimeout(() => {
    nightlyRefreshTimer = null;
    runNightlyRefresh();
  }, delayMs);
  nightlyRefreshTimer.unref?.();
}

function runNightlyRefresh() {
  if (nightlyRefreshStopping || !nightlyRefreshState.enabled) return;
  if (nightlyRefreshProcess) {
    nightlyRefreshState.reason = "already running";
    scheduleNextNightlyRefresh();
    return;
  }

  const child = spawn(npmCommand(), ["run", NIGHTLY_REFRESH_SCRIPT], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  nightlyRefreshProcess = child;
  nightlyRefreshState.running = true;
  nightlyRefreshState.pid = child.pid || null;
  nightlyRefreshState.startedAt = new Date().toISOString();
  nightlyRefreshState.lastExit = null;
  nightlyRefreshState.lastError = "";
  nightlyRefreshState.reason = "running";

  child.stdout.on("data", chunk => logNightlyRefreshStream("stdout", chunk));
  child.stderr.on("data", chunk => logNightlyRefreshStream("stderr", chunk));
  child.on("error", error => {
    nightlyRefreshState.lastError = error.message;
    nightlyRefreshState.reason = "spawn failed";
    console.error(`Hawley nightly refresh failed to start: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    nightlyRefreshProcess = null;
    nightlyRefreshState.running = false;
    nightlyRefreshState.pid = null;
    nightlyRefreshState.lastExit = {
      code,
      signal,
      at: new Date().toISOString()
    };

    if (nightlyRefreshStopping || !nightlyRefreshState.enabled) {
      nightlyRefreshState.reason = "stopped";
      return;
    }

    nightlyRefreshState.reason = code === 0 ? "scheduled" : "failed";
    if (code === 0 && nightlyAirtableBackfillState.enabled) {
      runNightlyAirtableBackfill(() => scheduleNextNightlyRefresh());
      return;
    }
    scheduleNextNightlyRefresh();
  });
}

function nightlyRefreshNeedsAirtable() {
  const script = String(NIGHTLY_REFRESH_SCRIPT || "").toLowerCase();
  return script.includes("airtable") || script === "pg:refresh-all" || script === "pg:refresh-hawley-read-model";
}

function configureNightlyAirtableBackfill() {
  nightlyAirtableBackfillState.requested = shouldRunNightlyAirtableBackfill();
  nightlyAirtableBackfillState.enabled = false;
  nightlyAirtableBackfillState.apply = shouldApplyNightlyAirtableBackfill();
  nightlyAirtableBackfillState.windowDays = NIGHTLY_AIRTABLE_BACKFILL_WINDOW_DAYS;
  nightlyAirtableBackfillState.reason = "";

  if (!nightlyAirtableBackfillState.requested) {
    nightlyAirtableBackfillState.reason = "disabled";
    return;
  }

  if (!process.env.AIRTABLE_PAT || !process.env.AIRTABLE_BASE) {
    nightlyAirtableBackfillState.reason = "missing AIRTABLE_PAT or AIRTABLE_BASE";
    console.warn("Hawley nightly Airtable backfill disabled: missing Airtable configuration.");
    return;
  }

  if (!syncDatabaseConfigured()) {
    nightlyAirtableBackfillState.reason = "missing HAWLEY_SYNC_DATABASE_URL or HAWLEY_MIGRATION_DATABASE_URL";
    console.warn("Hawley nightly Airtable backfill disabled: missing sync database URL.");
    return;
  }

  if (!Number.isFinite(NIGHTLY_AIRTABLE_BACKFILL_WINDOW_DAYS) || NIGHTLY_AIRTABLE_BACKFILL_WINDOW_DAYS < 1) {
    nightlyAirtableBackfillState.reason = "invalid HAWLEY_NIGHTLY_AIRTABLE_BACKFILL_WINDOW_DAYS";
    console.warn("Hawley nightly Airtable backfill disabled: window days must be at least 1.");
    return;
  }

  nightlyAirtableBackfillState.enabled = true;
  nightlyAirtableBackfillState.reason = "scheduled after nightly refresh";
}

function runNightlyAirtableBackfill(onComplete = () => {}) {
  if (nightlyRefreshStopping || !nightlyAirtableBackfillState.enabled) {
    onComplete();
    return;
  }
  if (nightlyAirtableBackfillProcess) {
    nightlyAirtableBackfillState.reason = "already running";
    onComplete();
    return;
  }

  const args = [
    "run",
    NIGHTLY_AIRTABLE_BACKFILL_SCRIPT,
    "--",
    "--window-days",
    String(Math.trunc(NIGHTLY_AIRTABLE_BACKFILL_WINDOW_DAYS))
  ];
  if (nightlyAirtableBackfillState.apply) args.push("--apply");

  const backfillEnv = { ...process.env };
  if (nightlyAirtableBackfillState.apply) {
    backfillEnv.HAWLEY_ALLOW_SOURCE_WRITES = "true";
    backfillEnv.HAWLEY_DRY_RUN = "false";
  }

  const child = spawn(npmCommand(), args, {
    cwd: repoRoot,
    env: backfillEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  nightlyAirtableBackfillProcess = child;
  nightlyAirtableBackfillState.running = true;
  nightlyAirtableBackfillState.pid = child.pid || null;
  nightlyAirtableBackfillState.startedAt = new Date().toISOString();
  nightlyAirtableBackfillState.lastExit = null;
  nightlyAirtableBackfillState.lastError = "";
  nightlyAirtableBackfillState.reason = nightlyAirtableBackfillState.apply ? "running apply" : "running dry run";

  child.stdout.on("data", chunk => logNightlyAirtableBackfillStream("stdout", chunk));
  child.stderr.on("data", chunk => logNightlyAirtableBackfillStream("stderr", chunk));
  child.on("error", error => {
    nightlyAirtableBackfillState.lastError = error.message;
    nightlyAirtableBackfillState.reason = "spawn failed";
    console.error(`Hawley nightly Airtable backfill failed to start: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    nightlyAirtableBackfillProcess = null;
    nightlyAirtableBackfillState.running = false;
    nightlyAirtableBackfillState.pid = null;
    nightlyAirtableBackfillState.lastExit = {
      code,
      signal,
      at: new Date().toISOString()
    };
    nightlyAirtableBackfillState.reason = code === 0 ? "scheduled after nightly refresh" : "failed";
    onComplete();
  });
}

function startNightlyRefreshScheduler() {
  nightlyRefreshState.requested = shouldStartNightlyRefreshScheduler();
  nightlyRefreshState.enabled = false;
  nightlyRefreshState.reason = "";
  configureNightlyAirtableBackfill();

  if (!nightlyRefreshState.requested) {
    nightlyRefreshState.reason = "disabled";
    if (nightlyAirtableBackfillState.enabled) {
      nightlyAirtableBackfillState.reason = "waiting for nightly refresh scheduler";
    }
    return;
  }

  if (!process.env.ASANA_PAT) {
    nightlyRefreshState.reason = "missing ASANA_PAT";
    console.warn("Hawley nightly refresh disabled: missing ASANA_PAT.");
    return;
  }

  if (nightlyRefreshNeedsAirtable() && (!process.env.AIRTABLE_PAT || !process.env.AIRTABLE_BASE)) {
    nightlyRefreshState.reason = "missing AIRTABLE_PAT or AIRTABLE_BASE";
    console.warn("Hawley nightly refresh disabled: missing Airtable configuration.");
    return;
  }

  if (!syncDatabaseConfigured()) {
    nightlyRefreshState.reason = "missing HAWLEY_SYNC_DATABASE_URL or HAWLEY_MIGRATION_DATABASE_URL";
    console.warn("Hawley nightly refresh disabled: missing sync database URL.");
    return;
  }

  try {
    if (!nextNightlyRefreshAt()) {
      nightlyRefreshState.reason = "invalid HAWLEY_NIGHTLY_REFRESH_TIME";
      console.warn("Hawley nightly refresh disabled: invalid HAWLEY_NIGHTLY_REFRESH_TIME.");
      return;
    }
  } catch (error) {
    nightlyRefreshState.reason = "invalid HAWLEY_NIGHTLY_REFRESH_TIME_ZONE";
    nightlyRefreshState.lastError = error.message;
    console.warn(`Hawley nightly refresh disabled: ${error.message}`);
    return;
  }

  nightlyRefreshState.enabled = true;
  nightlyRefreshState.reason = "scheduled";
  scheduleNextNightlyRefresh();
}

function stopNightlyRefreshScheduler(signal = "SIGTERM") {
  nightlyRefreshStopping = true;
  if (nightlyRefreshTimer) {
    clearTimeout(nightlyRefreshTimer);
    nightlyRefreshTimer = null;
  }
  if (nightlyRefreshProcess && !nightlyRefreshProcess.killed) {
    nightlyRefreshProcess.kill(signal);
  }
  if (nightlyAirtableBackfillProcess && !nightlyAirtableBackfillProcess.killed) {
    nightlyAirtableBackfillProcess.kill(signal);
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

async function ensureMigrationTable(client) {
  await client.query(`
    create table if not exists sync.schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )
  `);
}

async function applyStartupMigrations() {
  if (!APPLY_MIGRATIONS_ON_START) return;
  if (!syncDatabaseConfigured()) {
    console.warn("Hawley startup migrations skipped: missing sync database URL.");
    return;
  }

  const client = new pg.Client(getDatabaseConfig({ useSyncUrl: true }));
  await client.connect();
  await client.query("begin");
  try {
    await client.query("create schema if not exists sync");
    await ensureMigrationTable(client);

    const migrationFiles = (await fs.readdir(migrationsDir))
      .filter(file => file.endsWith(".sql"))
      .sort();

    for (const file of migrationFiles) {
      const alreadyApplied = await client.query(
        "select 1 from sync.schema_migrations where filename = $1",
        [file]
      );
      if (alreadyApplied.rowCount) continue;

      const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
      console.log(`Applying Hawley migration ${file}`);
      await client.query(sql);
      await client.query(
        "insert into sync.schema_migrations (filename) values ($1)",
        [file]
      );
    }

    const viewFiles = (await fs.readdir(viewsDir))
      .filter(file => file.endsWith(".sql"))
      .sort();

    for (const file of viewFiles) {
      const sql = await fs.readFile(path.join(viewsDir, file), "utf8");
      console.log(`Applying Hawley view ${file}`);
      await client.query(sql);
    }

    await client.query("commit");
    console.log("Hawley startup migrations verified.");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

async function applyAuthSchemaMigrationIfNeeded() {
  if (!APP_AUTH_ACTIVE && !APP_AUTH_SEED_ROSTER_ON_START && !APP_AUTH_BOOTSTRAP_ENABLED) return;
  if (!syncDatabaseConfigured()) {
    console.warn("Hawley auth schema migration skipped: missing sync database URL.");
    return;
  }

  const client = new pg.Client(getDatabaseConfig({ useSyncUrl: true }));
  await client.connect();
  try {
    const exists = await client.query("select to_regclass('core.app_users') as table_name");
    if (exists.rows[0]?.table_name) return;

    await client.query("begin");
    await client.query("create schema if not exists sync");
    await ensureMigrationTable(client);
    const migrationFile = "014_app_user_auth.sql";
    const sql = await fs.readFile(path.join(migrationsDir, migrationFile), "utf8");
    console.log(`Applying Hawley auth migration ${migrationFile}`);
    await client.query(sql);
    await client.query(
      `
        insert into sync.schema_migrations (filename)
        values ($1)
        on conflict (filename) do update set applied_at = now()
      `,
      [migrationFile]
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
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

function clockToMinutes(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

function timeZoneParts(date, timeZone = SHOP_TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return parts;
}

function isoDateInTimeZone(date, timeZone = SHOP_TIME_ZONE) {
  const parsed = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(parsed.getTime())) return todayIso();
  const parts = timeZoneParts(parsed, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function timeZoneOffsetMinutes(date, timeZone = SHOP_TIME_ZONE) {
  const parts = timeZoneParts(date, timeZone);
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
  return (localAsUtc - date.getTime()) / 60000;
}

function dateAtZonedClock(isoDate, clock, timeZone = SHOP_TIME_ZONE) {
  const dateMatch = String(isoDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) return null;
  const minutes = clockToMinutes(clock);
  const localAsUtc = Date.UTC(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Math.floor(minutes / 60),
    minutes % 60,
    0,
    0
  );
  let utcMs = localAsUtc;
  for (let i = 0; i < 3; i += 1) {
    const offsetMinutes = timeZoneOffsetMinutes(new Date(utcMs), timeZone);
    const nextUtcMs = localAsUtc - offsetMinutes * 60000;
    if (Math.abs(nextUtcMs - utcMs) < 1000) break;
    utcMs = nextUtcMs;
  }
  return new Date(utcMs);
}

function scheduledWorkWindowsForDate(workDate) {
  if (!isIsoDate(workDate)) return [];
  return SHOP_WORK_WINDOWS
    .map(window => ({
      start: dateAtZonedClock(workDate, window.start),
      end: dateAtZonedClock(workDate, window.end)
    }))
    .filter(window => window.start && window.end && window.end > window.start);
}

function scheduledWorkMinutesBetween(startValue, endValue, workDate = "") {
  const startedAt = startValue instanceof Date ? startValue : new Date(startValue);
  const stoppedAt = endValue instanceof Date ? endValue : new Date(endValue);
  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(stoppedAt.getTime()) || stoppedAt <= startedAt) return 0;
  const date = isIsoDate(workDate) ? workDate : isoDateInTimeZone(startedAt);
  let minutes = 0;
  for (const window of scheduledWorkWindowsForDate(date)) {
    const overlapStart = Math.max(startedAt.getTime(), window.start.getTime());
    const overlapEnd = Math.min(stoppedAt.getTime(), window.end.getTime());
    if (overlapEnd > overlapStart) minutes += (overlapEnd - overlapStart) / 60000;
  }
  return minutes > 0 ? Math.max(1, Math.round(minutes)) : 0;
}

function isWithinScheduledWorkWindow(value, workDate = "") {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const dateKey = isIsoDate(workDate) ? workDate : isoDateInTimeZone(date);
  return scheduledWorkWindowsForDate(dateKey).some(window => date >= window.start && date < window.end);
}

function effectiveScheduledStopDate(value, workDate = "") {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const dateKey = isIsoDate(workDate) ? workDate : isoDateInTimeZone(date);
  const windows = scheduledWorkWindowsForDate(dateKey);
  let latestBoundary = null;
  for (const window of windows) {
    if (date >= window.start && date < window.end) return date;
    if (date >= window.end) latestBoundary = window.end;
    if (date < window.start) break;
  }
  return latestBoundary || null;
}

function scheduledWindowEndForStart(value, workDate = "") {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const dateKey = isIsoDate(workDate) ? workDate : isoDateInTimeZone(date);
  return scheduledWorkWindowsForDate(dateKey).find(window => date < window.end)?.end || null;
}

function scheduledAutoStopReason(stopAt, workDate = "") {
  const date = stopAt instanceof Date ? stopAt : new Date(stopAt);
  if (Number.isNaN(date.getTime())) return "scheduled_pause";
  const dateKey = isIsoDate(workDate) ? workDate : isoDateInTimeZone(date);
  const windows = scheduledWorkWindowsForDate(dateKey);
  const matchingWindow = windows.find(window => Math.abs(window.end.getTime() - date.getTime()) < 1000);
  if (!matchingWindow) return "scheduled_pause";
  const lastWindow = windows[windows.length - 1];
  return lastWindow && Math.abs(lastWindow.end.getTime() - date.getTime()) < 1000 ? "end_of_day" : "scheduled_pause";
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

function cycleSummaryKey(value) {
  const cycleNumber = cycleNumberFromName(value);
  return cycleNumber ? `cycle-${cycleNumber}` : slugify(formatCycleName(value) || "current");
}

function formatPhaseName(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^phase\s+[a-z]$/i.test(text)) return `Phase ${text.slice(-1).toUpperCase()}`;
  if (/^[a-z]$/i.test(text)) return `Phase ${text.toUpperCase()}`;
  return text;
}

function adminPhaseFamilyName(value) {
  const phase = formatPhaseName(value);
  const clean = phase.replace(/^Phase\s+/i, "").trim();
  if (/^A[12]$/i.test(clean)) return "Phase A";
  if (/^FAB[-\s]?[AB]?$/i.test(clean)) return "FAB";
  if (/^CNC[-\s]?[AB]?$/i.test(clean)) return "CNC";
  if (/^Frame[-\s]?[AB]?$/i.test(clean) || /^Frames?$/i.test(clean)) return "Frames";
  return phase || "Unassigned";
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
    actualTimeOnDateMinutes: 0,
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
    targetHours: Number(row.hours_per_day || SHOP_DAILY_AVAILABLE_HOURS),
    tasks: [],
    assignedHours: 0,
    completedHours: 0,
    remainingHours: 0,
    actualTimeMinutes: 0,
    actualTimeLoggedMinutes: 0,
    actualTimeCompletedMinutes: 0,
    actualTimeWipMinutes: 0,
    actualTimeTotalMinutes: 0,
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
        targetHours: SHOP_DAILY_AVAILABLE_HOURS,
        tasks: [],
        assignedHours: 0,
        completedHours: 0,
        remainingHours: 0,
        actualTimeMinutes: 0,
        actualTimeLoggedMinutes: 0,
        actualTimeCompletedMinutes: 0,
        actualTimeWipMinutes: 0,
        actualTimeTotalMinutes: 0,
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
      actualTimeLoggedMinutes: 0,
      actualTimeCompletedMinutes: 0,
      actualTimeWipMinutes: 0,
      actualTimeTotalMinutes: 0,
      actualTimeLoggedHours: 0,
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
    Number(worker.actualTimeLoggedMinutes || 0) > 0 ||
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
  const actualTimeCompletedMinutes = workerList.reduce((sum, worker) => (
    sum + Number(worker.actualTimeCompletedMinutes || 0)
  ), 0);
  const actualTimeWipMinutes = workerList.reduce((sum, worker) => (
    sum + Number(worker.actualTimeWipMinutes || 0)
  ), 0);
  const actualTimeLoggedMinutes = actualTimeCompletedMinutes + actualTimeWipMinutes;
  const targetMinutes = workersWithWork.length * SHOP_DAILY_AVAILABLE_MINUTES;
  const dataQualityFlags = dataQualityFlagsForWorkers(workerList);

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
    actualTimeCompletedMinutes,
    actualTimeWipMinutes,
    actualTimeTotalMinutes: actualTimeLoggedMinutes,
    actualTimeLoggedHours: round(actualTimeLoggedMinutes / 60),
    targetMinutes,
    targetHours: round(targetMinutes / 60),
    pacingDeltaMinutes: actualTimeLoggedMinutes - targetMinutes,
    dataQualityFlags,
    overCapacityCount: dataQualityFlags.length,
    overCapacityWorkers: dataQualityFlags,
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
    cycleProgressPercent: numberValue(fields["Cycle Progress %"]),
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
    actualHours: 0,
    snapshotActualHours: snapshot.actualHours,
    actualTimeLoggedHours: 0,
    actualTimeLoggedMinutes: 0,
    actualTimeCompletedMinutes: 0,
    actualTimeWipMinutes: 0,
    actualTimeTotalMinutes: 0,
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

function taskEstimateHours(task) {
  const estimatedMinutes = Number(task?.estimatedMinutes || 0);
  if (estimatedMinutes > 0) return round(estimatedMinutes / 60);
  const estimatedHours = Number(task?.estimatedHours || 0);
  if (estimatedHours > 0) return round(estimatedHours);
  return round(Number(task?.assignedHours || task?.targetHours || 0));
}

function normalizeTaskEstimate(task) {
  if (!task) return task;
  const estimateHours = taskEstimateHours(task);
  if (estimateHours > 0) {
    task.assignedHours = estimateHours;
    task.targetHours = estimateHours;
    task.estimatedHours = estimateHours;
    task.estimatedMinutes = Number(task.estimatedMinutes || 0) || minutesFromHours(estimateHours);
  }
  return task;
}

function mergeTaskLists(existingTasks, nextTasks) {
  const tasksById = new Map();

  for (const task of [...(existingTasks || []), ...(nextTasks || [])]) {
    const key = task.id || `${task.title}-${task.cycle}-${task.vin}-${task.order}`;
    if (!tasksById.has(key)) tasksById.set(key, normalizeTaskEstimate(task));
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
    actualTimeCompletedMinutes: 0,
    actualTimeWipMinutes: 0,
    actualTimeTotalMinutes: 0,
    targetHours: Number(row.hours_per_day || SHOP_DAILY_AVAILABLE_HOURS),
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
    actualTimeCompletedMinutes: 0,
    actualTimeWipMinutes: 0,
    actualTimeTotalMinutes: 0,
    targetHours: SHOP_DAILY_AVAILABLE_HOURS,
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

  const mergedWorkers = Array.from(mergedById.values());
  for (const worker of mergedWorkers) {
    recalculateSnapshotWorkerCompletion(worker);
  }

  return mergedWorkers.sort((a, b) => {
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
  const tasks = (worker.tasks || []).map(normalizeTaskEstimate);
  worker.tasks = tasks;
  const completedTasks = tasks.filter(task => task.completed);
  const assignedHours = tasks.reduce((sum, task) => sum + taskEstimateHours(task), 0);
  const actualTimeCompletedMinutes = (worker.tasks || []).reduce((sum, task) => (
    sum + (task.completed ? Number(task.actualTimeOnDateMinutes || 0) : 0)
  ), 0);
  const actualTimeWipMinutes = (worker.tasks || []).reduce((sum, task) => (
    sum + (!task.completed ? Number(task.actualTimeOnDateMinutes || 0) : 0)
  ), 0);
  const actualTimeTotalMinutes = actualTimeCompletedMinutes + actualTimeWipMinutes;
  worker.taskCount = (worker.tasks || []).length;
  worker.completedTaskCount = completedTasks.length;
  worker.assignedHours = round(assignedHours);
  worker.completedHours = round(completedTasks.reduce((sum, task) => sum + taskEstimateHours(task), 0));
  worker.remainingHours = round(Math.max(0, assignedHours - worker.completedHours));
  worker.actualTimeCompletedMinutes = actualTimeCompletedMinutes;
  worker.actualTimeWipMinutes = actualTimeWipMinutes;
  worker.actualTimeTotalMinutes = actualTimeTotalMinutes;
  worker.actualTimeLoggedMinutes = actualTimeTotalMinutes;
  worker.actualTimeLoggedHours = round(actualTimeTotalMinutes / 60);
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
      task.actualTimeOnDateMinutes = Number(task.actualTimeOnDateMinutes || 0);
      task.sopUrl = publicLink(textValue(fields["SOP Link"]) || task.sopUrl);
      task.estimatedMinutes = estimatedMinutes || task.estimatedMinutes || minutesFromHours(task.assignedHours);
      if (estimatedMinutes) {
        const estimateHours = round(estimatedMinutes / 60);
        task.assignedHours = estimateHours;
        task.targetHours = estimateHours;
        task.estimatedHours = estimateHours;
      } else {
        task.targetHours = Number(task.targetHours || task.assignedHours || 0);
      }
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
    loggedMinutes: Math.max(actualMinutes, timerMinutes),
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

  for (const row of actualRows || []) {
    const workerId = workerIdForDailyActual(row);
    const worker = workerById.get(workerId) || workerByName.get(slugify(row.workerName));
    if (!worker) continue;

    if (row.dailySummary || row.taskId === "__daily__") {
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
  const hasCalendarDates = Boolean(calendar?.dates?.length);
  const dates = hasCalendarDates
    ? [...calendar.dates]
    : Array.from(byDate.keys()).sort((a, b) => a.localeCompare(b));

  if (!hasCalendarDates && isIsoDate(selectedDate) && !dates.includes(selectedDate)) {
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

async function reportingCycleSummaries(selectedDate, selectedCycleName = "") {
  const calendarResult = await pool.query(`
    select
      cycle_number,
      cycle_label,
      start_date::text,
      end_date::text,
      days_in_cycle,
      holidays
    from reporting.hawley_cycle_calendar
    where start_date is not null
    order by cycle_number nulls last, start_date
  `);

  const selectedKey = cycleSummaryKey(selectedCycleName);
  const currentDate = todayIso();
  return calendarResult.rows
    .map(row => {
      const cycle = formatCycleName(row.cycle_label || row.cycle_number);
      const key = cycleSummaryKey(cycle);
      const holidays = holidayDatesFromField(row.holidays, row.start_date);
      const dates = cycleWorkdays(row.start_date, row.end_date, holidays, row.days_in_cycle);
      const dayCount = dates.length || Number(row.days_in_cycle || 0);
      const primaryDate = dates[dates.length - 1] || row.end_date || row.start_date || selectedDate;
      return {
        key,
        cycle,
        cycleNumber: Number(row.cycle_number || cycleNumberFromName(cycle) || 0),
        startDate: row.start_date || "",
        endDate: row.end_date || "",
        dayCount,
        firstDate: dates[0] || row.start_date || "",
        lastDate: dates[dates.length - 1] || row.end_date || "",
        primaryDate,
        snapshotDays: 0,
        workerCount: 0,
        assignedHours: 0,
        completedHours: 0,
        remainingHours: 0,
        taskCount: 0,
        completedTaskCount: 0,
        openTaskCount: 0,
        completionPercent: 0,
        completeTaskLabel: "",
        selected: key === selectedKey,
        status: row.end_date && row.end_date < currentDate ? "Complete" : "Assigned",
      };
    })
    .map(row => ({
      ...row,
      primaryDate: row.primaryDate || row.lastDate || row.firstDate || selectedDate
    }))
    .filter(row => row.selected || !row.startDate || row.startDate <= currentDate)
    .sort((a, b) =>
      (b.cycleNumber || 0) - (a.cycleNumber || 0) ||
      String(b.startDate || b.firstDate || "").localeCompare(String(a.startDate || a.firstDate || "")) ||
      a.cycle.localeCompare(b.cycle)
    );
}

async function reportingNavigation(date) {
  const selectedDate = isIsoDate(date) ? date : todayIso();
  const dayPayload = await cycleDays(selectedDate);
  const cycles = await reportingCycleSummaries(selectedDate, dayPayload?.cycle || "");
  return {
    ...dayPayload,
    source: "hawley-reporting-navigation",
    cycles,
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
    where job_name in ('pull_airtable', 'pull_worker_daily_actuals', 'pull_asana', 'pull_asana_events', 'pull_daily_tracker', 'backfill_airtable_worker_actuals')
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
    daysInCycle: dates.length,
    holidays: Array.from(holidays).sort(),
    dates
  };
}

async function cycleDays(date) {
  const dateCalendar = await cycleCalendar("", date);
  const calendarCycle = dateCalendar?.cycle || null;
  const result = await pool.query(
    `
      with selected as (
        select coalesce(
          $2::text,
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
    [date, calendarCycle]
  );

  const selectedRow = result.rows.find(row => row.assigned_on === date) || result.rows.find(row => row.cycle_name);
  const calendar = dateCalendar || await cycleCalendar(formatCycleName(selectedRow?.cycle_name), date);
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
        and source_system = $2
      order by
        worker_name nulls last,
        task_name nulls last
    `,
    [date, LIVE_WORKER_SOURCE]
  );

  return result.rows.map(normalizeWorkerDailyActual);
}

function actualLoggedMinutesFromRaw(row) {
  return Math.max(Number(row.actual_minutes || 0), Number(row.timer_minutes || 0));
}

function summarizeTaskActualHistory(rows) {
  const byDate = new Map();
  const workerIds = new Set();
  let totalMinutes = 0;

  for (const row of rows || []) {
    const loggedMinutes = actualLoggedMinutesFromRaw(row);
    if (loggedMinutes <= 0) continue;
    const date = row.work_date || "";
    const workerId = row.worker_key || slugifyWorker({
      workerEmail: row.worker_email,
      workerName: row.worker_name
    });
    if (workerId) workerIds.add(workerId);
    totalMinutes += loggedMinutes;
    byDate.set(date, (byDate.get(date) || 0) + loggedMinutes);
  }

  const dates = Array.from(byDate.entries())
    .map(([date, minutes]) => ({ date, minutes }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    totalMinutes,
    totalHours: round(totalMinutes / 60),
    dateCount: dates.length,
    workerCount: workerIds.size,
    firstDate: dates[0]?.date || "",
    lastDate: dates[dates.length - 1]?.date || "",
    dates
  };
}

async function attachWorkerTaskActualHistory(workers) {
  const taskIds = Array.from(new Set(
    (workers || [])
      .flatMap(worker => (worker.tasks || []).map(task => String(task.id || task.asanaTaskGid || "")))
      .filter(id => /^\d+$/.test(id))
  ));
  if (!taskIds.length) return;

  const result = await pool.query(
    `
      select
        worker_key,
        worker_name,
        worker_email,
        asana_task_gid,
        task_name,
        work_date::text,
        actual_minutes,
        timer_minutes,
        asana_posted_minutes,
        completed,
        source_label,
        source_synced_at::text
      from hb.worker_daily_task_actuals
      where asana_task_gid = any($1::text[])
        and not daily_summary
        and source_system = $2
      order by
        asana_task_gid,
        work_date,
        worker_name nulls last
    `,
    [taskIds, LIVE_WORKER_SOURCE]
  );

  const byTask = new Map();
  const byTaskWorker = new Map();
  for (const row of result.rows) {
    const taskId = String(row.asana_task_gid || "");
    if (!taskId) continue;
    const workerId = row.worker_key || slugifyWorker({
      workerEmail: row.worker_email,
      workerName: row.worker_name
    });
    if (!byTask.has(taskId)) byTask.set(taskId, []);
    byTask.get(taskId).push(row);
    const taskWorkerKey = `${taskId}::${workerId}`;
    if (!byTaskWorker.has(taskWorkerKey)) byTaskWorker.set(taskWorkerKey, []);
    byTaskWorker.get(taskWorkerKey).push(row);
  }

  for (const worker of workers || []) {
    for (const task of worker.tasks || []) {
      const taskId = String(task.id || task.asanaTaskGid || "");
      if (!taskId) continue;
      const workerHistory = summarizeTaskActualHistory(byTaskWorker.get(`${taskId}::${worker.id}`) || []);
      const teamHistory = summarizeTaskActualHistory(byTask.get(taskId) || []);
      task.actualHistory = workerHistory;
      task.teamActualHistory = teamHistory;
      task.actualTimeAllDatesMinutes = workerHistory.totalMinutes;
      task.teamActualTimeAllDatesMinutes = teamHistory.totalMinutes;
      task.actualHistoryDateCount = workerHistory.dateCount;
      task.teamActualHistoryDateCount = teamHistory.dateCount;
      task.teamActualWorkerCount = teamHistory.workerCount;
      task.actualHistoryCoverage = workerHistory.dateCount
        ? `${workerHistory.firstDate}${workerHistory.lastDate && workerHistory.lastDate !== workerHistory.firstDate ? ` to ${workerHistory.lastDate}` : ""}`
        : "";
      task.teamActualHistoryCoverage = teamHistory.dateCount
        ? `${teamHistory.firstDate}${teamHistory.lastDate && teamHistory.lastDate !== teamHistory.firstDate ? ` to ${teamHistory.lastDate}` : ""}`
        : "";
    }
  }
}

async function dailyAssignmentsPayload(url, authActor = null) {
  const date = url.searchParams.get("date") || todayIso();
  let requestedEmployee = url.searchParams.get("employee") || "";
  if (APP_AUTH_ACTIVE) {
    if (!authActor) throw actionError("Sign in to Hawley to load assignments.", 401, { code: "AUTH_REQUIRED" });
    if (!actorIsManager(authActor)) {
      const requestedWorker = requestedEmployee ? canonicalWorkerIdForWrites(requestedEmployee) : authActor.workerKey;
      if (requestedWorker && requestedWorker !== authActor.workerKey) {
        throw actionError("This login is not allowed to load that worker page.", 403, { code: "WORKER_ACCESS_DENIED" });
      }
      requestedEmployee = authActor.workerKey;
    }
  }
  const employee = requestedEmployee ? canonicalWorkerIdForWrites(requestedEmployee) : "";
  const includeNoWork = INCLUDE_NO_WORK_WORKERS || booleanQuery(url.searchParams.get("includeNoWork"));
  if (!isIsoDate(date)) {
    const error = new Error("Date must be YYYY-MM-DD.");
    error.statusCode = 400;
    throw error;
  }

  await autoCloseScheduledTimersForDate(date);
  await enforceScheduledActualsForDate(date);

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
    cycleDayPayload = employee ? null : await reportingNavigation(date);
  }

  const workers = visibleWorkersForRequest(allWorkers, employee, includeNoWork);
  await attachWorkerTaskActualHistory(workers);
  const managerLineOverview = employee
    ? null
    : lineOverview
      ? snapshotToLineOverview(lineOverview)
      : buildLineOverview(workers, date, latestRuns);

  if (managerLineOverview && cycleDayPayload?.cycle) {
    managerLineOverview.cycle = cycleDayPayload.cycle;
  }

  const dataQualityFlags = dataQualityFlagsForWorkers(workers);

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
    lineOverview: managerLineOverview,
    managerSignals: employee ? null : buildManagerSignals(workers),
    dataQuality: {
      maxProductiveMinutes: SHOP_DAILY_AVAILABLE_MINUTES,
      overCapacityCount: dataQualityFlags.length,
      flags: dataQualityFlags
    },
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

function accountRoleForEmail(email, fallback = "worker") {
  const normalized = normalizeEmail(email);
  if (APP_AUTH_ADMIN_EMAILS.has(normalized)) return "admin";
  if (APP_AUTH_MANAGER_EMAILS.has(normalized)) return "manager";
  return fallback;
}

function appAuthBaseStatus(user = null) {
  return {
    installed: true,
    active: APP_AUTH_ACTIVE,
    sessionRequired: APP_AUTH_ACTIVE,
    authenticated: Boolean(user),
    user,
    cookieName: APP_AUTH_COOKIE_NAME,
    sessionTtlHours: Number.isFinite(APP_AUTH_SESSION_TTL_HOURS) ? APP_AUTH_SESSION_TTL_HOURS : 12,
    rosterSeedOnStart: APP_AUTH_SEED_ROSTER_ON_START,
    bootstrapEnabled: APP_AUTH_BOOTSTRAP_ENABLED,
    managerEmailsConfigured: APP_AUTH_MANAGER_EMAILS.size,
    adminEmailsConfigured: APP_AUTH_ADMIN_EMAILS.size,
    runtime: { ...authRuntimeState }
  };
}

function authStatusPayload(user = null) {
  return {
    writePinRequired: false,
    mode: WORKER_WRITES_ENABLED ? "hawley-live-worker-writes" : "hawley-read-only-pilot",
    workerWritesEnabled: WORKER_WRITES_ENABLED,
    workerWritesAll: WORKER_WRITES_ALL,
    managerControlEnabled: WORKER_WRITES_ENABLED,
    transitionReviewsEnabled: TRANSITION_REVIEWS_ENABLED,
    writeWorkerIds: workerWriteIds(),
    writeWorkerNames: WORKER_WRITES_ENABLED && !WORKER_WRITES_ALL ? [JACOB_R_WORKER_NAME] : [],
    liveWriteScope: WORKER_WRITES_ALL
      ? "timer rows in Hawley plus Asana completion for assigned worker tasks"
      : "timer rows in Hawley plus Asana completion for approved pilot workers only",
    accountAuth: appAuthBaseStatus(user)
  };
}

function authSessionTtlSeconds() {
  const hours = Number.isFinite(APP_AUTH_SESSION_TTL_HOURS) && APP_AUTH_SESSION_TTL_HOURS > 0
    ? APP_AUTH_SESSION_TTL_HOURS
    : 12;
  return Math.round(hours * 60 * 60);
}

function sessionTokenHash(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const key = await scryptAsync(String(password || ""), salt, 64);
  return `scrypt$1$${salt}$${Buffer.from(key).toString("hex")}`;
}

async function verifyPassword(password, storedHash) {
  const [scheme, version, salt, keyHex] = String(storedHash || "").split("$");
  if (scheme !== "scrypt" || version !== "1" || !salt || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const actual = Buffer.from(await scryptAsync(String(password || ""), salt, expected.length));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function authUserPayload(row) {
  if (!row) return null;
  return {
    id: Number(row.app_user_id || 0),
    username: row.username || "",
    displayName: row.display_name || row.worker_name || row.username || "",
    email: row.email || row.worker_email || "",
    role: row.role || "worker",
    active: Boolean(row.active),
    workerKey: row.worker_key || "",
    workerName: row.worker_name || "",
    workerEmail: row.worker_email || "",
    temporaryPassword: Boolean(row.temporary_password)
  };
}

function actorIsManager(actor) {
  return Boolean(actor && ["manager", "admin"].includes(actor.role));
}

function actorIsAdmin(actor) {
  return Boolean(actor && actor.role === "admin");
}

function authActorSummary(actor) {
  if (!actor) return null;
  return {
    appUserId: actor.id,
    username: actor.username,
    displayName: actor.displayName,
    email: actor.email,
    role: actor.role,
    workerKey: actor.workerKey,
    workerName: actor.workerName,
    workerEmail: actor.workerEmail
  };
}

function actorAuditPayload(actor, actingForWorkerKey = "") {
  const summary = authActorSummary(actor);
  if (!summary) return {};
  return {
    authActor: summary,
    authActingForWorkerKey: actingForWorkerKey || "",
    authActingForAnotherWorker: Boolean(actingForWorkerKey && actingForWorkerKey !== summary.workerKey)
  };
}

async function recordAuthEvent(client, eventType, details = {}) {
  await client.query(
    `
      insert into core.app_auth_events (
        event_type,
        app_user_id,
        username,
        worker_key,
        role,
        success,
        reason,
        ip_address,
        user_agent,
        payload
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
    `,
    [
      eventType,
      details.user?.id || details.appUserId || null,
      details.username || details.user?.username || null,
      details.user?.workerKey || null,
      details.user?.role || null,
      Boolean(details.success),
      details.reason || null,
      details.ipAddress || null,
      details.userAgent || null,
      JSON.stringify(details.payload || {})
    ]
  );
}

async function prepareAuthClient(client) {
  await client.query("set statement_timeout = 5000");
}

async function seedInactiveAuthUsersFromWorkForce() {
  if (!APP_AUTH_SEED_ROSTER_ON_START || !syncDatabaseConfigured()) return;
  const client = new pg.Client(getDatabaseConfig({ useSyncUrl: true }));
  await client.connect();
  try {
    await client.query(
      `
        insert into core.app_users (
          username,
          display_name,
          email,
          worker_key,
          worker_name,
          worker_email,
          role,
          active,
          source_system,
          source_synced_at
        )
        select
          lower(nullif(worker_email, '')) as username,
          worker_name,
          lower(nullif(worker_email, '')) as email,
          'asana-' || trim(both '-' from regexp_replace(
            case
              when lower(nullif(worker_email, '')) like 'asana+%' then substring(lower(nullif(worker_email, '')) from 7)
              else lower(nullif(worker_email, ''))
            end,
            '[^a-z0-9]+',
            '-',
            'g'
          )) as worker_key,
          worker_name,
          lower(nullif(worker_email, '')) as worker_email,
          'worker',
          false,
          'hawley_work_force',
          source_synced_at
        from (
          select distinct on (lower(nullif(worker_email, ''))) *
          from hb.work_force
          where actively_employed
            and nullif(worker_email, '') is not null
          order by lower(nullif(worker_email, '')), source_synced_at desc nulls last, worker_name
        ) workforce
        on conflict (username) do update set
          display_name = excluded.display_name,
          email = excluded.email,
          worker_key = excluded.worker_key,
          worker_name = excluded.worker_name,
          worker_email = excluded.worker_email,
          source_system = excluded.source_system,
          source_synced_at = excluded.source_synced_at,
          updated_at = now()
      `
    );

    for (const email of new Set([...APP_AUTH_MANAGER_EMAILS, ...APP_AUTH_ADMIN_EMAILS])) {
      await client.query(
        `
          update core.app_users
          set role = $2, updated_at = now()
          where username = $1
        `,
        [email, accountRoleForEmail(email)]
      );
    }
  } catch (error) {
    console.warn(`Hawley auth roster seed skipped: ${error.message}`);
  } finally {
    await client.end();
  }
}

async function applyBootstrapAdminUser() {
  if (!APP_AUTH_BOOTSTRAP_ENABLED) return;
  if (!APP_AUTH_BOOTSTRAP_EMAIL || !APP_AUTH_BOOTSTRAP_PASSWORD) {
    console.warn("Hawley auth bootstrap skipped: missing HAWLEY_AUTH_BOOTSTRAP_EMAIL or HAWLEY_AUTH_BOOTSTRAP_PASSWORD.");
    return;
  }

  const client = new pg.Client(getDatabaseConfig({ useSyncUrl: true }));
  await client.connect();
  try {
    const passwordHash = await hashPassword(APP_AUTH_BOOTSTRAP_PASSWORD);
    await client.query(
      `
        insert into core.app_users (
          username,
          display_name,
          email,
          worker_key,
          worker_name,
          worker_email,
          role,
          active,
          password_hash,
          password_set_at,
          temporary_password,
          source_system
        )
        select
          $1,
          coalesce(worker_name, $1),
          $1,
          coalesce('asana-' || trim(both '-' from regexp_replace(
            case
              when lower(nullif(worker_email, '')) like 'asana+%' then substring(lower(nullif(worker_email, '')) from 7)
              else lower(nullif(worker_email, ''))
            end,
            '[^a-z0-9]+',
            '-',
            'g'
          )), ''),
          worker_name,
          lower(worker_email),
          'admin',
          true,
          $2,
          now(),
          true,
          'hawley_auth_bootstrap'
        from (select * from hb.work_force where lower(worker_email) = $1 limit 1) wf
        right join (select 1) one on true
        on conflict (username) do update set
          role = 'admin',
          active = true,
          password_hash = excluded.password_hash,
          password_set_at = now(),
          temporary_password = true,
          updated_at = now()
      `,
      [APP_AUTH_BOOTSTRAP_EMAIL, passwordHash]
    );
    console.log("Hawley auth bootstrap admin user verified.");
  } catch (error) {
    console.warn(`Hawley auth bootstrap skipped: ${error.message}`);
  } finally {
    await client.end();
  }
}

async function authActorFromRequest(req) {
  if (!APP_AUTH_ACTIVE) return null;
  const token = parseCookies(req)[APP_AUTH_COOKIE_NAME];
  if (!token) return null;
  const tokenHash = sessionTokenHash(token);
  authRuntimeState.lastSessionCheckAt = new Date().toISOString();
  authRuntimeState.lastSessionCheckStep = "connect";
  authRuntimeState.lastSessionCheckError = "";
  const client = await pool.connect();
  try {
    await prepareAuthClient(client);
    authRuntimeState.lastSessionCheckStep = "select_session";
    const result = await client.query(
      `
        select
          users.*
        from core.app_sessions sessions
        join core.app_users users on users.app_user_id = sessions.app_user_id
        where sessions.session_token_hash = $1
          and sessions.revoked_at is null
          and sessions.expires_at > now()
          and users.active
        limit 1
      `,
      [tokenHash]
    );
    if (!result.rows[0]) return null;
    authRuntimeState.lastSessionCheckStep = "touch_session";
    await client.query(
      "update core.app_sessions set last_seen_at = now() where session_token_hash = $1",
      [tokenHash]
    );
    authRuntimeState.lastSessionCheckStep = "ok";
    return authUserPayload(result.rows[0]);
  } catch (error) {
    authRuntimeState.lastSessionCheckError = error.message || String(error);
    throw error;
  } finally {
    client.release();
  }
}

async function requireAuthActor(req) {
  const actor = await authActorFromRequest(req);
  if (!actor) throw actionError("Sign in to Hawley to continue.", 401, { code: "AUTH_REQUIRED" });
  return actor;
}

function requireManagerActor(actor) {
  if (!APP_AUTH_ACTIVE) return;
  if (!actorIsManager(actor)) throw actionError("Manager access is required.", 403, { code: "MANAGER_REQUIRED" });
}

function requireAdminActor(actor) {
  if (!APP_AUTH_ACTIVE) return;
  if (!actorIsAdmin(actor)) throw actionError("Admin access is required.", 403, { code: "ADMIN_REQUIRED" });
}

function requireWorkerAccess(actor, workerKey) {
  if (!APP_AUTH_ACTIVE) return;
  if (actorIsManager(actor)) return;
  if (actor?.workerKey && workerKey && actor.workerKey === workerKey) return;
  throw actionError("This login is not allowed to use that worker page.", 403, { code: "WORKER_ACCESS_DENIED" });
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
    taskName: row.task_name || fields["Task Name"] || "",
    startedAt: fields["Timer Started At"] || "",
    accumulatedMinutes: Number(row.timer_minutes || fields["Timer Minutes"] || 0),
    actualMinutes: Number(row.actual_minutes || fields["Actual Minutes"] || 0),
    asanaPostedMinutes: Number(row.asana_posted_minutes || fields["Asana Posted Minutes"] || 0),
    completed: Boolean(row.completed) || booleanFromField(fields["Completed?"]),
    completionPending: booleanFromField(fields["Completion Pending?"]),
    timeEntryCreated: booleanFromField(fields["Time Entry Created?"])
  };
}

function liveTimerElapsedMinutes(timer, now, workDate = "") {
  const accumulated = Number(timer?.accumulatedMinutes || 0);
  if (!timer?.startedAt) return accumulated;
  const startedAt = new Date(timer.startedAt);
  if (Number.isNaN(startedAt.getTime())) return accumulated;
  return accumulated + scheduledWorkMinutesBetween(startedAt, now, workDate);
}

function liveTimerBaseActualMinutes(timer) {
  const actual = Number(timer?.actualMinutes || 0);
  const accumulated = Number(timer?.accumulatedMinutes || 0);
  return Math.max(0, actual - accumulated);
}

function liveTimerTotalActualMinutes(timer, now, workDate = "") {
  return liveTimerBaseActualMinutes(timer) + liveTimerElapsedMinutes(timer, now, workDate);
}

async function assignedWorkerTaskForWrite(employee, date, taskId, authActor = null) {
  const assignmentUrl = new URL("http://hawley.local/api/daily-assignments");
  assignmentUrl.searchParams.set("date", date);
  assignmentUrl.searchParams.set("employee", employee);
  assignmentUrl.searchParams.set("includeNoWork", "true");
  const payload = await dailyAssignmentsPayload(assignmentUrl, authActor);
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
        task_name,
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

async function blockingLiveTimerForWorker(client, workerId, date, exceptTaskId = "") {
  const result = await client.query(
    `
      select
        ledger_key,
        asana_task_gid,
        task_name,
        actual_minutes,
        timer_minutes,
        asana_posted_minutes,
        completed,
        fields_json
      from hb.worker_daily_task_actuals
      where worker_key = $1
        and work_date = $2::date
        and coalesce(asana_task_gid, '') <> $3
        and coalesce(completed, false) = false
        and source_system = $4
        and (
          coalesce(fields_json ->> 'Timer Started At', '') <> ''
          or coalesce(timer_minutes, 0) > 0
        )
      order by
        case when coalesce(fields_json ->> 'Timer Started At', '') <> '' then 0 else 1 end,
        source_synced_at desc nulls last,
        worker_daily_actual_id desc
      limit 1
    `,
    [workerId, date, String(exceptTaskId || ""), LIVE_WORKER_SOURCE]
  );
  return liveTimerFromRow(result.rows[0]);
}

async function acquireWorkerDayTimerLock(client, workerId, date) {
  const key = `hawley-worker-timer::${workerId}::${date}`;
  await client.query("select pg_advisory_lock(hashtext($1))", [key]);
  return key;
}

async function releaseWorkerDayTimerLock(client, key) {
  if (!key) return;
  try {
    await client.query("select pg_advisory_unlock(hashtext($1))", [key]);
  } catch (error) {
    console.warn(`Could not release worker timer lock ${key}: ${error.message}`);
  }
}

function liveActualFields(worker, task, date, timer, options = {}) {
  const actualMinutes = Number(options.actualMinutes ?? timer.actualMinutes ?? timer.accumulatedMinutes ?? 0);
  const timerMinutes = Number(options.timerMinutes ?? timer.accumulatedMinutes ?? 0);
  const asanaPostedMinutes = Number(options.asanaPostedMinutes ?? timer.asanaPostedMinutes ?? 0);
  const completed = Boolean(options.completed);
  const authAudit = actorAuditPayload(options.authActor, worker.id);
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
    "Was Assigned In DAT?": true,
    ...(authAudit.authActor ? {
      "Auth Actor User ID": authAudit.authActor.appUserId,
      "Auth Actor Email": authAudit.authActor.email,
      "Auth Actor Role": authAudit.authActor.role,
      "Auth Acting For Worker Key": authAudit.authActingForWorkerKey,
      "Auth Acting For Another Worker?": authAudit.authActingForAnotherWorker
    } : {})
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

function eventKey(prefix) {
  return `${prefix}:${crypto.randomUUID()}`;
}

function phaseKeyFromLabel(value) {
  return String(value || "unspecified")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unspecified";
}

function phaseKeyForTask(task) {
  return task.workAreaKey || phaseKeyFromLabel(task.workArea || task.phase || "Unspecified");
}

function phaseNameForTask(task) {
  return formatPhaseName(task.workArea || task.phase || "Unspecified") || "Unspecified";
}

function estimatedMinutesForTask(task) {
  return Number(task.estimatedMinutes || 0) || minutesFromHours(task.targetHours || task.assignedHours || task.estimatedHours || 0);
}

function sessionKeyForWorkerTask(workerId, date, taskId, startedAt) {
  const timestamp = new Date(startedAt);
  const safeStartedAt = Number.isNaN(timestamp.getTime()) ? String(startedAt || "") : timestamp.toISOString();
  return `${workerId}::${date}::${taskId}::${safeStartedAt}`;
}

function runningSegmentMinutes(timer, now, workDate = "") {
  if (!timer?.startedAt) return 0;
  const startedAt = new Date(timer.startedAt);
  if (Number.isNaN(startedAt.getTime())) return 0;
  return scheduledWorkMinutesBetween(startedAt, now, workDate);
}

async function recordWorkerTaskEvent(client, worker, task, date, eventType, eventTimestamp, options = {}) {
  const phaseKey = phaseKeyForTask(task);
  const phaseName = phaseNameForTask(task);
  const payload = {
    ...actorAuditPayload(options.authActor, worker.id),
    ...(options.payload || {})
  };
  const result = await client.query(
    `
      insert into core.worker_task_events (
        event_key,
        worker_key,
        worker_name,
        worker_email,
        asana_task_gid,
        task_instance_id,
        task_name,
        phase_key,
        phase_name,
        work_date,
        event_type,
        event_timestamp,
        duration_minutes,
        source,
        sync_status,
        payload,
        notes
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date,
        $11, $12::timestamptz, $13, 'hawley_worker_app', $14, $15::jsonb, $16
      )
      returning worker_task_event_id
    `,
    [
      eventKey(`worker-task-${eventType}`),
      worker.id,
      worker.name,
      worker.email || "",
      String(task.id || ""),
      task.taskInstanceId || null,
      task.title || "",
      phaseKey,
      phaseName,
      date,
      eventType,
      eventTimestamp,
      options.durationMinutes ?? null,
      options.syncStatus || "not_ready",
      JSON.stringify(payload),
      options.notes || null
    ]
  );
  return result.rows[0];
}

async function startTimeSession(client, worker, task, date, startedAt, payload = {}) {
  const phaseKey = phaseKeyForTask(task);
  const phaseName = phaseNameForTask(task);
  const result = await client.query(
    `
      insert into core.time_sessions (
        session_key,
        worker_key,
        worker_name,
        worker_email,
        asana_task_gid,
        task_instance_id,
        task_name,
        phase_key,
        phase_name,
        reporting_phase_key,
        reporting_phase_name,
        work_date,
        started_at,
        estimated_minutes,
        source,
        source_payload
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $8, $9,
        $10::date, $11::timestamptz, $12, 'hawley_worker_app', $13::jsonb
      )
      on conflict (session_key) do update set
        worker_name = excluded.worker_name,
        worker_email = excluded.worker_email,
        task_name = excluded.task_name,
        phase_key = excluded.phase_key,
        phase_name = excluded.phase_name,
        reporting_phase_key = excluded.reporting_phase_key,
        reporting_phase_name = excluded.reporting_phase_name,
        estimated_minutes = excluded.estimated_minutes,
        source_payload = core.time_sessions.source_payload || excluded.source_payload,
        updated_at = now()
      returning *
    `,
    [
      sessionKeyForWorkerTask(worker.id, date, task.id, startedAt),
      worker.id,
      worker.name,
      worker.email || "",
      String(task.id || ""),
      task.taskInstanceId || null,
      task.title || "",
      phaseKey,
      phaseName,
      date,
      startedAt,
      estimatedMinutesForTask(task),
      JSON.stringify(payload)
    ]
  );
  return result.rows[0];
}

async function closeTimeSession(client, worker, task, date, startedAt, stoppedAt, stopReason, durationMinutes, payload = {}) {
  if (!startedAt) return null;
  const sessionKey = sessionKeyForWorkerTask(worker.id, date, task.id, startedAt);
  const phaseKey = phaseKeyForTask(task);
  const phaseName = phaseNameForTask(task);
  const update = await client.query(
    `
      update core.time_sessions
      set
        stopped_at = $2::timestamptz,
        duration_minutes = $3,
        stop_reason = $4,
        source_payload = source_payload || $5::jsonb,
        updated_at = now()
      where session_key = $1
      returning *
    `,
    [sessionKey, stoppedAt, durationMinutes, stopReason, JSON.stringify(payload)]
  );
  if (update.rows[0]) return update.rows[0];

  const insert = await client.query(
    `
      insert into core.time_sessions (
        session_key,
        worker_key,
        worker_name,
        worker_email,
        asana_task_gid,
        task_instance_id,
        task_name,
        phase_key,
        phase_name,
        reporting_phase_key,
        reporting_phase_name,
        work_date,
        started_at,
        stopped_at,
        duration_minutes,
        estimated_minutes,
        stop_reason,
        source,
        source_payload
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $8, $9,
        $10::date, $11::timestamptz, $12::timestamptz, $13, $14, $15,
        'hawley_worker_app', $16::jsonb
      )
      on conflict (session_key) do update set
        stopped_at = excluded.stopped_at,
        duration_minutes = excluded.duration_minutes,
        stop_reason = excluded.stop_reason,
        source_payload = core.time_sessions.source_payload || excluded.source_payload,
        updated_at = now()
      returning *
    `,
    [
      sessionKey,
      worker.id,
      worker.name,
      worker.email || "",
      String(task.id || ""),
      task.taskInstanceId || null,
      task.title || "",
      phaseKey,
      phaseName,
      date,
      startedAt,
      stoppedAt,
      durationMinutes,
      estimatedMinutesForTask(task),
      stopReason,
      JSON.stringify(payload)
    ]
  );
  return insert.rows[0];
}

function workerFromActualRow(row) {
  return {
    id: row.worker_key || "",
    name: row.worker_name || "",
    email: row.worker_email || ""
  };
}

function taskFromActualRow(row) {
  return {
    id: row.asana_task_gid || "",
    title: row.task_name || "",
    phase: row.phase_label || "",
    workArea: row.phase_label || "",
    vin: row.vin || "",
    cycle: row.cycle_label || "",
    assignedHours: Number(row.assigned_hours || 0),
    targetHours: Number(row.allocated_hours || row.assigned_hours || 0),
    estimatedMinutes: minutesFromHours(row.allocated_hours || row.assigned_hours || 0),
    sourceUrl: row.task_url || ""
  };
}

async function autoCloseScheduledTimersForDate(date) {
  if (!WORKER_WRITES_ENABLED || !isIsoDate(date)) return 0;
  const now = new Date();
  if (date > isoDateInTimeZone(now)) return 0;
  const client = await writePool.connect();
  let closedCount = 0;

  try {
    await client.query("begin");
    const result = await client.query(
      `
        select
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
          completed,
          fields_json
        from hb.worker_daily_task_actuals
        where work_date = $1::date
          and source_system = $2
          and not daily_summary
          and not completed
          and nullif(fields_json ->> 'Timer Started At', '') is not null
      `,
      [date, LIVE_WORKER_SOURCE]
    );

    for (const row of result.rows) {
      const timer = liveTimerFromRow(row);
      if (!timer?.startedAt) continue;
      const autoStopAt = scheduledWindowEndForStart(timer.startedAt, date);
      if (!autoStopAt || now < autoStopAt) continue;

      const eventIso = autoStopAt.toISOString();
      const reason = scheduledAutoStopReason(autoStopAt, date);
      const elapsedMinutes = liveTimerElapsedMinutes(timer, autoStopAt, date);
      const actualMinutes = liveTimerTotalActualMinutes(timer, autoStopAt, date);
      const segmentMinutes = runningSegmentMinutes(timer, autoStopAt, date);
      const worker = workerFromActualRow(row);
      const task = taskFromActualRow(row);

      await client.query(
        `
          update hb.worker_daily_task_actuals
          set
            actual_minutes = $2::integer,
            timer_minutes = $3::integer,
            last_seen_at = $4::timestamptz,
            source_synced_at = $4::timestamptz,
            source_label = $5::text,
            fields_json = coalesce(fields_json, '{}'::jsonb)
              || jsonb_build_object(
                'Timer Started At', '',
                'Timer Minutes', $3::integer,
                'Actual Minutes', $2::integer,
                'Schedule Auto Stopped?', true,
                'Schedule Auto Stop Reason', $6::text,
                'Schedule Auto Stopped At', $4
              ),
            normalized_at = now()
          where ledger_key = $1
            and source_system = $7
        `,
        [
          row.ledger_key,
          actualMinutes,
          elapsedMinutes,
          eventIso,
          reason === "end_of_day" ? "Hawley timer auto-stopped at end of day" : "Hawley timer auto-stopped for scheduled break/lunch",
          reason,
          LIVE_WORKER_SOURCE
        ]
      );

      await closeTimeSession(client, worker, task, date, timer.startedAt, eventIso, reason, segmentMinutes, {
        action: "schedule-auto-stop",
        ledgerKey: row.ledger_key,
        elapsedMinutes,
        actualMinutes,
        reason
      });
      await recordWorkerTaskEvent(client, worker, task, date, "stop", eventIso, {
        durationMinutes: segmentMinutes || elapsedMinutes,
        notes: "Timer auto-stopped by Hawley shop schedule.",
        payload: {
          action: "schedule-auto-stop",
          ledgerKey: row.ledger_key,
          elapsedMinutes,
          actualMinutes,
          reason
        }
      });
      closedCount += 1;
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    console.warn(`Hawley schedule auto-stop skipped: ${error.message}`);
  } finally {
    client.release();
  }

  return closedCount;
}

function scheduleCorrectionForActualRow(row, workDate) {
  const actualMinutes = Number(row.actual_minutes || 0);
  const timerMinutes = Number(row.timer_minutes || 0);
  const asanaPostedMinutes = Number(row.asana_posted_minutes || 0);
  const rawMinutes = Math.max(actualMinutes, timerMinutes, asanaPostedMinutes);
  const rawStopAt = new Date(row.last_seen_at || row.source_synced_at || row.normalized_at || "");
  if (!rawMinutes || Number.isNaN(rawStopAt.getTime())) return null;

  const rawStartAt = new Date(rawStopAt.getTime() - rawMinutes * 60000);
  const scheduledMinutes = scheduledWorkMinutesBetween(rawStartAt, rawStopAt, workDate);
  const correctedMinutes = Math.min(rawMinutes, scheduledMinutes);
  if (correctedMinutes >= rawMinutes) return null;

  const effectiveStopAt = effectiveScheduledStopDate(rawStopAt, workDate) || rawStopAt;
  return {
    rawMinutes,
    scheduledMinutes,
    correctedMinutes,
    rawStopAt: rawStopAt.toISOString(),
    effectiveStopAt: effectiveStopAt.toISOString(),
    newActualMinutes: actualMinutes > 0 ? correctedMinutes : actualMinutes,
    newTimerMinutes: timerMinutes > 0 ? Math.min(timerMinutes, correctedMinutes) : timerMinutes,
    newAsanaPostedMinutes: asanaPostedMinutes > 0 ? Math.min(asanaPostedMinutes, correctedMinutes) : asanaPostedMinutes
  };
}

function scheduleCorrectionForSession(row, workDate) {
  const rawMinutes = Number(row.duration_minutes || 0);
  const startedAt = new Date(row.started_at || "");
  const stoppedAt = new Date(row.stopped_at || "");
  if (!rawMinutes || Number.isNaN(startedAt.getTime()) || Number.isNaN(stoppedAt.getTime())) return null;

  const scheduledMinutes = scheduledWorkMinutesBetween(startedAt, stoppedAt, workDate);
  const correctedMinutes = Math.min(rawMinutes, scheduledMinutes);
  if (correctedMinutes >= rawMinutes) return null;

  const effectiveStopAt = effectiveScheduledStopDate(stoppedAt, workDate) || stoppedAt;
  return {
    rawMinutes,
    scheduledMinutes,
    correctedMinutes,
    rawStopAt: stoppedAt.toISOString(),
    effectiveStopAt: effectiveStopAt.toISOString()
  };
}

async function enforceScheduledActualsForDate(date) {
  scheduleCorrectionState.lastDate = date;
  scheduleCorrectionState.lastStartedAt = new Date().toISOString();
  scheduleCorrectionState.lastFinishedAt = "";
  scheduleCorrectionState.lastCandidateRows = 0;
  scheduleCorrectionState.lastCandidateSessions = 0;
  scheduleCorrectionState.lastCorrectedRows = 0;
  scheduleCorrectionState.lastCorrectedSessions = 0;
  scheduleCorrectionState.lastSkippedRows = 0;
  scheduleCorrectionState.lastError = "";
  scheduleCorrectionState.lastReason = "";
  scheduleCorrectionState.lastSamples = [];

  if (!isIsoDate(date)) {
    scheduleCorrectionState.lastReason = "invalid_date";
    scheduleCorrectionState.lastFinishedAt = new Date().toISOString();
    return { actualRows: 0, sessions: 0 };
  }
  if (!syncDatabaseConfigured()) {
    scheduleCorrectionState.lastReason = "missing_sync_database_url";
    scheduleCorrectionState.lastFinishedAt = new Date().toISOString();
    return { actualRows: 0, sessions: 0 };
  }

  const client = await writePool.connect();
  const counts = { actualRows: 0, sessions: 0 };

  try {
    await client.query("begin");
    const actualRows = await client.query(
      `
        select
          worker_daily_actual_id,
          actual_minutes,
          timer_minutes,
          asana_posted_minutes,
          last_seen_at,
          source_synced_at,
          normalized_at
        from hb.worker_daily_task_actuals
        where work_date = $1::date
          and source_system = $2
          and not daily_summary
          and greatest(
            coalesce(actual_minutes, 0),
            coalesce(timer_minutes, 0),
            coalesce(asana_posted_minutes, 0)
          ) > 0
          and not (coalesce(fields_json, '{}'::jsonb) ? 'Schedule Corrected At')
      `,
      [date, LIVE_WORKER_SOURCE]
    );
    scheduleCorrectionState.lastCandidateRows = actualRows.rowCount;

    for (const row of actualRows.rows) {
      const correction = scheduleCorrectionForActualRow(row, date);
      if (!correction) {
        scheduleCorrectionState.lastSkippedRows += 1;
        continue;
      }
      if (scheduleCorrectionState.lastSamples.length < 8) {
        scheduleCorrectionState.lastSamples.push({
          type: "actual",
          id: String(row.worker_daily_actual_id || ""),
          rawMinutes: correction.rawMinutes,
          scheduledMinutes: correction.scheduledMinutes,
          correctedMinutes: correction.correctedMinutes,
          rawStopAt: correction.rawStopAt,
          effectiveStopAt: correction.effectiveStopAt
        });
      }

      await client.query(
        `
          update hb.worker_daily_task_actuals
          set
            actual_minutes = $2::integer,
            timer_minutes = $3::integer,
            asana_posted_minutes = $4::integer,
            last_seen_at = $5::timestamptz,
            source_synced_at = $5::timestamptz,
            fields_json = coalesce(fields_json, '{}'::jsonb)
              || jsonb_build_object(
                'Schedule Raw Actual Minutes', actual_minutes,
                'Schedule Raw Timer Minutes', timer_minutes,
                'Schedule Raw Asana Posted Minutes', asana_posted_minutes,
                'Schedule Raw Logged Minutes', $6::integer,
                'Schedule Raw Stop At', $7::text,
                'Schedule Effective Stop At', $5,
                'Schedule Corrected At', now()::text,
                'Schedule Correction Source', $8::text,
                'Actual Minutes', $2::integer,
                'Timer Minutes', $3::integer,
                'Asana Posted Minutes', $4::integer
              ),
            normalized_at = now()
          where worker_daily_actual_id = $1
            and not (coalesce(fields_json, '{}'::jsonb) ? 'Schedule Corrected At')
        `,
        [
          row.worker_daily_actual_id,
          correction.newActualMinutes,
          correction.newTimerMinutes,
          correction.newAsanaPostedMinutes,
          correction.effectiveStopAt,
          correction.rawMinutes,
          correction.rawStopAt,
          SHOP_SCHEDULE_CORRECTION_SOURCE
        ]
      );
      counts.actualRows += 1;
    }

    const sessions = await client.query(
      `
        select
          time_session_id,
          started_at,
          stopped_at,
          duration_minutes
        from core.time_sessions
        where work_date = $1::date
          and source = 'hawley_worker_app'
          and started_at is not null
          and stopped_at is not null
          and coalesce(duration_minutes, 0) > 0
          and not (coalesce(source_payload, '{}'::jsonb) ? 'scheduleCorrectedAt')
      `,
      [date]
    );
    scheduleCorrectionState.lastCandidateSessions = sessions.rowCount;

    for (const row of sessions.rows) {
      const correction = scheduleCorrectionForSession(row, date);
      if (!correction) continue;
      if (scheduleCorrectionState.lastSamples.length < 8) {
        scheduleCorrectionState.lastSamples.push({
          type: "session",
          id: String(row.time_session_id || ""),
          rawMinutes: correction.rawMinutes,
          scheduledMinutes: correction.scheduledMinutes,
          correctedMinutes: correction.correctedMinutes,
          rawStopAt: correction.rawStopAt,
          effectiveStopAt: correction.effectiveStopAt
        });
      }

      await client.query(
        `
          update core.time_sessions
          set
            duration_minutes = $2::integer,
            stopped_at = $3::timestamptz,
            source_payload = coalesce(source_payload, '{}'::jsonb)
              || jsonb_build_object(
                'scheduleRawDurationMinutes', $4::integer,
                'scheduleCorrectedDurationMinutes', $2::integer,
                'scheduleRawStoppedAt', $5::text,
                'scheduleEffectiveStoppedAt', $3,
                'scheduleCorrectedAt', now()::text,
                'scheduleCorrectionSource', $6::text
              ),
            updated_at = now()
          where time_session_id = $1
            and not (coalesce(source_payload, '{}'::jsonb) ? 'scheduleCorrectedAt')
        `,
        [
          row.time_session_id,
          correction.correctedMinutes,
          correction.effectiveStopAt,
          correction.rawMinutes,
          correction.rawStopAt,
          SHOP_SCHEDULE_CORRECTION_SOURCE
        ]
      );
      counts.sessions += 1;
    }

    if (counts.actualRows || counts.sessions) {
      await client.query(
        `
          with daily_rollups as (
            select
              worker_key,
              work_date,
              sum(greatest(
                coalesce(actual_minutes, 0),
                coalesce(timer_minutes, 0),
                coalesce(asana_posted_minutes, 0)
              ))::integer as logged_minutes
            from hb.worker_daily_task_actuals
            where source_system = $1
              and work_date = $2::date
              and not daily_summary
            group by worker_key, work_date
          )
          update hb.worker_daily_task_actuals summaries
          set
            actual_minutes = rollups.logged_minutes,
            timer_minutes = case when coalesce(summaries.timer_minutes, 0) > 0 then rollups.logged_minutes else summaries.timer_minutes end,
            source_synced_at = now(),
            last_seen_at = now(),
            daily_available_minutes = $3::integer,
            daily_logged_minutes = rollups.logged_minutes,
            daily_efficiency_percent = round((rollups.logged_minutes / $3::numeric * 100)::numeric, 2),
            daily_efficiency_under_75 = rollups.logged_minutes < round(($3 * 0.75)::numeric, 0),
            efficiency_snapshot_at = now(),
            fields_json = coalesce(summaries.fields_json, '{}'::jsonb)
              || jsonb_build_object(
                'Actual Minutes', rollups.logged_minutes,
                'Daily Available Minutes', $3::integer,
                'Daily Logged Minutes', rollups.logged_minutes,
                'Daily Efficiency Percent', round((rollups.logged_minutes / $3::numeric * 100)::numeric, 2),
                'Daily Efficiency Under 75?', rollups.logged_minutes < round(($3 * 0.75)::numeric, 0),
                'Efficiency Snapshot At', now()::text,
                'Schedule Corrected At', now()::text,
                'Schedule Correction Source', 'daily summary recomputed from schedule-corrected task actuals'
              ),
            normalized_at = now()
          from daily_rollups rollups
          where summaries.source_system = $1
            and summaries.daily_summary
            and summaries.worker_key = rollups.worker_key
            and summaries.work_date = rollups.work_date
        `,
        [LIVE_WORKER_SOURCE, date, SHOP_DAILY_AVAILABLE_MINUTES]
      );
    }

    await client.query("commit");
    scheduleCorrectionState.lastCorrectedRows = counts.actualRows;
    scheduleCorrectionState.lastCorrectedSessions = counts.sessions;
    scheduleCorrectionState.lastReason = counts.actualRows || counts.sessions ? "corrected" : "no_corrections_needed";
  } catch (error) {
    await client.query("rollback").catch(() => {});
    scheduleCorrectionState.lastError = error.message;
    scheduleCorrectionState.lastReason = "error";
    console.warn(`Hawley schedule correction skipped: ${error.message}`);
  } finally {
    scheduleCorrectionState.lastFinishedAt = new Date().toISOString();
    client.release();
  }

  return counts;
}

function transitionBucketKey(minutes) {
  const value = Number(minutes || 0);
  if (value < 2) return "micro_transition";
  if (value < 5) return "normal_transition";
  if (value < 10) return "extended_transition";
  if (value < 20) return "alert_transition";
  if (value < 45) return "material_utilization_gap";
  return "major_gap";
}

function transitionAutoCategory(minutes) {
  return Number(minutes || 0) <= 5 ? "normal_transition" : "unknown_needs_review";
}

function numericMinutesBetween(start, end) {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return round(Math.max(0, (endMs - startMs) / 60000), 2);
}

async function assignmentChangedDuringGap(client, worker, previousEndedAt, nextStartedAt) {
  if (!worker?.email && !worker?.name) return false;
  const result = await client.query(
    `
      select 1
      from core.assignment_events
      where detected_at >= $1::timestamptz
        and detected_at <= $2::timestamptz
        and (
          lower(coalesce(new_assignee_email, '')) = lower($3)
          or lower(coalesce(previous_assignee_email, '')) = lower($3)
          or lower(coalesce(new_assignee_name, '')) = lower($4)
          or lower(coalesce(previous_assignee_name, '')) = lower($4)
        )
      limit 1
    `,
    [previousEndedAt, nextStartedAt, worker.email || "", worker.name || ""]
  );
  return Boolean(result.rowCount);
}

async function createTransitionForNewSession(client, worker, newSession) {
  if (!newSession?.started_at) return null;
  const previousResult = await client.query(
    `
      select *
      from core.time_sessions
      where worker_key = $1
        and work_date = $2::date
        and stopped_at is not null
        and started_at < $3::timestamptz
        and time_session_id <> $4
      order by stopped_at desc, time_session_id desc
      limit 1
    `,
    [newSession.worker_key, newSession.work_date, newSession.started_at, newSession.time_session_id]
  );
  const previous = previousResult.rows[0];
  if (!previous) return null;

  const rawGapMinutes = numericMinutesBetween(previous.stopped_at, newSession.started_at);
  const allowedTransitionMinutes = 5;
  const excessGapMinutes = round(Math.max(0, rawGapMinutes - allowedTransitionMinutes), 2);
  const gapBucket = transitionBucketKey(rawGapMinutes);
  const assignmentChanged = await assignmentChangedDuringGap(client, worker, previous.stopped_at, newSession.started_at);
  const previousEstimated = Number(previous.estimated_minutes || 0);
  const previousActual = Number(previous.duration_minutes || 0);
  const overEstimate = Boolean(previousEstimated > 0 && previousActual > previousEstimated + 15);
  const reviewRequired = rawGapMinutes >= 10 || excessGapMinutes > 0 || assignmentChanged || overEstimate;
  const autoCategory = transitionAutoCategory(rawGapMinutes);

  const result = await client.query(
    `
      insert into core.task_transition_events (
        transition_key,
        worker_key,
        worker_name,
        worker_email,
        work_date,
        previous_task_gid,
        previous_task_name,
        next_task_gid,
        next_task_name,
        previous_phase_key,
        previous_phase_name,
        next_phase_key,
        next_phase_name,
        reporting_phase_key,
        reporting_phase_name,
        previous_task_ended_at,
        next_task_started_at,
        raw_gap_minutes,
        gap_bucket,
        allowed_transition_minutes,
        excess_gap_minutes,
        previous_task_completed,
        previous_task_estimated_minutes,
        previous_task_actual_minutes,
        previous_task_over_estimate,
        next_task_assigned_before_gap,
        assignment_changed_during_gap,
        auto_category,
        auto_category_reason,
        review_required,
        source,
        source_payload
      )
      values (
        $1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, $11,
        $12, $13, $14, $15, $16::timestamptz, $17::timestamptz,
        $18, $19, $20, $21, $22, $23, $24, $25, true, $26,
        $27, $28, $29, 'hawley_worker_app', $30::jsonb
      )
      on conflict (transition_key) do update set
        worker_name = excluded.worker_name,
        worker_email = excluded.worker_email,
        previous_task_name = excluded.previous_task_name,
        next_task_name = excluded.next_task_name,
        previous_phase_key = excluded.previous_phase_key,
        previous_phase_name = excluded.previous_phase_name,
        next_phase_key = excluded.next_phase_key,
        next_phase_name = excluded.next_phase_name,
        reporting_phase_key = excluded.reporting_phase_key,
        reporting_phase_name = excluded.reporting_phase_name,
        raw_gap_minutes = excluded.raw_gap_minutes,
        gap_bucket = excluded.gap_bucket,
        excess_gap_minutes = excluded.excess_gap_minutes,
        previous_task_completed = excluded.previous_task_completed,
        previous_task_estimated_minutes = excluded.previous_task_estimated_minutes,
        previous_task_actual_minutes = excluded.previous_task_actual_minutes,
        previous_task_over_estimate = excluded.previous_task_over_estimate,
        next_task_assigned_before_gap = excluded.next_task_assigned_before_gap,
        assignment_changed_during_gap = excluded.assignment_changed_during_gap,
        auto_category = excluded.auto_category,
        auto_category_reason = excluded.auto_category_reason,
        review_required = excluded.review_required,
        source_payload = core.task_transition_events.source_payload || excluded.source_payload,
        updated_at = now()
      returning transition_event_id
    `,
    [
      `${newSession.worker_key}::${newSession.work_date}::${previous.time_session_id}->${newSession.time_session_id}`,
      newSession.worker_key,
      newSession.worker_name || previous.worker_name,
      newSession.worker_email || previous.worker_email,
      newSession.work_date,
      previous.asana_task_gid,
      previous.task_name,
      newSession.asana_task_gid,
      newSession.task_name,
      previous.reporting_phase_key || previous.phase_key,
      previous.reporting_phase_name || previous.phase_name,
      newSession.reporting_phase_key || newSession.phase_key,
      newSession.reporting_phase_name || newSession.phase_name,
      previous.reporting_phase_key || previous.phase_key,
      previous.reporting_phase_name || previous.phase_name,
      previous.stopped_at,
      newSession.started_at,
      rawGapMinutes,
      gapBucket,
      allowedTransitionMinutes,
      excessGapMinutes,
      previous.stop_reason === "complete",
      previousEstimated || null,
      previousActual || null,
      overEstimate,
      assignmentChanged,
      autoCategory,
      rawGapMinutes <= 5 ? "Gap is within expected transition allowance." : "Gap exceeds transition allowance and should be reviewed.",
      reviewRequired,
      JSON.stringify({
        previousSessionId: previous.time_session_id,
        nextSessionId: newSession.time_session_id
      })
    ]
  );

  return result.rows[0];
}

async function tryWorkerTransitionLedger(label, callback) {
  try {
    return await callback();
  } catch (error) {
    console.warn(`Hawley transition ledger skipped ${label}: ${error.message}`);
    return null;
  }
}

async function handleWorkerTaskAction(req) {
  const body = await readJsonBody(req);
  const action = String(body.action || "").trim().toLowerCase();
  const employee = canonicalWorkerIdForWrites(body.employee || "");
  const taskId = String(body.taskId || "").trim();
  const date = String(body.date || todayIso()).trim();
  const authActor = APP_AUTH_ACTIVE ? await requireAuthActor(req) : null;

  if (!["start", "stop", "release", "complete"].includes(action)) {
    throw actionError("Action must be start, stop, release, or complete.", 400);
  }
  requireWorkerAccess(authActor, employee);
  if (!employee || !workerWritesAllowed(employee)) {
    throw actionError("Live worker writes are not enabled for this employee.", 403, {
      mode: authStatusPayload().mode,
      writeWorkerIds: workerWriteIds()
    });
  }
  if (!taskId) throw actionError("Task ID is required.", 400);
  if (!isIsoDate(date)) throw actionError("Date must be YYYY-MM-DD.", 400);

  if (action === "start") {
    await autoCloseScheduledTimersForDate(date);
  }

  const { worker, task } = await assignedWorkerTaskForWrite(employee, date, taskId, authActor);
  const authAudit = actorAuditPayload(authActor, worker.id);
  const now = new Date();
  const nowIso = now.toISOString();
  const ledgerKey = ledgerKeyForWorkerTask(worker.id, date, task.id);
  const client = await writePool.connect();
  let workerTimerLockKey = "";

  try {
    workerTimerLockKey = await acquireWorkerDayTimerLock(client, worker.id, date);
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
          elapsedMinutes: liveTimerElapsedMinutes(current, now, date),
          completed: false
        };
      }

      if (!isWithinScheduledWorkWindow(now, date)) {
        throw actionError("Timers can only be started during scheduled shop time: 7:00 AM-3:30 PM, excluding breaks and lunch.", 409, {
          code: "OUTSIDE_SCHEDULED_WORK_TIME"
        });
      }

      const blocking = await blockingLiveTimerForWorker(client, worker.id, date, task.id);
      if (blocking) {
        throw actionError("Complete the current task, or have a manager use End Session, before starting another task.", 409, {
          code: "TIMER_SESSION_BLOCKED",
          blockingTaskId: blocking.taskId,
          blockingTaskName: blocking.taskName || ""
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
        seenAt: nowIso,
        authActor
      });
      await tryWorkerTransitionLedger("start", async () => {
        await recordWorkerTaskEvent(client, worker, task, date, "start", nowIso, {
          authActor,
          payload: {
            ...authAudit,
            startedAt: saved.startedAt,
            accumulatedMinutes: saved.accumulatedMinutes,
            ledgerKey
          }
        });
        const session = await startTimeSession(client, worker, task, date, saved.startedAt || nowIso, {
          action: "start",
          ...authAudit,
          ledgerKey,
          accumulatedMinutes: saved.accumulatedMinutes
        });
        await createTransitionForNewSession(client, worker, session);
      });

      return {
        ok: true,
        action,
        taskId,
        startedAt: saved.startedAt,
        accumulatedMinutes: saved.accumulatedMinutes,
        elapsedMinutes: liveTimerElapsedMinutes(saved, now, date),
        completed: false
      };
    }

    if (!current) {
      throw actionError("Start the timer before stopping or completing this task.", 409);
    }

    const eventAt = effectiveScheduledStopDate(now, date) || now;
    const eventIso = eventAt.toISOString();
    const elapsedMinutes = liveTimerElapsedMinutes(current, eventAt, date);
    const actualMinutes = liveTimerTotalActualMinutes(current, eventAt, date);
    const segmentMinutes = runningSegmentMinutes(current, eventAt, date);
    if (action === "stop") {
      const saved = await upsertLiveWorkerActual(client, worker, task, date, {
        ...current,
        startedAt: "",
        accumulatedMinutes: elapsedMinutes,
        actualMinutes
      }, {
        actualMinutes,
        timerMinutes: elapsedMinutes,
        asanaPostedMinutes: current.asanaPostedMinutes,
        sourceLabel: "Hawley timer stopped",
        seenAt: eventIso,
        authActor
      });
      await tryWorkerTransitionLedger("stop", async () => {
        await closeTimeSession(client, worker, task, date, current.startedAt, eventIso, "stop", segmentMinutes, {
          action: "stop",
          ...authAudit,
          ledgerKey,
          elapsedMinutes,
          actualMinutes
        });
        await recordWorkerTaskEvent(client, worker, task, date, "stop", eventIso, {
          authActor,
          durationMinutes: segmentMinutes || elapsedMinutes,
          payload: {
            ...authAudit,
            accumulatedMinutes: saved.accumulatedMinutes,
            actualMinutes: saved.actualMinutes,
            ledgerKey
          }
        });
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

    if (action === "release") {
      if (current.completionPending) {
        throw actionError("This timer is already being completed and cannot be ended as an open session.", 409);
      }
      if (current.completed) {
        throw actionError("This task is already completed in the Hawley timer ledger.", 409);
      }

      const saved = await upsertLiveWorkerActual(client, worker, task, date, {
        ...current,
        startedAt: "",
        accumulatedMinutes: 0,
        actualMinutes
      }, {
        actualMinutes,
        timerMinutes: 0,
        asanaPostedMinutes: current.asanaPostedMinutes,
        sourceLabel: "Hawley timer session ended",
        seenAt: eventIso,
        authActor
      });
      await tryWorkerTransitionLedger("release", async () => {
        await closeTimeSession(client, worker, task, date, current.startedAt, eventIso, "release", segmentMinutes, {
          action: "release",
          ...authAudit,
          ledgerKey,
          elapsedMinutes,
          actualMinutes
        });
        await recordWorkerTaskEvent(client, worker, task, date, "release", eventIso, {
          authActor,
          durationMinutes: segmentMinutes || elapsedMinutes,
          payload: {
            ...authAudit,
            elapsedMinutes,
            actualMinutes: saved.actualMinutes || actualMinutes,
            ledgerKey
          }
        });
      });

      return {
        ok: true,
        action,
        taskId,
        startedAt: "",
        accumulatedMinutes: 0,
        elapsedMinutes,
        actualMinutes: saved.actualMinutes || actualMinutes,
        completed: false,
        released: true
      };
    }

    if (actualMinutes <= 0) {
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
      actualMinutes
    }, {
      actualMinutes,
      timerMinutes: elapsedMinutes,
      asanaPostedMinutes: current.asanaPostedMinutes,
      completionPending: true,
      timeEntryCreated: current.timeEntryCreated,
      sourceLabel: "Hawley completion pending",
      seenAt: eventIso,
      authActor
    });
    await tryWorkerTransitionLedger("complete", async () => {
      await closeTimeSession(client, worker, task, date, current.startedAt, eventIso, "complete", segmentMinutes, {
        action: "complete",
        ...authAudit,
        ledgerKey,
        elapsedMinutes,
        actualMinutes
      });
      await recordWorkerTaskEvent(client, worker, task, date, "complete", eventIso, {
        authActor,
        durationMinutes: segmentMinutes || elapsedMinutes,
        syncStatus: "pending",
        payload: {
          ...authAudit,
          elapsedMinutes,
          actualMinutes,
          unpostedMinutes: Math.max(0, actualMinutes - Number(current.asanaPostedMinutes || 0)),
          ledgerKey
        }
      });
    });

    const unpostedMinutes = Math.max(0, actualMinutes - Number(current.asanaPostedMinutes || 0));
    const postedMinutes = Number(current.asanaPostedMinutes || 0) + unpostedMinutes;
    if (unpostedMinutes > 0) {
      await createTimeTrackingEntry(token, task.id, unpostedMinutes, date);
      await upsertLiveWorkerActual(client, worker, task, date, {
        ...current,
        startedAt: "",
        accumulatedMinutes: elapsedMinutes,
        actualMinutes,
        asanaPostedMinutes: postedMinutes
      }, {
        actualMinutes,
        timerMinutes: elapsedMinutes,
        asanaPostedMinutes: postedMinutes,
        completionPending: true,
        timeEntryCreated: true,
        sourceLabel: "Hawley Asana time posted",
        seenAt: eventIso,
        authActor
      });
    }

    await updateAsanaTask(token, task.id, { completed: true });
    await createAsanaStory(token, task.id, `Hawley worker pilot timer logged ${formatTimerMinutes(elapsedMinutes)}.`);
    const saved = await upsertLiveWorkerActual(client, worker, task, date, {
      ...current,
      startedAt: "",
      accumulatedMinutes: elapsedMinutes,
      actualMinutes,
      asanaPostedMinutes: Math.max(postedMinutes, current.asanaPostedMinutes || 0)
    }, {
      actualMinutes,
      timerMinutes: elapsedMinutes,
      asanaPostedMinutes: Math.max(postedMinutes, current.asanaPostedMinutes || 0),
      completed: true,
      completionPending: false,
      timeEntryCreated: true,
      sourceLabel: "Hawley task completed",
      seenAt: eventIso,
      authActor
    });

    return {
      ok: true,
      action,
      taskId,
      elapsedMinutes: saved.actualMinutes || actualMinutes,
      completed: true
    };
  } finally {
    await releaseWorkerDayTimerLock(client, workerTimerLockKey);
    client.release();
  }
}

function numberField(row, key) {
  const value = Number(row?.[key]);
  return Number.isFinite(value) ? value : 0;
}

function workerCapacityFlagPayload(worker) {
  const productiveMinutes = Number(worker.productiveTaskMinutes ?? worker.actualTimeLoggedMinutes ?? worker.actualTimeTotalMinutes ?? 0);
  const productiveUtilizationPercent = Number(worker.productiveUtilizationPercent || (
    SHOP_DAILY_AVAILABLE_MINUTES ? productiveMinutes / SHOP_DAILY_AVAILABLE_MINUTES * 100 : 0
  ));
  if (productiveMinutes <= SHOP_DAILY_AVAILABLE_MINUTES && productiveUtilizationPercent <= 100) return null;
  return {
    code: OVER_CAPACITY_FLAG,
    severity: "red",
    workerKey: worker.workerKey || worker.id || "",
    workerName: worker.workerName || worker.name || "",
    productiveTaskMinutes: productiveMinutes,
    productiveTaskHours: round(productiveMinutes / 60, 2),
    maxProductiveMinutes: SHOP_DAILY_AVAILABLE_MINUTES,
    maxProductiveHours: SHOP_DAILY_AVAILABLE_HOURS,
    productiveUtilizationPercent: round(productiveUtilizationPercent, 2),
    message: "Daily productive time exceeds the 7h40m shop capacity."
  };
}

function dataQualityFlagsForWorkers(workers) {
  return (workers || []).map(workerCapacityFlagPayload).filter(Boolean);
}

function textKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function phaseSlug(value) {
  return String(value || "unspecified")
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unspecified";
}

function phaseMatches(row, phaseFilter) {
  if (!phaseFilter) return true;
  const wanted = textKey(phaseFilter);
  return [
    row.phase_key,
    row.phaseKey,
    row.phaseSlug,
    row.phase_name,
    row.phaseName,
    phaseSlug(row.phase_key || row.phaseKey)
  ].some(value => textKey(value) === wanted);
}

function workerMatches(row, workerFilter) {
  if (!workerFilter) return true;
  const wanted = textKey(workerFilter);
  return [
    row.worker_key,
    row.workerKey,
    row.workerSlug,
    row.worker_email,
    row.workerEmail,
    row.worker_name,
    row.workerName,
    row.worker_identity,
    row.workerIdentity
  ].some(value => textKey(value) === wanted);
}

function transitionStats(rows) {
  const transitionRows = Array.isArray(rows) ? rows : [];
  const taskSwitchCount = transitionRows.filter(row =>
    String(row.previousTaskGid || "") &&
    String(row.nextTaskGid || "") &&
    String(row.previousTaskGid || "") !== String(row.nextTaskGid || "")
  ).length;
  const reviewRequiredCount = transitionRows.filter(row => row.reviewRequired).length;
  const unreviewedCount = transitionRows.filter(row => row.reviewRequired && !row.reviewedAt).length;
  return {
    transitionCount: transitionRows.length,
    taskSwitchCount,
    handoffGapCount: transitionRows.filter(row => row.previousTaskCompleted || String(row.previousTaskGid || "") !== String(row.nextTaskGid || "")).length,
    totalTransitionMinutes: round(transitionRows.reduce((sum, row) => sum + Number(row.rawGapMinutes || 0), 0), 2),
    excessTransitionMinutes: round(transitionRows.reduce((sum, row) => sum + Number(row.excessGapMinutes || 0), 0), 2),
    reviewRequiredCount,
    unreviewedTransitionCount: unreviewedCount,
    reviewedTransitionCount: transitionRows.filter(row => row.reviewedAt).length,
    maxTransitionMinutes: round(Math.max(0, ...transitionRows.map(row => Number(row.rawGapMinutes || 0))), 2),
    assignmentChangeCount: transitionRows.filter(row => row.assignmentChangedDuringGap).length
  };
}

function categoryPayload(row) {
  return {
    categoryKey: row.category_key,
    displayName: row.display_name,
    categoryGroup: row.category_group,
    displayOrder: numberField(row, "display_order"),
    managerSelectable: Boolean(row.manager_selectable),
    notes: row.notes || ""
  };
}

function transitionPayload(row) {
  return {
    transitionEventId: numberField(row, "transition_event_id"),
    transitionKey: row.transition_key || "",
    workerKey: row.worker_key || "",
    workerName: row.worker_name || "",
    workerEmail: row.worker_email || "",
    workerIdentity: row.worker_identity || "",
    workerSlug: slugifyWorker({ workerEmail: row.worker_email, workerName: row.worker_name }),
    workDate: row.work_date ? String(row.work_date).slice(0, 10) : "",
    previousTaskGid: row.previous_task_gid || "",
    previousTaskName: row.previous_task_name || "",
    nextTaskGid: row.next_task_gid || "",
    nextTaskName: row.next_task_name || "",
    previousPhaseKey: row.previous_phase_key || "",
    previousPhaseName: row.previous_phase_name || "",
    nextPhaseKey: row.next_phase_key || "",
    nextPhaseName: row.next_phase_name || "",
    phaseKey: row.reporting_phase_key || "",
    phaseName: row.reporting_phase_name || "",
    phaseSlug: phaseSlug(row.reporting_phase_key),
    previousTaskEndedAt: row.previous_task_ended_at || "",
    nextTaskStartedAt: row.next_task_started_at || "",
    rawGapMinutes: numberField(row, "raw_gap_minutes"),
    gapBucket: row.gap_bucket || "",
    gapBucketName: row.gap_bucket_name || row.gap_bucket || "",
    allowedTransitionMinutes: numberField(row, "allowed_transition_minutes"),
    excessGapMinutes: numberField(row, "excess_gap_minutes"),
    previousTaskCompleted: Boolean(row.previous_task_completed),
    previousTaskEstimatedMinutes: numberField(row, "previous_task_estimated_minutes"),
    previousTaskActualMinutes: numberField(row, "previous_task_actual_minutes"),
    previousTaskOverEstimate: Boolean(row.previous_task_over_estimate),
    nextTaskAssignedBeforeGap: Boolean(row.next_task_assigned_before_gap),
    assignmentChangedDuringGap: Boolean(row.assignment_changed_during_gap),
    loggedOutAlertTriggered: Boolean(row.logged_out_alert_triggered),
    overEstimateAlertTriggered: Boolean(row.over_estimate_alert_triggered),
    autoCategory: row.auto_category || "",
    autoCategoryName: row.auto_category_name || "",
    autoCategoryGroup: row.auto_category_group || "",
    autoCategoryReason: row.auto_category_reason || "",
    reviewRequired: Boolean(row.review_required),
    managerCategory: row.manager_category || "",
    managerCategoryName: row.manager_category_name || "",
    managerCategoryGroup: row.manager_category_group || "",
    managerNotes: row.manager_notes || "",
    reviewedBy: row.reviewed_by || "",
    reviewedAt: row.reviewed_at || "",
    managerFlagged: Boolean(row.manager_flagged),
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || ""
  };
}

function phaseSummaryPayload(row, transitions = []) {
  const stats = transitionStats(transitions);
  return {
    workDate: row.work_date ? String(row.work_date).slice(0, 10) : "",
    phaseKey: row.phase_key || "",
    phaseName: row.phase_name || row.phase_key || "Unspecified",
    phaseSlug: phaseSlug(row.phase_key),
    totalActualTaskMinutes: numberField(row, "total_actual_task_minutes"),
    totalActualTaskHours: numberField(row, "total_actual_task_hours"),
    totalTransitionMinutes: numberField(row, "total_transition_minutes") || stats.totalTransitionMinutes,
    excessTransitionMinutes: numberField(row, "excess_transition_minutes") || stats.excessTransitionMinutes,
    totalEstimatedMinutes: numberField(row, "total_estimated_minutes"),
    efficiencyPercent: numberField(row, "efficiency_percent"),
    assignedTaskCount: numberField(row, "assigned_task_count"),
    completedTaskCount: numberField(row, "completed_task_count"),
    assignedVsCompletedPercent: numberField(row, "assigned_vs_completed_percent"),
    startedTaskCount: numberField(row, "started_task_count"),
    workerCount: numberField(row, "worker_count"),
    assignedWorkerCount: numberField(row, "assigned_worker_count"),
    taskChurnCount: numberField(row, "task_churn_count"),
    gapsRequiringReviewCount: numberField(row, "gaps_requiring_review_count") || stats.reviewRequiredCount,
    reviewedGapCount: numberField(row, "reviewed_gap_count") || stats.reviewedTransitionCount,
    unreviewedGapCount: numberField(row, "unreviewed_gap_count") || stats.unreviewedTransitionCount,
    transitionStats: stats,
    topTransitionCategory: row.top_transition_category || "",
    topManagerCategoryGroup: row.top_manager_category_group || ""
  };
}

function workerPhaseSummaryPayload(row, transitions = []) {
  const stats = transitionStats(transitions);
  return {
    workDate: row.work_date ? String(row.work_date).slice(0, 10) : "",
    workerKey: row.worker_key || "",
    workerName: row.worker_name || "",
    workerEmail: row.worker_email || "",
    workerSlug: slugifyWorker({ workerEmail: row.worker_email, workerName: row.worker_name }),
    phaseKey: row.phase_key || "",
    phaseName: row.phase_name || row.phase_key || "Unspecified",
    phaseSlug: phaseSlug(row.phase_key),
    actualTaskMinutes: numberField(row, "actual_task_minutes"),
    actualTaskHours: numberField(row, "actual_task_hours"),
    estimatedMinutes: numberField(row, "estimated_minutes"),
    transitionMinutes: numberField(row, "transition_minutes") || stats.totalTransitionMinutes,
    excessTransitionMinutes: numberField(row, "excess_transition_minutes") || stats.excessTransitionMinutes,
    efficiencyPercent: numberField(row, "efficiency_percent"),
    assignedTaskCount: numberField(row, "assigned_task_count"),
    startedTaskCount: numberField(row, "started_task_count"),
    completedTaskCount: numberField(row, "completed_task_count"),
    assignedVsCompletedPercent: numberField(row, "assigned_vs_completed_percent"),
    taskSessionCount: numberField(row, "task_session_count"),
    taskChurnCount: numberField(row, "task_churn_count"),
    gapsRequiringReviewCount: numberField(row, "gaps_requiring_review_count") || stats.reviewRequiredCount,
    transitionStats: stats,
    topTransitionCategory: row.top_transition_category || "",
    topManagerCategoryGroup: row.top_manager_category_group || ""
  };
}

async function transitionCategories() {
  const result = await pool.query(`
    select
      category_key,
      display_name,
      category_group,
      display_order,
      manager_selectable,
      notes
    from core.transition_category_catalog
    where active
    order by display_order, display_name
  `);
  return result.rows.map(categoryPayload);
}

async function utilizationReportPayload(url) {
  const date = url.searchParams.get("date") || todayIso();
  const phaseFilter = url.searchParams.get("phase") || "";
  const workerFilter = url.searchParams.get("worker") || "";
  if (!isIsoDate(date)) throw actionError("Date must be YYYY-MM-DD.", 400);

  await enforceScheduledActualsForDate(date);

  const [phaseResult, workerPhaseResult, workerDailyResult, transitionResult, categories] = await Promise.all([
    pool.query("select * from reporting.phase_day_summary where work_date = $1::date order by total_actual_task_minutes desc, total_estimated_minutes desc, phase_name", [date]),
    pool.query("select * from reporting.worker_phase_day_summary where work_date = $1::date order by actual_task_minutes desc, estimated_minutes desc, worker_name", [date]),
    pool.query("select * from reporting.worker_daily_utilization where work_date = $1::date order by productive_task_minutes desc, worker_name", [date]),
    pool.query("select * from reporting.transition_event_detail where work_date = $1::date order by previous_task_ended_at nulls last, next_task_started_at nulls last, transition_event_id", [date]),
    transitionCategories()
  ]);

  const transitions = transitionResult.rows
    .map(transitionPayload)
    .filter(row => phaseMatches(row, phaseFilter) && workerMatches(row, workerFilter));
  const phases = phaseResult.rows
    .filter(row => phaseMatches(row, phaseFilter))
    .map(row => phaseSummaryPayload(row, transitions.filter(transition => phaseMatches(transition, row.phase_key))));
  const workerPhases = workerPhaseResult.rows
    .filter(row => phaseMatches(row, phaseFilter) && workerMatches(row, workerFilter))
    .map(row => workerPhaseSummaryPayload(
      row,
      transitions.filter(transition => phaseMatches(transition, row.phase_key) && workerMatches(transition, row.worker_key))
    ));
  const workerDaily = workerDailyResult.rows
    .filter(row => workerMatches(row, workerFilter))
    .map(row => {
      const productiveTaskMinutes = numberField(row, "productive_task_minutes");
      const totalTransitionMinutes = numberField(row, "total_transition_minutes");
      const worker = {
        workDate: row.work_date ? String(row.work_date).slice(0, 10) : "",
        workerKey: row.worker_key || "",
        workerName: row.worker_name || "",
        workerEmail: row.worker_email || "",
        workerSlug: slugifyWorker({ workerEmail: row.worker_email, workerName: row.worker_name }),
        scheduledHours: SHOP_DAILY_AVAILABLE_HOURS,
        productiveTaskMinutes,
        estimatedMinutes: numberField(row, "estimated_minutes"),
        totalTransitionMinutes,
        excessTransitionMinutes: numberField(row, "excess_transition_minutes"),
        unaccountedMinutes: numberField(row, "unaccounted_minutes"),
        productiveUtilizationPercent: round(productiveTaskMinutes / SHOP_DAILY_AVAILABLE_MINUTES * 100, 2),
        accountedUtilizationPercent: round((productiveTaskMinutes + totalTransitionMinutes) / SHOP_DAILY_AVAILABLE_MINUTES * 100, 2),
        taskEfficiencyPercent: numberField(row, "task_efficiency_percent"),
        assignedTaskCount: numberField(row, "assigned_task_count"),
        completedTaskCount: numberField(row, "completed_task_count"),
        taskCountStarted: numberField(row, "task_count_started"),
        taskSessionCount: numberField(row, "task_session_count"),
        transitionCount: numberField(row, "transition_count"),
        reviewRequiredCount: numberField(row, "review_required_count"),
        unreviewedTransitionCount: numberField(row, "unreviewed_transition_count")
      };
      const flag = workerCapacityFlagPayload(worker);
      return {
        ...worker,
        dataQualityFlags: flag ? [flag] : []
      };
    });
  const stats = transitionStats(transitions);
  const dataQualityFlags = workerDaily.flatMap(row => row.dataQualityFlags || []);

  return {
    ok: true,
    date,
    phase: phaseFilter || null,
    worker: workerFilter || null,
    reviewControlsEnabled: Boolean(TRANSITION_REVIEWS_ENABLED && WORKER_WRITES_ENABLED),
    categories,
    dataQuality: {
      maxProductiveMinutes: SHOP_DAILY_AVAILABLE_MINUTES,
      overCapacityCount: dataQualityFlags.length,
      flags: dataQualityFlags
    },
    summary: {
      ...stats,
      phaseCount: phases.length,
      workerPhaseCount: workerPhases.length,
      workerCount: new Set(workerPhases.map(row => row.workerKey || row.workerSlug || row.workerName).filter(Boolean)).size
    },
    phases,
    workerPhases,
    workerDaily,
    transitions,
    reviewQueue: transitions.filter(row => row.reviewRequired && !row.reviewedAt),
    refreshedAt: new Date().toISOString()
  };
}

async function transitionReviewQueuePayload(url) {
  const date = url.searchParams.get("date") || todayIso();
  if (!isIsoDate(date)) throw actionError("Date must be YYYY-MM-DD.", 400);
  const [queueResult, categories] = await Promise.all([
    pool.query("select * from reporting.unreviewed_transition_queue where work_date = $1::date order by raw_gap_minutes desc, previous_task_ended_at nulls last", [date]),
    transitionCategories()
  ]);
  const transitions = queueResult.rows.map(transitionPayload);
  return {
    ok: true,
    date,
    reviewControlsEnabled: Boolean(TRANSITION_REVIEWS_ENABLED && WORKER_WRITES_ENABLED),
    categories,
    transitions,
    summary: transitionStats(transitions),
    refreshedAt: new Date().toISOString()
  };
}

async function reportingNavigationPayload(url) {
  const requestedDate = url.searchParams.get("date") || todayIso();
  return reportingNavigation(isIsoDate(requestedDate) ? requestedDate : todayIso());
}

async function authMePayload(req) {
  const user = await authActorFromRequest(req);
  return {
    ok: true,
    accountAuth: appAuthBaseStatus(user),
    user,
    authenticated: Boolean(user)
  };
}

async function handleAuthLogin(req, res) {
  if (!APP_AUTH_ACTIVE) {
    sendError(res, 409, "Hawley account login is installed but not active.", {
      accountAuth: appAuthBaseStatus()
    });
    return;
  }

  const body = await readJsonBody(req);
  const username = normalizeEmail(body.username || body.email);
  const password = String(body.password || "");
  authRuntimeState.lastLoginAt = new Date().toISOString();
  authRuntimeState.lastLoginStep = "connect";
  authRuntimeState.lastLoginError = "";
  authRuntimeState.lastLoginStatus = "";
  const client = await pool.connect();
  try {
    await prepareAuthClient(client);
    authRuntimeState.lastLoginStep = "select_user";
    const result = await client.query(
      `
        select *
        from core.app_users
        where username = $1 or lower(email) = $1
        limit 1
      `,
      [username]
    );
    const row = result.rows[0];
    const user = authUserPayload(row);
    const genericReason = "Invalid login or inactive account.";
    const requestDetails = {
      username,
      ipAddress: requestIp(req),
      userAgent: String(req.headers["user-agent"] || "")
    };

    if (!row || !row.active || !row.password_hash || (row.locked_until && new Date(row.locked_until) > new Date())) {
      authRuntimeState.lastLoginStep = "record_rejected_login";
      await recordAuthEvent(client, "login", {
        ...requestDetails,
        user,
        success: false,
        reason: !row ? "not_found" : !row.active ? "inactive" : !row.password_hash ? "password_not_set" : "locked"
      });
      authRuntimeState.lastLoginStatus = "rejected";
      throw actionError(genericReason, 401, { code: "LOGIN_FAILED" });
    }

    authRuntimeState.lastLoginStep = "verify_password";
    const validPassword = await verifyPassword(password, row.password_hash);
    if (!validPassword) {
      authRuntimeState.lastLoginStep = "update_bad_password";
      await client.query(
        `
          update core.app_users
          set
            failed_login_count = failed_login_count + 1,
            locked_until = case when failed_login_count + 1 >= 10 then now() + interval '15 minutes' else locked_until end,
            updated_at = now()
          where app_user_id = $1
        `,
        [row.app_user_id]
      );
      authRuntimeState.lastLoginStep = "record_bad_password";
      await recordAuthEvent(client, "login", {
        ...requestDetails,
        user,
        success: false,
        reason: "bad_password"
      });
      authRuntimeState.lastLoginStatus = "rejected";
      throw actionError(genericReason, 401, { code: "LOGIN_FAILED" });
    }

    authRuntimeState.lastLoginStep = "create_session";
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = sessionTokenHash(token);
    const ttlSeconds = authSessionTtlSeconds();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    await client.query(
      `
        insert into core.app_sessions (
          session_token_hash,
          app_user_id,
          expires_at,
          ip_address,
          user_agent
        )
        values ($1, $2, $3::timestamptz, $4, $5)
      `,
      [tokenHash, row.app_user_id, expiresAt, requestIp(req), String(req.headers["user-agent"] || "")]
    );
    authRuntimeState.lastLoginStep = "update_user_login";
    await client.query(
      `
        update core.app_users
        set
          last_login_at = now(),
          failed_login_count = 0,
          locked_until = null,
          updated_at = now()
        where app_user_id = $1
      `,
      [row.app_user_id]
    );
    authRuntimeState.lastLoginStep = "record_success";
    await recordAuthEvent(client, "login", {
      ...requestDetails,
      user,
      success: true,
      reason: "ok"
    });

    authRuntimeState.lastLoginStep = "ok";
    authRuntimeState.lastLoginStatus = "success";
    sendJson(res, 200, {
      ok: true,
      accountAuth: appAuthBaseStatus(user),
      user,
      authenticated: true
    }, {
      "Set-Cookie": cookieHeader(APP_AUTH_COOKIE_NAME, token, { maxAge: ttlSeconds })
    });
  } catch (error) {
    authRuntimeState.lastLoginError = error.message || String(error);
    throw error;
  } finally {
    client.release();
  }
}

async function handleAuthLogout(req, res) {
  const token = parseCookies(req)[APP_AUTH_COOKIE_NAME];
  if (APP_AUTH_ACTIVE && token) {
    const client = await pool.connect();
    try {
      await prepareAuthClient(client);
      await client.query(
        "update core.app_sessions set revoked_at = now() where session_token_hash = $1 and revoked_at is null",
        [sessionTokenHash(token)]
      );
      await recordAuthEvent(client, "logout", {
        success: true,
        reason: "user_logout",
        ipAddress: requestIp(req),
        userAgent: String(req.headers["user-agent"] || "")
      });
    } finally {
      client.release();
    }
  }

  sendJson(res, 200, {
    ok: true,
    accountAuth: appAuthBaseStatus(),
    authenticated: false
  }, {
    "Set-Cookie": cookieHeader(APP_AUTH_COOKIE_NAME, "", { maxAge: 0, expires: new Date(0) })
  });
}

async function transitionById(transitionEventId) {
  const result = await pool.query(
    "select * from reporting.transition_event_detail where transition_event_id = $1",
    [transitionEventId]
  );
  return result.rows[0] ? transitionPayload(result.rows[0]) : null;
}

async function handleTransitionReview(req) {
  if (!TRANSITION_REVIEWS_ENABLED || !WORKER_WRITES_ENABLED) {
    throw actionError("Transition review writes are not enabled for this Hawley app.", 403, {
      mode: authStatusPayload().mode
    });
  }
  const authActor = APP_AUTH_ACTIVE ? await requireAuthActor(req) : null;
  requireManagerActor(authActor);

  const body = await readJsonBody(req);
  const transitionEventId = Number(body.transitionEventId || body.transition_event_id || 0);
  const managerCategory = String(body.categoryKey || body.managerCategory || "").trim();
  const managerNotes = String(body.notes || body.managerNotes || "").trim().slice(0, 4000);
  const reviewedBy = String(authActor?.displayName || authActor?.email || body.reviewedBy || "Hawley manager").trim().slice(0, 200);
  if (!Number.isInteger(transitionEventId) || transitionEventId <= 0) {
    throw actionError("transitionEventId is required.", 400);
  }
  if (!managerCategory) throw actionError("categoryKey is required.", 400);

  const client = await writePool.connect();
  try {
    await client.query("begin");
    const category = await client.query(
      `
        select category_key, category_group
        from core.transition_category_catalog
        where category_key = $1
          and active
          and manager_selectable
      `,
      [managerCategory]
    );
    if (!category.rows[0]) {
      throw actionError("Transition category is not manager-selectable.", 400);
    }

    const categoryGroup = category.rows[0].category_group;
    await client.query(
      `
        insert into core.transition_reviews (
          transition_event_id,
          reviewed_by,
          manager_category,
          manager_category_group,
          manager_notes,
          confidence,
          action_required,
          followup_owner,
          review_mode
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, 'manager_line_view')
      `,
      [
        transitionEventId,
        reviewedBy,
        managerCategory,
        categoryGroup,
        managerNotes || null,
        body.confidence || null,
        Boolean(body.actionRequired),
        body.followupOwner || null
      ]
    );
    const update = await client.query(
      `
        update core.task_transition_events
        set
          manager_category = $2,
          manager_category_group = $3,
          manager_notes = $4,
          reviewed_by = $5,
          reviewed_at = now(),
          manager_flagged = coalesce(manager_flagged, false) or $6,
          updated_at = now()
        where transition_event_id = $1
        returning transition_event_id
      `,
      [transitionEventId, managerCategory, categoryGroup, managerNotes || null, reviewedBy, Boolean(body.managerFlagged)]
    );
    if (!update.rows[0]) throw actionError("Transition event was not found.", 404);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  return {
    ok: true,
    transition: await transitionById(transitionEventId)
  };
}

async function healthPayload() {
  const [db, counts, latestRuns] = await Promise.all([
    pool.query("select current_database() as database_name, current_user as user_name, version() as postgres_version"),
    pool.query(`
      select
        (select count(*)::int from reporting.hawley_worker_page_assignments) as assignment_rows,
        (select count(distinct worker_email)::int from reporting.hawley_worker_page_assignments where worker_email is not null) as assigned_worker_count,
        (select count(*)::int from raw.asana_tasks where project_gid = $1) as daily_tracker_rows,
        (select count(*)::int from raw.airtable_phase_cycle_load) as raw_phase_cycle_load_rows,
        (select count(*)::int from raw.airtable_worker_cycle_bank) as raw_worker_cycle_bank_rows,
        (select count(*)::int from raw.airtable_worker_phase_allocation) as raw_worker_phase_allocation_rows,
        (select count(*)::int from hb.rev1_task_instances) as rev1_task_instance_rows,
        (select count(*)::int from hb.phase_cycle_load_rev1) as phase_cycle_load_rows,
        (select count(*)::int from hb.worker_phase_allocation_rev1) as worker_phase_allocation_rows,
        (select count(*)::int from hb.worker_cycle_bank_rev1) as worker_cycle_bank_rows,
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
    databaseMode: {
      runtimePrefersSyncUrl: true,
      syncUrlConfigured: syncDatabaseConfigured(),
      databaseUrlConfigured: Boolean(process.env.DATABASE_URL)
    },
    counts: counts.rows[0],
    scheduleCorrection: scheduleCorrectionStatus(),
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
    scheduleCorrection: scheduleCorrectionStatus(),
    latestRuns: await latestImportRuns(),
    refreshedAt: new Date().toISOString()
  };
}

function adminCycleNumber(value) {
  const match = String(value || "").match(/\d{1,3}/);
  return match ? Number(match[0]) : null;
}

function adminProjectNameForSchedule(row) {
  const vin = String(row.vin || "").trim();
  const cycle = String(row.short_cycle_label || row.cycle_label || "").trim();
  const phase = String(row.phase_name || row.section_column || "").trim();
  return [vin ? `VIN ${vin}` : "", phase, cycle].filter(Boolean).join(" - ") || row.schedule_name || "New Hawley project";
}

function secondsToHours(value) {
  return round(Number(value || 0) / 3600, 2);
}

function adminPercentValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return round(Math.abs(number) <= 1 ? number * 100 : number, 1);
}

function adminCycleStatus(row) {
  if (!row) {
    return {
      label: "",
      startDate: "",
      endDate: "",
      progressPct: null,
      totalWorkdays: null,
      elapsedWorkday: null,
      remainingWorkdays: null,
      source: "hb.cycles"
    };
  }

  const startDate = row.start_date ? String(row.start_date).slice(0, 10) : "";
  const endDate = row.end_date ? String(row.end_date).slice(0, 10) : "";
  const holidays = holidayDatesFromField(row.holidays, startDate || endDate);
  const workdays = cycleWorkdays(startDate, endDate, holidays, row.days_in_cycle);
  const today = todayIso();
  const effectiveToday = endDate && today > endDate ? endDate : today;
  const elapsedWorkday = startDate && effectiveToday >= startDate
    ? workdays.filter(date => date <= effectiveToday).length
    : 0;
  const totalWorkdays = Number(workdays.length || row.days_in_cycle || 0) || null;
  const remainingWorkdays = totalWorkdays
    ? Math.max(0, totalWorkdays - Math.max(1, Math.min(totalWorkdays, elapsedWorkday || 0)) + 1)
    : null;
  const progressPct = totalWorkdays
    ? round(Math.max(0, Math.min(100, (elapsedWorkday / totalWorkdays) * 100)), 1)
    : adminPercentValue(row.cycle_percent);

  return {
    label: row.cycle_label || (row.cycle_number ? `C${row.cycle_number}` : ""),
    cycleNumber: row.cycle_number === null || row.cycle_number === undefined ? null : Number(row.cycle_number),
    startDate,
    endDate,
    progressPct,
    totalWorkdays,
    elapsedWorkday: totalWorkdays ? Math.max(0, Math.min(totalWorkdays, elapsedWorkday)) : null,
    remainingWorkdays,
    source: "hb.cycles"
  };
}

function adminNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function adminPhaseStatusRank(status) {
  const value = String(status || "").toLowerCase();
  if (value.includes("off")) return 3;
  if (value.includes("risk")) return 2;
  if (value.includes("track")) return 1;
  return 0;
}

function adminPresentationPhaseName(phaseName) {
  const phase = adminPhaseFamilyName(phaseName);
  if (phase === "Phase A" || phase === "Frames") return "Phase A & Frames";
  return phase || "Unassigned";
}

function adminPlhPhaseAllowed(phaseName) {
  if (!ADMIN_PLH_PHASES.size) return true;
  const formatted = formatPhaseName(phaseName);
  const family = adminPhaseFamilyName(formatted);
  const presentation = adminPresentationPhaseName(formatted);
  return ADMIN_PLH_PHASES.has(formatted) ||
    ADMIN_PLH_PHASES.has(family) ||
    ADMIN_PLH_PHASES.has(presentation);
}

function adminMergePresentationPhases(phases) {
  const byPhase = new Map();
  for (const phase of phases || []) {
    const key = adminPresentationPhaseName(phase.phase);
    const existing = byPhase.get(key) || {
      phase: key,
      status: phase.status || "",
      remainingHours: 0,
      capacityHours: 0,
      capacityLabel: phase.capacityLabel || "Gap",
      capacityDeltaHours: 0,
      completionPct: null,
      cyclePct: phase.cyclePct ?? null,
      workerCount: 0,
      totalLoadHours: 0,
      completedHours: 0
    };

    existing.status = adminPhaseStatusRank(phase.status) > adminPhaseStatusRank(existing.status)
      ? phase.status
      : existing.status;
    existing.remainingHours = round(existing.remainingHours + Number(phase.remainingHours || 0), 2);
    existing.capacityHours = round(existing.capacityHours + Number(phase.capacityHours || 0), 2);
    existing.capacityDeltaHours = round(existing.capacityDeltaHours + Number(phase.capacityDeltaHours || 0), 2);
    existing.workerCount += Number(phase.workerCount || 0);
    existing.totalLoadHours = round(existing.totalLoadHours + Number(phase.totalLoadHours || 0), 2);
    existing.completedHours = round(existing.completedHours + Number(phase.completedHours || 0), 2);
    if (existing.cyclePct === null || existing.cyclePct === undefined) existing.cyclePct = phase.cyclePct ?? null;
    byPhase.set(key, existing);
  }

  return Array.from(byPhase.values()).map(phase => ({
    ...phase,
    phaseName: phase.phase,
    capacityHours: phase.capacityHours || null,
    capacityDeltaHours: phase.capacityDeltaHours || null,
    completionPct: phase.totalLoadHours > 0 ? round((phase.completedHours / phase.totalLoadHours) * 100, 1) : phase.completionPct,
    workerCount: phase.workerCount || null,
    totalLoadHours: phase.totalLoadHours || null,
    completedHours: phase.completedHours || null
  }));
}

function adminParseLineOverviewPhases(text) {
  const lines = String(text || "").split(/\r?\n/);
  const phases = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const phaseMatch = line.match(/(Phase [A-I]|FAB|Frames?)\s*-\s*(On Track|At Risk|Off Track)/i);
    if (!phaseMatch) continue;

    const statsLine = lines[index + 1] || "";
    const progressLine = lines[index + 2] || "";
    const loadLine = lines[index + 3] || "";
    const statsMatch = statsLine.match(
      /Remaining:\s*([0-9.]+)h\s*\|\s*Station Capacity:\s*([0-9.]+)h\s*\|\s*(Cushion|Gap):\s*([0-9.]+)h/i
    );
    const progressMatch = progressLine.match(
      /Complete:\s*([0-9.]+)%\s*\|\s*Cycle:\s*([0-9.]+)%\s*\|\s*([0-9]+)\s*worker/i
    );
    const loadMatch = loadLine.match(/Load:\s*([0-9.]+)h\s*\|\s*Done:\s*([0-9.]+)h/i);

    phases.push({
      phase: formatPhaseName(phaseMatch[1]),
      status: phaseMatch[2],
      remainingHours: statsMatch ? round(Number(statsMatch[1]), 2) : null,
      capacityHours: statsMatch ? round(Number(statsMatch[2]), 2) : null,
      capacityLabel: statsMatch ? statsMatch[3] : "Gap",
      capacityDeltaHours: statsMatch ? round(Number(statsMatch[4]), 2) : null,
      completionPct: progressMatch ? round(Number(progressMatch[1]), 1) : null,
      cyclePct: progressMatch ? round(Number(progressMatch[2]), 1) : null,
      workerCount: progressMatch ? Number(progressMatch[3]) : null,
      totalLoadHours: loadMatch ? round(Number(loadMatch[1]), 2) : null,
      completedHours: loadMatch ? round(Number(loadMatch[2]), 2) : null
    });
  }

  return adminMergePresentationPhases(phases);
}

function adminParseLineOverviewRemainingWorkdays(text) {
  const match = String(text || "").match(/Remaining Workdays:\s*([0-9.]+)/i);
  return match ? round(Number(match[1]), 2) : null;
}

function adminComputedPhaseStatus(phase, fallbackCycleProgress = null) {
  const remaining = adminNumberOrNull(phase.remainingHours);
  const capacity = adminNumberOrNull(phase.capacityHours);
  const completion = adminNumberOrNull(phase.completionPct);
  const cycle = adminNumberOrNull(phase.cyclePct) ?? adminNumberOrNull(fallbackCycleProgress);
  const status = String(phase.status || "");

  if (remaining !== null && remaining <= 0.05) return "On Track";
  if (capacity !== null && capacity <= 0.05) return "Off Track";
  if (remaining !== null && capacity !== null && remaining > capacity + 0.05) return "Off Track";
  if (completion !== null && cycle !== null && completion + 0.01 < cycle) return "At Risk";
  return status || "On Track";
}

function adminIsLineOverviewSnapshot(snapshot) {
  return /line overview/i.test(String(snapshot?.trackerType || "")) ||
    /^Line Overview\s*\|/i.test(String(snapshot?.name || "")) ||
    /^LINE OVERVIEW SNAPSHOT/i.test(String(snapshot?.notes || ""));
}

function adminLineOverviewFromSnapshot(snapshot) {
  if (!snapshot) return null;
  const phases = adminParseLineOverviewPhases(snapshot.notes || "");
  const phaseCyclePct = phases.find(phase => adminNumberOrNull(phase.cyclePct) !== null)?.cyclePct ?? null;
  const snapshotCyclePct = adminNumberOrNull(snapshot.cycleProgressPercent);
  const totalLoadHours = round(phases.reduce((sum, phase) => sum + Number(phase.totalLoadHours || 0), 0), 2);
  const completedHours = round(phases.reduce((sum, phase) => sum + Number(phase.completedHours || 0), 0), 2);
  const computedCompletionPct = totalLoadHours ? round((completedHours / totalLoadHours) * 100, 1) : null;
  const snapshotCompletionPct = adminNumberOrNull(snapshot.completionPercent);
  const cycleProgressPct = snapshotCyclePct && snapshotCyclePct > 0 ? snapshotCyclePct : (phaseCyclePct ?? snapshotCyclePct);
  const completionPct = snapshotCompletionPct && snapshotCompletionPct > 0 ? snapshotCompletionPct : (computedCompletionPct ?? snapshotCompletionPct);

  return {
    gid: snapshot.gid,
    name: snapshot.name,
    cycle: snapshot.cycle,
    cycleLabel: snapshot.cycle,
    status: snapshot.trackerStatus,
    trackerDate: snapshot.trackerDate,
    completionPct,
    cycleProgressPct,
    remainingWorkdays: adminParseLineOverviewRemainingWorkdays(snapshot.notes || ""),
    remainingAssignedHours: snapshot.remainingHours,
    remainingHours: snapshot.remainingHours,
    assignedHours: snapshot.assignedHours,
    completedHours: snapshot.completedHours,
    taskCount: snapshot.taskCount,
    completedTaskCount: snapshot.completedTaskCount,
    capacityHours: snapshot.capacityHours,
    capacityDeltaHours: snapshot.capacityDeltaHours,
    loadCapacityPercent: snapshot.loadCapacityPercent,
    phases,
    trackerUrl: snapshot.url,
    source: "raw.asana_tasks"
  };
}

async function adminLatestLineOverview() {
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
      order by
        due_on desc nulls last,
        modified_at desc nulls last,
        synced_at desc nulls last,
        name
      limit 500
    `,
    [DAILY_TRACKER_PROJECT_ID]
  );

  return result.rows
    .map(normalizeTrackerSnapshot)
    .filter(snapshot => !snapshot.archivedSection)
    .filter(adminIsLineOverviewSnapshot)
    .sort((left, right) =>
      String(right.trackerDate || right.dueOn || "").localeCompare(String(left.trackerDate || left.dueOn || "")) ||
      String(right.syncedAt || "").localeCompare(String(left.syncedAt || ""))
    )[0] || null;
}

const ADMIN_RAW_PCL_FIELDS = Object.freeze({
  bucketKey: ["PhaseCycleBucketKey", "Phase Cycle Bucket Key", "Display Bucket Key", "PhaseCycleKey", "Phase Cycle Key"],
  phase: ["Phase Name", "Phase", "Primary Phase", "Section/Column"],
  cycle: ["Cycle Label", "Cycle", "Cycle Number"],
  remainingHours: ["Remaining Task Hours", "Remaining Task Hrs", "Remaining Hrs", "Remaining Hours", "Open Est. Hours"],
  totalLoadHours: ["Total Load Hrs.", "Total Load Hrs", "Total Load Hours", "Total Load", "Load Hours"],
  completedHours: ["Completed Task Hours", "Completed Hrs", "Completed Hours", "Competed Est. Hours"],
  status: ["Status", "PLH Status", "Tracker Status"]
});

function adminRawFieldKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function adminRawField(fields, names) {
  if (!fields || typeof fields !== "object") return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(fields, name)) return fields[name];
  }
  const wanted = new Set(names.map(adminRawFieldKey).filter(Boolean));
  for (const [key, value] of Object.entries(fields)) {
    if (wanted.has(adminRawFieldKey(key))) return value;
  }
  return undefined;
}

function adminRawTextValue(value) {
  if (value === null || value === undefined || value === "") return "";
  if (Array.isArray(value)) return value.map(adminRawTextValue).filter(Boolean).join(", ");
  if (typeof value === "object") {
    return adminRawTextValue(value.name ?? value.email ?? value.value ?? value.text ?? value.display_value ?? value.id);
  }
  return String(value).trim();
}

function adminRawTextFromFields(fields, names) {
  return adminRawTextValue(adminRawField(fields, names));
}

function adminRawNumberValue(value) {
  if (value === null || value === undefined || value === "") return null;
  if (Array.isArray(value)) {
    const numbers = value
      .map(adminRawNumberValue)
      .filter(number => number !== null && Number.isFinite(number));
    return numbers.length ? numbers.reduce((sum, number) => sum + number, 0) : null;
  }
  if (typeof value === "object") {
    return adminRawNumberValue(value.number_value ?? value.value ?? value.name ?? value.display_value ?? value.id);
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/,/g, "").replace(/[^0-9.\-]+/g, "");
  if (!cleaned || cleaned === "-" || cleaned === "." || cleaned === "-.") return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

function adminRawNumberFromFields(fields, names) {
  return adminRawNumberValue(adminRawField(fields, names));
}

function adminNormalizeRawPclPhase(value) {
  const phase = String(value || "").trim();
  if (!phase || /^rec[a-z0-9]+$/i.test(phase)) return "";
  if (/^A\s*&\s*Frames$/i.test(phase)) return "Phase A";
  if (/^FAB$/i.test(phase)) return "FAB";
  if (/^CNC$/i.test(phase)) return "CNC";
  if (/^Frames?$/i.test(phase)) return "Frames";
  return formatPhaseName(phase);
}

function adminParseRawPclBucketText(value) {
  const text = String(value || "").trim();
  if (!text) return null;

  let match = text.match(/^C?\s*(\d{1,3})\s*[-:|/]+\s*(.+)$/i);
  if (match) {
    const phaseName = adminNormalizeRawPclPhase(match[2]);
    return phaseName ? {
      cycleNumber: Number(match[1]),
      cycleLabel: `C${Number(match[1])}`,
      phaseName
    } : null;
  }

  match = text.match(/^(.+?)\s*[-:|/]+\s*C?\s*(\d{1,3})$/i);
  if (match) {
    const phaseName = adminNormalizeRawPclPhase(match[1]);
    return phaseName ? {
      cycleNumber: Number(match[2]),
      cycleLabel: `C${Number(match[2])}`,
      phaseName
    } : null;
  }

  match = text.match(/\bC\s*(\d{1,3})\b/i);
  if (match) {
    const phaseText = text
      .replace(match[0], "")
      .replace(/^[\s\-:|/]+|[\s\-:|/]+$/g, "")
      .trim();
    const phaseName = adminNormalizeRawPclPhase(phaseText);
    return phaseName ? {
      cycleNumber: Number(match[1]),
      cycleLabel: `C${Number(match[1])}`,
      phaseName
    } : null;
  }

  return null;
}

function adminParseRawPclCycle(fields) {
  const cycleText = adminRawTextFromFields(fields, ADMIN_RAW_PCL_FIELDS.cycle);
  const cycleNumber = cycleNumberFromName(cycleText);
  return {
    cycleNumber,
    cycleLabel: cycleNumber ? `C${cycleNumber}` : formatCycleName(cycleText)
  };
}

function adminRawPhaseCycleLoadSnapshot(rawRows) {
  const groups = new Map();
  const stats = {
    rawRowCount: rawRows.length,
    parsedRowCount: 0,
    positiveRowCount: 0,
    groupedRowCount: 0,
    skippedNoPhaseCycle: 0,
    totalRemainingHours: 0,
    totalLoadHours: 0,
    completedHours: 0,
    latestSyncedAt: ""
  };

  for (const rawRow of rawRows) {
    const fields = rawRow.fields_json || {};
    const bucketTexts = ADMIN_RAW_PCL_FIELDS.bucketKey
      .map(fieldName => adminRawTextFromFields(fields, [fieldName]))
      .filter(Boolean);
    let parsed = null;
    for (const bucketText of bucketTexts) {
      parsed = adminParseRawPclBucketText(bucketText);
      if (parsed) break;
    }

    if (!parsed) {
      const phaseName = adminNormalizeRawPclPhase(adminRawTextFromFields(fields, ADMIN_RAW_PCL_FIELDS.phase));
      const cycle = adminParseRawPclCycle(fields);
      if (phaseName && (cycle.cycleNumber || cycle.cycleLabel)) parsed = { ...cycle, phaseName };
    }

    if (!parsed || !parsed.phaseName || (!parsed.cycleNumber && !parsed.cycleLabel)) {
      stats.skippedNoPhaseCycle += 1;
      continue;
    }

    stats.parsedRowCount += 1;
    const remainingHours = round(adminRawNumberFromFields(fields, ADMIN_RAW_PCL_FIELDS.remainingHours) || 0, 2);
    const completedHours = round(adminRawNumberFromFields(fields, ADMIN_RAW_PCL_FIELDS.completedHours) || 0, 2);
    const rawTotalLoadHours = round(adminRawNumberFromFields(fields, ADMIN_RAW_PCL_FIELDS.totalLoadHours) || 0, 2);
    const totalLoadHours = rawTotalLoadHours > 0
      ? rawTotalLoadHours
      : round(remainingHours + completedHours, 2);
    const hasHours = remainingHours > 0 || completedHours > 0 || totalLoadHours > 0;
    if (!hasHours) continue;

    stats.positiveRowCount += 1;
    stats.totalRemainingHours = round(stats.totalRemainingHours + remainingHours, 2);
    stats.totalLoadHours = round(stats.totalLoadHours + totalLoadHours, 2);
    stats.completedHours = round(stats.completedHours + completedHours, 2);
    if (rawRow.synced_at && String(rawRow.synced_at) > stats.latestSyncedAt) stats.latestSyncedAt = String(rawRow.synced_at);

    const cycleNumber = parsed.cycleNumber === null || parsed.cycleNumber === undefined
      ? null
      : Number(parsed.cycleNumber);
    const cycleLabel = parsed.cycleLabel || (cycleNumber ? `C${cycleNumber}` : "");
    const phaseName = formatPhaseName(parsed.phaseName) || "Unassigned";
    const key = `${cycleNumber || cycleLabel || "unknown"}::${phaseName}`;
    const existing = groups.get(key) || {
      phase_name: phaseName,
      cycle_number: cycleNumber,
      cycle_label: cycleLabel,
      remaining_hours: 0,
      total_load_hours: 0,
      completed_hours: 0,
      status: ""
    };
    const status = adminRawTextFromFields(fields, ADMIN_RAW_PCL_FIELDS.status);
    existing.remaining_hours = round(existing.remaining_hours + remainingHours, 2);
    existing.total_load_hours = round(existing.total_load_hours + totalLoadHours, 2);
    existing.completed_hours = round(existing.completed_hours + completedHours, 2);
    existing.status = adminPhaseStatusRank(status) > adminPhaseStatusRank(existing.status)
      ? status
      : existing.status;
    groups.set(key, existing);
  }

  const rows = Array.from(groups.values())
    .sort((left, right) =>
      Number(left.cycle_number || 9999) - Number(right.cycle_number || 9999) ||
      String(left.phase_name || "").localeCompare(String(right.phase_name || ""))
    );
  stats.groupedRowCount = rows.length;
  return { rows, stats };
}

function adminDebtTier(key, label, shortLabel, tone, cycleNumbers = []) {
  return {
    key,
    label,
    shortLabel,
    tone,
    total: 0,
    totalHours: 0,
    byPhase: {},
    cycleNumbers
  };
}

function addAdminDebtHours(tier, phaseName, hours) {
  const value = round(Number(hours || 0), 2);
  if (value <= 0) return;
  tier.total = round(Number(tier.total || 0) + value, 2);
  tier.totalHours = round(tier.totalHours + value, 2);
  tier.byPhase[phaseName] = round((tier.byPhase[phaseName] || 0) + value, 2);
}

function adminPhasePacingStatus(row, cycleProgressPct) {
  const remainingHours = Number(row.remainingHours || 0);
  if (remainingHours <= 0.05) return "Complete";
  if (cycleProgressPct === null || cycleProgressPct === undefined) return row.status || "No signal";
  if (Number(row.paceDeltaPct || 0) >= 0) return "On pace";
  if (Number(row.paceDeltaPct || 0) <= -10) return "Behind pace";
  return "Watch pace";
}

function adminPhaseCapacityStatus(row) {
  const remainingHours = Number(row.remainingHours || 0);
  const capacityHours = Number(row.capacityHours || 0);
  const workerCount = Number(row.workerCount || 0);
  const pacingStatus = String(row.status || "").toLowerCase();
  if (remainingHours <= 0.05) return "Complete";
  if (!workerCount || capacityHours <= 0.05) return "No capacity";
  if (remainingHours > capacityHours + 0.05) return "Off track";
  if (pacingStatus.includes("behind") || pacingStatus.includes("watch")) return "At risk";
  return "On track";
}

function adminMergeCurrentRowsForPresentation(rows) {
  const byPhase = new Map();

  for (const row of rows || []) {
    const presentationName = adminPresentationPhaseName(row.phaseName || row.phase);
    const phaseKey = adminPhaseFamilyName(row.phaseName || row.phase);
    const existing = byPhase.get(presentationName) || {
      phaseName: presentationName,
      phase: presentationName,
      phaseKey,
      cycleNumber: row.cycleNumber ?? null,
      cycleLabel: row.cycleLabel || "",
      remainingHours: 0,
      totalLoadHours: 0,
      completedHours: 0,
      status: ""
    };

    existing.remainingHours = round(existing.remainingHours + Number(row.remainingHours || 0), 2);
    existing.totalLoadHours = round(existing.totalLoadHours + Number(row.totalLoadHours || 0), 2);
    existing.completedHours = round(existing.completedHours + Number(row.completedHours || 0), 2);
    existing.status = adminPhaseStatusRank(row.status) > adminPhaseStatusRank(existing.status)
      ? row.status
      : existing.status;
    byPhase.set(presentationName, existing);
  }

  return Array.from(byPhase.values());
}

async function adminPlhMetricsPayload() {
  const baselineCycleNumber = cycleNumberFromName(ADMIN_PLH_BASELINE_CYCLE) || 5;
  const today = todayIso();
  const [cycleResult, debtResult, rawPhaseCycleLoadResult, dailyResult, latestLineOverviewSnapshot] = await Promise.all([
    pool.query(`
      with cycle_rows as (
        select
          cycle_record_id,
          cycle_number,
          cycle_label,
          start_date,
          end_date,
          days_in_cycle,
          holidays,
          cycle_percent,
          0 as source_rank
        from hb.cycles
        where cycle_number is not null
        union all
        select
          max(cycle_record_id) as cycle_record_id,
          cycle_number,
          coalesce(max(nullif(short_cycle_label, '')), max(nullif(cycle_label, '')), 'C' || cycle_number::text) as cycle_label,
          min(start_date) as start_date,
          max(end_date) as end_date,
          max(days_in_cycle) as days_in_cycle,
          null::text as holidays,
          null::numeric as cycle_percent,
          1 as source_rank
        from hb.production_schedule
        where cycle_number is not null
        group by cycle_number
      )
      select
        cycle_record_id,
        cycle_number,
        cycle_label,
        start_date::text,
        end_date::text,
        days_in_cycle,
        holidays,
        cycle_percent
      from cycle_rows
      order by
        case when $1::date between coalesce(start_date, $1::date) and coalesce(end_date, $1::date) then 0 else 1 end,
        source_rank,
        start_date desc nulls last,
        cycle_number desc
      limit 1
    `, [today]),
    pool.query(`
      select
        coalesce(nullif(pcl.phase_name, ''), 'Unassigned') as phase_name,
        coalesce(
          cycles.cycle_number,
          nullif(substring(coalesce(pcl.cycle_label, '') from 'C[[:space:]]*([0-9]{1,3})'), '')::int,
          nullif(substring(coalesce(pcl.cycle_label, '') from '([0-9]{1,3})'), '')::int
        ) as cycle_number,
        coalesce(cycles.cycle_label, pcl.cycle_label) as cycle_label,
        sum(coalesce(pcl.remaining_task_hours, 0))::numeric(12, 2) as remaining_hours,
        sum(coalesce(pcl.total_load_hours, 0))::numeric(12, 2) as total_load_hours,
        sum(coalesce(pcl.completed_task_hours, 0))::numeric(12, 2) as completed_hours,
        max(pcl.status) as status
      from hb.phase_cycle_load_rev1 pcl
      left join hb.cycles cycles on cycles.cycle_record_id = pcl.cycle_record_id
      where coalesce(pcl.remaining_task_hours, 0) > 0
         or coalesce(pcl.total_load_hours, 0) > 0
         or coalesce(pcl.completed_task_hours, 0) > 0
      group by
        coalesce(nullif(pcl.phase_name, ''), 'Unassigned'),
        coalesce(
          cycles.cycle_number,
          nullif(substring(coalesce(pcl.cycle_label, '') from 'C[[:space:]]*([0-9]{1,3})'), '')::int,
          nullif(substring(coalesce(pcl.cycle_label, '') from '([0-9]{1,3})'), '')::int
        ),
        coalesce(cycles.cycle_label, pcl.cycle_label)
      order by cycle_number nulls last, phase_name
    `),
    pool.query(`
      select
        record_id,
        fields_json,
        synced_at::text
      from raw.airtable_phase_cycle_load
    `),
    pool.query(`
      select
        count(*) filter (where productive_task_minutes > 0 or assigned_task_count > 0)::int as worker_count,
        coalesce(sum(productive_task_minutes), 0)::integer as productive_minutes,
        coalesce(sum(estimated_minutes), 0)::integer as estimated_minutes,
        coalesce(sum(assigned_task_count), 0)::integer as assigned_task_count,
        coalesce(sum(completed_task_count), 0)::integer as completed_task_count,
        coalesce(sum(review_required_count), 0)::integer as review_required_count
      from reporting.worker_daily_utilization
      where work_date = $1::date
    `, [today]),
    adminLatestLineOverview()
  ]);

  const cycleStatus = adminCycleStatus(cycleResult.rows[0] || null);
  const currentCycleNumber = cycleStatus.cycleNumber;
  const carryoverCycleNumbers = baselineCycleNumber && currentCycleNumber
    ? Array.from(
      { length: Math.max(currentCycleNumber - baselineCycleNumber - 1, 0) },
      (_item, index) => baselineCycleNumber + index + 1
    )
    : [];
  const carryoverCycleLabels = carryoverCycleNumbers.map(cycleNumber => `C${cycleNumber}`);
  const tiers = {
    current: adminDebtTier(
      "current",
      `${cycleStatus.label || "Current"} Current Work`,
      cycleStatus.label || "Current",
      "blue",
      currentCycleNumber ? [currentCycleNumber] : []
    ),
    carryover: adminDebtTier(
      "carryover",
      `${carryoverCycleLabels.join(" + ") || "Prior Cycle"} Carryover`,
      carryoverCycleLabels.join(" + ") || "Carryover",
      "warn",
      carryoverCycleNumbers
    ),
    original: adminDebtTier(
      "original",
      `C1-${ADMIN_PLH_BASELINE_CYCLE} Original Debt`,
      `C1-${ADMIN_PLH_BASELINE_CYCLE}`,
      "risk",
      baselineCycleNumber ? Array.from({ length: baselineCycleNumber }, (_item, index) => index + 1) : []
    )
  };
  const carryoverTierKeys = [];
  for (const cycleNumber of carryoverCycleNumbers) {
    const label = `C${cycleNumber}`;
    const key = `carryover${label}`;
    carryoverTierKeys.push(key);
    tiers[key] = adminDebtTier(key, `${label} Carryover`, label, "warn", [cycleNumber]);
  }
  const tierOrder = ["current", ...(carryoverTierKeys.length ? carryoverTierKeys.slice().reverse() : ["carryover"]), "original"];
  const matrix = new Map();
  const currentRows = [];
  const rawPhaseCycleLoad = adminRawPhaseCycleLoadSnapshot(rawPhaseCycleLoadResult.rows);
  const debtRows = rawPhaseCycleLoad.rows.length ? rawPhaseCycleLoad.rows : debtResult.rows;
  const phaseCycleLoadSource = rawPhaseCycleLoad.rows.length
    ? "raw.airtable_phase_cycle_load"
    : "hb.phase_cycle_load_rev1";
  const capacityResult = currentCycleNumber
    ? await pool.query(`
      with worker_phase_capacity as (
        select
          coalesce(nullif(wpa.home_phase_text, ''), nullif(wpa.worked_phase_text, ''), 'Unassigned') as phase_name,
          wpa.worker_record_id,
          max(coalesce(wcb.effective_hours_bank, wcb.cycle_capacity, 0)) as effective_hours_bank,
          max(coalesce(wcb.remaining_hours, 0)) as remaining_bank_hours,
          max(coalesce(wcb.assigned_hours_total, 0)) as assigned_hours_total
        from hb.worker_phase_allocation_rev1 wpa
        join hb.worker_cycle_bank_rev1 wcb on wcb.worker_cycle_key = wpa.worker_cycle_key
        left join hb.cycles cycles on cycles.cycle_record_id = wpa.cycle_record_id
        where coalesce(
          cycles.cycle_number,
          nullif(substring(coalesce(wpa.cycle_label, '') from 'C[[:space:]]*([0-9]{1,3})'), '')::int,
          nullif(substring(coalesce(wpa.cycle_label, '') from '([0-9]{1,3})'), '')::int
        ) = $1::int
          and coalesce(wcb.actively_employed, false)
        group by 1, wpa.worker_record_id
      )
      select
        phase_name,
        count(*)::int as worker_count,
        coalesce(sum(effective_hours_bank), 0)::numeric(12, 2) as effective_hours_bank,
        coalesce(sum(remaining_bank_hours), 0)::numeric(12, 2) as remaining_bank_hours,
        coalesce(sum(assigned_hours_total), 0)::numeric(12, 2) as assigned_hours_total
      from worker_phase_capacity
      group by phase_name
    `, [currentCycleNumber])
    : { rows: [] };
  const remainingCapacityRatio = cycleStatus.totalWorkdays
    ? Math.max(0, Math.min(1, Number(cycleStatus.remainingWorkdays || 0) / Number(cycleStatus.totalWorkdays || 1)))
    : 1;
  const capacityByPhase = new Map();
  for (const row of capacityResult.rows) {
    const phaseName = formatPhaseName(row.phase_name) || "Unassigned";
    const phaseKey = adminPhaseFamilyName(phaseName);
    const existing = capacityByPhase.get(phaseKey) || {
      phaseName: phaseKey,
      phaseKey,
      workerCount: 0,
      capacityHours: 0,
      fullCycleCapacityHours: 0,
      bankRemainingHours: 0,
      assignedHoursTotal: 0
    };
    const fullCycleCapacityHours = Number(row.effective_hours_bank || 0);
    existing.workerCount += Number(row.worker_count || 0);
    existing.fullCycleCapacityHours = round(existing.fullCycleCapacityHours + fullCycleCapacityHours, 2);
    existing.capacityHours = round(existing.capacityHours + (fullCycleCapacityHours * remainingCapacityRatio), 2);
    existing.bankRemainingHours = round(existing.bankRemainingHours + Number(row.remaining_bank_hours || 0), 2);
    existing.assignedHoursTotal = round(existing.assignedHoursTotal + Number(row.assigned_hours_total || 0), 2);
    capacityByPhase.set(phaseKey, existing);
  }
  const capacityByPresentation = new Map();
  for (const capacity of capacityByPhase.values()) {
    const presentationName = adminPresentationPhaseName(capacity.phaseName);
    const existing = capacityByPresentation.get(presentationName) || {
      phaseName: presentationName,
      phaseKey: presentationName,
      workerCount: 0,
      capacityHours: 0,
      fullCycleCapacityHours: 0,
      bankRemainingHours: 0,
      assignedHoursTotal: 0
    };
    existing.workerCount += Number(capacity.workerCount || 0);
    existing.capacityHours = round(existing.capacityHours + Number(capacity.capacityHours || 0), 2);
    existing.fullCycleCapacityHours = round(existing.fullCycleCapacityHours + Number(capacity.fullCycleCapacityHours || 0), 2);
    existing.bankRemainingHours = round(existing.bankRemainingHours + Number(capacity.bankRemainingHours || 0), 2);
    existing.assignedHoursTotal = round(existing.assignedHoursTotal + Number(capacity.assignedHoursTotal || 0), 2);
    capacityByPresentation.set(presentationName, existing);
  }

  for (const row of debtRows) {
    const cycleNumber = row.cycle_number === null || row.cycle_number === undefined ? null : Number(row.cycle_number);
    if (currentCycleNumber && cycleNumber && cycleNumber > currentCycleNumber) continue;
    const phaseName = formatPhaseName(row.phase_name) || "Unassigned";
    if (!adminPlhPhaseAllowed(phaseName)) continue;
    const remainingHours = round(row.remaining_hours, 2);
    const totalLoadHours = round(row.total_load_hours, 2);
    const completedHours = round(row.completed_hours, 2);
    let tierKey = "original";
    let isCarryover = false;

    if (currentCycleNumber && cycleNumber === currentCycleNumber) {
      tierKey = "current";
      currentRows.push({
        phaseName,
        phaseKey: adminPhaseFamilyName(phaseName),
        cycleNumber,
        cycleLabel: row.cycle_label || cycleStatus.label,
        remainingHours,
        totalLoadHours,
        completedHours,
        status: row.status || ""
      });
    } else if (cycleNumber && carryoverCycleNumbers.includes(cycleNumber)) {
      tierKey = `carryoverC${cycleNumber}`;
      isCarryover = true;
    } else if (cycleNumber && cycleNumber > baselineCycleNumber) {
      tierKey = "carryover";
      isCarryover = true;
    }

    addAdminDebtHours(tiers[tierKey], phaseName, remainingHours);
    if (isCarryover && tierKey !== "carryover") addAdminDebtHours(tiers.carryover, phaseName, remainingHours);

    const existing = matrix.get(phaseName) || {
      phase: phaseName,
      phaseName,
      tiers: {},
      currentHours: 0,
      carryoverHours: 0,
      originalDebtHours: 0,
      totalPressureHours: 0,
      carryover: 0,
      total: 0
    };
    existing.tiers[tierKey] = round((existing.tiers[tierKey] || 0) + remainingHours, 2);
    if (tierKey === "current") existing.currentHours = round(existing.currentHours + remainingHours, 2);
    if (isCarryover || tierKey === "carryover") {
      existing.carryoverHours = round(existing.carryoverHours + remainingHours, 2);
      existing.carryover = existing.carryoverHours;
    }
    if (tierKey === "original") existing.originalDebtHours = round(existing.originalDebtHours + remainingHours, 2);
    existing.totalPressureHours = round(existing.currentHours + existing.carryoverHours + existing.originalDebtHours, 2);
    existing.total = existing.totalPressureHours;
    matrix.set(phaseName, existing);
  }

  const currentPresentationRows = adminMergeCurrentRowsForPresentation(currentRows);
  const lineOverview = adminLineOverviewFromSnapshot(latestLineOverviewSnapshot);
  const lineOverviewPhases = Array.isArray(lineOverview?.phases) ? lineOverview.phases : [];
  const hasLineOverviewPhases = lineOverviewPhases.length > 0;
  const lineOverviewTotalLoadHours = round(
    lineOverviewPhases.reduce((sum, phase) => sum + Number(phase.totalLoadHours || 0), 0),
    2
  );
  const lineOverviewCompletedHours = round(
    lineOverviewPhases.reduce((sum, phase) => sum + Number(phase.completedHours || 0), 0),
    2
  );
  const lineOverviewRemainingHours = round(
    lineOverviewPhases.reduce((sum, phase) => sum + Number(phase.remainingHours || 0), 0),
    2
  );
  const currentTotalLoadHours = hasLineOverviewPhases
    ? lineOverviewTotalLoadHours
    : round(currentPresentationRows.reduce((sum, row) => sum + Number(row.totalLoadHours || 0), 0), 2);
  const currentCompletedHours = hasLineOverviewPhases
    ? lineOverviewCompletedHours
    : round(currentPresentationRows.reduce((sum, row) => sum + Number(row.completedHours || 0), 0), 2);
  const currentRemainingHours = hasLineOverviewPhases
    ? lineOverviewRemainingHours
    : round(currentPresentationRows.reduce((sum, row) => sum + Number(row.remainingHours || 0), 0), 2);
  const completionPct = adminNumberOrNull(lineOverview?.completionPct) ??
    (currentTotalLoadHours ? round((currentCompletedHours / currentTotalLoadHours) * 100, 1) : null);
  const cycleProgressPct = adminNumberOrNull(lineOverview?.cycleProgressPct) ?? cycleStatus.progressPct;
  const expectedCompletedHours = cycleProgressPct === null || cycleProgressPct === undefined
    ? null
    : round(currentTotalLoadHours * (cycleProgressPct / 100), 2);
  const paceDeltaHours = expectedCompletedHours === null ? null : round(currentCompletedHours - expectedCompletedHours, 2);
  const paceDeltaPct = completionPct === null || cycleProgressPct === null || cycleProgressPct === undefined
    ? null
    : round(completionPct - cycleProgressPct, 1);
  const pacingStatus =
    completionPct === null ? "No cycle load" :
    paceDeltaPct >= 0 ? "On pace" :
    paceDeltaPct <= -10 ? "Behind pace" :
    "Watch pace";

  const phasePacing = hasLineOverviewPhases
    ? lineOverviewPhases.map(phase => {
      const phaseCyclePct = adminNumberOrNull(phase.cyclePct) ?? cycleProgressPct;
      const phaseCompletionPct = adminNumberOrNull(phase.completionPct);
      const totalLoadHours = adminNumberOrNull(phase.totalLoadHours) ??
        round(Number(phase.completedHours || 0) + Number(phase.remainingHours || 0), 2);
      const expectedHours = phaseCyclePct === null || phaseCyclePct === undefined
        ? null
        : round(totalLoadHours * (phaseCyclePct / 100), 2);
      const completedHours = round(Number(phase.completedHours || 0), 2);
      const paceDeltaHours = expectedHours === null ? null : round(completedHours - expectedHours, 2);
      const paceDeltaPct = phaseCompletionPct === null || phaseCyclePct === null || phaseCyclePct === undefined
        ? null
        : round(phaseCompletionPct - phaseCyclePct, 1);
      const status = adminComputedPhaseStatus(phase, cycleProgressPct);
      return {
        ...phase,
        phaseName: phase.phaseName || phase.phase,
        cycleProgressPct: phaseCyclePct,
        expectedCompletedHours: expectedHours,
        paceDeltaHours,
        paceDeltaPct,
        status,
        sourceStatus: phase.status || "",
        capacityStatus: status,
        totalLoadHours,
        completedHours,
        remainingHours: round(Number(phase.remainingHours || 0), 2),
        capacityHours: round(Number(phase.capacityHours || 0), 2),
        fullCycleCapacityHours: round(Number(phase.capacityHours || 0), 2),
        capacityDeltaHours: round(Number(phase.capacityDeltaHours || 0), 2),
        capacityLabel: phase.capacityLabel || (Number(phase.capacityHours || 0) >= Number(phase.remainingHours || 0) ? "Cushion" : "Gap"),
        workerCount: Number(phase.workerCount || 0),
        lineOverviewSource: true
      };
    })
    : currentPresentationRows
      .map(row => {
        const capacity = capacityByPresentation.get(row.phaseName) || capacityByPhase.get(row.phaseKey) || {};
        const rowCompletionPct = row.totalLoadHours ? round((row.completedHours / row.totalLoadHours) * 100, 1) : null;
        const rowExpectedHours = cycleProgressPct === null || cycleProgressPct === undefined
          ? null
          : round(row.totalLoadHours * (cycleProgressPct / 100), 2);
        const rowPaceDeltaHours = rowExpectedHours === null ? null : round(row.completedHours - rowExpectedHours, 2);
        const rowPaceDeltaPct = rowCompletionPct === null || cycleProgressPct === null || cycleProgressPct === undefined
          ? null
          : round(rowCompletionPct - cycleProgressPct, 1);
        const payload = {
          ...row,
          completionPct: rowCompletionPct,
          cycleProgressPct,
          expectedCompletedHours: rowExpectedHours,
          paceDeltaHours: rowPaceDeltaHours,
          paceDeltaPct: rowPaceDeltaPct,
          workerCount: Number(capacity.workerCount || 0),
          capacityHours: round(capacity.capacityHours || 0, 2),
          fullCycleCapacityHours: round(capacity.fullCycleCapacityHours || 0, 2),
          bankRemainingHours: round(capacity.bankRemainingHours || 0, 2),
          assignedHoursTotal: round(capacity.assignedHoursTotal || 0, 2)
        };
        const capacityDeltaSignedHours = round(Number(payload.capacityHours || 0) - Number(row.remainingHours || 0), 2);
        return {
          ...payload,
          capacityDeltaHours: Math.abs(capacityDeltaSignedHours),
          capacityDeltaSignedHours,
          capacityLabel: capacityDeltaSignedHours >= 0 ? "Cushion" : "Gap",
          status: adminPhasePacingStatus(payload, cycleProgressPct),
          capacityStatus: adminPhaseCapacityStatus({ ...payload, capacityDeltaHours: capacityDeltaSignedHours })
        };
      })
      .sort((left, right) => Number(left.paceDeltaHours || -9999) - Number(right.paceDeltaHours || -9999));

  const debtMatrix = Array.from(matrix.values())
    .map(row => {
      const tierValues = Object.fromEntries(
        tierOrder.map(tierKey => [tierKey, round(row.tiers?.[tierKey] || 0, 2)])
      );
      const total = round(tierOrder.reduce((sum, tierKey) => sum + (tierValues[tierKey] || 0), 0), 2);
      return {
        ...row,
        ...tierValues,
        tiers: tierValues,
        total,
        totalPressureHours: total,
        carryover: row.carryoverHours
      };
    })
    .filter(row => row.totalPressureHours > 0)
    .sort((left, right) => right.totalPressureHours - left.totalPressureHours);
  const daily = dailyResult.rows[0] || {};

  return {
    baselineCycle: ADMIN_PLH_BASELINE_CYCLE,
    cycleStatus,
    pacing: {
      status: pacingStatus,
      completionPct,
      cycleProgressPct,
      paceDeltaPct,
      paceDeltaHours,
      currentTotalLoadHours,
      currentCompletedHours,
      currentRemainingHours,
      expectedCompletedHours
    },
    recovery: {
      currentHours: round(tiers.current.totalHours, 2),
      carryoverHours: round(tiers.carryover.totalHours, 2),
      originalDebtHours: round(tiers.original.totalHours, 2),
      totalPressureHours: round(tiers.current.totalHours + tiers.carryover.totalHours + tiers.original.totalHours, 2),
      totalRecoveryDebtHours: round(tiers.carryover.totalHours + tiers.original.totalHours, 2),
      tiers
    },
    debtTiers: {
      baselineCycle: ADMIN_PLH_BASELINE_CYCLE,
      currentCycle: cycleStatus.label,
      cycleStatus,
      cycleStartDate: cycleStatus.startDate,
      cycleEndDate: cycleStatus.endDate,
      cycleProgressPct: cycleStatus.progressPct,
      totalWorkdays: cycleStatus.totalWorkdays,
      elapsedWorkday: cycleStatus.elapsedWorkday,
      remainingWorkdays: cycleStatus.remainingWorkdays,
      carryoverCycle: carryoverCycleLabels[carryoverCycleLabels.length - 1] || "",
      carryoverCycles: carryoverCycleLabels,
      tiers,
      tierOrder,
      matrix: debtMatrix,
      totalRecoveryDebt: round(tiers.carryover.totalHours + tiers.original.totalHours, 2),
      totalPressure: round(tiers.current.totalHours + tiers.carryover.totalHours + tiers.original.totalHours, 2),
      source: phaseCycleLoadSource
    },
    tracker: {
      latestLineOverviewDate: lineOverview?.trackerDate || "",
      lineOverview,
      source: lineOverview ? "raw.asana_tasks" : ""
    },
    phasePacing,
    debtMatrix,
    daily: {
      date: today,
      workerCount: Number(daily.worker_count || 0),
      productiveHours: round(Number(daily.productive_minutes || 0) / 60, 2),
      estimatedHours: round(Number(daily.estimated_minutes || 0) / 60, 2),
      assignedTaskCount: Number(daily.assigned_task_count || 0),
      completedTaskCount: Number(daily.completed_task_count || 0),
      reviewRequiredCount: Number(daily.review_required_count || 0)
    },
    diagnostics: {
      today,
      latestLineOverviewGid: latestLineOverviewSnapshot?.gid || "",
      latestLineOverviewName: latestLineOverviewSnapshot?.name || "",
      latestLineOverviewDate: latestLineOverviewSnapshot?.trackerDate || "",
      latestLineOverviewPhaseCount: lineOverviewPhases.length,
      phaseCycleLoadSource,
      phaseCycleLoadGroupCount: debtRows.length,
      hbPhaseCycleLoadGroupCount: debtResult.rows.length,
      rawPhaseCycleLoadRowCount: rawPhaseCycleLoad.stats.rawRowCount,
      rawPhaseCycleLoadParsedRowCount: rawPhaseCycleLoad.stats.parsedRowCount,
      rawPhaseCycleLoadPositiveRowCount: rawPhaseCycleLoad.stats.positiveRowCount,
      rawPhaseCycleLoadGroupCount: rawPhaseCycleLoad.stats.groupedRowCount,
      rawPhaseCycleLoadRemainingHours: rawPhaseCycleLoad.stats.totalRemainingHours,
      rawPhaseCycleLoadTotalHours: rawPhaseCycleLoad.stats.totalLoadHours,
      rawPhaseCycleLoadCompletedHours: rawPhaseCycleLoad.stats.completedHours,
      rawPhaseCycleLoadLatestSyncedAt: rawPhaseCycleLoad.stats.latestSyncedAt,
      currentCycleLoadRowCount: currentRows.length,
      currentPresentationPhaseCount: currentPresentationRows.length,
      capacityPhaseCount: capacityByPhase.size,
      capacityPresentationPhaseCount: capacityByPresentation.size,
      phaseFilterActive: ADMIN_PLH_PHASES.size > 0,
      phaseFilterValues: Array.from(ADMIN_PLH_PHASES)
    },
    source: hasLineOverviewPhases
      ? `raw.asana_tasks line overview + hb.cycles + ${phaseCycleLoadSource}`
      : `hb.cycles + ${phaseCycleLoadSource} + hb.worker_cycle_bank_rev1`
  };
}

async function adminDashboardPayload() {
  const [countsResult, cycleResult, runResult, phaseResult, plhMetrics] = await Promise.all([
    pool.query(`
      select
        (select count(*)::int from hb.task_templates) as task_template_count,
        (select count(*)::int from hb.task_templates where coalesce(active, true)) as active_task_template_count,
        (select count(*)::int from hb.task_templates where estimated_batch_task_time_seconds is null and estimated_task_time_seconds is null) as task_templates_missing_estimates,
        (select count(*)::int from hb.production_schedule) as production_schedule_count,
        (select count(distinct cycle_number)::int from hb.production_schedule where cycle_number is not null) as production_cycle_count,
        (select count(*)::int from hb.production_schedule where existing_rev1_task_instance_links > 0) as schedule_rows_with_rev1_links,
        (select count(*)::int from hb.rev1_task_instances) as rev1_task_instance_count,
        (select count(*)::int from hb.worker_daily_task_actuals) as worker_daily_actual_count,
        (select count(*)::int from hb.work_force where actively_employed) as active_worker_count
    `),
    pool.query(`
      select
        cycle_number,
        coalesce(short_cycle_label, cycle_label, 'C' || cycle_number::text) as cycle_label,
        min(start_date)::text as start_date,
        max(end_date)::text as end_date,
        count(*)::int as schedule_rows,
        count(distinct nullif(vin, ''))::int as vin_count,
        count(distinct coalesce(phase_record_id, phase_name, section_column))::int as phase_count,
        coalesce(sum(existing_rev1_task_instance_links), 0)::int as rev1_links
      from hb.production_schedule
      where cycle_number is not null
      group by cycle_number, coalesce(short_cycle_label, cycle_label, 'C' || cycle_number::text)
      order by cycle_number desc
      limit 8
    `),
    pool.query(`
      select
        job_name,
        status,
        ended_at::text,
        records_read,
        records_written,
        error_count
      from sync.run_log
      where job_name in ('pull_airtable', 'pull_asana', 'pull_daily_tracker', 'pull_worker_daily_actuals')
      order by ended_at desc nulls last, id desc
      limit 8
    `),
    pool.query(`
      select
        coalesce(primary_phase_name, 'Unassigned') as phase_name,
        count(*)::int as task_count,
        coalesce(sum(coalesce(estimated_batch_task_time_seconds, estimated_task_time_seconds, 0)), 0)::int as estimated_seconds,
        count(*) filter (where estimated_batch_task_time_seconds is null and estimated_task_time_seconds is null)::int as missing_estimates
      from hb.task_templates
      where coalesce(active, true)
      group by coalesce(primary_phase_name, 'Unassigned')
      order by task_count desc, phase_name
      limit 10
    `)
  ]);

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    projectCreateEnabled: ADMIN_PROJECT_CREATE_ENABLED,
    counts: countsResult.rows[0] || {},
    plh: plhMetrics,
    cycles: cycleResult.rows,
    latestRuns: runResult.rows,
    taskTemplatePhases: phaseResult.rows.map(row => ({
      ...row,
      estimatedHours: secondsToHours(row.estimated_seconds)
    })),
    features: [
      {
        key: "project-creator",
        title: "Project Creator",
        status: ADMIN_PROJECT_CREATE_ENABLED ? "write-ready" : "preview",
        href: "#project-creator"
      },
      {
        key: "source-health",
        title: "Source Health",
        status: "available",
        href: "#dashboard"
      },
      {
        key: "accounts",
        title: "Accounts",
        status: "planned",
        href: "#dashboard"
      },
      {
        key: "controls",
        title: "Admin Controls",
        status: "planned",
        href: "#dashboard"
      }
    ]
  };
}

async function selectedAdminCycleNumber(requestedCycle) {
  const explicit = adminCycleNumber(requestedCycle);
  if (explicit !== null) return explicit;
  const result = await pool.query(`
    select cycle_number
    from hb.production_schedule
    where cycle_number is not null
    order by
      case when current_date between coalesce(start_date, current_date) and coalesce(end_date, current_date) then 0 else 1 end,
      start_date desc nulls last,
      cycle_number desc
    limit 1
  `);
  return result.rows[0]?.cycle_number || null;
}

async function adminProjectCreatorPayload(url) {
  const requestedCycle = url.searchParams.get("cycle") || "";
  const selectedProductionRecordId = url.searchParams.get("productionRecordId") || "";
  const cycleNumber = await selectedAdminCycleNumber(requestedCycle);

  const [cyclesResult, scheduleResult, phaseResult] = await Promise.all([
    pool.query(`
      select
        cycle_number,
        coalesce(short_cycle_label, cycle_label, 'C' || cycle_number::text) as cycle_label,
        min(start_date)::text as start_date,
        max(end_date)::text as end_date,
        count(*)::int as schedule_rows,
        count(distinct nullif(vin, ''))::int as vin_count
      from hb.production_schedule
      where cycle_number is not null
      group by cycle_number, coalesce(short_cycle_label, cycle_label, 'C' || cycle_number::text)
      order by cycle_number desc
      limit 40
    `),
    pool.query(
      `
        select
          production_record_id,
          schedule_key,
          schedule_name,
          cycle_number,
          cycle_label,
          short_cycle_label,
          phase_record_id,
          phase_name,
          section_column,
          asana_section,
          vin,
          vin_values,
          model_type,
          start_date::text,
          end_date::text,
          days_in_cycle,
          existing_rev1_task_instance_links
        from hb.production_schedule
        where ($1::int is null or cycle_number = $1::int)
        order by start_date nulls last, nullif(vin, '') nulls last, phase_name nulls last, section_column nulls last
        limit 300
      `,
      [cycleNumber]
    ),
    pool.query(`
      select
        primary_phase_record_id,
        coalesce(primary_phase_name, 'Unassigned') as phase_name,
        count(*)::int as task_count,
        coalesce(sum(coalesce(estimated_batch_task_time_seconds, estimated_task_time_seconds, 0)), 0)::int as estimated_seconds,
        count(*) filter (where estimated_batch_task_time_seconds is null and estimated_task_time_seconds is null)::int as missing_estimates
      from hb.task_templates
      where coalesce(active, true)
      group by primary_phase_record_id, coalesce(primary_phase_name, 'Unassigned')
      order by phase_name
    `)
  ]);

  const scheduleRows = scheduleResult.rows;
  const selectedSchedule =
    scheduleRows.find(row => row.production_record_id === selectedProductionRecordId) ||
    scheduleRows[0] ||
    null;

  let preview = null;
  if (selectedSchedule) {
    const taskResult = await pool.query(
      `
        select
          task_record_id,
          tasks_key,
          task_name,
          parent_task_name,
          task_order,
          quantity,
          estimated_task_time_seconds,
          estimated_batch_task_time_seconds,
          primary_phase_record_id,
          primary_phase_name,
          assigned_worker_names,
          assignee_email,
          document_link,
          attachment_summary
        from hb.task_templates
        where coalesce(active, true)
          and (
            $1::text is null
            or primary_phase_record_id = $1::text
            or $1::text = any(phase_record_ids)
          )
        order by task_order nulls last, parent_task_name nulls first, task_name
        limit 500
      `,
      [selectedSchedule.phase_record_id || null]
    );
    const tasks = taskResult.rows.map(row => ({
      ...row,
      estimatedHours: secondsToHours(row.estimated_batch_task_time_seconds || row.estimated_task_time_seconds)
    }));
    const totalSeconds = tasks.reduce(
      (sum, row) => sum + Number(row.estimated_batch_task_time_seconds || row.estimated_task_time_seconds || 0),
      0
    );
    const missingEstimates = tasks.filter(row => !row.estimated_batch_task_time_seconds && !row.estimated_task_time_seconds).length;
    preview = {
      mode: ADMIN_PROJECT_CREATE_ENABLED ? "write-ready" : "preview-only",
      writeEnabled: ADMIN_PROJECT_CREATE_ENABLED,
      projectName: adminProjectNameForSchedule(selectedSchedule),
      schedule: selectedSchedule,
      taskCount: tasks.length,
      estimatedHours: secondsToHours(totalSeconds),
      missingEstimates,
      tasks
    };
  }

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    projectCreateEnabled: ADMIN_PROJECT_CREATE_ENABLED,
    selectedCycleNumber: cycleNumber,
    cycles: cyclesResult.rows,
    scheduleRows,
    taskTemplatePhases: phaseResult.rows.map(row => ({
      ...row,
      estimatedHours: secondsToHours(row.estimated_seconds)
    })),
    preview
  };
}

async function handleAdminProjectCreate(req) {
  const actor = APP_AUTH_ACTIVE ? await requireAuthActor(req) : null;
  requireAdminActor(actor);
  await parseJsonBody(req);

  if (!ADMIN_PROJECT_CREATE_ENABLED) {
    throw actionError("Project creation is in preview mode. Enable HAWLEY_ADMIN_PROJECT_CREATE_ENABLED after the Asana write path is reviewed.", 409, {
      code: "PROJECT_CREATE_PREVIEW_ONLY"
    });
  }

  throw actionError("Asana project creation is not implemented in this Hawley admin build yet.", 501, {
    code: "PROJECT_CREATE_NOT_IMPLEMENTED"
  });
}

async function serveStatic(req, res, url) {
  const requested =
    url.pathname === "/" ? "index.html" :
    url.pathname === "/admin" || url.pathname === "/admin/" ? "admin.html" :
    url.pathname.replace(/^\/+/, "");
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

    if (url.pathname === "/api/auth-status" && req.method === "GET") {
      sendJson(res, 200, authStatusPayload(await authActorFromRequest(req)));
      return;
    }

    if (url.pathname === "/api/auth/me" && req.method === "GET") {
      sendJson(res, 200, await authMePayload(req));
      return;
    }

    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      await handleAuthLogin(req, res);
      return;
    }

    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      await handleAuthLogout(req, res);
      return;
    }

    if (url.pathname === "/api/sync-status") {
      const authActor = APP_AUTH_ACTIVE ? await requireAuthActor(req) : null;
      requireManagerActor(authActor);
      sendJson(res, 200, await syncStatusPayload());
      return;
    }

    if (url.pathname === "/api/admin/dashboard" && req.method === "GET") {
      const authActor = APP_AUTH_ACTIVE ? await requireAuthActor(req) : null;
      requireAdminActor(authActor);
      sendJson(res, 200, await adminDashboardPayload());
      return;
    }

    if (url.pathname === "/api/admin/project-creator" && req.method === "GET") {
      const authActor = APP_AUTH_ACTIVE ? await requireAuthActor(req) : null;
      requireAdminActor(authActor);
      sendJson(res, 200, await adminProjectCreatorPayload(url));
      return;
    }

    if (url.pathname === "/api/admin/project-creator/create" && req.method === "POST") {
      sendJson(res, 200, await handleAdminProjectCreate(req));
      return;
    }

    if (url.pathname === "/api/daily-assignments" || url.pathname === "/api/assignments") {
      const authActor = APP_AUTH_ACTIVE ? await requireAuthActor(req) : null;
      sendJson(res, 200, await dailyAssignmentsPayload(url, authActor));
      return;
    }

    if (url.pathname === "/api/utilization-report" && req.method === "GET") {
      const authActor = APP_AUTH_ACTIVE ? await requireAuthActor(req) : null;
      requireManagerActor(authActor);
      sendJson(res, 200, await utilizationReportPayload(url));
      return;
    }

    if (url.pathname === "/api/reporting-navigation" && req.method === "GET") {
      const authActor = APP_AUTH_ACTIVE ? await requireAuthActor(req) : null;
      requireManagerActor(authActor);
      sendJson(res, 200, await reportingNavigationPayload(url));
      return;
    }

    if (url.pathname === "/api/transition-review-queue" && req.method === "GET") {
      const authActor = APP_AUTH_ACTIVE ? await requireAuthActor(req) : null;
      requireManagerActor(authActor);
      sendJson(res, 200, await transitionReviewQueuePayload(url));
      return;
    }

    if (url.pathname === "/api/transition-review" && req.method === "POST") {
      sendJson(res, 200, await handleTransitionReview(req));
      return;
    }

    if (url.pathname === "/api/alert-status" && req.method === "GET") {
      sendJson(res, 200, {
        enabled: false,
        channel: "log",
        configuredRecipients: 0,
        thresholdMinutes: 15,
        overEstimateThresholdMinutes: 15,
        workStart: SHOP_WORK_START,
        workEnd: SHOP_WORK_END,
        lunchStart: "11:00",
        lunchEnd: "11:30",
        pauses: SHOP_PAUSES,
        timerAutoStopEnabled: true,
        timerScheduleEnforced: true,
        pending: [],
        history: [],
        mode: "hawley-read-only-pilot"
      });
      return;
    }

    if (url.pathname === "/api/refresh-daily-tracker" && req.method === "GET") {
      const authActor = APP_AUTH_ACTIVE ? await requireAuthActor(req) : null;
      requireManagerActor(authActor);
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
      const authActor = APP_AUTH_ACTIVE ? await requireAuthActor(req) : null;
      requireManagerActor(authActor);
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
  try {
    await applyStartupMigrations();
  } catch (error) {
    console.error(`Hawley startup migrations failed: ${error.message}`);
  }
  try {
    await applyAuthSchemaMigrationIfNeeded();
  } catch (error) {
    console.error(`Hawley auth schema migration failed: ${error.message}`);
  }
  await applyRuntimeReadGrants();
  await seedInactiveAuthUsersFromWorkForce();
  await applyBootstrapAdminUser();
  startAsanaEventWatcher();
  startWorkerActualsWatcher();
  startNightlyRefreshScheduler();
  server.listen(PORT, HOST, () => {
    console.log(`Hawley worker pilot listening on http://${HOST}:${PORT}`);
  });
}

function shutdown(signal) {
  stopAsanaEventWatcher(signal);
  stopWorkerActualsWatcher(signal);
  stopNightlyRefreshScheduler(signal);
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
