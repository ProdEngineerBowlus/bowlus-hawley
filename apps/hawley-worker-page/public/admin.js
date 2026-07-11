(() => {
  const root = document.getElementById("admin-root");
  const state = {
    authStatus: null,
    activeView: "dashboard",
    dashboard: null,
    project: null,
    selectedCycle: "",
    selectedProductionId: "",
    loading: true,
    projectLoading: false,
    error: "",
    loginPending: false,
    loginError: "",
    createMessage: ""
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
  }

  function formatNumber(value) {
    const number = Number(value || 0);
    return Number.isFinite(number) ? number.toLocaleString() : "0";
  }

  function formatHours(value) {
    const number = Number(value || 0);
    return `${Number.isFinite(number) ? number.toFixed(number >= 10 ? 1 : 2) : "0"}h`;
  }

  function formatPercent(value) {
    const number = Number(value);
    return Number.isFinite(number) ? `${number.toFixed(1)}%` : "n/a";
  }

  function formatSignedHours(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "n/a";
    const sign = number > 0 ? "+" : "";
    return `${sign}${number.toFixed(Math.abs(number) >= 10 ? 1 : 2)}h`;
  }

  function formatSignedPercent(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "n/a";
    const sign = number > 0 ? "+" : "";
    return `${sign}${number.toFixed(1)}%`;
  }

  function formatDate(value) {
    if (!value) return "";
    const date = new Date(`${value}T12:00:00`);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function accountAuth() {
    return state.authStatus?.accountAuth || {};
  }

  function currentUser() {
    return accountAuth().user || null;
  }

  function adminAllowed() {
    const account = accountAuth();
    if (!account.active) return true;
    return Boolean(account.authenticated && account.user?.role === "admin");
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      headers: { Accept: "application/json", ...(options.headers || {}) },
      ...options
    });
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { message: text };
    }
    if (!response.ok) {
      const error = new Error(payload.message || `Request failed ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async function postJson(url, body) {
    return fetchJson(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(body || {})
    });
  }

  async function loadAuth() {
    state.authStatus = await fetchJson(`/api/auth-status?_=${Date.now()}`);
  }

  async function loadDashboard() {
    state.dashboard = await fetchJson(`/api/admin/dashboard?_=${Date.now()}`);
  }

  async function loadProjectCreator(options = {}) {
    const params = new URLSearchParams();
    if (options.cycle || state.selectedCycle) params.set("cycle", options.cycle || state.selectedCycle);
    if (options.productionRecordId || state.selectedProductionId) {
      params.set("productionRecordId", options.productionRecordId || state.selectedProductionId);
    }
    params.set("_", Date.now());
    state.projectLoading = true;
    render();
    try {
      state.project = await fetchJson(`/api/admin/project-creator?${params.toString()}`);
      state.selectedCycle = String(state.project.selectedCycleNumber || state.selectedCycle || "");
      state.selectedProductionId = state.project.preview?.schedule?.production_record_id || state.selectedProductionId || "";
      state.createMessage = "";
    } finally {
      state.projectLoading = false;
      render();
    }
  }

  async function loadAll() {
    state.loading = true;
    state.error = "";
    render();
    try {
      await loadAuth();
      if (adminAllowed()) {
        await Promise.all([loadDashboard(), loadProjectCreator()]);
      }
    } catch (error) {
      state.error = error.message || "Could not load Hawley Admin.";
    } finally {
      state.loading = false;
      render();
    }
  }

  async function handleLogin(form) {
    state.loginPending = true;
    state.loginError = "";
    render();
    try {
      const data = new FormData(form);
      const payload = await postJson("/api/auth/login", {
        username: data.get("username"),
        password: data.get("password")
      });
      state.authStatus = { ...(state.authStatus || {}), accountAuth: payload.accountAuth };
      await loadAll();
    } catch (error) {
      state.loginError = error.message || "Could not sign in.";
      state.loginPending = false;
      render();
    }
  }

  async function logout() {
    await postJson("/api/auth/logout", {});
    state.authStatus = { ...(state.authStatus || {}), accountAuth: { ...accountAuth(), authenticated: false, user: null } };
    state.dashboard = null;
    state.project = null;
    render();
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

  function pill(label, tone = "") {
    return `<span class="pill ${escapeAttr(tone)}">${escapeHtml(label)}</span>`;
  }

  function renderLogin() {
    return `
      <div class="auth-shell">
        <main class="auth-card">
          <div class="brand">
            <div class="brand-mark">HA</div>
            <div>
              <h1>Hawley Admin</h1>
              <p>Admin account required</p>
            </div>
          </div>
          <form class="auth-form" data-auth-form>
            <label class="field">
              <span>Email</span>
              <input type="email" name="username" autocomplete="username" required ${state.loginPending ? "disabled" : ""} />
            </label>
            <label class="field">
              <span>Password</span>
              <input type="password" name="password" autocomplete="current-password" required ${state.loginPending ? "disabled" : ""} />
            </label>
            ${state.loginError ? `<div class="error">${escapeHtml(state.loginError)}</div>` : ""}
            <button class="btn primary" type="submit" ${state.loginPending ? "disabled" : ""}>${state.loginPending ? "Signing in..." : "Sign in"}</button>
          </form>
        </main>
      </div>
    `;
  }

  function renderDenied() {
    const user = currentUser();
    return `
      <div class="auth-shell">
        <main class="auth-card">
          <div class="brand">
            <div class="brand-mark">HA</div>
            <div>
              <h1>Hawley Admin</h1>
              <p>${escapeHtml(user?.displayName || user?.email || "Signed in")}</p>
            </div>
          </div>
          <div class="notice risk" style="margin-top: 18px;">Admin access is required.</div>
          <div class="inline-actions" style="margin-top: 18px;">
            <a class="btn ghost" href="/">Live app</a>
            <button class="btn" type="button" data-action="logout">Logout</button>
          </div>
        </main>
      </div>
    `;
  }

  function renderTopbar() {
    const user = currentUser();
    const accountBadge = accountAuth().active && user
      ? `<span class="pill">${escapeHtml(user.displayName || user.email)} - ${escapeHtml(user.role || "admin")}</span>
         <button class="btn ghost" type="button" data-action="logout">Logout</button>`
      : "";
    return `
      <header class="admin-topbar">
        <div class="brand">
          <div class="brand-mark">HA</div>
          <div>
            <h1>Hawley Admin</h1>
            <p>Operations control layer</p>
          </div>
        </div>
        <nav class="nav-tabs" aria-label="Admin views">
          <button class="nav-tab ${state.activeView === "dashboard" ? "active" : ""}" type="button" data-view="dashboard">Dashboard</button>
          <button class="nav-tab ${state.activeView === "project" ? "active" : ""}" type="button" data-view="project">Project Creator</button>
        </nav>
        <div class="top-actions">
          <a class="btn ghost" href="/">Live app</a>
          <a class="btn ghost" href="/beta.html">Reporting</a>
          <button class="btn primary" type="button" data-action="reload">Reload</button>
          ${accountBadge}
        </div>
      </header>
    `;
  }

  function toneForPacingStatus(status) {
    const normalized = String(status || "").toLowerCase();
    if (normalized.includes("behind") || normalized.includes("off")) return "risk";
    if (normalized.includes("watch") || normalized.includes("risk")) return "warn";
    return "good";
  }

  function progressBar(label, value, tone = "good") {
    const number = Number(value);
    const width = Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
    return `
      <div class="progress-row">
        <div>
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(formatPercent(number))}</strong>
        </div>
        <div class="progress-track" aria-hidden="true">
          <span class="${escapeAttr(tone)}" style="width: ${width}%"></span>
        </div>
      </div>
    `;
  }

  function renderDebtBars(recovery) {
    const total = Math.max(Number(recovery?.totalPressureHours || 0), 0);
    const rows = [
      { label: "Current work", value: recovery?.currentHours, tone: "blue" },
      { label: "Carryover debt", value: recovery?.carryoverHours, tone: "warn" },
      { label: "Original debt", value: recovery?.originalDebtHours, tone: "risk" }
    ];
    return `
      <div class="debt-bars">
        ${rows.map(row => {
          const value = Math.max(Number(row.value || 0), 0);
          const width = total ? Math.max(2, Math.min(100, value / total * 100)) : 0;
          return `
            <div class="debt-bar-row">
              <span>${escapeHtml(row.label)}</span>
              <strong>${escapeHtml(formatHours(value))}</strong>
              <div class="progress-track" aria-hidden="true">
                <span class="${escapeAttr(row.tone)}" style="width: ${width}%"></span>
              </div>
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  function renderPlhSnapshot(plh) {
    const cycle = plh?.cycleStatus || {};
    const pacing = plh?.pacing || {};
    const recovery = plh?.recovery || {};
    const daily = plh?.daily || {};
    const pacingTone = toneForPacingStatus(pacing.status);
    return `
      <section class="plh-dashboard-panel">
        <div class="plh-header">
          <div>
            <h3 class="panel-title">Shop Pacing</h3>
            <p class="muted">${escapeHtml(cycle.label || "Current cycle")} - ${escapeHtml(formatDate(cycle.startDate))} to ${escapeHtml(formatDate(cycle.endDate))}</p>
          </div>
          <div class="chip-row">
            ${pill(pacing.status || "No signal", pacingTone)}
            ${pill(plh?.source || "Postgres", "blue")}
          </div>
        </div>
        <div class="plh-grid">
          <article class="plh-card pacing-card">
            <span>Cycle pacing</span>
            <strong>${escapeHtml(formatSignedHours(pacing.paceDeltaHours))}</strong>
            <small>${escapeHtml(formatSignedPercent(pacing.paceDeltaPct))} vs cycle progress</small>
            <div class="progress-stack">
              ${progressBar("Complete", pacing.completionPct, pacingTone)}
              ${progressBar("Cycle", pacing.cycleProgressPct, "blue")}
            </div>
          </article>
          <article class="plh-card">
            <span>Current load</span>
            <strong>${escapeHtml(formatHours(pacing.currentTotalLoadHours))}</strong>
            <small>${escapeHtml(formatHours(pacing.currentCompletedHours))} complete - ${escapeHtml(formatHours(pacing.currentRemainingHours))} remaining</small>
          </article>
          <article class="plh-card">
            <span>Cycle workdays</span>
            <strong>${escapeHtml(formatNumber(cycle.elapsedWorkday || 0))}/${escapeHtml(formatNumber(cycle.totalWorkdays || 0))}</strong>
            <small>${escapeHtml(formatNumber(cycle.remainingWorkdays || 0))} remaining</small>
          </article>
          <article class="plh-card">
            <span>Today</span>
            <strong>${escapeHtml(formatHours(daily.productiveHours))}</strong>
            <small>${escapeHtml(formatNumber(daily.workerCount))} workers - ${escapeHtml(formatNumber(daily.reviewRequiredCount))} reviews</small>
          </article>
        </div>
        <div class="debt-panel">
          <div>
            <h3 class="panel-title">Cycle Debt Hour Breakdown</h3>
            <p class="muted">${escapeHtml(formatHours(recovery.totalRecoveryDebtHours))} recovery debt - ${escapeHtml(formatHours(recovery.totalPressureHours))} total pressure</p>
          </div>
          ${renderDebtBars(recovery)}
        </div>
      </section>
    `;
  }

  function renderDashboard() {
    const latestRuns = state.dashboard?.latestRuns || [];
    const cycles = state.dashboard?.cycles || [];
    const phases = state.dashboard?.taskTemplatePhases || [];
    const plh = state.dashboard?.plh || {};
    const phasePacing = plh.phasePacing || [];
    const debtMatrix = plh.debtMatrix || [];
    return `
      <div class="content-stack">
        <section>
          <h2 class="section-title">Dashboard</h2>
          <p class="muted">Checked ${escapeHtml(new Date(state.dashboard?.checkedAt || Date.now()).toLocaleString())}</p>
        </section>
        ${renderPlhSnapshot(plh)}
        <section class="split-grid">
          <article class="panel">
            <div class="panel-header">
              <h3 class="panel-title">Phase Pacing</h3>
            </div>
            <div class="panel-body table-wrap">
              <table class="table">
                <thead><tr><th>Phase</th><th>Status</th><th>Complete</th><th>Cycle</th><th>Delta</th><th>Remaining</th></tr></thead>
                <tbody>
                  ${phasePacing.map(row => `
                    <tr>
                      <td>${escapeHtml(row.phaseName)}</td>
                      <td>${pill(row.status || "No signal", toneForPacingStatus(row.status))}</td>
                      <td>${escapeHtml(formatPercent(row.completionPct))}</td>
                      <td>${escapeHtml(formatPercent(row.cycleProgressPct))}</td>
                      <td>${escapeHtml(formatSignedHours(row.paceDeltaHours))}</td>
                      <td>${escapeHtml(formatHours(row.remainingHours))}</td>
                    </tr>
                  `).join("") || `<tr><td colspan="6">No current cycle phase pacing rows.</td></tr>`}
                </tbody>
              </table>
            </div>
          </article>
          <article class="panel">
            <div class="panel-header">
              <h3 class="panel-title">Cycle Debt By Phase</h3>
            </div>
            <div class="panel-body table-wrap">
              <table class="table">
                <thead><tr><th>Phase</th><th>Current</th><th>Carryover</th><th>Original</th><th>Total</th></tr></thead>
                <tbody>
                  ${debtMatrix.map(row => `
                    <tr>
                      <td>${escapeHtml(row.phaseName)}</td>
                      <td>${escapeHtml(formatHours(row.currentHours))}</td>
                      <td>${escapeHtml(formatHours(row.carryoverHours))}</td>
                      <td>${escapeHtml(formatHours(row.originalDebtHours))}</td>
                      <td>${escapeHtml(formatHours(row.totalPressureHours))}</td>
                    </tr>
                  `).join("") || `<tr><td colspan="5">No cycle debt rows.</td></tr>`}
                </tbody>
              </table>
            </div>
          </article>
        </section>
        <section class="split-grid">
          <article class="panel">
            <div class="panel-header">
              <h3 class="panel-title">Production Cycles</h3>
            </div>
            <div class="panel-body table-wrap">
              <table class="table">
                <thead><tr><th>Cycle</th><th>Dates</th><th>Rows</th><th>VINs</th><th>Phases</th><th>Links</th></tr></thead>
                <tbody>
                  ${cycles.map(row => `
                    <tr>
                      <td>${escapeHtml(row.cycle_label || `C${row.cycle_number}`)}</td>
                      <td>${escapeHtml(formatDate(row.start_date))} - ${escapeHtml(formatDate(row.end_date))}</td>
                      <td>${formatNumber(row.schedule_rows)}</td>
                      <td>${formatNumber(row.vin_count)}</td>
                      <td>${formatNumber(row.phase_count)}</td>
                      <td>${formatNumber(row.rev1_links)}</td>
                    </tr>
                  `).join("") || `<tr><td colspan="6">No cycle rows.</td></tr>`}
                </tbody>
              </table>
            </div>
          </article>
          <article class="panel">
            <div class="panel-header">
              <h3 class="panel-title">Task Template Phases</h3>
            </div>
            <div class="panel-body table-wrap">
              <table class="table">
                <thead><tr><th>Phase</th><th>Tasks</th><th>Hours</th><th>Missing</th></tr></thead>
                <tbody>
                  ${phases.map(row => `
                    <tr>
                      <td>${escapeHtml(row.phase_name)}</td>
                      <td>${formatNumber(row.task_count)}</td>
                      <td>${formatHours(row.estimatedHours)}</td>
                      <td>${formatNumber(row.missing_estimates)}</td>
                    </tr>
                  `).join("") || `<tr><td colspan="4">No task templates.</td></tr>`}
                </tbody>
              </table>
            </div>
          </article>
        </section>
        <section class="panel">
          <div class="panel-header">
            <h3 class="panel-title">Source Runs</h3>
          </div>
          <div class="panel-body table-wrap">
            <table class="table">
              <thead><tr><th>Job</th><th>Status</th><th>Ended</th><th>Read</th><th>Written</th><th>Errors</th></tr></thead>
              <tbody>
                ${latestRuns.map(row => `
                  <tr>
                    <td>${escapeHtml(row.job_name)}</td>
                    <td>${pill(row.status || "unknown", row.status === "success" ? "good" : "warn")}</td>
                    <td>${escapeHtml(row.ended_at ? new Date(row.ended_at).toLocaleString() : "")}</td>
                    <td>${formatNumber(row.records_read)}</td>
                    <td>${formatNumber(row.records_written)}</td>
                    <td>${formatNumber(row.error_count)}</td>
                  </tr>
                `).join("") || `<tr><td colspan="6">No runs.</td></tr>`}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    `;
  }

  function renderProjectCreator() {
    const project = state.project || {};
    const cycles = project.cycles || [];
    const scheduleRows = project.scheduleRows || [];
    const preview = project.preview || null;
    return `
      <div class="content-stack" id="project-creator">
        <section>
          <h2 class="section-title">Project Creator</h2>
          <div class="chip-row">
            ${pill(project.projectCreateEnabled ? "Write enabled" : "Preview mode", project.projectCreateEnabled ? "good" : "warn")}
            ${project.selectedCycleNumber ? pill(`C${project.selectedCycleNumber}`, "good") : ""}
            ${state.projectLoading ? pill("Loading", "warn") : ""}
          </div>
        </section>
        <section class="panel">
          <div class="panel-header">
            <h3 class="panel-title">Cycles</h3>
          </div>
          <div class="panel-body cycle-strip">
            ${cycles.map(row => `
              <button class="cycle-button ${String(row.cycle_number) === String(project.selectedCycleNumber) ? "active" : ""}" type="button" data-cycle="${escapeAttr(row.cycle_number)}">
                <strong>${escapeHtml(row.cycle_label || `C${row.cycle_number}`)}</strong>
                <span>${escapeHtml(formatDate(row.start_date))} - ${escapeHtml(formatDate(row.end_date))}</span>
                <span>${formatNumber(row.schedule_rows)} rows - ${formatNumber(row.vin_count)} VINs</span>
              </button>
            `).join("") || `<div class="notice">No production cycles.</div>`}
          </div>
        </section>
        <section class="creator-grid">
          <article class="panel">
            <div class="panel-header">
              <h3 class="panel-title">Schedule Rows</h3>
              <span class="pill">${formatNumber(scheduleRows.length)}</span>
            </div>
            <div class="panel-body schedule-list">
              ${scheduleRows.map(row => `
                <button class="schedule-row ${preview?.schedule?.production_record_id === row.production_record_id ? "active" : ""}" type="button" data-production-record-id="${escapeAttr(row.production_record_id)}">
                  <span>
                    <strong>${escapeHtml(row.vin ? `VIN ${row.vin}` : row.schedule_name || row.production_record_id)}</strong>
                    <span>${escapeHtml(row.phase_name || row.section_column || "No phase")} - ${escapeHtml(row.asana_section || "No section")}</span>
                    <span>${escapeHtml(formatDate(row.start_date))} - ${escapeHtml(formatDate(row.end_date))}</span>
                  </span>
                  <span class="pill">${formatNumber(row.existing_rev1_task_instance_links)}</span>
                </button>
              `).join("") || `<div class="notice">No schedule rows for this cycle.</div>`}
            </div>
          </article>
          <article class="panel">
            <div class="panel-header">
              <h3 class="panel-title">Preview</h3>
              <div class="panel-actions">
                ${preview ? pill(`${formatNumber(preview.taskCount)} tasks`, "good") : ""}
                ${preview ? pill(formatHours(preview.estimatedHours), "good") : ""}
              </div>
            </div>
            <div class="panel-body">
              ${preview ? renderPreview(preview) : `<div class="notice">No preview available.</div>`}
            </div>
          </article>
        </section>
      </div>
    `;
  }

  function renderPreview(preview) {
    const tasks = preview.tasks || [];
    return `
      <div class="content-stack">
        <div>
          <h3 class="section-title" style="font-size: 1.22rem;">${escapeHtml(preview.projectName)}</h3>
          <div class="chip-row" style="margin-top: 10px;">
            ${pill(preview.mode, preview.writeEnabled ? "good" : "warn")}
            ${preview.missingEstimates ? pill(`${formatNumber(preview.missingEstimates)} missing estimates`, "risk") : pill("Estimates ready", "good")}
            ${preview.schedule?.model_type ? pill(preview.schedule.model_type) : ""}
          </div>
        </div>
        <div class="metric-grid">
          ${metric("Tasks", formatNumber(preview.taskCount), preview.schedule?.phase_name || "")}
          ${metric("Estimated", formatHours(preview.estimatedHours), "batch time")}
          ${metric("VIN", preview.schedule?.vin || "No VIN", preview.schedule?.cycle_label || "")}
          ${metric("Dates", `${formatDate(preview.schedule?.start_date)} - ${formatDate(preview.schedule?.end_date)}`, `${formatNumber(preview.schedule?.days_in_cycle)} days`)}
        </div>
        <div class="inline-actions">
          <button class="btn primary" type="button" data-action="create-project" ${preview.writeEnabled ? "" : "disabled"}>Create project</button>
          ${state.createMessage ? `<span class="muted">${escapeHtml(state.createMessage)}</span>` : ""}
        </div>
        <div class="task-list">
          ${tasks.map(row => `
            <div class="task-row">
              <span class="pill">${escapeHtml(row.task_order ?? "")}</span>
              <span>
                <strong>${escapeHtml(row.task_name)}</strong>
                <small>${escapeHtml(row.parent_task_name || row.tasks_key || "")}</small>
              </span>
              <span>${formatHours(row.estimatedHours)}</span>
            </div>
          `).join("") || `<div class="notice">No matching task templates for this schedule row.</div>`}
        </div>
      </div>
    `;
  }

  function renderApp() {
    if (state.loading) {
      return `
        <div class="admin-shell">
          ${renderTopbar()}
          <main class="admin-main"><div class="notice">Loading Hawley Admin.</div></main>
        </div>
      `;
    }
    if (state.error) {
      return `
        <div class="admin-shell">
          ${renderTopbar()}
          <main class="admin-main"><div class="notice risk">${escapeHtml(state.error)}</div></main>
        </div>
      `;
    }
    return `
      <div class="admin-shell">
        ${renderTopbar()}
        <main class="admin-main">
          ${state.activeView === "project" ? renderProjectCreator() : renderDashboard()}
        </main>
      </div>
    `;
  }

  function render() {
    const account = accountAuth();
    if (account.active && !account.authenticated) {
      root.innerHTML = renderLogin();
      return;
    }
    if (!adminAllowed()) {
      root.innerHTML = renderDenied();
      return;
    }
    root.innerHTML = renderApp();
  }

  root.addEventListener("click", async event => {
    const viewButton = event.target.closest("[data-view]");
    if (viewButton) {
      state.activeView = viewButton.dataset.view === "project" ? "project" : "dashboard";
      render();
      return;
    }

    const cycleButton = event.target.closest("[data-cycle]");
    if (cycleButton) {
      state.selectedCycle = cycleButton.dataset.cycle || "";
      state.selectedProductionId = "";
      await loadProjectCreator({ cycle: state.selectedCycle, productionRecordId: "" });
      return;
    }

    const scheduleButton = event.target.closest("[data-production-record-id]");
    if (scheduleButton) {
      state.selectedProductionId = scheduleButton.dataset.productionRecordId || "";
      await loadProjectCreator({ productionRecordId: state.selectedProductionId });
      return;
    }

    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "reload") {
      await loadAll();
    } else if (action === "logout") {
      await logout();
    } else if (action === "create-project") {
      try {
        const payload = await postJson("/api/admin/project-creator/create", {
          productionRecordId: state.project?.preview?.schedule?.production_record_id
        });
        state.createMessage = payload.message || "Project created.";
      } catch (error) {
        state.createMessage = error.message || "Project creation is not available.";
      }
      render();
    }
  });

  root.addEventListener("submit", event => {
    const form = event.target.closest("[data-auth-form]");
    if (!form) return;
    event.preventDefault();
    handleLogin(form);
  });

  loadAll();
})();
