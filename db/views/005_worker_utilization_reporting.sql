create or replace view reporting.worker_time_sessions as
with ledger_sessions as (
  select
    'worker_actual:' || coalesce(actuals.ledger_key, actuals.worker_daily_actual_id::text) as session_key,
    actuals.worker_key,
    actuals.worker_name,
    actuals.worker_email,
    actuals.asana_task_gid,
    actuals.task_name,
    actuals.work_date,
    case
      when nullif(actuals.fields_json ->> 'Timer Started At', '') ~ '^\d{4}-\d{2}-\d{2}'
        then (actuals.fields_json ->> 'Timer Started At')::timestamptz
      else null
    end as started_at,
    coalesce(actuals.last_seen_at, actuals.source_synced_at, actuals.normalized_at) as stopped_at,
    greatest(
      coalesce(actuals.actual_minutes, 0),
      coalesce(actuals.timer_minutes, 0),
      coalesce(actuals.asana_posted_minutes, 0)
    )::integer as duration_minutes,
    round((coalesce(actuals.allocated_hours, actuals.assigned_hours, 0) * 60)::numeric, 0)::integer as estimated_minutes,
    actuals.phase_label,
    actuals.cycle_label,
    actuals.vin,
    actuals.completed,
    actuals.source_label,
    'hb.worker_daily_task_actuals' as source_table,
    actuals.fields_json as source_payload,
    actuals.source_synced_at
  from hb.worker_daily_task_actuals actuals
  where actuals.work_date is not null
    and not actuals.daily_summary
    and greatest(
      coalesce(actuals.actual_minutes, 0),
      coalesce(actuals.timer_minutes, 0),
      coalesce(actuals.asana_posted_minutes, 0)
    ) > 0
),
ledger_mapped as (
  select
    ledger_sessions.*,
    coalesce(area.work_area_key, regexp_replace(lower(coalesce(nullif(ledger_sessions.phase_label, ''), 'unspecified')), '[^a-z0-9]+', '_', 'g')) as phase_key,
    coalesce(area.display_name, nullif(ledger_sessions.phase_label, ''), 'Unspecified') as phase_name
  from ledger_sessions
  left join lateral (
    select wa.work_area_key, wa.display_name
    from ops.work_area_aliases wa
    where wa.active
      and (
        lower(coalesce(ledger_sessions.phase_label, '')) = lower(wa.display_name)
        or exists (
          select 1
          from unnest(wa.phase_names || wa.section_names) as alias_name
          where lower(coalesce(ledger_sessions.phase_label, '')) = lower(alias_name)
        )
        or exists (
          select 1
          from unnest(wa.task_keywords) as keyword
          where lower(coalesce(ledger_sessions.task_name, '')) like '%' || lower(keyword) || '%'
        )
      )
    order by
      case when lower(coalesce(ledger_sessions.phase_label, '')) = lower(wa.display_name) then 0 else 1 end,
      wa.display_name
    limit 1
  ) area on true
),
explicit_sessions as (
  select
    'time_session:' || sessions.time_session_id::text as session_key,
    sessions.worker_key,
    sessions.worker_name,
    sessions.worker_email,
    sessions.asana_task_gid,
    sessions.task_name,
    sessions.work_date,
    sessions.started_at,
    sessions.stopped_at,
    coalesce(
      sessions.duration_minutes,
      case
        when sessions.stopped_at is not null then greatest(0, round(extract(epoch from (sessions.stopped_at - sessions.started_at)) / 60.0)::integer)
        else null
      end
    ) as duration_minutes,
    sessions.estimated_minutes,
    coalesce(sessions.reporting_phase_key, sessions.phase_key, 'unspecified') as phase_key,
    coalesce(sessions.reporting_phase_name, sessions.phase_name, 'Unspecified') as phase_name,
    null::text as cycle_label,
    null::text as vin,
    false as completed,
    sessions.source as source_label,
    'core.time_sessions' as source_table,
    sessions.source_payload,
    sessions.updated_at as source_synced_at
  from core.time_sessions sessions
  where not exists (
    select 1
    from hb.worker_daily_task_actuals actuals
    where actuals.work_date = sessions.work_date
      and actuals.worker_key = sessions.worker_key
      and actuals.asana_task_gid = sessions.asana_task_gid
      and actuals.source_system = 'hawley_worker_live_pilot'
      and not actuals.daily_summary
  )
)
select
  session_key,
  worker_key,
  worker_name,
  worker_email,
  lower(coalesce(nullif(worker_email, ''), nullif(worker_name, ''), worker_key)) as worker_identity,
  asana_task_gid,
  task_name,
  work_date,
  started_at,
  stopped_at,
  duration_minutes,
  estimated_minutes,
  phase_key as reporting_phase_key,
  phase_name as reporting_phase_name,
  cycle_label,
  vin,
  completed,
  source_label,
  source_table,
  source_payload,
  source_synced_at
from ledger_mapped
union all
select
  session_key,
  worker_key,
  worker_name,
  worker_email,
  lower(coalesce(nullif(worker_email, ''), nullif(worker_name, ''), worker_key)) as worker_identity,
  asana_task_gid,
  task_name,
  work_date,
  started_at,
  stopped_at,
  duration_minutes,
  estimated_minutes,
  phase_key as reporting_phase_key,
  phase_name as reporting_phase_name,
  cycle_label,
  vin,
  completed,
  source_label,
  source_table,
  source_payload,
  source_synced_at
from explicit_sessions;

create or replace view reporting.transition_event_detail as
select
  transitions.transition_event_id,
  transitions.transition_key,
  transitions.worker_key,
  transitions.worker_name,
  transitions.worker_email,
  lower(coalesce(nullif(transitions.worker_email, ''), nullif(transitions.worker_name, ''), transitions.worker_key)) as worker_identity,
  transitions.work_date,
  transitions.previous_task_gid,
  transitions.previous_task_name,
  transitions.next_task_gid,
  transitions.next_task_name,
  transitions.previous_phase_key,
  transitions.previous_phase_name,
  transitions.next_phase_key,
  transitions.next_phase_name,
  transitions.reporting_phase_key,
  transitions.reporting_phase_name,
  transitions.reporting_phase_rule,
  transitions.previous_task_ended_at,
  transitions.next_task_started_at,
  transitions.raw_gap_minutes,
  transitions.gap_bucket,
  buckets.display_name as gap_bucket_name,
  buckets.display_order as gap_bucket_order,
  transitions.allowed_transition_minutes,
  transitions.excess_gap_minutes,
  transitions.previous_task_completed,
  transitions.previous_task_estimated_minutes,
  transitions.previous_task_actual_minutes,
  transitions.previous_task_over_estimate,
  transitions.next_task_assigned_before_gap,
  transitions.assignment_changed_during_gap,
  transitions.logged_out_alert_triggered,
  transitions.over_estimate_alert_triggered,
  transitions.auto_category,
  auto_category.display_name as auto_category_name,
  auto_category.category_group as auto_category_group,
  transitions.auto_category_reason,
  transitions.review_required,
  transitions.manager_category,
  manager_category.display_name as manager_category_name,
  coalesce(transitions.manager_category_group, manager_category.category_group) as manager_category_group,
  transitions.manager_notes,
  transitions.reviewed_by,
  transitions.reviewed_at,
  transitions.manager_flagged,
  transitions.source,
  transitions.created_at,
  transitions.updated_at
from core.task_transition_events transitions
left join core.transition_gap_buckets buckets
  on buckets.bucket_key = transitions.gap_bucket
left join core.transition_category_catalog auto_category
  on auto_category.category_key = transitions.auto_category
left join core.transition_category_catalog manager_category
  on manager_category.category_key = transitions.manager_category;

create or replace view reporting.worker_daily_utilization as
with session_daily as (
  select
    worker_identity,
    work_date,
    max(worker_key) as worker_key,
    max(worker_name) as worker_name,
    max(worker_email) as worker_email,
    sum(duration_minutes)::integer as productive_task_minutes,
    sum(coalesce(estimated_minutes, 0))::integer as estimated_minutes,
    count(*)::integer as task_session_count,
    count(distinct asana_task_gid)::integer as task_count_started
  from reporting.worker_time_sessions
  group by worker_identity, work_date
),
assignment_daily as (
  select
    lower(coalesce(nullif(worker_email, ''), nullif(worker_name, ''))) as worker_identity,
    assigned_on as work_date,
    count(*)::integer as assigned_task_count,
    count(*) filter (where completed)::integer as completed_task_count
  from reporting.hawley_worker_page_assignments
  where assigned_on is not null
    and nullif(coalesce(worker_email, worker_name), '') is not null
  group by lower(coalesce(nullif(worker_email, ''), nullif(worker_name, ''))), assigned_on
),
transition_daily as (
  select
    worker_identity,
    work_date,
    sum(raw_gap_minutes)::numeric(12, 2) as total_transition_minutes,
    sum(excess_gap_minutes)::numeric(12, 2) as excess_transition_minutes,
    count(*)::integer as transition_count,
    round(avg(raw_gap_minutes)::numeric, 2) as avg_transition_minutes,
    (percentile_cont(0.5) within group (order by raw_gap_minutes))::numeric(12, 2) as median_transition_minutes,
    max(raw_gap_minutes)::numeric(12, 2) as max_transition_minutes,
    count(*) filter (where gap_bucket = 'micro_transition')::integer as gaps_0_2_count,
    count(*) filter (where gap_bucket = 'normal_transition')::integer as gaps_2_5_count,
    count(*) filter (where gap_bucket = 'extended_transition')::integer as gaps_5_10_count,
    count(*) filter (where gap_bucket = 'alert_transition')::integer as gaps_10_20_count,
    count(*) filter (where gap_bucket = 'material_utilization_gap')::integer as gaps_20_45_count,
    count(*) filter (where gap_bucket = 'major_gap')::integer as gaps_45_plus_count,
    count(*) filter (where review_required)::integer as review_required_count,
    count(*) filter (where reviewed_at is not null)::integer as reviewed_transition_count,
    count(*) filter (where review_required and reviewed_at is null)::integer as unreviewed_transition_count,
    count(*) filter (where assignment_changed_during_gap)::integer as assignment_change_count,
    count(*) filter (where logged_out_alert_triggered)::integer as logged_out_alert_count,
    count(*) filter (where over_estimate_alert_triggered)::integer as over_estimate_alert_count,
    sum(raw_gap_minutes) filter (where manager_category_group in ('system_controlled', 'lead_controlled', 'valid_work'))::numeric(12, 2) as manager_explained_transition_minutes
  from reporting.transition_event_detail
  group by worker_identity, work_date
),
schedule_daily as (
  select
    lower(coalesce(nullif(worker_email, ''), nullif(worker_name, ''), worker_key)) as worker_identity,
    work_date,
    max(scheduled_hours) as scheduled_hours,
    max(coalesce(lunch_minutes, 0) + coalesce(break_minutes, 0))::integer as planned_break_minutes
  from core.worker_day_schedule
  where active
  group by lower(coalesce(nullif(worker_email, ''), nullif(worker_name, ''), worker_key)), work_date
),
worker_defaults as (
  select
    lower(coalesce(nullif(worker_email, ''), nullif(worker_name, ''))) as worker_identity,
    max(worker_name) as worker_name,
    max(worker_email) as worker_email,
    max(coalesce(hours_per_day, 7.5)) as standard_daily_hours
  from hb.work_force
  where actively_employed
  group by lower(coalesce(nullif(worker_email, ''), nullif(worker_name, '')))
),
keys as (
  select worker_identity, work_date from session_daily
  union
  select worker_identity, work_date from assignment_daily
  union
  select worker_identity, work_date from transition_daily
  union
  select worker_identity, work_date from schedule_daily
)
select
  keys.work_date,
  coalesce(session_daily.worker_key, keys.worker_identity) as worker_key,
  coalesce(session_daily.worker_name, worker_defaults.worker_name, keys.worker_identity) as worker_name,
  coalesce(session_daily.worker_email, worker_defaults.worker_email) as worker_email,
  coalesce(schedule_daily.scheduled_hours, worker_defaults.standard_daily_hours, 7.5)::numeric(10, 2) as scheduled_hours,
  coalesce(session_daily.productive_task_minutes, 0) as productive_task_minutes,
  round((coalesce(session_daily.productive_task_minutes, 0) / 60.0)::numeric, 2) as productive_task_hours,
  coalesce(session_daily.estimated_minutes, 0) as estimated_minutes,
  coalesce(transition_daily.total_transition_minutes, 0)::numeric(12, 2) as total_transition_minutes,
  coalesce(transition_daily.excess_transition_minutes, 0)::numeric(12, 2) as excess_transition_minutes,
  coalesce(schedule_daily.planned_break_minutes, 0) as planned_break_minutes,
  greatest(
    0,
    round((
      coalesce(schedule_daily.scheduled_hours, worker_defaults.standard_daily_hours, 7.5) * 60
      - coalesce(session_daily.productive_task_minutes, 0)
      - coalesce(transition_daily.total_transition_minutes, 0)
      - coalesce(schedule_daily.planned_break_minutes, 0)
    )::numeric, 2)
  ) as unaccounted_minutes,
  round((
    coalesce(session_daily.productive_task_minutes, 0)
    / nullif(coalesce(schedule_daily.scheduled_hours, worker_defaults.standard_daily_hours, 7.5) * 60, 0)
    * 100
  )::numeric, 2) as productive_utilization_percent,
  round((
    (
      coalesce(session_daily.productive_task_minutes, 0)
      + coalesce(transition_daily.total_transition_minutes, 0)
      + coalesce(schedule_daily.planned_break_minutes, 0)
    )
    / nullif(coalesce(schedule_daily.scheduled_hours, worker_defaults.standard_daily_hours, 7.5) * 60, 0)
    * 100
  )::numeric, 2) as accounted_utilization_percent,
  round((coalesce(session_daily.estimated_minutes, 0)::numeric / nullif(session_daily.productive_task_minutes, 0) * 100)::numeric, 2) as task_efficiency_percent,
  coalesce(assignment_daily.assigned_task_count, 0) as assigned_task_count,
  coalesce(assignment_daily.completed_task_count, 0) as completed_task_count,
  round((coalesce(assignment_daily.completed_task_count, 0)::numeric / nullif(assignment_daily.assigned_task_count, 0) * 100)::numeric, 2) as assigned_vs_completed_percent,
  coalesce(session_daily.task_count_started, 0) as task_count_started,
  coalesce(session_daily.task_session_count, 0) as task_session_count,
  coalesce(transition_daily.transition_count, 0) as transition_count,
  coalesce(transition_daily.avg_transition_minutes, 0) as avg_transition_minutes,
  coalesce(transition_daily.median_transition_minutes, 0) as median_transition_minutes,
  coalesce(transition_daily.max_transition_minutes, 0) as max_transition_minutes,
  coalesce(transition_daily.gaps_0_2_count, 0) as gaps_0_2_count,
  coalesce(transition_daily.gaps_2_5_count, 0) as gaps_2_5_count,
  coalesce(transition_daily.gaps_5_10_count, 0) as gaps_5_10_count,
  coalesce(transition_daily.gaps_10_20_count, 0) as gaps_10_20_count,
  coalesce(transition_daily.gaps_20_45_count, 0) as gaps_20_45_count,
  coalesce(transition_daily.gaps_45_plus_count, 0) as gaps_45_plus_count,
  coalesce(transition_daily.review_required_count, 0) as review_required_count,
  coalesce(transition_daily.reviewed_transition_count, 0) as reviewed_transition_count,
  coalesce(transition_daily.unreviewed_transition_count, 0) as unreviewed_transition_count,
  coalesce(transition_daily.assignment_change_count, 0) as assignment_change_count,
  coalesce(transition_daily.assignment_change_count, 0) as task_churn_count,
  coalesce(transition_daily.logged_out_alert_count, 0) as logged_out_alert_count,
  coalesce(transition_daily.over_estimate_alert_count, 0) as over_estimate_alert_count,
  coalesce(transition_daily.manager_explained_transition_minutes, 0)::numeric(12, 2) as manager_explained_transition_minutes
from keys
left join session_daily using (worker_identity, work_date)
left join assignment_daily using (worker_identity, work_date)
left join transition_daily using (worker_identity, work_date)
left join schedule_daily using (worker_identity, work_date)
left join worker_defaults using (worker_identity);

create or replace view reporting.worker_transition_summary as
select
  work_date,
  worker_key,
  worker_name,
  worker_email,
  total_transition_minutes,
  excess_transition_minutes,
  transition_count,
  avg_transition_minutes,
  median_transition_minutes,
  max_transition_minutes,
  gaps_0_2_count,
  gaps_2_5_count,
  gaps_5_10_count,
  gaps_10_20_count,
  gaps_20_45_count,
  gaps_45_plus_count,
  review_required_count,
  unreviewed_transition_count
from reporting.worker_daily_utilization;

create or replace view reporting.worker_unaccounted_time as
select
  work_date,
  worker_key,
  worker_name,
  worker_email,
  scheduled_hours,
  productive_task_hours,
  total_transition_minutes,
  planned_break_minutes,
  unaccounted_minutes,
  productive_utilization_percent,
  accounted_utilization_percent,
  review_required_count
from reporting.worker_daily_utilization;

create or replace view reporting.phase_day_summary as
with session_phase as (
  select
    work_date,
    reporting_phase_key as phase_key,
    reporting_phase_name as phase_name,
    sum(duration_minutes)::integer as total_actual_task_minutes,
    sum(coalesce(estimated_minutes, 0))::integer as total_estimated_minutes,
    count(distinct worker_identity)::integer as worker_count,
    count(distinct asana_task_gid)::integer as started_task_count
  from reporting.worker_time_sessions
  group by work_date, reporting_phase_key, reporting_phase_name
),
assignment_phase as (
  select
    assigned_on as work_date,
    inferred_work_area_key as phase_key,
    inferred_work_area_name as phase_name,
    count(*)::integer as assigned_task_count,
    count(*) filter (where completed)::integer as completed_task_count,
    count(distinct lower(coalesce(nullif(worker_email, ''), nullif(worker_name, ''))))::integer as assigned_worker_count,
    round(sum(coalesce(estimated_hours, 0) * 60)::numeric, 0)::integer as assigned_estimated_minutes
  from reporting.hawley_worker_page_assignments
  where assigned_on is not null
  group by assigned_on, inferred_work_area_key, inferred_work_area_name
),
transition_phase as (
  select
    work_date,
    reporting_phase_key as phase_key,
    reporting_phase_name as phase_name,
    sum(raw_gap_minutes)::numeric(12, 2) as total_transition_minutes,
    sum(excess_gap_minutes)::numeric(12, 2) as excess_transition_minutes,
    count(*) filter (where review_required)::integer as gaps_requiring_review_count,
    count(*) filter (where reviewed_at is not null)::integer as reviewed_gap_count,
    count(*) filter (where review_required and reviewed_at is null)::integer as unreviewed_gap_count,
    count(*) filter (where logged_out_alert_triggered)::integer as logged_out_alert_count,
    count(*) filter (where over_estimate_alert_triggered)::integer as over_estimate_alert_count,
    mode() within group (order by gap_bucket) as top_transition_category,
    mode() within group (order by manager_category_group) as top_manager_category_group
  from reporting.transition_event_detail
  group by work_date, reporting_phase_key, reporting_phase_name
),
churn_phase as (
  select
    detected_at::date as work_date,
    phase_key,
    max(phase_name) as phase_name,
    count(*)::integer as assignment_change_count
  from core.assignment_events
  group by detected_at::date, phase_key
),
keys as (
  select work_date, phase_key from session_phase
  union
  select work_date, phase_key from assignment_phase
  union
  select work_date, phase_key from transition_phase
  union
  select work_date, phase_key from churn_phase
)
select
  keys.work_date,
  keys.phase_key,
  coalesce(session_phase.phase_name, assignment_phase.phase_name, transition_phase.phase_name, churn_phase.phase_name, keys.phase_key, 'Unspecified') as phase_name,
  coalesce(session_phase.total_actual_task_minutes, 0) as total_actual_task_minutes,
  round((coalesce(session_phase.total_actual_task_minutes, 0) / 60.0)::numeric, 2) as total_actual_task_hours,
  coalesce(transition_phase.total_transition_minutes, 0)::numeric(12, 2) as total_transition_minutes,
  coalesce(transition_phase.excess_transition_minutes, 0)::numeric(12, 2) as excess_transition_minutes,
  coalesce(assignment_phase.assigned_estimated_minutes, session_phase.total_estimated_minutes, 0) as total_estimated_minutes,
  round((coalesce(assignment_phase.assigned_estimated_minutes, session_phase.total_estimated_minutes, 0)::numeric / nullif(session_phase.total_actual_task_minutes, 0) * 100)::numeric, 2) as efficiency_percent,
  coalesce(assignment_phase.assigned_task_count, 0) as assigned_task_count,
  coalesce(assignment_phase.completed_task_count, 0) as completed_task_count,
  round((coalesce(assignment_phase.completed_task_count, 0)::numeric / nullif(assignment_phase.assigned_task_count, 0) * 100)::numeric, 2) as assigned_vs_completed_percent,
  coalesce(session_phase.started_task_count, 0) as started_task_count,
  coalesce(session_phase.worker_count, 0) as worker_count,
  coalesce(assignment_phase.assigned_worker_count, 0) as assigned_worker_count,
  coalesce(churn_phase.assignment_change_count, 0) as assignment_change_count,
  coalesce(churn_phase.assignment_change_count, 0) as task_churn_count,
  coalesce(transition_phase.logged_out_alert_count, 0) as logged_out_alert_count,
  coalesce(transition_phase.over_estimate_alert_count, 0) as over_estimate_alert_count,
  coalesce(transition_phase.gaps_requiring_review_count, 0) as gaps_requiring_review_count,
  coalesce(transition_phase.reviewed_gap_count, 0) as reviewed_gap_count,
  coalesce(transition_phase.unreviewed_gap_count, 0) as unreviewed_gap_count,
  transition_phase.top_transition_category,
  transition_phase.top_manager_category_group
from keys
left join session_phase using (work_date, phase_key)
left join assignment_phase using (work_date, phase_key)
left join transition_phase using (work_date, phase_key)
left join churn_phase using (work_date, phase_key);

create or replace view reporting.worker_phase_day_summary as
with session_worker_phase as (
  select
    work_date,
    worker_identity,
    max(worker_key) as worker_key,
    max(worker_name) as worker_name,
    max(worker_email) as worker_email,
    reporting_phase_key as phase_key,
    reporting_phase_name as phase_name,
    sum(duration_minutes)::integer as actual_task_minutes,
    sum(coalesce(estimated_minutes, 0))::integer as estimated_minutes,
    count(*)::integer as task_session_count,
    count(distinct asana_task_gid)::integer as started_task_count
  from reporting.worker_time_sessions
  group by work_date, worker_identity, reporting_phase_key, reporting_phase_name
),
assignment_worker_phase as (
  select
    assigned_on as work_date,
    lower(coalesce(nullif(worker_email, ''), nullif(worker_name, ''))) as worker_identity,
    inferred_work_area_key as phase_key,
    inferred_work_area_name as phase_name,
    count(*)::integer as assigned_task_count,
    count(*) filter (where completed)::integer as completed_task_count,
    round(sum(coalesce(estimated_hours, 0) * 60)::numeric, 0)::integer as assigned_estimated_minutes
  from reporting.hawley_worker_page_assignments
  where assigned_on is not null
    and nullif(coalesce(worker_email, worker_name), '') is not null
  group by assigned_on, lower(coalesce(nullif(worker_email, ''), nullif(worker_name, ''))), inferred_work_area_key, inferred_work_area_name
),
transition_worker_phase as (
  select
    work_date,
    worker_identity,
    reporting_phase_key as phase_key,
    reporting_phase_name as phase_name,
    sum(raw_gap_minutes)::numeric(12, 2) as transition_minutes,
    sum(excess_gap_minutes)::numeric(12, 2) as excess_transition_minutes,
    count(*) filter (where review_required)::integer as gaps_requiring_review_count,
    count(*) filter (where logged_out_alert_triggered)::integer as logged_out_alert_count,
    count(*) filter (where over_estimate_alert_triggered)::integer as over_estimate_alert_count,
    count(*) filter (where assignment_changed_during_gap)::integer as task_churn_count,
    mode() within group (order by gap_bucket) as top_transition_category,
    mode() within group (order by manager_category_group) as top_manager_category_group
  from reporting.transition_event_detail
  group by work_date, worker_identity, reporting_phase_key, reporting_phase_name
),
keys as (
  select work_date, worker_identity, phase_key from session_worker_phase
  union
  select work_date, worker_identity, phase_key from assignment_worker_phase
  union
  select work_date, worker_identity, phase_key from transition_worker_phase
)
select
  keys.work_date,
  coalesce(session_worker_phase.worker_key, keys.worker_identity) as worker_key,
  session_worker_phase.worker_name,
  session_worker_phase.worker_email,
  keys.phase_key,
  coalesce(session_worker_phase.phase_name, assignment_worker_phase.phase_name, transition_worker_phase.phase_name, keys.phase_key, 'Unspecified') as phase_name,
  coalesce(session_worker_phase.actual_task_minutes, 0) as actual_task_minutes,
  round((coalesce(session_worker_phase.actual_task_minutes, 0) / 60.0)::numeric, 2) as actual_task_hours,
  coalesce(assignment_worker_phase.assigned_estimated_minutes, session_worker_phase.estimated_minutes, 0) as estimated_minutes,
  coalesce(transition_worker_phase.transition_minutes, 0)::numeric(12, 2) as transition_minutes,
  coalesce(transition_worker_phase.excess_transition_minutes, 0)::numeric(12, 2) as excess_transition_minutes,
  round((coalesce(assignment_worker_phase.assigned_estimated_minutes, session_worker_phase.estimated_minutes, 0)::numeric / nullif(session_worker_phase.actual_task_minutes, 0) * 100)::numeric, 2) as efficiency_percent,
  coalesce(assignment_worker_phase.assigned_task_count, 0) as assigned_task_count,
  coalesce(session_worker_phase.started_task_count, 0) as started_task_count,
  coalesce(assignment_worker_phase.completed_task_count, 0) as completed_task_count,
  round((coalesce(assignment_worker_phase.completed_task_count, 0)::numeric / nullif(assignment_worker_phase.assigned_task_count, 0) * 100)::numeric, 2) as assigned_vs_completed_percent,
  coalesce(session_worker_phase.task_session_count, 0) as task_session_count,
  coalesce(transition_worker_phase.task_churn_count, 0) as task_churn_count,
  coalesce(transition_worker_phase.logged_out_alert_count, 0) as logged_out_alert_count,
  coalesce(transition_worker_phase.over_estimate_alert_count, 0) as over_estimate_alert_count,
  coalesce(transition_worker_phase.gaps_requiring_review_count, 0) as gaps_requiring_review_count,
  transition_worker_phase.top_transition_category,
  transition_worker_phase.top_manager_category_group
from keys
left join session_worker_phase using (work_date, worker_identity, phase_key)
left join assignment_worker_phase using (work_date, worker_identity, phase_key)
left join transition_worker_phase using (work_date, worker_identity, phase_key);

create or replace view reporting.phase_worker_labor_detail as
select *
from reporting.worker_phase_day_summary;

create or replace view reporting.assignment_churn_by_worker as
select
  detected_at::date as work_date,
  lower(coalesce(nullif(new_assignee_email, ''), nullif(new_assignee_name, ''), nullif(previous_assignee_email, ''), nullif(previous_assignee_name, ''))) as worker_identity,
  max(coalesce(new_assignee_name, previous_assignee_name)) as worker_name,
  max(coalesce(new_assignee_email, previous_assignee_email)) as worker_email,
  count(*)::integer as assignment_change_count,
  count(distinct asana_task_gid)::integer as touched_task_count
from core.assignment_events
group by detected_at::date, lower(coalesce(nullif(new_assignee_email, ''), nullif(new_assignee_name, ''), nullif(previous_assignee_email, ''), nullif(previous_assignee_name, '')));

create or replace view reporting.assignment_churn_by_phase as
select
  detected_at::date as work_date,
  phase_key,
  max(phase_name) as phase_name,
  count(*)::integer as assignment_change_count,
  count(distinct asana_task_gid)::integer as touched_task_count
from core.assignment_events
group by detected_at::date, phase_key;

create or replace view reporting.queue_starvation_events as
select *
from reporting.transition_event_detail
where coalesce(next_task_assigned_before_gap, false) = false
   or manager_category in ('waiting_for_lead', 'no_task_available')
   or auto_category in ('waiting_for_lead', 'no_task_available');

create or replace view reporting.lead_dispatch_delays as
select *
from reporting.queue_starvation_events
where raw_gap_minutes >= 5;

create or replace view reporting.assigned_but_not_started as
select
  assignments.assigned_on as work_date,
  assignments.worker_name,
  assignments.worker_email,
  lower(coalesce(nullif(assignments.worker_email, ''), nullif(assignments.worker_name, ''))) as worker_identity,
  assignments.asana_task_gid,
  assignments.task_name,
  assignments.inferred_work_area_key as phase_key,
  assignments.inferred_work_area_name as phase_name,
  assignments.estimated_hours,
  assignments.completed
from reporting.hawley_worker_page_assignments assignments
where assignments.assigned_on is not null
  and not exists (
    select 1
    from reporting.worker_time_sessions sessions
    where sessions.asana_task_gid = assignments.asana_task_gid
      and sessions.work_date = assignments.assigned_on
  );

create or replace view reporting.actual_vs_estimated_by_task as
select
  sessions.work_date,
  sessions.asana_task_gid,
  max(sessions.task_name) as task_name,
  max(sessions.reporting_phase_key) as phase_key,
  max(sessions.reporting_phase_name) as phase_name,
  sum(sessions.estimated_minutes)::integer as estimated_minutes,
  sum(sessions.duration_minutes)::integer as actual_minutes,
  round((sum(sessions.estimated_minutes)::numeric / nullif(sum(sessions.duration_minutes), 0) * 100)::numeric, 2) as efficiency_percent,
  count(distinct sessions.worker_identity)::integer as worker_count
from reporting.worker_time_sessions sessions
group by sessions.work_date, sessions.asana_task_gid;

create or replace view reporting.actual_vs_estimated_by_phase as
select
  work_date,
  phase_key,
  phase_name,
  total_estimated_minutes as estimated_minutes,
  total_actual_task_minutes as actual_minutes,
  efficiency_percent
from reporting.phase_day_summary;

create or replace view reporting.transition_gap_cause_summary as
select
  work_date,
  reporting_phase_key as phase_key,
  reporting_phase_name as phase_name,
  coalesce(manager_category, auto_category, 'unknown_needs_review') as category_key,
  coalesce(manager_category_name, auto_category_name, 'Unknown / Needs Review') as category_name,
  coalesce(manager_category_group, auto_category_group, 'unknown') as category_group,
  count(*)::integer as gap_count,
  sum(raw_gap_minutes)::numeric(12, 2) as total_gap_minutes,
  sum(excess_gap_minutes)::numeric(12, 2) as total_excess_minutes,
  count(*) filter (where review_required and reviewed_at is null)::integer as unreviewed_count
from reporting.transition_event_detail
group by
  work_date,
  reporting_phase_key,
  reporting_phase_name,
  coalesce(manager_category, auto_category, 'unknown_needs_review'),
  coalesce(manager_category_name, auto_category_name, 'Unknown / Needs Review'),
  coalesce(manager_category_group, auto_category_group, 'unknown');

create or replace view reporting.unreviewed_transition_queue as
select *
from reporting.transition_event_detail
where review_required
  and reviewed_at is null;

create or replace view reporting.daily_owner_action_list as
select
  'transition_review' as action_type,
  work_date,
  worker_name,
  worker_email,
  reporting_phase_name as phase_name,
  previous_task_name || ' -> ' || next_task_name as subject,
  raw_gap_minutes || ' min ' || coalesce(gap_bucket_name, gap_bucket, 'gap') as reason,
  transition_event_id::text as source_id,
  created_at
from reporting.unreviewed_transition_queue
union all
select
  'low_productive_utilization' as action_type,
  work_date,
  worker_name,
  worker_email,
  null::text as phase_name,
  'Worker daily utilization' as subject,
  productive_utilization_percent || '% productive utilization, ' || unaccounted_minutes || ' min unaccounted' as reason,
  worker_key as source_id,
  now() as created_at
from reporting.worker_daily_utilization
where productive_utilization_percent < 85
  and unaccounted_minutes > 30;

grant select on all tables in schema reporting to bowlus_app, bowlus_readonly;
