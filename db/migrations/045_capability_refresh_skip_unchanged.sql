-- core.refresh_worker_task_capabilities from 022, unchanged except that the evidence upsert skips rows whose
-- values did not change. Rewriting every evidence row on each HB rebuild (15M updates by 2026-10-30) added to
-- the load that timed out the worker page. last_refreshed_at now means "last changed".
create or replace function core.refresh_worker_task_capabilities()
returns jsonb
language plpgsql
as $$
declare
  evidence_rows integer := 0;
  capability_rows integer := 0;
begin
  with completed_tasks as (
    select
      ti.*,
      lower(coalesce(
        nullif(ti.worker_email, ''),
        nullif(ti.assignee_email, ''),
        nullif(ti.worker_record_id, ''),
        nullif(ti.worker_name, ''),
        nullif(ti.assignee_name, '')
      )) as assigned_worker_identity,
      templates.required_skill_level
    from hb.rev1_task_instances ti
    left join hb.task_templates templates on templates.task_record_id = ti.tasks_record_id
    where ti.tasks_record_id is not null
      and (
        ti.task_completed
        or lower(coalesce(ti.task_status, ti.status, '')) in ('true', 'complete', 'completed', 'done', 'yes')
      )
  ),
  session_contributors as (
    select
      sessions.asana_task_gid,
      lower(coalesce(
        nullif(sessions.worker_email, ''),
        nullif(sessions.worker_key, ''),
        nullif(sessions.worker_name, '')
      )) as worker_identity,
      max(sessions.worker_key) as worker_key,
      max(sessions.worker_name) as worker_name,
      max(sessions.worker_email) as worker_email,
      min(sessions.started_at) as started_at,
      max(sessions.stopped_at) as completed_at,
      max(sessions.work_date) as work_date,
      sum(greatest(coalesce(sessions.duration_minutes, 0), 0))::numeric(12, 2) as productive_minutes,
      count(*)::int as session_count,
      bool_or(
        sessions.source_table = 'core.time_sessions'
        or lower(coalesce(sessions.source_label, '')) like 'hawley%'
      ) as is_hawley_timer
    from reporting.worker_time_sessions sessions
    where sessions.asana_task_gid is not null
      and nullif(coalesce(sessions.worker_email, sessions.worker_key, sessions.worker_name), '') is not null
      and coalesce(sessions.duration_minutes, 0) > 0
    group by sessions.asana_task_gid, lower(coalesce(
      nullif(sessions.worker_email, ''),
      nullif(sessions.worker_key, ''),
      nullif(sessions.worker_name, '')
    ))
  ),
  contributor_counts as (
    select asana_task_gid, count(*)::int as contributor_count
    from session_contributors
    group by asana_task_gid
  ),
  timed_evidence as (
    select
      tasks.*,
      contributors.worker_identity as evidence_worker_identity,
      contributors.worker_key as evidence_worker_record_id,
      contributors.worker_name as evidence_worker_name,
      contributors.worker_email as evidence_worker_email,
      contributors.started_at as evidence_started_at,
      contributors.completed_at as evidence_completed_at,
      contributors.work_date as evidence_work_date,
      contributors.productive_minutes as evidence_productive_minutes,
      contributors.is_hawley_timer as evidence_is_hawley_timer,
      counts.contributor_count
    from completed_tasks tasks
    join session_contributors contributors on contributors.asana_task_gid = tasks.asana_task_gid
    join contributor_counts counts on counts.asana_task_gid = tasks.asana_task_gid
  ),
  fallback_evidence as (
    select
      tasks.*,
      tasks.assigned_worker_identity as evidence_worker_identity,
      tasks.worker_record_id as evidence_worker_record_id,
      coalesce(nullif(tasks.worker_name, ''), nullif(tasks.assignee_name, '')) as evidence_worker_name,
      coalesce(nullif(tasks.worker_email, ''), nullif(tasks.assignee_email, '')) as evidence_worker_email,
      null::timestamptz as evidence_started_at,
      null::timestamptz as evidence_completed_at,
      tasks.completed_on as evidence_work_date,
      nullif(coalesce(tasks.actual_time_minutes, round(tasks.actual_time_seconds / 60.0)::int), 0)::numeric(12, 2) as evidence_productive_minutes,
      false as evidence_is_hawley_timer,
      1::int as contributor_count
    from completed_tasks tasks
    where tasks.assigned_worker_identity is not null
      and not exists (
        select 1
        from session_contributors contributors
        where contributors.asana_task_gid = tasks.asana_task_gid
      )
  ),
  evidence as (
    select * from timed_evidence
    union all
    select * from fallback_evidence
  )
  insert into core.task_completion_evidence (
    evidence_key,
    task_instance_id,
    airtable_record_id,
    asana_task_gid,
    task_record_id,
    tasks_key,
    task_name,
    required_skill_level,
    worker_identity,
    worker_record_id,
    worker_name,
    worker_email,
    completed_on,
    started_at,
    completed_at,
    productive_minutes,
    estimated_minutes,
    quantity,
    minutes_per_unit,
    timing_source,
    evidence_confidence,
    assisted,
    contributor_count,
    source_system,
    source_payload,
    last_refreshed_at
  )
  select
    'rev1:' || evidence.rev1_task_instance_id::text || ':' || evidence.evidence_worker_identity,
    evidence.rev1_task_instance_id,
    evidence.airtable_record_id,
    evidence.asana_task_gid,
    evidence.tasks_record_id,
    evidence.tasks_key,
    evidence.task_name,
    evidence.required_skill_level,
    evidence.evidence_worker_identity,
    evidence.evidence_worker_record_id,
    evidence.evidence_worker_name,
    evidence.evidence_worker_email,
    coalesce(evidence.completed_on, evidence.evidence_work_date),
    evidence.evidence_started_at,
    evidence.evidence_completed_at,
    evidence.evidence_productive_minutes,
    round((coalesce(evidence.estimated_batch_task_time_seconds, evidence.estimated_task_time_seconds, 0) / 60.0)::numeric, 2),
    evidence.quantity,
    case
      when evidence.evidence_productive_minutes > 0 and coalesce(evidence.quantity, 0) > 0
        then round(evidence.evidence_productive_minutes / evidence.quantity, 2)
      else null
    end,
    case
      when evidence.evidence_is_hawley_timer then 'hawley_timer_session'
      when evidence.evidence_productive_minutes > 0 then 'historical_actual_time'
      else 'completion_without_time'
    end,
    case
      when evidence.evidence_is_hawley_timer then 'high'
      when evidence.evidence_productive_minutes > 0 then 'medium'
      else 'low'
    end,
    evidence.contributor_count > 1,
    evidence.contributor_count,
    case when evidence.evidence_is_hawley_timer then 'hawley_timer_history' else 'hb_rev1_history' end,
    jsonb_build_object(
      'taskInstanceId', evidence.rev1_task_instance_id,
      'airtableRecordId', evidence.airtable_record_id,
      'asanaTaskGid', evidence.asana_task_gid
    ),
    now()
  from evidence
  where evidence.evidence_worker_identity is not null
  on conflict (evidence_key) do update set
    task_name = excluded.task_name,
    required_skill_level = excluded.required_skill_level,
    worker_record_id = excluded.worker_record_id,
    worker_name = excluded.worker_name,
    worker_email = excluded.worker_email,
    completed_on = excluded.completed_on,
    started_at = excluded.started_at,
    completed_at = excluded.completed_at,
    productive_minutes = excluded.productive_minutes,
    estimated_minutes = excluded.estimated_minutes,
    quantity = excluded.quantity,
    minutes_per_unit = excluded.minutes_per_unit,
    timing_source = excluded.timing_source,
    evidence_confidence = excluded.evidence_confidence,
    assisted = excluded.assisted,
    contributor_count = excluded.contributor_count,
    source_system = excluded.source_system,
    source_payload = excluded.source_payload,
    last_refreshed_at = now()
  where (core.task_completion_evidence.task_name, core.task_completion_evidence.required_skill_level, core.task_completion_evidence.worker_record_id, core.task_completion_evidence.worker_name, core.task_completion_evidence.worker_email, core.task_completion_evidence.completed_on, core.task_completion_evidence.started_at, core.task_completion_evidence.completed_at, core.task_completion_evidence.productive_minutes, core.task_completion_evidence.estimated_minutes, core.task_completion_evidence.quantity, core.task_completion_evidence.minutes_per_unit, core.task_completion_evidence.timing_source, core.task_completion_evidence.evidence_confidence, core.task_completion_evidence.assisted, core.task_completion_evidence.contributor_count, core.task_completion_evidence.source_system, core.task_completion_evidence.source_payload)
    is distinct from (excluded.task_name, excluded.required_skill_level, excluded.worker_record_id, excluded.worker_name, excluded.worker_email, excluded.completed_on, excluded.started_at, excluded.completed_at, excluded.productive_minutes, excluded.estimated_minutes, excluded.quantity, excluded.minutes_per_unit, excluded.timing_source, excluded.evidence_confidence, excluded.assisted, excluded.contributor_count, excluded.source_system, excluded.source_payload);

  get diagnostics evidence_rows = row_count;

  delete from core.worker_task_capabilities;

  with ranked as (
    select
      evidence.*,
      row_number() over (
        partition by evidence.worker_identity, evidence.task_record_id
        order by evidence.completed_on desc nulls last, evidence.task_completion_evidence_id desc
      ) as recent_rank
    from core.task_completion_evidence evidence
  ),
  summary as (
    select
      worker_identity,
      task_record_id,
      max(worker_record_id) as worker_record_id,
      max(worker_name) as worker_name,
      max(worker_email) as worker_email,
      max(task_name) as task_name,
      max(required_skill_level) as required_skill_level,
      count(*)::int as completion_count,
      count(*) filter (where productive_minutes > 0)::int as timed_completion_count,
      count(*) filter (where verified)::int as verified_completion_count,
      count(*) filter (where assisted is false)::int as solo_completion_count,
      count(*) filter (where assisted is true)::int as assisted_completion_count,
      min(completed_on) as first_completed_on,
      max(completed_on) as last_completed_on,
      round(avg(productive_minutes) filter (where productive_minutes > 0), 2) as average_minutes,
      round(((percentile_cont(0.5) within group (order by productive_minutes) filter (where productive_minutes > 0))::numeric), 2) as median_minutes,
      round(min(productive_minutes) filter (where productive_minutes > 0 and coalesce(rework_required, false) is false), 2) as best_valid_minutes,
      round(stddev_pop(productive_minutes) filter (where productive_minutes > 0), 2) as time_variability_minutes,
      round(avg(minutes_per_unit) filter (where minutes_per_unit > 0), 2) as average_minutes_per_unit,
      count(*) filter (where coalesce(rework_required, false))::int as rework_count,
      max(last_refreshed_at) as last_evidence_at,
      bool_or(evidence_confidence = 'high') as has_high_confidence,
      bool_or(evidence_confidence = 'medium') as has_medium_confidence
    from ranked
    group by worker_identity, task_record_id
  ),
  recent as (
    select
      worker_identity,
      task_record_id,
      round((percentile_cont(0.5) within group (order by productive_minutes))::numeric, 2) as recent_median_minutes
    from ranked
    where recent_rank <= 5
      and productive_minutes > 0
    group by worker_identity, task_record_id
  )
  insert into core.worker_task_capabilities (
    worker_identity,
    task_record_id,
    worker_record_id,
    worker_name,
    worker_email,
    task_name,
    required_skill_level,
    completion_count,
    timed_completion_count,
    verified_completion_count,
    solo_completion_count,
    assisted_completion_count,
    first_completed_on,
    last_completed_on,
    average_minutes,
    median_minutes,
    recent_median_minutes,
    best_valid_minutes,
    time_variability_minutes,
    average_minutes_per_unit,
    rework_count,
    capability_status,
    evidence_confidence,
    last_evidence_at,
    refreshed_at
  )
  select
    summary.worker_identity,
    summary.task_record_id,
    summary.worker_record_id,
    summary.worker_name,
    summary.worker_email,
    summary.task_name,
    summary.required_skill_level,
    summary.completion_count,
    summary.timed_completion_count,
    summary.verified_completion_count,
    summary.solo_completion_count,
    summary.assisted_completion_count,
    summary.first_completed_on,
    summary.last_completed_on,
    summary.average_minutes,
    summary.median_minutes,
    recent.recent_median_minutes,
    summary.best_valid_minutes,
    summary.time_variability_minutes,
    summary.average_minutes_per_unit,
    summary.rework_count,
    case
      when summary.verified_completion_count > 0 then 'verified'
      when summary.completion_count > 0 then 'completed_before'
      else 'not_observed'
    end,
    case
      when summary.has_high_confidence then 'high'
      when summary.has_medium_confidence then 'medium'
      else 'low'
    end,
    summary.last_evidence_at,
    now()
  from summary
  left join recent using (worker_identity, task_record_id);

  get diagnostics capability_rows = row_count;

  return jsonb_build_object(
    'evidenceRowsRefreshed', evidence_rows,
    'capabilityRowsBuilt', capability_rows,
    'evidenceRowsTotal', (select count(*) from core.task_completion_evidence)
  );
end
$$;
