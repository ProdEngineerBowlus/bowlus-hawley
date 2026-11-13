// Local MCP server (stdio) that lets the CNC Parts Desk page apply a change the moment Jacob sends it, from the Claude
// desktop app on his PC (the page calls it as `host:cnc-parts-desk`). Each call runs the same checked path Claude uses:
//   node scripts/hawley-db.mjs admin -- node scripts/cnc-parts-desk.mjs apply|parts …
// so credentials come from doctl at runtime and are never seen here. Register it in claude_desktop_config.json:
//   "cnc-parts-desk": {"command": "node", "args": ["C:\\dev\\bowlus-hawley\\scripts\\cnc-parts-desk-mcp.mjs", "--actor", "<email>"]}
// Tools: apply_change {request} -> {ok, summary} | {ok:false, error}; refresh_parts {bases} -> parts snapshot slice.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const actorIndex = process.argv.indexOf("--actor");
const ACTOR = actorIndex > 0 ? process.argv[actorIndex + 1] || "" : "";
const TYPES = ["new_part", "new_revision", "release", "retire", "edit", "correct", "link_change"];

const TOOLS = [
  {
    name: "apply_change",
    description: "Apply one CNC Parts Desk change request to Hawley's parts tables now (production write). Same checks as Claude's queue processing; one transaction.",
    inputSchema: { type: "object", properties: { request: { type: "object", description: "The request as the page stores it: type, part_base, part_number, change_reason, …" } }, required: ["request"] },
    annotations: { readOnlyHint: false, destructiveHint: false }
  },
  {
    name: "refresh_parts",
    description: "Current parts data for some part bases (revisions, history, Part Revision records), to refresh the page after a change.",
    inputSchema: { type: "object", properties: { bases: { type: "array", items: { type: "string" }, maxItems: 20 } }, required: ["bases"] },
    annotations: { readOnlyHint: true }
  }
];

function runDesk(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/hawley-db.mjs", "admin", "--", "node", "scripts/cnc-parts-desk.mjs", ...args], { cwd: ROOT, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { err += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      const line = out.trim().split(/\r?\n/).filter(Boolean).at(-1) || "";
      try { resolve(JSON.parse(line)); }
      catch { reject(new Error(code ? `The desk script failed (exit ${code}). ${err.split(/\r?\n/).filter(Boolean).at(-1) || ""}`.trim() : "The desk script gave no answer.")); }
    });
  });
}

async function withTempDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cnc-desk-"));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const isPlainText = value => typeof value === "string" || typeof value === "number" || value === null || value === undefined;

async function applyChange({ request } = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("request must be an object.");
  if (!TYPES.includes(request.type)) throw new Error(`Unknown change type "${request.type}".`);
  // Only flat text/number fields go to the script.
  const clean = Object.fromEntries(Object.entries(request).filter(([key, value]) => /^[a-z_]{1,40}$/.test(key) && isPlainText(value)));
  if (!clean.requestedByEmail && ACTOR) clean.requestedByEmail = ACTOR;
  return withTempDir(async dir => {
    const file = path.join(dir, "request.json");
    writeFileSync(file, JSON.stringify(clean));
    return runDesk(["apply", file]);
  });
}

async function refreshParts({ bases } = {}) {
  const list = (Array.isArray(bases) ? bases : []).map(base => String(base).trim().toUpperCase()).filter(base => /^[A-Z0-9-]{1,40}$/.test(base)).slice(0, 20);
  if (!list.length) throw new Error("Give at least one part base.");
  return withTempDir(async dir => {
    const file = path.join(dir, "parts.json");
    const result = await runDesk(["parts", file, ...list]);
    if (!result.ok) throw new Error(result.error || "Couldn't read the parts.");
    return JSON.parse(readFileSync(file, "utf8"));
  });
}

// --- Minimal MCP over stdio (newline-delimited JSON-RPC 2.0) ---
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

async function handle(message) {
  const { id, method, params } = message;
  if (id === undefined || id === null) return; // notifications
  try {
    if (method === "initialize") {
      send({ id, result: { protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cnc-parts-desk", version: "1.0.0" } } });
    } else if (method === "ping") {
      send({ id, result: {} });
    } else if (method === "tools/list") {
      send({ id, result: { tools: TOOLS } });
    } else if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments || {};
      let payload;
      try {
        if (name === "apply_change") payload = await applyChange(args);
        else if (name === "refresh_parts") payload = await refreshParts(args);
        else { send({ id, error: { code: -32602, message: `Unknown tool ${name}` } }); return; }
      } catch (error) {
        send({ id, result: { isError: true, content: [{ type: "text", text: error.message }] } });
        return;
      }
      send({ id, result: { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload } });
    } else {
      send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (error) {
    send({ id, error: { code: -32603, message: error.message } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: "Parse error" } }); continue; }
    void handle(message);
  }
});
process.stdin.on("end", () => process.exit(0));
