create or replace function core.hawley_scheduled_work_minutes(
  p_started_at timestamptz,
  p_stopped_at timestamptz,
  p_work_date date default null
) returns integer
language sql
stable
as $$
  with params as (
    select
      p_started_at as started_at,
      p_stopped_at as stopped_at,
      coalesce(p_work_date, (p_started_at at time zone 'America/Los_Angeles')::date) as work_date
    where p_started_at is not null
      and p_stopped_at is not null
      and p_stopped_at > p_started_at
  ),
  windows(start_clock, end_clock) as (
    values
      (time '07:00', time '09:00'),
      (time '09:10', time '11:00'),
      (time '11:30', time '13:30'),
      (time '13:40', time '15:30')
  ),
  overlaps as (
    select
      extract(epoch from (
        least(params.stopped_at, (params.work_date + windows.end_clock) at time zone 'America/Los_Angeles')
        - greatest(params.started_at, (params.work_date + windows.start_clock) at time zone 'America/Los_Angeles')
      )) / 60.0 as minutes
    from params
    cross join windows
    where least(params.stopped_at, (params.work_date + windows.end_clock) at time zone 'America/Los_Angeles')
      > greatest(params.started_at, (params.work_date + windows.start_clock) at time zone 'America/Los_Angeles')
  )
  select coalesce(greatest(0, round(sum(minutes))::integer), 0)
  from overlaps;
$$;

create or replace function core.hawley_effective_work_stop(
  p_stopped_at timestamptz,
  p_work_date date
) returns timestamptz
language sql
stable
as $$
  with params as (
    select p_stopped_at as stopped_at, p_work_date as work_date
    where p_stopped_at is not null
      and p_work_date is not null
  ),
  windows(start_clock, end_clock) as (
    values
      (time '07:00', time '09:00'),
      (time '09:10', time '11:00'),
      (time '11:30', time '13:30'),
      (time '13:40', time '15:30')
  ),
  bounds as (
    select
      (params.work_date + windows.start_clock) at time zone 'America/Los_Angeles' as window_start,
      (params.work_date + windows.end_clock) at time zone 'America/Los_Angeles' as window_end,
      params.stopped_at
    from params
    cross join windows
  ),
  in_window as (
    select stopped_at as effective_stop
    from bounds
    where stopped_at >= window_start
      and stopped_at < window_end
    limit 1
  ),
  latest_boundary as (
    select max(window_end) as effective_stop
    from bounds
    where stopped_at >= window_end
  )
  select coalesce(
    (select effective_stop from in_window),
    (select effective_stop from latest_boundary)
  );
$$;

with actual_candidates as (
  select
    actuals.worker_daily_actual_id,
    greatest(
      coalesce(actuals.actual_minutes, 0),
      coalesce(actuals.timer_minutes, 0),
      coalesce(actuals.asana_posted_minutes, 0)
    )::integer as raw_minutes,
    coalesce(actuals.last_seen_at, actuals.source_synced_at, actuals.normalized_at) as raw_stop_at
  from hb.worker_daily_task_actuals actuals
  where actuals.source_system = 'hawley_worker_live_pilot'
    and not actuals.daily_summary
    and actuals.work_date is not null
),
actual_corrected as (
  select
    candidates.worker_daily_actual_id,
    candidates.raw_minutes,
    candidates.raw_stop_at,
    core.hawley_effective_work_stop(candidates.raw_stop_at, actuals.work_date) as effective_stop_at,
    least(
      candidates.raw_minutes,
      core.hawley_scheduled_work_minutes(
        candidates.raw_stop_at - (candidates.raw_minutes || ' minutes')::interval,
        candidates.raw_stop_at,
        actuals.work_date
      )
    )::integer as corrected_minutes
  from actual_candidates candidates
  join hb.worker_daily_task_actuals actuals using (worker_daily_actual_id)
  where candidates.raw_minutes > 0
    and candidates.raw_stop_at is not null
),
actual_updates as (
  select
    actuals.worker_daily_actual_id,
    corrected.raw_minutes,
    corrected.corrected_minutes,
    corrected.raw_stop_at,
    coalesce(corrected.effective_stop_at, corrected.raw_stop_at) as effective_stop_at,
    case when coalesce(actuals.actual_minutes, 0) > 0 then corrected.corrected_minutes else actuals.actual_minutes end as new_actual_minutes,
    case when coalesce(actuals.timer_minutes, 0) > 0 then least(actuals.timer_minutes, corrected.corrected_minutes) else actuals.timer_minutes end as new_timer_minutes,
    case when coalesce(actuals.asana_posted_minutes, 0) > 0 then least(actuals.asana_posted_minutes, corrected.corrected_minutes) else actuals.asana_posted_minutes end as new_asana_posted_minutes
  from actual_corrected corrected
  join hb.worker_daily_task_actuals actuals using (worker_daily_actual_id)
  where corrected.corrected_minutes < corrected.raw_minutes
)
update hb.worker_daily_task_actuals actuals
set
  actual_minutes = updates.new_actual_minutes,
  timer_minutes = updates.new_timer_minutes,
  asana_posted_minutes = updates.new_asana_posted_minutes,
  last_seen_at = updates.effective_stop_at,
  source_synced_at = updates.effective_stop_at,
  fields_json = coalesce(actuals.fields_json, '{}'::jsonb)
    || jsonb_build_object(
      'Schedule Raw Actual Minutes', actuals.actual_minutes,
      'Schedule Raw Timer Minutes', actuals.timer_minutes,
      'Schedule Raw Asana Posted Minutes', actuals.asana_posted_minutes,
      'Schedule Raw Logged Minutes', updates.raw_minutes,
      'Schedule Raw Stop At', updates.raw_stop_at::text,
      'Schedule Effective Stop At', updates.effective_stop_at::text,
      'Schedule Corrected At', now()::text,
      'Schedule Correction Source', '7:00-15:30 America/Los_Angeles minus 09:00-09:10, 11:00-11:30, 13:30-13:40',
      'Actual Minutes', updates.new_actual_minutes,
      'Timer Minutes', updates.new_timer_minutes,
      'Asana Posted Minutes', updates.new_asana_posted_minutes
    ),
  normalized_at = now()
from actual_updates updates
where actuals.worker_daily_actual_id = updates.worker_daily_actual_id;

with session_corrected as (
  select
    sessions.time_session_id,
    coalesce(sessions.duration_minutes, 0)::integer as raw_minutes,
    least(
      coalesce(sessions.duration_minutes, 0),
      core.hawley_scheduled_work_minutes(sessions.started_at, sessions.stopped_at, sessions.work_date)
    )::integer as corrected_minutes,
    core.hawley_effective_work_stop(sessions.stopped_at, sessions.work_date) as effective_stop_at
  from core.time_sessions sessions
  where sessions.source = 'hawley_worker_app'
    and sessions.started_at is not null
    and sessions.stopped_at is not null
    and coalesce(sessions.duration_minutes, 0) > 0
),
session_updates as (
  select *
  from session_corrected
  where corrected_minutes < raw_minutes
)
update core.time_sessions sessions
set
  duration_minutes = updates.corrected_minutes,
  stopped_at = coalesce(updates.effective_stop_at, sessions.stopped_at),
  source_payload = coalesce(sessions.source_payload, '{}'::jsonb)
    || jsonb_build_object(
      'scheduleRawDurationMinutes', updates.raw_minutes,
      'scheduleCorrectedDurationMinutes', updates.corrected_minutes,
      'scheduleRawStoppedAt', sessions.stopped_at::text,
      'scheduleEffectiveStoppedAt', coalesce(updates.effective_stop_at, sessions.stopped_at)::text,
      'scheduleCorrectedAt', now()::text,
      'scheduleCorrectionSource', '7:00-15:30 America/Los_Angeles minus 09:00-09:10, 11:00-11:30, 13:30-13:40'
    ),
  updated_at = now()
from session_updates updates
where sessions.time_session_id = updates.time_session_id;

with daily_rollups as (
  select
    worker_key,
    work_date,
    sum(greatest(
      coalesce(actual_minutes, 0),
      coalesce(timer_minutes, 0),
      coalesce(asana_posted_minutes, 0)
    ))::integer as logged_minutes
  from hb.worker_daily_task_actuals
  where source_system = 'hawley_worker_live_pilot'
    and not daily_summary
    and work_date is not null
  group by worker_key, work_date
)
update hb.worker_daily_task_actuals summaries
set
  actual_minutes = rollups.logged_minutes,
  timer_minutes = case when coalesce(summaries.timer_minutes, 0) > 0 then rollups.logged_minutes else summaries.timer_minutes end,
  source_synced_at = now(),
  last_seen_at = now(),
  daily_available_minutes = 460,
  daily_logged_minutes = rollups.logged_minutes,
  daily_efficiency_percent = round((rollups.logged_minutes / 460.0 * 100)::numeric, 2),
  daily_efficiency_under_75 = rollups.logged_minutes < 345,
  efficiency_snapshot_at = now(),
  fields_json = coalesce(summaries.fields_json, '{}'::jsonb)
    || jsonb_build_object(
      'Actual Minutes', rollups.logged_minutes,
      'Daily Available Minutes', 460,
      'Daily Logged Minutes', rollups.logged_minutes,
      'Daily Efficiency Percent', round((rollups.logged_minutes / 460.0 * 100)::numeric, 2),
      'Daily Efficiency Under 75?', rollups.logged_minutes < 345,
      'Efficiency Snapshot At', now()::text,
      'Schedule Corrected At', now()::text,
      'Schedule Correction Source', 'daily summary recomputed from schedule-corrected task actuals'
    ),
  normalized_at = now()
from daily_rollups rollups
where summaries.source_system = 'hawley_worker_live_pilot'
  and summaries.daily_summary
  and summaries.worker_key = rollups.worker_key
  and summaries.work_date = rollups.work_date;
