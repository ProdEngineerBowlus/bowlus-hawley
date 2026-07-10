(() => {
  const root = document.getElementById("beta-root");
  function localTodayIso() {
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }
  const today = localTodayIso();
  const state = {
    date: new URLSearchParams(window.location.search).get("date") || today,
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

  function setDate(nextDate) {
    state.date = nextDate || today;
    const url = new URL(window.location.href);
    url.searchParams.set("date", state.date);
    window.history.replaceState({}, "", url);
    load();
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

  function workers() {
    return Array.isArray(state.assignments?.workers) ? state.assignments.workers : [];
  }

  function phaseNameForTask(task) {
    return task.workArea || task.phase || task.phaseBucket || "Unspecified";
  }

  function phaseRows() {
    const rows = new Map();
    for (const worker of workers()) {
      for (const task of worker.tasks || []) {
        const phase = phaseNameForTask(task);
        if (!rows.has(phase)) {
          rows.set(phase, {
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
        const row = rows.get(phase);
        row.taskCount += 1;
        row.completedTaskCount += task.completed ? 1 : 0;
        row.assignedHours += Number(task.assignedHours || task.estimatedHours || 0);
        row.completedHours += task.completed ? Number(task.assignedHours || task.estimatedHours || 0) : 0;
        row.actualMinutes += taskActualToday(task);
        row.openTaskCount += task.completed ? 0 : 1;
        row.workerIds.add(worker.id);
      }
    }

    return Array.from(rows.values())
      .map((row) => ({
        ...row,
        workerCount: row.workerIds.size,
        completionPercent: row.taskCount ? Math.round((row.completedTaskCount / row.taskCount) * 100) : 0,
      }))
      .sort((a, b) => b.assignedHours - a.assignedHours || a.phase.localeCompare(b.phase));
  }

  function workerRows() {
    return workers()
      .map((worker) => {
        const tasks = Array.isArray(worker.tasks) ? worker.tasks : [];
        const actualMinutes = tasks.reduce((sum, task) => sum + taskActualToday(task), 0);
        const openTasks = tasks.filter((task) => !task.completed).length;
        const phaseSet = new Set(tasks.map(phaseNameForTask).filter(Boolean));
        return {
          id: worker.id,
          name: worker.name,
          phase: worker.phase || Array.from(phaseSet).join(", ") || "No work",
          taskCount: tasks.length,
          completedTaskCount: tasks.filter((task) => task.completed).length,
          openTasks,
          assignedHours: Number(worker.assignedHours || 0),
          actualMinutes,
          liveWriteEnabled: Boolean(worker.liveWriteEnabled),
        };
      })
      .sort((a, b) => b.taskCount - a.taskCount || b.actualMinutes - a.actualMinutes || a.name.localeCompare(b.name));
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
    const writeLevel = state.auth?.workerWritesEnabled ? "warn" : "ok";

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

  function renderPhaseRows() {
    const rows = phaseRows();
    if (!rows.length) return `<div class="empty">No phase rows for ${escapeHtml(state.date)}.</div>`;
    return rows.map((row) => `
      <div class="phase-row">
        <div class="row-main">
          <strong>${escapeHtml(row.phase)}</strong>
          <small>${formatNumber(row.workerCount)} workers active</small>
        </div>
        <div class="row-stat"><span>Actual</span><strong>${formatMinutes(row.actualMinutes)}</strong></div>
        <div class="row-stat"><span>Assigned</span><strong>${formatHours(row.assignedHours)}</strong></div>
        <div class="row-stat"><span>Tasks</span><strong>${formatNumber(row.completedTaskCount)}/${formatNumber(row.taskCount)}</strong></div>
        <div class="row-stat"><span>Complete</span><strong>${formatNumber(row.completionPercent)}%</strong></div>
        <div class="row-stat"><span>Open</span><strong>${formatNumber(row.openTaskCount)}</strong></div>
      </div>
    `).join("");
  }

  function renderWorkerRows() {
    const rows = workerRows();
    if (!rows.length) return `<div class="empty">No workers in the selected payload.</div>`;
    return rows.map((row) => `
      <div class="worker-row">
        <div class="row-main">
          <strong>${escapeHtml(row.name)}</strong>
          <small>${escapeHtml(row.phase)}</small>
        </div>
        <div class="row-stat"><span>Actual</span><strong>${formatMinutes(row.actualMinutes)}</strong></div>
        <div class="row-stat"><span>Assigned</span><strong>${formatHours(row.assignedHours)}</strong></div>
        <div class="row-stat"><span>Tasks</span><strong>${formatNumber(row.completedTaskCount)}/${formatNumber(row.taskCount)}</strong></div>
        <div class="row-stat"><span>Open</span><strong>${formatNumber(row.openTasks)}</strong></div>
        <div class="row-stat"><span>Writes</span><strong>${row.liveWriteEnabled ? "Main" : "No"}</strong></div>
      </div>
    `).join("");
  }

  function renderDebugPanel() {
    const payload = {
      date: state.date,
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
          <details class="debug-box" open>
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

  function renderContent() {
    if (state.error) {
      return `<div class="error">${escapeHtml(state.error)}</div>`;
    }

    if (state.loading && !state.assignments) {
      return `<div class="empty">Loading Hawley beta diagnostics...</div>`;
    }

    return `
      <div class="notice">
        <strong>Beta page is intentionally not active.</strong>
        This page only uses GET requests. It does not expose Start, Stop, Complete, End Session, Refresh tracker, or Adopt tasks.
      </div>
      ${renderStatusStrip()}
      <section class="lab-grid">
        <div class="panel">
          <div class="panel-header">
            <h2 class="panel-title">Phase debug summary</h2>
            ${statusPill(`${phaseRows().length} phases`, "ok")}
          </div>
          <div class="panel-body phase-list">${renderPhaseRows()}</div>
        </div>
        <div class="panel">
          <div class="panel-header">
            <h2 class="panel-title">Worker debug summary</h2>
            ${statusPill(`${workerRows().filter((row) => row.taskCount > 0).length} active`, "ok")}
          </div>
          <div class="panel-body worker-list">${renderWorkerRows()}</div>
        </div>
      </section>
      ${renderDebugPanel()}
    `;
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
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "reload") load();
  });

  root.addEventListener("change", (event) => {
    const target = event.target.closest("[data-action='date']");
    if (target) setDate(target.value);
  });

  load();
})();
