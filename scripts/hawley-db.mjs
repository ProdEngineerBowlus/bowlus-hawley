// Production database access for agents and admins, with credentials fetched from doctl at runtime.
// Nothing is printed or written to disk. Requires `doctl auth init` with access to the Bowlus DigitalOcean team.
//
//   node scripts/hawley-db.mjs query <file.sql>      read-only queries as bowlus_readonly (statements split on ";\n")
//   node scripts/hawley-db.mjs admin -- <command…>   run a command with HAWLEY_SYNC_DATABASE_URL set (admin user), e.g.
//     node scripts/hawley-db.mjs admin -- npm run pg:hawley-auth-user -- set-role someone@bowlus.com admin
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

async function query(file) {
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
else if (mode === "admin") admin(rest[0] === "--" ? rest.slice(1) : rest);
else {
  console.error("Usage: node scripts/hawley-db.mjs query <file.sql> | admin -- <command…>");
  process.exit(1);
}
