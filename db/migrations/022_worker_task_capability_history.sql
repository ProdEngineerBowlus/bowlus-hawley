create table if not exists core.task_completion_evidence (
  task_completion_evidence_id bigserial primary key,
  evidence_key text not null unique,
  task_instance_id bigint,
  airtable_record_id text,
  asana_task_gid text,
  task_record_id text not null,
  tasks_key text,
  task_name text,
  required_skill_level numeric(12, 4),
  worker_identity text not null,
  worker_record_id text,
  worker_name text,
  worker_email text,
  completed_on date,
  started_at timestamptz,
  completed_at timestamptz,
  productive_minutes numeric(12, 2),
  estimated_minutes numeric(12, 2),
  quantity numeric(12, 4),
  minutes_per_unit numeric(12, 2),
  timing_source text not null default 'completion_without_time',
  evidence_confidence text not null default 'low',
  assisted boolean,
  contributor_count integer not null default 1,
  quality_status text not null default 'unknown',
  rework_required boolean,
  verified boolean not null default false,
  verified_by text,
  verified_at timestamptz,
  source_system text not null default 'hb_rev1_history',
  source_payload jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_refreshed_at timestamptz not null default now()
);

create index if not exists idx_task_completion_evidence_task
  on core.task_completion_evidence(task_record_id, completed_on desc);

create index if not exists idx_task_completion_evidence_worker
  on core.task_completion_evidence(worker_identity, completed_on desc);

create index if not exists idx_task_completion_evidence_asana
  on core.task_completion_evidence(asana_task_gid);

create table if not exists core.worker_task_capabilities (
  worker_identity text not null,
  task_record_id text not null,
  worker_record_id text,
  worker_name text,
  worker_email text,
  task_name text,
  required_skill_level numeric(12, 4),
  completion_count integer not null default 0,
  timed_completion_count integer not null default 0,
  verified_completion_count integer not null default 0,
  solo_completion_count integer not null default 0,
  assisted_completion_count integer not null default 0,
  first_completed_on date,
  last_completed_on date,
  average_minutes numeric(12, 2),
  median_minutes numeric(12, 2),
  recent_median_minutes numeric(12, 2),
  best_valid_minutes numeric(12, 2),
  time_variability_minutes numeric(12, 2),
  average_minutes_per_unit numeric(12, 2),
  rework_count integer not null default 0,
  capability_status text not null default 'not_observed',
  evidence_confidence text not null default 'low',
  last_evidence_at timestamptz,
  refreshed_at timestamptz not null default now(),
  primary key (worker_identity, task_record_id)
);

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
    last_refreshed_at = now();

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

create or replace view reporting.worker_task_capability_rankings as
select
  capabilities.*,
  row_number() over (
    partition by capabilities.task_record_id
    order by
      (capabilities.capability_status = 'verified') desc,
      capabilities.completion_count desc,
      capabilities.timed_completion_count desc,
      capabilities.rework_count asc,
      capabilities.recent_median_minutes asc nulls last,
      capabilities.median_minutes asc nulls last,
      capabilities.worker_name
  )::int as evidence_rank,
  row_number() over (
    partition by capabilities.task_record_id
    order by capabilities.median_minutes asc nulls last, capabilities.completion_count desc
  )::int as time_rank
from core.worker_task_capabilities capabilities;

grant select, insert, update, delete on core.task_completion_evidence to bowlus_app, bowlus_sync;
grant select, insert, update, delete on core.worker_task_capabilities to bowlus_app, bowlus_sync;
grant usage, select, update on sequence core.task_completion_evidence_task_completion_evidence_id_seq to bowlus_app, bowlus_sync;
grant execute on function core.refresh_worker_task_capabilities() to bowlus_app, bowlus_sync;
grant select on reporting.worker_task_capability_rankings to bowlus_app, bowlus_readonly;
