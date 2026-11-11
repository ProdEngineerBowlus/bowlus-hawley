// Production Simulation With Offset — Rev ANT.9 (FAB parity-only in Cycle 1 + CNC/Frame buckets VINless + script map)
// - Install line (A1/A2, B–H) writes VIN-linked Production records
// - Derived/support buckets (FAB-A/B, Frame-A/B, CNC-A/B) write Phase+Cycle only (NO VIN)
// - CNC legacy detailed phases (CNCF-*/CNCR-*), CNC1/2, and changeover (C#X) are DISABLED in Production
//   (VIN/model/flavor resolution is now strictly Task Instances)
//
// =========================
// KEY / SCRIPT MAP (use Ctrl+F on the SEARCH TAG)
// =========================
// [KEY-10]  CONFIG / CONSTANTS
// [KEY-80]  HELPERS + LOOKUP LOADERS
// [KEY-140] PHASE RESOLVERS (getPhaseDataCached / getPhaseDataGenericOnly)
// [KEY-260] CYCLE RESOLUTION (getCycleRecordId / buildCycleSequence)
// [KEY-340] RECORD WRITERS (createRecWithKnownPhase / createRec)
// [KEY-380] (LEGACY) MODEL DETECT / CNC HELPERS (kept for compatibility; unused)
// [KEY-470] runSim() MAIN LOOP START
// [KEY-560] FAB bucket emission        <<<< UPDATED (VINless; always emits)
// [KEY-610] A1/A2 emission
// [KEY-640] Frame bucket emission      <<<< UPDATED (Frame-A/Frame-B VINless)
// [KEY-670] Install B–H emission
// [KEY-700] CNC bucket emission        <<<< UPDATED (CNC-A/CNC-B VINless)
// [KEY-880] Entry / prompts

/**************** [KEY-10] CONFIG / CONSTANTS ****************/
const productionTable = base.getTable("Production");
const vinsTable       = base.getTable("VINs");
const phasesTable     = base.getTable("Phases");
const modelsTable     = base.getTable("Models");
const cyclesTable     = base.getTable("Cycles");

// If your generic phases are under a different model name, change this:
const CNC_OP_PHASE_MODEL = "Base Model";

// Optional console logs
const DEBUG = false;

// Writable Process Order on Production (must be a Number field; ignored if formula/lookup/rollup)
function getWritableNumberField(table, name) {
  try { const f = table.getField(name); return (f && f.type === "number") ? f : null; }
  catch { return null; }
}
const F_PROCESS_ORDER = getWritableNumberField(productionTable, "Process Order");

// Caches and state
let VINS_RECORDS = [];
let MODELS_QUERY = null;
let modelsIndex  = null;
let phaseCache   = {};
let allPhasesQuery = null;

// --- Legacy CNC constants (kept only so old helper functions don’t break if referenced elsewhere)
const MODEL_RIVET    = "Rivet";
const MODEL_FRONTIER = "Frontier";
const CNC_PREFIX_RIVET    = "CNCR";
const CNC_PREFIX_FRONTIER = "CNCF";
const ENABLE_LEGACY_CNCE_FALLBACK = false;
const LEGACY_MODEL_ENDLESS = "Endless Highways";
const LEGACY_PREFIX_ENDLESS = "CNCE";
const CNC_SUFFIX      = ["B","C","D","E"];
const SUFFIX_VARIANTS = { B:["","2"], C:["","1","3"], D:["","3"], E:["","1","3"] };
const CHANGEOVER_MAX  = 6;
const MONO_CNC_ANCHOR_LETTER = "C";

/**************** [KEY-80] HELPERS + LOOKUP LOADERS ****************/
function extractModelType(cell) {
  if (!cell) return null;
  if (Array.isArray(cell) && cell[0]?.name) return cell[0].name.trim();
  return String(cell).trim();
}
function findVinRecordByNumber(vn) {
  return VINS_RECORDS.find(r => Number(r.getCellValue("VIN")) === vn);
}
function arrIncludesId(list, id) {
  if (!Array.isArray(list)) return false;
  return list.some(x => x && x.id === id);
}
async function ensureLookupsLoaded() {
  if (!MODELS_QUERY) MODELS_QUERY = await modelsTable.selectRecordsAsync();
  if (!modelsIndex) {
    modelsIndex = {};
    for (const m of MODELS_QUERY.records) {
      modelsIndex[m.getCellValue("Name")] = m.id;
    }
  }
  if (!allPhasesQuery) {
    allPhasesQuery = await phasesTable.selectRecordsAsync({
      fields: ["Name","Model Type","Task Offset","Process Order"]
    });
  }
}

/**************** [KEY-140] PHASE RESOLVERS ****************/
// Flexible phase resolver: exact model -> Base Model -> no-model -> any
async function getPhaseDataCached(name, modelName) {
  await ensureLookupsLoaded();
  const key = `${name}|${modelName||"__null"}`;
  if (phaseCache[key]) return phaseCache[key];

  const candidates = allPhasesQuery.records.filter(r => r.getCellValue("Name") === name);
  let rec = null;

  const targetModelId = modelName ? modelsIndex[modelName] : null;
  const baseModelId   = modelsIndex[CNC_OP_PHASE_MODEL] || null;

  if (!rec && targetModelId) {
    rec = candidates.find(r => arrIncludesId(r.getCellValue("Model Type"), targetModelId));
  }
  if (!rec && baseModelId) {
    rec = candidates.find(r => arrIncludesId(r.getCellValue("Model Type"), baseModelId));
  }
  if (!rec) {
    rec = candidates.find(r => {
      const mt = r.getCellValue("Model Type");
      return !Array.isArray(mt) || mt.length === 0;
    });
  }
  if (!rec) rec = candidates[0] || null;

  const data = rec
    ? {
        id:     rec.id,
        offset: rec.getCellValue("Task Offset") || 0,
        order:  rec.getCellValue("Process Order") ?? null,
        modelFrom: (() => {
          const mt = rec.getCellValue("Model Type");
          if (Array.isArray(mt) && mt.length) return mt[0].name;
          return null;
        })()
      }
    : { id:null, offset:0, order:null, modelFrom:null };

  phaseCache[key] = data;
  return data;
}

// Strict generic resolver (kept for compatibility; not required for CNC-A/B buckets)
async function getPhaseDataGenericOnly(name) {
  await ensureLookupsLoaded();
  const key = `${name}|__generic_only`;
  if (phaseCache[key]) return phaseCache[key];

  const candidates = allPhasesQuery.records.filter(r => r.getCellValue("Name") === name);
  const baseModelId = modelsIndex[CNC_OP_PHASE_MODEL] || null;

  let rec = candidates.find(r => {
    const mt = r.getCellValue("Model Type");
    return !Array.isArray(mt) || mt.length === 0;
  });

  if (!rec && baseModelId) {
    rec = candidates.find(r => arrIncludesId(r.getCellValue("Model Type"), baseModelId));
  }

  if (!rec) {
    const empty = { id:null, offset:0, order:null, modelFrom:null };
    phaseCache[key] = empty;
    return empty;
  }

  const data = {
    id:     rec.id,
    offset: rec.getCellValue("Task Offset") || 0,
    order:  rec.getCellValue("Process Order") ?? null,
    modelFrom: (() => {
      const mt = rec.getCellValue("Model Type");
      if (Array.isArray(mt) && mt.length) return mt[0].name;
      return null;
    })()
  };
  phaseCache[key] = data;
  return data;
}

function computeFramePair(virtualCycle, nextVIN, lastPair) {
  if (virtualCycle % 2 === 1) {
    const pair = [nextVIN, nextVIN + 1];
    return { pair, nextVIN: nextVIN + 2, lastPair: pair };
  }
  if (!lastPair) {
    const pair = [nextVIN + 1, nextVIN];
    return { pair, nextVIN: nextVIN + 2, lastPair: pair };
  }
  return { pair: [lastPair[1], lastPair[0]], nextVIN, lastPair };
}

/**************** [KEY-260] CYCLE RESOLUTION ****************/
async function getCycleRecordId(num, year) {
  if (!Number.isInteger(year)) throw new Error(`Invalid cycle year: ${year}`);

  const all = await cyclesTable.selectRecordsAsync();
  const startY = new Date(year, 0, 1);
  const endY   = new Date(year + 1, 0, 1);

  const match = all.records.find(r => {
    const sd = r.getCellValue("Start Date");
    const ed = r.getCellValue("End Date");
    if (!sd || !ed) return false;

    const s = new Date(sd);
    const e = new Date(ed);

    return (
      r.getCellValue("Cycle Number") === num &&
      s < endY &&
      e > startY
    );
  });

  if (match) return match.id;

  throw new Error(`Cycle ${num} not found in ${year}. Populate the Cycles table before running the simulation.`);
}

async function getMaxCycleNumberForYear(year) {
  const all = await cyclesTable.selectRecordsAsync();
  const startY = new Date(year, 0, 1);
  const endY   = new Date(year + 1, 0, 1);

  let max = null;
  for (const r of all.records) {
    const sd = r.getCellValue("Start Date");
    const ed = r.getCellValue("End Date");
    const cn = r.getCellValue("Cycle Number");
    if (!sd || !ed || typeof cn !== "number") continue;

    const s = new Date(sd);
    const e = new Date(ed);
    if (s < endY && e > startY) {
      if (max == null || cn > max) max = cn;
    }
  }
  return max;
}

function inclusiveRange(a, b) {
  const out = [];
  for (let i=a; i<=b; i++) out.push(i);
  return out;
}

async function buildCycleSequence(startYear, startCycle, endYear, endCycle) {
  if (endYear < startYear) throw new Error(`End year ${endYear} is before start year ${startYear}.`);
  if (startYear === endYear && endCycle < startCycle) {
    throw new Error(`End cycle ${endCycle} is before start cycle ${startCycle} in ${startYear}.`);
  }

  const seq = [];

  if (startYear === endYear) {
    for (const c of inclusiveRange(startCycle, endCycle)) seq.push({ year:startYear, cycle:c });
    return seq;
  }

  const maxStart = await getMaxCycleNumberForYear(startYear);
  if (maxStart == null) throw new Error(`No cycles found for year ${startYear}.`);
  if (startCycle > maxStart) throw new Error(`Start cycle ${startCycle} exceeds max cycle ${maxStart} for ${startYear}.`);
  for (const c of inclusiveRange(startCycle, maxStart)) seq.push({ year:startYear, cycle:c });

  for (let y=startYear+1; y<=endYear-1; y++) {
    const maxY = await getMaxCycleNumberForYear(y);
    if (maxY == null) throw new Error(`No cycles found for year ${y}.`);
    for (const c of inclusiveRange(1, maxY)) seq.push({ year:y, cycle:c });
  }

  const maxEnd = await getMaxCycleNumberForYear(endYear);
  if (maxEnd == null) throw new Error(`No cycles found for year ${endYear}.`);
  if (endCycle > maxEnd) throw new Error(`End cycle ${endCycle} exceeds max cycle ${maxEnd} for ${endYear}.`);
  for (const c of inclusiveRange(1, endCycle)) seq.push({ year:endYear, cycle:c });

  return seq;
}

/**************** [KEY-340] RECORD WRITERS ****************/
async function createRecWithKnownPhase(vinIds, phaseId, order, cycleId) {
  if (!phaseId) return;

  const fields = {
    "Phase": [{id:phaseId}],
    "Cycle": [{id:cycleId}]
  };

  if (Array.isArray(vinIds) && vinIds.length) {
    fields["VIN"] = vinIds.map(id => ({id}));
  }

  if (F_PROCESS_ORDER && typeof order === "number") fields["Process Order"] = order;

  await productionTable.createRecordAsync(fields);
}

async function createRec(vinIds, phaseName, model, cycleId) {
  const { id:phaseId, order } = await getPhaseDataCached(phaseName, model);
  if (!phaseId) return;
  await createRecWithKnownPhase(vinIds || [], phaseId, order, cycleId);
}

async function updateNextCycleVin() {
  const prod = await productionTable.selectRecordsAsync({ fields:["VIN","Next Cycle VIN"] });
  for (const r of prod.records) {
    const link = r.getCellValue("VIN");
    if (!Array.isArray(link) || !link.length) continue; // derived phases skip
    const cvRec = VINS_RECORDS.find(v=>v.id===link[0].id);
    if (!cvRec) continue;
    const cv  = Number(cvRec.getCellValue("VIN"));
    const nxt = VINS_RECORDS.find(v=>Number(v.getCellValue("VIN"))===cv+1);
    if (nxt) await productionTable.updateRecordAsync(r.id, { "Next Cycle VIN":[{id:nxt.id}] });
  }
}

/**************** [KEY-380] (LEGACY) MODEL DETECT / CNC HELPERS ****************/
// Kept only for compatibility; CNC detailed emissions are disabled in this Rev.
// (If you want, we can delete this whole block later with confidence.)

/**************** [KEY-470] runSim() MAIN LOOP START ****************/
async function runSim(startVIN, startYear, startCycle, endYear, endCycle, startSet) {
  VINS_RECORDS = (await vinsTable.selectRecordsAsync()).records;
  MODELS_QUERY = await modelsTable.selectRecordsAsync();
  modelsIndex  = null; phaseCache = {}; allPhasesQuery = null;

  await ensureLookupsLoaded();

  const cycleSeq  = await buildCycleSequence(startYear, startCycle, endYear, endCycle);
  const numCycles = cycleSeq.length;

  // Virtual parity driver:
  // Set 1 => virtualCycle starts odd (1), Set 2 => starts even (2).
  const virtualStart = (startSet === 2) ? 2 : 1;

  // Frame pairs two cycles ahead using virtual parity
  let tmpNext = startVIN, tmpLast = null;
  const framePairs = {};
  for (let v = virtualStart; v < virtualStart + numCycles + 2; v++) {
    const res = computeFramePair(v, tmpNext, tmpLast);
    framePairs[v] = res.pair;
    tmpNext = res.nextVIN; tmpLast = res.lastPair;
  }

  const lettersArr = ["B","C","D","E","F","G","H"];

  for (let idx=0; idx<numCycles; idx++) {
    const { year:cycleYear, cycle:cycleLabel } = cycleSeq[idx];

    // This is the parity reference for all A/FAB/Frame/CNC buckets
    const virtualCycle = virtualStart + idx;

    const cycleId = await getCycleRecordId(cycleLabel, cycleYear);
    const pair    = framePairs[virtualCycle] || [];

    // letterBase: B -> pair[0]-2, C -> pair[0]-3, ...
    const letterBase = {};
    for (let i=0; i<lettersArr.length; i++) {
      letterBase[lettersArr[i]] = pair[0] - (i+2);
    }

    /************** [KEY-560] FAB BUCKET EMISSION (VINLESS; ALWAYS) **************/
    {
      const fabPhaseName = (virtualCycle % 2) ? "FAB-A" : "FAB-B";
      await createRec([], fabPhaseName, "Base Model", cycleId);
    }

    /************** [KEY-610] A1/A2 emission **************/
    {
      const aPhase = (virtualCycle % 2) ? "A1" : "A2";
      for (const vnum of pair) {
        const r = findVinRecordByNumber(vnum);
        if (r) await createRec([r.id], aPhase, extractModelType(r.getCellValue("Model Type")), cycleId);
      }
    }

    /************** [KEY-640] Frame BUCKET EMISSION (VINLESS) **************/
    {
      const phase = (virtualCycle % 2) ? "Frame-A" : "Frame-B";
      await createRec([], phase, "Base Model", cycleId);
    }

    /************** [KEY-670] Install B–H emission **************/
    for (let i=0; i<lettersArr.length; i++) {
      const lett = lettersArr[i];
      const vin  = letterBase[lett];
      const rec  = findVinRecordByNumber(vin);
      if (rec) await createRec([rec.id], lett, extractModelType(rec.getCellValue("Model Type")), cycleId);
    }

    /************** [KEY-700] CNC BUCKET EMISSION (VINLESS) **************/
    {
      const cncPhaseName = (virtualCycle % 2) ? "CNC-A" : "CNC-B";
      await createRec([], cncPhaseName, "Base Model", cycleId);
    }
  }

  await updateNextCycleVin();
}

/**************** [KEY-880] Entry / prompts ****************/
const startVIN   = parseInt(await input.textAsync("Starting VIN?"),10);

const startYear  = parseInt(await input.textAsync("Start Cycle Year? (e.g., 2025)"),10);
const startCycle = parseInt(await input.textAsync("Start Cycle Number? (e.g., 17)"),10);

const endYear    = parseInt(await input.textAsync("End Cycle Year? (e.g., 2026)"),10);
const endCycle   = parseInt(await input.textAsync("End Cycle Number? (e.g., 12)"),10);

// Parity selection: Set 1 = A1/FAB-A/Frame-A/CNC-A, Set 2 = A2/FAB-B/Frame-B/CNC-B
const startSetRaw = await input.textAsync('Start parity set? Type "1" (A1/FAB-A/Frame-A/CNC-A) or "2" (A2/FAB-B/Frame-B/CNC-B). Default 1.');
const startSet = (String(startSetRaw||"").trim() === "2") ? 2 : 1;

await runSim(startVIN, startYear, startCycle, endYear, endCycle, startSet);
output.text("Simulation complete.");
