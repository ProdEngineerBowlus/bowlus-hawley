-- CNC machine runtime is intentionally separate from worker labor time.
-- A machine can run while the CNC operator is setting up, deburring, or
-- tending another machine, so these intervals must not be summed into the
-- operator's daily utilization.

create table if not exists hb.cnc_program_runtime_profiles (
  program_key text primary key,
  program_name text not null,
  gcode_relative_path text,
  completed_run_count integer not null default 0,
  total_attempt_count integer not null default 0,
  non_normal_attempt_count integer not null default 0,
  estimated_runtime_minutes numeric(10, 2),
  average_runtime_minutes numeric(10, 2),
  median_runtime_minutes numeric(10, 2),
  minimum_runtime_minutes numeric(10, 2),
  maximum_runtime_minutes numeric(10, 2),
  average_cut_length_meters numeric(12, 2),
  last_normal_run_at timestamptz,
  confidence text not null default 'no_observation',
  source_system text not null default 'de_job_history',
  source_loaded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists core.cnc_machine_runs (
  cnc_machine_run_id bigserial primary key,
  machine_run_key text not null unique,
  worker_key text not null,
  worker_name text,
  worker_email text,
  machine_key text not null default 'de_cnc',
  asana_task_gid text not null,
  task_instance_id bigint,
  task_name text not null,
  phase_key text,
  phase_name text,
  work_date date not null,
  program_key text not null references hb.cnc_program_runtime_profiles(program_key),
  program_name text not null,
  expected_runtime_minutes numeric(10, 2) not null,
  alert_after_minutes numeric(10, 2) not null,
  started_at timestamptz not null,
  stopped_at timestamptz,
  machine_runtime_minutes numeric(10, 2),
  status text not null default 'running' check (status in ('running', 'completed', 'stopped', 'released')),
  overrun_alerted_at timestamptz,
  stopped_by_email text,
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_cnc_machine_runs_active_worker
  on core.cnc_machine_runs(worker_key, work_date, started_at desc)
  where status = 'running';
create index if not exists idx_cnc_machine_runs_task
  on core.cnc_machine_runs(asana_task_gid, started_at desc);

grant select, insert, update, delete on
  hb.cnc_program_runtime_profiles,
  core.cnc_machine_runs
to bowlus_app, bowlus_sync;
grant usage, select on sequence core.cnc_machine_runs_cnc_machine_run_id_seq
to bowlus_app, bowlus_sync;
