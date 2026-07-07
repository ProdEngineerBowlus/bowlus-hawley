create table if not exists raw.airtable_worker_daily_actuals (
  record_id text primary key,
  fields_json jsonb not null,
  airtable_created_at timestamptz,
  modified_at timestamptz,
  source_table_name text,
  synced_at timestamptz not null default now()
);

create index if not exists idx_airtable_worker_daily_actuals_work_date
  on raw.airtable_worker_daily_actuals ((fields_json->>'Work Date'));

create index if not exists idx_airtable_worker_daily_actuals_worker_key
  on raw.airtable_worker_daily_actuals ((fields_json->>'Worker Key'));

grant select, insert, update, delete on raw.airtable_worker_daily_actuals to bowlus_sync;
