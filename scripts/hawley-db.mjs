// Production database access for agents and admins, with credentials fetched from doctl at runtime.
// Credentials are never printed or written to disk. Requires `doctl auth init` with access to the Bowlus DigitalOcean team.
//
//   node scripts/hawley-db.mjs query <file.sql>      read-only queries as bowlus_readonly (statements split on ";\n")
//   node scripts/hawley-db.mjs map <out.md>          write a Markdown map of every schema (read-only)
//   node scripts/hawley-db.mjs admin -- <command…>   run a command with HAWLEY_SYNC_DATABASE_URL set (admin user), e.g.
//     node scripts/hawley-db.mjs admin -- npm run pg:hawley-auth-user -- set-role someone@bowlus.com admin
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";

const DB_ID = "3173c8b8-455b-423f-a86f-a90a322a18ef";
const DB_NAME = "bowlus_ops";

function doctlPath() {
  const winget = path.join(os.homedir(), "AppData/Local/Microsoft/WinGet/Packages");
  if (existsSync(winget)) {
    for (const dir of execFileSync("cmd", ["/c", "dir", "/b", winget], { encoding: "utf8" }).split(/\r?\n/)) {
      if (dir.startsWith("DigitalOcean.Doctl") && existsSync(path.join(winget, dir, "doctl.exe"))) return path.join(winget, dir, "doctl.exe");
    }
  }
  return "doctl";
}

const DOCTL = doctlPath();
const doctl = (...args) => execFileSync(DOCTL, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const first = value => (Array.isArray(value) ? value[0] : value);

async function readOnlyClient() {
  const connection = first(JSON.parse(doctl("databases", "connection", DB_ID, "-o", "json")));
  const ca = first(JSON.parse(doctl("databases", "get-ca", DB_ID, "-o", "json"))).certificate;
  const client = new pg.Client({
    host: connection.host,
    port: Number(connection.port),
    database: DB_NAME,
    user: "bowlus_readonly",
    password: doctl("databases", "user", "get", DB_ID, "bowlus_readonly", "--format", "Password", "--no-header", "--show").trim(),
    ssl: { ca: Buffer.from(ca, "base64").toString("utf8"), rejectUnauthorized: true }
  });
  await client.connect();
  await client.query("set default_transaction_read_only = on");
  await client.query("set statement_timeout = 60000");
  return client;
}

async function query(file) {
  const client = await readOnlyClient();
  for (const sql of readFileSync(file, "utf8").split(/;\s*\n/).map(s => s.trim()).filter(Boolean)) {
    try {
      const { rows } = await client.query(sql);
      console.log(`\n-- ${sql.split("\n")[0].slice(0, 100)}`);
      console.table(rows);
    } catch (error) {
      console.log(`\n-- ERROR ${error.message} :: ${sql.slice(0, 80)}`);
    }
  }
  await client.end();
}

// Writes a Markdown map of every Hawley schema from the system catalog (readable by bowlus_readonly even where the
// table data isn't): tables and views, estimated rows, columns, primary keys, foreign keys and comments.
const MAP_SCHEMAS = ["raw", "hb", "core", "ops", "reporting", "sync"];

async function map(outFile) {
  const client = await readOnlyClient();
  const { rows: relations } = await client.query(
    `select n.nspname as schema, c.relname as name, c.oid,
            case c.relkind when 'r' then 'table' when 'p' then 'table' when 'v' then 'view' when 'm' then 'materialized view' end as kind,
            greatest(c.reltuples, 0)::bigint as est_rows, obj_description(c.oid, 'pg_class') as comment
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1) and c.relkind in ('r', 'p', 'v', 'm') and not c.relispartition
      order by array_position($1, n.nspname::text), c.relname`,
    [MAP_SCHEMAS]
  );
  const { rows: columns } = await client.query(
    `select a.attrelid as oid, a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
            pg_get_expr(d.adbin, d.adrelid) as default_expr, col_description(a.attrelid, a.attnum) as comment
       from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = any($1) and a.attnum > 0 and not a.attisdropped
      order by a.attrelid, a.attnum`,
    [relations.map(row => row.oid)]
  );
  const { rows: constraints } = await client.query(
    `select conrelid as oid, contype as type, pg_get_constraintdef(oid) as definition
       from pg_constraint where conrelid = any($1) and contype in ('p', 'f', 'u') order by conrelid, contype, conname`,
    [relations.map(row => row.oid)]
  );
  await client.end();

  const byOid = (list, oid) => list.filter(row => row.oid === oid);
  const cell = value => String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
  const lines = [
    "# Hawley database map (generated)",
    "",
    `Generated from \`bowlus_ops\` on ${new Date().toISOString().slice(0, 10)} by \`node scripts/hawley-db.mjs map ${outFile}\`. Do not edit by hand; re-run after migrations.`,
    "See `docs/hawley-database-schema.md` for what each layer is for. Row counts are planner estimates.",
    "",
    "## Contents",
    ""
  ];
  for (const schema of MAP_SCHEMAS) {
    const list = relations.filter(row => row.schema === schema);
    lines.push(`- **${schema}** (${list.length}): ${list.map(row => `[${row.name}](#${schema}${row.name})`).join(", ")}`);
  }
  for (const schema of MAP_SCHEMAS) {
    lines.push("", `## ${schema}`);
    for (const relation of relations.filter(row => row.schema === schema)) {
      lines.push("", `### ${schema}.${relation.name}`, "");
      lines.push(`${relation.kind}${relation.kind === "view" ? "" : `, ~${Number(relation.est_rows).toLocaleString("en-US")} rows`}${relation.comment ? `. ${cell(relation.comment)}` : ""}`, "");
      lines.push("| Column | Type | Null | Default |", "|---|---|---|---|");
      for (const column of byOid(columns, relation.oid)) {
        lines.push(`| ${column.name} | ${cell(column.type)} | ${column.not_null ? "no" : "yes"} | ${cell(column.default_expr)} |`);
      }
      const keys = byOid(constraints, relation.oid);
      if (keys.length) lines.push("", ...keys.map(key => `- ${{ p: "Primary key", f: "Foreign key", u: "Unique" }[key.type]}: \`${cell(key.definition)}\``));
    }
  }
  writeFileSync(outFile, `${lines.join("\n")}\n`);
  console.log(`Mapped ${relations.length} tables and views, ${columns.length} columns -> ${outFile}`);
}

function admin(command) {
  if (!command.length) throw new Error("Usage: node scripts/hawley-db.mjs admin -- <command…>");
  const url = new URL(first(JSON.parse(doctl("databases", "connection", DB_ID, "--show", "-o", "json"))).uri);
  url.pathname = `/${DB_NAME}`;
  const result = spawnSync(command[0], command.slice(1), {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, HAWLEY_SYNC_DATABASE_URL: url.toString() }
  });
  process.exit(result.status ?? 1);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "query" && rest[0]) await query(rest[0]);
else if (mode === "map" && rest[0]) await map(rest[0]);
else if (mode === "admin") admin(rest[0] === "--" ? rest.slice(1) : rest);
else {
  console.error("Usage: node scripts/hawley-db.mjs query <file.sql> | map <out.md> | admin -- <command…>");
  process.exit(1);
}
