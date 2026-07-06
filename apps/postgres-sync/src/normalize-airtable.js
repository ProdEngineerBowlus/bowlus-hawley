import pg from "pg";
import { getDatabaseConfig } from "./config.js";
import {
  displayValue,
  durationSecondsToHours,
  durationSecondsToMinutes,
  firstLinkedId,
  pickField,
  toDateString
} from "./value-utils.js";

const { Client } = pg;

function mapByRecordId(rows) {
  return new Map(rows.map(row => [row.record_id, row.fields_json || {}]));
}

function linkedDisplay(fields, fieldNames, lookup) {
  const value = pickField(fields, fieldNames);
  const id = firstLinkedId(value);
  if (id && lookup.has(id)) {
    return displayValue(pickField(lookup.get(id), ["Name", "Cycle Number", "Section/Column"])) || id;
  }
  return displayValue(value);
}

function linkedWorker(fields, workerLookup) {
  const id = firstLinkedId(pickField(fields, ["Assigned Worker", "Worker", "Primary Worker"]));
  const worker = id ? workerLookup.get(id) : null;
  return {
    id,
    name: worker ? displayValue(pickField(worker, ["Name", "Worker", "Employee"])) || id : displayValue(pickField(fields, ["Assigned Worker", "Worker", "Primary Worker"])),
    email: worker ? displayValue(pickField(worker, ["Email", "Assignee", "Worker Email"])) : displayValue(pickField(fields, ["Email", "Worker Email"]))
  };
}

function taskName(fields) {
  return displayValue(pickField(fields, [
    "Task Name",
    "Name",
    "Task",
    "Tasks",
    "Asana Task Name",
    "Task Label"
  ]));
}

function taskStatus(fields) {
  return displayValue(pickField(fields, [
    "Task Status",
    "Status",
    "Tracker Status",
    "Task Completed?"
  ]));
}

async function main() {
  const client = new Client(getDatabaseConfig());
  await client.connect();

  try {
    await client.query("begin");

    const taskRows = await client.query("select record_id, fields_json from raw.airtable_task_instances");
    const workerRows = await client.query("select record_id, fields_json from raw.airtable_work_force");
    const cycleRows = await client.query("select record_id, fields_json from raw.airtable_cycles");
    const phaseRows = await client.query("select record_id, fields_json from raw.airtable_phases");

    const workerLookup = mapByRecordId(workerRows.rows);
    const cycleLookup = mapByRecordId(cycleRows.rows);
    const phaseLookup = mapByRecordId(phaseRows.rows);

    const seenRecordIds = [];

    for (const row of taskRows.rows) {
      const fields = row.fields_json || {};
      const worker = linkedWorker(fields, workerLookup);
      const cycleName = linkedDisplay(fields, ["Cycle", "Cycle Number", "Cycle Label"], cycleLookup);
      const phaseName =
        linkedDisplay(fields, ["Phase", "Primary Phase"], phaseLookup) ||
        displayValue(pickField(fields, ["Section/Column"])) ||
        displayValue(pickField(fields, ["PhaseCycleBucketKey"]));

      const assignedOn = toDateString(pickField(fields, ["Assigned On", "Assigned Date"]));
      const estimatedHours = durationSecondsToHours(pickField(fields, ["Estimated Task Time", "Estimated Time", "Estimated Hours"]));
      const actualMinutes = durationSecondsToMinutes(pickField(fields, ["Actual time", "Actual Time", "Actual Time Minutes"]));

      await client.query(
        `
          insert into core.task_instances (
            airtable_record_id,
            asana_task_gid,
            worker_name,
            worker_email,
            phase_name,
            cycle_name,
            vin,
            assigned_on,
            task_name,
            task_status,
            estimated_hours,
            actual_time_minutes,
            source_updated_at,
            normalized_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10, $11, $12, now(), now())
          on conflict (airtable_record_id) do update set
            asana_task_gid = excluded.asana_task_gid,
            worker_name = excluded.worker_name,
            worker_email = excluded.worker_email,
            phase_name = excluded.phase_name,
            cycle_name = excluded.cycle_name,
            vin = excluded.vin,
            assigned_on = excluded.assigned_on,
            task_name = excluded.task_name,
            task_status = excluded.task_status,
            estimated_hours = excluded.estimated_hours,
            actual_time_minutes = excluded.actual_time_minutes,
            source_updated_at = excluded.source_updated_at,
            normalized_at = now()
        `,
        [
          row.record_id,
          displayValue(pickField(fields, ["Asana Task GID", "Asana Task ID"])),
          worker.name || null,
          worker.email || null,
          phaseName || null,
          cycleName || null,
          displayValue(pickField(fields, ["VIN", "VIN Number"])) || null,
          assignedOn,
          taskName(fields) || null,
          taskStatus(fields) || null,
          estimatedHours,
          actualMinutes
        ]
      );
      seenRecordIds.push(row.record_id);
    }

    if (seenRecordIds.length) {
      await client.query(
        "delete from sync.record_map where airtable_record_id is not null and not (airtable_record_id = any($1::text[]))",
        [seenRecordIds]
      );

      await client.query(
        `
          insert into sync.record_map (
            asana_task_gid,
            airtable_record_id,
            core_task_instance_id,
            source_type,
            last_seen_at,
            last_synced_at
          )
          select
            nullif(asana_task_gid, ''),
            airtable_record_id,
            id,
            'airtable_task_instance',
            now(),
            now()
          from core.task_instances
          where airtable_record_id = any($1::text[])
          on conflict do nothing
        `,
        [seenRecordIds]
      );
    }

    await client.query("commit");
    console.log(`Normalized ${seenRecordIds.length} Task Instances Rev1 record(s) into core.task_instances.`);
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
