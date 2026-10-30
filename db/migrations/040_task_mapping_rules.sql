-- Task template ramp step 2b: admin decisions for tasks that have no template key. A rule maps every
-- task with a given normalized name (and phase, or any phase when match_phase = '') to a definition,
-- or marks the group as one-off work to ignore. Rules are applied by every HB rebuild.
create table if not exists hb.task_mapping_rules (
  match_name text not null,
  match_phase text not null default '',
  action text not null check (action in ('map', 'ignore')),
  task_definition_id text references hb.task_definitions,
  note text not null default '',
  decided_by text not null default '',
  decided_at timestamptz not null default now(),
  primary key (match_name, match_phase),
  check ((action = 'map') = (task_definition_id is not null))
);

grant select, insert, update, delete on hb.task_mapping_rules to bowlus_app, bowlus_sync;
grant select on hb.task_mapping_rules to bowlus_readonly;
