create table if not exists raw.airtable_tasks (
  record_id text primary key,
  fields_json jsonb not null,
  airtable_created_at timestamptz,
  modified_at timestamptz,
  source_table_name text,
  synced_at timestamptz not null default now()
);

create table if not exists raw.airtable_production (
  record_id text primary key,
  fields_json jsonb not null,
  airtable_created_at timestamptz,
  modified_at timestamptz,
  source_table_name text,
  synced_at timestamptz not null default now()
);

create index if not exists idx_airtable_tasks_tasks_key
  on raw.airtable_tasks ((fields_json->>'TasksKey'));

create index if not exists idx_airtable_tasks_task_name
  on raw.airtable_tasks ((fields_json->>'Task Name'));

create index if not exists idx_airtable_production_cycle_number
  on raw.airtable_production ((fields_json->>'Cycle Number'));

create index if not exists idx_airtable_production_start_date
  on raw.airtable_production ((fields_json->>'Start Date'));

create table if not exists hb.task_templates (
  task_record_id text primary key,
  tasks_key text,
  task_name text,
  parent_task_record_id text,
  parent_task_name text,
  task_order numeric(12, 2),
  quantity numeric(12, 4),
  estimated_task_time_seconds integer,
  estimated_batch_task_time_seconds integer,
  primary_phase_record_id text,
  primary_phase_name text,
  phase_record_ids text[] not null default '{}'::text[],
  phase_names text[] not null default '{}'::text[],
  primary_worker_record_id text,
  primary_worker_name text,
  assigned_worker_record_ids text[] not null default '{}'::text[],
  assigned_worker_names text[] not null default '{}'::text[],
  assignee_email text,
  document_link text,
  attachment_summary text,
  attachment_files_json jsonb not null default '[]'::jsonb,
  task_description text,
  template_status text,
  active boolean,
  fields_json jsonb not null default '{}'::jsonb,
  source_system text not null default 'airtable_tasks',
  source_synced_at timestamptz,
  normalized_at timestamptz not null default now()
);

create table if not exists hb.production_schedule (
  production_record_id text primary key,
  schedule_key text,
  schedule_name text,
  cycle_number integer,
  cycle_label text,
  short_cycle_label text,
  cycle_record_id text,
  phase_record_id text,
  phase_name text,
  section_column text,
  asana_section text,
  vin text,
  vin_values text[] not null default '{}'::text[],
  vin_record_ids text[] not null default '{}'::text[],
  model_type text,
  start_date date,
  end_date date,
  days_in_cycle integer,
  task_instance_record_ids text[] not null default '{}'::text[],
  existing_rev1_task_instance_links integer not null default 0,
  fields_json jsonb not null default '{}'::jsonb,
  source_system text not null default 'airtable_production',
  source_synced_at timestamptz,
  normalized_at timestamptz not null default now()
);

create index if not exists idx_hb_task_templates_tasks_key
  on hb.task_templates(tasks_key);

create index if not exists idx_hb_task_templates_primary_phase
  on hb.task_templates(primary_phase_record_id);

create index if not exists idx_hb_task_templates_parent_task
  on hb.task_templates(parent_task_record_id);

create index if not exists idx_hb_production_schedule_key
  on hb.production_schedule(schedule_key);

create index if not exists idx_hb_production_schedule_cycle_phase
  on hb.production_schedule(cycle_record_id, phase_record_id);

create index if not exists idx_hb_production_schedule_vin
  on hb.production_schedule(vin);

create index if not exists idx_hb_production_schedule_dates
  on hb.production_schedule(start_date, end_date);

grant select, insert, update, delete on
  raw.airtable_tasks,
  raw.airtable_production
to bowlus_sync;

grant select, insert, update, delete on
  hb.task_templates,
  hb.production_schedule
to bowlus_sync;

grant select on
  hb.task_templates,
  hb.production_schedule
to bowlus_app, bowlus_readonly;
