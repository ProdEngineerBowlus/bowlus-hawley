(() => {
  const root = document.getElementById("admin-root");
  const DASHBOARD_AUTO_REFRESH_MS = 60 * 1000;
  const IDEAL_PRODUCTIVE_HOURS_PER_WORKER_DAY = 7 + (40 / 60);
  let dashboardRefreshInFlight = false;
  const state = {
    authStatus: null,
    activeView: "dashboard",
    dashboard: null,
    project: null,
    projectType: "VIN",
    selectedCycle: "",
    selectedVin: "",
    projectName: "",
    projectNameDirty: false,
    loading: true,
    projectLoading: false,
    error: "",
    loginPending: false,
    loginError: "",
    createMessage: "",
    dashboardMessage: "",
    capacityPhase: "",
    capacityHours: "",
    capacityWorker: "",
    capacityPreview: null,
    capacityPlanIds: [],
    capacityStagedPlans: [],
    capacitySelectedActionIds: [],
    capacityLoading: false,
    capacityMessage: "",
    configurationOpen: false
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

  function formatHoursPrecise(value) {
    const number = Number(value);
    return Number.isFinite(number) ? `${number.toFixed(2)}h` : "--";
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

  function formatPaceIndex(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "n/a";
    return `${(number / 100).toFixed(1)}x`;
  }

  function formatDate(value) {
    if (!value) return "";
    const date = new Date(`${value}T12:00:00`);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function clamp(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.max(min, Math.min(max, number));
  }

  function formatWorkdays(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return "no pace";
    if (number < 1) return "<1d";
    return `${number.toFixed(number >= 10 ? 0 : 1)}d`;
  }

  function phaseShortName(value) {
    const raw = String(value || "Phase").replace(/\s+/g, " ").trim();
    const normalized = raw.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
    if (normalized === "A" || /\bPHASE A\b/.test(normalized) || normalized.includes("FRAME")) return "Frames";
    return raw
      .replace(/^Phase\s+/i, "")
      .trim() || "Phase";
  }

  function sparklinePath(points, width, height, maxValue) {
    const safePoints = points.length ? points : [0];
    const safeMax = Math.max(Number(maxValue) || 0, 1);
    return safePoints.map((point, index) => {
      const x = safePoints.length === 1 ? width / 2 : (index / (safePoints.length - 1)) * width;
      const y = height - (clamp(point, 0, safeMax) / safeMax) * height;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(" ");
  }

  function capacityPhaseKey(value) {
    const key = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (key.includes("fabrication") || key === "fab") return "fab";
    if (key.includes("frame") || key === "phasea") return "frames";
    if (key.includes("cnc")) return "cnc";
    const phase = key.match(/phase([b-h])/);
    return phase ? `phase${phase[1]}` : key;
  }

  function phaseGroupLetter(row) {
    const label = String(row?.phaseName || row?.phase || "").toUpperCase();
    const normalized = label.replace(/[^A-Z0-9]+/g, " ").trim();
    if (!normalized) return "";
    if (normalized.includes("FRAME")) return "A";
    const fabMatch = normalized.match(/\bFAB\s*([A-H])\b/);
    if (fabMatch) return fabMatch[1];
    const phaseMatch = normalized.match(/\bPHASE\s*([A-H])\b/);
    if (phaseMatch) return phaseMatch[1];
    const bareMatch = normalized.match(/^([A-H])(?:\b|$)/);
    return bareMatch ? bareMatch[1] : "";
  }

  function phaseDepartment(row) {
    const label = String(row?.phaseName || row?.phase || "").toUpperCase();
    const normalized = label.replace(/[^A-Z0-9]+/g, " ").trim();
    const letter = phaseGroupLetter(row);
    if (normalized.includes("FRAME") || letter === "A") return "frames";
    if (normalized.includes("FAB")) return "fabrication";
    if (["B", "C", "D", "E", "F"].includes(letter)) return "installation";
    if (letter === "G" || normalized.includes("POLISH")) return "polishing";
    if (letter === "H" || normalized.includes("SOQS")) return "soqs";
    return "other";
  }

  function buildEfficiencyGauge(label, rows, cycleProgress, note) {
    const safeRows = rows.filter(row => Number(row?.totalLoadHours || row?.completedHours || row?.remainingHours || 0) > 0);
    const totalLoad = safeRows.reduce((sum, row) => {
      const explicitTotal = Number(row.totalLoadHours);
      return sum + (Number.isFinite(explicitTotal) && explicitTotal > 0
        ? explicitTotal
        : Number(row.completedHours || 0) + Number(row.remainingHours || 0));
    }, 0);
    let hasExplicitTarget = false;
    const expectedLoad = safeRows.reduce((sum, row) => {
      const explicitTotal = Number(row.totalLoadHours);
      const rowTotal = Number.isFinite(explicitTotal) && explicitTotal > 0
        ? explicitTotal
        : Number(row.completedHours || 0) + Number(row.remainingHours || 0);
      const target = Number(row.trueCycleProgressPct ?? row.cycleProgressPct ?? cycleProgress);
      if (Number.isFinite(target)) hasExplicitTarget = true;
      return sum + (Number.isFinite(target) ? rowTotal * (target / 100) : 0);
    }, 0);
    const completed = safeRows.reduce((sum, row) => sum + Number(row.completedHours || 0), 0);
    const remaining = safeRows.reduce((sum, row) => sum + Number(row.remainingHours || 0), 0);
    const capacity = safeRows.reduce((sum, row) => sum + Number(row.capacityHours || 0), 0);
    const completionPct = totalLoad > 0 ? (completed / totalLoad) * 100 : null;
    const targetPct = totalLoad > 0 && hasExplicitTarget ? (expectedLoad / totalLoad) * 100 : Number(cycleProgress);
    const efficiencyPct = completionPct !== null && Number.isFinite(targetPct) && targetPct > 0
      ? (completionPct / targetPct) * 100
      : null;
    const capacityDelta = capacity - remaining;
    const phaseNames = [...new Set(safeRows
      .map(row => phaseShortName(row.phaseName || row.phase))
      .filter(Boolean))];
    const tone = efficiencyPct === null
      ? "neutral"
      : efficiencyPct >= 98
        ? "good"
        : efficiencyPct >= 82
          ? "warn"
          : "risk";

    return {
      label,
      note,
      tone,
      rows: safeRows.length,
      phaseText: phaseNames.length ? phaseNames.join(", ") : "No matching phases",
      totalLoad,
      completed,
      remaining,
      capacity,
      capacityDelta,
      completionPct,
      targetPct: Number.isFinite(targetPct) ? targetPct : null,
      efficiencyPct
    };
  }

  function renderEfficiencyGauge(gauge) {
    const completion = Number(gauge.completionPct);
    const paceIndex = Number(gauge.efficiencyPct);
    const fill = Number.isFinite(completion) ? clamp(completion, 0, 100) : 0;
    const value = Number.isFinite(completion) ? `${completion.toFixed(0)}%` : "n/a";
    const deltaTone = Number(gauge.capacityDelta || 0) >= 0 ? "Cushion" : "Gap";
    const completionText = gauge.completionPct === null ? "n/a" : formatPercent(gauge.completionPct);
    const targetText = gauge.targetPct === null ? "n/a" : formatPercent(gauge.targetPct);
    const paceText = formatPaceIndex(paceIndex);
    return `
      <article class="efficiency-card ${escapeAttr(gauge.tone)}">
        <div class="efficiency-dial" style="--dial-fill: ${fill.toFixed(1)}%;">
          <div class="efficiency-dial-core">
            <strong>${escapeHtml(value)}</strong>
            <span>complete</span>
          </div>
        </div>
        <div class="efficiency-copy">
          <span>${escapeHtml(gauge.note)}</span>
          <h4>${escapeHtml(gauge.label)}</h4>
          <p>${escapeHtml(completionText)} complete vs ${escapeHtml(targetText)} cycle pace</p>
        </div>
        <div class="efficiency-details">
          <span><em>Remaining</em>${escapeHtml(formatHours(gauge.remaining))}</span>
          <span><em>${escapeHtml(deltaTone)}</em>${escapeHtml(formatHours(Math.abs(gauge.capacityDelta || 0)))}</span>
          <span title="Pace Index = actual completion percent divided by expected cycle completion percent. 1.0x is on pace; below 1.0x is behind; above 1.0x is ahead."><em>Pace Index ⓘ</em>${escapeHtml(paceText)}</span>
        </div>
      </article>
    `;
  }

  function renderCycleEfficiencyGauges(rows, cycleProgress) {
    const withDepartments = rows.map(row => ({ row, department: phaseDepartment(row) }));
    const frameRows = withDepartments
      .filter(item => item.department === "frames")
      .map(item => item.row);
    const fabricationRows = withDepartments
      .filter(item => item.department === "fabrication")
      .map(item => item.row);
    const installationRows = withDepartments
      .filter(item => item.department === "installation")
      .map(item => item.row);
    const gauges = [
      buildEfficiencyGauge("Frames", frameRows, cycleProgress, "Phase A / Frames"),
      buildEfficiencyGauge("Fabrication", fabricationRows, cycleProgress, "FAB only"),
      buildEfficiencyGauge("Installation", installationRows, cycleProgress, "Phases B-F line work"),
      buildEfficiencyGauge("Shop", rows, cycleProgress, "All current shop load")
    ];

    return `
      <section class="efficiency-strip" aria-label="Cycle efficiency gauges">
        ${gauges.map(renderEfficiencyGauge).join("")}
      </section>
    `;
  }

  function renderPaceSparkline({ totalLoad, completed, remaining, workerCount, currentDailyPace, totalWorkdays, elapsedWorkdays, truePace, dropDeadStart }) {
    const width = 222;
    const height = 96;
    const days = Math.max(2, Math.round(Number(totalWorkdays) || 10));
    const safeTotal = Math.max(Number(totalLoad) || (Number(completed) || 0) + (Number(remaining) || 0), 1);
    const safeCompleted = Math.max(Number(completed) || 0, 0);
    const elapsed = clamp(Number(elapsedWorkdays) || 0, 0, days);
    const startIndex = clamp(Number(truePace?.startWorkdayIndex || 0), 0, days - 1);
    const trueWindowDays = Math.max(1, days - startIndex);
    const trueElapsed = clamp(Number(truePace?.elapsedWorkdays ?? elapsed) || 0, 0, trueWindowDays);
    const safeCurrentDaily = Number(currentDailyPace) || (trueElapsed > 0 ? safeCompleted / trueElapsed : 0);
    const targetDaily = IDEAL_PRODUCTIVE_HOURS_PER_WORKER_DAY * Math.max(Number(workerCount) || 0, 0);
    const targetPoints = Array.from({ length: days + 1 }, (_, boundary) => {
      if (boundary <= startIndex) return safeTotal;
      return Math.max(safeTotal - targetDaily * (boundary - startIndex), 0);
    });
    const pacePoints = Array.from({ length: days + 1 }, (_, boundary) => {
      if (boundary <= startIndex) return safeTotal;
      if (!safeCurrentDaily) return safeTotal;
      return Math.max(safeTotal - safeCurrentDaily * (boundary - startIndex), 0);
    });
    const currentRemaining = Math.max(Number(remaining) || safeTotal - safeCompleted, 0);
    const currentBoundary = clamp(Math.round(elapsed) - 1, 0, days);
    const markerX = (currentBoundary / days) * width;
    const maxValue = Math.max(safeTotal, ...targetPoints, ...pacePoints, 1);
    const markerY = height - (currentRemaining / maxValue) * height;
    const projectedRemainingAtEnd = pacePoints[pacePoints.length - 1] || 0;
    const currentDayLabel = `D${Math.max(1, Math.min(days, Math.round(elapsed) || 1))}/${days}`;
    const trueStartX = (startIndex / days) * width;
    const trueStartLabel = truePace?.hasOverride ? `start ${formatDate(truePace.trueStartDate)}` : "cycle start";
    const preStartWidth = truePace?.hasOverride ? Math.max(0, trueStartX) : 0;
    const dropDead = dropDeadStart || truePace?.dropDeadStart || {};
    const dropDeadIndex = Number(dropDead.workdayIndex);
    const hasDropDeadIndex = Number.isFinite(dropDeadIndex);
    const dropDeadX = hasDropDeadIndex ? (clamp(dropDeadIndex, 0, days) / days) * width : 0;
    const dropDeadOverdue = !dropDead.feasible || (hasDropDeadIndex && currentBoundary > dropDeadIndex);
    const dropDeadTone = dropDeadOverdue ? "var(--accent)" : "var(--blue)";
    const dropDeadLabel = dropDead.feasible && dropDead.date
      ? `last start ${formatDate(dropDead.date)}`
      : "start before cycle";

    return `
      <div class="pace-spark" title="Green is ideal productive capacity at 7h 40m per worker per workday. Yellow is current pace. The vertical marker is the last workday this load can start and still finish within the cycle.">
        <svg viewBox="0 0 ${width} ${height}" aria-hidden="true">
          ${preStartWidth ? `<rect x="0" y="0" width="${preStartWidth.toFixed(1)}" height="${height}" fill="rgba(115,199,242,0.08)" rx="3"></rect>` : ""}
          <line x1="0" y1="0" x2="${width}" y2="0" stroke="rgba(240,245,233,0.08)" stroke-width="1"></line>
          <line x1="0" y1="${(height / 2).toFixed(1)}" x2="${width}" y2="${(height / 2).toFixed(1)}" stroke="rgba(240,245,233,0.08)" stroke-width="1"></line>
          <line x1="0" y1="${height}" x2="${width}" y2="${height}" stroke="rgba(240,245,233,0.16)" stroke-width="1"></line>
          ${truePace?.hasOverride ? `<line x1="${trueStartX.toFixed(1)}" y1="0" x2="${trueStartX.toFixed(1)}" y2="${height}" stroke="var(--blue)" stroke-width="2" stroke-dasharray="4 3"></line>` : ""}
          <line x1="${markerX.toFixed(1)}" y1="0" x2="${markerX.toFixed(1)}" y2="${height}" stroke="rgba(240,245,233,0.16)" stroke-width="1" stroke-dasharray="3 4"></line>
          <rect x="${dropDeadX.toFixed(1)}" y="0" width="${Math.max(0, width - dropDeadX).toFixed(1)}" height="${height}" fill="${dropDeadTone}" opacity="0.08"></rect>
          <line x1="${dropDeadX.toFixed(1)}" y1="0" x2="${dropDeadX.toFixed(1)}" y2="${height}" stroke="${dropDeadTone}" stroke-width="3"></line>
          <path d="M${(dropDeadX - 5).toFixed(1)} 0 L${(dropDeadX + 5).toFixed(1)} 0 L${dropDeadX.toFixed(1)} 8 Z" fill="${dropDeadTone}"></path>
          <path d="${sparklinePath(targetPoints, width, height, maxValue)}" fill="none" stroke="var(--primary)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>
          <path d="${sparklinePath(pacePoints, width, height, maxValue)}" fill="none" stroke="var(--warn)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>
          ${truePace?.hasOverride ? `<circle cx="${trueStartX.toFixed(1)}" cy="7" r="4" fill="var(--blue)" stroke="rgba(16,20,15,0.92)" stroke-width="2"></circle>` : ""}
          <circle cx="${markerX.toFixed(1)}" cy="${markerY.toFixed(1)}" r="4.6" fill="var(--ink)" stroke="rgba(16,20,15,0.92)" stroke-width="2"></circle>
        </svg>
        <div class="pace-spark-meta">
          <span>ideal</span>
          <span>pace</span>
          <span>${escapeHtml(currentDayLabel)}</span>
          <span style="color: ${dropDeadTone}">${escapeHtml(dropDeadLabel)}</span>
        </div>
        <div class="pace-spark-note">${escapeHtml(trueStartLabel)} · current pace leaves ${escapeHtml(formatHours(projectedRemainingAtEnd))} open</div>
      </div>
    `;
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
      const error = new Error(payload.message || payload.error || `Request failed ${response.status}`);
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

  async function refreshDashboardSilently() {
    if (dashboardRefreshInFlight || document.hidden || !adminAllowed()) return;
    dashboardRefreshInFlight = true;
    try {
      await loadDashboard();
      if (state.activeView === "dashboard") render();
    } catch (error) {
      state.dashboardMessage = error.message || "Could not automatically refresh the dashboard.";
      if (state.activeView === "dashboard") render();
    } finally {
      dashboardRefreshInFlight = false;
    }
  }

  function startDashboardAutoRefresh() {
    window.setInterval(refreshDashboardSilently, DASHBOARD_AUTO_REFRESH_MS);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refreshDashboardSilently();
    });
  }

  async function loadProjectCreator(options = {}) {
    const params = new URLSearchParams();
    const projectType = options.projectType || state.projectType || "VIN";
    const cycle = options.cycle !== undefined ? options.cycle : state.selectedCycle;
    const vin = options.vin !== undefined ? options.vin : state.selectedVin;
    params.set("projectType", projectType);
    if (cycle) params.set("cycle", cycle);
    if (vin) params.set("vin", vin);
    if (state.projectNameDirty && state.projectName) params.set("projectName", state.projectName);
    params.set("_", Date.now());
    state.projectLoading = true;
    render();
    try {
      state.project = await fetchJson(`/api/admin/project-creator?${params.toString()}`);
      state.projectType = state.project.projectType || projectType;
      state.selectedCycle = String(state.project.selectedCycleNumber || state.selectedCycle || "");
      state.selectedVin = state.project.selectedVin ? String(state.project.selectedVin) : "";
      if (!state.projectNameDirty) state.projectName = state.project.preview?.projectName || "";
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
    if (normalized.includes("behind") || normalized.includes("off") || normalized.includes("no capacity")) return "risk";
    if (normalized.includes("watch") || normalized.includes("risk")) return "warn";
    return "good";
  }

  function surfaceTone(status) {
    const normalized = String(status || "").toLowerCase();
    if (normalized.includes("off") || normalized.includes("no capacity")) return "high";
    if (normalized.includes("risk") || normalized.includes("watch")) return "med";
    return "low";
  }

  function numberOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function computedPhaseStatus(phase, fallbackCycleProgress = null) {
    if (phase?.truePace?.status === "queued") return "Queued";
    const remaining = numberOrNull(phase?.remainingHours);
    const capacity = numberOrNull(phase?.capacityHours);

    if (remaining !== null && remaining <= 0.05) return "Complete";
    if (capacity !== null && capacity <= 0.05) return "Off Track";
    if (remaining !== null && capacity !== null && remaining > capacity + 0.05) return "Off Track";
    return "On Track";
  }

  function phasePaceSignal(phase, fallbackCycleProgress = null) {
    if (phase?.truePace?.status === "queued") return "Queued";
    const completion = numberOrNull(phase?.completionPct);
    const cycle = numberOrNull(phase?.trueCycleProgressPct) ?? numberOrNull(phase?.cyclePct) ?? numberOrNull(phase?.cycleProgressPct) ?? numberOrNull(fallbackCycleProgress);
    if (completion === null || cycle === null) return "No pace signal";
    return completion + 0.01 < cycle ? "Behind Pace" : "On Pace";
  }

  function truePaceChip(row) {
    const truePace = row?.truePace || {};
    if (!truePace.hasOverride) return "";
    if (truePace.status === "queued") return `Starts ${formatDate(truePace.trueStartDate)}`;
    const shift = Number(truePace.shiftWorkdays || 0);
    return shift > 0 ? `Shifted +${formatNumber(shift)}d` : `True start ${formatDate(truePace.trueStartDate)}`;
  }

  function matrixCell(value) {
    const number = Number(value || 0);
    const className = number > 0.05 ? "" : "zero";
    return `<td class="${className}">${escapeHtml(number > 0.05 ? formatHoursPrecise(number) : "-")}</td>`;
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

  function renderPhaseCycleBurnDown(plh) {
    const debt = plh?.debtTiers || {};
    const recovery = plh?.recovery || {};
    const diagnostics = plh?.diagnostics || {};
    const sourceLabel = diagnostics.phaseCycleLoadSource || debt.source || plh?.source || "missing PLH payload";
    const rows = debt.matrix || plh?.debtMatrix || [];
    const tiers = debt.tiers || recovery.tiers || {};
    const tierOrder = debt.tierOrder || ["current", "carryover", "original"];
    const visibleTiers = tierOrder
      .map(key => ({ key, ...(tiers[key] || {}) }))
      .filter(tier => tier.key && tiers[tier.key]);
    const visibleRows = rows.slice(0, 10);
    const hiddenCount = Math.max(rows.length - visibleRows.length, 0);
    const recoveryDebt = debt.totalRecoveryDebt ?? recovery.totalRecoveryDebtHours;
    const totalPressure = debt.totalPressure ?? recovery.totalPressureHours;
    return `
      <article class="panel visual-panel plh-reference-panel burn-panel">
        <div class="visual-head">
          <div>
            <h3 class="panel-title">Phase-Cycle Burn-Down</h3>
            <p class="muted">Phase work split by current cycle pressure, carryover cycle, and original recovery debt.</p>
          </div>
          <span class="section-tag">Phase Matrix</span>
        </div>
        <div class="burn-matrix-wrap">
          <table class="burn-matrix">
            <thead>
              <tr>
                <th>Phase</th>
                ${visibleTiers.map(tier => `<th>${escapeHtml(tier.shortLabel || tier.label || tier.key)}</th>`).join("")}
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              ${visibleRows.map(row => `
                <tr>
                  <td>${escapeHtml(phaseShortName(row.phaseName || row.phase))}</td>
                  ${visibleTiers.map(tier => matrixCell(row.tiers?.[tier.key] ?? row[tier.key])).join("")}
                  ${matrixCell(row.total ?? row.totalPressureHours)}
                </tr>
              `).join("") || `<tr><td colspan="${visibleTiers.length + 2}">No phase-cycle burn-down rows found yet. Source: ${escapeHtml(sourceLabel)}; PCL groups: ${escapeHtml(formatNumber(diagnostics.phaseCycleLoadGroupCount || 0))}; raw rows parsed: ${escapeHtml(formatNumber(diagnostics.rawPhaseCycleLoadParsedRowCount || 0))}/${escapeHtml(formatNumber(diagnostics.rawPhaseCycleLoadRowCount || 0))}; raw positive: ${escapeHtml(formatNumber(diagnostics.rawPhaseCycleLoadPositiveRowCount || 0))}.</td></tr>`}
            </tbody>
          </table>
        </div>
        <p class="matrix-meta">Recovery debt ${escapeHtml(formatHours(recoveryDebt))} excludes current-cycle work. Total pressure including current work is ${escapeHtml(formatHours(totalPressure))}.${hiddenCount ? ` ${escapeHtml(formatNumber(hiddenCount))} lower-pressure phase rows hidden.` : ""}</p>
      </article>
    `;
  }

  function renderScheduleAlignment(plh) {
    const alignment = plh?.scheduleAlignment || {};
    const currentCycleNumber = Number(alignment.currentCycleNumber || plh?.cycleStatus?.cycleNumber || 0);
    const rows = (alignment.rows || []).filter(row => Number(row.cycleNumber || 0) === currentCycleNumber);
    const phaseTotals = alignment.phaseTotals || [];
    const positionsByPhase = new Map();

    for (const row of rows) {
      const key = row.presentationPhaseName || row.phaseName || "Unassigned";
      const position = row.vin ? `VIN ${row.vin}` : (row.scheduleName || key);
      const prior = row.priorPhaseName
        ? `${row.priorCycleLabel || `C${Number(row.cycleNumber || 0) - 1}`} ${phaseShortName(row.priorPhaseName)} -> `
        : "";
      const label = `${position} (${prior}${row.cycleLabel || ""} ${phaseShortName(row.phaseName)})`;
      if (!positionsByPhase.has(key)) positionsByPhase.set(key, []);
      positionsByPhase.get(key).push(label);
    }

    return `
      <article class="panel visual-panel schedule-alignment-panel">
        <div class="visual-head">
          <div>
            <h3 class="panel-title">Production / Asana Mirror Check</h3>
            <p class="muted">Current schedule positions from Postgres, summed against linked Rev1 task instances and mirrored Asana rows.</p>
          </div>
          <span class="section-tag">Schedule Proof</span>
        </div>
        <div class="alignment-table-wrap">
          <table class="alignment-table">
            <thead>
              <tr>
                <th>Phase</th>
                <th>Current Position</th>
                <th>Tasks</th>
                <th>Mirror Hours</th>
                <th>Pace Bucket</th>
                <th>Off-Schedule Load</th>
                <th>Delta</th>
              </tr>
            </thead>
            <tbody>
              ${phaseTotals.map(row => {
                const totalDelta = Number(row.mirrorVsPhaseCycleTotalDeltaHours || 0);
                const doneDelta = Number(row.mirrorVsPhaseCycleCompletedDeltaHours || 0);
                const deltaClass = Math.abs(totalDelta) > 0.05 || Math.abs(doneDelta) > 0.05 ? "warn" : "ok";
                const positions = positionsByPhase.get(row.phaseName) || row.vins?.map(vin => `VIN ${vin}`) || [];
                const extraSamples = (row.extraTaskSamples || [])
                  .slice(0, 3)
                  .map(task => task?.name || task?.gid || "")
                  .filter(Boolean)
                  .join("; ");
                return `
                  <tr>
                    <td><strong>${escapeHtml(phaseShortName(row.phaseName))}</strong></td>
                    <td>${escapeHtml(positions.join(", ") || "No VIN position")}</td>
                    <td>${escapeHtml(formatNumber(row.rev1TaskCount))}/${escapeHtml(formatNumber(row.linkedTaskCount))} linked<br><small>${escapeHtml(formatNumber(row.asanaMirrorCount))} mirrored</small></td>
                    <td>${escapeHtml(formatHours(row.mirrorCompletedHours))} done<br><small>${escapeHtml(formatHours(row.mirrorTotalHours))} total</small></td>
                    <td>${escapeHtml(formatHours(row.phaseCycleCompletedHours))} done<br><small>${escapeHtml(formatHours(row.phaseCycleTotalHours))} total</small></td>
                    <td>${escapeHtml(formatHours(row.extraCompletedHours))} done<br><small>${escapeHtml(formatNumber(row.extraTaskCount))} tasks${extraSamples ? ` - ${escapeHtml(extraSamples)}` : ""}</small></td>
                    <td class="${escapeAttr(deltaClass)}">${escapeHtml(formatSignedHours(totalDelta))} total<br><small>${escapeHtml(formatSignedHours(doneDelta))} done</small></td>
                  </tr>
                `;
              }).join("") || `<tr><td colspan="7">No current-cycle production alignment rows found.</td></tr>`}
            </tbody>
          </table>
        </div>
      </article>
    `;
  }

  function renderPhasePaceProjection(plh) {
    const diagnostics = plh?.diagnostics || {};
    const sourceLabel = diagnostics.currentCyclePacingSource || diagnostics.phaseCycleLoadSource || plh?.debtTiers?.source || plh?.source || "missing PLH payload";
    const rows = plh?.phasePacing || [];
    const cycle = plh?.cycleStatus || {};
    const debt = plh?.debtTiers || {};
    const cycleProgress = Number(debt.cycleProgressPct ?? cycle.progressPct);
    const totalWorkdays = Number(debt.totalWorkdays ?? cycle.totalWorkdays);
    const remainingWorkdays = Number(debt.remainingWorkdays ?? cycle.remainingWorkdays);
    const elapsedWorkdays = Number.isFinite(cycleProgress) && cycleProgress > 0 && Number.isFinite(totalWorkdays)
      ? totalWorkdays * (cycleProgress / 100)
      : Number(cycle.elapsedWorkday || 0);
    const cycleLabel = debt.currentCycle || cycle.label || "Current";
    const cycleDates = [cycle.startDate, cycle.endDate].filter(Boolean).map(formatDate).join(" - ");
    const elapsedDay = Number(cycle.elapsedWorkday || elapsedWorkdays || 0);
    const cycleDays = Number.isFinite(totalWorkdays) && totalWorkdays > 0 ? Math.round(totalWorkdays) : 10;
    const cycleMeta = [
      { label: "Cycle", value: cycleLabel },
      { label: "Day", value: Number.isFinite(totalWorkdays) && totalWorkdays > 0 ? `${formatNumber(Math.round(elapsedDay))}/${formatNumber(cycleDays)}` : "n/a" },
      { label: "Cycle Days", value: Number.isFinite(totalWorkdays) && totalWorkdays > 0 ? `${formatNumber(cycleDays)} workdays` : "n/a" },
      { label: "Remaining", value: Number.isFinite(remainingWorkdays) ? `${formatNumber(remainingWorkdays)} days` : "n/a" },
      { label: "Progress", value: formatPercent(cycleProgress) }
    ];
    return `
      <article class="panel visual-panel plh-reference-panel pace-panel">
        <div class="visual-head">
          <div>
            <h3 class="panel-title">Phase Pace Projection</h3>
            <p class="muted">${escapeHtml(cycleLabel)}${cycleDates ? ` - ${escapeHtml(cycleDates)}` : ""}. Pace is projected against the current cycle's workday count.</p>
          </div>
          <span class="section-tag">Shop Pace</span>
        </div>
        <div class="pace-context" aria-label="Cycle pace context">
          ${cycleMeta.map(item => `
            <div class="pace-context-item">
              <span>${escapeHtml(item.label)}</span>
              <strong>${escapeHtml(item.value)}</strong>
            </div>
          `).join("")}
        </div>
        ${rows.length ? renderCycleEfficiencyGauges(rows, cycleProgress) : ""}
        <div class="phase-pace-list">
          ${rows.map(row => {
            const truePace = row.truePace || {};
            const targetProgress = Number(row.trueCycleProgressPct ?? row.cycleProgressPct ?? cycleProgress);
            const status = computedPhaseStatus(row, cycleProgress);
            const paceSignal = phasePaceSignal(row, cycleProgress);
            const paceSignalTone = paceSignal === "Behind Pace" ? "warn" : "good";
            const showPaceSignal = status !== "Queued" && status !== "Complete";
            const tone = toneForPacingStatus(status);
            const completed = Number(row.completedHours || 0);
            const remaining = Number(row.remainingHours || 0);
            const totalLoad = Number(row.totalLoadHours || completed + remaining || 0);
            const workerCount = Number(row.workerCount || 0);
            const hoursPerWorker = workerCount > 0 ? remaining / workerCount : null;
            const capacityHours = Number(row.capacityHours || 0);
            const trueRemainingWorkdays = Number(truePace.remainingWorkdays ?? remainingWorkdays);
            const trueElapsedWorkdays = Number(truePace.elapsedWorkdays ?? elapsedWorkdays);
            const trueTotalWorkdays = Number(truePace.totalWorkdays || cycleDays);
            const idealDailyCapacity = Number.isFinite(trueRemainingWorkdays) && trueRemainingWorkdays > 0
              ? capacityHours / trueRemainingWorkdays
              : null;
            const idealWorkdays = idealDailyCapacity && idealDailyCapacity > 0 ? remaining / idealDailyCapacity : null;
            const dailyPace = trueElapsedWorkdays && completed > 0 ? completed / trueElapsedWorkdays : null;
            const projectedWorkdays = dailyPace && dailyPace > 0 ? remaining / dailyPace : null;
            const progress = clamp(row.completionPct, 0, 100).toFixed(1);
            const expectedDone = Number(row.expectedCompletedHours);
            const paceDelta = Number(row.paceDeltaHours);
            const capacityDelta = Number(row.capacityDeltaSignedHours ?? row.capacityDeltaHours);
            const capacityLabel = row.capacityLabel || (Number.isFinite(capacityDelta) ? (capacityDelta >= 0 ? "Cushion" : "Gap") : "Capacity");
            const capacityDeltaText = Number.isFinite(capacityDelta) ? formatHours(Math.abs(capacityDelta)) : "n/a";
            const shiftChip = truePaceChip(row);
            const detailItems = [
              ["Load", formatHours(totalLoad)],
              ["Done", formatHours(completed)],
              ["Open", formatHours(remaining)],
              ["Capacity", formatHours(capacityHours)],
              ["Expected", Number.isFinite(expectedDone) ? formatHours(expectedDone) : "n/a"],
              ["Delta", Number.isFinite(paceDelta) ? formatSignedHours(paceDelta) : "n/a"],
              ["True target", Number.isFinite(targetProgress) ? formatPercent(targetProgress) : "n/a"],
              ["Cycle target", formatPercent(cycleProgress)]
            ];
            return `
              <div class="pace-row ${tone}">
                <div class="pace-phase">${escapeHtml(phaseShortName(row.phaseName || row.phase))}</div>
                <div class="pace-copy">
                  <div class="pace-status-line">
                    <strong>${escapeHtml(status)}</strong>
                    ${showPaceSignal ? `<span class="pace-signal-chip ${escapeAttr(paceSignalTone)}">${escapeHtml(paceSignal)}</span>` : ""}
                    ${shiftChip ? `<span class="pace-shift-chip">${escapeHtml(shiftChip)}</span>` : ""}
                  </div>
                  <small>${escapeHtml(formatHours(remaining))} remaining / ${escapeHtml(formatNumber(workerCount))} worker${workerCount === 1 ? "" : "s"} = ${escapeHtml(hoursPerWorker === null ? "--" : formatHours(hoursPerWorker))} per worker</small>
                  <small>ideal ${escapeHtml(formatWorkdays(idealWorkdays))} | current pace ${escapeHtml(formatWorkdays(projectedWorkdays))}${truePace.hasOverride ? ` | true window ${escapeHtml(formatNumber(trueElapsedWorkdays))}/${escapeHtml(formatNumber(trueTotalWorkdays))} days` : ""}</small>
                  <div class="pace-detail-grid">
                    ${detailItems.map(([label, value]) => `
                      <span><em>${escapeHtml(label)}</em>${escapeHtml(value)}</span>
                    `).join("")}
                  </div>
                </div>
                <div class="pace-meter">
                  <div class="pace-meter-track">
                    <span class="pace-meter-fill ${escapeAttr(tone)}" style="width: ${progress}%"></span>
                  </div>
                  <small>${escapeHtml(formatPercent(row.completionPct))} / ${escapeHtml(formatPercent(targetProgress))}</small>
                  <small>${escapeHtml(capacityLabel)}: ${escapeHtml(capacityDeltaText)}</small>
                </div>
                ${renderPaceSparkline({
                  totalLoad,
                  completed,
                  remaining,
                  workerCount,
                  currentDailyPace: dailyPace,
                  totalWorkdays: cycleDays,
                  elapsedWorkdays,
                  truePace,
                  dropDeadStart: row.dropDeadStart || truePace.dropDeadStart
                })}
              </div>
            `;
          }).join("") || `<div class="notice visual-empty">No Hawley current-cycle phase load rows found yet. Current-cycle load rows: ${escapeHtml(formatNumber(diagnostics.currentCycleLoadRowCount || 0))}; source: ${escapeHtml(sourceLabel)}.</div>`}
        </div>
      </article>
    `;
  }

  function renderLiveCapacitySurface(plh) {
    const diagnostics = plh?.diagnostics || {};
    const rows = plh?.phasePacing || [];
    const cycleProgress = plh?.debtTiers?.cycleProgressPct ?? plh?.cycleStatus?.progressPct;
    const headers = ["Phase", "Status", "Remaining", "Capacity", "Gap / Cushion", "Complete", "Cycle"];
    return `
      <article class="panel visual-panel plh-reference-panel capacity-panel">
        <div class="visual-head">
          <div>
            <h3 class="panel-title">Live Capacity Surface</h3>
            <p class="muted">Current phase capacity and remaining-work signal from Hawley's Postgres read model.</p>
          </div>
          <span class="section-tag">Tracker Surface</span>
        </div>
        <div class="surface-grid">
          ${headers.map(label => `<div class="surface-head">${escapeHtml(label)}</div>`).join("")}
          ${rows.flatMap(row => {
            const status = computedPhaseStatus(row, cycleProgress);
            const tone = surfaceTone(status);
            return [
              `<div class="surface-label">${escapeHtml(phaseShortName(row.phaseName || row.phase))}</div>`,
              `<div class="surface-cell ${tone}"><span class="surface-value">${escapeHtml(status)}</span></div>`,
              `<div class="surface-cell ${tone}"><span class="surface-value">${escapeHtml(formatHoursPrecise(row.remainingHours))}</span></div>`,
              `<div class="surface-cell ${tone}"><span class="surface-value">${escapeHtml(formatHoursPrecise(row.capacityHours))}</span></div>`,
              `<div class="surface-cell ${tone}"><span class="surface-value">${escapeHtml(row.capacityLabel || "Gap")}: ${escapeHtml(formatHoursPrecise(row.capacityDeltaHours))}</span></div>`,
              `<div class="surface-cell ${tone}"><span class="surface-value">${escapeHtml(formatPercent(row.completionPct))}</span></div>`,
              `<div class="surface-cell ${tone}"><span class="surface-value">${escapeHtml(formatPercent(row.cyclePct ?? row.cycleProgressPct ?? cycleProgress))}</span><span class="surface-note">${escapeHtml(formatNumber(row.workerCount || 0))} worker${Number(row.workerCount || 0) === 1 ? "" : "s"}</span></div>`
            ];
          }).join("") || `<div class="notice surface-empty visual-empty">No live capacity rows found from Hawley current-cycle phase load yet. Capacity phase groups: ${escapeHtml(formatNumber(diagnostics.capacityPresentationPhaseCount || 0))}; current-cycle load rows: ${escapeHtml(formatNumber(diagnostics.currentCycleLoadRowCount || 0))}.</div>`}
        </div>
      </article>
    `;
  }

  function renderPlhVisuals(plh) {
    return `
      <section class="plh-visual-grid">
        ${renderPhasePaceProjection(plh)}
        ${renderPhaseCycleBurnDown(plh)}
      </section>
    `;
  }

  function renderSourceRuns(latestRuns) {
    return `
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
    `;
  }

  function renderTruePaceControls(plh) {
    const truePace = plh?.truePace || {};
    const phases = truePace.phases || [];
    const cycleNumber = truePace.cycleNumber || plh?.cycleStatus?.cycleNumber || "";
    const minDate = truePace.cycleStartDate || plh?.cycleStatus?.startDate || "";
    const maxDate = truePace.cycleEndDate || plh?.cycleStatus?.endDate || "";
    return `
      <article class="panel config-inner-panel true-pace-panel">
        <div class="panel-header">
          <div>
            <h3 class="panel-title">True Pace Starts</h3>
            <p class="muted">Admin pacing overlay by dashboard phase label. This changes pace math only; task data stays untouched.</p>
          </div>
          <span class="pill ${Number(truePace.overrideCount || 0) ? "warn" : "good"}">${formatNumber(truePace.overrideCount || 0)} shifted</span>
        </div>
        <div class="panel-body table-wrap">
          <table class="table true-pace-table">
            <thead>
              <tr>
                <th>Phase Label</th>
                <th>Default</th>
                <th>Last Safe Start</th>
                <th>True Start</th>
                <th>Mode</th>
                <th>Shift</th>
                <th>Note</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${phases.map(row => {
                const trueStart = row.trueStartDate || row.defaultStartDate || minDate;
                const dropDead = row.dropDeadStart || {};
                const isJustInTime = row.startMode === "just_in_time";
                const shiftText = row.hasOverride
                  ? `${row.shiftWorkdays > 0 ? "+" : ""}${formatNumber(row.shiftWorkdays || 0)} workdays`
                  : "Default";
                return `
                  <tr data-true-pace-row data-cycle-number="${escapeAttr(cycleNumber)}" data-phase-label="${escapeAttr(row.phaseLabel)}" data-drop-dead-date="${escapeAttr(dropDead.date || "")}">
                    <td>
                      <strong>${escapeHtml(row.phaseLabel)}</strong>
                      ${row.hasOverride ? `<br><small>${escapeHtml(truePaceChip({ truePace: row }))}</small>` : ""}
                    </td>
                    <td>${escapeHtml(formatDate(row.defaultStartDate))}</td>
                    <td>
                      <strong>${escapeHtml(dropDead.feasible ? formatDate(dropDead.date) : "Before cycle")}</strong>
                      <br><small>${escapeHtml(dropDead.requiredWorkdays ? `${formatNumber(dropDead.requiredWorkdays)} workdays required` : dropDead.reason || "No signal")}</small>
                    </td>
                    <td>
                      <input class="table-input" type="date" data-true-pace-date min="${escapeAttr(minDate)}" max="${escapeAttr(maxDate)}" value="${escapeAttr(trueStart)}" />
                    </td>
                    <td>
                      <button class="btn ${isJustInTime ? "primary" : "ghost"} compact" type="button" data-action="true-pace-jit" ${dropDead.feasible && dropDead.date ? "" : "disabled"}>${isJustInTime ? "JIT on" : "Use JIT"}</button>
                    </td>
                    <td>${escapeHtml(shiftText)}</td>
                    <td>
                      <input class="table-input" type="text" data-true-pace-note value="${escapeAttr(row.note || "")}" placeholder="Reason" />
                    </td>
                    <td class="true-pace-actions">
                      <button class="btn primary compact" type="button" data-action="true-pace-save">Save</button>
                      <button class="btn ghost compact" type="button" data-action="true-pace-reset" ${row.hasOverride ? "" : "disabled"}>Reset</button>
                    </td>
                  </tr>
                `;
              }).join("") || `<tr><td colspan="8">No current phase labels available for this cycle.</td></tr>`}
            </tbody>
          </table>
        </div>
      </article>
    `;
  }

  function renderConfigurationDrawer(plh, latestRuns) {
    const diagnostics = plh?.diagnostics || {};
    return `
      <details class="config-drawer" ${state.configurationOpen ? "open" : ""}>
        <summary>
          <span>
            <strong>Configuration</strong>
            <small>${escapeHtml(diagnostics.currentCyclePacingSource || "source checks")}</small>
          </span>
          <span class="section-tag">Open</span>
        </summary>
        <div class="config-drawer-body">
          ${renderCapacityRecommendationControls(plh)}
          ${renderTruePaceControls(plh)}
          ${renderScheduleAlignment(plh)}
          <article class="panel config-inner-panel">
            <div class="panel-header">
              <h3 class="panel-title">Source Runs</h3>
            </div>
            ${renderSourceRuns(latestRuns)}
          </article>
        </div>
      </details>
    `;
  }

  function renderCapacityRecommendationControls(plh) {
    const phases = plh?.phasePacing || [];
    const workers = state.dashboard?.capacityWorkers || [];
    const preview = state.capacityPreview;
    const pace = preview?.pacePreview;
    const stagedWorkers = state.capacityPlanIds.length;
    const selectedPhase = state.capacityPhase || phases[0]?.phaseName || "";
    const selectedPhaseKey = capacityPhaseKey(selectedPhase);
    const eligibleWorkers = workers.map(worker => {
      const sourcePhase = phases.find(row => capacityPhaseKey(row.phaseName) === capacityPhaseKey(worker.home_section_column));
      const bankHours = Math.max(0, Number(worker.capacity_bank_remaining_hours || 0));
      const sourceCushion = Math.max(0, Number(sourcePhase?.capacityDeltaSignedHours || 0));
      return { ...worker, sourcePhase, bankHours, sourceCushion, transferableHours: Math.min(bankHours, sourceCushion) };
    }).filter(worker => capacityPhaseKey(worker.home_section_column) !== selectedPhaseKey && worker.transferableHours >= 0.25);
    if (state.capacityWorker && !eligibleWorkers.some(worker => worker.workforce_record_id === state.capacityWorker)) state.capacityWorker = "";
    return `
      <article class="panel config-inner-panel capacity-planner">
        <div class="panel-header">
          <div><h3 class="panel-title">Capacity Recommendation</h3><p class="muted">Preview qualified task moves before changing the live Asana schedule.</p></div>
          ${preview ? pill(preview.status === "committed" ? "Committed" : "Read-only preview", preview.status === "committed" ? "good" : "warn") : ""}
        </div>
        <div class="panel-body">
          <div class="capacity-controls">
            <label class="field"><span>Phase</span><select data-capacity-phase>${phases.map(row => `<option value="${escapeAttr(row.phaseName)}" ${row.phaseName === selectedPhase ? "selected" : ""}>${escapeHtml(row.phaseName)} · ${escapeHtml(row.capacityLabel)} ${formatHours(row.capacityDeltaHours)}</option>`).join("")}</select></label>
            <label class="field"><span>Worker</span><select data-capacity-worker><option value="">Automatic recommendation</option>${eligibleWorkers.map(worker => `<option value="${escapeAttr(worker.workforce_record_id)}" ${state.capacityWorker === worker.workforce_record_id ? "selected" : ""}>${escapeHtml(worker.worker_name)} · ${escapeHtml(worker.home_section_column || "No home phase")} · ${formatHours(worker.transferableHours)} safe</option>`).join("")}</select><small>${eligibleWorkers.length ? `${formatNumber(eligibleWorkers.length)} workers have bank and source-phase cushion.` : "No workers currently have safe transferable capacity."}</small></label>
            <label class="field"><span>Hours to ease</span><input data-capacity-hours type="number" min="0.25" max="80" step="0.25" value="${escapeAttr(state.capacityHours)}" placeholder="Auto from gap" /><small>Approximate task hours to move. Blank uses the current gap.</small></label>
            <button class="btn primary" type="button" data-action="capacity-preview" ${state.capacityLoading || !phases.length || !eligibleWorkers.length ? "disabled" : ""}>${state.capacityLoading ? "Building preview…" : "Generate preview"}</button>
          </div>
          ${stagedWorkers ? `<div class="notice good"><strong>Plan in progress:</strong> ${formatNumber(stagedWorkers)} worker${stagedWorkers === 1 ? "" : "s"} staged. Keep the task checkboxes you want, then add another worker or commit the combined plan. <button class="btn ghost" type="button" data-action="capacity-clear-plan">Clear staged plan</button></div>` : ""}
          ${renderStagedCapacitySchedule()}
          ${state.capacityMessage ? `<div class="notice ${state.capacityMessage.toLowerCase().includes("could") || state.capacityMessage.toLowerCase().includes("stale") ? "risk" : ""}">${escapeHtml(state.capacityMessage)}</div>` : ""}
          ${preview ? `
            ${preview.selectionMode === "manager_selected" && !(preview.actions || []).some(action => Number(action.completionCount || 0) > 0) ? `<div class="notice risk"><strong>Manager override:</strong> ${escapeHtml(preview.targetWorker?.name || "Selected worker")} has no prior completion evidence for these tasks. Review the declared skill and task list before committing.</div>` : ""}
            ${renderCapacityFlowStory(preview)}
            ${renderCapacityPreviewSparkline(pace, plh?.cycleStatus)}
            <div class="table-scroll"><table class="data-table capacity-task-table"><thead><tr><th>Keep</th><th>Task</th><th>Current</th><th>Proposed</th><th>Hours</th><th>Skill evidence</th></tr></thead><tbody>
              ${(preview.actions || []).map(action => `<tr><td><input type="checkbox" data-capacity-task-select data-action-id="${escapeAttr(action.actionId)}" ${state.capacitySelectedActionIds.includes(action.actionId) ? "checked" : ""} aria-label="Keep ${escapeAttr(action.taskName)} in plan" /></td><td><strong>${escapeHtml(action.taskName)}</strong></td><td>${escapeHtml(action.previousWorkerName || action.previousWorkerEmail || "Unassigned")}</td><td>${escapeHtml(action.targetWorkerName)}</td><td>${formatHours(action.estimatedHours)}</td><td><span class="skill-dot">${escapeHtml(action.requiredSkillLevel ?? "—")}</span> ${escapeHtml(action.capabilityReason)}</td></tr>`).join("")}
            </tbody></table></div>
            <div class="capacity-commit-row"><small>Preview expires ${escapeHtml(new Date(preview.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}. Commit rechecks every live assignee first.</small><div class="inline-actions"><button class="btn ghost" type="button" data-action="capacity-discard">Discard current preview</button><button class="btn ghost" type="button" data-action="capacity-add-worker" ${state.capacityLoading || !state.capacitySelectedActionIds.length ? "disabled" : ""}>Keep tasks &amp; add worker</button><button class="btn primary" type="button" data-action="capacity-commit" ${state.capacityLoading || preview.status !== "preview" || !state.capacitySelectedActionIds.length ? "disabled" : ""}>Commit ${stagedWorkers ? "combined " : ""}plan</button></div></div>
          ` : `<div class="notice">Choose a phase to generate a deterministic pace and task reassignment preview. Nothing changes until Commit is selected.${stagedWorkers ? " Select the next worker and generate their task list for the remaining gap." : ""}</div>`}
        </div>
      </article>`;
  }

  function renderStagedCapacitySchedule() {
    const plans = state.capacityStagedPlans || [];
    if (!plans.length) return "";
    const tasks = plans.flatMap(plan => plan.actions || []);
    const hours = tasks.reduce((sum, action) => sum + Number(action.estimatedHours || 0), 0);
    return `
      <details class="capacity-staged-schedule">
        <summary><strong>Staged schedule</strong><span>${formatNumber(plans.length)} worker${plans.length === 1 ? "" : "s"} · ${formatNumber(tasks.length)} task${tasks.length === 1 ? "" : "s"} · ${formatHours(hours)}</span></summary>
        <p class="muted">These are staged only. They are not reassigned in Asana until the combined plan is committed.</p>
        ${plans.map(plan => {
          const planHours = (plan.actions || []).reduce((sum, action) => sum + Number(action.estimatedHours || 0), 0);
          return `<section class="capacity-staged-worker"><header><strong>${escapeHtml(plan.workerName || "Worker")}</strong><span>${escapeHtml(plan.homePhase || "No home phase")} → ${escapeHtml(plan.phaseLabel || "Destination")} · ${formatHours(planHours)}</span></header><ul>${(plan.actions || []).map(action => `<li><strong>${escapeHtml(action.taskName)}</strong><span>${escapeHtml(action.previousWorkerName || action.previousWorkerEmail || "Unassigned")} → ${escapeHtml(action.targetWorkerName || plan.workerName || "Worker")} · ${formatHours(action.estimatedHours)}</span></li>`).join("")}</ul></section>`;
        }).join("")}
      </details>`;
  }

  function renderCapacityFlowStory(preview) {
    const pace = preview?.pacePreview || {};
    const target = preview?.targetWorker || {};
    const source = pace.sourcePhase;
    const priorOwners = [...new Set((preview.actions || []).map(action => action.previousWorkerName || action.previousWorkerEmail || "Unassigned"))];
    const ownerText = priorOwners.length > 2 ? `${priorOwners.slice(0, 2).join(", ")} +${priorOwners.length - 2}` : priorOwners.join(", ");
    const sourceLabel = source?.phaseLabel || target.homePhase || preview.phaseLabel;
    const sourceBefore = source ? formatSignedHours(source.beforeDeltaHours) : "same phase";
    const sourceAfter = source ? formatSignedHours(source.afterDeltaHours) : "unchanged";
    const sourceState = source && Number(source.beforeDeltaHours) >= 0 ? "cushion" : "gap";
    const destinationState = Number(pace.afterDeltaHours) >= 0 ? "cushion" : "gap";
    return `
      <div class="capacity-flow-story" aria-label="Capacity transfer story">
        <div class="capacity-flow-node source">
          <span>Capacity comes from</span>
          <strong>${escapeHtml(sourceLabel || "Worker bank")}</strong>
          <div class="capacity-flow-metrics">
            <span><em>Open load</em><b>${source ? formatHours(source.remainingHours) : "—"}</b></span>
            <span><em>Capacity before</em><b>${source ? formatHours(source.beforeCapacityHours) : "—"}</b></span>
            <span><em>${escapeHtml(sourceState)}</em><b>${sourceBefore}</b></span>
          </div>
          <small>After transfer: ${source ? `${formatHours(source.afterCapacityHours)} capacity · ${sourceAfter} ${sourceAfter.startsWith("-") ? "gap" : "cushion"}` : "capacity unchanged"}</small>
        </div>
        <div class="capacity-flow-person">
          <span>Float</span>
          <strong>${escapeHtml(target.name || "—")}</strong>
          <small>${formatHours(target.availableHours)} bank</small>
        </div>
        <div class="capacity-flow-arrow">
          <span>${formatHours(preview.recommendedHours)}</span>
          <i></i>
          <small class="capacity-task-count"><i aria-hidden="true"><b></b><b></b><b></b></i>${formatNumber(preview.actions?.length)} task${Number(preview.actions?.length) === 1 ? "" : "s"}</small>
        </div>
        <div class="capacity-flow-node destination">
          <span>Capacity goes to</span>
          <strong>${escapeHtml(preview.phaseLabel)}</strong>
          <div class="capacity-flow-metrics">
            <span><em>Open load</em><b>${formatHours(pace.remainingHours)}</b></span>
            <span><em>Capacity before</em><b>${formatHours(pace.beforeCapacityHours)}</b></span>
            <span><em>${escapeHtml(destinationState)}</em><b>${formatSignedHours(pace.afterDeltaHours)}</b></span>
          </div>
          <small>After transfer: ${formatHours(pace.afterCapacityHours)} capacity · ${formatSignedHours(pace.beforeDeltaHours)} → ${formatSignedHours(pace.afterDeltaHours)}</small>
        </div>
        <div class="capacity-flow-assignment"><span>Task ownership</span><strong>${escapeHtml(ownerText || "Unassigned")} → ${escapeHtml(target.name || "—")}</strong></div>
      </div>`;
  }

  function renderCapacityPreviewSparkline(pace, cycleStatus) {
    if (!pace) return "";
    const days = Math.max(1, Number(cycleStatus?.remainingWorkdays || 1));
    const load = Math.max(0, Number(pace.remainingHours || 0));
    const beforeCapacity = Math.max(0, Number(pace.beforeCapacityHours || 0));
    const afterCapacity = Math.max(0, Number(pace.afterCapacityHours || 0));
    const scale = Math.max(load, beforeCapacity, afterCapacity, 1);
    const loadPct = clamp(load / scale * 100, 0, 100);
    const bar = (label, capacity, delta, tone) => {
      const capacityPct = clamp(Math.min(capacity, load) / scale * 100, 0, 100);
      const cushionPct = clamp(Math.max(capacity - load, 0) / scale * 100, 0, 100);
      const gapPct = clamp(Math.max(load - capacity, 0) / scale * 100, 0, 100);
      const result = delta >= 0 ? `${formatHours(delta)} cushion` : `${formatHours(Math.abs(delta))} gap`;
      return `<div class="capacity-balance-row ${tone}">
        <div class="capacity-balance-label"><strong>${escapeHtml(label)}</strong><span>${formatHours(capacity)} capacity</span></div>
        <div class="capacity-balance-track">
          <div class="capacity-balance-load" style="width:${loadPct.toFixed(2)}%"></div>
          <div class="capacity-balance-fill" style="width:${capacityPct.toFixed(2)}%"></div>
          ${gapPct ? `<div class="capacity-balance-gap" style="left:${capacityPct.toFixed(2)}%;width:${gapPct.toFixed(2)}%"></div>` : ""}
          ${cushionPct ? `<div class="capacity-balance-cushion" style="left:${loadPct.toFixed(2)}%;width:${cushionPct.toFixed(2)}%"></div>` : ""}
          <i class="capacity-load-marker" style="left:${loadPct.toFixed(2)}%"></i>
        </div>
        <div class="capacity-balance-result ${delta >= 0 ? "good" : "risk-text"}">${escapeHtml(result)}</div>
      </div>`;
    };
    return `
      <div class="capacity-preview-spark" title="Compares required open load with capacity before and after the proposed reassignment.">
        <div class="capacity-spark-heading"><strong>${escapeHtml(pace.phaseLabel)} load versus capacity</strong><span>${formatHours(load)} open load · ${formatNumber(days)} workdays remaining</span></div>
        <div class="capacity-balance-scale"><span>0h</span><span class="load-key">Required load ${formatHours(load)}</span><span>${formatHours(scale)}</span></div>
        ${bar("Current", beforeCapacity, Number(pace.beforeDeltaHours || 0), "current")}
        ${bar("Projected", afterCapacity, Number(pace.afterDeltaHours || 0), "projected")}
        <div class="capacity-balance-legend"><span><i class="key capacity"></i>Covered by capacity</span><span><i class="key gap"></i>Uncovered gap</span><span><i class="key cushion"></i>Extra cushion</span></div>
        ${pace.sourcePhase ? `<div class="capacity-source-impact"><strong>Tradeoff</strong><span>${escapeHtml(pace.sourcePhase.phaseLabel)} moves from ${formatSignedHours(pace.sourcePhase.beforeDeltaHours)} to ${formatSignedHours(pace.sourcePhase.afterDeltaHours)} gap/cushion.</span></div>` : `<div class="capacity-source-impact"><strong>Internal rebalance</strong><span>Total phase capacity stays the same; the task load is redistributed between workers.</span></div>`}
      </div>`;
  }

  function renderDashboard() {
    const latestRuns = state.dashboard?.latestRuns || [];
    const plh = state.dashboard?.plh || {};
    const build = state.dashboard?.build || {};
    const buildLabel = build.label
      ? ` - ${build.label}${build.commit ? ` (${String(build.commit).slice(0, 7)})` : ""}`
      : "";
    return `
      <div class="content-stack">
        <section>
          <h2 class="section-title">Dashboard</h2>
          <p class="muted">Checked ${escapeHtml(new Date(state.dashboard?.checkedAt || Date.now()).toLocaleString())}${escapeHtml(buildLabel)}</p>
        </section>
        ${state.dashboard?.plh ? "" : `<div class="notice risk">The admin API response did not include the PLH payload. Server build: ${escapeHtml(build.label || "unknown")}.</div>`}
        ${state.dashboardMessage ? `<div class="notice">${escapeHtml(state.dashboardMessage)}</div>` : ""}
        ${renderPlhVisuals(plh)}
        ${renderConfigurationDrawer(plh, latestRuns)}
      </div>
    `;
  }

  function renderProjectCreator() {
    const project = state.project || {};
    const cycles = project.cycles || [];
    const scheduleRows = project.scheduleRows || [];
    const vinChoices = project.vinChoices || [];
    const preview = project.preview || null;
    const projectType = project.projectType || state.projectType || "VIN";
    const isVinProject = projectType === "VIN";
    const selectedVin = String(project.selectedVin || state.selectedVin || "");
    const projectName = state.projectName || preview?.projectName || "";
    const latestRun = (project.creationRuns || [])[0] || null;
    return `
      <div class="content-stack" id="project-creator">
        <section>
          <h2 class="section-title">Project Creator</h2>
          <div class="chip-row">
            ${pill(project.projectCreateEnabled ? "Write enabled" : "Preview mode", project.projectCreateEnabled ? "good" : "warn")}
            ${pill(projectType, "good")}
            ${project.selectedCycleNumber ? pill(`C${project.selectedCycleNumber}`, "good") : ""}
            ${selectedVin ? pill(`VIN ${selectedVin}`, "blue") : ""}
            ${state.projectLoading ? pill("Loading", "warn") : ""}
          </div>
          ${latestRun?.status === "failed" ? `<div class="notice risk-text" style="margin-top: 12px;"><strong>Latest create failed: ${escapeHtml(latestRun.project_name || "Unnamed project")}</strong><br>${escapeHtml(latestRun.error_message || "No failure detail was recorded.")}<div class="inline-actions" style="margin-top: 10px;"><button class="btn" type="button" data-action="cleanup-project-run" data-delete-asana="${latestRun.asana_project_gid ? "true" : "false"}" data-run-id="${escapeAttr(latestRun.project_creation_run_id)}">${latestRun.asana_project_gid ? "Delete failed Asana project and reset" : "Remove failed Hawley run"}</button></div></div>` : ""}
        </section>
        <section class="panel">
          <div class="panel-header">
            <h3 class="panel-title">Project Setup</h3>
            <span class="pill">${isVinProject ? "VIN portfolio" : "Fabrication portfolio"}</span>
          </div>
          <div class="panel-body project-setup-grid">
            <div>
              <span class="setup-label">Project type</span>
              <div class="segmented-control" role="group" aria-label="Project type">
                <button class="${isVinProject ? "active" : ""}" type="button" data-project-type="VIN">VIN Project</button>
                <button class="${!isVinProject ? "active" : ""}" type="button" data-project-type="Fabrication">Fabrication Project</button>
              </div>
            </div>
            <label class="field project-name-field">
              <span>Project name</span>
              <input type="text" data-project-name value="${escapeAttr(projectName)}" placeholder="${isVinProject ? "VIN 324" : "C12 - Fabrication"}" />
            </label>
          </div>
        </section>
        <section class="panel">
          <div class="panel-header">
            <h3 class="panel-title">${isVinProject ? "Cycle Context" : "Fabrication Cycle"}</h3>
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
              <h3 class="panel-title">${isVinProject ? "VINs" : "Fabrication Support Rows"}</h3>
              <span class="pill">${formatNumber(isVinProject ? vinChoices.length : scheduleRows.length)}</span>
            </div>
            <div class="panel-body schedule-list">
              ${isVinProject ? vinChoices.map(row => `
                <button class="schedule-row ${String(row.vin) === selectedVin ? "active" : ""}" type="button" data-vin-choice="${escapeAttr(row.vin)}">
                  <span>
                    <strong>VIN ${escapeHtml(row.vin)}</strong>
                    <span>${escapeHtml(row.firstCycleLabel || "")} start - ${escapeHtml(formatDate(row.firstStartDate))}</span>
                    <span>${formatNumber(row.scheduleRows)} schedule rows - ${escapeHtml((row.phases || []).slice(0, 8).join(", ") || "No phases")}</span>
                  </span>
                  <span class="pill">${escapeHtml(formatDate(row.lastEndDate))}</span>
                </button>
              `).join("") : scheduleRows.map(row => `
                <div class="schedule-row readonly">
                  <span>
                    <strong>${escapeHtml(row.schedule_name || row.phase_name || row.production_record_id)}</strong>
                    <span>${escapeHtml(row.phase_name || row.section_column || "No phase")} - ${escapeHtml(row.asana_section || "No section")}</span>
                    <span>${escapeHtml(formatDate(row.start_date))} - ${escapeHtml(formatDate(row.end_date))}</span>
                  </span>
                  <span class="pill">${formatNumber(row.existing_rev1_task_instance_links)}</span>
                </div>
              `).join("")}
              ${(isVinProject ? vinChoices : scheduleRows).length ? "" : `<div class="notice">${isVinProject ? "No VINs found in the production schedule." : "No fabrication support rows for this cycle."}</div>`}
            </div>
          </article>
          <article class="panel">
            <div class="panel-header">
              <h3 class="panel-title">Preview</h3>
              <div class="panel-actions">
                ${preview ? pill(`${formatNumber(preview.taskCount)} generated`, preview.taskCount ? "good" : "warn") : ""}
                ${preview ? pill(`${formatNumber(preview.creatableTaskCount)} creatable`, preview.creatableTaskCount ? "good" : "warn") : ""}
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
    const skipped = preview.skipped || {};
    const sourceCounts = preview.sourceCounts || {};
    const createBlocked = !preview.writeEnabled || !preview.creatableTaskCount || preview.existingLinkedScheduleRows || preview.existingSyncedTasks || preview.existingLegacyTasks || preview.existingNativePendingTasks;
    const projectName = state.projectName || preview.projectName;
    const scopeRows = preview.scheduleRows?.length ? preview.scheduleRows : (preview.schedule ? [preview.schedule] : []);
    const startDates = scopeRows.map(row => row.start_date).filter(Boolean).sort();
    const endDates = scopeRows.map(row => row.end_date).filter(Boolean).sort();
    const firstDate = startDates[0] || preview.schedule?.start_date || "";
    const lastDate = endDates[endDates.length - 1] || preview.schedule?.end_date || "";
    const cycleLabels = [...new Set(scopeRows.map(row => row.short_cycle_label || row.cycle_label).filter(Boolean))];
    const phaseLabels = [...new Set(scopeRows.map(row => row.phase_name || row.section_column || row.asana_section).filter(Boolean))];
    const scopeLabel = preview.projectType === "VIN"
      ? `VIN ${preview.selectedVin || ""}`.trim()
      : (cycleLabels.join(", ") || `C${preview.selectedCycleNumber || ""}`.trim());
    return `
      <div class="content-stack">
        <div>
          <h3 class="section-title" style="font-size: 1.22rem;">${escapeHtml(projectName)}</h3>
          <div class="chip-row" style="margin-top: 10px;">
            ${pill(preview.mode, preview.writeEnabled ? "good" : "warn")}
            ${preview.creationStrategy === "direct" ? pill("Direct Asana project", "blue") : ""}
            ${pill(preview.projectType || "Project", "good")}
            ${preview.selectedVin ? pill(`VIN ${preview.selectedVin}`, "blue") : ""}
            ${preview.selectedCycleNumber ? pill(`C${preview.selectedCycleNumber}`, "blue") : ""}
            ${preview.missingEstimates ? pill(`${formatNumber(preview.missingEstimates)} missing estimates`, "risk") : pill("Estimates ready", "good")}
            ${preview.existingSyncedTasks ? pill(`${formatNumber(preview.existingSyncedTasks)} already in Asana`, "risk") : ""}
            ${preview.existingLegacyTasks ? pill(`${formatNumber(preview.existingLegacyTasks)} legacy rows exist`, "risk") : ""}
            ${preview.existingNativePendingTasks ? pill(`${formatNumber(preview.existingNativePendingTasks)} Hawley pending`, "warn") : ""}
            ${preview.existingLinkedScheduleRows ? pill(`${formatNumber(preview.existingLinkedScheduleRows)} Production rows already instantiated`, "risk") : ""}
            ${phaseLabels.length ? pill(`${phaseLabels.length} phases`) : ""}
          </div>
        </div>
        <div class="metric-grid">
          ${metric("Tasks", formatNumber(preview.taskCount), `${formatNumber(scopeRows.length)} schedule rows`)}
          ${metric("Creatable", formatNumber(preview.creatableTaskCount), "not Asana-linked")}
          ${metric("Estimated", formatHours(preview.estimatedHours), "batch time")}
          ${metric("Scope", scopeLabel || "No scope", phaseLabels.slice(0, 3).join(", "))}
          ${metric("Dates", `${formatDate(firstDate)} - ${formatDate(lastDate)}`, cycleLabels.slice(0, 3).join(", "))}
        </div>
        <div class="metric-grid small-metrics">
          ${metric("Source tasks", formatNumber(sourceCounts.taskTemplates), "active templates")}
          ${metric("VIN records", formatNumber(sourceCounts.vins), "model/frame rules")}
          ${metric("Models", formatNumber(sourceCounts.models), "lookup names")}
          ${metric("VIN anchors", formatNumber(sourceCounts.vinAnchors), "A-H schedule anchors")}
          ${metric("Existing", formatNumber(sourceCounts.existingForSchedule), "in scope")}
        </div>
        <div class="chip-row">
          ${skipped.missingVinAnchor ? pill(`${formatNumber(skipped.missingVinAnchor)} no VIN anchor`, "warn") : ""}
          ${skipped.missingProductionVin ? pill(`${formatNumber(skipped.missingProductionVin)} no production VIN`, "warn") : ""}
          ${skipped.missingVinRecord ? pill(`${formatNumber(skipped.missingVinRecord)} VINs missing`, "risk") : ""}
          ${skipped.modelFrameMismatch ? pill(`${formatNumber(skipped.modelFrameMismatch)} model/frame filtered`, "warn") : ""}
          ${skipped.outsideProjectScope ? pill(`${formatNumber(skipped.outsideProjectScope)} outside scope`, "warn") : ""}
        </div>
        <div class="inline-actions">
          <button class="btn primary" type="button" data-action="create-project" ${createBlocked ? "disabled" : ""}>Create Project</button>
          ${state.createMessage ? `<span class="muted">${escapeHtml(state.createMessage)}</span>` : ""}
        </div>
        <div class="task-list">
          ${tasks.map(row => `
            <div class="task-row">
              <span class="pill">${escapeHtml(row.task_order ?? "")}</span>
              <span>
                <strong>${escapeHtml(row.task_name)}</strong>
                <small>${escapeHtml([row.parent_task_name || row.tasks_key || "", row.phaseLabel || "", row.schedule?.short_cycle_label || row.schedule?.cycle_label || "", row.vin ? `VIN ${row.vin}` : "", row.vinSource ? `source ${row.vinSource}` : ""].filter(Boolean).join(" - "))}</small>
              </span>
              <span>
                ${formatHours(row.estimatedHours)}
                ${row.existingAsanaTaskGid ? `<small class="risk-text">Asana-linked</small>` : ""}
                ${row.existingTaskInstanceId && !row.existingAsanaTaskGid && row.existingSourceSystem !== "hawley_project_creator" ? `<small class="risk-text">legacy row exists</small>` : ""}
              </span>
            </div>
          `).join("") || `<div class="notice">No matching task templates for this project scope.</div>`}
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
      state.projectName = "";
      state.projectNameDirty = false;
      if (state.projectType === "VIN") state.selectedVin = "";
      await loadProjectCreator({ cycle: state.selectedCycle, vin: state.selectedVin });
      return;
    }

    const typeButton = event.target.closest("[data-project-type]");
    if (typeButton) {
      state.projectType = typeButton.dataset.projectType === "Fabrication" ? "Fabrication" : "VIN";
      state.projectName = "";
      state.projectNameDirty = false;
      if (state.projectType === "Fabrication") state.selectedVin = "";
      await loadProjectCreator({ projectType: state.projectType, vin: state.selectedVin });
      return;
    }

    const vinButton = event.target.closest("[data-vin-choice]");
    if (vinButton) {
      state.selectedVin = vinButton.dataset.vinChoice || "";
      state.projectName = "";
      state.projectNameDirty = false;
      await loadProjectCreator({ vin: state.selectedVin });
      return;
    }

    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "reload") {
      await loadAll();
    } else if (action === "logout") {
      await logout();
    } else if (action === "capacity-preview") {
      state.capacityLoading = true;
      state.capacityMessage = "";
      render();
      try {
        state.capacityPreview = await postJson("/api/admin/capacity-recommendations/preview", {
          phaseLabel: state.capacityPhase || state.dashboard?.plh?.phasePacing?.[0]?.phaseName || "",
          hours: state.capacityHours || undefined,
          targetWorkerRecordId: state.capacityWorker || undefined,
          priorRecommendationIds: state.capacityPlanIds
        });
        state.capacitySelectedActionIds = (state.capacityPreview.actions || []).map(action => action.actionId);
        state.capacityMessage = `Preview ready: ${state.capacityPreview.actions?.length || 0} task moves.`;
      } catch (error) {
        state.capacityPreview = null;
        state.capacitySelectedActionIds = [];
        state.capacityMessage = error.message || "Could not build a recommendation preview.";
      } finally {
        state.capacityLoading = false;
        render();
      }
    } else if (action === "capacity-clear-plan") {
      const planIds = [...new Set([...state.capacityPlanIds, state.capacityPreview?.recommendationId].filter(Boolean))];
      state.capacityLoading = true;
      render();
      try {
        await Promise.all(planIds.map(id => postJson(`/api/admin/capacity-recommendations/${id}/selection`, { actionIds: [] })));
        state.capacityPlanIds = [];
        state.capacityStagedPlans = [];
        state.capacityPreview = null;
        state.capacitySelectedActionIds = [];
        state.capacityMessage = "Staged plan cleared. No schedule changes were made.";
      } catch (error) {
        state.capacityMessage = error.message || "Could not clear the staged plan.";
      } finally {
        state.capacityLoading = false;
        render();
      }
    } else if (action === "capacity-discard") {
      const preview = state.capacityPreview;
      if (!preview) return;
      state.capacityLoading = true;
      render();
      try {
        await postJson(`/api/admin/capacity-recommendations/${preview.recommendationId}/selection`, { actionIds: [] });
        state.capacityPreview = null;
        state.capacitySelectedActionIds = [];
        state.capacityMessage = "Preview discarded. No schedule changes were made.";
      } catch (error) {
        state.capacityMessage = error.message || "Could not discard the preview.";
      } finally {
        state.capacityLoading = false;
        render();
      }
    } else if (action === "capacity-add-worker") {
      const preview = state.capacityPreview;
      if (!preview || !state.capacitySelectedActionIds.length) return;
      state.capacityLoading = true;
      render();
      try {
        await postJson(`/api/admin/capacity-recommendations/${preview.recommendationId}/selection`, { actionIds: state.capacitySelectedActionIds });
        const selectedActions = (preview.actions || []).filter(action => state.capacitySelectedActionIds.includes(action.actionId));
        state.capacityPlanIds = [...new Set([...state.capacityPlanIds, preview.recommendationId])];
        state.capacityStagedPlans = [...state.capacityStagedPlans, {
          recommendationId: preview.recommendationId,
          workerName: preview.targetWorker?.name || "Worker",
          homePhase: preview.targetWorker?.homePhase || "",
          phaseLabel: preview.phaseLabel || "",
          actions: selectedActions
        }];
        state.capacityPreview = null;
        state.capacitySelectedActionIds = [];
        state.capacityWorker = "";
        state.capacityMessage = "Selected tasks are staged. Choose another worker and generate their task list for the remaining gap.";
      } catch (error) {
        state.capacityMessage = error.message || "Could not stage the selected tasks.";
      } finally {
        state.capacityLoading = false;
        render();
      }
    } else if (action === "capacity-commit") {
      const preview = state.capacityPreview;
      if (!preview || !state.capacitySelectedActionIds.length) return;
      const planIds = [...new Set([...state.capacityPlanIds, preview.recommendationId])];
      if (!window.confirm(`Commit the selected task assignment changes for ${planIds.length} worker${planIds.length === 1 ? "" : "s"} to the live Asana schedule?`)) return;
      state.capacityLoading = true;
      render();
      try {
        await postJson(`/api/admin/capacity-recommendations/${preview.recommendationId}/selection`, { actionIds: state.capacitySelectedActionIds });
        const result = await postJson(`/api/admin/capacity-recommendations/${preview.recommendationId}/commit`, { recommendationIds: state.capacityPlanIds });
        state.capacityPreview = { ...preview, status: result.status };
        state.capacityPlanIds = [];
        state.capacityStagedPlans = [];
        state.capacitySelectedActionIds = [];
        state.capacityMessage = result.ok ? `Committed ${result.changedTasks} live schedule changes. Hawley will reflect them on the next one-minute refresh.` : `Committed ${result.changedTasks} changes with ${result.failures?.length || 0} failures.`;
        await loadDashboard();
      } catch (error) {
        state.capacityMessage = error.message || "Could not commit the schedule changes.";
      } finally {
        state.capacityLoading = false;
        render();
      }
    } else if (action === "true-pace-save" || action === "true-pace-reset" || action === "true-pace-jit") {
      const row = event.target.closest("[data-true-pace-row]");
      if (!row) return;
      const phaseLabel = row.dataset.phaseLabel || "";
      const cycleNumber = row.dataset.cycleNumber || "";
      const dateInput = row.querySelector("[data-true-pace-date]");
      const noteInput = row.querySelector("[data-true-pace-note]");
      try {
        const reset = action === "true-pace-reset";
        const justInTime = action === "true-pace-jit";
        const selectedStartDate = justInTime ? row.dataset.dropDeadDate || "" : dateInput?.value || "";
        await postJson("/api/admin/phase-cycle-pacing", {
          cycleNumber,
          phaseLabel,
          trueStartDate: reset ? "" : selectedStartDate,
          startMode: justInTime ? "just_in_time" : "manual",
          note: reset ? "" : noteInput?.value || "",
          reset
        });
        state.dashboardMessage = reset
          ? `Reset true pace start for ${phaseLabel}.`
          : justInTime
            ? `Enabled just-in-time pacing for ${phaseLabel}.`
            : `Saved true pace start for ${phaseLabel}.`;
        await loadDashboard();
      } catch (error) {
        state.dashboardMessage = error.message || "Could not save true pace start.";
      }
      render();
    } else if (action === "create-project") {
      try {
        const payload = await postJson("/api/admin/project-creator/create", {
          projectType: state.projectType,
          cycle: state.selectedCycle,
          vin: state.selectedVin,
          projectName: state.projectName || state.project?.preview?.projectName || ""
        });
        state.createMessage = payload.message || "Project created.";
      } catch (error) {
        state.createMessage = error.message || "Project creation is not available.";
      }
      render();
    } else if (action === "cleanup-project-run") {
      const cleanupButton = event.target.closest("[data-run-id]");
      const runId = cleanupButton?.dataset.runId || "";
      const deleteAsanaProject = cleanupButton?.dataset.deleteAsana === "true";
      if (deleteAsanaProject && !window.confirm("Delete the failed Asana project and all tasks in it, then reset this Hawley run?")) return;
      try {
        const payload = await postJson("/api/admin/project-creator/cleanup", { runId, deleteAsanaProject });
        state.createMessage = `Removed failed Hawley run for ${payload.projectName || runId}.`;
        await loadProjectCreator();
      } catch (error) {
        state.createMessage = error.message || "Could not remove the failed Hawley run.";
        render();
      }
    }
  });

  root.addEventListener("input", event => {
    const phaseInput = event.target.closest("[data-capacity-phase]");
    if (phaseInput) {
      state.capacityPhase = phaseInput.value;
      state.capacityPreview = null;
      return;
    }
    const hoursInput = event.target.closest("[data-capacity-hours]");
    if (hoursInput) {
      state.capacityHours = hoursInput.value;
      state.capacityPreview = null;
      return;
    }
    const nameInput = event.target.closest("[data-project-name]");
    if (!nameInput) return;
    state.projectName = nameInput.value;
    state.projectNameDirty = true;
  });

  root.addEventListener("change", event => {
    const taskSelect = event.target.closest("[data-capacity-task-select]");
    if (taskSelect) {
      const actionId = taskSelect.dataset.actionId || "";
      state.capacitySelectedActionIds = taskSelect.checked
        ? [...new Set([...state.capacitySelectedActionIds, actionId])]
        : state.capacitySelectedActionIds.filter(value => value !== actionId);
      render();
      return;
    }
    const workerInput = event.target.closest("[data-capacity-worker]");
    if (!workerInput) return;
    const hadPreview = Boolean(state.capacityPreview);
    state.capacityWorker = workerInput.value;
    state.capacityPreview = null;
    state.capacityMessage = hadPreview ? "Rebuilding preview for the selected worker…" : "";
    if (hadPreview) setTimeout(() => root.querySelector('[data-action="capacity-preview"]')?.click(), 0);
  });

  root.addEventListener("toggle", event => {
    const drawer = event.target.closest?.(".config-drawer");
    if (drawer) state.configurationOpen = drawer.open;
  }, true);

  root.addEventListener("submit", event => {
    const form = event.target.closest("[data-auth-form]");
    if (!form) return;
    event.preventDefault();
    handleLogin(form);
  });

  loadAll();
  startDashboardAutoRefresh();
})();
