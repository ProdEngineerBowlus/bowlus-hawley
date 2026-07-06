create table if not exists raw.airtable_schema_tables (
  table_id text primary key,
  table_name text not null,
  primary_field_id text,
  raw_json jsonb not null,
  synced_at timestamptz not null default now()
);

create table if not exists raw.airtable_schema_fields (
  table_id text not null,
  field_id text not null,
  table_name text not null,
  field_name text not null,
  field_type text,
  field_description text,
  raw_json jsonb not null,
  synced_at timestamptz not null default now(),
  primary key (table_id, field_id)
);

grant select, insert, update, delete on raw.airtable_schema_tables to bowlus_sync;
grant select, insert, update, delete on raw.airtable_schema_fields to bowlus_sync;
