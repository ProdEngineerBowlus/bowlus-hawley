import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { getDatabaseConfig } from "./config.js";

const { Client } = pg;

function parseArgs(argv) {
  const args = {
    csvPath: process.env.HAWLEY_OPS_OWNER_HINTS_CSV || "data/ops/work-area-owner-hints.csv",
    replace: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--csv") args.csvPath = argv[++i] || args.csvPath;
    else if (arg.startsWith("--csv=")) args.csvPath = arg.slice("--csv=".length);
    else if (arg === "--replace") args.replace = true;
    else if (arg === "-h" || arg === "--help") {
      console.log([
        "Usage: npm run pg:load:ops-hints -- [options]",
        "",
        "Options:",
        "  --csv PATH     CSV file to load. Default: data/ops/work-area-owner-hints.csv",
        "  --replace      Deactivate existing manual hints before loading."
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      field += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(field);
      if (row.some(value => value.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  row.push(field);
  if (row.some(value => value.trim() !== "")) rows.push(row);

  if (!rows.length) return [];
  const headers = rows[0].map(header => header.trim());
  return rows.slice(1).map(values => Object.fromEntries(
    headers.map((header, index) => [header, (values[index] || "").trim()])
  ));
}

function normalizeKeyPart(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function hintKey(row) {
  return [
    normalizeKeyPart(row.work_area_key),
    normalizeKeyPart(row.owner_person_email || row.owner_person_name),
    normalizeKeyPart(row.owner_role || "practical_anchor")
  ].filter(Boolean).join(":");
}

function booleanFromCsv(value) {
  if (value === "") return true;
  return ["true", "1", "yes", "y"].includes(String(value).trim().toLowerCase());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const csvPath = path.resolve(args.csvPath);
  if (!fs.existsSync(csvPath)) {
    throw new Error(`Owner hints CSV not found: ${csvPath}`);
  }

  const rows = parseCsv(fs.readFileSync(csvPath, "utf8"))
    .filter(row => row.work_area_key && (row.owner_person_name || row.owner_person_email));

  const client = new Client(getDatabaseConfig({ useSyncUrl: true }));
  await client.connect();

  try {
    await client.query("begin");

    if (args.replace) {
      await client.query("update ops.manual_work_area_owner_hints set active = false, updated_at = now()");
    }

    for (const row of rows) {
      await client.query(
        `
          insert into ops.manual_work_area_owner_hints (
            owner_hint_key,
            work_area_key,
            owner_person_name,
            owner_person_email,
            owner_role,
            confidence_label,
            source_label,
            notes,
            active,
            updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
          on conflict (owner_hint_key) do update set
            work_area_key = excluded.work_area_key,
            owner_person_name = excluded.owner_person_name,
            owner_person_email = excluded.owner_person_email,
            owner_role = excluded.owner_role,
            confidence_label = excluded.confidence_label,
            source_label = excluded.source_label,
            notes = excluded.notes,
            active = excluded.active,
            updated_at = now()
        `,
        [
          hintKey(row),
          row.work_area_key,
          row.owner_person_name || null,
          row.owner_person_email || null,
          row.owner_role || "practical_anchor",
          row.confidence_label || "manual",
          row.source_label || "local_hawley_seed",
          row.notes || null,
          booleanFromCsv(row.active || "")
        ]
      );
    }

    await client.query("commit");
    console.log(`Loaded ${rows.length} operational owner hint(s) from ${csvPath}.`);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
