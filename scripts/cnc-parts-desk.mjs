// Back end for the CNC Parts Desk page (a claude.ai artifact): exports the parts snapshot the page shows, and applies
// one change request to Hawley's parts schema (migration 055) with the requester recorded in parts.cnc_part_history.
// Run under the admin connection; credentials come from doctl and are never printed:
//
//   node scripts/hawley-db.mjs admin -- node scripts/cnc-parts-desk.mjs export <out.json>
//   node scripts/hawley-db.mjs admin -- node scripts/cnc-parts-desk.mjs apply <request.json> [--dry-run]
//
// A request is {id, type, requestedByEmail, part_base?, part_number?, revision?, effective_from_vin?, part_name?,
// material_name?, quantity_on_sheet?, notes?, change_reason, engineering_change_ref?}. Types: new_part,
// new_revision, release, retire, edit, link_change. Any change can also record an engineering change: eco "new" creates
// one (eco_description, eco_first_vin, asana_link; defaults from the change) and links it to the revision; eco "ECO-12"
// links an existing one. `apply` prints one JSON line {ok, summary} or {ok:false, error}.
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

const ecoIdOf = value => {
  const match = /^(?:ECO-?\s*)?(\d+)$/i.exec(text(value));
  if (!match) fail(`"${text(value)}" isn't an engineering change number like ECO-12.`);
  return Number(match[1]);
};

async function recordEngineeringChange(client, request, change, actor) {
  const choice = text(request.eco);
  if (!choice || choice === "none") return "";
  const { rows: [revision] } = await client.query("select revision_id, part_number from parts.cnc_part_revisions where part_number = $1", [change.partNumber]);
  if (!revision) fail(`No revision ${change.partNumber} to record the change on.`);
  let eco;
  if (choice === "new") {
    const description = text(request.eco_description) || text(request.change_reason);
    const firstVin = vinOf(request.eco_first_vin) ?? change.vin ?? null;
    ({ rows: [eco] } = await client.query(
      `insert into parts.engineering_changes (description, notes, change_date, first_vin, new_part_number, asana_link, created_by)
       values ($1, $2, current_date, $3, $4, $5, $6) returning eco_id, eco_number`,
      [description, text(request.eco_notes), firstVin, change.newPart ? change.partNumber : "", text(request.asana_link), actor]
    ));
  } else {
    ({ rows: [eco] } = await client.query("select eco_id, eco_number from parts.engineering_changes where eco_id = $1", [ecoIdOf(choice)]));
    if (!eco) fail(`No engineering change ${choice} in Hawley.`);
  }
  await client.query(
    "insert into parts.cnc_part_revision_changes (revision_id, eco_id, link_source) values ($1, $2, 'cnc parts desk') on conflict do nothing",
    [revision.revision_id, eco.eco_id]
  );
  return ` Recorded as ${eco.eco_number}${choice === "new" ? " (new)" : ""} on ${revision.part_number}.`;
}

export async function applyRequest(client, request) {
  const reason = text(request.change_reason);
  if (!reason) fail("Every change needs a reason.");
  const actor = text(request.requestedByEmail) || "cnc parts desk";
  await client.query("select set_config('hawley.actor', $1, true)", [`${actor} (CNC Parts Desk ${text(request.id)})`]);
  if (request.type === "link_change") {
    const target = await revisionByNumber(client, request.part_number);
    if (!text(request.eco) || text(request.eco) === "new" || text(request.eco) === "none") fail("Pick the engineering change to link, like ECO-12.");
    return `Linked to ${target.part_number}.${await recordEngineeringChange(client, request, { partNumber: target.part_number }, actor)}`;
  }
  const change = await applyChange(client, request, reason, actor);
  return `${change.summary}${await recordEngineeringChange(client, request, change, actor)}`;
}

async function applyChange(client, request, reason, actor) {

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
      return { summary: `Created part ${base} with draft revision ${base}${revision}.`, partNumber: `${base}${revision}`, newPart: true };
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
      return { summary: `Created draft revision ${base}${revision}${basis.part_number ? ` from ${basis.part_number}` : ""}.`, partNumber: `${base}${revision}`, newPart: true };
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
      return { summary: `Released ${target.part_number} from VIN ${vin}${current.length ? `; ${current.map(row => row.part_number).join(", ")} superseded (still used before VIN ${vin})` : ""}.`, partNumber: target.part_number, vin };
    }
    case "retire": {
      const target = await revisionByNumber(client, request.part_number);
      if (target.status === "retired") fail(`${target.part_number} is already retired.`);
      await client.query("update parts.cnc_part_revisions set status = 'retired', change_reason = $2 where revision_id = $1", [target.revision_id, reason]);
      return { summary: `Retired ${target.part_number}.`, partNumber: target.part_number };
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
      return { summary: `Updated draft ${target.part_number}.`, partNumber: target.part_number };
    }
    default:
      fail(`Unknown request type "${request.type}".`);
  }
}

const to_regclass_ok = result => Boolean(result.rows[0]?.ok);

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
  const { rows: links } = await client.query("select revision_id, eco_id, link_source from parts.cnc_part_revision_changes");
  const { rows: ecos } = await client.query(
    `select eco_id, eco_number, description, notes, change_date::text as change_date, first_vin, first_vin_note, new_part_number, asana_link, created_by
       from parts.engineering_changes order by eco_id`
  );
  const { rows: sheetIds } = await client.query("select revision_id, cnc_sheet_record_ids from parts.cnc_part_revisions where cardinality(cnc_sheet_record_ids) > 0");
  const sheets = to_regclass_ok(await client.query("select to_regclass('hb.cnc_sheets') is not null as ok"))
    ? (await client.query(
        `select sheet_record_id, sheet_name, material_name, sheet_dimensions, sheet_cost::float as sheet_cost, average_price_per_part::float as average_price_per_part,
                inventory_location, frame_class_names, model_type_names
           from hb.cnc_sheets order by sheet_name`
      )).rows
    : [];
  const sheetsByRevision = new Map(sheetIds.map(row => [row.revision_id, row.cnc_sheet_record_ids]));
  const ecosByRevision = new Map();
  for (const link of links) ecosByRevision.set(link.revision_id, [...(ecosByRevision.get(link.revision_id) || []), link.eco_id]);
  const numberByRevision = new Map(revisions.map(rev => [rev.revision_id, rev.part_number]));
  const slim = row => Object.fromEntries(Object.entries(row || {}).filter(([key]) => !["cnc_sheet_record_ids", "airtable_record_ids", "created_at", "updated_at"].includes(key)));
  return {
    generatedAt: new Date().toISOString(),
    parts: parts.map(part => ({
      ...part,
      revisions: revisions.filter(rev => rev.part_base === part.part_base).map(rev => ({
        ...rev, sheet_ids: sheetsByRevision.get(rev.revision_id) || [], eco_ids: ecosByRevision.get(rev.revision_id) || []
      }))
    })),
    sheets: sheets.map(sheet => ({
      ...sheet,
      part_numbers: revisions.filter(rev => (sheetsByRevision.get(rev.revision_id) || []).includes(sheet.sheet_record_id) && rev.status !== "retired").map(rev => rev.part_number)
    })),
    engineeringChanges: ecos.map(eco => ({
      ...eco,
      part_numbers: links.filter(link => link.eco_id === eco.eco_id).map(link => numberByRevision.get(link.revision_id)).filter(Boolean)
    })),
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
