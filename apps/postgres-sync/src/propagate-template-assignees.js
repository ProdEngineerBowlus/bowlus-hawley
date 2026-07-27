import pg from "pg";
import { getDatabaseConfig } from "./config.js";

const { Client } = pg;
const AIRTABLE_API_BASE = "https://api.airtable.com/v0";
const ASANA_API_BASE = "https://app.asana.com/api/1.0";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const minVinIndex = process.argv.indexOf("--min-vin");
const minVin = minVinIndex >= 0 ? Number(process.argv[minVinIndex + 1]) : 325;
const phaseNames = ["phase c", "phase d"];

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}.`);
  return value;
}

function batches(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

async function request(url, { method = "GET", token, body }) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${url} failed (${response.status}): ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

async function loadAirtableActions(client) {
  const result = await client.query(
    `
      with template_owners as (
        select
          template.record_id as task_record_id,
          lower(coalesce(template.fields_json -> 'Assignee' ->> 0, '')) as desired_email,
          lower(coalesce(template.fields_json ->> 'Section/Column', '')) as phase_name
        from raw.airtable_tasks template
        where lower(coalesce(template.fields_json ->> 'Section/Column', '')) = any($1::text[])
      ), workforce as (
        select
          worker.record_id as worker_record_id,
          worker.fields_json ->> 'Name' as worker_name,
          lower(coalesce(worker.fields_json ->> 'Assignee', '')) as worker_email
        from raw.airtable_work_force worker
      ), asana_users as (
        select
          lower(assignee_email) as worker_email,
          min(assignee_gid) as assignee_gid
        from raw.asana_tasks
        where assignee_email is not null
          and assignee_gid is not null
        group by lower(assignee_email)
      )
      select distinct on (instance.record_id)
        instance.record_id as airtable_record_id,
        instance.fields_json ->> 'Asana Task GID' as asana_task_gid,
        instance.fields_json ->> 'Task Name' as task_name,
        (instance.fields_json ->> 'VIN')::int as vin,
        owner.phase_name,
        workforce.worker_record_id,
        workforce.worker_name,
        workforce.worker_email,
        asana.assignee_gid as asana_assignee_gid,
        coalesce(instance.fields_json -> 'Assigned Worker' ->> 0, '') as current_worker_record_id
      from raw.airtable_task_instances instance
      join template_owners owner
        on coalesce(instance.fields_json -> 'Tasks', '[]'::jsonb) ? owner.task_record_id
      join workforce
        on workforce.worker_email = owner.desired_email
      left join asana_users as asana on asana.worker_email = workforce.worker_email
      where coalesce(instance.fields_json ->> 'VIN', '') ~ '^[0-9]+$'
        and (instance.fields_json ->> 'VIN')::int >= $2
        and not coalesce((instance.fields_json ->> 'Task Completed?')::boolean, false)
        and coalesce(instance.fields_json -> 'Assigned Worker' ->> 0, '') <> workforce.worker_record_id
      order by instance.record_id, owner.phase_name
    `,
    [phaseNames, minVin]
  );
  return result.rows;
}

async function loadAsanaActions(client) {
  const result = await client.query(
    `
      with phase_owners as (
        select
          lower(template.fields_json ->> 'Section/Column') as phase_name,
          min(lower(template.fields_json -> 'Assignee' ->> 0)) as desired_email
        from raw.airtable_tasks template
        where lower(template.fields_json ->> 'Section/Column') = any($1::text[])
        group by lower(template.fields_json ->> 'Section/Column')
        having count(distinct lower(template.fields_json -> 'Assignee' ->> 0)) = 1
      ), workforce as (
        select
          worker.fields_json ->> 'Name' as worker_name,
          lower(worker.fields_json ->> 'Assignee') as worker_email
        from raw.airtable_work_force worker
      ), asana_users as (
        select lower(assignee_email) as worker_email, min(assignee_gid) as assignee_gid
        from raw.asana_tasks
        where assignee_email is not null and assignee_gid is not null
        group by lower(assignee_email)
      )
      select
        instance.asana_task_gid,
        instance.task_name,
        instance.vin,
        owner.phase_name,
        workforce.worker_name,
        workforce.worker_email,
        asana_users.assignee_gid as asana_assignee_gid
      from hb.rev1_task_instances instance
      join phase_owners owner
        on owner.phase_name = case
          when lower(coalesce(instance.phase_label, instance.section_column, '')) in ('c', 'phase c') then 'phase c'
          when lower(coalesce(instance.phase_label, instance.section_column, '')) in ('d', 'phase d') then 'phase d'
        end
      join workforce on workforce.worker_email = owner.desired_email
      join asana_users on asana_users.worker_email = workforce.worker_email
      where instance.vin >= $2
        and not coalesce(instance.task_completed, false)
        and instance.asana_task_gid is not null
        and lower(coalesce(instance.assignee_email, instance.worker_email, '')) <> workforce.worker_email
      order by instance.vin, owner.phase_name, instance.task_name
    `,
    [phaseNames, minVin]
  );
  return result.rows;
}

async function applyAirtable(actions, { baseId, token }) {
  for (const chunk of batches(actions, 10)) {
    await request(`${AIRTABLE_API_BASE}/${encodeURIComponent(baseId)}/Task%20Instances%20Rev1`, {
      method: "PATCH",
      token,
      body: {
        records: chunk.map(action => ({
          id: action.airtable_record_id,
          fields: {
            "Assigned Worker": [action.worker_record_id],
            Email: action.worker_email,
            "Assignee Name": action.worker_name,
            "Assignee Email": action.worker_email
          }
        }))
      }
    });
  }
}

async function applyAsana(actions, token) {
  const concurrency = 4;
  let next = 0;
  const worker = async () => {
    while (next < actions.length) {
      const action = actions[next++];
      await request(`${ASANA_API_BASE}/tasks/${encodeURIComponent(action.asana_task_gid)}`, {
        method: "PUT",
        token,
        body: { data: { assignee: action.asana_assignee_gid } }
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, actions.length) }, worker));
  return { updated: actions.length };
}

async function main() {
  if (!Number.isInteger(minVin) || minVin < 1) throw new Error("--min-vin must be a positive integer.");
  if (apply && process.env.HAWLEY_ALLOW_SOURCE_WRITES !== "true") {
    throw new Error("Refusing source writes. Set HAWLEY_ALLOW_SOURCE_WRITES=true with --apply.");
  }

  const client = new Client(getDatabaseConfig({ useSyncUrl: true }));
  await client.connect();
  try {
    const airtableActions = await loadAirtableActions(client);
    const asanaActions = await loadAsanaActions(client);
    const summary = {
      mode: apply ? "apply" : "dry-run",
      minVin,
      airtableTaskInstances: airtableActions.length,
      asanaProjectTasks: asanaActions.length,
      byPhase: Object.fromEntries(phaseNames.map(phase => [phase, {
        airtable: airtableActions.filter(action => action.phase_name === phase).length,
        asana: asanaActions.filter(action => action.phase_name === phase).length
      }])),
      samples: asanaActions.slice(0, 10).map(action => ({
        vin: action.vin,
        phase: action.phase_name,
        task: action.task_name,
        worker: action.worker_name
      }))
    };

    if (!apply || (!airtableActions.length && !asanaActions.length)) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    const airtableToken = requiredEnv("AIRTABLE_PAT");
    const airtableBase = requiredEnv("AIRTABLE_BASE");
    const asanaToken = requiredEnv("ASANA_PAT");
    await applyAirtable(airtableActions, { baseId: airtableBase, token: airtableToken });
    summary.airtableUpdated = airtableActions.length;
    summary.asana = await applyAsana(asanaActions, asanaToken);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
