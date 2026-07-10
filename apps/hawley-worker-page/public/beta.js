(() => {
  const root = document.getElementById("beta-root");

  function localTodayIso() {
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  const params = new URLSearchParams(window.location.search);
  const initialView = params.get("view");
  const today = localTodayIso();
  const state = {
    date: params.get("date") || today,
    selectedPhase: params.get("phase") || "",
    phaseView: initialView === "tasks" || initialView === "worker" ? initialView : "workers",
    selectedWorker: params.get("worker") || "",
    loading: true,
    error: "",
    health: null,
    sync: null,
    auth: null,
    assignments: null,
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

  async function fetchJson(url) {
    const response = await fetch(url, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || payload.message || `Request failed: ${response.status}`);
    }
    return payload;
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
    } else {
      url.searchParams.delete("phase");
      url.searchParams.delete("view");
      url.searchParams.delete("worker");
    }
    window.history.replaceState({}, "", url);
  }

  function setDate(nextDate) {
    state.date = nextDate || today;
    state.selectedPhase = "";
    state.phaseView = "workers";
    state.selectedWorker = "";
    updateUrl();
    load();
  }

  function setPhase(phaseKey) {
    state.selectedPhase = phaseKey || "";
    state.phaseView = "workers";
    state.selectedWorker = "";
    updateUrl();
    render();
  }

  function setPhaseView(view) {
    state.phaseView = view || "workers";
    if (state.phaseView !== "worker") state.selectedWorker = "";
    updateUrl();
    render();
  }

  function setWorker(workerKey) {
    state.phaseView = "worker";
    state.selectedWorker = workerKey || "";
    updateUrl();
    render();
  }

  async function load() {
    state.loading = true;
    state.error = "";
    render();

    const stamp = Date.now();
    try {
      const [health, sync, auth, assignments] = await Promise.all([
        fetchJson(`/api/health?_=${stamp}`),
        fetchJson(`/api/sync-status?_=${stamp}`),
        fetchJson(`/api/auth-status?_=${stamp}`),
        fetchJson(`/api/daily-assignments?date=${encodeURIComponent(state.date)}&includeNoWork=true&_=${stamp}`),
      ]);
      state.health = health;
      state.sync = sync;
      state.auth = auth;
      state.assignments = assignments;
      if (state.selectedPhase && !selectedPhaseRow()) state.selectedPhase = "";
      if (!state.selectedPhase) {
        state.phaseView = "workers";
        state.selectedWorker = "";
      } else if (state.phaseView === "worker" && !selectedPhaseWorkerRow()) {
        state.phaseView = "workers";
        state.selectedWorker = "";
      }
      updateUrl();
    } catch (error) {
      state.error = error.message || "Could not load beta diagnostics.";
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

  function workers() {
    return Array.isArray(state.assignments?.workers) ? state.assignments.workers : [];
  }

  function phaseNameForTask(task) {
    return task.workArea || task.phase || task.phaseBucket || "Unspecified";
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
    return phaseKeyForName(phaseNameForTask(task));
  }

  function tasksForWorker(worker, phaseKey = "") {
    const tasks = Array.isArray(worker.tasks) ? worker.tasks : [];
    if (!phaseKey) return tasks;
    return tasks.filter((task) => taskPhaseKey(task) === phaseKey);
  }

  function phaseRows() {
    const rows = new Map();
    for (const worker of workers()) {
      for (const task of worker.tasks || []) {
        const phase = phaseNameForTask(task);
        const phaseKey = phaseKeyForName(phase);
        if (!rows.has(phaseKey)) {
          rows.set(phaseKey, {
            phaseKey,
            phase,
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
        row.taskCount += 1;
        row.completedTaskCount += task.completed ? 1 : 0;
        row.assignedHours += taskHours(task);
        row.completedHours += task.completed ? taskHours(task) : 0;
        row.actualMinutes += taskActualToday(task);
        row.openTaskCount += task.completed ? 0 : 1;
        row.workerIds.add(worker.id || worker.email || worker.name);
      }
    }

    return Array.from(rows.values())
      .map((row) => ({
        ...row,
        workerCount: row.workerIds.size,
        completionPercent: row.taskCount ? Math.round((row.completedTaskCount / row.taskCount) * 100) : 0,
        efficiencyPercent: row.actualMinutes ? Math.round((row.assignedHours * 60 / row.actualMinutes) * 100) : null,
      }))
      .sort((a, b) => b.assignedHours - a.assignedHours || a.phase.localeCompare(b.phase));
  }

  function selectedPhaseRow() {
    return phaseRows().find((row) => row.phaseKey === state.selectedPhase) || null;
  }

  function selectedPhaseWorkerRow() {
    if (!state.selectedWorker) return null;
    return phaseWorkerRows(state.selectedPhase).find((row) => row.workerKey === state.selectedWorker) || null;
  }

  function phaseWorkerRows(phaseKey) {
    return workers()
      .map((worker) => {
        const tasks = tasksForWorker(worker, phaseKey);
        const actualMinutes = tasks.reduce((sum, task) => sum + taskActualToday(task), 0);
        const assignedHours = tasks.reduce((sum, task) => sum + taskHours(task), 0);
        const completedTaskCount = tasks.filter((task) => task.completed).length;
        const completedHours = tasks.reduce((sum, task) => sum + (task.completed ? taskHours(task) : 0), 0);
        return {
          id: worker.id,
          workerKey: workerKeyForWorker(worker),
          name: worker.name || worker.email || "Unknown worker",
          role: worker.phase || worker.workArea || "",
          taskCount: tasks.length,
          completedTaskCount,
          openTasks: tasks.length - completedTaskCount,
          assignedHours,
          completedHours,
          actualMinutes,
          completionPercent: tasks.length ? Math.round((completedTaskCount / tasks.length) * 100) : 0,
          efficiencyPercent: actualMinutes ? Math.round((assignedHours * 60 / actualMinutes) * 100) : null,
          liveWriteEnabled: Boolean(worker.liveWriteEnabled),
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
          sourceTaskGid: task.sourceTaskGid || task.gid || task.taskGid || "",
          vin: task.vin || task.vinNumber || task.trailerVin || "",
          assignedHours,
          actualMinutes,
          completed: Boolean(task.completed),
          efficiencyPercent: actualMinutes ? Math.round((assignedHours * 60 / actualMinutes) * 100) : null,
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
    return {
      taskCount: rows.length,
      completedTaskCount,
      openTaskCount: rows.length - completedTaskCount,
      assignedHours,
      actualMinutes,
      workerCount: workerNames.size,
      completionPercent: rows.length ? Math.round((completedTaskCount / rows.length) * 100) : 0,
      efficiencyPercent: actualMinutes ? Math.round((assignedHours * 60 / actualMinutes) * 100) : null,
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
            <h1>Hawley Beta Lab</h1>
            <p>Read-only diagnostics and report prototypes</p>
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

    return `
      <section class="status-strip">
        ${metric("Cycle", line.cycle || "Current", `${formatNumber(line.completedTaskCount || 0)}/${formatNumber(line.taskCount || 0)} tasks complete`)}
        ${metric("Assigned", formatHours(line.assignedHours || 0), `${formatHours(line.remainingHours || 0)} remaining`)}
        ${metric("Actual today", formatMinutes(signals.actualTimeLoggedMinutes || 0), "from worker actual ledger")}
        ${metric("Sync", syncRuns.pull_asana_events?.status || state.sync?.watcher?.lastStatus || "unknown", formatDateTime(syncRuns.pull_asana_events?.ended_at || state.sync?.refreshedAt))}
        <div class="metric">
          <span>Beta safety</span>
          <strong>${statusPill("GET only", "ok")}</strong>
          <small>${escapeHtml(writeMode)}</small>
        </div>
        ${metric("Workers", formatNumber(signals.workerCount || workers().length), `${formatNumber(signals.workersWithWork || 0)} with work`)}
        ${metric("Open tasks", formatNumber(signals.openTaskCount || signals.openTasks || 0), "manager payload")}
        ${metric("Mode", state.assignments?.mode || "--", `latest tracker ${state.assignments?.latestTrackerDate || "--"}`)}
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
          <small>${formatNumber(row.workerCount)} workers active</small>
        </div>
        <div class="row-stat"><span>Actual</span><strong>${formatMinutes(row.actualMinutes)}</strong></div>
        <div class="row-stat"><span>Assigned</span><strong>${formatHours(row.assignedHours)}</strong></div>
        <div class="row-stat"><span>Tasks</span><strong>${formatNumber(row.completedTaskCount)}/${formatNumber(row.taskCount)}</strong></div>
        <div class="row-stat"><span>Complete</span><strong>${formatPercent(row.completionPercent)}</strong></div>
        <div class="row-stat"><span>Efficiency</span><strong>${formatPercent(row.efficiencyPercent)}</strong></div>
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
        <div class="row-stat"><span>Efficiency</span><strong>${formatPercent(row.efficiencyPercent)}</strong></div>
        <div class="row-stat"><span>Open</span><strong>${formatNumber(row.openTasks)}</strong></div>
      </button>
    `).join("");
  }

  function renderPhaseTasks(phaseKey, workerKey = "") {
    const rows = phaseTaskRows(phaseKey, workerKey);
    if (!rows.length) return `<div class="empty">No task detail is attached to this phase for ${escapeHtml(state.date)}.</div>`;
    return rows.map((row) => `
      <div class="task-row">
        <div class="row-main">
          <strong>${escapeHtml(row.taskName)}</strong>
          <small>${escapeHtml([row.workerName, row.vin ? `VIN ${row.vin}` : "", row.sourceTaskGid].filter(Boolean).join(" - "))}</small>
        </div>
        <div class="row-stat"><span>Actual</span><strong>${formatMinutes(row.actualMinutes)}</strong></div>
        <div class="row-stat"><span>Assigned</span><strong>${formatHours(row.assignedHours)}</strong></div>
        <div class="row-stat"><span>Efficiency</span><strong>${formatPercent(row.efficiencyPercent)}</strong></div>
        <div class="row-stat"><span>Status</span><strong>${row.completed ? "Complete" : "Open"}</strong></div>
      </div>
    `).join("");
  }

  function renderTransitionPanel(phaseKey, workerKey = "") {
    const taskRows = phaseTaskRows(phaseKey, workerKey);
    const actualTasks = taskRows.filter((row) => row.actualMinutes > 0).length;
    const completedTasks = taskRows.filter((row) => row.completed).length;
    const staleRows = taskRows.filter((row) => !row.actualMinutes && !row.completed).length;

    return `
      <div class="transition-grid">
        ${metric("Tasks touched", formatNumber(actualTasks), "logged time today")}
        ${metric("Completed", formatNumber(completedTasks), "completed task rows")}
        ${metric("Open without actual", formatNumber(staleRows), "review candidates")}
      </div>
      <div class="debug-box transition-note">
        <strong>Transition ledger status</strong>
        <p>The beta page can read phase, task, worker, assigned, actual, and completion rows today. The richer transition stream from the new Hawley ledger will plug into this panel next, so we can show phase handoffs, task switching, review-required events, and end-session gaps without changing the live app.</p>
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
            ${railTile("Task switches", "--", "coming from transition ledger", true)}
            ${railTile("Handoff gaps", "--", "coming from transition ledger", true)}
            ${railTile("Review flags", "--", "coming from manager review layer", true)}
          </div>
          <div class="rail-actions">
            <button class="btn primary" type="button" data-action="show-phase-tasks">All phase tasks</button>
            <button class="btn" type="button" disabled>Transitions soon</button>
            <button class="btn" type="button" disabled>Review queue soon</button>
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
        ${metric("Efficiency", formatPercent(phase.efficiencyPercent), "assigned hours / actual today")}
        ${metric("Workers", formatNumber(phase.workerCount), "worked or assigned in phase")}
      </section>
    `;
  }

  function renderTaskScopeMetricStrip(summary) {
    return `
      <section class="status-strip phase-metrics">
        ${metric("Actual", formatMinutes(summary.actualMinutes), "worker actual ledger")}
        ${metric("Assigned", formatHours(summary.assignedHours), "task estimate")}
        ${metric("Tasks", `${formatNumber(summary.completedTaskCount)}/${formatNumber(summary.taskCount)}`, `${formatNumber(summary.openTaskCount)} open`)}
        ${metric("Completion", formatPercent(summary.completionPercent), "task row completion")}
        ${metric("Efficiency", formatPercent(summary.efficiencyPercent), "assigned hours / actual today")}
        ${metric("Workers", formatNumber(summary.workerCount), "scope")}
      </section>
    `;
  }

  function renderDebugPanel() {
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
        <strong>Beta page is intentionally not active.</strong>
        This page only uses GET requests. It does not expose Start, Stop, Complete, End Session, Refresh tracker, or Adopt tasks.
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
      return `<div class="empty">Loading Hawley beta diagnostics...</div>`;
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

  root.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    const action = target?.dataset.action;
    if (action === "reload") load();
    if (action === "select-phase") setPhase(target.dataset.phaseKey);
    if (action === "show-phase-tasks") setPhaseView("tasks");
    if (action === "select-worker") setWorker(target.dataset.workerKey);
    if (action === "back-to-phase") setPhaseView("workers");
    if (action === "back-to-day") setPhase("");
  });

  root.addEventListener("change", (event) => {
    const target = event.target.closest("[data-action='date']");
    if (target) setDate(target.value);
  });

  load();
})();
