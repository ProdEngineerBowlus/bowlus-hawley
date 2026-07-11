create or replace view reporting.hawley_reporting_day_summary as
select
  assigned_on,
  coalesce(cycle_name, 'Current') as cycle_name,
  count(distinct nullif(coalesce(worker_email, worker_name), ''))::int as worker_count,
  count(*)::int as task_count,
  count(*) filter (where completed)::int as completed_task_count,
  count(*) filter (where not completed)::int as open_task_count,
  coalesce(sum(estimated_hours), 0)::numeric as assigned_hours,
  coalesce(sum(estimated_hours) filter (where completed), 0)::numeric as completed_hours,
  coalesce(sum(estimated_hours) filter (where not completed), 0)::numeric as remaining_hours
from reporting.hawley_worker_page_assignments
where assigned_on is not null
group by assigned_on, coalesce(cycle_name, 'Current');
