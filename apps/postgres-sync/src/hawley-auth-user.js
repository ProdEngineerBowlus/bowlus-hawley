import crypto from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";
import { getDatabaseConfig } from "./config.js";

const { Client } = pg;
const scryptAsync = promisify(crypto.scrypt);
const DEFAULT_PILOT_ADMINS = ["erick t", "jacob r", "prodengineering@bowlusroadchief.com"];
const DEFAULT_PILOT_MANAGERS = ["cesar z"];

function usage() {
  return `
Usage:
  npm run pg:hawley-auth-user -- list
  npm run pg:hawley-auth-user -- setup-pilot-roster [--admin="Erick T"] [--manager="Cesar Z"]
  npm run pg:hawley-auth-user -- verify-passwords
  npm run pg:hawley-auth-user -- set-password <email> [--active] [--role=worker|manager|admin]
  npm run pg:hawley-auth-user -- set-role <email> <worker|manager|admin>
  npm run pg:hawley-auth-user -- deactivate <email>

Set HAWLEY_AUTH_PASSWORD in the shell before setup-pilot-roster, verify-passwords,
or set-password. The password is never printed and is stored only as a salted
scrypt hash. By default setup-pilot-roster makes Erick T, Jacob R, and
prodengineering@bowlusroadchief.com admins, Cesar Z a manager, and everyone else
a worker.
`.trim();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function parseOptions(args) {
  const options = { admins: [], managers: [] };
  const positional = [];
  for (const arg of args) {
    if (arg === "--active") {
      options.active = true;
    } else if (arg === "--inactive") {
      options.active = false;
    } else if (arg.startsWith("--role=")) {
      options.role = arg.slice("--role=".length).trim().toLowerCase();
    } else if (arg.startsWith("--admin=")) {
      options.admins.push(arg.slice("--admin=".length).trim());
    } else if (arg.startsWith("--manager=")) {
      options.managers.push(arg.slice("--manager=".length).trim());
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

async function verifyPassword(password, storedHash) {
  const [scheme, version, salt, keyHex] = String(storedHash || "").split("$");
  if (scheme !== "scrypt" || version !== "1" || !salt || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const actual = Buffer.from(await scryptAsync(String(password || ""), salt, expected.length));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function normalizeNameMatch(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9@.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function localPart(value) {
  return String(value || "").split("@")[0] || "";
}

function candidateNames(row) {
  return [
    row.display_name,
    row.worker_name,
    row.workerName,
    row.email,
    row.worker_email,
    row.workerEmail,
    row.username,
    localPart(row.email),
    localPart(row.worker_email || row.workerEmail || row.username)
  ].filter(Boolean);
}

function firstLastInitialMatch(spec, candidate) {
  const specParts = normalizeNameMatch(spec).split(" ").filter(Boolean);
  const candidateParts = normalizeNameMatch(candidate).split(" ").filter(Boolean);
  if (specParts.length !== 2 || specParts[1].length !== 1 || candidateParts.length < 2) return false;
  return candidateParts[0] === specParts[0] && candidateParts[candidateParts.length - 1].startsWith(specParts[1]);
}

function rosterSpecMatches(spec, row) {
  const normalizedSpec = normalizeNameMatch(spec);
  if (!normalizedSpec) return false;
  return candidateNames(row).some(candidate => {
    const normalizedCandidate = normalizeNameMatch(candidate);
    return normalizedCandidate === normalizedSpec
      || firstLastInitialMatch(normalizedSpec, normalizedCandidate)
      || (normalizedSpec.includes("@") && normalizeEmail(candidate) === normalizeEmail(spec));
  });
}

function roleForRosterRow(row, adminSpecs, managerSpecs) {
  if (adminSpecs.some(spec => rosterSpecMatches(spec, row))) return "admin";
  if (managerSpecs.some(spec => rosterSpecMatches(spec, row))) return "manager";
  return "worker";
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

async function activeWorkForceRows(client) {
  const result = await client.query(
    `
      select
        lower(nullif(worker_email, '')) as username,
        worker_name as display_name,
        lower(nullif(worker_email, '')) as email,
        'asana-' || trim(both '-' from regexp_replace(
          case
            when lower(nullif(worker_email, '')) like 'asana+%' then substring(lower(nullif(worker_email, '')) from 7)
            else lower(nullif(worker_email, ''))
          end,
          '[^a-z0-9]+',
          '-',
          'g'
        )) as worker_key,
        worker_name,
        lower(nullif(worker_email, '')) as worker_email,
        source_synced_at
      from (
        select distinct on (lower(nullif(worker_email, ''))) *
        from hb.work_force
        where actively_employed
          and nullif(worker_email, '') is not null
        order by lower(nullif(worker_email, '')), source_synced_at desc nulls last, worker_name
      ) workforce
      order by worker_name, worker_email
    `
  );
  return result.rows;
}

async function existingAuthRows(client) {
  try {
    const result = await client.query(
      `
        select
          username,
          display_name,
          email,
          worker_key,
          worker_name,
          worker_email,
          role,
          active,
          password_hash,
          temporary_password,
          last_login_at,
          source_synced_at
        from core.app_users
      `
    );
    return result.rows;
  } catch {
    return [];
  }
}

function mergeRosterRows(workForceRows, authRows) {
  const byEmail = new Map();
  for (const row of authRows) {
    const email = normalizeEmail(row.email || row.worker_email || row.username);
    if (!email) continue;
    byEmail.set(email, {
      username: email,
      display_name: row.display_name || row.worker_name || email,
      email,
      worker_key: row.worker_key || workerKeyFromEmail(email, row.display_name || row.worker_name || email),
      worker_name: row.worker_name || row.display_name || email,
      worker_email: normalizeEmail(row.worker_email || email),
      source_synced_at: row.source_synced_at || null
    });
  }

  for (const row of workForceRows) {
    const email = normalizeEmail(row.email || row.worker_email || row.username);
    if (!email) continue;
    byEmail.set(email, {
      username: email,
      display_name: row.display_name || row.worker_name || email,
      email,
      worker_key: row.worker_key || workerKeyFromEmail(email, row.display_name || row.worker_name || email),
      worker_name: row.worker_name || row.display_name || email,
      worker_email: normalizeEmail(row.worker_email || email),
      source_synced_at: row.source_synced_at || null
    });
  }

  return [...byEmail.values()].sort((left, right) =>
    String(left.display_name || left.email).localeCompare(String(right.display_name || right.email))
  );
}

function assertRosterSpecsMatched(rows, adminSpecs, managerSpecs) {
  const allSpecs = [
    ...adminSpecs.map(spec => ({ role: "admin", spec })),
    ...managerSpecs.map(spec => ({ role: "manager", spec }))
  ];
  const unmatched = allSpecs.filter(({ spec }) => !rows.some(row => rosterSpecMatches(spec, row)));
  if (unmatched.length) {
    const details = unmatched.map(item => `${item.role}:${item.spec}`).join(", ");
    throw new Error(`Could not match these requested pilot roles to roster emails: ${details}`);
  }
}

async function rosterUserRows(client) {
  const result = await client.query(
    `
      select username, display_name, email, role, active, worker_key, worker_name, worker_email, temporary_password, last_login_at, password_hash
      from core.app_users
      order by active desc, role desc, display_name nulls last, username
    `
  );
  return result.rows;
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

function passwordRequired(command) {
  const password = process.env.HAWLEY_AUTH_PASSWORD;
  if (!password) throw new Error(`Set HAWLEY_AUTH_PASSWORD before running ${command}.`);
  return password;
}

function pilotRosterSummary(row, passwordVerified = null) {
  return {
    name: row.display_name || row.worker_name || "",
    email: row.email || row.worker_email || row.username || "",
    role: row.role,
    active: Boolean(row.active),
    temporaryPassword: Boolean(row.temporary_password),
    passwordVerified: passwordVerified === null ? "" : Boolean(passwordVerified),
    lastLoginAt: row.last_login_at || ""
  };
}

async function setupPilotRoster(client, options) {
  const password = passwordRequired("setup-pilot-roster");
  const adminSpecs = options.admins.length ? options.admins : DEFAULT_PILOT_ADMINS;
  const managerSpecs = options.managers.length ? options.managers : DEFAULT_PILOT_MANAGERS;
  const rosterRows = mergeRosterRows(await activeWorkForceRows(client), await existingAuthRows(client));
  if (!rosterRows.length) throw new Error("No active workforce rows with email addresses were found.");
  assertRosterSpecsMatched(rosterRows, adminSpecs, managerSpecs);

  await client.query("begin");
  try {
    for (const row of rosterRows) {
      const email = normalizeEmail(row.email || row.worker_email || row.username);
      const role = roleForRosterRow(row, adminSpecs, managerSpecs);
      const passwordHash = await hashPassword(password);
      await client.query(
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
            source_synced_at,
            updated_at
          )
          values ($1, $2, $1, $3, $4, $5, $6, true, $7, now(), true, 'hawley_auth_admin_cli', $8, now())
          on conflict (username) do update set
            display_name = excluded.display_name,
            email = excluded.email,
            worker_key = excluded.worker_key,
            worker_name = excluded.worker_name,
            worker_email = excluded.worker_email,
            role = excluded.role,
            active = true,
            password_hash = excluded.password_hash,
            password_set_at = now(),
            temporary_password = true,
            source_system = excluded.source_system,
            source_synced_at = excluded.source_synced_at,
            updated_at = now()
        `,
        [
          email,
          row.display_name || row.worker_name || email,
          row.worker_key || workerKeyFromEmail(email, row.display_name || row.worker_name || email),
          row.worker_name || row.display_name || email,
          normalizeEmail(row.worker_email || email),
          role,
          passwordHash,
          row.source_synced_at || null
        ]
      );
      await recordAdminEvent(client, "admin_setup_pilot_roster_user", email, { role });
    }
    await recordAdminEvent(client, "admin_setup_pilot_roster", "bulk", {
      users: rosterRows.length,
      admins: adminSpecs,
      managers: managerSpecs
    });
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }

  const users = await rosterUserRows(client);
  const summaries = [];
  for (const row of users) {
    summaries.push(pilotRosterSummary(row, await verifyPassword(password, row.password_hash)));
  }
  console.table(summaries);
}

async function verifyRosterPasswords(client) {
  const password = passwordRequired("verify-passwords");
  const users = await rosterUserRows(client);
  const summaries = [];
  for (const row of users) {
    summaries.push(pilotRosterSummary(row, await verifyPassword(password, row.password_hash)));
  }
  console.table(summaries);
  const failed = summaries.filter(row => row.active && !row.passwordVerified);
  if (failed.length) {
    throw new Error(`${failed.length} active users did not verify against HAWLEY_AUTH_PASSWORD.`);
  }
}

async function setPassword(client, email, options) {
  const password = passwordRequired("set-password");
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
    } else if (command === "setup-pilot-roster") {
      await setupPilotRoster(client, options);
    } else if (command === "verify-passwords") {
      await verifyRosterPasswords(client);
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
