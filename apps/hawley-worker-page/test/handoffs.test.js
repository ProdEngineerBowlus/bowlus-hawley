import test from "node:test";
import assert from "node:assert/strict";

import { checkDeliver, checkPack, checkReceive, handoffLabel, summarizeLines } from "../handoffs.js";

const cart = () => [
  { item_name: "Rib 12", expected_qty: 4, packed_qty: 4 },
  { item_name: "Skin L", expected_qty: 2, packed_qty: 2 }
];

test("packing and delivery: every line packed, short packing needs a reason", () => {
  assert.equal(checkPack("open", [{ expected_qty: 4, packed_qty: 3 }]).ok, false);
  assert.equal(checkPack("open", [{ expected_qty: 4, packed_qty: 3, issue: "remake" }]).ok, true);
  assert.match(checkDeliver("packing", [{ expected_qty: 4, packed_qty: 4 }, { expected_qty: 1, packed_qty: null }]).error, /1 line/);
  assert.deepEqual(checkDeliver("packing", cart()), { ok: true, status: "delivered" });
  assert.equal(checkDeliver("packing", []).ok, false, "no contents, nothing to deliver");
  assert.equal(checkPack("delivered", cart()).ok, false, "packing closes at delivery");
});

test("receiving is the gate: count every line, explain shortages, tick the checklist", () => {
  const lines = cart().map(line => ({ ...line, received_qty: line.expected_qty }));
  assert.equal(checkReceive("packing", lines).ok, false, "must be delivered first");
  assert.deepEqual(checkReceive("delivered", lines), { ok: true, status: "received" });
  assert.match(checkReceive("delivered", lines, { checklist: ["Quality check done"] }).error, /Quality check done/);
  assert.equal(checkReceive("delivered", lines, { checklist: ["Quality check done"], checked: ["Quality check done"] }).status, "received");

  const taken = [{ ...lines[0], received_qty: 3 }, lines[1]];
  assert.match(checkReceive("delivered", taken).error, /reason/);
  taken[0].issue = "taken";
  assert.deepEqual(checkReceive("delivered", taken), { ok: true, status: "short" }, "a part taken off the cart makes the handoff short");
  assert.deepEqual(summarizeLines(taken), { lineCount: 2, expected: 6, packed: 6, received: 5, packedLines: 2, receivedLines: 2, shortLines: 1 });
});

test("labels follow the handoff scope", () => {
  assert.equal(handoffLabel({ name: "CNC cart" }, { cycleLabel: "C22.26" }), "CNC cart C22.26");
  assert.equal(handoffLabel({ name: "Phase cart" }, { cycleLabel: "C22.26", phase: "B", number: 2 }), "Phase cart C22.26 Phase B #2");
});
