-- Mirror Airtable's task-level historical time baseline into Hawley. Airtable
-- currently calculates these fields from its linked Task Instances Rev1 rows;
-- Hawley retains their precise values and confidence band without changing the
-- current Airtable ownership of the calculation.

alter table hb.task_templates
  add column if not exists avg_time_seconds numeric(14, 4),
  add column if not exists avg_time_input_count integer,
  add column if not exists avg_time_quality text;

update hb.task_templates template
set
  avg_time_seconds = case
    when nullif(regexp_replace(coalesce(raw_task.fields_json ->> 'Avg. Time', ''), '[^0-9.\-]+', '', 'g'), '') is null then null
    else nullif(regexp_replace(raw_task.fields_json ->> 'Avg. Time', '[^0-9.\-]+', '', 'g'), '')::numeric
  end,
  avg_time_input_count = case
    when nullif(regexp_replace(coalesce(raw_task.fields_json ->> 'Avg. Time Input Count', ''), '[^0-9\-]+', '', 'g'), '') is null then null
    else nullif(regexp_replace(raw_task.fields_json ->> 'Avg. Time Input Count', '[^0-9\-]+', '', 'g'), '')::integer
  end,
  avg_time_quality = nullif(btrim(raw_task.fields_json ->> 'Avg. Time Quality'), '')
from raw.airtable_tasks raw_task
where raw_task.record_id = template.task_record_id;

comment on column hb.task_templates.avg_time_seconds is
  'Mirrors Airtable Tasks.Avg. Time in seconds. Airtable currently averages qualifying linked Task Instances Rev1 actuals.';

comment on column hb.task_templates.avg_time_input_count is
  'Mirrors Airtable Tasks.Avg. Time Input Count: qualifying actual-time observations behind Avg. Time.';

comment on column hb.task_templates.avg_time_quality is
  'Mirrors Airtable Tasks.Avg. Time Quality. Bands: No Data=0, Very Low=1, Low=2-3, Medium=4-6, High=7-8, Very High=9+ qualifying inputs.';
