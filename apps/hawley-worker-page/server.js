import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
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
const NIGHTLY_REFRESH_TIME = process.env.HAWLEY_NIGHTLY_REFRESH_TIME || "01:00";
const NIGHTLY_REFRESH_TIME_ZONE = process.env.HAWLEY_NIGHTLY_REFRESH_TIME_ZONE || "America/Los_Angeles";
const NIGHTLY_REFRESH_SCRIPT = process.env.HAWLEY_NIGHTLY_REFRESH_SCRIPT || "pg:refresh-worker-read-model";
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
const LIVE_WORKER_SOURCE = "hawley_worker_live_pilot";
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

const pool = new Pool(getDatabaseConfig());
const writePool = new Pool(getDatabaseConfig({ useSyncUrl: true }));
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
  if (/hawley_worker_page_assignments|hawley_cycle_calendar|task_work_area_inference|work_force_capability_levels|airtable_worker_daily_actuals|jsonb_display_text|task_transition_events|time_sessions|transition_category_catalog/.test(message)) {
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
  return false;
}

function shouldStartNightlyRefreshScheduler() {
  if (process.env.HAWLEY_NIGHTLY_REFRESH_ENABLED !== undefined) {
    return booleanEnv("HAWLEY_NIGHTLY_REFRESH_ENABLED", false);
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

function watcherStatuses() {
  return {
    asanaEvents: asanaEventWatcherStatus(),
    workerDailyActuals: workerActualsWatcherStatus(),
    nightlyRefresh: nightlyRefreshStatus()
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
    scheduleNextNightlyRefresh();
  });
}

function startNightlyRefreshScheduler() {
  nightlyRefreshState.requested = shouldStartNightlyRefreshScheduler();
  nightlyRefreshState.enabled = false;
  nightlyRefreshState.reason = "";

  if (!nightlyRefreshState.requested) {
    nightlyRefreshState.reason = "disabled";
    return;
  }

  if (!process.env.ASANA_PAT) {
    nightlyRefreshState.reason = "missing ASANA_PAT";
    console.warn("Hawley nightly refresh disabled: missing ASANA_PAT.");
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
    daysInCycle: Number(row.days_in_cycle || dates.length),
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
    cycleDayPayload = employee ? null : await cycleDays(date);
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

function authStatusPayload() {
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
      JSON.stringify(options.payload || {}),
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

  if (!["start", "stop", "release", "complete"].includes(action)) {
    throw actionError("Action must be start, stop, release, or complete.", 400);
  }
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

  const { worker, task } = await assignedWorkerTaskForWrite(employee, date, taskId);
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
        seenAt: nowIso
      });
      await tryWorkerTransitionLedger("start", async () => {
        await recordWorkerTaskEvent(client, worker, task, date, "start", nowIso, {
          payload: {
            startedAt: saved.startedAt,
            accumulatedMinutes: saved.accumulatedMinutes,
            ledgerKey
          }
        });
        const session = await startTimeSession(client, worker, task, date, saved.startedAt || nowIso, {
          action: "start",
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
        seenAt: eventIso
      });
      await tryWorkerTransitionLedger("stop", async () => {
        await closeTimeSession(client, worker, task, date, current.startedAt, eventIso, "stop", segmentMinutes, {
          action: "stop",
          ledgerKey,
          elapsedMinutes,
          actualMinutes
        });
        await recordWorkerTaskEvent(client, worker, task, date, "stop", eventIso, {
          durationMinutes: segmentMinutes || elapsedMinutes,
          payload: {
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
        seenAt: eventIso
      });
      await tryWorkerTransitionLedger("release", async () => {
        await closeTimeSession(client, worker, task, date, current.startedAt, eventIso, "release", segmentMinutes, {
          action: "release",
          ledgerKey,
          elapsedMinutes,
          actualMinutes
        });
        await recordWorkerTaskEvent(client, worker, task, date, "release", eventIso, {
          durationMinutes: segmentMinutes || elapsedMinutes,
          payload: {
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
      seenAt: eventIso
    });
    await tryWorkerTransitionLedger("complete", async () => {
      await closeTimeSession(client, worker, task, date, current.startedAt, eventIso, "complete", segmentMinutes, {
        action: "complete",
        ledgerKey,
        elapsedMinutes,
        actualMinutes
      });
      await recordWorkerTaskEvent(client, worker, task, date, "complete", eventIso, {
        durationMinutes: segmentMinutes || elapsedMinutes,
        syncStatus: "pending",
        payload: {
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
        seenAt: eventIso
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
      seenAt: eventIso
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

  const body = await readJsonBody(req);
  const transitionEventId = Number(body.transitionEventId || body.transition_event_id || 0);
  const managerCategory = String(body.categoryKey || body.managerCategory || "").trim();
  const managerNotes = String(body.notes || body.managerNotes || "").trim().slice(0, 4000);
  const reviewedBy = String(body.reviewedBy || "Hawley manager").trim().slice(0, 200);
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

    if (url.pathname === "/api/utilization-report" && req.method === "GET") {
      sendJson(res, 200, await utilizationReportPayload(url));
      return;
    }

    if (url.pathname === "/api/transition-review-queue" && req.method === "GET") {
      sendJson(res, 200, await transitionReviewQueuePayload(url));
      return;
    }

    if (url.pathname === "/api/transition-review" && req.method === "POST") {
      sendJson(res, 200, await handleTransitionReview(req));
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
  try {
    await applyStartupMigrations();
  } catch (error) {
    console.error(`Hawley startup migrations failed: ${error.message}`);
  }
  await applyRuntimeReadGrants();
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
