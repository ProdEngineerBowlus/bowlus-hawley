create table if not exists core.capacity_recommendation_runs (
  recommendation_id uuid primary key,
  cycle_number integer not null,
  cycle_label text,
  phase_label text not null,
  requested_hours numeric(12, 2) not null,
  recommended_hours numeric(12, 2) not null default 0,
  status text not null default 'preview',
  generated_by text,
  preview_json jsonb not null default '{}'::jsonb,
  commit_result_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 minutes',
  committed_at timestamptz
);

create table if not exists core.capacity_recommendation_actions (
  recommendation_action_id uuid primary key,
  recommendation_id uuid not null references core.capacity_recommendation_runs(recommendation_id) on delete cascade,
  task_instance_id bigint not null,
  asana_task_gid text not null,
  task_name text,
  task_record_id text,
  phase_label text,
  estimated_hours numeric(12, 2) not null default 0,
  required_skill_level numeric(12, 2),
  previous_worker_record_id text,
  previous_worker_name text,
  previous_worker_email text,
  target_worker_record_id text not null,
  target_worker_name text,
  target_worker_email text,
  capability_reason text,
  completion_count integer not null default 0,
  status text not null default 'preview',
  error_message text,
  committed_at timestamptz
);

create index if not exists idx_capacity_recommendation_runs_created
  on core.capacity_recommendation_runs(created_at desc);
create index if not exists idx_capacity_recommendation_actions_run
  on core.capacity_recommendation_actions(recommendation_id);

grant select, insert, update, delete on
  core.capacity_recommendation_runs,
  core.capacity_recommendation_actions
to bowlus_app, bowlus_sync;
