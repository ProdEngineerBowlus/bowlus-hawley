(function () {
  const PROJECT_ID = "1214157321063250";
  const ASSIGNMENT_AUTO_REFRESH_MS = 90 * 1000;
  const SYNC_STATUS_REFRESH_MS = 60 * 1000;
  let today = getTodayIso();
  const queryEmployee = getEmployeeFromUrl();
  const queryDate = queryEmployee ? "" : getDateFromUrl();
  const selectedDate = queryDate || today;

  const state = {
    loading: true,
    actionTaskId: "",
    timers: loadLocalTimers(),
    trackerRefresh: {
      running: false,
      message: "",
      startedAt: "",
      step: "",
      outputTail: "",
    },
    authStatus: {
      writePinRequired: false,
      mode: "debug-open",
      workerWritesEnabled: false,
      writeWorkerIds: [],
    },
    alertStatus: {
      enabled: false,
      channel: "log",
      configuredRecipients: 0,
      thresholdMinutes: 15,
      workStart: "07:00",
      workEnd: "15:30",
      lunchStart: "11:00",
      lunchEnd: "11:30",
      pauses: [],
      timerAutoStopEnabled: true,
      timerScheduleEnforced: true,
      pending: [],
      history: [],
    },
    syncStatus: {
      watcher: {},
      latestRuns: {},
      refreshedAt: "",
    },
    source: "loading",
    date: selectedDate,
    project: {
      id: PROJECT_ID,
      name: "Daily Assignment Tracker",
      url: "https://app.asana.com/1/829365006370166/project/1214157321063250",
    },
    latestTrackerDate: "",
    latestRuns: {},
    refreshedAt: "",
    cycleDays: null,
    workers: [],
    lineOverview: null,
    error: "",
  };

  const icons = {
    copy:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
    open:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path></svg>',
    refresh:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M21 12a9 9 0 0 1-15.5 6.2"></path><path d="M3 12A9 9 0 0 1 18.5 5.8"></path><path d="M18 2v4h4"></path><path d="M6 22v-4H2"></path></svg>',
  };

  const sampleAssignments = {
    source: "sample",
    date: selectedDate,
    project: {
      id: PROJECT_ID,
      name: "Daily Assignment Tracker",
      url: "https://app.asana.com/1/829365006370166/project/1214157321063250",
    },
    lineOverview: {
      cycle: "C10",
      status: "Assigned",
      assignedHours: 296.28,
      completedHours: 11.5,
      remainingHours: 284.78,
      taskCount: 277,
      completedTaskCount: 21,
      completionPercent: 3.88,
      capacityDeltaHours: 207.98,
    },
    workers: [
      {
        id: "asana-luisg-bowlusroadchief-com",
        name: "Luis Garcia",
        email: "asana+luisg@bowlusroadchief.com",
        cycle: "C10",
        phase: "Phase B",
        workBlock: "Auto Work Block 1",
        trackerStatus: "Assigned",
        trackerUrl:
          "https://app.asana.com/1/829365006370166/project/1214157321063250/task/1215677904390174",
        assignedHours: 4.27,
        completedHours: 0.75,
        remainingHours: 3.52,
        taskCount: 6,
        completedTaskCount: 1,
        tasks: [
          {
            id: "1214887589108815",
            title: "Tape Trailer Top Half Of Trailer",
            cycle: "C10",
            assignedHours: 1,
            targetHours: 7,
            completed: false,
            trackerUrl:
              "https://app.asana.com/1/829365006370166/project/1214157321063250/task/1215680314064588",
            sourceUrl:
              "https://app.asana.com/1/829365006370166/project/1214885291416399/task/1214887589108815",
            sopUrl: "https://example.com/sop/tape-trailer-top-half",
            actualTimeMinutes: 0,
            estimatedMinutes: 60,
          },
          {
            id: "1214885291891615",
            title: 'Fit Middle "C"',
            cycle: "C10",
            assignedHours: 0.25,
            targetHours: 7,
            completed: false,
            trackerUrl:
              "https://app.asana.com/1/829365006370166/project/1214157321063250/task/1215680315157242",
            sourceUrl:
              "https://app.asana.com/1/829365006370166/project/1214885291416399/task/1214885291891615",
            sopUrl: "",
            actualTimeMinutes: 0,
            estimatedMinutes: 15,
          },
          {
            id: "1214887589154232",
            title: 'SUPERVISOR QC AND APPROVAL REQUIRED FOR MIDDLE "C" PANEL',
            cycle: "C10",
            assignedHours: 0.02,
            targetHours: 7,
            completed: false,
            trackerUrl:
              "https://app.asana.com/1/829365006370166/project/1214157321063250/task/1215682916065255",
            sourceUrl:
              "https://app.asana.com/1/829365006370166/project/1214885291416399/task/1214887589154232",
            sopUrl: "",
            actualTimeMinutes: 0,
            estimatedMinutes: 1,
          },
          {
            id: "1214887589163822",
            title: 'Fit and Drill Middle "B" Port and Star',
            cycle: "C10",
            assignedHours: 1.5,
            targetHours: 7,
            completed: false,
            trackerUrl:
              "https://app.asana.com/1/829365006370166/project/1214157321063250/task/1215677904284633",
            sourceUrl:
              "https://app.asana.com/1/829365006370166/project/1214885291416399/task/1214887589163822",
            sopUrl: "",
            actualTimeMinutes: 0,
            estimatedMinutes: 90,
          },
          {
            id: "1214892207946081",
            title: "Cleco Tail H-C With Long & Short Spine",
            cycle: "C10",
            assignedHours: 0.75,
            targetHours: 7,
            completed: false,
            trackerUrl:
              "https://app.asana.com/1/829365006370166/project/1214157321063250/task/1215677904246487",
            sourceUrl:
              "https://app.asana.com/1/829365006370166/project/1214885291416399/task/1214892207946081",
            sopUrl: "",
            actualTimeMinutes: 0,
            estimatedMinutes: 45,
          },
          {
            id: "1214886361431848",
            title: "Tape & Roll Middle A Panels",
            cycle: "C10",
            assignedHours: 0.75,
            targetHours: 7,
            completed: true,
            trackerUrl:
              "https://app.asana.com/1/829365006370166/project/1214157321063250/task/1215682916065322",
            sourceUrl:
              "https://app.asana.com/1/829365006370166/project/1214885291416399/task/1214886361431848",
            sopUrl: "",
            actualTimeMinutes: 45,
            estimatedMinutes: 45,
          },
        ],
      },
      {
        id: "asana-mauricer-bowlusroadchief-com",
        name: "Maurice Ramirez",
        email: "asana+mauricer@bowlusroadchief.com",
        cycle: "C10",
        phase: "Phase B",
        workBlock: "Auto Work Block 1",
        trackerStatus: "Assigned",
        trackerUrl:
          "https://app.asana.com/1/829365006370166/project/1214157321063250/task/1215688096767883",
        assignedHours: 9.25,
        completedHours: 0,
        remainingHours: 9.25,
        taskCount: 5,
        completedTaskCount: 0,
        tasks: [
          {
            id: "1214891221128930",
            title: "Source task 1214891221128930",
            cycle: "C10",
            assignedHours: 7,
            targetHours: 7,
            completed: false,
            phase: "Phase B",
            order: 3,
            vin: 323,
            sourceUrl:
              "https://app.asana.com/1/829365006370166/project/1214885291416399/task/1214891221128930",
            sopUrl: "",
            actualTimeMinutes: 0,
            estimatedMinutes: 420,
          },
          {
            id: "1214892207673888",
            title: "Source task 1214892207673888",
            cycle: "C10",
            assignedHours: 0.75,
            targetHours: 7,
            completed: false,
            phase: "Phase B",
            order: 7,
            vin: 323,
            sourceUrl:
              "https://app.asana.com/1/829365006370166/project/1214885291416399/task/1214892207673888",
            sopUrl: "",
            actualTimeMinutes: 0,
            estimatedMinutes: 45,
          },
          {
            id: "1214885291935604",
            title: "Source task 1214885291935604",
            cycle: "C10",
            assignedHours: 0.75,
            targetHours: 7,
            completed: false,
            phase: "Phase B",
            order: 9,
            vin: 323,
            sourceUrl:
              "https://app.asana.com/1/829365006370166/project/1214885291416399/task/1214885291935604",
            sopUrl: "",
            actualTimeMinutes: 0,
            estimatedMinutes: 45,
          },
        ],
      },
    ],
  };

  render();
  loadAuthStatus();
  loadAssignments();
  loadAlertStatus();
  if (!queryEmployee) {
    loadRefreshStatus();
    loadSyncStatus();
  }
  window.setInterval(() => {
    if (hasVisibleRunningTimer()) render();
  }, 30000);
  window.setInterval(() => {
    if (!state.actionTaskId) loadAssignments({ silent: true });
  }, ASSIGNMENT_AUTO_REFRESH_MS);
  if (!queryEmployee) {
    window.setInterval(() => {
      loadSyncStatus({ silent: true });
    }, SYNC_STATUS_REFRESH_MS);
  }

  async function loadAssignments(options = {}) {
    const silent = Boolean(options.silent);
    const freshToday = getTodayIso();
    if (freshToday !== today) {
      today = freshToday;
      if (queryEmployee || !queryDate) {
        window.location.reload();
        return;
      }
      render();
      return;
    }

    if (!silent) {
      state.loading = true;
      render();
    }

    try {
      const params = new URLSearchParams({ date: state.date, _: String(Date.now()) });
      if (queryEmployee) params.set("employee", queryEmployee);
      const response = await fetch(`/api/daily-assignments?${params.toString()}`);
      if (!response.ok) throw new Error(`Asana API returned ${response.status}`);
      const payload = await response.json();
      applyAssignments(payload, "asana");
    } catch (error) {
      if (silent) {
        state.error = "Could not refresh live worker assignments. Reload the page or ask a manager to check the Daily Assignment app server.";
        render();
        return;
      }
      if (queryEmployee) {
        applyAssignments({ source: "error", date: state.date, workers: [], error: "Could not load live worker assignments. Ask a manager to check the Daily Assignment app server." }, "error");
      } else {
        applyAssignments(sampleAssignments, "sample");
        state.error =
          "Using sample data. Start the Node server with ASANA_ACCESS_TOKEN to load live Asana assignments.";
      }
    }

    state.loading = false;
    render();
  }

  async function loadRefreshStatus() {
    try {
      const response = await fetch("/api/refresh-daily-tracker");
      if (!response.ok) return;
      const payload = await response.json();
      if (!payload.running && !payload.error) return;
      applyRefreshStatus(payload);
      render();
      if (payload.running) pollTrackerRefresh();
    } catch (error) {
      // Refresh status is helpful, but the assignment page can run without it.
    }
  }

  async function loadAlertStatus() {
    try {
      const response = await fetch("/api/alert-status");
      if (!response.ok) return;
      state.alertStatus = await response.json();
      render();
    } catch (error) {
      // Alerts are supplemental; the task page can run without this status.
    }
  }

  async function loadSyncStatus(options = {}) {
    try {
      const response = await fetch(`/api/sync-status?_=${Date.now()}`);
      if (!response.ok) return;
      state.syncStatus = await response.json();
      if (!options.silent || !state.actionTaskId) render();
    } catch (error) {
      // Freshness status is supplemental; assignments still carry last run info.
    }
  }

  async function loadAuthStatus() {
    try {
      const response = await fetch("/api/auth-status");
      if (!response.ok) return;
      state.authStatus = await response.json();
    } catch (error) {
      // If this fails, write actions will still handle a 401 by prompting.
    }
  }

  function applyAssignments(payload, source) {
    state.actionTaskId = "";
    state.source = payload.source || source;
    state.date = payload.date || today;
    state.project = payload.project || state.project;
    state.lineOverview = payload.lineOverview || null;
    state.latestTrackerDate = payload.latestTrackerDate || "";
    state.latestRuns = payload.latestRuns || {};
    state.refreshedAt = payload.refreshedAt || "";
    state.cycleDays = payload.cycleDays || null;
    const workers = Array.isArray(payload.workers) ? payload.workers : [];
    state.workers = queryEmployee ? workers.filter((worker) => worker.id === queryEmployee) : workers;
    state.error = payload.error || "";
  }

  function render() {
    const app = document.getElementById("app");
    const selectedWorker = getSelectedWorker();
    const locked = Boolean(queryEmployee);

    app.innerHTML = `
      <div class="app-shell ${locked ? "worker-shell" : "admin-shell"}">
        ${renderTopbar(selectedWorker, locked)}
        <div class="layout">
          ${locked ? renderEmployeeRail(selectedWorker) : renderAdminRail(selectedWorker)}
          <main class="main">
            ${renderToolbar(selectedWorker, locked)}
            ${state.loading ? renderLoading() : renderMain(selectedWorker, locked)}
          </main>
        </div>
        <div class="toast" id="toast" role="status"></div>
      </div>
    `;

    bindEvents();
  }

  function renderTopbar(worker, locked) {
    const scope = locked ? worker ? worker.name : "Worker" : "Admin";
    const sourceLabel = state.source === "asana" ? "Live Asana" : state.source === "sample" ? "Sample" : state.source === "error" ? "Error" : "Loading";

    return `
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">DA</div>
          <div>
            <h1>Daily Assignments</h1>
            <p>${escapeHtml(formatLongDate(state.date))} - ${escapeHtml(scope)} - ${escapeHtml(sourceLabel)}</p>
          </div>
        </div>
        <div class="top-actions">
          ${
            locked
              ? ""
              : `<a class="btn ghost" href="${escapeAttr(state.project.url)}" target="_blank" rel="noreferrer">${icons.open}<span>Asana project</span></a>
                 <button class="btn ghost" type="button" data-action="refresh">${icons.refresh}<span>Reload</span></button>
                 ${
                   worker
                     ? `<button class="btn primary" type="button" data-action="refresh-tracker" ${state.trackerRefresh.running ? "disabled" : ""}>${icons.refresh}<span>${state.trackerRefresh.running ? "Refreshing..." : "Refresh worker"}</span></button>`
                     : ""
                 }`
          }
        </div>
      </header>
    `;
  }

  function renderAdminRail(selectedWorker) {
    return `
      <aside class="sidebar">
        ${renderLineOverview()}
        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">Employees</h2>
          </div>
          <div class="panel-body">
            <div class="employee-list">
              <button class="employee-row${selectedWorker ? "" : " active"}" type="button" data-action="dashboard">
                <span>
                  <span class="employee-name">Manager dashboard</span>
                  <span class="employee-role">All worker timer status</span>
                </span>
                <span class="count-pill">${countActiveWorkers()} active</span>
              </button>
              ${state.workers.map((worker) => renderWorkerButton(worker, selectedWorker)).join("")}
            </div>
          </div>
        </section>
        <details class="panel link-drawer">
          <summary class="panel-header link-drawer-summary">
            <h2 class="panel-title">Configuration</h2>
            <span class="count-pill">${state.workers.length}</span>
          </summary>
          <div class="panel-body link-list">
            ${renderManagerLink()}
            ${state.workers.map(renderWorkerLink).join("") || `<div class="empty-state">No employee snapshots for today.</div>`}
          </div>
        </details>
      </aside>
    `;
  }

  function renderEmployeeRail(worker) {
    if (!worker) {
      const title = state.loading
        ? "Loading assignment"
        : state.error
          ? "Assignment unavailable"
          : "Employee link not found";
      const message = state.loading
        ? "Checking today's Daily Assignment snapshot."
        : state.error
          ? "Ask a manager to check the Daily Assignment app server."
          : "Ask a manager for your worker link.";

      return `
        <aside class="sidebar">
          <div class="notice">
            <div>
              <strong>${escapeHtml(title)}</strong>
              <div class="muted">${escapeHtml(message)}</div>
            </div>
          </div>
        </aside>
      `;
    }

    return `
      <aside class="sidebar">
        <div class="notice">
          <div>
            <strong>${escapeHtml(worker.name)}</strong>
            <div class="muted">${escapeHtml(worker.email || worker.phase || "Daily assignment")}</div>
          </div>
          <span class="count-pill">${openTasks(worker.tasks).length} open</span>
        </div>
      </aside>
    `;
  }

  function renderLineOverview() {
    const line = state.lineOverview;
    if (!line) return "";

    return `
      <section class="panel">
        <div class="panel-header">
          <h2 class="panel-title">Line overview</h2>
        </div>
        <div class="panel-body metric-grid">
          ${renderMetric("Cycle", line.cycle || "Current")}
          ${renderMetric("Assigned", formatHours(line.assignedHours))}
          ${renderMetric("Remaining", formatHours(line.remainingHours))}
          ${renderMetric("Complete", `${formatNumber(line.completionPercent)}%`)}
        </div>
      </section>
    `;
  }

  function renderWorkerButton(worker, selectedWorker) {
    const active = selectedWorker && worker.id === selectedWorker.id ? " active" : "";
    return `
      <button class="employee-row${active}" type="button" data-worker="${escapeAttr(worker.id)}">
        <span>
          <span class="employee-name">${escapeHtml(worker.name)}</span>
          <span class="employee-role">${escapeHtml(worker.phase || worker.cycle || "Worker snapshot")}</span>
        </span>
        <span class="count-pill">${worker.taskCount || worker.tasks.length}</span>
      </button>
    `;
  }

  function renderManagerLink() {
    const url = managerUrl();
    return `
      <div class="link-item manager-link">
        <div>
          <strong>Manager page</strong>
          <div class="link-url">${escapeHtml(url)}</div>
        </div>
        <button class="btn icon-only" type="button" title="Copy manager link" data-action="copy" data-url="${escapeAttr(url)}">${icons.copy}</button>
      </div>
    `;
  }

  function renderWorkerLink(worker) {
    const url = employeeUrl(worker.id);
    return `
      <div class="link-item">
        <div>
          <strong>${escapeHtml(worker.name)}</strong>
          <div class="link-url">${escapeHtml(url)}</div>
        </div>
        <button class="btn icon-only" type="button" title="Copy ${escapeAttr(worker.name)} link" data-action="copy" data-url="${escapeAttr(url)}">${icons.copy}</button>
      </div>
    `;
  }

  function renderToolbar(worker, locked) {
    const title = locked ? "Today's assignments" : worker ? worker.name : "Manager dashboard";
    let summary = worker
      ? `${formatHours(worker.assignedHours)} assigned - ${formatHours(worker.remainingHours)} remaining - ${worker.trackerStatus || "Open"}`
      : `${state.workers.length} employee snapshots - ${formatLongDate(state.date)}`;

    if (!worker) {
      summary = locked
        ? state.loading
          ? "Loading worker assignment"
          : state.error
            ? "Assignment unavailable"
            : "No assignment snapshot matched this link"
        : `${state.workers.length} workers - ${countActiveWorkers()} active timers - ${countOpenTasks()} open tasks`;
    } else {
      summary = `${openTasks(worker.tasks).length} open tasks - ${formatHours(worker.assignedHours)} assigned - ${formatHours(worker.remainingHours)} remaining - ${displayWorkerStatus(worker)}`;
    }

    return `
      <section class="toolbar">
        <div>
          <h2 class="page-title">${escapeHtml(title)}</h2>
          <p class="summary-line">${escapeHtml(summary)}</p>
        </div>
        <div class="button-row">
          ${
            worker
              ? `${locked ? "" : `<button class="btn ghost" type="button" data-action="dashboard">${icons.open}<span>Dashboard</span></button>`}
                 <a class="btn ghost" href="${escapeAttr(worker.trackerUrl)}" target="_blank" rel="noreferrer">${icons.open}<span>Tracker task</span></a>
                 ${
                   locked
                     ? ""
                     : `<button class="btn primary" type="button" data-action="copy-selected">${icons.copy}<span>Copy link</span></button>`
                 }`
              : ""
          }
        </div>
      </section>
    `;
  }

  function renderMain(worker, locked) {
    const content = locked || worker ? renderWorkerSection(worker) : renderManagerDashboard();

    if (state.error) {
      const notice = `
        <div class="notice">
          <div>
            <strong>${locked ? "Assignment data" : "Asana connection"}</strong>
            <div class="muted">${escapeHtml(state.error)}</div>
          </div>
        </div>
      `;

      if (locked) {
        return notice;
      }

      return `
        ${notice}
        ${content}
      `;
    }

    if (!locked && state.trackerRefresh.message) {
      return `
        ${renderRefreshNotice()}
        ${content}
      `;
    }

    return content;
  }

  function renderRefreshNotice() {
    const elapsed = state.trackerRefresh.running && state.trackerRefresh.startedAt
      ? `Elapsed ${formatElapsed(state.trackerRefresh.startedAt)}`
      : "";
    const step = refreshStepLabel(state.trackerRefresh.step);
    const details = [elapsed, step].filter(Boolean).join(" - ");

    return `
      <div class="notice refresh-notice">
        <div>
          <strong>Daily Assignment Tracker</strong>
          <div class="muted">${escapeHtml(state.trackerRefresh.message)}</div>
          ${details ? `<div class="field-hint">${escapeHtml(details)}</div>` : ""}
        </div>
      </div>
    `;
  }

  function renderManagerDashboard() {
    const freshnessPanel = renderFreshnessPanel();
    if (!state.workers.length) {
      const latest = state.latestTrackerDate && state.latestTrackerDate !== state.date
        ? `<div class="field-hint">Latest available tracker date: ${escapeHtml(formatLongDate(state.latestTrackerDate))}. Refresh tracker before using today's worker pages.</div>`
        : "";
      return `
        ${freshnessPanel}
        <div class="empty-state">No worker assignment snapshots are available for ${escapeHtml(formatLongDate(state.date))}.${latest}</div>
      `;
    }

    return `
      <section class="manager-dashboard">
        ${renderCycleDayBar()}
        ${freshnessPanel}
        ${renderEfficiencyPanel()}
        ${renderAlertAttentionPanel()}
      </section>
    `;
  }

  function renderFreshnessPanel() {
    const syncStatus = state.syncStatus || {};
    const watcher = syncStatus.watcher || {};
    const workerActualsWatcher = syncStatus.watchers?.workerDailyActuals || {};
    const latestRuns = syncStatus.latestRuns || state.latestRuns || {};
    const running = Boolean(watcher.running);
    const intervalMs = Number(watcher.intervalMs || 60000);
    const workerActualsRunning = Boolean(workerActualsWatcher.running);
    const workerActualsIntervalMs = Number(workerActualsWatcher.intervalMs || 60000);
    const watcherTone = running ? "good" : watcher.requested || watcher.enabled ? "warn" : "risk";
    const workerActualsTone = workerActualsRunning ? "good" : workerActualsWatcher.requested || workerActualsWatcher.enabled ? "warn" : "risk";
    const watcherDetail = running
      ? `Every ${formatMinutes(Math.round(intervalMs / 60000))}`
      : watcher.reason || "Not running";
    const workerActualsDetail = workerActualsRunning
      ? `Every ${formatMinutes(Math.round(workerActualsIntervalMs / 60000))}`
      : workerActualsWatcher.reason || "Not running";
    const refreshedAt = syncStatus.refreshedAt || state.refreshedAt;

    return `
      <section class="panel freshness-panel">
        <div class="panel-header dashboard-header">
          <div>
            <h2 class="panel-title">HB freshness</h2>
            <p class="summary-line">${escapeHtml(refreshedAt ? `Checked ${formatRelativeTime(refreshedAt)}` : "Waiting for sync status")}</p>
          </div>
          <span class="status-pill ${escapeAttr(watcherTone)}">${escapeHtml(running ? "Watching" : "Offline")}</span>
        </div>
        <div class="panel-body freshness-grid">
          ${renderFreshnessMetric("Asana watcher", running ? "Running" : "Off", watcherDetail, watcherTone)}
          ${renderFreshnessMetric("Worker actuals", workerActualsRunning ? "Running" : "Off", workerActualsDetail, workerActualsTone)}
          ${renderRunFreshness("Asana events", latestRuns.pull_asana_events, 5)}
          ${renderRunFreshness("Worker actuals", latestRuns.pull_worker_daily_actuals, 5)}
          ${renderRunFreshness("Full Asana", latestRuns.pull_asana, 180)}
          ${renderRunFreshness("DAT mirror", latestRuns.pull_daily_tracker, 60)}
          ${renderRunFreshness("Legacy Airtable", latestRuns.pull_airtable, 1440)}
        </div>
      </section>
    `;
  }

  function renderRunFreshness(label, run, freshMinutes) {
    const endedAt = run && run.ended_at;
    const ok = run && run.status === "success";
    const ageMinutes = endedAt ? (Date.now() - new Date(endedAt).getTime()) / 60000 : Infinity;
    const tone = ok && ageMinutes <= freshMinutes ? "good" : ok ? "warn" : "risk";
    const detailParts = [];
    if (run && run.status) detailParts.push(run.status === "success" ? "ok" : run.status);
    if (run && Number(run.records_written || 0)) detailParts.push(`${formatCompactNumber(run.records_written)} writes`);
    if (run && Number(run.error_count || 0)) detailParts.push(`${formatCompactNumber(run.error_count)} errors`);
    return renderFreshnessMetric(label, endedAt ? formatRelativeTime(endedAt) : "Never", detailParts.join(" - ") || "No run logged", tone);
  }

  function renderFreshnessMetric(label, value, detail, level) {
    return `
      <div class="freshness-metric ${escapeAttr(level || "")}">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
        <small>${escapeHtml(detail)}</small>
      </div>
    `;
  }

  function renderAlertAttentionPanel() {
    const status = state.alertStatus || {};
    const pending = Array.isArray(status.pending)
    ? status.pending.filter((alert) => !alert.date || alert.date === state.date)
    : [];
    const attentionRows = workerAttentionSignals(state.workers);
    const issueCount = pending.length + attentionRows.length;
    const lanes = [
      {
        label: "Daily pacing",
        tone: "risk",
        rows: attentionRows.filter((row) => row.category === "pacing"),
        empty: "All tracked workers are at or above 75%.",
      },
      {
        label: "Log status",
        tone: "warn",
        rows: attentionRows.filter((row) => row.category === "log"),
        empty: "No open-work login gaps.",
      },
      {
        label: "Paused",
        tone: "paused",
        rows: attentionRows.filter((row) => row.category === "paused"),
        empty: "No paused timers.",
      },
      {
        label: "Task alerts",
        tone: "risk",
        rows: [
          ...pending.map((alert) => ({ type: "pending", alert })),
          ...attentionRows.filter((row) => row.category === "task"),
        ],
        empty: "No pending or over-estimate task alerts.",
      },
    ];

    return `
        <section class="panel alert-attention-panel">
          <div class="panel-header dashboard-header">
            <div>
              <h2 class="panel-title">Alert layer</h2>
              <p class="summary-line">${issueCount ? `${issueCount} current signal${issueCount === 1 ? "" : "s"}` : "No paused, not logged in, or over-estimate workers right now."}</p>
            </div>
            <div class="button-row">
              <button class="btn ghost" type="button" data-action="adopt-tasks" ${state.trackerRefresh.running ? "disabled" : ""}>${icons.refresh}<span>${state.trackerRefresh.running ? "Working..." : "Adopt new tasks"}</span></button>
              <button class="btn primary" type="button" data-action="refresh-tracker" ${state.trackerRefresh.running ? "disabled" : ""}>${icons.refresh}<span>${state.trackerRefresh.running ? "Refreshing..." : "Refresh tracker"}</span></button>
            </div>
          </div>
          <div class="panel-body alert-lane-grid">
            ${lanes.map(renderAlertLane).join("")}
          </div>
        </section>
    `;
  }

  function renderAlertLane(lane) {
    const count = lane.rows.length;
    return `
      <section class="alert-lane ${escapeAttr(lane.tone)}">
        <div class="alert-lane-header">
          <span>${escapeHtml(lane.label)}</span>
          <strong>${count}</strong>
        </div>
        <div class="alert-lane-body">
          ${count ? lane.rows.map((row) => row.type === "pending" ? renderPendingAlertCard(row.alert) : renderAttentionCard(row)).join("") : `<div class="alert-lane-empty">${escapeHtml(lane.empty)}</div>`}
        </div>
      </section>
    `;
  }

  function renderPendingAlertCard(alert) {
    const worker = state.workers.find((item) => item.id === alert.employee || item.name === alert.workerName);
    return `
      <article class="attention-card warn">
        <div class="attention-card-main">
          <span class="attention-label">Pending alert</span>
          <strong>${escapeHtml(alert.workerName || alert.employee || "Worker")}</strong>
          <span>${escapeHtml(alert.completedTaskTitle || alert.taskTitle || "Needs follow-up")}</span>
        </div>
        ${worker ? `<button class="btn ghost" type="button" data-worker="${escapeAttr(worker.id)}">Details</button>` : ""}
      </article>
    `;
  }

  function renderAttentionCard(signal) {
    const level = signal.level === "risk" ? "risk" : signal.label === "Paused" ? "paused" : "warn";
    return `
      <article class="attention-card ${escapeAttr(level)}">
        <div class="attention-card-main">
          <span class="attention-label">${escapeHtml(signal.label)}</span>
          <strong>${escapeHtml(signal.name)}</strong>
          <span>${escapeHtml(signal.detail)}</span>
        </div>
        <button class="btn ghost" type="button" data-worker="${escapeAttr(signal.id)}">Details</button>
      </article>
    `;
  }

  function renderEfficiencyPanel() {
    const efficiencyRows = workerDailyEfficiencyRows();
    const linePercent = efficiencyRows.length
      ? Math.round(efficiencyRows.reduce((sum, row) => sum + row.percent, 0) / efficiencyRows.length)
      : 0;
    const belowThresholdCount = efficiencyRows.filter((row) => row.percent < 75).length;
    const cycleDays = state.cycleDays || {};
    const days = Array.isArray(cycleDays.days) ? cycleDays.days : [];
    const selected = days.find((day) => day.selected) || days.find((day) => day.date === state.date) || {};
    const cyclePercentValue = selected.taskCompletionPercent ?? selected.completionPercent ?? 0;
    const cyclePercent = Math.round(Number(cyclePercentValue || 0));
    const lineDetail = efficiencyRows.length
      ? `${efficiencyRows.length} worker average - ${belowThresholdCount} below 75%`
      : "No worker time logged yet";

    return `
      <section class="panel efficiency-panel">
        <div class="panel-header">
          <h2 class="panel-title">Efficiency signals</h2>
        </div>
        <div class="panel-body efficiency-grid">
          ${renderEfficiencySignal("Line daily efficiency", efficiencyRows.length ? `${linePercent}%` : "--", lineDetail, linePercent, efficiencyLevel(linePercent, efficiencyRows.length))}
          ${renderEfficiencySignal(`${cycleDays.cycle || "Cycle"} day`, `${cyclePercent}%`, selected.completeTaskLabel ? `${selected.completeTaskLabel} tasks complete` : "selected day completion", cyclePercent, cyclePercent >= 65 ? "good" : cyclePercent >= 35 ? "warn" : "risk")}
        </div>
      </section>
    `;
  }

  function renderEfficiencySignal(label, value, detail, percent, level) {
    const score = Math.max(0, Math.min(100, Number(percent || 0)));
    const needle = -90 + (score * 1.8);
    return `
      <div class="efficiency-signal ${escapeAttr(level)}">
        <div class="efficiency-copy">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
          <small>${escapeHtml(detail)}</small>
        </div>
        <div class="efficiency-gauge" aria-hidden="true">
          <svg viewBox="0 0 200 112" role="img" focusable="false">
            <path class="gauge-track" pathLength="100" d="M 18 94 A 82 82 0 0 1 182 94"></path>
            <path class="gauge-progress" pathLength="100" style="stroke-dasharray: ${score} 100;" d="M 18 94 A 82 82 0 0 1 182 94"></path>
            <g class="gauge-ticks">
              <line x1="18" y1="94" x2="30" y2="94"></line>
              <line x1="100" y1="12" x2="100" y2="26"></line>
              <line x1="182" y1="94" x2="170" y2="94"></line>
            </g>
            <line class="gauge-needle" x1="100" y1="94" x2="100" y2="34" style="transform: rotate(${needle}deg);"></line>
            <circle class="gauge-hub" cx="100" cy="94" r="7"></circle>
          </svg>
          <div class="gauge-scale">
            <span>0</span>
            <span>50</span>
            <span>100</span>
          </div>
        </div>
      </div>
    `;
  }

  function workerDailyEfficiencyRows() {
    const availableMinutes = elapsedScheduledWorkMinutesForDate(state.date);
    return state.workers
      .map((worker) => workerDailyEfficiency(worker, availableMinutes))
      .filter((row) => row.hasWork || row.loggedMinutes > 0)
      .sort((a, b) => b.percent - a.percent || b.loggedMinutes - a.loggedMinutes || a.name.localeCompare(b.name));
  }

  function workerDailyEfficiency(worker, availableMinutes = elapsedScheduledWorkMinutesForDate(state.date)) {
    const scheduledAvailableMinutes = Math.max(0, Number(availableMinutes || 0));
    const loggedMinutes = workerActualLoggedMinutes(worker);
    const summary = worker.dailyEfficiency || {};
    const summaryLoggedMinutes = Number(summary.loggedMinutes || 0);
    const effectiveLoggedMinutes = Math.max(loggedMinutes, summaryLoggedMinutes);
    const hasWork = Number(worker.assignedHours || 0) > 0 || openTasks(worker.tasks).length || Number(worker.completedTaskCount || 0) > 0;
    const percent = scheduledAvailableMinutes ? Math.round((effectiveLoggedMinutes / scheduledAvailableMinutes) * 100) : 0;
    return {
      id: worker.id,
      name: worker.name,
      loggedMinutes: effectiveLoggedMinutes,
      availableMinutes: scheduledAvailableMinutes,
      hasWork,
      percent,
      level: efficiencyLevel(percent, scheduledAvailableMinutes),
    };
  }

  function efficiencyLevel(percent, denominatorMinutes) {
    if (!denominatorMinutes) return "warn";
    if (percent >= 100) return "good";
    if (percent >= 70) return "warn";
    return "risk";
  }

  function renderCycleDayBar() {
    const cycleDays = state.cycleDays || {};
    const days = Array.isArray(cycleDays.days) ? cycleDays.days : [];
    if (!days.length) return "";

    const selected = days.find((day) => day.selected) || days.find((day) => day.date === state.date) || {};
    const dayLinks = days
      .map((day) => `
        <a class="cycle-day${day.date === state.date ? " active" : ""}${day.date === today ? " today" : ""}${day.hasSnapshot ? "" : " empty"}" href="${escapeAttr(managerDateUrl(day.date))}">
          <span>${escapeHtml(day.label)}</span>
          <strong>${escapeHtml(formatShortDate(day.date))}</strong>
        </a>
      `)
      .join("");

    return `
      <section class="panel cycle-panel">
        <div class="panel-header dashboard-header">
          <div>
            <h2 class="panel-title">${escapeHtml(cycleDays.cycle || "Cycle")} history</h2>
            <p class="summary-line">${escapeHtml(formatLongDate(state.date))}</p>
          </div>
          <a class="btn ghost" href="${escapeAttr(managerDateUrl(today))}">${icons.refresh}<span>Today</span></a>
        </div>
        <div class="cycle-day-strip" aria-label="Cycle days">
          ${dayLinks}
        </div>
      </section>
    `;
  }

  function renderManagerSignals() {
    const signals = managerSignals();
    const pacingClass = signals.pacingDeltaMinutes >= 0 ? "good" : signals.pacingDeltaMinutes <= -60 ? "risk" : "warn";
    const workerRows = signals.workerSignals
      .slice(0, 6)
      .map((worker) => `
        <div class="signal-row">
          <div>
            <strong>${escapeHtml(worker.name)}</strong>
            <span>${escapeHtml(worker.detail)}</span>
          </div>
          <span class="signal-badge ${escapeAttr(worker.level)}">${escapeHtml(worker.label)}</span>
        </div>
      `)
      .join("");
    const outlierRows = signals.outliers
      .slice(0, 4)
      .map((item) => `
        <div class="signal-row compact">
          <div>
            <strong>${escapeHtml(item.workerName)}</strong>
            <span>${escapeHtml(item.taskTitle)}</span>
          </div>
          <span class="signal-badge risk">${escapeHtml(item.flag || "PLH")}</span>
        </div>
      `)
      .join("");

    return `
      <section class="panel manager-signals-panel">
        <div class="panel-header dashboard-header">
          <div>
            <h2 class="panel-title">Manager signals</h2>
            <p class="summary-line">Live worker-page signals from assignments, timers, actual time, and PLH flags.</p>
          </div>
          <span class="status-pill ${pacingClass}">${escapeHtml(signals.pacingLabel)}</span>
        </div>
        <div class="panel-body signal-grid">
      ${renderSignalMetric(actualTimeLabel(), signals.pacingValue, signals.pacingDetail, pacingClass)}
          ${renderSignalMetric("WIP", signals.wipValue, signals.wipDetail, signals.runningCount ? "good" : "warn")}
          ${renderSignalMetric("Open outliers", signals.outlierValue, signals.outlierDetail, signals.outliers.length ? "risk" : "good")}
          ${renderSignalMetric("Needs attention", signals.attentionValue, signals.attentionDetail, signals.workerSignals.length ? "warn" : "good")}
        </div>
        ${workerRows || outlierRows ? `
          <div class="panel-body signal-lists">
            <div>
              <span class="field-label">Worker attention</span>
              <div class="signal-list">${workerRows || `<div class="empty-mini">No current worker pacing flags.</div>`}</div>
            </div>
            <div>
              <span class="field-label">PLH / outlier flags</span>
              <div class="signal-list">${outlierRows || `<div class="empty-mini">No open outlier flags in visible work.</div>`}</div>
            </div>
          </div>
        ` : ""}
      </section>
    `;
  }

  function renderSignalMetric(label, value, detail, level) {
    return `
      <div class="signal-metric ${escapeAttr(level || "")}">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
        <small>${escapeHtml(detail)}</small>
      </div>
    `;
  }

  function renderAlertPanel() {
    const status = state.alertStatus || {};
    const pending = Array.isArray(status.pending) ? status.pending : [];
    const history = Array.isArray(status.history) ? status.history : [];
    const mode = status.enabled ? `${status.channel || "log"} active` : "Dry run";
    const recipients = Number(status.configuredRecipients || 0);
    const deliveryTarget = status.channel === "slack"
      ? "Slack channel"
      : `${recipients} recipient${recipients === 1 ? "" : "s"}`;
    const idleThreshold = Number(status.thresholdMinutes || 15);
    const overEstimateThreshold = Number(status.overEstimateThresholdMinutes || 15);
    const pauses = Array.isArray(status.pauses) && status.pauses.length
      ? status.pauses
      : [{ label: "lunch", start: status.lunchStart || "11:00", end: status.lunchEnd || "11:30" }];
    const pauseText = pauses.map((pause) => `${pause.label || "pause"} ${formatClockRange(pause.start, pause.end)}`).join(", ");
    const schedule = `${formatClockRange(status.workStart || "07:00", status.workEnd || "15:30")}; ${pauseText}`;
    const timerPolicy = status.timerAutoStopEnabled ? "Timers auto-stop during pauses" : "Timer auto-stop off";
    const pendingRows = pending
      .slice(0, 3)
      .map((alert) => `
        <div class="alert-row">
          <strong>${escapeHtml(alert.workerName || alert.employee || "Worker")}</strong>
          <span>${escapeHtml(alert.completedTaskTitle || "Completed task")}</span>
        </div>
      `)
      .join("");
    const latest = history[0];

    return `
      <section class="panel alert-panel">
        <div class="panel-header dashboard-header">
          <div>
            <h2 class="panel-title">Alert layer</h2>
            <p class="summary-line">${escapeHtml(mode)} - ${escapeHtml(deliveryTarget)} - idle ${idleThreshold} min / estimate +${overEstimateThreshold} min</p>
          </div>
          <span class="status-pill${status.enabled ? "" : " paused"}">${status.enabled ? "Enabled" : "Dry run"}</span>
        </div>
        <div class="panel-body alert-grid">
          <div>
            <span class="field-label">Schedule</span>
            <strong>${escapeHtml(schedule)}</strong>
          </div>
          <div>
            <span class="field-label">Pending</span>
            <strong>${pending.length}</strong>
          </div>
          <div>
            <span class="field-label">Timer policy</span>
            <strong>${escapeHtml(timerPolicy)}</strong>
          </div>
        </div>
        ${pendingRows ? `<div class="panel-body alert-list">${pendingRows}</div>` : ""}
      </section>
    `;
  }

  function renderDashboardMetric(label, value) {
    return `
      <div class="dashboard-metric">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
    `;
  }

  function renderWorkerStatusRow(worker) {
    const activeTask = getWorkerActiveTask(worker);
    const pausedTask = getWorkerPausedTask(worker);
    const openCount = openTasks(worker.tasks).length;
    const workerStatus = activeTask ? "running" : pausedTask ? "paused" : "idle";
    const task = activeTask || pausedTask;
    const statusText = activeTask ? "Logged in" : pausedTask ? "Paused" : "Not logged in";
    const detailText = task
      ? `${task.title} - ${formatTimerState(getTaskTimer(task))}`
      : `${openCount} open task${openCount === 1 ? "" : "s"}`;

    return `
      <div class="worker-status-row">
        <div class="worker-status-person">
          <strong>${escapeHtml(worker.name)}</strong>
          <span>${escapeHtml(worker.email || worker.phase || "Worker")}</span>
        </div>
        <div class="worker-status-task">
          <span class="status-dot ${workerStatus}" aria-hidden="true"></span>
          <div>
            <strong>${escapeHtml(statusText)}</strong>
            <span>${escapeHtml(detailText)}</span>
          </div>
        </div>
        <div class="worker-status-time">
          <span class="field-label">${escapeHtml(actualTimeLabel())}</span>
          <strong>${escapeHtml(formatMinutes(workerActualLoggedMinutes(worker)))}</strong>
        </div>
        <div class="worker-status-actions">
          <button class="btn ghost" type="button" data-worker="${escapeAttr(worker.id)}">Details</button>
          <button class="btn icon-only" type="button" title="Copy ${escapeAttr(worker.name)} worker link" data-action="copy" data-url="${escapeAttr(employeeUrl(worker.id))}">${icons.copy}</button>
        </div>
      </div>
    `;
  }

  function renderWorkerSection(worker) {
    if (!worker) {
      const latest = state.latestTrackerDate && state.latestTrackerDate !== state.date
        ? `<div class="field-hint">Latest available tracker date: ${escapeHtml(formatLongDate(state.latestTrackerDate))}. Ask a manager to refresh the tracker before using today's worker page.</div>`
        : "";
      return `<div class="empty-state">No worker assignment snapshot matched this link.${latest}</div>`;
    }

    if (queryEmployee) {
      return `
        <section class="worker-focus">
          ${renderDailyProgress(worker)}
          <div class="task-list">
            ${renderTaskCards(worker.tasks, true)}
          </div>
        </section>
      `;
    }

    return `
      <div class="grid assignment-grid">
        <section class="task-list">
          ${renderTaskCards(worker.tasks, false)}
        </section>
        <aside class="panel">
          <div class="panel-header">
            <h2 class="panel-title">Snapshot</h2>
          </div>
          <div class="panel-body">
            ${renderWorkerStats(worker)}
            <div class="snapshot-detail">
              ${renderDetail("Cycle", worker.cycle)}
              ${renderDetail("Phase", worker.phase)}
              ${renderDetail("Work block", worker.workBlock)}
              ${renderDetail("Status", displayWorkerStatus(worker))}
              ${renderDetail("Email", worker.email)}
            </div>
          </div>
        </aside>
      </div>
    `;
  }

  function renderWorkerStats(worker) {
    const efficiency = workerDailyEfficiency(worker);
    return `
      <div class="metric-grid">
        ${renderMetric("Daily efficiency", efficiency.availableMinutes ? `${efficiency.percent}%` : "--")}
        ${renderMetric("Assigned", formatHours(worker.assignedHours))}
        ${renderMetric(actualTimeLabel(), formatMinutes(workerActualLoggedMinutes(worker)))}
        ${renderMetric("Complete", formatHours(worker.completedHours))}
        ${renderMetric("Remaining", formatHours(worker.remainingHours))}
        ${renderMetric("Scheduled elapsed", formatMinutes(efficiency.availableMinutes))}
        ${renderMetric("Tasks", `${worker.completedTaskCount || 0}/${worker.taskCount || worker.tasks.length}`)}
      </div>
    `;
  }

  function renderDailyProgress(worker) {
    const targetMinutes = 7.5 * 60;
    const completedMinutes = completedEstimatedMinutes(worker.tasks);
    const percent = Math.min(100, Math.round((completedMinutes / targetMinutes) * 100));

    return `
      <section class="progress-panel" aria-label="Daily estimated time progress">
        <div class="progress-copy">
          <span>Estimated complete</span>
          <strong>${escapeHtml(formatMinutes(completedMinutes))} / 7h 30m</strong>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width: ${percent}%"></div>
        </div>
        <div class="progress-percent">${percent}%</div>
      </section>
    `;
  }

  function renderTaskCards(tasks, locked) {
    const visibleTasks = locked ? openTasks(tasks) : tasks || [];

    if (!visibleTasks.length) {
      return `<div class="empty-state">${locked ? "All assigned tasks are complete." : "No assigned task breakdown rows in this snapshot."}</div>`;
    }

    return visibleTasks
      .slice()
      .sort((a, b) => Number(a.order || 9999) - Number(b.order || 9999))
      .map((task) => renderTaskCard(task, locked))
      .join("");
  }

  function renderTaskCard(task, locked) {
    const busy = state.actionTaskId === task.id;
    const sopUrl = safeExternalUrl(task.sopUrl);
    const sourceUrl = safeExternalUrl(task.sourceUrl);
    const trackerUrl = safeExternalUrl(task.trackerUrl);
    const hasSop = Boolean(sopUrl);
    const timer = getTaskTimer(task);
    const timerStartedAt = timer.startedAt;
    const loggedMinutes = timerElapsedMinutes(timer);
    const timerRunning = Boolean(timerStartedAt) && !task.completed;
    const timerHasTime = loggedMinutes > 0 && !task.completed;
    const startLabel = timerHasTime ? "Resume timer" : "Start timer";
    const estimateChip = renderEstimateChip(task);
    const taskActualMinutes = Number(task.actualTimeOnDateMinutes ?? task.actualTimeMinutes ?? 0);

    return `
      <article class="task-card${task.completed ? " done" : ""}">
        ${locked ? "" : `<input class="task-check" type="checkbox" aria-label="${escapeAttr(task.title)} complete" ${task.completed ? "checked" : ""} disabled />`}
        <div>
          <h3 class="task-title">${escapeHtml(task.title)}</h3>
          <div class="task-meta">
            <span class="chip blue">${escapeHtml(task.cycle || "Cycle")}</span>
            ${locked ? "" : `<span class="chip">${formatHours(task.assignedHours)}</span>`}
            ${locked ? "" : estimateChip}
            ${!locked && task.workedTimeRecovered ? `<span class="chip yellow">Worked this day</span>` : ""}
            ${!locked && task.ledgerBackfilled ? `<span class="chip yellow">Ledger</span>` : ""}
            ${!locked && taskActualMinutes ? `<span class="chip green">${formatMinutes(taskActualMinutes)} actual</span>` : ""}
            ${timerHasTime ? `<span class="chip green">${escapeHtml(formatTimerState(timer))}</span>` : ""}
            ${task.phase ? `<span class="chip yellow">${escapeHtml(task.phase)}</span>` : ""}
            ${task.vin ? `<span class="chip">VIN ${escapeHtml(task.vin)}</span>` : ""}
            <span class="status-pill${task.completed ? " done" : ""}">${task.completed ? "Done" : "Open"}</span>
          </div>
          ${
            locked
              ? `<div class="work-actions" data-task-id="${escapeAttr(task.id)}">
                  <a class="btn ${hasSop ? "ghost" : "disabled"}" ${hasSop ? `href="${escapeAttr(sopUrl)}" target="_blank" rel="noreferrer"` : ""} aria-disabled="${hasSop ? "false" : "true"}">${icons.open}<span>SOP</span></a>
                  <button class="btn ghost" type="button" data-action="start-timer" data-task-id="${escapeAttr(task.id)}" ${task.completed || timerRunning || busy ? "disabled" : ""}>${timerRunning ? "Running" : startLabel}</button>
                  ${timerRunning ? `<button class="btn ghost" type="button" data-action="stop-timer" data-task-id="${escapeAttr(task.id)}" ${task.completed || busy ? "disabled" : ""}>Stop</button>` : ""}
                  <button class="btn primary" type="button" data-action="complete-task" data-task-id="${escapeAttr(task.id)}" ${task.completed || !timerHasTime || busy ? "disabled" : ""}>${busy ? "Saving..." : "Complete"}</button>
                </div>`
              : ""
          }
        </div>
        <div class="task-actions">
          ${
            locked
              ? ""
              : `${trackerUrl ? `<a class="btn icon-only" title="Open tracker subtask" href="${escapeAttr(trackerUrl)}" target="_blank" rel="noreferrer">${icons.open}</a>` : ""}
                 ${sourceUrl ? `<a class="btn icon-only" title="Open source task" href="${escapeAttr(sourceUrl)}" target="_blank" rel="noreferrer">${icons.open}</a>` : ""}`
          }
        </div>
      </article>
    `;
  }

  function renderEstimateChip(task) {
    const minutes = Number(task.estimatedMinutes || 0);
    if (minutes <= 0) return "";
    return `<span class="chip">Remaining estimate ${escapeHtml(formatMinutes(minutes))}</span>`;
  }

  function renderLoading() {
    return `<div class="empty-state">Loading daily assignments...</div>`;
  }

  function renderMetric(label, value) {
    return `
      <div class="metric">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value || "0")}</strong>
      </div>
    `;
  }

  function renderDetail(label, value) {
    if (!value) return "";
    return `
      <div class="detail-row">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
    `;
  }

  function bindEvents() {
    document.querySelectorAll("[data-worker]").forEach((button) => {
      button.addEventListener("click", () => {
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.set("selected", button.dataset.worker);
        history.replaceState(null, "", nextUrl);
        render();
      });
    });

    document.querySelectorAll("[data-action='dashboard']").forEach((button) => {
      button.addEventListener("click", () => {
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.delete("selected");
        history.replaceState(null, "", nextUrl);
        render();
      });
    });

    document.querySelector("[data-action='refresh']")?.addEventListener("click", loadAssignments);

    document.querySelectorAll("[data-action='refresh-tracker']").forEach((button) => {
      button.addEventListener("click", () => startTrackerRefresh("fast", getSelectedWorker()));
    });
    document.querySelectorAll("[data-action='adopt-tasks']").forEach((button) => {
      button.addEventListener("click", () => startTrackerRefresh("adopt", getSelectedWorker()));
    });

    document.querySelectorAll("[data-action='copy']").forEach((button) => {
      button.addEventListener("click", () => {
        copyText(button.dataset.url);
      });
    });

    document.querySelector("[data-action='copy-selected']")?.addEventListener("click", () => {
      const worker = getSelectedWorker();
      if (worker) copyText(employeeUrl(worker.id));
    });

    document.querySelectorAll("[data-action='start-timer']").forEach((button) => {
      button.addEventListener("click", async () => {
        const worker = getSelectedWorker();
        if (!worker) return;
        await startWorkerTimer(worker.id, button.dataset.taskId);
      });
    });

    document.querySelectorAll("[data-action='stop-timer']").forEach((button) => {
      button.addEventListener("click", async () => {
        const worker = getSelectedWorker();
        if (!worker) return;
        await stopWorkerTimer(worker.id, button.dataset.taskId);
      });
    });

    document.querySelectorAll("[data-action='complete-task']").forEach((button) => {
      button.addEventListener("click", async () => {
        const worker = getSelectedWorker();
        if (!worker) return;
        await completeWorkerTask(worker.id, button.dataset.taskId);
      });
    });
  }

  async function startTrackerRefresh(mode = "fast", worker = null) {
    const workerFilter = refreshWorkerFilter(worker);
    state.trackerRefresh = {
      running: true,
      message:
        mode === "adopt"
          ? workerFilter
            ? `Adopting new tracked Asana tasks, then rebuilding ${worker.name}'s Daily Assignment Tracker snapshot.`
            : "Adopting new tracked Asana tasks into Airtable, then rebuilding Daily Assignment Tracker."
          : workerFilter
            ? `Refreshing assignments from Asana, then rebuilding ${worker.name}'s worker snapshot.`
            : "Refreshing assignments from Asana, then rebuilding Daily Assignment Tracker.",
      startedAt: new Date().toISOString(),
      step: "Starting",
      outputTail: "",
    };
    render();

    try {
      const response = await postJsonWithPin("/api/refresh-daily-tracker", { mode, workerFilter });
      const payload = await response.json();

      if (!response.ok && response.status !== 202) {
        throw new Error(payload.error || `Refresh failed with ${response.status}`);
      }

      applyRefreshStatus(payload);
      if (!payload.running && !state.trackerRefresh.message) {
        state.trackerRefresh.message = "Daily Assignment Tracker refresh started.";
      }
      render();
      pollTrackerRefresh();
    } catch (error) {
      state.trackerRefresh = {
        running: false,
        message: error.message || "Could not start Daily Assignment Tracker refresh.",
        startedAt: "",
        step: "",
        outputTail: "",
      };
      render();
    }
  }

  async function pollTrackerRefresh() {
    try {
      const response = await fetch("/api/refresh-daily-tracker");
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || `Refresh status failed with ${response.status}`);
      }

      if (payload.running) {
        applyRefreshStatus(payload);
        render();
        window.setTimeout(pollTrackerRefresh, 3000);
        return;
      }

      if (payload.error) {
        state.trackerRefresh = {
          running: false,
          message: payload.error,
          startedAt: payload.startedAt || "",
          step: payload.step || "",
          outputTail: payload.outputTail || "",
        };
        render();
        return;
      }

      state.trackerRefresh = {
        running: false,
        message: "Daily Assignment Tracker refreshed. Reloaded worker pages from Asana.",
        startedAt: payload.startedAt || "",
        step: "",
        outputTail: payload.outputTail || "",
      };
      await loadAssignments();
      state.trackerRefresh.message = "Daily Assignment Tracker refreshed. Worker pages are current.";
      render();
    } catch (error) {
      state.trackerRefresh = {
        running: false,
        message: error.message || "Could not check Daily Assignment Tracker refresh.",
        startedAt: "",
        step: "",
        outputTail: "",
      };
      render();
    }
  }

  function applyRefreshStatus(payload) {
    state.trackerRefresh = {
      running: Boolean(payload.running),
      message: payload.running
        ? formatRefreshMessage(payload)
        : payload.error || state.trackerRefresh.message || "",
      startedAt: payload.startedAt || state.trackerRefresh.startedAt || "",
      step: payload.step || "",
      outputTail: payload.outputTail || "",
    };
  }

  function formatRefreshMessage(payload) {
    const scoped = payload.workerFilter ? ` for ${payload.workerFilter}` : "";
    const fullRunHint = payload.workerFilter ? "" : " Full tracker rebuilds can take several minutes.";
    if (payload.step === "Asana poll") {
      return "Refreshing recent Asana assignment changes.";
    }
    if (payload.step === "Asana adoption") {
      return "Adopting new tracked Asana tasks into Airtable.";
    }
    if (payload.step === "Daily tracker rebuild") {
      return `Rebuilding Daily Assignment Tracker${scoped}.${fullRunHint}`;
    }
    return `Daily Assignment Tracker refresh is running.${fullRunHint}`;
  }

  function refreshStepLabel(step) {
    if (step === "Asana adoption") return "Finding new tasks";
    if (step === "Asana poll") return "Checking Asana changes";
    if (step === "Daily tracker rebuild") return "Updating worker pages";
    return step ? "Working" : "";
  }

  function refreshWorkerFilter(worker) {
    if (!worker) return "";
    return worker.email || worker.name || worker.id || "";
  }

  function serverWritesEnabledFor(employee) {
    if (state.source === "asana") return true;
    const ids = Array.isArray(state.authStatus.writeWorkerIds) ? state.authStatus.writeWorkerIds : [];
    return Boolean(state.authStatus.workerWritesEnabled && (ids.includes("*") || ids.includes(employee)));
  }

  async function startWorkerTimer(employee, taskId) {
    const activeTask = findActiveTimerTask(taskId);
    if (activeTask) {
      showToast(`Stop "${activeTask.title}" before starting another task.`);
      return;
    }

    if (!serverWritesEnabledFor(employee)) {
      const timer = startLocalTimer(state.timers[getTimerKey(taskId)], new Date());
      state.timers[getTimerKey(taskId)] = timer;
      applyTimerToTask(taskId, timer);
      saveLocalTimers();
      showToast("Timer started");
      render();
      return;
    }

    state.actionTaskId = taskId;
    render();

    try {
      const response = await postJsonWithPin("/api/worker-task-action", {
        employee,
        taskId,
        date: state.date,
        action: "start",
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Save failed with ${response.status}`);
      }

      const payload = await response.json();
      applyTimerToTask(taskId, {
        startedAt: payload.startedAt,
        accumulatedMinutes: payload.accumulatedMinutes || 0,
      });
      showToast("Timer started");
      state.actionTaskId = "";
      render();
    } catch (error) {
      state.actionTaskId = "";
      render();
      showToast(error.message || "Could not start timer");
    }
  }

  async function stopWorkerTimer(employee, taskId) {
    if (!serverWritesEnabledFor(employee)) {
      const timer = stopLocalTimer(getTaskTimerById(taskId), new Date());
      state.timers[getTimerKey(taskId)] = timer;
      applyTimerToTask(taskId, timer);
      saveLocalTimers();
      showToast("Timer stopped");
      render();
      return;
    }

    state.actionTaskId = taskId;
    render();

    try {
      const response = await postJsonWithPin("/api/worker-task-action", {
        employee,
        taskId,
        date: state.date,
        action: "stop",
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Save failed with ${response.status}`);
      }

      const payload = await response.json();
      applyTimerToTask(taskId, {
        startedAt: "",
        accumulatedMinutes: payload.accumulatedMinutes || payload.elapsedMinutes || 0,
      });
      showToast("Timer stopped");
      state.actionTaskId = "";
      render();
    } catch (error) {
      state.actionTaskId = "";
      render();
      showToast(error.message || "Could not stop timer");
    }
  }

  async function completeWorkerTask(employee, taskId) {
    if (!serverWritesEnabledFor(employee)) {
      updateSampleTask(taskId, getTaskTimerById(taskId));
      delete state.timers[getTimerKey(taskId)];
      saveLocalTimers();
      showToast("Sample task completed");
      render();
      return;
    }

    state.actionTaskId = taskId;
    render();

    try {
      const response = await postJsonWithPin("/api/worker-task-action", {
        employee,
        taskId,
        date: state.date,
        action: "complete",
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Save failed with ${response.status}`);
      }

      showToast("Task completed");
      await loadAssignments();
    } catch (error) {
      state.actionTaskId = "";
      render();
      showToast(error.message || "Could not save task");
    }
  }

  function updateSampleTask(taskId, timer) {
    for (const worker of state.workers) {
      const task = worker.tasks.find((item) => item.id === taskId);
      if (!task) continue;
      task.completed = true;
      task.timerStartedAt = "";
      task.timerAccumulatedMinutes = 0;
      task.actualTimeMinutes = timerElapsedMinutes(timer);
      worker.completedTaskCount = worker.tasks.filter((item) => item.completed).length;
      worker.completedHours = worker.tasks
        .filter((item) => item.completed)
        .reduce((sum, item) => sum + Number(item.assignedHours || 0), 0);
      worker.remainingHours = Math.max(0, Number(worker.assignedHours || 0) - worker.completedHours);
      return;
    }
  }

  function openTasks(tasks) {
    return (tasks || []).filter((task) => !task.completed);
  }

  function completedEstimatedMinutes(tasks) {
    return (tasks || [])
      .filter((task) => task.completed)
      .reduce((sum, task) => {
        const minutes = Number(task.estimatedMinutes || 0);
        if (minutes) return sum + minutes;
        return sum + Number(task.assignedHours || 0) * 60;
      }, 0);
  }

  function countOpenTasks() {
    return state.workers.reduce((sum, worker) => sum + openTasks(worker.tasks).length, 0);
  }

  function totalTaskCount() {
    return state.workers.reduce((sum, worker) => sum + Number(worker.taskCount || worker.tasks.length || 0), 0);
  }

  function completedTaskCount() {
    return state.workers.reduce((sum, worker) => sum + Number(worker.completedTaskCount || 0), 0);
  }

  function countActiveWorkers() {
    return state.workers.filter(getWorkerActiveTask).length;
  }

  function totalAssignedHours() {
    return state.workers.reduce((sum, worker) => sum + Number(worker.assignedHours || 0), 0);
  }

  function totalRemainingHours() {
    return state.workers.reduce((sum, worker) => sum + Number(worker.remainingHours || 0), 0);
  }

  function totalActualLoggedMinutes() {
    return state.workers.reduce((sum, worker) => sum + workerActualLoggedMinutes(worker), 0);
  }

  function managerSignals() {
    const workersWithWork = state.workers.filter((worker) => Number(worker.assignedHours || 0) > 0 || openTasks(worker.tasks).length);
    const runningCount = countActiveWorkers();
    const openTaskCount = countOpenTasks();
    const remainingHours = state.workers.reduce((sum, worker) => sum + Number(worker.remainingHours || 0), 0);
    const actualMinutes = totalActualLoggedMinutes();
    const targetMinutes = workersWithWork.length * 7.5 * 60;
    const pacingDeltaMinutes = targetMinutes ? actualMinutes - targetMinutes : 0;
    const outliers = visibleOutlierTasks();
    const workerSignals = workerAttentionSignals(workersWithWork);

    return {
      runningCount,
      pacingDeltaMinutes,
      pacingLabel: pacingLabel(pacingDeltaMinutes, targetMinutes),
      pacingValue: `${formatMinutes(actualMinutes)} / ${formatMinutes(targetMinutes)}`,
      pacingDetail: targetMinutes ? `${formatSignedMinutes(pacingDeltaMinutes)} vs 7h 30m per assigned worker` : "No assigned worker target for today",
      wipValue: `${openTaskCount} tasks`,
      wipDetail: `${formatHours(remainingHours)} remaining - ${runningCount} running now`,
      outlierValue: String(outliers.length),
      outlierDetail: outliers.length ? "Open tasks with PLH/outlier flags" : "No visible outlier flags",
      attentionValue: String(workerSignals.length),
      attentionDetail: workerSignals.length ? "Workers below pace, idle, or over assigned hours" : "No current pacing flags",
      outliers,
      workerSignals,
    };
  }

  function workerAttentionSignals(workers) {
    return workers
      .flatMap((worker) => {
        const actual = workerActualLoggedMinutes(worker);
        const assigned = Math.round(Number(worker.assignedHours || 0) * 60);
        const open = openTasks(worker.tasks);
        const openCount = open.length;
        const runningTask = getWorkerActiveTask(worker);
        const pausedTask = getWorkerPausedTask(worker);
        const running = Boolean(runningTask);
        const paused = Boolean(pausedTask);
        const remaining = Math.round(Number(worker.remainingHours || 0) * 60);
        const efficiency = workerDailyEfficiency(worker);
        const signals = [];

        if (actual >= assigned + 30 && assigned > 0) {
          signals.push({
            id: worker.id,
            name: worker.name,
            email: worker.email,
            category: "task",
            label: "Over estimate",
            level: "risk",
            score: 3,
            detail: `${formatMinutes(actual)} actual vs ${formatMinutes(assigned)} assigned`,
          });
        }
        if (!running && !paused && openCount) {
          signals.push({
            id: worker.id,
            name: worker.name,
            email: worker.email,
            category: "log",
            label: "Not logged in",
            level: "warn",
            score: 2,
            detail: `${openCount} open task${openCount === 1 ? "" : "s"} - ${formatMinutes(remaining)} remaining${openTaskSynopsis(open)}`,
          });
        }
        if (paused) {
          const hasConflict = Boolean(runningTask);
          signals.push({
            id: worker.id,
            name: worker.name,
            email: worker.email,
            category: "paused",
            label: hasConflict ? "Timer conflict" : "Paused",
            level: hasConflict ? "risk" : "warn",
            score: hasConflict ? 5 : 1,
            detail: hasConflict
              ? `Running ${runningTask.title || "a task"} while ${pausedTask.title || "another task"} is paused`
              : `${formatMinutes(actual)} ${actualTimeLabel().toLowerCase()}`,
          });
        }
        if (efficiency.hasWork && efficiency.availableMinutes && efficiency.percent < 75) {
          signals.push({
            id: worker.id,
            name: worker.name,
            email: worker.email,
            category: "pacing",
            label: "Below 75%",
            level: "risk",
            score: 4,
            detail: `${efficiency.percent}% - ${formatMinutes(efficiency.loggedMinutes)} logged + WIP / ${formatMinutes(efficiency.availableMinutes)} scheduled elapsed`,
          });
        }
        return signals;
      })
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  function visibleOutlierTasks() {
    const outliers = [];
    for (const worker of state.workers) {
      for (const task of openTasks(worker.tasks)) {
        const flag = outlierFlag(task);
        if (!flag) continue;
        outliers.push({
          workerName: worker.name,
          taskTitle: task.title || "Untitled task",
          flag,
        });
      }
    }
    return outliers;
  }

  function openTaskSynopsis(tasks) {
    const open = (tasks || []).slice(0, 3);
    if (!open.length) return "";
    const synopsis = open
      .map((task) => {
        const minutes = Number(task.estimatedMinutes || 0) || Math.round(Number(task.assignedHours || 0) * 60);
        const details = [];
        if (minutes) details.push(formatMinutes(minutes));
        if (task.vin) details.push(`VIN ${task.vin}`);
        return `${task.title || "Untitled task"}${details.length ? ` (${details.join(", ")})` : ""}`;
      })
      .join("; ");
    const extra = (tasks || []).length - open.length;
    return `: ${synopsis}${extra > 0 ? `; +${extra} more` : ""}`;
  }

  function outlierFlag(task) {
    const text = String(task.outlierFlag || task.plhOutlierFlag || task.outlierStatus || "").trim();
    if (!text || text === "-" || /^none$/i.test(text)) return "";
    return text;
  }

  function pacingLabel(deltaMinutes, targetMinutes) {
    if (!targetMinutes) return "No target";
    if (deltaMinutes >= 0) return "On pace";
    if (deltaMinutes <= -60) return "Behind pace";
    return "Watch pace";
  }

  function workerActualLoggedMinutes(worker) {
    const taskMinutes = (worker.tasks || []).reduce((sum, task) => {
      const sourceActual = Number(task.actualTimeOnDateMinutes ?? task.actualTimeMinutes ?? 0);
      const timerActual = task.completed ? 0 : timerElapsedMinutes(getTaskTimer(task));
      return sum + (task.completed ? sourceActual : Math.max(sourceActual, timerActual));
    }, 0);
    const workerMinutes = Math.round(Number(worker.actualTimeLoggedMinutes || Number(worker.actualTimeLoggedHours || worker.actualHours || 0) * 60 || 0));

    return Math.max(taskMinutes, workerMinutes);
  }

  function getWorkerActiveTask(worker) {
    return (worker.tasks || []).find((task) => !task.completed && Boolean(getTaskTimer(task).startedAt)) || null;
  }

  function getWorkerPausedTask(worker) {
    return (worker.tasks || []).find((task) => {
      if (task.completed) return false;
      const timer = getTaskTimer(task);
      return !timer.startedAt && timer.accumulatedMinutes > 0;
    }) || null;
  }

  function displayWorkerStatus(worker) {
    const openCount = openTasks(worker.tasks).length;
    if (openCount) return "Open";
    return worker.trackerStatus || "Complete";
  }

  function hasVisibleRunningTimer() {
    if (queryEmployee && getSelectedWorker()) return true;
    return state.workers.some(getWorkerActiveTask);
  }

  function applyTimerToTask(taskId, timer) {
    const normalized = normalizeLocalTimer(timer);
    for (const worker of state.workers) {
      const task = worker.tasks.find((item) => item.id === taskId);
      if (!task) continue;
      task.timerStartedAt = normalized.startedAt;
      task.timerAccumulatedMinutes = normalized.accumulatedMinutes;
      return;
    }
  }

  function getTaskTimer(task) {
    const taskTimer = normalizeLocalTimer({
      startedAt: task.timerStartedAt,
      accumulatedMinutes: task.timerAccumulatedMinutes,
    });
    if (taskTimer.startedAt || taskTimer.accumulatedMinutes) return taskTimer;
    const worker = getSelectedWorker();
    if (state.source === "asana" || serverWritesEnabledFor(worker && worker.id)) return taskTimer;
    return normalizeLocalTimer(state.timers[getTimerKey(task.id)]);
  }

  function getTaskTimerById(taskId) {
    for (const worker of state.workers) {
      const task = worker.tasks.find((item) => item.id === taskId);
      if (task) return getTaskTimer(task);
    }

    return normalizeLocalTimer(state.timers[getTimerKey(taskId)]);
  }

  function findActiveTimerTask(exceptTaskId) {
    const worker = getSelectedWorker();
    if (!worker) return null;

    return (worker.tasks || []).find((task) => {
      if (task.id === exceptTaskId || task.completed) return false;
      return Boolean(getTaskTimer(task).startedAt);
    });
  }

  function getSelectedWorker() {
    const selected = new URLSearchParams(window.location.search).get("selected");
    const desired = queryEmployee || selected;
    if (!desired) return null;
    return state.workers.find((worker) => worker.id === desired) || null;
  }

  function getEmployeeFromUrl() {
    return new URLSearchParams(window.location.search).get("employee");
  }

  function getDateFromUrl() {
    const value = new URLSearchParams(window.location.search).get("date") || "";
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
  }

  function employeeUrl(workerId) {
    return `${baseUrl()}?employee=${encodeURIComponent(workerId)}`;
  }

  function managerDateUrl(date) {
    const url = new URL(baseUrl(), window.location.origin);
    if (date && date !== today) {
      url.searchParams.set("date", date);
    }
    return `${url.pathname}${url.search}`;
  }

  function managerUrl() {
    return baseUrl();
  }

  function baseUrl() {
    return `${window.location.origin}${window.location.pathname}`;
  }

  async function postJsonWithPin(url, payload) {
    let response = await postJson(url, payload, state.authStatus.writePinRequired ? getWritePin() : "");

    if (response.status === 401) {
      sessionStorage.removeItem("dailyAssignmentPin.v1");
      state.authStatus.writePinRequired = true;
      response = await postJson(url, payload, getWritePin());
    }

    return response;
  }

  async function postJson(url, payload, pin) {
    const headers = {
      "Content-Type": "application/json",
    };
    if (pin) {
      headers["X-Daily-App-Pin"] = pin;
    }

    return fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  }

  function getWritePin() {
    const stored = sessionStorage.getItem("dailyAssignmentPin.v1");
    if (stored) return stored;

    const entered = window.prompt("Enter Daily Assignment app PIN");
    const pin = String(entered || "").trim();
    if (pin) {
      sessionStorage.setItem("dailyAssignmentPin.v1", pin);
    }
    return pin;
  }

  function safeExternalUrl(value) {
    const text = String(value || "").trim();
    if (!text) return "";

    try {
      const url = new URL(text, window.location.origin);
      if (url.protocol === "http:" || url.protocol === "https:") {
        return url.href;
      }
    } catch (error) {
      return "";
    }

    return "";
  }

  async function copyText(value) {
    const text = String(value || "");
    if (!text) {
      showToast("Nothing to copy");
      return false;
    }

    if (copyTextFallback(text)) {
      showToast("Link copied");
      return true;
    }

    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        throw new Error("Clipboard unavailable");
      }
      await navigator.clipboard.writeText(text);
      showToast("Link copied");
      return true;
    } catch (error) {
      showToast("Copy failed. Press and hold the link to copy.");
      return false;
    }
  }

  function copyTextFallback(value) {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "0";
    textarea.style.width = "1px";
    textarea.style.height = "1px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);

    try {
      return document.execCommand("copy");
    } catch (error) {
      return false;
    } finally {
      document.body.removeChild(textarea);
    }
  }

  function showToast(message) {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2200);
  }

  function getTodayIso() {
    const date = new Date();
    const local = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    return local.toISOString().slice(0, 10);
  }

  function formatRelativeTime(value) {
    const timestamp = new Date(value).getTime();
    if (!timestamp) return "unknown";
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 90) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;

    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(timestamp));
  }

  function formatLongDate(isoDate) {
    const date = new Date(`${isoDate}T00:00:00`);
    return new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(date);
  }

  function formatShortDate(isoDate) {
    const date = new Date(`${isoDate}T00:00:00`);
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(date);
  }

  function actualTimeLabel() {
    return state.date === today ? "Actual today" : "Actual logged";
  }

  function elapsedScheduledWorkMinutesForDate(isoDate) {
    const schedule = state.alertStatus || {};
    const day = new Date(`${isoDate || today}T00:00:00`);
    if (Number.isNaN(day.getTime())) return 0;

    const workEnd = dateAtClock(day, schedule.workEnd || "15:30");
    let cutoff = workEnd;
    if ((isoDate || today) === today) {
      const now = new Date();
      cutoff = new Date(Math.min(now.getTime(), workEnd.getTime()));
    } else if ((isoDate || today) > today) {
      cutoff = dateAtClock(day, schedule.workStart || "07:00");
    }

    return scheduledWorkMinutesBetween(
      dateAtClock(day, schedule.workStart || "07:00"),
      cutoff,
      schedule,
    );
  }

  function scheduledWorkMinutesBetween(startDate, endDate, schedule) {
    if (!(startDate instanceof Date) || !(endDate instanceof Date) || endDate <= startDate) return 0;

    let windows = [{ start: dateAtClock(startDate, schedule.workStart || "07:00"), end: dateAtClock(startDate, schedule.workEnd || "15:30") }];
    const pauses = Array.isArray(schedule.pauses) && schedule.pauses.length
      ? schedule.pauses
      : [{ label: "lunch", start: schedule.lunchStart || "11:00", end: schedule.lunchEnd || "11:30" }];

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

  function dateAtClock(day, clock) {
    const date = new Date(day);
    const minutes = clockToMinutes(clock);
    date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    return date;
  }

  function clockToMinutes(value) {
    const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return 0;
    return Number(match[1]) * 60 + Number(match[2]);
  }

  function formatHours(value) {
    const numeric = Number(value || 0);
    return `${formatNumber(numeric)}h`;
  }

  function formatMinutes(value) {
    const minutes = Number(value || 0);
    if (!minutes) return "0m";
    const hours = Math.floor(minutes / 60);
    const remainder = Math.round(minutes % 60);
    if (!hours) return `${remainder}m`;
    if (!remainder) return `${hours}h`;
    return `${hours}h ${remainder}m`;
  }

  function formatSignedMinutes(value) {
    const minutes = Math.round(Number(value || 0));
    if (!minutes) return "on pace";
    return `${minutes > 0 ? "+" : "-"}${formatMinutes(Math.abs(minutes))}`;
  }

  function formatClockRange(start, end) {
    return `${formatClock(start)}-${formatClock(end)}`;
  }

  function formatClock(value) {
    const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return String(value || "");

    const hour24 = Number(match[1]);
    const suffix = hour24 >= 12 ? "PM" : "AM";
    const hour12 = hour24 % 12 || 12;
    return `${hour12}:${match[2]} ${suffix}`;
  }

  function formatTimerState(timer) {
    const elapsed = timerElapsedMinutes(timer);
    return `${formatMinutes(elapsed)} ${timer.startedAt ? "running" : "logged"}`;
  }

  function formatElapsed(startedAt) {
    const start = new Date(startedAt).getTime();
    if (!start) return "0m";
    const seconds = Math.max(0, Math.round((Date.now() - start) / 1000));
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    if (!minutes) return `${remainder}s`;
    return `${minutes}m ${remainder.toString().padStart(2, "0")}s`;
  }

  function timerElapsedMinutes(timer) {
    const normalized = normalizeLocalTimer(timer);
    const accumulated = normalized.accumulatedMinutes;
    if (!normalized.startedAt) return accumulated;
    const running = Math.max(1, Math.round((Date.now() - new Date(normalized.startedAt).getTime()) / 60000));
    return accumulated + running;
  }

  function normalizeLocalTimer(timer) {
    if (!timer) return { startedAt: "", accumulatedMinutes: 0 };
    if (typeof timer === "string") return { startedAt: timer, accumulatedMinutes: 0 };
    return {
      startedAt: timer.startedAt || "",
      accumulatedMinutes: Number(timer.accumulatedMinutes || 0),
    };
  }

  function startLocalTimer(timer, now) {
    const normalized = normalizeLocalTimer(timer);
    if (!normalized.startedAt) normalized.startedAt = now.toISOString();
    return normalized;
  }

  function stopLocalTimer(timer, now) {
    const normalized = normalizeLocalTimer(timer);
    if (normalized.startedAt) {
      normalized.accumulatedMinutes = timerElapsedMinutes(normalized);
      normalized.startedAt = "";
    }
    return normalized;
  }

  function getTimerKey(taskId) {
    return `${state.date}::${queryEmployee || "admin"}::${taskId}`;
  }

  function loadLocalTimers() {
    try {
      return JSON.parse(localStorage.getItem("dailyAssignmentTimers.v1") || "{}");
    } catch (error) {
      return {};
    }
  }

  function saveLocalTimers() {
    localStorage.setItem("dailyAssignmentTimers.v1", JSON.stringify(state.timers));
  }

  function formatNumber(value) {
    const numeric = Number(value || 0);
    return numeric.toLocaleString(undefined, {
      maximumFractionDigits: 2,
      minimumFractionDigits: Number.isInteger(numeric) ? 0 : 2,
    });
  }

  function formatCompactNumber(value) {
    const numeric = Number(value || 0);
    return new Intl.NumberFormat(undefined, {
      notation: "compact",
      maximumFractionDigits: numeric >= 10000 ? 1 : 0,
    }).format(numeric);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }
})();
