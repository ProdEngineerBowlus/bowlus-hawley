create table if not exists raw.airtable_cnc_parts_master (
  record_id text primary key,
  fields_json jsonb not null,
  airtable_created_at timestamptz,
  modified_at timestamptz,
  source_table_name text,
  synced_at timestamptz not null default now()
);

grant select, insert, update, delete on raw.airtable_cnc_parts_master to bowlus_sync;
