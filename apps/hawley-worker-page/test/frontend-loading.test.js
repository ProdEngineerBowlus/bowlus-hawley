import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const settle = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

function createPage() {
  let now = 0;
  let nextTimer = 1;
  const timers = new Map();
  const requests = [];
  const buttons = [{ disabled: false }];
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const setTimer = (callback, delay, interval = false) => {
    const id = nextTimer++;
    timers.set(id, { callback, delay, due: now + delay, interval });
    return id;
  };
  const context = {
    URL, URLSearchParams, Date, Intl, AbortController,
    localStorage: storage, sessionStorage: storage,
    document: {
      querySelector: () => null,
      querySelectorAll: (selector) => selector === "button[data-task-id]" ? buttons : [],
    },
    window: {
      location: new URL("https://hawley.example/?employee=test-worker"),
      setTimeout: (callback, delay) => setTimer(callback, delay),
      clearTimeout: (id) => timers.delete(id),
      setInterval: (callback, delay) => setTimer(callback, delay, true),
      confirm: () => true,
    },
    fetch(url, options = {}) {
      return new Promise((resolve, reject) => {
        let rejectBody;
        const request = {
          url, options, aborted: false,
          reply(payload, status = 200) {
            resolve({ status, ok: status < 400, json: async () => payload });
          },
          headersOnly(status = 200) {
            resolve({ status, ok: status < 400, json: () => new Promise((bodyResolve, bodyReject) => {
              request.replyBody = bodyResolve;
              rejectBody = bodyReject;
            }) });
          },
        };
        const abort = () => {
          request.aborted = true;
          if (request.ignoreAbort) return;
          const error = Object.assign(new Error("The read was aborted"), { name: "AbortError" });
          reject(error);
          rejectBody?.(error);
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
        requests.push(request);
      });
    },
  };
  vm.createContext(context);
  // Run the actual app, replacing only automatic startup and DOM-heavy display
  // helpers. The request, state, mutation and scheduling code stays unmodified.
  const instrumented = source.replace(/  render\(\);\r?\n  initialize\(\);/, "")
    .replace(/\}\)\(\);\s*$/, `
      render = () => {};
      showToast = () => {};
      showToastError = () => {};
      loadAlertStatus = async () => {};
      renderWorkerSection = () => '<section>saved worker tasks</section>';
      renderManagerDashboard = () => '<section>manager tasks</section>';
      globalThis.page = {
        state, initialize, loadAssignments, startAutoRefresh, readJsonWithTimeout,
        renderMain, bindEvents, postJsonWithPin, reloadAfterTaskAction,
        completeWorkerTask, startWorkerTimer, logout
      };
    })();`);
  vm.runInContext(instrumented, context);
  const page = context.page;
  const payload = (label = "current", completed = false) => ({
    source: "hawley-brain", date: page.state.date,
    workers: [{ id: "test-worker", name: label, tasks: [{ id: "task-1", title: label, completed }] }],
  });
  async function advance(milliseconds) {
    const target = now + milliseconds;
    while (true) {
      const next = [...timers.entries()].filter(([, timer]) => timer.due <= target)
        .sort((left, right) => left[1].due - right[1].due)[0];
      if (!next) break;
      const [id, timer] = next;
      now = timer.due;
      timers.delete(id);
      if (timer.interval) timers.set(id, { ...timer, due: now + timer.delay });
      void timer.callback();
      await settle();
    }
    now = target;
    await settle();
  }
  async function loadInitial(label = "saved") {
    page.state.auth.loaded = true;
    const initial = page.loadAssignments();
    requests.at(-1).reply(payload(label));
    await initial;
  }
  return { page, requests, buttons, timers, payload, advance, loadInitial };
}

test("manual and automatic refreshes join one read, including the auth preflight", async () => {
  const { page, requests, payload } = createPage();
  const first = page.loadAssignments();
  assert.equal(page.loadAssignments(), first);
  assert.equal(page.loadAssignments({ silent: true }), first);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/auth-status");
  requests[0].reply({ accountAuth: { active: false } });
  await settle();
  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /^\/api\/daily-assignments\?/);
  assert.equal(page.loadAssignments(), first);
  requests[1].reply(payload("latest"));
  await first;
  assert.equal(page.state.workers[0].name, "latest");
  assert.equal(page.state.loading, false);
});

test("automatic refresh waits one minute after completion and never piles requests", async () => {
  const { page, requests, payload, advance, loadInitial } = createPage();
  await loadInitial();
  page.startAutoRefresh();
  await advance(60_000);
  assert.equal(requests.length, 2);
  await advance(19_000);
  assert.equal(requests.length, 2);
  for (let click = 0; click < 10; click += 1) page.loadAssignments();
  assert.equal(requests.length, 2);
  requests[1].reply(payload("second"));
  await settle();
  await advance(59_999);
  assert.equal(requests.length, 2);
  await advance(1);
  assert.equal(requests.length, 3);
  requests[2].reply(payload("third"));
  await settle();
  assert.equal(page.state.workers[0].name, "third");
});

test("a stalled response body is aborted, saved tasks stay visible, and retry recovers", async () => {
  const { page, requests, buttons, payload, advance, loadInitial } = createPage();
  await loadInitial();
  const refresh = page.loadAssignments({ silent: true });
  requests[1].headersOnly();
  await settle();
  await advance(20_000);
  await refresh;
  assert.equal(requests[1].aborted, true);
  assert.equal(page.state.loading, false);
  assert.equal(page.state.workers[0].name, "saved");
  assert.match(page.state.assignmentLoadError, /last loaded/);
  const html = page.renderMain(page.state.workers[0], true);
  assert.match(html, /Assignments may be out of date/);
  assert.match(html, /saved worker tasks/);
  assert.match(html, /Reload assignments/);
  page.bindEvents();
  assert.equal(buttons[0].disabled, true);
  await assert.rejects(page.postJsonWithPin("/api/worker-task-action", { taskId: "task-1" }), /Reload assignments/);
  assert.equal(requests.length, 2, "stale controls cannot send a write");
  const retry = page.loadAssignments();
  requests[2].reply(payload("recovered"));
  await retry;
  assert.equal(page.state.assignmentLoadError, "");
  assert.equal(page.state.workers[0].name, "recovered");
});

test("auth timeout exits loading and the next scheduled attempt rechecks auth", async () => {
  const { page, requests, payload, advance } = createPage();
  const initial = page.initialize();
  await advance(20_000);
  await initial;
  assert.equal(requests[0].aborted, true);
  assert.equal(page.state.loading, false);
  assert.equal(page.state.auth.loaded, false);
  assert.match(page.renderMain(null, true), /Assignments unavailable/);
  await advance(60_000);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, "/api/auth-status");
  requests[1].reply({ accountAuth: { active: false } });
  await settle();
  requests[2].reply(payload("reconnected"));
  await settle();
  assert.equal(page.state.workers[0].name, "reconnected");
});

test("completion cancels an older read and reloads after the write without unlocking early", async () => {
  const { page, requests, payload, loadInitial } = createPage();
  await loadInitial();
  page.state.authStatus.workerWritesEnabled = true;
  page.state.authStatus.writeWorkerIds = ["*"];
  const oldRead = page.loadAssignments({ silent: true });
  const action = page.completeWorkerTask("test-worker", "task-1");
  assert.equal(requests[1].aborted, true);
  assert.equal(requests[2].options.method, "POST");
  await oldRead;
  assert.equal(page.state.actionTaskId, "task-1");
  await page.loadAssignments();
  assert.equal(requests.length, 3, "manual reload waits during the mutation");
  requests[2].reply({ ok: true });
  await settle();
  assert.equal(requests.length, 4);
  assert.match(requests[3].url, /^\/api\/daily-assignments\?/);
  requests[3].reply(payload("completed", true));
  await action;
  assert.equal(page.state.workers[0].tasks[0].completed, true);
  assert.equal(page.state.actionTaskId, "");
});

test("a late invalidated read cannot replace data or satisfy the post-action reload", async () => {
  const { page, requests, payload, loadInitial } = createPage();
  await loadInitial();
  const oldRead = page.loadAssignments({ silent: true });
  requests[1].ignoreAbort = true;
  requests[1].headersOnly();
  await settle();
  page.state.actionTaskId = "task-1";
  const write = page.postJsonWithPin("/api/worker-task-action", { taskId: "task-1" });
  requests[2].reply({ ok: true });
  await write;
  const reload = page.reloadAfterTaskAction();
  assert.equal(requests.length, 3);
  requests[1].replyBody(payload("obsolete"));
  await oldRead;
  await settle();
  assert.equal(page.state.workers[0].name, "saved");
  assert.equal(page.state.actionTaskId, "task-1");
  assert.equal(requests.length, 4);
  requests[3].reply(payload("after-write"));
  await reload;
  assert.equal(page.state.workers[0].name, "after-write");
});

test("a failed post-action reload releases the save indicator but keeps stale writes disabled", async () => {
  const { page, requests, advance, loadInitial } = createPage();
  await loadInitial();
  page.state.actionTaskId = "task-1";
  const reload = page.reloadAfterTaskAction();
  await advance(20_000);
  await reload;
  assert.equal(page.state.actionTaskId, "");
  assert.equal(page.state.workers[0].name, "saved");
  assert.match(page.state.assignmentLoadError, /Changes are disabled/);
  await assert.rejects(page.postJsonWithPin("/api/worker-task-action", { taskId: "task-1" }), /Reload assignments/);
  assert.equal(requests.length, 2);
});

test("logout clears the saved snapshot and freshness state for the next account", async () => {
  const { page, requests, loadInitial } = createPage();
  await loadInitial();
  page.state.assignmentLoadError = "Connection unavailable";
  const logout = page.logout();
  requests.at(-1).reply({ ok: true });
  await logout;
  assert.equal(page.state.workers.length, 0);
  assert.equal(page.state.assignmentsLoaded, false);
  assert.equal(page.state.assignmentsRefreshedAt, "");
  assert.equal(page.state.assignmentLoadError, "");
});
