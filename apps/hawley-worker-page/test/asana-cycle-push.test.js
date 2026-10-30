import test from "node:test";
import assert from "node:assert/strict";

import { ASANA_CYCLE_FIELD_GID, addCycleOptions, pushCycleField } from "../asana-cycle-push.js";

// Mirrors adminAsanaRequest: the body it receives is wrapped in { data } before sending.
function fakeAsana({ failOptions = [] } = {}) {
  const sent = [];
  let next = 1;
  const request = async (path, method, body) => {
    sent.push({ path, method, wire: JSON.parse(JSON.stringify({ data: body })) });
    if (path.endsWith("/enum_options")) {
      if (failOptions.includes(body.name)) throw new Error("Asana POST failed: 403");
      return { gid: `opt-${next++}`, name: body.name };
    }
    if (path === "/batch") return body.actions.map(() => ({ status_code: 200 }));
    throw new Error(`unexpected ${path}`);
  };
  return { sent, request };
}

test("option requests send a bare payload (no double data wrapping) in chronological order", async () => {
  const asana = fakeAsana();
  const options = new Map([["c23.26", "o23"], ["c24.26", "o24"]]);
  const result = await addCycleOptions(asana.request, ["C1.27", "C2.27", "C24.26"], options);
  assert.deepEqual(result.added, ["C1.27", "C2.27"]);
  assert.deepEqual(asana.sent.map(s => s.wire), [
    { data: { name: "C1.27", enabled: true, insert_after: "o24" } },
    { data: { name: "C2.27", enabled: true, insert_after: "opt-1" } }
  ]);
});

test("a push never sends an empty update when the option is missing", async () => {
  const asana = fakeAsana({ failOptions: ["C2.27"] });
  const options = new Map([["c24.26", "o24"]]);
  const { options: withNew, failed } = await addCycleOptions(asana.request, ["C1.27", "C2.27"], options);
  assert.deepEqual(failed, ["C2.27"]);
  const pushes = [
    { asanaTaskGid: "t1", label: "C1.27", status: "pending" },
    { asanaTaskGid: "t2", label: "C2.27", status: "pending" },
    { asanaTaskGid: "t3", label: "C1.27", status: "pushed" }
  ];
  const results = await pushCycleField(asana.request, pushes, withNew);
  assert.deepEqual(results.map(r => r.status), ["pushed", "failed", "pushed"]);
  assert.match(results[1].error, /C2\.27 is missing/);
  const batch = asana.sent.find(s => s.path === "/batch").wire.data.actions;
  assert.deepEqual(batch, [{ method: "put", relative_path: "/tasks/t1", data: { custom_fields: { [ASANA_CYCLE_FIELD_GID]: "opt-1" } } }]);
});

test("retrying re-sends previously failed pushes once the option exists", async () => {
  const asana = fakeAsana();
  const results = await pushCycleField(asana.request, [{ asanaTaskGid: "t2", label: "C2.27", status: "failed", error: "Asana Cycle option C2.27 is missing." }], new Map([["c2.27", "o2"]]));
  assert.deepEqual([results[0].status, results[0].error], ["pushed", undefined]);
});
