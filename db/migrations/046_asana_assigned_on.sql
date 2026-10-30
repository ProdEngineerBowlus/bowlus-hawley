-- Last Assigned On value Hawley saw in Asana. When it goes from a date to blank on an open task, the HB rebuild
-- clears assigned_on so the task leaves the worker page (Asana runs day-to-day dispatch).
alter table hb.rev1_task_instances add column if not exists asana_assigned_on date;
