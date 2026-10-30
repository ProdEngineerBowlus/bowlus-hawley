-- Worker page assignments: the assignee's row for each assigned task, plus one row per helper from the
-- Asana Helpers field (team tasks). Helper rows carry no estimate so capacity is not double counted, and
-- appear only for trial workers until team tasks are enabled for everyone.
create or replace view reporting.hawley_worker_page_assignments as
with base as (
  select
    dwa.task_instance_id,
    dwa.airtable_record_id,
    dwa.asana_task_gid,
    dwa.worker_name,
    dwa.worker_email,
    dwa.assigned_on,
    dwa.task_name,
    coalesce(asana_task.completed, lower(coalesce(dwa.task_status, '')) in ('true', 'complete', 'completed', 'done', 'yes')) as completed,
    dwa.task_status,
    dwa.phase_name,
    dwa.cycle_name,
    dwa.vin,
    dwa.estimated_hours,
    dwa.actual_time_minutes,
    asana_task.permalink_url as asana_permalink_url,
    ops.jsonb_display_text(hb_task.fields_json->'SOP Link') as sop_link,
    coalesce(hb_task.document_link, ops.jsonb_display_text(hb_task.fields_json->'Document Link')) as document_link,
    coalesce(hb_task.section_column, ops.jsonb_display_text(hb_task.fields_json->'Section/Column')) as section_column,
    work_area.inferred_work_area_key,
    work_area.inferred_work_area_name,
    work_area.inference_source,
    dwa.normalized_at,
    greatest(
      coalesce(dwa.normalized_at, '-infinity'::timestamptz),
      coalesce(asana_task.synced_at, '-infinity'::timestamptz),
      coalesce(hb_task.source_synced_at, '-infinity'::timestamptz),
      coalesce(task_template.source_synced_at, '-infinity'::timestamptz)
    ) as source_synced_at,
    task_template.required_skill_level
  from reporting.daily_worker_assignments dwa
  left join raw.asana_tasks asana_task on asana_task.gid = dwa.asana_task_gid
  left join hb.rev1_task_instances hb_task on hb_task.rev1_task_instance_id = dwa.task_instance_id
  left join hb.task_templates task_template on task_template.task_record_id = hb_task.tasks_record_id
  left join reporting.task_work_area_inference work_area on work_area.task_instance_id = dwa.task_instance_id
)
select base.*, 'assignee'::text as assignment_role
from base
union all
select
  base.task_instance_id,
  base.airtable_record_id,
  base.asana_task_gid,
  coalesce(helper.helper_name, helper.helper_email) as worker_name,
  helper.helper_email as worker_email,
  base.assigned_on,
  base.task_name,
  base.completed,
  base.task_status,
  base.phase_name,
  base.cycle_name,
  base.vin,
  0::numeric(10, 2) as estimated_hours,
  base.actual_time_minutes,
  base.asana_permalink_url,
  base.sop_link,
  base.document_link,
  base.section_column,
  base.inferred_work_area_key,
  base.inferred_work_area_name,
  base.inference_source,
  base.normalized_at,
  greatest(base.source_synced_at, helper.synced_at) as source_synced_at,
  base.required_skill_level,
  'helper'::text as assignment_role
from base
join hb.task_helpers helper on helper.asana_task_gid = base.asana_task_gid
cross join hb.team_task_settings settings
where lower(helper.helper_email) <> lower(coalesce(base.worker_email, ''))
  and (settings.enabled_for_all or lower(helper.helper_email) = any(settings.trial_worker_emails));

grant select on reporting.hawley_worker_page_assignments to bowlus_app, bowlus_readonly;
