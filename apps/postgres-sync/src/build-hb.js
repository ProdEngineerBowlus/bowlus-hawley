import pg from "pg";
import { getDatabaseConfig } from "./config.js";

const { Client } = pg;

function toArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function firstValue(value) {
  const values = toArray(value);
  return values.length ? values[0] : null;
}

function linkedIds(value) {
  return toArray(value)
    .map(item => {
      if (!item) return "";
      if (typeof item === "string") return item.trim();
      if (typeof item === "object") return String(item.id || item.value || item.name || "").trim();
      return String(item).trim();
    })
    .filter(Boolean);
}

function firstLinkedId(value) {
  return linkedIds(value)[0] || null;
}

function displayText(value) {
  const first = firstValue(value);
  if (first === null || first === undefined) return "";
  if (typeof first === "string") return first.trim();
  if (typeof first === "number" || typeof first === "boolean") return String(first);
  if (typeof first === "object") return String(first.name || first.email || first.value || first.id || "").trim();
  return String(first).trim();
}

function text(value) {
  const result = displayText(value);
  return result || null;
}

function numberValue(value, fallback = null) {
  const raw = firstValue(value);
  if (raw === null || raw === undefined || raw === "") return fallback;
  if (typeof raw === "object") return numberValue(raw.value ?? raw.name ?? raw.id, fallback);
  const parsed = Number(String(raw).replace(/[^0-9.\-]+/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function integerValue(value, fallback = null) {
  const parsed = numberValue(value, fallback);
  return parsed === null || parsed === undefined ? fallback : Math.trunc(parsed);
}

function booleanValue(value) {
  const raw = firstValue(value);
  if (raw === true) return true;
  if (raw === false || raw === null || raw === undefined || raw === "") return false;
  if (typeof raw === "number") return raw !== 0;
  const normalized = String(raw).trim().toLowerCase();
  return ["true", "1", "yes", "y", "checked", "complete", "completed"].includes(normalized);
}

function dateValue(value) {
  const raw = firstValue(value);
  if (!raw) return null;
  if (typeof raw === "object") return dateValue(raw.value ?? raw.name ?? raw.date);
  const normalized = String(raw).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(normalized) ? normalized.slice(0, 10) : null;
}

function timestampValue(value) {
  const raw = firstValue(value);
  if (!raw) return null;
  if (typeof raw === "object") return timestampValue(raw.value ?? raw.name ?? raw.date);
  const normalized = String(raw).trim();
  return normalized ? normalized : null;
}

function durationSeconds(value) {
  const parsed = numberValue(value, null);
  return parsed === null ? null : Math.round(parsed);
}

function round(value, precision = 2) {
  const parsed = Number(value || 0);
  const multiplier = 10 ** precision;
  return Math.round((parsed + Number.EPSILON) * multiplier) / multiplier;
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function fullTableName(tableName) {
  return tableName.split(".").map(quoteIdent).join(".");
}

async function upsertRow(client, tableName, conflictColumn, row) {
  const columns = Object.keys(row);
  const placeholders = columns.map((_, index) => `$${index + 1}`);
  const updates = columns
    .filter(column => column !== conflictColumn)
    .map(column => `${quoteIdent(column)} = excluded.${quoteIdent(column)}`);

  await client.query(
    `
      insert into ${fullTableName(tableName)}
        (${columns.map(quoteIdent).join(", ")})
      values
        (${placeholders.join(", ")})
      on conflict (${quoteIdent(conflictColumn)}) do update set
        ${updates.join(", ")}
    `,
    columns.map(column => row[column])
  );
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function upsertRows(client, tableName, conflictColumn, rows, chunkSize = 200) {
  if (!rows.length) return;
  const columns = Object.keys(rows[0]);
  const updates = columns
    .filter(column => column !== conflictColumn)
    .map(column => `${quoteIdent(column)} = excluded.${quoteIdent(column)}`);

  for (const batch of chunk(rows, chunkSize)) {
    const params = [];
    const valueRows = batch.map(row => {
      const placeholders = columns.map(column => {
        params.push(row[column]);
        return `$${params.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });

    await client.query(
      `
        insert into ${fullTableName(tableName)}
          (${columns.map(quoteIdent).join(", ")})
        values
          ${valueRows.join(",\n          ")}
        on conflict (${quoteIdent(conflictColumn)}) do update set
          ${updates.join(", ")}
      `,
      params
    );
  }
}

async function insertRow(client, tableName, row) {
  const columns = Object.keys(row);
  const placeholders = columns.map((_, index) => `$${index + 1}`);
  await client.query(
    `
      insert into ${fullTableName(tableName)}
        (${columns.map(quoteIdent).join(", ")})
      values
        (${placeholders.join(", ")})
    `,
    columns.map(column => row[column])
  );
}

async function insertRows(client, tableName, rows, chunkSize = 250) {
  if (!rows.length) return;
  const columns = Object.keys(rows[0]);

  for (const batch of chunk(rows, chunkSize)) {
    const params = [];
    const valueRows = batch.map(row => {
      const placeholders = columns.map(column => {
        params.push(row[column]);
        return `$${params.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });

    await client.query(
      `
        insert into ${fullTableName(tableName)}
          (${columns.map(quoteIdent).join(", ")})
        values
          ${valueRows.join(",\n          ")}
      `,
      params
    );
  }
}

async function deleteBootstrapRowsNotSeen(client, tableName, idColumn, seenIds) {
  if (seenIds.length === 0) return;
  await client.query(
    `
      delete from ${fullTableName(tableName)}
      where source_system = 'airtable_bootstrap'
        and not (${quoteIdent(idColumn)} = any($1::text[]))
    `,
    [seenIds]
  );
}

async function deleteSourceRowsNotSeen(client, tableName, idColumn, sourceSystem, seenIds) {
  if (seenIds.length === 0) {
    await client.query(
      `
        delete from ${fullTableName(tableName)}
        where source_system = $1
      `,
      [sourceSystem]
    );
    return;
  }
  await client.query(
    `
      delete from ${fullTableName(tableName)}
      where source_system = $1
        and not (${quoteIdent(idColumn)} = any($2::text[]))
    `,
    [sourceSystem, seenIds]
  );
}

async function rawRows(client, tableName) {
  const result = await client.query(`
    select record_id, fields_json, synced_at
    from ${fullTableName(tableName)}
    order by record_id
  `);
  return result.rows;
}

async function rawAsanaPortfolioTaskRows(client) {
  const result = await client.query(`
    select distinct on (task.gid)
      task.gid,
      task.project_gid,
      task.parent_gid,
      task.name,
      task.assignee_gid,
      task.assignee_name,
      task.assignee_email,
      task.completed,
      task.completed_at,
      task.due_on,
      task.due_at,
      task.start_on,
      task.start_at,
      task.actual_time_minutes,
      task.num_subtasks,
      task.custom_fields_json,
      task.created_at,
      task.modified_at,
      task.permalink_url,
      task.raw_json,
      task.synced_at,
      project.name as project_name,
      portfolio_project.portfolio_gid,
      portfolio_project.portfolio_name,
      portfolio_project.task_type as portfolio_task_type
    from raw.asana_tasks task
    join raw.asana_portfolio_projects portfolio_project on portfolio_project.project_gid = task.project_gid
    left join raw.asana_projects project on project.gid = task.project_gid
    order by task.gid, portfolio_project.portfolio_gid
  `);
  return result.rows;
}

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\w\s/.]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeProductionPhase(value) {
  const raw = normalizeKey(value);
  if (!raw) return "";
  if (raw.includes("cnc")) return "CNC";
  if (raw.includes("fab")) return "FAB";
  if (raw.includes("frame")) return "Frames";
  if (raw.includes("qc")) return "QC /Inventory";
  if (raw === "a1" || raw === "a2" || raw === "a" || raw.includes("phase a")) return "Phase A";
  if (raw === "b" || raw.includes("phase b")) return "Phase B";
  if (raw === "c" || raw.includes("phase c")) return "Phase C";
  if (raw === "d" || raw.includes("phase d")) return "Phase D";
  if (raw === "e" || raw.includes("phase e")) return "Phase E";
  if (raw === "f" || raw.includes("phase f")) return "Phase F";
  if (raw === "g" || raw.includes("phase g")) return "Phase G";
  if (raw === "h" || raw.includes("phase h")) return "Phase H";
  return displayText(value);
}

function parityPhaseName(homePhaseText, cycleNumber) {
  if (cycleNumber === null || cycleNumber === undefined) return "";
  const suffix = Number(cycleNumber) % 2 === 0 ? "A" : "B";
  const normalized = normalizeProductionPhase(homePhaseText);
  if (normalized === "Phase A") return Number(cycleNumber) % 2 === 0 ? "A1" : "A2";
  if (normalized === "CNC") return `CNC-${suffix}`;
  if (normalized === "FAB") return `FAB-${suffix}`;
  if (normalized === "Frames") return `Frame-${suffix}`;
  return "";
}

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseHolidayDates(value) {
  return new Set(
    String(value || "")
      .split(/[,;\n]+/)
      .map(item => item.trim())
      .filter(Boolean)
      .map(item => {
        const iso = item.match(/\d{4}-\d{2}-\d{2}/)?.[0];
        if (iso) return iso;
        const mdY = item.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (!mdY) return "";
        return `${mdY[3]}-${String(mdY[1]).padStart(2, "0")}-${String(mdY[2]).padStart(2, "0")}`;
      })
      .filter(Boolean)
  );
}

function dateRange(startDate, endDate) {
  const dates = [];
  if (!startDate || !endDate) return dates;
  const current = new Date(`${startDate}T12:00:00`);
  const end = new Date(`${endDate}T12:00:00`);
  while (current <= end) {
    dates.push(localDateString(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

function countBusinessDaysInclusive(startDate, endDate, holidayDates = new Set()) {
  return dateRange(startDate, endDate).filter(value => {
    const day = new Date(`${value}T12:00:00`).getDay();
    return day !== 0 && day !== 6 && !holidayDates.has(value);
  }).length;
}

function computeCyclePercent({ startDate, endDate, daysInCycle, holidays }) {
  if (!startDate || !endDate || !daysInCycle) return null;
  const today = localDateString();
  if (today < startDate) return 0;
  const clampedToday = today > endDate ? endDate : today;
  const elapsed = countBusinessDaysInclusive(startDate, clampedToday, parseHolidayDates(holidays));
  return round(Math.max(0, Math.min(1, elapsed / Math.max(daysInCycle, 1))), 6);
}

function phaseCycleKey(phaseId, cycleId) {
  return phaseId && cycleId ? `${phaseId}::${cycleId}` : "";
}

function cycleNumberFromText(value) {
  const match = String(value || "").match(/\bC?\s*(\d{1,3})\b/i);
  return match ? Number(match[1]) : null;
}

function addNormalizedLookup(map, key, value) {
  const normalized = normalizeKey(key);
  if (normalized && !map.has(normalized)) map.set(normalized, value);
}

function buildLookups(workers, cycles, phases) {
  const lookups = {
    workers: new Map(workers.map(row => [row.workforce_record_id, row])),
    workersByEmail: new Map(),
    workersByName: new Map(),
    cycles: new Map(cycles.map(row => [row.cycle_record_id, row])),
    cyclesByLabel: new Map(),
    cyclesByNumber: new Map(),
    phases: new Map(phases.map(row => [row.phase_record_id, row])),
    phasesByLabel: new Map(),
    phasesByNormalizedName: new Map()
  };

  for (const worker of workers) {
    addNormalizedLookup(lookups.workersByEmail, worker.worker_email, worker);
    addNormalizedLookup(lookups.workersByName, worker.worker_name, worker);
  }
  for (const cycle of cycles) {
    addNormalizedLookup(lookups.cyclesByLabel, cycle.cycle_label, cycle);
    addNormalizedLookup(lookups.cyclesByLabel, cycle.cycle_number ? `C${cycle.cycle_number}` : "", cycle);
    if (cycle.cycle_number !== null && cycle.cycle_number !== undefined) {
      lookups.cyclesByNumber.set(Number(cycle.cycle_number), cycle);
    }
  }
  for (const phase of phases) {
    addNormalizedLookup(lookups.phasesByLabel, phase.phase_name, phase);
    addNormalizedLookup(lookups.phasesByLabel, phase.section_column, phase);
    addNormalizedLookup(lookups.phasesByNormalizedName, normalizeProductionPhase(phase.phase_name), phase);
    addNormalizedLookup(lookups.phasesByNormalizedName, normalizeProductionPhase(phase.section_column), phase);
  }

  return lookups;
}

function findWorker(lookups, email, name) {
  const byEmail = lookups.workersByEmail.get(normalizeKey(email));
  if (byEmail) return byEmail;
  return lookups.workersByName.get(normalizeKey(name)) || null;
}

function findCycle(lookups, ...values) {
  for (const value of values) {
    const byLabel = lookups.cyclesByLabel.get(normalizeKey(value));
    if (byLabel) return byLabel;
    const number = cycleNumberFromText(value);
    if (number !== null && lookups.cyclesByNumber.has(number)) return lookups.cyclesByNumber.get(number);
  }
  return null;
}

function findPhase(lookups, ...values) {
  for (const value of values) {
    const byLabel = lookups.phasesByLabel.get(normalizeKey(value));
    if (byLabel) return byLabel;
    const normalized = normalizeProductionPhase(value);
    const byNormalized = lookups.phasesByNormalizedName.get(normalizeKey(normalized));
    if (byNormalized) return byNormalized;
  }
  return null;
}

function asanaFieldsByName(fields) {
  return toArray(fields).reduce((result, field) => {
    if (field?.name) result[field.name] = field;
    return result;
  }, {});
}

function asanaField(fieldsByName, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(fieldsByName, name)) return fieldsByName[name];
  }
  const normalizedNames = new Set(names.map(normalizeKey));
  return Object.values(fieldsByName).find(field => normalizedNames.has(normalizeKey(field?.name))) || null;
}

function hasAsanaField(fieldsByName, names) {
  return Boolean(asanaField(fieldsByName, names));
}

function asanaFieldValue(field) {
  if (!field) return null;
  if (field.date_value?.date) return field.date_value.date;
  if (field.date_value?.date_time) return field.date_value.date_time;
  if (field.enum_value?.name) return field.enum_value.name;
  if (Array.isArray(field.multi_enum_values) && field.multi_enum_values.length) {
    return field.multi_enum_values.map(item => item.name).filter(Boolean).join(", ");
  }
  if (field.number_value !== undefined && field.number_value !== null) return field.number_value;
  if (field.text_value !== undefined && field.text_value !== null) return field.text_value;
  if (field.display_value !== undefined && field.display_value !== null) return field.display_value;
  return null;
}

function asanaText(fieldsByName, names) {
  const value = asanaFieldValue(asanaField(fieldsByName, names));
  if (value === null || value === undefined || value === "") return null;
  return String(value).trim() || null;
}

function asanaNumber(fieldsByName, names) {
  const value = asanaFieldValue(asanaField(fieldsByName, names));
  return numberValue(value);
}

function asanaInteger(fieldsByName, names) {
  const value = asanaNumber(fieldsByName, names);
  return value === null || value === undefined ? null : Math.trunc(value);
}

function asanaDate(fieldsByName, names) {
  return dateValue(asanaFieldValue(asanaField(fieldsByName, names)));
}

function asanaDurationSeconds(fieldsByName, names) {
  const minutes = asanaNumber(fieldsByName, names);
  return minutes === null || minutes === undefined ? null : Math.round(minutes * 60);
}

function asanaFieldDisplayMap(fieldsByName) {
  return Object.fromEntries(
    Object.values(fieldsByName)
      .filter(field => field?.name)
      .map(field => [field.name, asanaFieldValue(field)])
  );
}

function asanaSourceSection(asana) {
  const memberships = toArray(asana.raw_json?.memberships);
  const sourceMembership =
    memberships.find(membership => membership.project?.gid === asana.project_gid && membership.section?.name) ||
    memberships.find(membership => membership.section?.name);
  return sourceMembership?.section?.name || null;
}

function maxTimestamp(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return new Date(left) > new Date(right) ? left : right;
}

function displayBucketKey(phase, cycle) {
  if (!phase || !cycle) return "";
  return `${cycle.cycle_label || `C${cycle.cycle_number || ""}`}-${phase.phase_name || phase.phase_record_id}`;
}

function addTaskGroup(map, key, seed, task) {
  if (!map.has(key)) {
    map.set(key, {
      ...seed,
      taskIds: [],
      taskRecordIds: [],
      totalHours: 0,
      completedHours: 0,
      remainingHours: 0
    });
  }

  const group = map.get(key);
  group.taskIds.push(task.rev1_task_instance_id);
  if (task.airtable_record_id) group.taskRecordIds.push(task.airtable_record_id);
  group.totalHours += task.batchHours;
  if (task.task_completed) group.completedHours += task.batchHours;
  else group.remainingHours += task.batchHours;
}

function unique(values) {
  return Array.from(new Set((values || []).filter(value => value !== null && value !== undefined && value !== "")));
}

function timestampMillis(value) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function maxActualMinutes(row) {
  return Math.max(
    Number(row.actual_minutes || 0),
    Number(row.timer_minutes || 0),
    Number(row.asana_posted_minutes || 0),
    Number(row.daily_logged_minutes || 0)
  );
}

function compareActualRows(left, right) {
  const leftTime = Math.max(
    timestampMillis(left.last_seen_at),
    timestampMillis(left.efficiency_snapshot_at),
    timestampMillis(left.source_synced_at)
  );
  const rightTime = Math.max(
    timestampMillis(right.last_seen_at),
    timestampMillis(right.efficiency_snapshot_at),
    timestampMillis(right.source_synced_at)
  );
  if (leftTime !== rightTime) return leftTime - rightTime;

  const leftMinutes = maxActualMinutes(left);
  const rightMinutes = maxActualMinutes(right);
  if (leftMinutes !== rightMinutes) return leftMinutes - rightMinutes;

  return String(left.airtable_record_id || "").localeCompare(String(right.airtable_record_id || ""));
}

function dedupeActualRowsByLedger(rows) {
  const byLedger = new Map();
  for (const row of rows) {
    const current = byLedger.get(row.ledger_key);
    if (!current || compareActualRows(row, current) > 0) {
      byLedger.set(row.ledger_key, row);
    }
  }
  return {
    rows: Array.from(byLedger.values()),
    duplicateLedgers: rows.length - byLedger.size
  };
}

async function upsertWorkerDailyActualRows(client, rows) {
  if (!rows.length) return;

  const recordIds = unique(rows.map(row => row.airtable_record_id));
  if (recordIds.length) {
    await client.query(
      `
        delete from hb.worker_daily_task_actuals
        where source_system is distinct from 'hawley_worker_live_pilot'
          and airtable_record_id = any($1::text[])
      `,
      [recordIds]
    );
  }

  const columns = Object.keys(rows[0]);
  const updates = columns
    .filter(column => column !== "ledger_key")
    .map(column => `${quoteIdent(column)} = excluded.${quoteIdent(column)}`);

  for (const row of rows) {
    await client.query(
      `
        insert into hb.worker_daily_task_actuals
          (${columns.map(quoteIdent).join(", ")})
        values
          (${columns.map((_, index) => `$${index + 1}`).join(", ")})
        on conflict (ledger_key) do update set
          ${updates.join(", ")}
        where hb.worker_daily_task_actuals.source_system is distinct from 'hawley_worker_live_pilot'
      `,
      columns.map(column => row[column])
    );
  }
}

function firstPresentField(fields, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(fields, name)) return fields[name];
  }
  return undefined;
}

function textFromAny(fields, names) {
  return text(firstPresentField(fields, names));
}

function flattenFieldValues(value) {
  const result = [];
  const visit = item => {
    if (item === null || item === undefined || item === "") return;
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (typeof item === "object") {
      visit(item.name ?? item.email ?? item.value ?? item.text ?? item.id);
      return;
    }
    const normalized = String(item).trim();
    if (normalized) result.push(normalized);
  };
  visit(value);
  return result;
}

function textList(value) {
  return unique(flattenFieldValues(value));
}

function recordLinkedIds(value) {
  return unique(linkedIds(value).filter(id => /^rec[a-z0-9]+$/i.test(id)));
}

function recordLinkedIdsFromAny(fields, names) {
  return unique(names.flatMap(name => recordLinkedIds(fields[name])));
}

function nonRecordTextList(value) {
  return textList(value).filter(item => !/^rec[a-z0-9]+$/i.test(item));
}

function optionalBoolean(value) {
  const raw = firstValue(value);
  if (raw === null || raw === undefined || raw === "") return null;
  return booleanValue(value);
}

function validUrl(value) {
  if (!value) return false;
  try {
    new URL(String(value));
    return true;
  } catch {
    return false;
  }
}

function filenameFromUrl(value) {
  try {
    const url = new URL(String(value));
    const name = url.pathname.split("/").filter(Boolean).pop();
    return name ? decodeURIComponent(name) : "attachment";
  } catch {
    return "attachment";
  }
}

function attachmentFiles(value) {
  const files = [];
  const seen = new Set();
  for (const item of toArray(value)) {
    let url = "";
    let filename = "";
    if (typeof item === "string") {
      url = item.trim();
      filename = filenameFromUrl(url);
    } else if (item && typeof item === "object") {
      url = String(item.url || item.downloadUrl || item.download_url || "").trim();
      filename = String(item.filename || item.name || item.id || filenameFromUrl(url)).trim();
    }
    if (!validUrl(url)) continue;
    const key = `${url}::${filename}`;
    if (seen.has(key)) continue;
    seen.add(key);
    files.push({ url, filename: filename || "attachment" });
  }
  return files;
}

function attachmentSummary(value) {
  const files = attachmentFiles(value);
  return files.length ? files.map(file => file.filename).join("\n") : null;
}

function phaseNamesForIds(ids, lookups) {
  return unique(ids.map(id => lookups.phases.get(id)?.phase_name || lookups.phases.get(id)?.section_column));
}

function workerNamesForIds(ids, lookups) {
  return unique(ids.map(id => lookups.workers.get(id)?.worker_name));
}

function normalizeVinValue(value) {
  const normalized = String(value || "")
    .replace(/^vin\s*/i, "")
    .trim();
  const match = normalized.match(/\b\d{3,5}\b/);
  return match ? match[0] : normalized;
}

function splitVinValues(value) {
  return String(value || "")
    .split(/[,;/\n]+/)
    .map(item => normalizeVinValue(item))
    .filter(Boolean);
}

function vinValuesFromFields(fields) {
  return unique(
    [
      ...nonRecordTextList(fields["VIN (from VIN)"]),
      ...nonRecordTextList(fields["VIN Number"]),
      ...nonRecordTextList(fields.VIN)
    ].flatMap(splitVinValues)
  );
}

function taskTemplateRow(raw, lookups) {
  const fields = raw.fields_json || {};
  const phaseIds = recordLinkedIds(fields.Phase);
  const phaseNames = unique([
    ...phaseNamesForIds(phaseIds, lookups),
    ...nonRecordTextList(fields.Phase)
  ]);
  const workerIds = recordLinkedIdsFromAny(fields, ["Name", "Assigned Worker", "Worker"]);
  const workerNames = unique([
    ...workerNamesForIds(workerIds, lookups),
    ...nonRecordTextList(firstPresentField(fields, ["Name", "Assigned Worker", "Worker"]))
  ]);
  const parentRecordId = recordLinkedIdsFromAny(fields, ["Parent Task Record", "Parent Task", "Parent"])[0] || null;
  const status = textFromAny(fields, ["Status", "Task Status", "Template Status"]);
  const active = optionalBoolean(firstPresentField(fields, ["Active?", "Active", "Task Active?"]));
  const primaryWorker = workerIds.length ? lookups.workers.get(workerIds[0]) : null;
  const attachmentValue = fields["Diagrams & Utilities"];

  return {
    task_record_id: raw.record_id,
    tasks_key: text(fields.TasksKey) || text(fields["Tasks Key"]),
    task_name: text(fields["Task Name"]) || text(fields.Task) || raw.record_id,
    parent_task_record_id: parentRecordId,
    parent_task_name:
      text(fields["Parent Task Name"]) ||
      (parentRecordId ? null : text(fields["Parent Task"])) ||
      text(fields.Parent),
    task_order: numberValue(fields["Task Order"]) ?? numberValue(fields.Order) ?? numberValue(fields.Sort),
    quantity: numberValue(fields.Quantity),
    estimated_task_time_seconds: durationSeconds(fields["Estimated Task Time"]),
    estimated_batch_task_time_seconds:
      durationSeconds(fields["Estimated Batched Task Time"]) ??
      durationSeconds(fields["Estimated Batch Task Time"]) ??
      durationSeconds(fields["Estimated Time (w/ Qty)"]),
    primary_phase_record_id: phaseIds[0] || null,
    primary_phase_name: phaseNames[0] || null,
    phase_record_ids: phaseIds,
    phase_names: phaseNames,
    primary_worker_record_id: workerIds[0] || null,
    primary_worker_name: workerNames[0] || null,
    assigned_worker_record_ids: workerIds,
    assigned_worker_names: workerNames,
    assignee_email: text(fields.Assignee) || primaryWorker?.worker_email || null,
    document_link: text(fields["Document Link"]) || text(fields["SOP Link"]),
    attachment_summary: attachmentSummary(attachmentValue),
    attachment_files_json: JSON.stringify(attachmentFiles(attachmentValue)),
    task_description: text(fields["Task Description"]) || text(fields.Description) || text(fields.Notes),
    template_status: status,
    active: active ?? (status ? !/\b(inactive|archived|retired)\b/i.test(status) : null),
    fields_json: fields,
    source_system: "airtable_tasks",
    source_synced_at: raw.synced_at
  };
}

function taskTemplateRows(rawRows, lookups) {
  const rows = rawRows.map(raw => taskTemplateRow(raw, lookups));
  const byRecordId = new Map(rows.map(row => [row.task_record_id, row]));
  for (const row of rows) {
    if (!row.parent_task_name && row.parent_task_record_id && byRecordId.has(row.parent_task_record_id)) {
      row.parent_task_name = byRecordId.get(row.parent_task_record_id).task_name;
    }
  }
  return rows;
}

function productionScheduleRow(raw, lookups) {
  const fields = raw.fields_json || {};
  const cycleIds = recordLinkedIds(fields.Cycle);
  const phaseIds = recordLinkedIds(fields.Phase);
  const cycle =
    (cycleIds[0] ? lookups.cycles.get(cycleIds[0]) : null) ||
    findCycle(lookups, fields["Cycle Number"], fields["Cycle Number (from Cycle)"], fields["Cycle Label"], fields.Cycle);
  const phase =
    (phaseIds[0] ? lookups.phases.get(phaseIds[0]) : null) ||
    findPhase(lookups, fields["Section/Column"], fields["Asana Section"], fields.Phase);
  const cycleNumber =
    integerValue(fields["Cycle Number"]) ??
    integerValue(fields["Cycle Number (from Cycle)"]) ??
    cycle?.cycle_number ??
    cycleNumberFromText(text(fields.Cycle));
  const cycleLabel =
    text(fields["Cycle Label"]) ||
    cycle?.cycle_label ||
    (cycleNumber !== null && cycleNumber !== undefined ? `C${cycleNumber}` : text(fields.Cycle));
  const shortCycleLabel =
    cycleNumber !== null && cycleNumber !== undefined ? `C${cycleNumber}` : cycleLabel;
  const vinValues = vinValuesFromFields(fields);
  const vinRecordIds = recordLinkedIdsFromAny(fields, ["VIN Record", "VIN"]);
  const phaseName = phase?.phase_name || text(fields.Phase) || text(fields["Section/Column"]);
  const sectionColumn = text(fields["Section/Column"]) || phase?.section_column || null;
  const taskInstanceIds = recordLinkedIds(fields["Task Instances Rev1"]);
  const scheduleKey = unique([
    shortCycleLabel,
    vinValues[0],
    phase?.phase_record_id || phaseName || sectionColumn
  ]).join("::") || raw.record_id;

  return {
    production_record_id: raw.record_id,
    schedule_key: scheduleKey,
    schedule_name: text(fields["Schedule Name"]) || text(fields.Name) || scheduleKey,
    cycle_number: cycleNumber,
    cycle_label: cycleLabel,
    short_cycle_label: shortCycleLabel,
    cycle_record_id: cycleIds[0] || cycle?.cycle_record_id || null,
    phase_record_id: phaseIds[0] || phase?.phase_record_id || null,
    phase_name: phaseName,
    section_column: sectionColumn,
    asana_section: text(fields["Asana Section"]),
    vin: vinValues.length ? vinValues.join(", ") : null,
    vin_values: vinValues,
    vin_record_ids: vinRecordIds,
    model_type: text(fields["Model Type"]),
    start_date: dateValue(fields["Start Date"]),
    end_date: dateValue(fields["End Date"]),
    days_in_cycle: integerValue(fields["Days in Cycle (from Cycle)"]) ?? integerValue(fields["Days in Cycle"]),
    task_instance_record_ids: taskInstanceIds,
    existing_rev1_task_instance_links: taskInstanceIds.length,
    fields_json: fields,
    source_system: "airtable_production",
    source_synced_at: raw.synced_at
  };
}

function workerRow(raw) {
  const fields = raw.fields_json || {};
  return {
    workforce_record_id: raw.record_id,
    worker_name: text(fields.Name),
    worker_email: text(fields.Assignee),
    actively_employed: booleanValue(fields["Actively Employed"]),
    primary_phase_record_id: firstLinkedId(fields["Primary Phase (Legacy)"]),
    home_section_column: text(fields["Home Section/Column"]),
    efficiency_factor: numberValue(fields["Efficiency Factor"], 1) ?? 1,
    ideal_efficiency_factor: numberValue(fields["Ideal Efficiency Factor"]),
    fab_skill_level: numberValue(fields["FAB SL"]),
    cnc_skill_level: numberValue(fields["CNC SL"]),
    frames_skill_level: numberValue(fields["Frames SL"]),
    phase_a_skill_level: numberValue(fields["Phase A SL"]),
    phase_b_skill_level: numberValue(fields["Phase B SL"]),
    phase_c_skill_level: numberValue(fields["Phase C SL"]),
    phase_d_skill_level: numberValue(fields["Phase D SL"]),
    phase_e_skill_level: numberValue(fields["Phase E SL"]),
    phase_f_skill_level: numberValue(fields["Phase F SL"]),
    phase_g_skill_level: numberValue(fields["Phase G SL"]),
    phase_h_skill_level: numberValue(fields["Phase H SL"]),
    qc_inventory_skill_level: numberValue(fields["QC / Inventory SL"]),
    hours_per_day: numberValue(fields["Hours Per Day"]),
    fields_json: fields,
    source_system: "airtable_bootstrap",
    source_synced_at: raw.synced_at
  };
}

function cycleRow(raw) {
  const fields = raw.fields_json || {};
  const startDate = dateValue(fields["Start Date"]);
  const endDate = dateValue(fields["End Date"]);
  const computedDaysInCycle = countBusinessDaysInclusive(startDate, endDate, parseHolidayDates(fields.Holidays));
  const daysInCycle =
    computedDaysInCycle ||
    integerValue(fields["Days In Cycle"]);
  const hoursPerWorkday = numberValue(fields["Hours Per Workday"]);
  const cycleCapacity =
    numberValue(fields["Cycle Capacity"]) ??
    (daysInCycle && hoursPerWorkday ? round(daysInCycle * hoursPerWorkday, 2) : null);
  const cycleNumber = integerValue(fields["Cycle Number"]);
  const holidays = text(fields.Holidays);

  return {
    cycle_record_id: raw.record_id,
    cycle_number: cycleNumber,
    cycle_label: cycleNumber ? `C${cycleNumber}` : text(fields["Cycle Number"]),
    start_date: startDate,
    end_date: endDate,
    quarter: text(fields.Quarter),
    days_in_cycle: daysInCycle || null,
    cycle_capacity: cycleCapacity,
    hours_per_workday: hoursPerWorkday,
    holidays,
    cycle_percent:
      computeCyclePercent({ startDate, endDate, daysInCycle, holidays }) ??
      numberValue(fields["Cycle %"]),
    sequence_number: integerValue(fields.Sequence),
    fields_json: fields,
    source_system: "airtable_bootstrap",
    source_synced_at: raw.synced_at
  };
}

function phaseRow(raw) {
  const fields = raw.fields_json || {};
  return {
    phase_record_id: raw.record_id,
    phase_name: text(fields.Name),
    section_column: text(fields["Section/Column"]),
    process_order: numberValue(fields["Process Order"]),
    installation_phase: text(fields["Installation Phase"]),
    model_type: text(fields["Model Type"]),
    frame_class: text(fields["Frame Class"]),
    task_offset: integerValue(fields["Task Offset"]),
    backfill_odd: integerValue(fields["Backfill Odd"]),
    backfill_even: integerValue(fields["Backfill Even"]),
    group_size: integerValue(fields["Group Size"]),
    parity_mode: text(fields["Parity Mode"]),
    phase_skills: text(fields["Phase Skills"]),
    fields_json: fields,
    source_system: "airtable_bootstrap",
    source_synced_at: raw.synced_at
  };
}

function recomputeTaskHours(row) {
  const estimatedSeconds = row.estimated_batch_task_time_seconds ?? row.estimated_task_time_seconds;
  row.allocated_hours = estimatedSeconds === null || estimatedSeconds === undefined
    ? row.allocated_hours
    : round(estimatedSeconds / 3600, 2);
  row.completed_est_hours = row.allocated_hours === null || row.allocated_hours === undefined
    ? row.completed_est_hours
    : (row.task_completed ? row.allocated_hours : 0);
  row.open_est_hours = row.allocated_hours === null || row.allocated_hours === undefined
    ? row.open_est_hours
    : (row.task_completed ? 0 : row.allocated_hours);
  row.actual_efficiency =
    row.actual_time_seconds !== null &&
    row.actual_time_seconds !== undefined &&
    row.estimated_batch_task_time_seconds
      ? round(row.actual_time_seconds / row.estimated_batch_task_time_seconds, 4)
      : row.actual_efficiency;
  return row;
}

function applyAsanaOverlay(row, asana, lookups) {
  const fieldsByName = asanaFieldsByName(asana.custom_fields_json || asana.raw_json?.custom_fields || []);
  const asanaFields = asanaFieldDisplayMap(fieldsByName);
  const sourceSection = asanaSourceSection(asana);
  const completed = Boolean(asana.completed);
  const actualMinutes =
    asana.actual_time_minutes === null || asana.actual_time_minutes === undefined
      ? null
      : Math.round(Number(asana.actual_time_minutes || 0));

  const assignedOnNames = ["Assigned On", "Assigned Date", "Assigned On Date"];
  const phaseText =
    asanaText(fieldsByName, ["Primary Phase", "Phase", "Phase Label", "Section/Column", "Section / Column"]) ||
    sourceSection ||
    row.phase_label ||
    row.section_column;
  const cycleText =
    asanaText(fieldsByName, ["Cycle Label", "Cycle", "Cycle Number"]) ||
    row.cycle_label ||
    asana.project_name;
  const phase = findPhase(lookups, phaseText);
  const cycle = findCycle(lookups, cycleText);
  const assigneeName = asana.assignee_name || null;
  const assigneeEmail = asana.assignee_email || null;
  const worker = findWorker(lookups, assigneeEmail, assigneeName);
  const quantity = asanaNumber(fieldsByName, ["Quantity", "Qty"]);
  const taskSeconds = asanaDurationSeconds(fieldsByName, [
    "Estimated Task Time",
    "Estimated time",
    "Estimated Time",
    "Est Time Remaining (Project)"
  ]);
  const explicitBatchSeconds = asanaDurationSeconds(fieldsByName, [
    "Estimated Batch Task Time",
    "Estimated Time (w/ Qty)",
    "Allocated Time",
    "Allocated Minutes"
  ]);
  const batchSeconds = explicitBatchSeconds ?? (quantity && taskSeconds ? Math.round(quantity * taskSeconds) : null);
  const vinNumber = asanaInteger(fieldsByName, ["VIN", "VIN Number"]);

  row.asana_task_gid = asana.gid || row.asana_task_gid;
  row.asana_project_gid = asana.project_gid || row.asana_project_gid;
  row.asana_project_name = asana.project_name || row.asana_project_name;
  row.asana_portfolio_gid = asana.portfolio_gid || row.asana_portfolio_gid;
  row.asana_portfolio_name = asana.portfolio_name || row.asana_portfolio_name;
  row.asana_section = sourceSection || row.asana_section;
  row.parent_asana_task_gid = asana.parent_gid || row.parent_asana_task_gid;
  row.parent_task_name = asana.raw_json?.parent?.name || row.parent_task_name;
  row.is_subtask = Boolean(row.parent_asana_task_gid);
  row.task_name = asana.name || row.task_name;
  row.task_description = asana.raw_json?.notes || row.task_description;
  row.task_type = row.task_type || asana.portfolio_task_type || null;
  row.task_order = asanaNumber(fieldsByName, ["Task Order", "Order"]) ?? row.task_order;
  row.task_completed = completed;
  row.completed_on = completed ? dateValue(asana.completed_at) : null;
  row.status = completed ? "Completed" : "Open";
  row.task_status = completed ? "Completed" : "Open";
  row.asana_due_date = dateValue(asana.due_on || asana.due_at) || row.asana_due_date;
  row.start_date = dateValue(asana.start_on || asana.start_at) || row.start_date;
  row.end_date = dateValue(asana.due_on || asana.due_at) || row.end_date;

  if (hasAsanaField(fieldsByName, assignedOnNames)) {
    row.assigned_on = asanaDate(fieldsByName, assignedOnNames);
  }

  row.assignee_name = assigneeName;
  row.assignee_email = assigneeEmail;
  row.worker_record_id = worker?.workforce_record_id || null;
  row.worker_name = worker?.worker_name || assigneeName;
  row.worker_email = worker?.worker_email || assigneeEmail;

  if (phase) {
    row.phase_record_id = phase.phase_record_id;
    row.phase_label = phase.phase_name;
    row.section_column = phase.section_column || row.section_column;
  } else if (phaseText) {
    row.phase_label = phaseText;
    row.section_column = sourceSection || row.section_column;
  }

  if (cycle) {
    row.cycle_record_id = cycle.cycle_record_id;
    row.cycle_label = cycle.cycle_label;
    row.days_in_cycle = cycle.days_in_cycle || row.days_in_cycle;
  } else if (cycleText) {
    row.cycle_label = cycleText;
  }

  row.phase_cycle_bucket_key =
    phaseCycleKey(row.phase_record_id, row.cycle_record_id) || row.phase_cycle_bucket_key;
  row.phase_cycle_key = row.phase_cycle_bucket_key || row.phase_cycle_key;

  if (vinNumber !== null && vinNumber !== undefined) {
    row.vin = vinNumber;
    row.vin_text = String(vinNumber);
  }
  row.quantity = quantity ?? row.quantity;
  row.estimated_task_time_seconds = taskSeconds ?? row.estimated_task_time_seconds;
  row.estimated_batch_task_time_seconds = batchSeconds ?? row.estimated_batch_task_time_seconds;
  if (actualMinutes !== null && Number.isFinite(actualMinutes)) {
    row.actual_time_minutes = actualMinutes;
    row.actual_time_seconds = actualMinutes * 60;
  }

  row.document_link = asanaText(fieldsByName, ["Document Link", "SOP Link"]) || row.document_link;
  row.active_in_production = Boolean(row.assigned_on || row.active_in_production);
  row.last_synced_at = asana.modified_at || asana.synced_at || row.last_synced_at;
  row.fields_json = {
    ...asanaFields,
    ...(row.fields_json || {}),
    _asana: {
      gid: asana.gid,
      project_gid: asana.project_gid,
      project_name: asana.project_name,
      portfolio_gid: asana.portfolio_gid,
      portfolio_name: asana.portfolio_name,
      section_name: sourceSection,
      permalink_url: asana.permalink_url,
      synced_at: asana.synced_at,
      fields: asanaFields
    }
  };
  row.source_synced_at = maxTimestamp(row.source_synced_at, asana.synced_at);

  return recomputeTaskHours(row);
}

function asanaTaskRow(asana, lookups) {
  const fieldsByName = asanaFieldsByName(asana.custom_fields_json || asana.raw_json?.custom_fields || []);
  const fields = asanaFieldDisplayMap(fieldsByName);
  const row = {
    airtable_record_id: `asana:${asana.gid}`,
    task_instance_rev1_key: asanaText(fieldsByName, ["Task Instance Rev1 Key"]) || `asana:${asana.gid}`,
    airtable_key: asanaText(fieldsByName, ["AirTableKey", "Airtable Key"]),
    asana_airtable_key: asanaText(fieldsByName, ["Asana AirTableKey", "AirTableKey", "Airtable Key"]),
    asana_task_gid: asana.gid,
    asana_project_gid: asana.project_gid,
    asana_project_name: asana.project_name,
    asana_portfolio_gid: asana.portfolio_gid,
    asana_portfolio_name: asana.portfolio_name,
    asana_section: asanaSourceSection(asana),
    parent_asana_task_gid: asana.parent_gid,
    parent_task_name: asana.raw_json?.parent?.name || null,
    parent_task: null,
    is_subtask: Boolean(asana.parent_gid),
    inherited_from_parent: false,
    task_name: asana.name,
    task_description: asana.raw_json?.notes || null,
    task_type: asana.portfolio_task_type || null,
    task_order: asanaNumber(fieldsByName, ["Task Order", "Order"]),
    status: Boolean(asana.completed) ? "Completed" : "Open",
    task_status: Boolean(asana.completed) ? "Completed" : "Open",
    task_completed: Boolean(asana.completed),
    completed_on: Boolean(asana.completed) ? dateValue(asana.completed_at) : null,
    asana_due_date: dateValue(asana.due_on || asana.due_at),
    assigned_on: asanaDate(fieldsByName, ["Assigned On", "Assigned Date", "Assigned On Date"]),
    worker_record_id: null,
    worker_name: null,
    worker_email: null,
    assignee_name: asana.assignee_name || null,
    assignee_email: asana.assignee_email || null,
    phase_record_id: null,
    phase_label: asanaText(fieldsByName, ["Primary Phase", "Phase", "Phase Label", "Section/Column", "Section / Column"]),
    section_column: asanaSourceSection(asana),
    phase_cycle_bucket_key: null,
    phase_cycle_key: null,
    cycle_record_id: null,
    cycle_label: asanaText(fieldsByName, ["Cycle Label", "Cycle", "Cycle Number"]),
    vin: asanaInteger(fieldsByName, ["VIN", "VIN Number"]),
    vin_text: asanaText(fieldsByName, ["VIN", "VIN Number"]),
    vin_record_id: null,
    line_schedule_record_id: null,
    tasks_record_id: null,
    tasks_key: asanaText(fieldsByName, ["TasksKey", "Tasks Key"]),
    model: asanaText(fieldsByName, ["Model"]),
    model_type: asanaText(fieldsByName, ["Model Type"]),
    start_date: dateValue(asana.start_on || asana.start_at),
    end_date: dateValue(asana.due_on || asana.due_at),
    quantity: asanaNumber(fieldsByName, ["Quantity", "Qty"]),
    estimated_task_time_seconds: null,
    estimated_batch_task_time_seconds: null,
    actual_time_seconds: asana.actual_time_minutes === null || asana.actual_time_minutes === undefined
      ? null
      : Math.round(Number(asana.actual_time_minutes || 0) * 60),
    actual_time_minutes: asana.actual_time_minutes === null || asana.actual_time_minutes === undefined
      ? null
      : Math.round(Number(asana.actual_time_minutes || 0)),
    allocated_hours: null,
    completed_est_hours: null,
    open_est_hours: null,
    actual_efficiency: null,
    days_in_cycle: null,
    est_time_remaining_project_seconds: asanaDurationSeconds(fieldsByName, ["Est Time Remaining (Project)"]),
    document_link: asanaText(fieldsByName, ["Document Link", "SOP Link"]),
    attachment_summary: null,
    active_in_production: Boolean(asanaDate(fieldsByName, ["Assigned On", "Assigned Date", "Assigned On Date"])),
    production_match_status: "asana_only",
    sync_status: true,
    last_synced_at: asana.modified_at || asana.synced_at,
    rev1_import_notes: "Created by Hawley Brain from Asana portfolio mirror; no Airtable Rev1 row found.",
    phase_cycle_load_record_id: null,
    worker_phase_allocation_record_id: null,
    load_type: null,
    proposed_worker: null,
    proposed_worker_record_id: null,
    proposed_start_date: null,
    proposed_end_date: null,
    scheduler_score: null,
    scheduler_status: null,
    scheduler_mode: null,
    scheduler_notes: null,
    scheduler_snapshot_id: null,
    scheduler_baseline_snapshot_id: null,
    required_skill_scheduler: null,
    current_skill_level_scheduler: null,
    proposed_skill_level_scheduler: null,
    skill_gap_scheduler: null,
    overskill_scheduler: null,
    load_delta_hours_scheduler: null,
    scheduler_locked: false,
    push_to_asana: false,
    scheduling_evaluated_at: null,
    scheduling_scope: null,
    asana_push_status: null,
    asana_push_result: null,
    asana_pushed_at: null,
    fields_json: fields,
    source_system: "asana_portfolio",
    source_synced_at: asana.synced_at
  };

  return applyAsanaOverlay(row, asana, lookups);
}

function taskRow(raw, lookups, asana = null) {
  const fields = raw.fields_json || {};
  const workerId = firstLinkedId(fields["Assigned Worker"]);
  const phaseId = firstLinkedId(fields.Phase);
  const cycleId = firstLinkedId(fields.Cycle);
  const worker = workerId ? lookups.workers.get(workerId) : null;
  const phase = phaseId ? lookups.phases.get(phaseId) : null;
  const cycle = cycleId ? lookups.cycles.get(cycleId) : null;
  const completed = booleanValue(fields["Task Completed?"]);
  const estimatedTaskSeconds = durationSeconds(fields["Estimated Task Time"]);
  const estimatedBatchSeconds = durationSeconds(fields["Estimated Batch Task Time"]);
  const actualSeconds = durationSeconds(fields["Actual time"]);
  const allocatedHours =
    estimatedBatchSeconds !== null ? round(estimatedBatchSeconds / 3600, 2) : numberValue(fields["Allocated Hours"]);
  const actualEfficiency =
    actualSeconds !== null && estimatedBatchSeconds
      ? round(actualSeconds / estimatedBatchSeconds, 4)
      : numberValue(fields["Actual Efficiency"]);
  const vinNumber = integerValue(fields.VIN);

  const row = {
    airtable_record_id: raw.record_id,
    task_instance_rev1_key: text(fields["Task Instance Rev1 Key"]),
    airtable_key: text(fields.AirTableKey),
    asana_airtable_key: text(fields["Asana AirTableKey"]),
    asana_task_gid: text(fields["Asana Task GID"]),
    asana_project_gid: text(fields["Asana Project GID"]),
    asana_project_name: text(fields["Asana Project Name"]),
    asana_portfolio_gid: text(fields["Asana Portfolio GID"]),
    asana_portfolio_name: text(fields["Asana Portfolio Name"]),
    asana_section: text(fields["Asana Section"]),
    parent_asana_task_gid: text(fields["Parent Asana Task GID"]),
    parent_task_name: text(fields["Parent Task Name"]),
    parent_task: text(fields["Parent Task"]),
    is_subtask: booleanValue(fields["Is Subtask"]),
    inherited_from_parent: booleanValue(fields["Inherited From Parent?"]),
    task_name: text(fields["Task Name"]),
    task_description: text(fields["Task Description"]),
    task_type: text(fields["Task Type"]),
    task_order: numberValue(fields["Task Order"]),
    status: text(fields.Status) || (completed ? "Completed" : "Not Started"),
    task_status: text(fields["Task Status"]) || (completed ? "Completed" : "Open"),
    task_completed: completed,
    completed_on: dateValue(fields["Completed On"]),
    asana_due_date: dateValue(fields["Asana Due Date"]),
    assigned_on: dateValue(fields["Assigned On"]),
    worker_record_id: workerId,
    worker_name: worker?.worker_name || text(fields["Assigned Worker"]),
    worker_email: worker?.worker_email || text(fields.Email) || text(fields["Assignee Email"]),
    assignee_name: text(fields["Assignee Name"]),
    assignee_email: text(fields["Assignee Email"]),
    phase_record_id: phaseId,
    phase_label: text(fields["Phase Label"]) || phase?.phase_name || null,
    section_column: text(fields["Section/Column"]) || phase?.section_column || null,
    phase_cycle_bucket_key: text(fields.PhaseCycleBucketKey) || phaseCycleKey(phaseId, cycleId) || null,
    phase_cycle_key: text(fields.PhaseCycleKey) || text(fields.PhaseCycleBucketKey) || phaseCycleKey(phaseId, cycleId) || null,
    cycle_record_id: cycleId,
    cycle_label: text(fields["Cycle Label"]) || cycle?.cycle_label || null,
    vin: vinNumber,
    vin_text: vinNumber === null ? text(fields.VIN) : String(vinNumber),
    vin_record_id: firstLinkedId(fields["VIN Record"]),
    line_schedule_record_id: firstLinkedId(fields["Line Schedule"]),
    tasks_record_id: firstLinkedId(fields.Tasks),
    tasks_key: text(fields.TasksKey),
    model: text(fields.Model),
    model_type: text(fields["Model Type"]),
    start_date: dateValue(fields["Start Date"]),
    end_date: dateValue(fields["End Date"]),
    quantity: numberValue(fields.Quantity),
    estimated_task_time_seconds: estimatedTaskSeconds,
    estimated_batch_task_time_seconds: estimatedBatchSeconds,
    actual_time_seconds: actualSeconds,
    actual_time_minutes: actualSeconds === null ? null : Math.round(actualSeconds / 60),
    allocated_hours: allocatedHours,
    completed_est_hours: allocatedHours === null ? numberValue(fields["Competed Est. Hours"]) : (completed ? allocatedHours : 0),
    open_est_hours: allocatedHours === null ? numberValue(fields["Open Est. Hours"]) : (completed ? 0 : allocatedHours),
    actual_efficiency: actualEfficiency,
    days_in_cycle: integerValue(fields["Days in Cycle"]),
    est_time_remaining_project_seconds: durationSeconds(fields["Est Time Remaining (Project)"]),
    document_link: text(fields["Document Link"]),
    attachment_summary: text(fields["Attachment summary"]),
    active_in_production: booleanValue(fields["Active In Production?"]) || Boolean(firstLinkedId(fields["Line Schedule"]) && phaseId && cycleId),
    production_match_status: text(fields["Production Match Status"]),
    sync_status: booleanValue(fields["Sync Status"]),
    last_synced_at: text(fields["Last Synced At"]),
    rev1_import_notes: text(fields["Rev1 Import Notes"]),
    phase_cycle_load_record_id: firstLinkedId(fields["Phase Cycle Load"]) || firstLinkedId(fields["Phase Cycle Load Rev1"]),
    worker_phase_allocation_record_id: firstLinkedId(fields["Worker Phase Allocation"]) || firstLinkedId(fields["Worker Phase Allocation Rev1"]),
    load_type: text(fields["Load Type"]),
    proposed_worker: text(fields["Proposed Worker"]),
    proposed_worker_record_id: text(fields["Proposed Worker Record ID"]),
    proposed_start_date: dateValue(fields["Proposed Start Date"]),
    proposed_end_date: dateValue(fields["Proposed End Date"]),
    scheduler_score: numberValue(fields["Scheduler Score"]),
    scheduler_status: text(fields["Scheduler Status"]),
    scheduler_mode: text(fields["Scheduler Mode"]),
    scheduler_notes: text(fields["Scheduler Notes"]),
    scheduler_snapshot_id: text(fields["Scheduler Snapshot ID"]),
    scheduler_baseline_snapshot_id: text(fields["Scheduler Baseline Snapshot ID"]),
    required_skill_scheduler: numberValue(fields["Required Skill (Scheduler)"]),
    current_skill_level_scheduler: numberValue(fields["Current Skill Level (Scheduler)"]),
    proposed_skill_level_scheduler: numberValue(fields["Proposed Skill Level (Scheduler)"]),
    skill_gap_scheduler: numberValue(fields["Skill Gap (Scheduler)"]),
    overskill_scheduler: numberValue(fields["Overskill (Scheduler)"]),
    load_delta_hours_scheduler: numberValue(fields["Load Delta Hours (Scheduler)"]),
    scheduler_locked: booleanValue(fields["Scheduler Locked?"]),
    push_to_asana: booleanValue(fields["Push To Asana?"]),
    scheduling_evaluated_at: text(fields["Scheduling Evaluated At"]),
    scheduling_scope: text(fields["Scheduling Scope"]),
    asana_push_status: text(fields["Asana Push Status"]),
    asana_push_result: text(fields["Asana Push Result"]),
    asana_pushed_at: text(fields["Asana Pushed At"]),
    fields_json: fields,
    source_system: "airtable_bootstrap",
    source_synced_at: raw.synced_at
  };

  return asana ? applyAsanaOverlay(row, asana, lookups) : row;
}

function actualsRow(raw) {
  const fields = raw.fields_json || {};
  return {
    airtable_record_id: raw.record_id,
    ledger_key: text(fields["Ledger Key"]),
    work_date: dateValue(fields["Work Date"]),
    worker_key: text(fields["Worker Key"]),
    worker_name: text(fields["Worker Name"]),
    worker_email: text(fields["Worker Email"]),
    asana_task_gid: text(fields["Asana Task GID"]),
    task_name: text(fields["Task Name"]),
    task_url: text(fields["Task URL"]),
    vin: text(fields.VIN),
    cycle_label: text(fields.Cycle),
    phase_label: text(fields.Phase),
    assigned_hours: numberValue(fields["Assigned Hours"]),
    allocated_hours: numberValue(fields["Allocated Hours"]),
    actual_minutes: integerValue(fields["Actual Minutes"]),
    timer_minutes: integerValue(fields["Timer Minutes"]),
    asana_posted_minutes: integerValue(fields["Asana Posted Minutes"]),
    source_label: text(fields.Source),
    was_assigned_in_dat: booleanValue(fields["Was Assigned In DAT?"]),
    was_recovered: booleanValue(fields["Was Recovered?"]),
    completed: booleanValue(fields["Completed?"]),
    last_seen_at: timestampValue(fields["Last Seen At"]),
    notes: text(fields.Notes),
    daily_summary: booleanValue(fields["Daily Summary?"]),
    daily_available_minutes: integerValue(fields["Daily Available Minutes"]),
    daily_logged_minutes: integerValue(fields["Daily Logged Minutes"]),
    daily_efficiency_percent: numberValue(fields["Daily Efficiency Percent"]),
    daily_efficiency_under_75: booleanValue(fields["Daily Efficiency Under 75?"]),
    efficiency_snapshot_at: timestampValue(fields["Efficiency Snapshot At"]),
    review_month: text(fields["Review Month"]),
    review_year: integerValue(fields["Review Year"]),
    fields_json: fields,
    source_system: "airtable_bootstrap",
    source_synced_at: raw.synced_at
  };
}

async function normalizeBaseTables(client) {
  const workerRaw = await rawRows(client, "raw.airtable_work_force");
  const cycleRaw = await rawRows(client, "raw.airtable_cycles");
  const phaseRaw = await rawRows(client, "raw.airtable_phases");

  const workers = workerRaw.map(workerRow);
  const cycles = cycleRaw.map(cycleRow);
  const phases = phaseRaw.map(phaseRow);

  await upsertRows(client, "hb.work_force", "workforce_record_id", workers);
  await upsertRows(client, "hb.cycles", "cycle_record_id", cycles);
  await upsertRows(client, "hb.phases", "phase_record_id", phases);

  await deleteBootstrapRowsNotSeen(client, "hb.work_force", "workforce_record_id", workers.map(row => row.workforce_record_id));
  await deleteBootstrapRowsNotSeen(client, "hb.cycles", "cycle_record_id", cycles.map(row => row.cycle_record_id));
  await deleteBootstrapRowsNotSeen(client, "hb.phases", "phase_record_id", phases.map(row => row.phase_record_id));

  const lookups = buildLookups(workers, cycles, phases);

  const taskTemplateRaw = await rawRows(client, "raw.airtable_tasks");
  const taskTemplates = taskTemplateRows(taskTemplateRaw, lookups);
  await upsertRows(client, "hb.task_templates", "task_record_id", taskTemplates);
  await deleteSourceRowsNotSeen(
    client,
    "hb.task_templates",
    "task_record_id",
    "airtable_tasks",
    taskTemplates.map(row => row.task_record_id)
  );

  const productionRaw = await rawRows(client, "raw.airtable_production");
  const productionSchedule = productionRaw.map(row => productionScheduleRow(row, lookups));
  await upsertRows(client, "hb.production_schedule", "production_record_id", productionSchedule);
  await deleteSourceRowsNotSeen(
    client,
    "hb.production_schedule",
    "production_record_id",
    "airtable_production",
    productionSchedule.map(row => row.production_record_id)
  );

  const taskRaw = await rawRows(client, "raw.airtable_task_instances");
  const asanaRaw = await rawAsanaPortfolioTaskRows(client);
  const asanaByGid = new Map(asanaRaw.map(row => [row.gid, row]));
  const taskRows = taskRaw.map(row => {
    const asanaTaskGid = text((row.fields_json || {})["Asana Task GID"]);
    return taskRow(row, lookups, asanaTaskGid ? asanaByGid.get(asanaTaskGid) : null);
  });
  const taskAsanaGids = new Set(taskRows.map(row => row.asana_task_gid).filter(Boolean));
  const asanaOnlyRows = asanaRaw
    .filter(row => row.gid && !taskAsanaGids.has(row.gid))
    .map(row => asanaTaskRow(row, lookups));
  const allTaskRows = taskRows.concat(asanaOnlyRows);

  await upsertRows(client, "hb.rev1_task_instances", "airtable_record_id", allTaskRows, 150);
  await deleteBootstrapRowsNotSeen(
    client,
    "hb.rev1_task_instances",
    "airtable_record_id",
    taskRows.map(row => row.airtable_record_id)
  );
  await deleteSourceRowsNotSeen(
    client,
    "hb.rev1_task_instances",
    "airtable_record_id",
    "asana_portfolio",
    asanaOnlyRows.map(row => row.airtable_record_id)
  );

  const actualsRaw = await rawRows(client, "raw.airtable_worker_daily_actuals");
  const actualDeduped = dedupeActualRowsByLedger(actualsRaw.map(actualsRow).filter(row => row.ledger_key));
  const actualRows = actualDeduped.rows;
  await upsertWorkerDailyActualRows(client, actualRows);
  await deleteSourceRowsNotSeen(
    client,
    "hb.worker_daily_task_actuals",
    "ledger_key",
    "airtable_bootstrap",
    actualRows.map(row => row.ledger_key)
  );

  return {
    workers: workers.length,
    cycles: cycles.length,
    phases: phases.length,
    taskTemplates: taskTemplates.length,
    productionSchedule: productionSchedule.length,
    taskInstances: allTaskRows.length,
    airtableTaskInstances: taskRows.length,
    asanaOnlyTaskInstances: asanaOnlyRows.length,
    asanaOverlayTaskInstances: taskRows.filter(row => row.fields_json?._asana).length,
    workerDailyActuals: actualRows.length,
    workerDailyActualDuplicateLedgers: actualDeduped.duplicateLedgers
  };
}

async function loadHbRows(client) {
  const taskResult = await client.query("select * from hb.rev1_task_instances");
  const workerResult = await client.query("select * from hb.work_force");
  const cycleResult = await client.query("select * from hb.cycles");
  const phaseResult = await client.query("select * from hb.phases");

  return {
    tasks: taskResult.rows,
    workersById: new Map(workerResult.rows.map(row => [row.workforce_record_id, row])),
    cyclesById: new Map(cycleResult.rows.map(row => [row.cycle_record_id, row])),
    phasesById: new Map(phaseResult.rows.map(row => [row.phase_record_id, row])),
    phaseIdByName: new Map(workerResult.rows.length ? [] : [])
  };
}

function phaseNameMaps(phasesById) {
  const byName = new Map();
  const byNormalizedName = new Map();

  for (const phase of phasesById.values()) {
    if (phase.phase_name) byName.set(phase.phase_name, phase.phase_record_id);
    const normalized = normalizeProductionPhase(phase.phase_name);
    if (normalized) byNormalizedName.set(normalized, phase.phase_record_id);
    const raw = normalizeKey(phase.phase_name);
    if (raw) byNormalizedName.set(raw, phase.phase_record_id);
  }

  return { byName, byNormalizedName };
}

async function rebuildCalculations(client) {
  const { tasks, workersById, cyclesById, phasesById } = await loadHbRows(client);
  const { byName: phaseIdByName, byNormalizedName: phaseIdByNormalizedName } = phaseNameMaps(phasesById);

  const phaseCycleGroups = new Map();
  const workerPhaseGroups = new Map();
  const workerCycleGroups = new Map();
  let skippedNoPhaseCycle = 0;
  let skippedNoWorker = 0;

  for (const row of tasks) {
    const phaseId = row.phase_record_id;
    const cycleId = row.cycle_record_id;
    const workerId = row.worker_record_id;
    const batchHours = Number(row.estimated_batch_task_time_seconds || 0) / 3600;
    const task = {
      ...row,
      batchHours
    };

    if (!phaseId || !cycleId) {
      skippedNoPhaseCycle += 1;
      continue;
    }

    const pck = phaseCycleKey(phaseId, cycleId);
    addTaskGroup(phaseCycleGroups, pck, { phaseId, cycleId }, task);

    if (batchHours <= 0) continue;

    if (!workerId) {
      skippedNoWorker += 1;
      continue;
    }

    const workerPhaseKey = `${workerId}::${cycleId}::${phaseId}`;
    addTaskGroup(workerPhaseGroups, workerPhaseKey, { workerId, cycleId, phaseId, phaseCycleKey: pck }, task);

    const workerCycleKey = `${workerId}::${cycleId}`;
    addTaskGroup(workerCycleGroups, workerCycleKey, { workerId, cycleId }, task);
  }

  const importAllocationKeysByPclKey = new Map();
  const exportAllocationKeysByPclKey = new Map();
  const wpaHoursByKey = new Map();
  const wpaRows = [];

  for (const [key, group] of workerPhaseGroups.entries()) {
    const worker = workersById.get(group.workerId) || {};
    const cycle = cyclesById.get(group.cycleId) || {};
    const phase = phasesById.get(group.phaseId) || {};
    const workedPhaseText = normalizeProductionPhase(phase.phase_name);
    const homePhaseText = normalizeProductionPhase(worker.home_section_column);
    const isHomePhase = Boolean(homePhaseText) && workedPhaseText === homePhaseText;
    const crossPhase = Boolean(homePhaseText) && !isHomePhase;
    const homeParityName = parityPhaseName(homePhaseText, cycle.cycle_number);
    const homePhaseId = homePhaseText
      ? phaseIdByName.get(homeParityName) || phaseIdByNormalizedName.get(homePhaseText) || null
      : null;
    const homePhaseCycleKey = homePhaseId ? phaseCycleKey(homePhaseId, group.cycleId) : "";
    const workedPhaseCycleKey = group.phaseCycleKey;

    if (crossPhase) {
      if (workedPhaseCycleKey) {
        if (!importAllocationKeysByPclKey.has(workedPhaseCycleKey)) importAllocationKeysByPclKey.set(workedPhaseCycleKey, []);
        importAllocationKeysByPclKey.get(workedPhaseCycleKey).push(key);
      }
      if (homePhaseCycleKey) {
        if (!exportAllocationKeysByPclKey.has(homePhaseCycleKey)) exportAllocationKeysByPclKey.set(homePhaseCycleKey, []);
        exportAllocationKeysByPclKey.get(homePhaseCycleKey).push(key);
      }
    }

    wpaHoursByKey.set(key, group.totalHours);
    wpaRows.push({
      worker_cycle_phase_key: key,
      worker_record_id: group.workerId,
      worker_name: worker.worker_name || null,
      worker_email: worker.worker_email || null,
      cycle_record_id: group.cycleId,
      cycle_label: cycle.cycle_label || null,
      worked_phase_record_id: group.phaseId,
      worked_phase_text: workedPhaseText || phase.phase_name || null,
      home_phase_text: homePhaseText || null,
      is_home_phase: isHomePhase,
      assigned_hours: round(group.totalHours, 2),
      imported_hours: crossPhase ? round(group.totalHours, 2) : 0,
      exported_hours: crossPhase ? round(group.totalHours, 2) : 0,
      cross_phase_support: crossPhase,
      phase_cycle_bucket_key: homePhaseCycleKey || workedPhaseCycleKey,
      worked_bucket_key: workedPhaseCycleKey,
      phase_cycle_load_key: workedPhaseCycleKey,
      worker_cycle_key: `${group.workerId}::${group.cycleId}`,
      task_instance_ids: unique(group.taskIds),
      task_airtable_record_ids: unique(group.taskRecordIds)
    });
  }

  const pclSignalKeys = new Set([
    ...phaseCycleGroups.keys(),
    ...importAllocationKeysByPclKey.keys(),
    ...exportAllocationKeysByPclKey.keys()
  ]);

  const pclRows = [];
  for (const key of pclSignalKeys) {
    const [phaseId, cycleId] = key.split("::");
    const group = phaseCycleGroups.get(key) || {
      phaseId,
      cycleId,
      taskIds: [],
      taskRecordIds: [],
      totalHours: 0,
      completedHours: 0,
      remainingHours: 0
    };
    const phase = phasesById.get(group.phaseId) || {};
    const cycle = cyclesById.get(group.cycleId) || {};
    const importKeys = unique(importAllocationKeysByPclKey.get(key) || []);
    const exportKeys = unique(exportAllocationKeysByPclKey.get(key) || []);
    const importedHours = importKeys.reduce((sum, wpaKey) => sum + (wpaHoursByKey.get(wpaKey) || 0), 0);
    const exportedHours = exportKeys.reduce((sum, wpaKey) => sum + (wpaHoursByKey.get(wpaKey) || 0), 0);
    const completion = group.totalHours ? group.completedHours / group.totalHours : 0;
    const cyclePct = Number(cycle.cycle_percent || 0);

    pclRows.push({
      phase_cycle_bucket_key: key,
      display_bucket_key: displayBucketKey(phase, cycle),
      phase_record_id: group.phaseId || null,
      phase_name: phase.phase_name || null,
      cycle_record_id: group.cycleId || null,
      cycle_label: cycle.cycle_label || null,
      total_load_hours: round(group.totalHours, 2),
      remaining_task_hours: round(group.remainingHours, 2),
      completed_task_hours: round(group.completedHours, 2),
      coverage_percent: round(completion, 6),
      imported_hours: round(importedHours, 2),
      exported_hours: round(exportedHours, 2),
      completion_percent: round(completion, 6),
      status: completion < cyclePct ? "At Risk" : "On Track",
      hours_per_day: 7.17,
      task_instance_ids: unique(group.taskIds),
      task_airtable_record_ids: unique(group.taskRecordIds),
      import_allocation_keys: importKeys,
      export_allocation_keys: exportKeys
    });
  }

  const wpaKeysByWorkerCycle = new Map();
  for (const wpa of wpaRows) {
    if (!wpaKeysByWorkerCycle.has(wpa.worker_cycle_key)) wpaKeysByWorkerCycle.set(wpa.worker_cycle_key, []);
    wpaKeysByWorkerCycle.get(wpa.worker_cycle_key).push(wpa.worker_cycle_phase_key);
  }

  const wcbRows = [];
  for (const [key, group] of workerCycleGroups.entries()) {
    const worker = workersById.get(group.workerId) || {};
    const cycle = cyclesById.get(group.cycleId) || {};
    const cycleCapacity = Number(cycle.cycle_capacity || 0);
    const efficiencyFactor = Number(worker.efficiency_factor || 1);
    const activelyEmployed = Boolean(worker.actively_employed);
    const effectiveHoursBank = activelyEmployed ? cycleCapacity * efficiencyFactor : 0;

    wcbRows.push({
      worker_cycle_key: key,
      worker_record_id: group.workerId,
      worker_name: worker.worker_name || null,
      worker_email: worker.worker_email || null,
      cycle_record_id: group.cycleId,
      cycle_label: cycle.cycle_label || null,
      assigned_hours_total: round(group.totalHours, 2),
      remaining_hours: round(effectiveHoursBank - group.totalHours, 2),
      cycle_capacity: round(cycleCapacity, 2),
      effective_hours_bank: round(effectiveHoursBank, 2),
      actively_employed: activelyEmployed,
      days_in_cycle: cycle.days_in_cycle || null,
      efficiency_factor: efficiencyFactor,
      wpa_record_keys: unique(wpaKeysByWorkerCycle.get(key) || [])
    });
  }

  await client.query("delete from hb.phase_cycle_load_rev1");
  await client.query("delete from hb.worker_phase_allocation_rev1");
  await client.query("delete from hb.worker_cycle_bank_rev1");

  await insertRows(client, "hb.phase_cycle_load_rev1", pclRows);
  await insertRows(client, "hb.worker_phase_allocation_rev1", wpaRows);
  await insertRows(client, "hb.worker_cycle_bank_rev1", wcbRows);

  return {
    phaseCycleLoadRows: pclRows.length,
    workerPhaseAllocationRows: wpaRows.length,
    workerCycleBankRows: wcbRows.length,
    skippedNoPhaseCycle,
    skippedNoWorker
  };
}

async function main() {
  const client = new Client(getDatabaseConfig({ useSyncUrl: true }));
  await client.connect();

  try {
    await client.query("begin");
    const normalized = await normalizeBaseTables(client);
    const rebuilt = await rebuildCalculations(client);
    await client.query("commit");
    console.log(JSON.stringify({
      status: "ok",
      writes: "hawley_db_only",
      normalized,
      rebuilt
    }, null, 2));
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error("Hawley Brain build failed.");
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
