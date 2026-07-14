alter table hb.task_templates
  add column if not exists required_skill_level numeric(12, 4);

update hb.task_templates
set required_skill_level = case
  when nullif(regexp_replace(coalesce(fields_json->>'Required Skill Level', ''), '[^0-9.\-]+', '', 'g'), '') is null then null
  else nullif(regexp_replace(coalesce(fields_json->>'Required Skill Level', ''), '[^0-9.\-]+', '', 'g'), '')::numeric
end
where required_skill_level is distinct from case
  when nullif(regexp_replace(coalesce(fields_json->>'Required Skill Level', ''), '[^0-9.\-]+', '', 'g'), '') is null then null
  else nullif(regexp_replace(coalesce(fields_json->>'Required Skill Level', ''), '[^0-9.\-]+', '', 'g'), '')::numeric
end;

create or replace view reporting.hawley_worker_page_assignments as
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
left join reporting.task_work_area_inference work_area on work_area.task_instance_id = dwa.task_instance_id;

grant select on reporting.hawley_worker_page_assignments to bowlus_app, bowlus_readonly;
