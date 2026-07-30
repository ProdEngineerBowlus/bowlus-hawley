-- Airtable Tasks controls whether a task includes bending with the checked
-- `Has Bending?` field. Normalize that flag for the worker app and preserve
-- the automation key on generated studies so ending one prevents it from
-- being recreated for the same worker/task/day.

alter table hb.task_templates
  add column if not exists has_bending boolean not null default false;

update hb.task_templates template
set has_bending = case lower(coalesce(raw_task.fields_json ->> 'Has Bending?', ''))
  when 'true' then true
  when '1' then true
  when 'yes' then true
  when 'y' then true
  when 'checked' then true
  else false
end
from raw.airtable_tasks raw_task
where raw_task.record_id = template.task_record_id
  and template.has_bending is distinct from case lower(coalesce(raw_task.fields_json ->> 'Has Bending?', ''))
    when 'true' then true
    when '1' then true
    when 'yes' then true
    when 'y' then true
    when 'checked' then true
    else false
  end;

alter table core.task_time_studies
  add column if not exists auto_rule_key text;

create index if not exists idx_task_time_studies_auto_rule
  on core.task_time_studies(auto_rule_key, work_date, worker_key, asana_task_gid)
  where auto_rule_key is not null;

comment on column hb.task_templates.has_bending is
  'Mirrors Airtable Tasks.Has Bending? and automatically enables the Bending time study for assigned open task instances.';

comment on column core.task_time_studies.auto_rule_key is
  'Identifies a Hawley-created template rule. A prior record with the same key prevents re-creating a study after it was ended for that worker/task/day.';
