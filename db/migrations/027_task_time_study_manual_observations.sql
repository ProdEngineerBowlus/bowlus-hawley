-- Keep retrospective observations visibly distinct from live study laps.
-- These fields are reporting metadata only and never feed labor actuals.

alter table core.task_time_study_laps
  add column if not exists capture_mode text not null default 'live'
    check (capture_mode in ('live', 'manual_retroactive')),
  add column if not exists notes text;

comment on column core.task_time_study_laps.capture_mode is
  'live for a worker-operated lap; manual_retroactive for an admin-entered observed interval.';
comment on column core.task_time_study_laps.notes is
  'Optional manager observation note for the time-study lap.';
