(() => {
  const root = document.getElementById("beta-root");

  function localTodayIso() {
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  const params = new URLSearchParams(window.location.search);
  const initialView = params.get("view");
  const debugMode = params.get("debug") === "1" || params.get("debug") === "true";
  const validPhaseViews = new Set(["workers", "tasks", "worker", "transitions", "review"]);
  const today = localTodayIso();
  const standardDailyMinutes = 7.5 * 60;
  const defaultWorkSchedule = {
    workStart: "07:00",
    workEnd: "15:30",
    pauses: [{ label: "lunch", start: "11:00", end: "11:30" }],
  };
  const state = {
    date: params.get("date") || today,
    selectedPhase: params.get("phase") || "",
    phaseView: validPhaseViews.has(initialView) ? initialView : "workers",
    selectedWorker: params.get("worker") || "",
    selectedTransition: params.get("transition") || "",
    loading: true,
    error: "",
    health: null,
    sync: null,
    auth: null,
    assignments: null,
    utilization: null,
  };

  const fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatNumber(value, fallback = "--") {
    const number = Number(value);
    return Number.isFinite(number) ? fmt.format(number) : fallback;
  }

  function formatHours(value) {
    return `${formatNumber(value)}h`;
  }

  function formatMinutes(value) {
    const minutes = Number(value || 0);
    if (!minutes) return "0m";
    const hours = Math.floor(minutes / 60);
    const remainder = Math.round(minutes % 60);
    return hours ? `${hours}h ${remainder}m` : `${remainder}m`;
  }

  function formatPercent(value) {
    if (value === null || value === undefined || value === "") return "--";
    const number = Number(value);
    return Number.isFinite(number) ? `${formatNumber(number)}%` : "--";
  }

  function formatDateTime(value) {
    if (!value) return "--";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "--";
    return `${date.toLocaleDateString()} ${timeFmt.format(date)}`;
  }

  function formatClock(value) {
    if (!value) return "--";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "--";
    return timeFmt.format(date);
  }

  function dateAtClock(day, clock) {
    const [hour, minute] = String(clock || "00:00").split(":").map((part) => Number(part));
    const date = new Date(day);
    date.setHours(Number.isFinite(hour) ? hour : 0, Number.isFinite(minute) ? minute : 0, 0, 0);
    return date;
  }

  function scheduledWorkMinutesBetween(startDate, endDate, schedule = defaultWorkSchedule) {
    if (!(startDate instanceof Date) || !(endDate instanceof Date) || endDate <= startDate) return 0;

    let windows = [{
      start: dateAtClock(startDate, schedule.workStart || defaultWorkSchedule.workStart),
      end: dateAtClock(startDate, schedule.workEnd || defaultWorkSchedule.workEnd),
    }];

    const pauses = Array.isArray(schedule.pauses) ? schedule.pauses : defaultWorkSchedule.pauses;
    for (const pause of pauses) {
      const pauseStart = dateAtClock(startDate, pause.start);
      const pauseEnd = dateAtClock(startDate, pause.end);
      const nextWindows = [];

      for (const window of windows) {
        if (pauseEnd <= window.start || pauseStart >= window.end) {
          nextWindows.push(window);
          continue;
        }
        if (pauseStart > window.start) nextWindows.push({ start: window.start, end: pauseStart });
        if (pauseEnd < window.end) nextWindows.push({ start: pauseEnd, end: window.end });
      }

      windows = nextWindows;
    }

    return windows.reduce((sum, window) => {
      const windowStart = new Date(Math.max(window.start.getTime(), startDate.getTime()));
      const windowEnd = new Date(Math.min(window.end.getTime(), endDate.getTime()));
      if (windowEnd <= windowStart) return sum;
      return sum + Math.floor((windowEnd.getTime() - windowStart.getTime()) / 60000);
    }, 0);
  }

  function elapsedWorkerCapacityMinutes(isoDate = state.date) {
    const dateKey = isoDate || today;
    const day = new Date(`${dateKey}T00:00:00`);
    if (Number.isNaN(day.getTime())) return 0;
    if (dateKey > today) return 0;
    if (dateKey < today) return standardDailyMinutes;

    const start = dateAtClock(day, defaultWorkSchedule.workStart);
    const end = dateAtClock(day, defaultWorkSchedule.workEnd);
    const cutoff = new Date(Math.min(Date.now(), end.getTime()));
    return Math.min(standardDailyMinutes, scheduledWorkMinutesBetween(start, cutoff));
  }

  function utilizationPercent(actualMinutes, workerCount = 1) {
    const workersInScope = Math.max(1, Number(workerCount || 0));
    const denominator = elapsedWorkerCapacityMinutes() * workersInScope;
    if (!denominator) return null;
    return Math.min(100, Math.round((Number(actualMinutes || 0) / denominator) * 100));
  }

  async function fetchJson(url) {
    const response = await fetch(url, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || payload.message || `Request failed: ${response.status}`);
    }
    return payload;
  }

  async function postJson(url, payload) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || body.message || `Request failed: ${response.status}`);
    }
    return body;
  }

  function updateUrl() {
    const url = new URL(window.location.href);
    url.searchParams.set("date", state.date);
    if (state.selectedPhase) {
      url.searchParams.set("phase", state.selectedPhase);
      if (state.phaseView && state.phaseView !== "workers") {
        url.searchParams.set("view", state.phaseView);
      } else {
        url.searchParams.delete("view");
      }
      if (state.phaseView === "worker" && state.selectedWorker) {
        url.searchParams.set("worker", state.selectedWorker);
      } else {
        url.searchParams.delete("worker");
      }
      if (state.selectedTransition) {
        url.searchParams.set("transition", state.selectedTransition);
      } else {
        url.searchParams.delete("transition");
      }
    } else {
      url.searchParams.delete("phase");
      url.searchParams.delete("view");
      url.searchParams.delete("worker");
      url.searchParams.delete("transition");
    }
    window.history.replaceState({}, "", url);
  }

  function setDate(nextDate) {
    state.date = nextDate || today;
    state.selectedPhase = "";
    state.phaseView = "workers";
    state.selectedWorker = "";
    state.selectedTransition = "";
    updateUrl();
    load();
  }

  function setPhase(phaseKey) {
    state.selectedPhase = phaseKey || "";
    state.phaseView = "workers";
    state.selectedWorker = "";
    state.selectedTransition = "";
    updateUrl();
    render();
  }

  function setPhaseView(view) {
    state.phaseView = view || "workers";
    if (state.phaseView !== "worker") state.selectedWorker = "";
    if (state.phaseView !== "review" && state.phaseView !== "transitions") state.selectedTransition = "";
    updateUrl();
    render();
  }

  function setWorker(workerKey) {
    state.phaseView = "worker";
    state.selectedWorker = workerKey || "";
    state.selectedTransition = "";
    updateUrl();
    render();
  }

  function setTransition(transitionId) {
    state.selectedTransition = transitionId ? String(transitionId) : "";
    updateUrl();
    render();
  }

  async function load() {
    state.loading = true;
    state.error = "";
    render();

    const stamp = Date.now();
    try {
      const [health, sync, auth, assignments, utilization] = await Promise.all([
        fetchJson(`/api/health?_=${stamp}`),
        fetchJson(`/api/sync-status?_=${stamp}`),
        fetchJson(`/api/auth-status?_=${stamp}`),
        fetchJson(`/api/daily-assignments?date=${encodeURIComponent(state.date)}&includeNoWork=true&_=${stamp}`),
        fetchJson(`/api/utilization-report?date=${encodeURIComponent(state.date)}&_=${stamp}`),
      ]);
      state.health = health;
      state.sync = sync;
      state.auth = auth;
      state.assignments = assignments;
      state.utilization = utilization;
      const matchedPhase = selectedPhaseRow();
      if (state.selectedPhase && !matchedPhase) state.selectedPhase = "";
      if (matchedPhase && state.selectedPhase !== matchedPhase.phaseKey) state.selectedPhase = matchedPhase.phaseKey;
      if (!state.selectedPhase) {
        state.phaseView = "workers";
        state.selectedWorker = "";
        state.selectedTransition = "";
      } else if (state.phaseView === "worker" && !selectedPhaseWorkerRow()) {
        state.phaseView = "workers";
        state.selectedWorker = "";
        state.selectedTransition = "";
      }
      updateUrl();
    } catch (error) {
      state.error = error.message || "Could not load line view.";
    } finally {
      state.loading = false;
      render();
    }
  }

  function taskActualToday(task) {
    return Number(task.actualTimeOnDateMinutes || 0);
  }

  function taskHours(task) {
    return Number(task.assignedHours || task.estimatedHours || 0);
  }

  function taskWorkerHistoryMinutes(task) {
    return Number(task.actualTimeAllDatesMinutes || task.actualHistory?.totalMinutes || 0);
  }

  function taskTeamHistoryMinutes(task) {
    return Number(task.teamActualTimeAllDatesMinutes || task.teamActualHistory?.totalMinutes || 0);
  }

  function historyRange(task, scope = "worker") {
    const history = scope === "team" ? task.teamActualHistory : task.actualHistory;
    const coverage = scope === "team" ? task.teamActualHistoryCoverage : task.actualHistoryCoverage;
    if (coverage) return coverage;
    const dates = Array.isArray(history?.dates) ? history.dates : [];
    if (!dates.length) return "";
    const first = dates[0]?.date || "";
    const last = dates[dates.length - 1]?.date || "";
    return first && last && first !== last ? `${first} to ${last}` : first;
  }

  function workers() {
    return Array.isArray(state.assignments?.workers) ? state.assignments.workers : [];
  }

  function utilization() {
    return state.utilization || {};
  }

  function normalizeKey(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  }

  function phaseKeyMatches(left, right) {
    return Boolean(left || right) && canonicalPhaseKeyForValue(left) === canonicalPhaseKeyForValue(right);
  }

  function workerKeyMatches(left, right) {
    return Boolean(left || right) && normalizeKey(left) === normalizeKey(right);
  }

  function reportPhases() {
    return Array.isArray(utilization().phases) ? utilization().phases : [];
  }

  function reportWorkerPhases() {
    return Array.isArray(utilization().workerPhases) ? utilization().workerPhases : [];
  }

  function reportTransitions() {
    return Array.isArray(utilization().transitions) ? utilization().transitions : [];
  }

  function reportCategories() {
    return Array.isArray(utilization().categories) ? utilization().categories : [];
  }

  function reviewControlsEnabled() {
    return Boolean(state.auth?.managerControlEnabled && utilization().reviewControlsEnabled);
  }

  function transitionsForScope(phaseKey = "", workerKey = "", reviewOnly = false) {
    return reportTransitions().filter((transition) => {
      const phaseMatch = !phaseKey || phaseKeyMatches(transition.phaseKey, phaseKey) || phaseKeyMatches(transition.phaseSlug, phaseKey);
      const workerMatch = !workerKey || workerKeyMatches(transition.workerKey, workerKey) || workerKeyMatches(transition.workerSlug, workerKey);
      const reviewMatch = !reviewOnly || (transition.reviewRequired && !transition.reviewedAt);
      return phaseMatch && workerMatch && reviewMatch;
    });
  }

  function selectedTransitionRow(phaseKey = "", workerKey = "") {
    if (!state.selectedTransition) return null;
    return transitionsForScope(phaseKey, workerKey).find((transition) => String(transition.transitionEventId) === String(state.selectedTransition)) || null;
  }

  function transitionStats(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const taskSwitchCount = list.filter((row) =>
      row.previousTaskGid &&
      row.nextTaskGid &&
      String(row.previousTaskGid) !== String(row.nextTaskGid)
    ).length;
    return {
      transitionCount: list.length,
      taskSwitchCount,
      handoffGapCount: list.filter((row) => row.previousTaskCompleted || String(row.previousTaskGid || "") !== String(row.nextTaskGid || "")).length,
      totalTransitionMinutes: list.reduce((sum, row) => sum + Number(row.rawGapMinutes || 0), 0),
      excessTransitionMinutes: list.reduce((sum, row) => sum + Number(row.excessGapMinutes || 0), 0),
      reviewRequiredCount: list.filter((row) => row.reviewRequired).length,
      unreviewedTransitionCount: list.filter((row) => row.reviewRequired && !row.reviewedAt).length,
    };
  }

  const phaseAliasGroups = [
    {
      key: "fab_1_3",
      display: "FAB 1-3",
      aliases: ["fab_1_3", "fab_a", "fab_b", "fab", "fabrication", "fab13", "fab1-3", "fab1 3"],
    },
    {
      key: "frames_phase_a",
      display: "Frames / Phase A",
      aliases: ["frames_phase_a", "frame_a", "frame-a", "frames", "framesphasea", "frames phase a", "frames/phasea"],
    },
  ];

  function phaseNameForTask(task) {
    return task.workArea || task.phase || task.phaseBucket || "Unspecified";
  }

  function phaseAliasToken(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/&/g, "and")
      .replace(/[^a-z0-9]+/g, "");
  }

  function canonicalPhaseKeyForValue(value) {
    const token = phaseAliasToken(value);
    if (!token) return normalizeKey(value);
    for (const group of phaseAliasGroups) {
      const aliases = new Set([group.key, group.display, ...group.aliases].map(phaseAliasToken));
      if (aliases.has(token)) return group.key;
    }
    return normalizeKey(value);
  }

  function canonicalPhaseForValues(phase, rawKey = "") {
    const safePhase = phase || "Unspecified";
    const safeRawKey = rawKey || phaseKeyForName(safePhase);
    const tokens = new Set([
      phaseAliasToken(safeRawKey),
      phaseAliasToken(safePhase),
    ].filter(Boolean));

    for (const group of phaseAliasGroups) {
      const aliases = new Set([group.key, group.display, ...group.aliases].map(phaseAliasToken));
      for (const token of tokens) {
        if (aliases.has(token)) {
          return {
            phase: group.display,
            phaseKey: group.key,
            rawPhase: safePhase,
            rawPhaseKey: safeRawKey,
          };
        }
      }
    }

    return {
      phase: safePhase,
      phaseKey: phaseKeyForName(safePhase),
      rawPhase: safePhase,
      rawPhaseKey: safeRawKey,
    };
  }

  function canonicalPhaseForTask(task) {
    const phase = phaseNameForTask(task);
    const rawKey = task.workAreaKey || phaseKeyForName(phase);
    const taskInfo = canonicalPhaseForValues(phase, rawKey);
    const extraTokens = [
      task.phase,
      task.phaseBucket,
    ].filter(Boolean);

    if (taskInfo.phaseKey !== phaseKeyForName(phase)) return taskInfo;
    for (const value of extraTokens) {
      const extraInfo = canonicalPhaseForValues(value, value);
      if (extraInfo.phaseKey !== phaseKeyForName(value)) {
        return {
          ...extraInfo,
          rawPhase: phase,
          rawPhaseKey: rawKey,
        };
      }
    }
    return taskInfo;
  }

  function phaseKeyForName(name) {
    return String(name || "Unspecified")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unspecified";
  }

  function workerKeyForWorker(worker) {
    return phaseKeyForName(worker.id || worker.email || worker.name || "unknown-worker");
  }

  function taskPhaseKey(task) {
    return canonicalPhaseForTask(task).phaseKey;
  }

  function tasksForWorker(worker, phaseKey = "") {
    const tasks = Array.isArray(worker.tasks) ? worker.tasks : [];
    if (!phaseKey) return tasks;
    return tasks.filter((task) => phaseKeyMatches(taskPhaseKey(task), phaseKey));
  }

  function phaseRows() {
    const rows = new Map();
    for (const worker of workers()) {
      for (const task of worker.tasks || []) {
        const phaseInfo = canonicalPhaseForTask(task);
        const { phase, phaseKey } = phaseInfo;
        if (!rows.has(phaseKey)) {
          rows.set(phaseKey, {
            phaseKey,
            phase,
            rawPhaseNames: new Set(),
            rawPhaseKeys: new Set(),
            taskCount: 0,
            completedTaskCount: 0,
            assignedHours: 0,
            completedHours: 0,
            actualMinutes: 0,
            workerIds: new Set(),
            openTaskCount: 0,
          });
        }
        const row = rows.get(phaseKey);
        if (phaseInfo.rawPhase) row.rawPhaseNames.add(phaseInfo.rawPhase);
        if (phaseInfo.rawPhaseKey) row.rawPhaseKeys.add(phaseInfo.rawPhaseKey);
        row.taskCount += 1;
        row.completedTaskCount += task.completed ? 1 : 0;
        row.assignedHours += taskHours(task);
        row.completedHours += task.completed ? taskHours(task) : 0;
        row.actualMinutes += taskActualToday(task);
        row.openTaskCount += task.completed ? 0 : 1;
        row.workerIds.add(worker.id || worker.email || worker.name);
      }
    }

    for (const reportPhase of reportPhases()) {
      const matchingKey = Array.from(rows.keys()).find((key) =>
        phaseKeyMatches(key, reportPhase.phaseKey) ||
        phaseKeyMatches(key, reportPhase.phaseSlug) ||
        phaseKeyMatches(key, reportPhase.phaseName)
      );
      const key = matchingKey || reportPhase.phaseKey || reportPhase.phaseSlug || phaseKeyForName(reportPhase.phaseName);
      if (!rows.has(key)) {
        rows.set(key, {
          phaseKey: key,
          phase: reportPhase.phaseName || reportPhase.phaseKey || "Unspecified",
          rawPhaseNames: new Set(),
          rawPhaseKeys: new Set(),
          taskCount: Number(reportPhase.assignedTaskCount || 0),
          completedTaskCount: Number(reportPhase.completedTaskCount || 0),
          assignedHours: Number(reportPhase.totalEstimatedMinutes || 0) / 60,
          completedHours: 0,
          actualMinutes: Number(reportPhase.totalActualTaskMinutes || 0),
          workerIds: new Set(),
          openTaskCount: Math.max(0, Number(reportPhase.assignedTaskCount || 0) - Number(reportPhase.completedTaskCount || 0)),
        });
      }
    }

    return Array.from(rows.values())
      .map((row) => {
        const transitions = transitionsForScope(row.phaseKey);
        const stats = transitionStats(transitions);
        const reportPhase = reportPhases().find((item) =>
          phaseKeyMatches(item.phaseKey, row.phaseKey) ||
          phaseKeyMatches(item.phaseSlug, row.phaseKey) ||
          phaseKeyMatches(item.phaseName, row.phase)
        );
        const reportActualMinutes = Number(reportPhase?.totalActualTaskMinutes || 0);
        const reportEstimatedMinutes = Number(reportPhase?.totalEstimatedMinutes || 0);
        const reportTaskCount = Number(reportPhase?.assignedTaskCount || 0);
        const reportCompletedTaskCount = Number(reportPhase?.completedTaskCount || 0);
        const taskCount = row.taskCount || reportTaskCount;
        const completedTaskCount = row.taskCount ? row.completedTaskCount : reportCompletedTaskCount;
        const assignedHours = row.taskCount ? row.assignedHours : reportEstimatedMinutes / 60;
        const actualMinutes = row.actualMinutes || reportActualMinutes;
        const openTaskCount = row.taskCount
          ? row.openTaskCount
          : Math.max(0, reportTaskCount - reportCompletedTaskCount);
        const workerCount = Math.max(
          row.workerIds.size,
          Number(reportPhase?.workerCount || 0),
          Number(reportPhase?.assignedWorkerCount || 0)
        );
        const reportCompletion = reportPhase?.assignedVsCompletedPercent;
        const reportEfficiency = reportPhase?.efficiencyPercent;
        const taskPacePercent = actualMinutes ? Math.round((assignedHours * 60 / actualMinutes) * 100) : reportEfficiency ?? null;
        return {
          ...row,
          phase: row.phase || reportPhase?.phaseName || "Unspecified",
          taskCount,
          completedTaskCount,
          assignedHours,
          actualMinutes,
          openTaskCount,
          workerCount,
          rawPhaseNames: Array.from(row.rawPhaseNames).sort(),
          rawPhaseKeys: Array.from(row.rawPhaseKeys).sort(),
          completionPercent: taskCount ? Math.round((completedTaskCount / taskCount) * 100) : Number(reportCompletion || 0),
          efficiencyPercent: taskPacePercent,
          taskPacePercent,
          utilizationPercent: utilizationPercent(actualMinutes, workerCount),
          transitionStats: stats,
          transitionMinutes: stats.totalTransitionMinutes,
          reviewFlags: stats.unreviewedTransitionCount,
          taskSwitches: stats.taskSwitchCount,
        };
      })
      .sort((a, b) => b.assignedHours - a.assignedHours || a.phase.localeCompare(b.phase));
  }

  function selectedPhaseRow() {
    return phaseRows().find((row) => phaseKeyMatches(row.phaseKey, state.selectedPhase)) || null;
  }

  function lineViewMetrics() {
    const rows = phaseRows();
    const line = state.assignments?.lineOverview || {};
    const signals = state.assignments?.managerSignals || {};
    if (!rows.length) {
      const workerCount = Number(signals.workersWithWork || signals.workerCount || workers().length || 0);
      const actualMinutes = Number(signals.actualTimeLoggedMinutes || 0);
      return {
        assignedHours: Number(line.assignedHours || 0),
        completedHours: Number(line.completedHours || 0),
        remainingHours: Number(line.remainingHours || 0),
        taskCount: Number(line.taskCount || 0),
        completedTaskCount: Number(line.completedTaskCount || 0),
        openTaskCount: Number(signals.openTaskCount || signals.openTasks || 0),
        actualMinutes,
        workerCount,
        utilizationPercent: utilizationPercent(actualMinutes, workerCount || 1),
      };
    }

    const assignedHours = rows.reduce((sum, row) => sum + Number(row.assignedHours || 0), 0);
    const completedHours = rows.reduce((sum, row) => sum + Number(row.completedHours || 0), 0);
    const taskCount = rows.reduce((sum, row) => sum + Number(row.taskCount || 0), 0);
    const completedTaskCount = rows.reduce((sum, row) => sum + Number(row.completedTaskCount || 0), 0);
    const openTaskCount = rows.reduce((sum, row) => sum + Number(row.openTaskCount || 0), 0);
    const actualMinutes = rows.reduce((sum, row) => sum + Number(row.actualMinutes || 0), 0);
    const workerCount = Number(signals.workersWithWork || 0) || new Set(
      workers()
        .filter((worker) => Number(worker.actualTimeLoggedMinutes || 0) > 0 || (worker.tasks || []).length > 0)
        .map((worker) => worker.id || worker.email || worker.name)
        .filter(Boolean)
    ).size;

    return {
      assignedHours,
      completedHours,
      remainingHours: Math.max(0, assignedHours - completedHours),
      taskCount,
      completedTaskCount,
      openTaskCount,
      actualMinutes,
      workerCount,
      utilizationPercent: utilizationPercent(actualMinutes, workerCount || 1),
    };
  }

  function selectedPhaseWorkerRow() {
    if (!state.selectedWorker) return null;
    return phaseWorkerRows(state.selectedPhase).find((row) => row.workerKey === state.selectedWorker) || null;
  }

  function phaseLabelForTasks(tasks, fallbackPhaseKey = "") {
    const labels = Array.from(new Set(
      (tasks || []).map((task) => canonicalPhaseForTask(task).phase).filter(Boolean)
    )).sort();
    if (labels.length) return labels.join(", ");
    return phaseRows().find((row) => row.phaseKey === fallbackPhaseKey)?.phase || "Phase work";
  }

  function phaseWorkerRows(phaseKey) {
    return workers()
      .map((worker) => {
        const tasks = tasksForWorker(worker, phaseKey);
        const actualMinutes = tasks.reduce((sum, task) => sum + taskActualToday(task), 0);
        const assignedHours = tasks.reduce((sum, task) => sum + taskHours(task), 0);
        const completedTaskCount = tasks.filter((task) => task.completed).length;
        const completedHours = tasks.reduce((sum, task) => sum + (task.completed ? taskHours(task) : 0), 0);
        const taskPacePercent = actualMinutes ? Math.round((assignedHours * 60 / actualMinutes) * 100) : null;
        return {
          id: worker.id,
          workerKey: workerKeyForWorker(worker),
          name: worker.name || worker.email || "Unknown worker",
          role: phaseLabelForTasks(tasks, phaseKey),
          homeRole: worker.phase || worker.workArea || "",
          taskCount: tasks.length,
          completedTaskCount,
          openTasks: tasks.length - completedTaskCount,
          assignedHours,
          completedHours,
          actualMinutes,
          completionPercent: tasks.length ? Math.round((completedTaskCount / tasks.length) * 100) : 0,
          efficiencyPercent: taskPacePercent,
          taskPacePercent,
          utilizationPercent: utilizationPercent(actualMinutes, 1),
          liveWriteEnabled: Boolean(worker.liveWriteEnabled),
          transitionStats: transitionStats(transitionsForScope(phaseKey, workerKeyForWorker(worker))),
        };
      })
      .filter((row) => row.taskCount > 0 || row.actualMinutes > 0)
      .sort((a, b) => b.actualMinutes - a.actualMinutes || b.assignedHours - a.assignedHours || a.name.localeCompare(b.name));
  }

  function phaseTaskRows(phaseKey, workerKey = "") {
    const rows = [];
    for (const worker of workers()) {
      if (workerKey && workerKeyForWorker(worker) !== workerKey) continue;
      for (const task of tasksForWorker(worker, phaseKey)) {
        const assignedHours = taskHours(task);
        const actualMinutes = taskActualToday(task);
        rows.push({
          workerName: worker.name || worker.email || "Unknown worker",
          taskName: task.name || task.taskName || task.title || "Untitled task",
          sourceTaskGid: task.sourceTaskGid || task.gid || task.taskGid || task.asanaTaskGid || task.id || "",
          vin: task.vin || task.vinNumber || task.trailerVin || "",
          assignedHours,
          actualMinutes,
          completed: Boolean(task.completed),
          workerHistoryMinutes: taskWorkerHistoryMinutes(task),
          teamHistoryMinutes: taskTeamHistoryMinutes(task),
          workerHistoryDateCount: Number(task.actualHistoryDateCount || task.actualHistory?.dateCount || 0),
          teamHistoryDateCount: Number(task.teamActualHistoryDateCount || task.teamActualHistory?.dateCount || 0),
          teamWorkerCount: Number(task.teamActualWorkerCount || task.teamActualHistory?.workerCount || 0),
          workerHistoryRange: historyRange(task, "worker"),
          teamHistoryRange: historyRange(task, "team"),
          updatedAt: task.modifiedAt || task.updatedAt || task.completedAt || "",
        });
      }
    }
    return rows.sort((a, b) => b.actualMinutes - a.actualMinutes || a.taskName.localeCompare(b.taskName));
  }

  function taskScopeSummary(phaseKey, workerKey = "") {
    const rows = phaseTaskRows(phaseKey, workerKey);
    const workerNames = new Set(rows.map((row) => row.workerName));
    const completedTaskCount = rows.filter((row) => row.completed).length;
    const assignedHours = rows.reduce((sum, row) => sum + row.assignedHours, 0);
    const actualMinutes = rows.reduce((sum, row) => sum + row.actualMinutes, 0);
    const workerHistoryMinutes = rows.reduce((sum, row) => sum + row.workerHistoryMinutes, 0);
    const teamHistoryByTask = new Map();
    for (const row of rows) {
      if (!row.sourceTaskGid) continue;
      teamHistoryByTask.set(row.sourceTaskGid, Math.max(teamHistoryByTask.get(row.sourceTaskGid) || 0, row.teamHistoryMinutes));
    }
    const teamHistoryMinutes = Array.from(teamHistoryByTask.values()).reduce((sum, minutes) => sum + minutes, 0);
    return {
      taskCount: rows.length,
      completedTaskCount,
      openTaskCount: rows.length - completedTaskCount,
      assignedHours,
      actualMinutes,
      workerHistoryMinutes,
      teamHistoryMinutes,
      workerCount: workerNames.size,
      completionPercent: rows.length ? Math.round((completedTaskCount / rows.length) * 100) : 0,
    };
  }

  function metric(label, value, detail = "") {
    return `
      <div class="metric">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
        ${detail ? `<small>${escapeHtml(detail)}</small>` : ""}
      </div>
    `;
  }

  function statusPill(label, level = "ok") {
    return `<span class="pill ${escapeHtml(level)}">${escapeHtml(label)}</span>`;
  }

  function renderTopbar() {
    return `
      <header class="beta-topbar">
        <div class="brand">
          <div class="brand-mark">HB</div>
          <div>
            <h1>Hawley Line View</h1>
            <p>Task-safe production line reporting</p>
          </div>
        </div>
        <div class="top-actions">
          <input class="date-control" type="date" value="${escapeHtml(state.date)}" data-action="date" />
          <button class="btn primary" type="button" data-action="reload">Reload</button>
          <a class="btn" href="/">Live app</a>
        </div>
      </header>
    `;
  }

  function renderStatusStrip() {
    const line = state.assignments?.lineOverview || {};
    const signals = state.assignments?.managerSignals || {};
    const syncRuns = state.sync?.latestRuns || {};
    const writeMode = state.auth?.workerWritesEnabled ? "Live writes enabled on main app" : "Main app read-only";
    const visibleLine = lineViewMetrics();

    return `
      <section class="status-strip">
        ${metric("Cycle", line.cycle || "Current", `${formatNumber(visibleLine.completedTaskCount)}/${formatNumber(visibleLine.taskCount)} tasks complete`)}
        ${metric("Assigned", formatHours(visibleLine.assignedHours), `${formatHours(visibleLine.remainingHours)} remaining`)}
        ${metric("Actual today", formatMinutes(visibleLine.actualMinutes), "from worker actual ledger")}
        ${metric("Sync", syncRuns.pull_asana_events?.status || state.sync?.watcher?.lastStatus || "unknown", formatDateTime(syncRuns.pull_asana_events?.ended_at || state.sync?.refreshedAt))}
        <div class="metric">
          <span>Write safety</span>
          <strong>${statusPill("No task controls", "ok")}</strong>
          <small>${escapeHtml(reviewControlsEnabled() ? "Transition reviews write only to Hawley" : writeMode)}</small>
        </div>
        ${metric("Workers", formatNumber(signals.workerCount || workers().length), `${formatNumber(signals.workersWithWork || 0)} with work`)}
        ${metric("Open tasks", formatNumber(visibleLine.openTaskCount), "visible line rows")}
        ${metric("Line utilization", formatPercent(visibleLine.utilizationPercent), `${formatNumber(visibleLine.workerCount)} workers elapsed`)}
      </section>
    `;
  }

  function renderPhaseCards() {
    const rows = phaseRows();
    if (!rows.length) return `<div class="empty">No phase rows for ${escapeHtml(state.date)}.</div>`;
    return rows.map((row) => `
      <button class="phase-card" type="button" data-action="select-phase" data-phase-key="${escapeHtml(row.phaseKey)}">
        <div class="row-main">
          <strong>${escapeHtml(row.phase)}</strong>
          <small>${formatNumber(row.workerCount)} workers active${row.rawPhaseNames.length > 1 ? ` - ${formatNumber(row.rawPhaseNames.length)} labels merged` : ""}</small>
        </div>
        <div class="row-stat"><span>Actual</span><strong>${formatMinutes(row.actualMinutes)}</strong></div>
        <div class="row-stat"><span>Assigned</span><strong>${formatHours(row.assignedHours)}</strong></div>
        <div class="row-stat"><span>Tasks</span><strong>${formatNumber(row.completedTaskCount)}/${formatNumber(row.taskCount)}</strong></div>
        <div class="row-stat"><span>Complete</span><strong>${formatPercent(row.completionPercent)}</strong></div>
        <div class="row-stat"><span>Utilization</span><strong>${formatPercent(row.utilizationPercent)}</strong></div>
        <div class="row-stat"><span>Open</span><strong>${formatNumber(row.openTaskCount)}</strong></div>
      </button>
    `).join("");
  }

  function renderPhaseWorkers(phaseKey) {
    const rows = phaseWorkerRows(phaseKey);
    if (!rows.length) return `<div class="empty">No worker activity is attached to this phase for ${escapeHtml(state.date)}.</div>`;
    return rows.map((row) => `
      <button class="worker-row phase-worker-row worker-button" type="button" data-action="select-worker" data-worker-key="${escapeHtml(row.workerKey)}">
        <div class="row-main">
          <strong>${escapeHtml(row.name)}</strong>
          <small>${escapeHtml(row.role || "Phase worker")}</small>
        </div>
        <div class="row-stat"><span>Actual</span><strong>${formatMinutes(row.actualMinutes)}</strong></div>
        <div class="row-stat"><span>Assigned</span><strong>${formatHours(row.assignedHours)}</strong></div>
        <div class="row-stat"><span>Tasks</span><strong>${formatNumber(row.completedTaskCount)}/${formatNumber(row.taskCount)}</strong></div>
        <div class="row-stat"><span>Complete</span><strong>${formatPercent(row.completionPercent)}</strong></div>
        <div class="row-stat"><span>Utilization</span><strong>${formatPercent(row.utilizationPercent)}</strong></div>
        <div class="row-stat"><span>Open</span><strong>${formatNumber(row.openTasks)}</strong></div>
      </button>
    `).join("");
  }

  function renderPhaseTasks(phaseKey, workerKey = "") {
    const rows = phaseTaskRows(phaseKey, workerKey);
    if (!rows.length) return `<div class="empty">No task detail is attached to this phase for ${escapeHtml(state.date)}.</div>`;
    return rows.map((row) => {
      const isTeamTask = row.teamWorkerCount > 1;
      return `
      <div class="task-row ${isTeamTask ? "team-task" : ""}">
        <div class="row-main">
          <div class="task-title-line">
            <strong>${escapeHtml(row.taskName)}</strong>
            ${isTeamTask ? `<span class="team-badge" title="${escapeHtml(`${formatNumber(row.teamWorkerCount)} workers on task`)}">${escapeHtml(formatNumber(row.teamWorkerCount))}</span>` : ""}
          </div>
        </div>
        <div class="row-stat"><span>Actual today</span><strong>${formatMinutes(row.actualMinutes)}</strong></div>
        <div class="row-stat"><span>Worker total</span><strong>${formatMinutes(row.workerHistoryMinutes)}</strong></div>
        <div class="row-stat"><span>${isTeamTask ? "Team total" : "Task total"}</span><strong>${formatMinutes(row.teamHistoryMinutes)}</strong></div>
        <div class="row-stat"><span>Task estimate</span><strong>${formatHours(row.assignedHours)}</strong></div>
        <div class="row-stat"><span>Status</span><strong>${row.completed ? "Complete" : "Open"}</strong></div>
      </div>
    `;
    }).join("");
  }

  function transitionTitle(row) {
    const previous = row.previousTaskName || row.previousTaskGid || "Previous task";
    const next = row.nextTaskName || row.nextTaskGid || "Next task";
    return `${previous} -> ${next}`;
  }

  function renderTransitionReviewControls(row) {
    if (!row) return "";
    if (!reviewControlsEnabled()) {
      return `
        <div class="review-drawer">
          <strong>Review controls hidden</strong>
          <p>Manager review writes are not enabled for this app session.</p>
        </div>
      `;
    }

    const categories = reportCategories().filter((category) => category.managerSelectable);
    if (!categories.length) {
      return `
        <div class="review-drawer">
          <strong>No review categories loaded</strong>
          <p>Run Hawley migrations if this remains empty.</p>
        </div>
      `;
    }

    return `
      <div class="review-drawer" data-transition-review="${escapeHtml(row.transitionEventId)}">
        <div>
          <strong>Classify transition gap</strong>
          <p>${escapeHtml(formatMinutes(row.rawGapMinutes))} gap - ${escapeHtml(row.gapBucketName || "Unbucketed")} - ${escapeHtml(row.workerName || "Worker")}</p>
        </div>
        <textarea class="review-notes" rows="3" placeholder="Optional manager note" data-review-notes="${escapeHtml(row.transitionEventId)}">${escapeHtml(row.managerNotes || "")}</textarea>
        <div class="category-grid">
          ${categories.map((category) => `
            <button class="category-button${row.managerCategory === category.categoryKey ? " active" : ""}" type="button" data-action="save-transition-review" data-transition-id="${escapeHtml(row.transitionEventId)}" data-category-key="${escapeHtml(category.categoryKey)}">
              <span>${escapeHtml(category.displayName)}</span>
              <small>${escapeHtml(category.categoryGroup.replace(/_/g, " "))}</small>
            </button>
          `).join("")}
        </div>
      </div>
    `;
  }

  function renderTransitionRows(phaseKey, workerKey = "", reviewOnly = false) {
    const rows = transitionsForScope(phaseKey, workerKey, reviewOnly);
    if (!rows.length) {
      return `<div class="empty">No recorded transition gaps for this scope yet. New start/stop/switch activity will populate this ledger from here forward.</div>`;
    }

    return rows.map((row) => {
      const selected = String(row.transitionEventId) === String(state.selectedTransition);
      const reviewed = Boolean(row.reviewedAt);
      return `
        <div class="transition-row${selected ? " selected" : ""}${row.reviewRequired && !reviewed ? " needs-review" : ""}">
          <button class="transition-row-button" type="button" data-action="select-transition" data-transition-id="${escapeHtml(row.transitionEventId)}">
            <div class="row-main">
              <strong>${escapeHtml(transitionTitle(row))}</strong>
              <small>${escapeHtml(row.workerName || "Worker")} - ${escapeHtml(row.previousPhaseName || row.phaseName || "Phase")} to ${escapeHtml(row.nextPhaseName || "Next phase")}</small>
            </div>
            <div class="row-stat"><span>Gap</span><strong>${formatMinutes(row.rawGapMinutes)}</strong></div>
            <div class="row-stat"><span>Excess</span><strong>${formatMinutes(row.excessGapMinutes)}</strong></div>
            <div class="row-stat"><span>When</span><strong>${escapeHtml(formatClock(row.previousTaskEndedAt))}</strong><small>to ${escapeHtml(formatClock(row.nextTaskStartedAt))}</small></div>
            <div class="row-stat"><span>Bucket</span><strong>${escapeHtml(row.gapBucketName || "--")}</strong></div>
            <div class="row-stat"><span>Review</span><strong>${reviewed ? "Reviewed" : row.reviewRequired ? "Needed" : "No"}</strong></div>
          </button>
          ${selected ? renderTransitionReviewControls(row) : ""}
        </div>
      `;
    }).join("");
  }

  function renderTransitionPanel(phaseKey, workerKey = "") {
    const taskRows = phaseTaskRows(phaseKey, workerKey);
    const transitionRows = transitionsForScope(phaseKey, workerKey);
    const stats = transitionStats(transitionRows);
    const actualTasks = taskRows.filter((row) => row.actualMinutes > 0).length;
    const completedTasks = taskRows.filter((row) => row.completed).length;
    const staleRows = taskRows.filter((row) => !row.actualMinutes && !row.completed).length;

    return `
      <div class="transition-grid">
        ${metric("Tasks touched", formatNumber(actualTasks), "logged time today")}
        ${metric("Completed", formatNumber(completedTasks), "completed task rows")}
        ${metric("Open without actual", formatNumber(staleRows), "review candidates")}
        ${metric("Task switches", formatNumber(stats.taskSwitchCount), `${formatNumber(stats.transitionCount)} transition gaps`)}
        ${metric("Transition time", formatMinutes(stats.totalTransitionMinutes), `${formatMinutes(stats.excessTransitionMinutes)} excess`)}
        ${metric("Review flags", formatNumber(stats.unreviewedTransitionCount), `${formatNumber(stats.reviewRequiredCount)} requiring review`)}
      </div>
      <div class="debug-box transition-note">
        <strong>Actual-time and transition composition</strong>
        <p>Actual today is only the selected work date. Worker total and task total come from Hawley's worker actual ledger across recorded dates. Transition gaps come from Hawley's live session ledger and will be strongest from the point this ledger was enabled forward.</p>
      </div>
    `;
  }

  function railTile(label, value, detail = "", pending = false) {
    return `
      <div class="rail-tile ${pending ? "pending" : ""}">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
        ${detail ? `<small>${escapeHtml(detail)}</small>` : ""}
      </div>
    `;
  }

  function renderPhaseRail(phase) {
    const summary = taskScopeSummary(phase.phaseKey);
    const workerRows = phaseWorkerRows(phase.phaseKey);
    const touchedWorkers = workerRows.filter((row) => row.actualMinutes > 0).length;
    const touchedTasks = phaseTaskRows(phase.phaseKey).filter((row) => row.actualMinutes > 0).length;
    const transitions = transitionsForScope(phase.phaseKey);
    const stats = transitionStats(transitions);

    return `
      <section class="panel phase-rail-panel">
        <div class="panel-header">
          <h2 class="panel-title">Phase rail</h2>
          ${statusPill("preview layer", "warn")}
        </div>
        <div class="panel-body">
          <div class="phase-rail">
            ${railTile("Workers touched", formatNumber(touchedWorkers), `${formatNumber(workerRows.length)} assigned or active`)}
            ${railTile("Tasks touched", formatNumber(touchedTasks), `${formatNumber(summary.taskCount)} total in phase`)}
            ${railTile("Completed", formatNumber(summary.completedTaskCount), `${formatNumber(summary.openTaskCount)} open`)}
            ${railTile("Task switches", formatNumber(stats.taskSwitchCount), `${formatNumber(stats.transitionCount)} transition gaps`)}
            ${railTile("Handoff gaps", formatMinutes(stats.totalTransitionMinutes), `${formatMinutes(stats.excessTransitionMinutes)} excess`)}
            ${railTile("Review flags", formatNumber(stats.unreviewedTransitionCount), `${formatNumber(stats.reviewRequiredCount)} total flags`)}
          </div>
          <div class="rail-actions">
            <button class="btn primary" type="button" data-action="show-phase-tasks">All phase tasks</button>
            <button class="btn" type="button" data-action="show-transitions">Transitions</button>
            <button class="btn" type="button" data-action="show-review-queue" ${stats.unreviewedTransitionCount ? "" : "disabled"}>Review queue</button>
          </div>
        </div>
      </section>
    `;
  }

  function renderPhaseHero(phase, label = "Phase detail", title = phase.phase, detail = "") {
    const phaseDetail = detail || `${state.date} - ${formatNumber(phase.workerCount)} workers - ${formatNumber(phase.completedTaskCount)}/${formatNumber(phase.taskCount)} tasks complete`;
    const backToPhase = state.phaseView !== "workers"
      ? `<button class="btn" type="button" data-action="back-to-phase">Back to phase</button>`
      : "";

    return `
      <section class="phase-detail-hero">
        <div class="phase-hero-actions">
          <button class="btn" type="button" data-action="back-to-day">Back to day</button>
          ${backToPhase}
        </div>
        <div>
          <span class="section-kicker">${escapeHtml(label)}</span>
          <h2>${escapeHtml(title)}</h2>
          <p>${escapeHtml(phaseDetail)}</p>
        </div>
      </section>
    `;
  }

  function renderPhaseMetricStrip(phase) {
    return `
      <section class="status-strip phase-metrics">
        ${metric("Actual", formatMinutes(phase.actualMinutes), "worker actual ledger")}
        ${metric("Assigned", formatHours(phase.assignedHours), `${formatHours(phase.completedHours)} completed estimate`)}
        ${metric("Tasks", `${formatNumber(phase.completedTaskCount)}/${formatNumber(phase.taskCount)}`, `${formatNumber(phase.openTaskCount)} open`)}
        ${metric("Completion", formatPercent(phase.completionPercent), "task row completion")}
        ${metric("Utilization", formatPercent(phase.utilizationPercent), "actual / elapsed worker time")}
        ${metric("Workers", formatNumber(phase.workerCount), "worked or assigned in phase")}
      </section>
    `;
  }

  function renderTaskScopeMetricStrip(summary) {
    return `
      <section class="status-strip phase-metrics">
        ${metric("Actual today", formatMinutes(summary.actualMinutes), "selected work date")}
        ${metric("Worker history", formatMinutes(summary.workerHistoryMinutes), "all recorded dates")}
        ${metric("Team history", formatMinutes(summary.teamHistoryMinutes), "all workers, all dates")}
        ${metric("Task estimate", formatHours(summary.assignedHours), "full task estimate")}
        ${metric("Tasks", `${formatNumber(summary.completedTaskCount)}/${formatNumber(summary.taskCount)}`, `${formatNumber(summary.openTaskCount)} open`)}
        ${metric("Completion", formatPercent(summary.completionPercent), "task row completion")}
      </section>
    `;
  }

  function renderDebugPanel() {
    if (!debugMode) return "";

    const payload = {
      date: state.date,
      selectedPhase: state.selectedPhase,
      phaseView: state.phaseView,
      selectedWorker: state.selectedWorker,
      health: state.health,
      sync: state.sync,
      auth: state.auth,
      assignmentMode: state.assignments?.mode,
      latestTrackerDate: state.assignments?.latestTrackerDate,
      lineOverview: state.assignments?.lineOverview,
      managerSignals: state.assignments?.managerSignals,
      cycleDays: state.assignments?.cycleDays,
      utilizationSummary: state.utilization?.summary,
    };

    return `
      <section class="panel">
        <div class="panel-header">
          <h2 class="panel-title">Debug payload</h2>
          ${state.loading ? statusPill("Loading", "warn") : statusPill("Read-only", "ok")}
        </div>
        <div class="panel-body debug-list">
          <details class="debug-box">
            <summary>Environment and sync snapshot</summary>
            <pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>
          </details>
          <details class="debug-box">
            <summary>Worker payload sample</summary>
            <pre>${escapeHtml(JSON.stringify(workers().slice(0, 4), null, 2))}</pre>
          </details>
        </div>
      </section>
    `;
  }

  function renderNotice() {
    return `
      <div class="notice">
        <strong>Task-control safe line view.</strong>
        This page does not expose Start, Stop, Complete, End Session, Refresh tracker, or Adopt tasks. Manager transition review controls appear only after selecting a transition gap and write only to Hawley's review layer.
      </div>
    `;
  }

  function renderDayView() {
    return `
      ${renderNotice()}
      ${renderStatusStrip()}
      <section class="panel day-panel">
        <div class="panel-header">
          <h2 class="panel-title">Day phase overview</h2>
          ${statusPill(`${phaseRows().length} phases`, "ok")}
        </div>
        <div class="panel-body phase-list">${renderPhaseCards()}</div>
      </section>
      ${renderDebugPanel()}
    `;
  }

  function renderPhaseDetail() {
    const phase = selectedPhaseRow();
    if (!phase) return renderDayView();

    if (state.phaseView === "transitions" || state.phaseView === "review") {
      const reviewOnly = state.phaseView === "review";
      const transitions = transitionsForScope(phase.phaseKey, "", reviewOnly);
      return `
        ${renderNotice()}
        ${renderPhaseHero(
          phase,
          reviewOnly ? "Review queue" : "Transition detail",
          reviewOnly ? `${phase.phase} review queue` : `${phase.phase} transitions`,
          `${state.date} - ${formatNumber(transitions.length)} ${reviewOnly ? "unreviewed gaps" : "transition gaps"}`
        )}
        ${renderPhaseMetricStrip(phase)}
        <section class="panel task-detail-panel">
          <div class="panel-header">
            <h2 class="panel-title">${reviewOnly ? "Gaps requiring review" : "Transition gaps"}</h2>
            <div class="panel-actions">
              <button class="btn" type="button" data-action="show-phase-tasks">All phase tasks</button>
              <button class="btn" type="button" data-action="show-transitions">All transitions</button>
              ${statusPill(`${transitions.length} gaps`, transitions.some((row) => row.reviewRequired && !row.reviewedAt) ? "warn" : "ok")}
            </div>
          </div>
          <div class="panel-body task-list">
            ${renderTransitionPanel(phase.phaseKey)}
            ${renderTransitionRows(phase.phaseKey, "", reviewOnly)}
          </div>
        </section>
        ${renderDebugPanel()}
      `;
    }

    if (state.phaseView === "tasks") {
      const summary = taskScopeSummary(phase.phaseKey);
      return `
        ${renderNotice()}
        ${renderPhaseHero(phase, "Task detail", `${phase.phase} tasks`, `${state.date} - all tasks in this phase`)}
        ${renderTaskScopeMetricStrip(summary)}
        <section class="panel task-detail-panel">
          <div class="panel-header">
            <h2 class="panel-title">All phase tasks</h2>
            ${statusPill(`${summary.taskCount} tasks`, "ok")}
          </div>
          <div class="panel-body task-list">
            ${renderTransitionPanel(phase.phaseKey)}
            ${renderPhaseTasks(phase.phaseKey)}
          </div>
        </section>
        ${renderDebugPanel()}
      `;
    }

    if (state.phaseView === "worker") {
      const worker = selectedPhaseWorkerRow();
      if (!worker) {
        state.phaseView = "workers";
        state.selectedWorker = "";
        updateUrl();
        return renderPhaseDetail();
      }
      const summary = taskScopeSummary(phase.phaseKey, worker.workerKey);
      return `
        ${renderNotice()}
        ${renderPhaseHero(phase, "Worker task detail", worker.name, `${state.date} - ${phase.phase} - ${formatNumber(summary.completedTaskCount)}/${formatNumber(summary.taskCount)} tasks complete`)}
        ${renderTaskScopeMetricStrip(summary)}
        <section class="panel task-detail-panel">
          <div class="panel-header">
            <h2 class="panel-title">Worker tasks</h2>
            <div class="panel-actions">
              <button class="btn" type="button" data-action="show-phase-tasks">All phase tasks</button>
              ${statusPill(`${summary.taskCount} tasks`, "ok")}
            </div>
          </div>
          <div class="panel-body task-list">
            ${renderTransitionPanel(phase.phaseKey, worker.workerKey)}
            ${renderTransitionRows(phase.phaseKey, worker.workerKey)}
            ${renderPhaseTasks(phase.phaseKey, worker.workerKey)}
          </div>
        </section>
        ${renderDebugPanel()}
      `;
    }

    return `
      ${renderNotice()}
      ${renderPhaseHero(phase)}
      ${renderPhaseMetricStrip(phase)}
      ${renderPhaseRail(phase)}
      <section class="panel phase-workers-panel">
        <div class="panel-header">
          <h2 class="panel-title">Workers in phase</h2>
          <div class="panel-actions">
            <button class="btn primary" type="button" data-action="show-phase-tasks">All phase tasks</button>
            ${statusPill(`${phaseWorkerRows(phase.phaseKey).length} workers`, "ok")}
          </div>
        </div>
        <div class="panel-body worker-list">${renderPhaseWorkers(phase.phaseKey)}</div>
      </section>
      ${renderDebugPanel()}
    `;
  }

  function renderContent() {
    if (state.error) {
      return `<div class="error">${escapeHtml(state.error)}</div>`;
    }

    if (state.loading && !state.assignments) {
      return `<div class="empty">Loading Hawley line view...</div>`;
    }

    return state.selectedPhase ? renderPhaseDetail() : renderDayView();
  }

  function render() {
    root.innerHTML = `
      <div class="beta-shell">
        ${renderTopbar()}
        <main class="beta-main">${renderContent()}</main>
      </div>
    `;
  }

  async function saveTransitionReview(button) {
    const transitionId = button.dataset.transitionId || "";
    const categoryKey = button.dataset.categoryKey || "";
    const notes = Array.from(document.querySelectorAll("[data-review-notes]"))
      .find((item) => String(item.dataset.reviewNotes) === String(transitionId))
      ?.value || "";
    if (!transitionId || !categoryKey) return;

    button.disabled = true;
    try {
      const payload = await postJson("/api/transition-review", {
        transitionEventId: Number(transitionId),
        categoryKey,
        notes,
      });
      const updated = payload.transition;
      if (updated && state.utilization?.transitions) {
        state.utilization.transitions = state.utilization.transitions.map((row) =>
          String(row.transitionEventId) === String(updated.transitionEventId) ? updated : row
        );
        state.utilization.reviewQueue = state.utilization.transitions.filter((row) => row.reviewRequired && !row.reviewedAt);
      }
      state.selectedTransition = String(transitionId);
      render();
    } catch (error) {
      button.disabled = false;
      window.alert(error.message || "Could not save transition review.");
    }
  }

  root.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-action]");
    const action = target?.dataset.action;
    if (action === "reload") load();
    if (action === "select-phase") setPhase(target.dataset.phaseKey);
    if (action === "show-phase-tasks") setPhaseView("tasks");
    if (action === "show-transitions") setPhaseView("transitions");
    if (action === "show-review-queue") setPhaseView("review");
    if (action === "select-worker") setWorker(target.dataset.workerKey);
    if (action === "select-transition") setTransition(target.dataset.transitionId);
    if (action === "save-transition-review") await saveTransitionReview(target);
    if (action === "back-to-phase") setPhaseView("workers");
    if (action === "back-to-day") setPhase("");
  });

  root.addEventListener("change", (event) => {
    const target = event.target.closest("[data-action='date']");
    if (target) setDate(target.value);
  });

  load();
})();
