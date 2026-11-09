-- Generic mirror for Airtable tables Hawley doesn't model yet (Engineering Changes and anything else in the base that
-- has no raw.airtable_* table). Read by nothing in the HB build, so filling it can never overwrite Hawley data; views
-- on top of it (like reporting.airtable_engineering_changes) are added as each table gets used.
create table if not exists raw.airtable_records (
  table_id text not null,
  table_name text not null,
  record_id text not null,
  fields_json jsonb not null,
  airtable_created_at timestamptz,
  synced_at timestamptz not null default now(),
  primary key (table_id, record_id)
);

create index if not exists idx_raw_airtable_records_table_name on raw.airtable_records(table_name);

grant select, insert, update, delete on raw.airtable_records to bowlus_sync;
grant select on raw.airtable_records to bowlus_app;

-- Engineering changes, linked from CNC parts (hb.cnc_parts_master.engineering_change_record_ids) and VINs.
create or replace view reporting.airtable_engineering_changes as
select
  record_id as engineering_change_record_id,
  fields_json,
  airtable_created_at,
  synced_at
from raw.airtable_records
where table_name = 'Engineering Changes';

grant select on reporting.airtable_engineering_changes to bowlus_app, bowlus_readonly;
