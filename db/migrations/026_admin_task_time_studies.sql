-- Manager-configured time studies measure a named slice of normal task labor.
-- They are intentionally separate from core.time_sessions and the worker-day
-- actuals ledger so a study lap cannot inflate labor, pacing, or efficiency.

create table if not exists core.task_time_studies (
  task_time_study_id bigserial primary key,
  study_key text not null unique,
  worker_key text not null,
  worker_name text,
  worker_email text,
  asana_task_gid text not null,
  task_instance_id bigint,
  task_name text not null,
  phase_key text,
  phase_name text,
  work_date date not null,
  label text not null,
  is_active boolean not null default true,
  created_by_email text,
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_by_email text,
  ended_reason text,
  source_payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_task_time_studies_one_active_task
  on core.task_time_studies(worker_key, work_date, asana_task_gid)
  where is_active;
create index if not exists idx_task_time_studies_worker_date
  on core.task_time_studies(worker_key, work_date, created_at desc);

create table if not exists core.task_time_study_laps (
  task_time_study_lap_id bigserial primary key,
  lap_key text not null unique,
  task_time_study_id bigint not null references core.task_time_studies(task_time_study_id) on delete cascade,
  started_at timestamptz not null,
  stopped_at timestamptz,
  duration_minutes integer,
  stop_reason text,
  started_by_email text,
  stopped_by_email text,
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_task_time_study_laps_one_open
  on core.task_time_study_laps(task_time_study_id)
  where stopped_at is null;
create index if not exists idx_task_time_study_laps_study
  on core.task_time_study_laps(task_time_study_id, started_at desc);

grant select, insert, update, delete on
  core.task_time_studies,
  core.task_time_study_laps
to bowlus_app, bowlus_sync;
grant usage, select on sequence
  core.task_time_studies_task_time_study_id_seq,
  core.task_time_study_laps_task_time_study_lap_id_seq
to bowlus_app, bowlus_sync;
