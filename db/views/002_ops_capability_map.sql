create or replace view reporting.work_force_capability_levels as
with workforce as (
  select
    wf.record_id as workforce_record_id,
    nullif(wf.fields_json->>'Name', '') as worker_name,
    nullif(wf.fields_json->>'Assignee', '') as worker_email,
    case
      when lower(coalesce(wf.fields_json->>'Actively Employed', 'false')) in ('true', '1', 'yes') then true
      else false
    end as actively_employed,
    case
      when nullif(regexp_replace(coalesce(wf.fields_json->>'Hours Per Day', ''), '[^0-9.\-]+', '', 'g'), '') is null then null
      else nullif(regexp_replace(coalesce(wf.fields_json->>'Hours Per Day', ''), '[^0-9.\-]+', '', 'g'), '')::numeric
    end as hours_per_day,
    ops.jsonb_display_text(wf.fields_json->'Home Section/Column') as home_section_column,
    wf.fields_json
  from raw.airtable_work_force wf
),
declared as (
  select
    workforce.*,
    wa.work_area_key,
    wa.display_name as work_area_name,
    wa.skill_level_field,
    case
      when wa.skill_level_field is null then null
      when nullif(regexp_replace(coalesce(workforce.fields_json->>wa.skill_level_field, ''), '[^0-9.\-]+', '', 'g'), '') is null then null
      else nullif(regexp_replace(coalesce(workforce.fields_json->>wa.skill_level_field, ''), '[^0-9.\-]+', '', 'g'), '')::numeric
    end as skill_level
  from workforce
  cross join ops.work_area_aliases wa
  where wa.active
    and wa.skill_level_field is not null
)
select
  workforce_record_id,
  worker_name,
  worker_email,
  actively_employed,
  hours_per_day,
  home_section_column,
  work_area_key,
  work_area_name,
  skill_level_field,
  skill_level,
  case
    when skill_level is null or skill_level <= 0 then 'not_declared'
    when skill_level >= 4 then 'primary_candidate'
    when skill_level >= 3 then 'capable'
    when skill_level >= 1 then 'support'
    else 'not_declared'
  end as capability_band,
  case
    when skill_level >= 4 then 'high'
    when skill_level >= 2 then 'medium'
    when skill_level > 0 then 'low'
    else 'none'
  end as declared_confidence
from declared;

create or replace view reporting.task_work_area_inference as
select
  ti.id as task_instance_id,
  ti.airtable_record_id,
  ti.asana_task_gid,
  ti.task_name,
  ti.worker_name,
  ti.worker_email,
  ti.assigned_on,
  ti.task_status,
  ti.phase_name,
  ti.cycle_name,
  ti.vin,
  ti.estimated_hours,
  ti.actual_time_minutes,
  coalesce(matched_area.work_area_key, regexp_replace(lower(coalesce(nullif(ti.phase_name, ''), membership.section_name, 'unspecified')), '[^a-z0-9]+', '_', 'g')) as inferred_work_area_key,
  coalesce(matched_area.display_name, nullif(ti.phase_name, ''), membership.section_name, 'Unspecified') as inferred_work_area_name,
  case
    when matched_area.work_area_key is not null and nullif(ti.phase_name, '') is not null then 'airtable_phase_alias'
    when nullif(ti.phase_name, '') is not null then 'airtable_phase'
    when membership.section_name is not null then 'asana_section'
    else 'unknown'
  end as inference_source,
  ti.normalized_at
from core.task_instances ti
left join lateral (
  select
    m.section_name
  from raw.asana_task_project_memberships m
  where m.task_gid = ti.asana_task_gid
  order by m.is_source_project desc, (m.section_name is null), m.section_name
  limit 1
) membership on true
left join lateral (
  select wa.work_area_key, wa.display_name
  from ops.work_area_aliases wa
  where wa.active
    and (
      lower(coalesce(ti.phase_name, '')) = lower(wa.display_name)
      or exists (
        select 1
        from unnest(wa.phase_names || wa.section_names) as alias_name
        where lower(coalesce(ti.phase_name, membership.section_name, '')) = lower(alias_name)
      )
      or exists (
        select 1
        from unnest(wa.task_keywords) as keyword
        where lower(coalesce(ti.task_name, '')) like '%' || lower(keyword) || '%'
      )
    )
  order by
    case when lower(coalesce(ti.phase_name, '')) = lower(wa.display_name) then 0 else 1 end,
    array_length(wa.phase_names || wa.section_names, 1) nulls last,
    wa.display_name
  limit 1
) matched_area on true;

create or replace view reporting.assignee_work_history as
select
  worker_name,
  worker_email,
  inferred_work_area_key as work_area_key,
  inferred_work_area_name as work_area_name,
  count(*)::int as task_count,
  count(*) filter (
    where lower(coalesce(task_status, '')) in ('true', 'complete', 'completed', 'done', 'yes')
  )::int as completed_task_count,
  round(coalesce(sum(estimated_hours), 0)::numeric, 2) as estimated_hours,
  round((coalesce(sum(actual_time_minutes), 0) / 60.0)::numeric, 2) as actual_hours,
  min(assigned_on) as first_assigned_on,
  max(assigned_on) as last_assigned_on,
  case
    when count(*) >= 25 then 'high'
    when count(*) >= 8 then 'medium'
    when count(*) > 0 then 'low'
    else 'none'
  end as observed_confidence
from reporting.task_work_area_inference
where nullif(coalesce(worker_email, worker_name), '') is not null
group by
  worker_name,
  worker_email,
  inferred_work_area_key,
  inferred_work_area_name;

create or replace view reporting.work_area_owner_hints as
select
  hints.owner_hint_key,
  hints.work_area_key,
  wa.display_name as work_area_name,
  hints.owner_person_name,
  hints.owner_person_email,
  hints.owner_role,
  hints.confidence_label,
  hints.source_label,
  hints.notes,
  wf.record_id as matched_workforce_record_id,
  coalesce(wf.fields_json->>'Name', hints.owner_person_name) as matched_worker_name,
  coalesce(wf.fields_json->>'Assignee', hints.owner_person_email) as matched_worker_email,
  hints.active,
  hints.updated_at
from ops.manual_work_area_owner_hints hints
join ops.work_area_aliases wa on wa.work_area_key = hints.work_area_key
left join raw.airtable_work_force wf
  on (
    hints.owner_person_email is not null
    and lower(wf.fields_json->>'Assignee') = lower(hints.owner_person_email)
  )
  or (
    hints.owner_person_email is null
    and hints.owner_person_name is not null
    and lower(wf.fields_json->>'Name') like '%' || lower(hints.owner_person_name) || '%'
  )
where hints.active;

create or replace view reporting.worker_capability_map as
with declared as (
  select *
  from reporting.work_force_capability_levels
),
observed as (
  select *
  from reporting.assignee_work_history
),
combined as (
  select
    coalesce(declared.worker_name, observed.worker_name) as worker_name,
    coalesce(declared.worker_email, observed.worker_email) as worker_email,
    coalesce(declared.actively_employed, true) as actively_employed,
    declared.hours_per_day,
    declared.home_section_column,
    coalesce(declared.work_area_key, observed.work_area_key) as work_area_key,
    coalesce(declared.work_area_name, observed.work_area_name) as work_area_name,
    declared.skill_level_field,
    declared.skill_level,
    declared.capability_band,
    declared.declared_confidence,
    coalesce(observed.task_count, 0) as observed_task_count,
    coalesce(observed.completed_task_count, 0) as observed_completed_task_count,
    coalesce(observed.estimated_hours, 0) as observed_estimated_hours,
    coalesce(observed.actual_hours, 0) as observed_actual_hours,
    observed.first_assigned_on,
    observed.last_assigned_on,
    coalesce(observed.observed_confidence, 'none') as observed_confidence
  from declared
  full outer join observed
    on lower(coalesce(declared.worker_email, declared.worker_name, '')) = lower(coalesce(observed.worker_email, observed.worker_name, ''))
   and declared.work_area_key = observed.work_area_key
)
select
  combined.*,
  owner_hints.owner_role as manual_owner_role,
  owner_hints.confidence_label as manual_owner_confidence,
  case
    when owner_hints.owner_hint_key is not null then 'manual_owner_hint'
    when combined.skill_level >= 4 and combined.observed_task_count >= 8 then 'declared_and_observed'
    when combined.skill_level >= 4 then 'declared_high'
    when combined.observed_task_count >= 25 then 'observed_high'
    when combined.skill_level >= 2 or combined.observed_task_count >= 8 then 'candidate'
    when combined.skill_level > 0 or combined.observed_task_count > 0 then 'weak_signal'
    else 'unknown'
  end as routing_signal,
  case
    when owner_hints.owner_hint_key is not null then 'high'
    when combined.skill_level >= 4 and combined.observed_task_count >= 8 then 'high'
    when combined.skill_level >= 3 or combined.observed_task_count >= 8 then 'medium'
    when combined.skill_level > 0 or combined.observed_task_count > 0 then 'low'
    else 'none'
  end as routing_confidence
from combined
left join reporting.work_area_owner_hints owner_hints
  on owner_hints.work_area_key = combined.work_area_key
 and lower(coalesce(owner_hints.matched_worker_email, owner_hints.matched_worker_name, '')) = lower(coalesce(combined.worker_email, combined.worker_name, ''));

create or replace view reporting.work_area_owners as
with manual as (
  select
    work_area_key,
    work_area_name,
    matched_worker_name as worker_name,
    matched_worker_email as worker_email,
    owner_role as signal_type,
    100::numeric as signal_score,
    confidence_label as confidence,
    source_label as source
  from reporting.work_area_owner_hints
),
declared_ranked as (
  select
    work_area_key,
    work_area_name,
    worker_name,
    worker_email,
    'declared_skill_level' as signal_type,
    skill_level as signal_score,
    declared_confidence as confidence,
    skill_level_field as source,
    row_number() over (
      partition by work_area_key
      order by skill_level desc nulls last, actively_employed desc, worker_name
    ) as rank_in_area
  from reporting.work_force_capability_levels
  where skill_level > 0
),
observed_ranked as (
  select
    work_area_key,
    work_area_name,
    worker_name,
    worker_email,
    'observed_assignment_history' as signal_type,
    task_count::numeric as signal_score,
    observed_confidence as confidence,
    'core.task_instances' as source,
    row_number() over (
      partition by work_area_key
      order by task_count desc, completed_task_count desc, worker_name
    ) as rank_in_area
  from reporting.assignee_work_history
  where task_count > 0
)
select
  work_area_key,
  work_area_name,
  worker_name,
  worker_email,
  signal_type,
  signal_score,
  confidence,
  source
from manual
union all
select
  work_area_key,
  work_area_name,
  worker_name,
  worker_email,
  signal_type,
  signal_score,
  confidence,
  source
from declared_ranked
where rank_in_area <= 5
union all
select
  work_area_key,
  work_area_name,
  worker_name,
  worker_email,
  signal_type,
  signal_score,
  confidence,
  source
from observed_ranked
where rank_in_area <= 5;
