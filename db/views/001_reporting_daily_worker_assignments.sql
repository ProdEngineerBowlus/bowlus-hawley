create or replace view reporting.daily_worker_assignments as
select
  ti.rev1_task_instance_id as task_instance_id,
  ti.worker_name,
  ti.worker_email,
  ti.assigned_on,
  ti.task_name,
  ti.task_status,
  coalesce(ti.phase_label, ti.section_column) as phase_name,
  ti.cycle_label as cycle_name,
  coalesce(ti.vin_text, ti.vin::text) as vin,
  round((coalesce(ti.estimated_batch_task_time_seconds, ti.estimated_task_time_seconds, 0) / 3600.0)::numeric, 2)::numeric(10, 2) as estimated_hours,
  ti.actual_time_minutes,
  ti.asana_task_gid,
  ti.airtable_record_id,
  ti.normalized_at
from hb.rev1_task_instances ti
where ti.assigned_on is not null;
