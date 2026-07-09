import pg from "pg";
import { getDatabaseConfig } from "./config.js";

const { Client } = pg;

async function main() {
  const client = new Client(getDatabaseConfig({ useSyncUrl: true }));
  await client.connect();

  const result = await client.query(`
    select
      current_database() as database_name,
      current_user as user_name,
      version() as postgres_version
  `);

  await client.end();

  console.log("Hawley Postgres health check passed.");
  console.log(JSON.stringify(result.rows[0], null, 2));
}

main().catch(error => {
  console.error("Hawley Postgres health check failed.");
  console.error(error.message);
  process.exitCode = 1;
});
