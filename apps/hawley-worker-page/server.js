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
const DAILY_TRACKER_PROJECT_ID = process.env.HAWLEY_DAILY_TRACKER_PROJECT_GID || "1214157321063250";
const USE_DAT_SNAPSHOTS = process.env.HAWLEY_WORKER_USE_DAT_SNAPSHOTS === "true";
const INCLUDE_NO_WORK_WORKERS = process.env.HAWLEY_WORKER_INCLUDE_NO_WORK === "true";

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
    asanaPostedMinutes,
    loggedMinutes: Math.max(actualMinutes, timerMinutes, asanaPostedMinutes),
    dailyLoggedMinutes: numberFromField(fields["Daily Logged Minutes"]),
    dailyAvailableMinutes: numberFromField(fields["Daily Available Minutes"]),
    dailyEfficiencyPercent: numberFromField(fields["Daily Efficiency Percent"]),
    completed: booleanFromField(fields["Completed?"]),
    dailySummary: booleanFromField(fields["Daily Summary?"]),
    source: fields.Source || ""
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
    if (!taskIdValue || row.loggedMinutes <= 0) continue;

    const existingTask = (worker.tasks || []).find(task => String(task.id || "") === taskIdValue);
    if (existingTask) {
      existingTask.actualTimeOnDateMinutes = Math.max(Number(existingTask.actualTimeOnDateMinutes || 0), row.loggedMinutes);
      existingTask.actualTimeMinutes = Math.max(Number(existingTask.actualTimeMinutes || 0), row.asanaPostedMinutes);
      existingTask.timerAccumulatedMinutes = Math.max(Number(existingTask.timerAccumulatedMinutes || 0), row.timerMinutes);
      existingTask.ledgerBackfilled = true;
      existingTask.ledgerSource = row.source || "Worker Daily Task Actuals";
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
      timerStartedAt: "",
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
      ledgerSource: row.source || "Worker Daily Task Actuals"
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
      return {
        date,
        cycle: day?.cycle || cycle,
        label: `Day ${index + 1}`,
        dayNumber: index + 1,
        selected: date === selectedDate,
        hasSnapshot: Boolean(day),
        workerCount: Number(day?.workerCount || 0),
        assignedHours: round(day?.assignedHours || 0),
        completedHours: round(day?.completedHours || 0),
        remainingHours: round(day?.remainingHours || 0),
        taskCount: Number(day?.taskCount || 0),
        completedTaskCount: Number(day?.completedTaskCount || 0),
        completeTaskLabel: `${Number(day?.completedTaskCount || 0)}/${Number(day?.taskCount || 0)}`,
        status: day?.status || (day ? "Assigned" : "No Work"),
        completionPercent: day?.completionPercent !== null && day?.completionPercent !== undefined
          ? Number(day.completionPercent || 0)
          : 0
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
    where job_name in ('pull_airtable', 'pull_asana', 'pull_asana_events', 'pull_daily_tracker')
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
          'Asana Posted Minutes', asana_posted_minutes,
          'Source', source_label,
          'Completed?', completed,
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
  const employee = url.searchParams.get("employee") || "";
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
    applyWorkerDailyActualRows(allWorkers, actualRows);
    if (!employee) {
      const calendar = await cycleCalendar(selectedCycleFromTrackerSnapshots(trackerSnapshots, date), date);
      cycleDayPayload = buildCycleDaysFromTrackerSnapshots(trackerSnapshots, date, calendar);
    }
    lineOverview = selectedTrackerSnapshots.find(snapshot => snapshot.trackerType === "Line Overview");
  } else {
    allWorkers = mergeConfiguredWorkers(buildWorkers(rows), configuredRows);
    applyWorkerDailyActualRows(allWorkers, actualRows);
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

    if (url.pathname === "/api/auth-status" && req.method === "GET") {
      sendJson(res, 200, {
        writePinRequired: false,
        mode: "hawley-read-only-pilot"
      });
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
      sendError(res, 409, "Hawley worker pilot is read-only. Timer and completion writes are not enabled yet.", {
        mode: "hawley-read-only-pilot"
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
