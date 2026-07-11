import crypto from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";
import { getDatabaseConfig } from "./config.js";

const { Client } = pg;
const scryptAsync = promisify(crypto.scrypt);

function usage() {
  return `
Usage:
  npm run pg:hawley-auth-user -- list
  npm run pg:hawley-auth-user -- set-password <email> [--active] [--role=worker|manager|admin]
  npm run pg:hawley-auth-user -- set-role <email> <worker|manager|admin>
  npm run pg:hawley-auth-user -- deactivate <email>

Set HAWLEY_AUTH_PASSWORD in the shell before set-password. The password is never
printed and is stored only as a salted scrypt hash.
`.trim();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function parseOptions(args) {
  const options = {};
  const positional = [];
  for (const arg of args) {
    if (arg === "--active") {
      options.active = true;
    } else if (arg === "--inactive") {
      options.active = false;
    } else if (arg.startsWith("--role=")) {
      options.role = arg.slice("--role=".length).trim().toLowerCase();
    } else {
      positional.push(arg);
    }
  }
  return { options, positional };
}

function assertRole(role) {
  if (!["worker", "manager", "admin"].includes(role)) {
    throw new Error("Role must be worker, manager, or admin.");
  }
  return role;
}

function workerKeyFromEmail(email, workerName = "") {
  const normalizedEmail = normalizeEmail(email);
  const emailForSlug = normalizedEmail.replace(/^asana\+/, "");
  if (emailForSlug) {
    return `asana-${emailForSlug.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
  }
  return `worker-${String(workerName || "unknown").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const key = await scryptAsync(String(password || ""), salt, 64);
  return `scrypt$1$${salt}$${Buffer.from(key).toString("hex")}`;
}

async function findWorker(client, email) {
  try {
    const result = await client.query(
      `
        select worker_name, worker_email
        from hb.work_force
        where lower(worker_email) = $1
        limit 1
      `,
      [email]
    );
    return result.rows[0] || null;
  } catch {
    return null;
  }
}

function userSummary(row) {
  return {
    username: row.username,
    displayName: row.display_name || "",
    email: row.email || "",
    role: row.role,
    active: Boolean(row.active),
    workerKey: row.worker_key || "",
    workerName: row.worker_name || "",
    temporaryPassword: Boolean(row.temporary_password),
    lastLoginAt: row.last_login_at || ""
  };
}

async function recordAdminEvent(client, eventType, username, payload = {}) {
  await client.query(
    `
      insert into core.app_auth_events (
        event_type,
        username,
        success,
        reason,
        payload
      )
      values ($1, $2, true, 'admin_cli', $3::jsonb)
    `,
    [eventType, username, JSON.stringify(payload)]
  );
}

async function listUsers(client) {
  const result = await client.query(
    `
      select username, display_name, email, role, active, worker_key, worker_name, temporary_password, last_login_at
      from core.app_users
      order by active desc, role desc, display_name nulls last, username
    `
  );
  console.table(result.rows.map(userSummary));
}

async function setPassword(client, email, options) {
  const password = process.env.HAWLEY_AUTH_PASSWORD;
  if (!password) throw new Error("Set HAWLEY_AUTH_PASSWORD before running set-password.");
  const role = assertRole(options.role || "worker");
  const active = options.active === undefined ? false : Boolean(options.active);
  const worker = await findWorker(client, email);
  const displayName = worker?.worker_name || email;
  const workerEmail = normalizeEmail(worker?.worker_email || email);
  const workerKey = workerKeyFromEmail(workerEmail, displayName);
  const passwordHash = await hashPassword(password);

  await client.query("begin");
  try {
    const result = await client.query(
      `
        insert into core.app_users (
          username,
          display_name,
          email,
          worker_key,
          worker_name,
          worker_email,
          role,
          active,
          password_hash,
          password_set_at,
          temporary_password,
          source_system,
          updated_at
        )
        values ($1, $2, $1, $3, $4, $5, $6, $7, $8, now(), true, 'hawley_auth_admin_cli', now())
        on conflict (username) do update set
          display_name = excluded.display_name,
          email = excluded.email,
          worker_key = excluded.worker_key,
          worker_name = excluded.worker_name,
          worker_email = excluded.worker_email,
          role = excluded.role,
          active = excluded.active,
          password_hash = excluded.password_hash,
          password_set_at = now(),
          temporary_password = true,
          updated_at = now()
        returning username, display_name, email, role, active, worker_key, worker_name, temporary_password, last_login_at
      `,
      [email, displayName, workerKey, displayName, workerEmail, role, active, passwordHash]
    );
    await recordAdminEvent(client, "admin_set_password", email, { role, active, workerKey });
    await client.query("commit");
    console.table([userSummary(result.rows[0])]);
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

async function setRole(client, email, role) {
  assertRole(role);
  const result = await client.query(
    `
      update core.app_users
      set role = $2, updated_at = now()
      where username = $1 or lower(email) = $1
      returning username, display_name, email, role, active, worker_key, worker_name, temporary_password, last_login_at
    `,
    [email, role]
  );
  if (!result.rows[0]) throw new Error(`No Hawley auth user found for ${email}.`);
  await recordAdminEvent(client, "admin_set_role", email, { role });
  console.table([userSummary(result.rows[0])]);
}

async function deactivateUser(client, email) {
  await client.query("begin");
  try {
    const result = await client.query(
      `
        update core.app_users
        set active = false, updated_at = now()
        where username = $1 or lower(email) = $1
        returning app_user_id, username, display_name, email, role, active, worker_key, worker_name, temporary_password, last_login_at
      `,
      [email]
    );
    if (!result.rows[0]) throw new Error(`No Hawley auth user found for ${email}.`);
    await client.query(
      "update core.app_sessions set revoked_at = now() where app_user_id = $1 and revoked_at is null",
      [result.rows[0].app_user_id]
    );
    await recordAdminEvent(client, "admin_deactivate_user", email);
    await client.query("commit");
    console.table([userSummary(result.rows[0])]);
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }

  const { options, positional } = parseOptions(rest);
  const client = new Client(getDatabaseConfig({ useSyncUrl: true }));
  await client.connect();
  try {
    if (command === "list") {
      await listUsers(client);
    } else if (command === "set-password") {
      const email = normalizeEmail(positional[0]);
      if (!email) throw new Error("set-password requires an email.");
      await setPassword(client, email, options);
    } else if (command === "set-role") {
      const email = normalizeEmail(positional[0]);
      const role = String(positional[1] || "").trim().toLowerCase();
      if (!email || !role) throw new Error("set-role requires an email and role.");
      await setRole(client, email, role);
    } else if (command === "deactivate") {
      const email = normalizeEmail(positional[0]);
      if (!email) throw new Error("deactivate requires an email.");
      await deactivateUser(client, email);
    } else {
      throw new Error(`Unknown command: ${command}`);
    }
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(error.message);
  console.error("");
  console.error(usage());
  process.exitCode = 1;
});
