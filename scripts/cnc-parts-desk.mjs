// Back end for the CNC Parts Desk page (a claude.ai artifact): exports the parts snapshot the page shows, and applies
// one change request to Hawley's parts schema (migration 055) with the requester recorded in parts.cnc_part_history.
// Run under the admin connection; credentials come from doctl and are never printed:
//
//   node scripts/hawley-db.mjs admin -- node scripts/cnc-parts-desk.mjs export <out.json>
//   node scripts/hawley-db.mjs admin -- node scripts/cnc-parts-desk.mjs apply <request.json> [--dry-run]
//
// A request is {id, type, requestedByEmail, part_base?, part_number?, revision?, effective_from_vin?, part_name?,
// material_name?, quantity_on_sheet?, notes?, change_reason, engineering_change_ref?}. Types: new_part,
// new_revision, release, retire, edit. `apply` prints one JSON line {ok, summary} or {ok:false, error}.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { getDatabaseConfig } from "../apps/postgres-sync/src/config.js";

const EDITABLE = ["part_name", "material_name", "quantity_on_sheet", "effective_from_vin", "change_reason", "engineering_change_ref"];

function fail(message) {
  const error = new Error(message);
  error.requestError = true;
  throw error;
}

const text = value => String(value ?? "").trim();
const vinOf = value => {
  if (value === undefined || value === null || value === "") return null;
  const vin = Number(value);
  if (!Number.isInteger(vin) || vin <= 0) fail(`Effective VIN must be a whole number, got "${value}".`);
  return vin;
};
const qtyOf = value => {
  if (value === undefined || value === null || value === "") return null;
  const qty = Number(value);
  if (!Number.isFinite(qty) || qty < 0) fail(`Quantity on sheet must be a number, got "${value}".`);
  return qty;
};

async function revisionByNumber(client, partNumber) {
  const { rows } = await client.query("select * from parts.cnc_part_revisions where part_number = $1 for update", [text(partNumber)]);
  if (!rows.length) fail(`No revision ${text(partNumber)} in Hawley.`);
  return rows[0];
}

export async function applyRequest(client, request) {
  const reason = text(request.change_reason);
  if (!reason) fail("Every change needs a reason.");
  const actor = text(request.requestedByEmail) || "cnc parts desk";
  await client.query("select set_config('hawley.actor', $1, true)", [`${actor} (CNC Parts Desk ${text(request.id)})`]);

  switch (request.type) {
    case "new_part": {
      const base = text(request.part_base).toUpperCase();
      if (!/^[A-Z0-9-]+$/.test(base)) fail("A new part needs a base number of letters, digits or dashes.");
      const name = text(request.part_name);
      if (!name) fail("A new part needs a name.");
      const exists = await client.query("select 1 from parts.cnc_parts where part_base = $1", [base]);
      if (exists.rows.length) fail(`Part ${base} already exists; request a new revision instead.`);
      const revision = text(request.revision || "A").toUpperCase();
      await client.query("insert into parts.cnc_parts (part_base, part_name, notes) values ($1, $2, $3)", [base, name, text(request.notes)]);
      await client.query(
        `insert into parts.cnc_part_revisions (part_base, revision, status, part_name, material_name, quantity_on_sheet, change_reason, engineering_change_ref, created_by)
         values ($1, $2, 'draft', $3, $4, $5, $6, $7, $8)`,
        [base, revision, name, text(request.material_name) || null, qtyOf(request.quantity_on_sheet), reason, text(request.engineering_change_ref), actor]
      );
      return `Created part ${base} with draft revision ${base}${revision}.`;
    }
    case "new_revision": {
      const base = text(request.part_base).toUpperCase();
      const { rows: [part] } = await client.query("select * from parts.cnc_parts where part_base = $1 for update", [base]);
      if (!part) fail(`No part ${base} in Hawley.`);
      const { rows: revisions } = await client.query("select * from parts.cnc_part_revisions where part_base = $1 order by revision", [base]);
      const lettered = revisions.map(row => row.revision).filter(rev => /^[A-Z]$/.test(rev));
      const next = lettered.length ? String.fromCharCode(lettered.at(-1).charCodeAt(0) + 1) : "A";
      const revision = text(request.revision).toUpperCase() || next;
      if (!text(request.revision) && !/^[A-Z]$/.test(next)) fail(`${base} has used every letter up to Z.`);
      if (!/^[A-Z]$/.test(revision)) fail(`Revision must be one letter, got "${revision}".`);
      if (revisions.some(row => row.revision === revision)) fail(`${base}${revision} already exists.`);
      const basis = revisions.find(row => row.status === "released") || revisions.at(-1) || {};
      await client.query(
        `insert into parts.cnc_part_revisions (part_base, revision, status, part_name, material_name, quantity_on_sheet, cnc_sheet_record_ids,
                                               change_reason, engineering_change_ref, created_by)
         values ($1, $2, 'draft', $3, $4, $5, $6, $7, $8, $9)`,
        [
          base, revision,
          text(request.part_name) || basis.part_name || part.part_name,
          text(request.material_name) || basis.material_name || null,
          qtyOf(request.quantity_on_sheet) ?? basis.quantity_on_sheet ?? null,
          basis.cnc_sheet_record_ids || [],
          reason, text(request.engineering_change_ref), actor
        ]
      );
      return `Created draft revision ${base}${revision}${basis.part_number ? ` from ${basis.part_number}` : ""}.`;
    }
    case "release": {
      const target = await revisionByNumber(client, request.part_number);
      if (!["draft", "superseded"].includes(target.status)) fail(`${target.part_number} is ${target.status}; only a draft or superseded revision can be released.`);
      const vin = vinOf(request.effective_from_vin);
      if (vin === null) fail("Releasing needs the VIN it applies from.");
      const { rows: current } = await client.query(
        "select * from parts.cnc_part_revisions where part_base = $1 and status = 'released' and revision_id <> $2 for update",
        [target.part_base, target.revision_id]
      );
      for (const row of current) {
        if ((row.effective_from_vin ?? 0) >= vin) fail(`${row.part_number} already applies from VIN ${row.effective_from_vin ?? "the first build"}; pick a later VIN than that.`);
        await client.query("update parts.cnc_part_revisions set status = 'superseded' where revision_id = $1", [row.revision_id]);
      }
      await client.query(
        `update parts.cnc_part_revisions
            set status = 'released', effective_from_vin = $2, released_at = now(), released_by = $3,
                change_reason = case when change_reason = '' then $4 else change_reason end
          where revision_id = $1`,
        [target.revision_id, vin, actor, reason]
      );
      return `Released ${target.part_number} from VIN ${vin}${current.length ? `; ${current.map(row => row.part_number).join(", ")} superseded (still used before VIN ${vin})` : ""}.`;
    }
    case "retire": {
      const target = await revisionByNumber(client, request.part_number);
      if (target.status === "retired") fail(`${target.part_number} is already retired.`);
      await client.query("update parts.cnc_part_revisions set status = 'retired', change_reason = $2 where revision_id = $1", [target.revision_id, reason]);
      return `Retired ${target.part_number}.`;
    }
    case "edit": {
      const target = await revisionByNumber(client, request.part_number);
      if (target.status !== "draft") fail(`${target.part_number} is ${target.status}. Released revisions don't change; request a new revision instead.`);
      const sets = [];
      const values = [target.revision_id];
      for (const field of EDITABLE) {
        if (!(field in request) || field === "change_reason") continue;
        const value = field === "effective_from_vin" ? vinOf(request[field]) : field === "quantity_on_sheet" ? qtyOf(request[field]) : text(request[field]) || null;
        values.push(field === "part_name" || field === "engineering_change_ref" ? value ?? "" : value);
        sets.push(`${field} = $${values.length}`);
      }
      values.push(reason);
      sets.push(`change_reason = $${values.length}`);
      if (sets.length === 1) fail("Nothing to change.");
      await client.query(`update parts.cnc_part_revisions set ${sets.join(", ")} where revision_id = $1`, values);
      return `Updated draft ${target.part_number}.`;
    }
    default:
      fail(`Unknown request type "${request.type}".`);
  }
}

export async function exportSnapshot(client) {
  const { rows: parts } = await client.query("select part_base, part_name, notes from parts.cnc_parts order by part_base");
  const { rows: revisions } = await client.query(
    `select revision_id, part_base, revision, part_number, status, effective_from_vin, part_name, material_name,
            quantity_on_sheet::float as quantity_on_sheet, change_reason, engineering_change_ref, released_at, released_by, created_at, updated_at
       from parts.cnc_part_revisions order by part_base, revision`
  );
  const { rows: history } = await client.query(
    `select h.history_id, h.table_name, h.row_key, h.operation, h.changed_fields, h.changed_by, h.changed_at,
            coalesce(h.new_row, h.old_row) ->> 'part_base' as part_base, coalesce(h.new_row, h.old_row) ->> 'part_number' as part_number,
            h.old_row, h.new_row
       from parts.cnc_part_history h
      where h.changed_by not like 'migration 055%'
      order by h.history_id desc limit 2000`
  );
  const slim = row => Object.fromEntries(Object.entries(row || {}).filter(([key]) => !["cnc_sheet_record_ids", "airtable_record_ids", "created_at", "updated_at"].includes(key)));
  return {
    generatedAt: new Date().toISOString(),
    parts: parts.map(part => ({ ...part, revisions: revisions.filter(rev => rev.part_base === part.part_base) })),
    history: history.map(row => ({ ...row, old_row: row.old_row && slim(row.old_row), new_row: row.new_row && slim(row.new_row) }))
  };
}

async function main() {
  const [mode, file, flag] = process.argv.slice(2);
  const client = new pg.Client(getDatabaseConfig({ useSyncUrl: true }));
  await client.connect();
  try {
    if (mode === "export" && file) {
      const snapshot = await exportSnapshot(client);
      writeFileSync(file, JSON.stringify(snapshot));
      console.log(JSON.stringify({ ok: true, parts: snapshot.parts.length, history: snapshot.history.length, file }));
    } else if (mode === "apply" && file) {
      const request = JSON.parse(readFileSync(file, "utf8"));
      await client.query("begin");
      try {
        const summary = await applyRequest(client, request);
        await client.query(flag === "--dry-run" ? "rollback" : "commit");
        console.log(JSON.stringify({ ok: true, dryRun: flag === "--dry-run", summary }));
      } catch (error) {
        await client.query("rollback");
        if (!error.requestError) throw error;
        console.log(JSON.stringify({ ok: false, error: error.message }));
      }
    } else {
      console.error("Usage: cnc-parts-desk.mjs export <out.json> | apply <request.json> [--dry-run]");
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
