import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { getDatabaseConfig } from "./config.js";

const { Client } = pg;
const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..", "..", "..");
const migrationsDir = path.join(repoRoot, "db", "migrations");
const viewsDir = path.join(repoRoot, "db", "views");

async function ensureMigrationTable(client) {
  await client.query(`
    create table if not exists sync.schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )
  `);
}

async function main() {
  const client = new Client(getDatabaseConfig({ useSyncUrl: true }));
  await client.connect();

  await client.query("begin");
  try {
    await client.query("create schema if not exists sync");
    await ensureMigrationTable(client);

    const files = (await fs.readdir(migrationsDir))
      .filter(file => file.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const alreadyApplied = await client.query(
        "select 1 from sync.schema_migrations where filename = $1",
        [file]
      );
      if (alreadyApplied.rowCount) continue;

      const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
      console.log(`Applying ${file}`);
      await client.query(sql);
      await client.query(
        "insert into sync.schema_migrations (filename) values ($1)",
        [file]
      );
    }

    const viewFiles = (await fs.readdir(viewsDir))
      .filter(file => file.endsWith(".sql"))
      .sort();

    for (const file of viewFiles) {
      const sql = await fs.readFile(path.join(viewsDir, file), "utf8");
      console.log(`Applying view ${file}`);
      await client.query(sql);
    }

    await client.query("commit");
    console.log("Hawley migrations complete.");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error("Hawley migration failed.");
  console.error(error.message);
  process.exitCode = 1;
});
