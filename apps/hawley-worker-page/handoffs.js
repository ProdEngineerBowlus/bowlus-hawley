// Department handoffs (issue 49, step 2): pure rules, no database. A handoff moves open -> packing -> delivered ->
// received (everything arrived) or short (something missing, damaged, wrong, taken or to remake).
export const HANDOFF_ISSUES = Object.freeze(["missing", "damaged", "wrong", "remake", "taken"]);

const qty = value => (value === null || value === undefined || value === "" ? null : Number(value));

export function summarizeLines(lines) {
  const rows = lines || [];
  const expected = rows.reduce((sum, line) => sum + Number(line.expected_qty || 0), 0);
  const packed = rows.reduce((sum, line) => sum + Number(qty(line.packed_qty) || 0), 0);
  const received = rows.reduce((sum, line) => sum + Number(qty(line.received_qty) || 0), 0);
  const isShort = line => Boolean(line.issue) || (qty(line.received_qty) !== null && qty(line.received_qty) < Number(line.expected_qty || 0));
  return {
    lineCount: rows.length,
    expected,
    packed,
    received,
    packedLines: rows.filter(line => qty(line.packed_qty) !== null).length,
    receivedLines: rows.filter(line => qty(line.received_qty) !== null).length,
    shortLines: rows.filter(isShort).length
  };
}

// Packing records what went on the cart. A line packed below its expected quantity needs a reason.
export function checkPack(status, lines) {
  if (!["open", "packing"].includes(status)) return { ok: false, error: `This handoff is ${status}; packing is closed.` };
  const unexplained = (lines || []).filter(line => qty(line.packed_qty) !== null && qty(line.packed_qty) < Number(line.expected_qty || 0) && !line.issue);
  if (unexplained.length) return { ok: false, error: `Give a reason for ${unexplained.length} line(s) packed short.` };
  return { ok: true, status: "packing" };
}

// Delivery needs every line packed (a short line counts once it has a reason).
export function checkDeliver(status, lines) {
  if (!["open", "packing"].includes(status)) return { ok: false, error: `This handoff is ${status}.` };
  if (!(lines || []).length) return { ok: false, error: "Add the expected contents before delivering." };
  const unpacked = lines.filter(line => qty(line.packed_qty) === null);
  if (unpacked.length) return { ok: false, error: `${unpacked.length} line(s) are not packed yet.` };
  return { ok: true, status: "delivered" };
}

// Receiving is the gate: every line counted, short lines given a reason, every checklist item ticked.
export function checkReceive(status, lines, { checklist = [], checked = [] } = {}) {
  if (status !== "delivered") return { ok: false, error: status === "received" || status === "short" ? `Already ${status}.` : "Deliver the handoff before receiving it." };
  const uncounted = (lines || []).filter(line => qty(line.received_qty) === null);
  if (uncounted.length) return { ok: false, error: `Count ${uncounted.length} more line(s).` };
  const unexplained = lines.filter(line => qty(line.received_qty) < Number(line.expected_qty || 0) && !line.issue);
  if (unexplained.length) return { ok: false, error: `Give a reason for ${unexplained.length} short line(s).` };
  const missingChecks = checklist.filter(item => !checked.includes(item));
  if (missingChecks.length) return { ok: false, error: `Tick every check: ${missingChecks.join("; ")}.` };
  const short = summarizeLines(lines).shortLines > 0;
  return { ok: true, status: short ? "short" : "received" };
}

export function handoffLabel(type, { cycleLabel = "", phase = "", vin = "", number = 1 } = {}) {
  const scope = [cycleLabel, phase ? `Phase ${phase}` : "", vin ? `VIN ${vin}` : ""].filter(Boolean).join(" ");
  return `${type?.name || "Handoff"} ${scope}${number > 1 ? ` #${number}` : ""}`.trim();
}
