function firstValue(value) {
  if (value === null || value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export function dateValue(value) {
  const raw = firstValue(value);
  if (!raw) return null;
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : raw.toISOString().slice(0, 10);
  }
  if (typeof raw === "object") {
    return dateValue(raw.value ?? raw.name ?? raw.date ?? null);
  }
  const normalized = String(raw).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(normalized) ? normalized.slice(0, 10) : null;
}

function normalizeCycleLookupKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\w\s/.]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeYear(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return null;
  if (parsed >= 0 && parsed <= 99) return 2000 + parsed;
  return parsed >= 1900 && parsed <= 2999 ? parsed : null;
}

export function parseCycleReference(value) {
  const normalized = String(firstValue(value) || "").trim();
  if (!normalized) return null;

  const match =
    normalized.match(/\bC(?:YCLE)?\s*0*(\d{1,3})(?:\s*\.\s*((?:19|20)\d{2}|\d{2}))?\b/i) ||
    normalized.match(/^\s*0*(\d{1,3})(?:\s*\.\s*((?:19|20)\d{2}|\d{2}))?\s*$/i);
  if (!match) return null;

  const number = Number(match[1]);
  if (!Number.isInteger(number)) return null;
  const year = match[2] ? normalizeYear(match[2]) : null;
  return {
    number,
    year,
    canonicalLabel: year ? `C${number}.${String(year).slice(-2)}` : `C${number}`
  };
}

export function fabricationProjectCycleLabel(value) {
  const match = String(value || "").trim().match(/^F\s*0*(\d{1,3})\s*\.\s*((?:19|20)\d{2}|\d{2})$/i);
  if (!match) return "";
  const year = normalizeYear(match[2]);
  return year ? `C${Number(match[1])}.${String(year).slice(-2)}` : "";
}

function sourceYear(value) {
  const normalized = String(value || "").trim();
  const fourDigit = normalized.match(/\b((?:19|20)\d{2})\b/);
  if (fourDigit) return normalizeYear(fourDigit[1]);
  const dotted = normalized.match(/\.\s*(\d{2})\b/);
  return dotted ? normalizeYear(dotted[1]) : null;
}

export function qualifyCycleReference(value, ...sourceValues) {
  const reference = parseCycleReference(value);
  if (!reference || reference.year) return reference?.canonicalLabel || String(value || "").trim();
  const year = sourceValues.map(sourceYear).find(Boolean) || null;
  return year ? `C${reference.number}.${String(year).slice(-2)}` : reference.canonicalLabel;
}

function cycleYear(cycle) {
  const explicitYear = parseCycleReference(cycle?.cycle_label)?.year;
  if (explicitYear) return explicitYear;
  for (const value of [cycle?.start_date, cycle?.end_date]) {
    const normalized = dateValue(value);
    if (normalized) return Number(normalized.slice(0, 4));
  }
  return null;
}

function addCandidate(map, key, cycle) {
  if (key === null || key === undefined || key === "") return;
  const candidates = map.get(key) || [];
  if (!candidates.some(candidate => candidate.cycle_record_id === cycle.cycle_record_id)) {
    candidates.push(cycle);
  }
  map.set(key, candidates);
}

export function buildCycleIndex(cycles) {
  const byLabel = new Map();
  const byNumber = new Map();
  const byNumberYear = new Map();

  for (const cycle of cycles || []) {
    const reference = parseCycleReference(cycle.cycle_label);
    const number = Number(cycle.cycle_number ?? reference?.number);
    const year = reference?.year ?? cycleYear(cycle);

    addCandidate(byLabel, normalizeCycleLookupKey(cycle.cycle_label), cycle);
    if (Number.isInteger(number)) {
      addCandidate(byLabel, normalizeCycleLookupKey(`C${number}`), cycle);
      addCandidate(byNumber, number, cycle);
      if (year) addCandidate(byNumberYear, `${number}:${year}`, cycle);
    }
  }

  return { byLabel, byNumber, byNumberYear };
}

function onlyCandidate(map, key) {
  const candidates = map.get(key) || [];
  return candidates.length === 1 ? candidates[0] : null;
}

export function findCycleByReference(index, ...values) {
  const populatedValues = values.filter(value => value !== null && value !== undefined && value !== "");
  const qualifiedReferences = populatedValues
    .map(parseCycleReference)
    .filter(reference => reference?.year);

  if (qualifiedReferences.length) {
    const qualifiedKeys = new Set(
      qualifiedReferences.map(reference => `${reference.number}:${reference.year}`)
    );
    if (qualifiedKeys.size !== 1) return null;
    return onlyCandidate(index.byNumberYear, [...qualifiedKeys][0]);
  }

  for (const value of populatedValues) {
    const byLabel = onlyCandidate(index.byLabel, normalizeCycleLookupKey(value));
    if (byLabel) return byLabel;
    const reference = parseCycleReference(value);
    if (reference) {
      const byNumber = onlyCandidate(index.byNumber, reference.number);
      if (byNumber) return byNumber;
    }
  }
  return null;
}

export function resolveCycleAttachment(index, value, existingCycleRecordId = null) {
  const cycle = findCycleByReference(index, value);
  const reference = parseCycleReference(value);
  const clearExisting = Boolean(!cycle && reference?.year);
  return {
    cycle,
    cycleRecordId: cycle?.cycle_record_id ?? (clearExisting ? null : existingCycleRecordId),
    cycleLabel: cycle?.cycle_label || reference?.canonicalLabel || String(value || "").trim(),
    clearExisting
  };
}

export function resolveAsanaCompletion(asana, existingCompletedOn = null) {
  const rawParent = asana?.raw_json?.parent || {};
  const parent = asana?.parent || {};
  const directCompleted = Boolean(asana?.completed);
  const parentCompleted = Boolean(
    asana?.parent_completed ?? parent.completed ?? rawParent.completed ?? false
  );
  const inheritedFromParent = !directCompleted && parentCompleted;
  const completed = directCompleted || inheritedFromParent;
  const sourceCompletedAt = directCompleted
    ? asana?.completed_at
    : (asana?.parent_completed_at ?? parent.completed_at ?? rawParent.completed_at);
  const completedOn = completed
    ? (dateValue(sourceCompletedAt) || dateValue(existingCompletedOn))
    : null;

  return {
    completed,
    directCompleted,
    parentCompleted,
    inheritedFromParent,
    completedOn
  };
}

export function splitTaskHours(value, completed) {
  const parsed = Number(value || 0);
  const hours = Number.isFinite(parsed) ? parsed : 0;
  return {
    totalHours: hours,
    completedHours: completed ? hours : 0,
    remainingHours: completed ? 0 : hours
  };
}
