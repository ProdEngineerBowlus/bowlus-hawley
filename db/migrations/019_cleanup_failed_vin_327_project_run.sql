do $$
declare
  target_run_id constant text := 'ef7e60bb-366b-49e6-a899-b1c3785cda48';
begin
  if exists (
    select 1
    from hb.project_creation_runs run
    where run.project_creation_run_id = target_run_id
      and run.status = 'failed'
      and run.vin = '327'
      and run.asana_project_gid is null
      and not exists (
        select 1
        from hb.rev1_task_instances task
        where task.source_system = 'hawley_project_creator'
          and task.fields_json ->> 'projectCreationRunId' = target_run_id
          and (task.asana_task_gid is not null or task.asana_project_gid is not null)
      )
  ) then
    delete from hb.rev1_task_instances
    where source_system = 'hawley_project_creator'
      and fields_json ->> 'projectCreationRunId' = target_run_id;

    delete from hb.project_creation_runs
    where project_creation_run_id = target_run_id;
  end if;
end
$$;
