import pg from "pg";
import { getDatabaseConfig } from "./config.js";

const { Client } = pg;

const COUNT_QUERIES = Object.freeze([
  ["raw.airtable_schema_tables", "select count(*)::int as count from raw.airtable_schema_tables"],
  ["raw.airtable_schema_fields", "select count(*)::int as count from raw.airtable_schema_fields"],
  ["raw.airtable_task_instances", "select count(*)::int as count from raw.airtable_task_instances"],
  ["raw.airtable_cycles", "select count(*)::int as count from raw.airtable_cycles"],
  ["raw.airtable_work_force", "select count(*)::int as count from raw.airtable_work_force"],
  ["raw.airtable_phase_cycle_load", "select count(*)::int as count from raw.airtable_phase_cycle_load"],
  ["raw.airtable_worker_cycle_bank", "select count(*)::int as count from raw.airtable_worker_cycle_bank"],
  ["raw.airtable_phases", "select count(*)::int as count from raw.airtable_phases"],
  ["raw.airtable_worker_phase_allocation", "select count(*)::int as count from raw.airtable_worker_phase_allocation"],
  ["raw.asana_portfolios", "select count(*)::int as count from raw.asana_portfolios"],
  ["raw.asana_portfolio_projects", "select count(*)::int as count from raw.asana_portfolio_projects"],
  ["raw.asana_projects", "select count(*)::int as count from raw.asana_projects"],
  ["raw.asana_tasks", "select count(*)::int as count from raw.asana_tasks"],
  ["raw.asana_task_project_memberships", "select count(*)::int as count from raw.asana_task_project_memberships"],
  ["core.task_instances", "select count(*)::int as count from core.task_instances"],
  [
    "reporting.daily_worker_assignments",
    "select count(*)::int as count from reporting.daily_worker_assignments"
  ]
]);

async function main() {
  const client = new Client(getDatabaseConfig());
  await client.connect();

  try {
    const counts = {};
    for (const [name, sql] of COUNT_QUERIES) {
      const result = await client.query(sql);
      counts[name] = result.rows[0].count;
    }

    const run = await client.query(`
      select id, job_name, status, records_read, records_written, error_count, ended_at
      from sync.run_log
      where job_name in ('pull_airtable', 'pull_asana')
      order by id desc
      limit 1
    `);

    const fieldSummary = await client.query(`
      with payload_fields as (
        select distinct key as field_name
        from raw.airtable_task_instances,
        lateral jsonb_object_keys(fields_json) as key
      ),
      schema_fields as (
        select field_name
        from raw.airtable_schema_fields
        where table_name = 'Task Instances Rev1'
      )
      select
        (select count(*) from payload_fields)::int as distinct_task_instance_field_count,
        (select count(*) from schema_fields)::int as task_instance_schema_field_count,
        (select count(*) from schema_fields sf where not exists (
          select 1 from payload_fields pf where pf.field_name = sf.field_name
        ))::int as task_instance_schema_fields_absent_from_payload
    `);

    console.log(JSON.stringify({
      latestAirtableRun: run.rows[0] || null,
      counts,
      taskInstanceFieldCount: fieldSummary.rows[0]?.distinct_task_instance_field_count || 0,
      taskInstanceSchemaFieldCount: fieldSummary.rows[0]?.task_instance_schema_field_count || 0,
      taskInstanceSchemaFieldsAbsentFromPayload: fieldSummary.rows[0]?.task_instance_schema_fields_absent_from_payload || 0
    }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
