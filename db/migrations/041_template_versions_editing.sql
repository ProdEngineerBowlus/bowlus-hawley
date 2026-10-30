-- Task template ramp step 3: templates are edited in Hawley as new versions. A version can apply now or
-- from a future cycle; when it takes effect, hb.task_templates (read by Project Creator) and the
-- attachment catalog are updated from it, so the current creation path keeps working during the ramp.
select pg_advisory_xact_lock(1212241740, 1212301892);

alter table hb.task_definition_versions
  add column if not exists model_type_names text[] not null default '{}'::text[],
  add column if not exists required_skill_level numeric(12, 4),
  add column if not exists retired boolean not null default false;

alter table hb.task_definitions
  add column if not exists current_version_number integer;

-- Version 1 reuses the verified attachment references already in the catalog.
update hb.task_definition_versions v
   set attachment_files_json = c.attachment_files
  from core.task_attachment_catalog c
 where c.task_record_id = v.task_definition_id and v.version_number = 1;

update hb.task_definition_versions v
   set model_type_names = coalesce(tt.model_type_names, '{}'::text[]),
       required_skill_level = tt.required_skill_level,
       retired = not coalesce(tt.active, true)
  from hb.task_templates tt
 where tt.task_record_id = v.task_definition_id and v.version_number = 1;

update hb.task_definitions set current_version_number = 1 where current_version_number is null;
