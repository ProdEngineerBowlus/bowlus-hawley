create table if not exists core.transition_gap_buckets (
  bucket_key text primary key,
  display_name text not null,
  min_minutes numeric(10, 2) not null,
  max_minutes numeric(10, 2),
  display_order integer not null,
  review_default boolean not null default false,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into core.transition_gap_buckets
  (bucket_key, display_name, min_minutes, max_minutes, display_order, review_default, notes)
values
  ('micro_transition', 'Micro Transition', 0, 2, 10, false, 'Expected tiny move/setup/admin gap.'),
  ('normal_transition', 'Normal Transition', 2, 5, 20, false, 'Normal move/setup transition.'),
  ('extended_transition', 'Extended Transition', 5, 10, 30, false, 'Worth tracking in aggregate; not always reviewable by itself.'),
  ('alert_transition', 'Alert Transition', 10, 20, 40, true, 'Long enough to align with current logged-out alert review.'),
  ('material_utilization_gap', 'Material Utilization Gap', 20, 45, 50, true, 'Large gap that can materially affect daily utilization.'),
  ('major_gap', 'Major Gap', 45, null, 60, true, 'Major daily-accounting gap.')
on conflict (bucket_key) do update set
  display_name = excluded.display_name,
  min_minutes = excluded.min_minutes,
  max_minutes = excluded.max_minutes,
  display_order = excluded.display_order,
  review_default = excluded.review_default,
  notes = excluded.notes,
  active = true,
  updated_at = now();

create table if not exists core.transition_category_catalog (
  category_key text primary key,
  display_name text not null,
  category_group text not null,
  display_order integer not null,
  manager_selectable boolean not null default true,
  valid_for_auto_suggestion boolean not null default true,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into core.transition_category_catalog
  (category_key, display_name, category_group, display_order, notes)
values
  ('normal_transition', 'Normal Transition', 'valid_work', 10, 'Normal move/setup/changeover.'),
  ('worker_delayed_start', 'Worker Delayed Start', 'worker_controlled', 20, 'Next work was available but start was delayed.'),
  ('waiting_for_lead', 'Waiting for Lead', 'lead_controlled', 30, 'Lead dispatch or direction was needed.'),
  ('no_task_available', 'No Task Available', 'lead_controlled', 40, 'Worker did not have available assigned work.'),
  ('waiting_for_parts_materials', 'Waiting for Parts / Materials', 'system_controlled', 50, 'Parts/materials constraint.'),
  ('waiting_for_engineering', 'Waiting for Engineering Clarification', 'system_controlled', 60, 'Engineering clarification constraint.'),
  ('waiting_for_qc', 'Waiting for QC', 'system_controlled', 70, 'QC/signoff constraint.'),
  ('tool_equipment_issue', 'Tool / Equipment Issue', 'system_controlled', 80, 'Tooling, equipment, or work-area constraint.'),
  ('helping_another_worker', 'Helping Another Worker', 'valid_work', 90, 'Valid support work not directly logged to the worker task.'),
  ('rework_unplanned_work', 'Rework / Unplanned Work', 'valid_work', 100, 'Valid unplanned work or rework.'),
  ('meeting_training', 'Meeting / Training', 'valid_work', 110, 'Meeting, training, huddle, or directed non-task work.'),
  ('app_time_tracking_compliance', 'App / Time Tracking Compliance Issue', 'worker_controlled', 120, 'App was not used or timer discipline failed.'),
  ('assignment_churn', 'Assignment Churn', 'lead_controlled', 130, 'Assignment changed during/around the gap.'),
  ('break_lunch', 'Break / Lunch', 'valid_work', 140, 'Scheduled or approved break/lunch time.'),
  ('unknown_needs_review', 'Unknown / Needs Review', 'unknown', 150, 'Default unresolved category.')
on conflict (category_key) do update set
  display_name = excluded.display_name,
  category_group = excluded.category_group,
  display_order = excluded.display_order,
  notes = excluded.notes,
  active = true,
  updated_at = now();

create table if not exists core.worker_day_schedule (
  worker_day_schedule_id bigserial primary key,
  worker_key text not null,
  worker_name text,
  worker_email text,
  work_date date not null,
  scheduled_hours numeric(10, 2) not null default 7.5,
  shift_start time,
  shift_end time,
  lunch_minutes integer not null default 30,
  break_minutes integer not null default 20,
  expected_productive_hours numeric(10, 2),
  active boolean not null default true,
  source_system text not null default 'hawley_default',
  source_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (worker_key, work_date)
);

create table if not exists core.assignment_events (
  assignment_event_id bigserial primary key,
  event_key text unique,
  asana_task_gid text not null,
  task_name text,
  project_gid text,
  project_name text,
  previous_assignee_gid text,
  previous_assignee_name text,
  previous_assignee_email text,
  new_assignee_gid text,
  new_assignee_name text,
  new_assignee_email text,
  changed_at_from_asana timestamptz,
  detected_at timestamptz not null default now(),
  source text not null default 'asana_poll',
  cycle_label text,
  vin text,
  phase_key text,
  phase_name text,
  assignment_state_before jsonb not null default '{}'::jsonb,
  assignment_state_after jsonb not null default '{}'::jsonb,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists core.worker_task_events (
  worker_task_event_id bigserial primary key,
  event_key text unique,
  worker_key text not null,
  worker_name text,
  worker_email text,
  asana_task_gid text,
  task_instance_id bigint,
  task_name text,
  phase_key text,
  phase_name text,
  work_date date,
  event_type text not null,
  event_timestamp timestamptz not null,
  duration_minutes integer,
  source text not null default 'hawley_worker_app',
  synced_to_asana boolean not null default false,
  sync_status text not null default 'not_ready',
  payload jsonb not null default '{}'::jsonb,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists core.time_sessions (
  time_session_id bigserial primary key,
  session_key text unique,
  worker_key text not null,
  worker_name text,
  worker_email text,
  asana_task_gid text not null,
  task_instance_id bigint,
  task_name text,
  phase_key text,
  phase_name text,
  reporting_phase_key text,
  reporting_phase_name text,
  work_date date not null,
  started_at timestamptz not null,
  stopped_at timestamptz,
  duration_minutes integer,
  estimated_minutes integer,
  stop_reason text,
  submitted_to_asana boolean not null default false,
  asana_sync_status text not null default 'not_ready',
  asana_time_entry_gid text,
  source text not null default 'hawley_worker_app',
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists core.task_transition_events (
  transition_event_id bigserial primary key,
  transition_key text unique,
  worker_key text not null,
  worker_name text,
  worker_email text,
  work_date date not null,
  previous_task_gid text,
  previous_task_name text,
  next_task_gid text,
  next_task_name text,
  previous_phase_key text,
  previous_phase_name text,
  next_phase_key text,
  next_phase_name text,
  reporting_phase_key text,
  reporting_phase_name text,
  reporting_phase_rule text not null default 'previous_phase',
  previous_task_ended_at timestamptz,
  next_task_started_at timestamptz,
  raw_gap_minutes numeric(10, 2) not null default 0,
  gap_bucket text references core.transition_gap_buckets(bucket_key),
  allowed_transition_minutes numeric(10, 2) not null default 5,
  excess_gap_minutes numeric(10, 2) not null default 0,
  previous_task_completed boolean not null default false,
  previous_task_estimated_minutes integer,
  previous_task_actual_minutes integer,
  previous_task_over_estimate boolean not null default false,
  next_task_assigned_before_gap boolean,
  assignment_changed_during_gap boolean not null default false,
  logged_out_alert_triggered boolean not null default false,
  over_estimate_alert_triggered boolean not null default false,
  auto_category text references core.transition_category_catalog(category_key),
  auto_category_reason text,
  review_required boolean not null default false,
  manager_category text references core.transition_category_catalog(category_key),
  manager_category_group text,
  manager_notes text,
  reviewed_by text,
  reviewed_at timestamptz,
  manager_flagged boolean not null default false,
  source text not null default 'hawley_worker_app',
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists core.transition_reviews (
  transition_review_id bigserial primary key,
  transition_event_id bigint not null references core.task_transition_events(transition_event_id) on delete cascade,
  reviewed_by text,
  reviewed_at timestamptz not null default now(),
  manager_category text not null references core.transition_category_catalog(category_key),
  manager_category_group text,
  manager_notes text,
  confidence text,
  action_required boolean not null default false,
  followup_owner text,
  review_mode text not null default 'review',
  created_at timestamptz not null default now()
);

create table if not exists sync.asana_writeback_queue (
  asana_writeback_id bigserial primary key,
  source_event_type text not null,
  source_event_id bigint,
  worker_key text,
  asana_task_gid text,
  action_type text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  last_attempt_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_worker_day_schedule_worker_date
  on core.worker_day_schedule(worker_key, work_date);

create index if not exists idx_assignment_events_task_detected
  on core.assignment_events(asana_task_gid, detected_at);

create index if not exists idx_assignment_events_new_assignee
  on core.assignment_events(new_assignee_email, detected_at);

create index if not exists idx_worker_task_events_worker_date
  on core.worker_task_events(worker_key, work_date, event_timestamp);

create index if not exists idx_time_sessions_worker_date
  on core.time_sessions(worker_key, work_date, started_at);

create index if not exists idx_time_sessions_task
  on core.time_sessions(asana_task_gid, work_date);

create index if not exists idx_time_sessions_phase_date
  on core.time_sessions(reporting_phase_key, work_date);

create index if not exists idx_transition_events_worker_date
  on core.task_transition_events(worker_key, work_date, previous_task_ended_at);

create index if not exists idx_transition_events_phase_date
  on core.task_transition_events(reporting_phase_key, work_date);

create index if not exists idx_transition_events_review
  on core.task_transition_events(review_required, reviewed_at, work_date);

create index if not exists idx_asana_writeback_queue_status
  on sync.asana_writeback_queue(status, created_at);

grant select, insert, update, delete on
  core.transition_gap_buckets,
  core.transition_category_catalog,
  core.worker_day_schedule,
  core.assignment_events,
  core.worker_task_events,
  core.time_sessions,
  core.task_transition_events,
  core.transition_reviews,
  sync.asana_writeback_queue
to bowlus_sync;

grant usage, select, update on all sequences in schema core to bowlus_sync;
grant usage, select, update on all sequences in schema sync to bowlus_sync;

grant select on
  core.transition_gap_buckets,
  core.transition_category_catalog,
  core.worker_day_schedule,
  core.assignment_events,
  core.worker_task_events,
  core.time_sessions,
  core.task_transition_events,
  core.transition_reviews,
  sync.asana_writeback_queue
to bowlus_app, bowlus_readonly;
