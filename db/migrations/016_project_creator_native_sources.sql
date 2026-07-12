create table if not exists raw.airtable_vins (
  record_id text primary key,
  fields_json jsonb not null,
  airtable_created_at timestamptz,
  modified_at timestamptz,
  source_table_name text,
  synced_at timestamptz not null default now()
);

create table if not exists raw.airtable_models (
  record_id text primary key,
  fields_json jsonb not null,
  airtable_created_at timestamptz,
  modified_at timestamptz,
  source_table_name text,
  synced_at timestamptz not null default now()
);

create index if not exists idx_airtable_vins_vin
  on raw.airtable_vins ((fields_json->>'VIN'));

alter table hb.task_templates
  add column if not exists parity_mode text,
  add column if not exists supported_phase_record_id text,
  add column if not exists supported_phase_name text,
  add column if not exists supported_offset numeric(12, 4),
  add column if not exists model_type_record_ids text[] not null default '{}'::text[],
  add column if not exists model_type_names text[] not null default '{}'::text[],
  add column if not exists frame_class_record_ids text[] not null default '{}'::text[],
  add column if not exists frame_class_names text[] not null default '{}'::text[];

create table if not exists hb.vins (
  vin_record_id text primary key,
  vin integer,
  vin_text text,
  model_type_record_ids text[] not null default '{}'::text[],
  model_type_names text[] not null default '{}'::text[],
  frame_class_record_ids text[] not null default '{}'::text[],
  frame_class_names text[] not null default '{}'::text[],
  fields_json jsonb not null default '{}'::jsonb,
  source_system text not null default 'airtable_vins',
  source_synced_at timestamptz,
  normalized_at timestamptz not null default now()
);

create index if not exists idx_hb_vins_vin
  on hb.vins(vin);

create table if not exists hb.models (
  model_record_id text primary key,
  model_name text,
  frame_class text,
  fields_json jsonb not null default '{}'::jsonb,
  source_system text not null default 'airtable_models',
  source_synced_at timestamptz,
  normalized_at timestamptz not null default now()
);

create index if not exists idx_hb_models_name
  on hb.models(model_name);

create unique index if not exists idx_hb_rev1_task_instances_hawley_key
  on hb.rev1_task_instances(task_instance_rev1_key)
  where source_system = 'hawley_project_creator'
    and task_instance_rev1_key is not null;

create table if not exists hb.project_creation_runs (
  project_creation_run_id text primary key,
  project_name text,
  project_type text,
  mode text not null default 'asana_test_create',
  status text not null default 'started',
  actor_email text,
  production_record_id text,
  cycle_record_id text,
  cycle_label text,
  phase_record_id text,
  phase_name text,
  vin text,
  asana_project_gid text,
  task_count integer not null default 0,
  root_task_count integer not null default 0,
  subtask_count integer not null default 0,
  estimated_seconds integer not null default 0,
  error_message text,
  request_json jsonb not null default '{}'::jsonb,
  result_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

grant select, insert, update, delete on
  raw.airtable_vins,
  raw.airtable_models,
  hb.vins,
  hb.models,
  hb.project_creation_runs
to bowlus_sync;

grant select, insert, update, delete on
  hb.project_creation_runs
to bowlus_app;

grant select on
  raw.airtable_vins,
  raw.airtable_models,
  hb.vins,
  hb.models,
  hb.project_creation_runs
to bowlus_app, bowlus_readonly;
