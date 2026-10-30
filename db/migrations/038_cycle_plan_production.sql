-- Cycle plan versions also record the production (VIN position) changes published with them and the
-- one-time Asana push of moved tasks' Cycle field.
alter table hb.cycle_plan_versions
  add column if not exists plan_group_id text,
  add column if not exists production_json jsonb not null default '{}'::jsonb,
  add column if not exists asana_push_json jsonb not null default '[]'::jsonb;

create index if not exists cycle_plan_versions_group_idx
  on hb.cycle_plan_versions (plan_group_id);

-- The Asana push result is recorded after the publish transaction commits.
grant update (asana_push_json) on hb.cycle_plan_versions to bowlus_app, bowlus_sync;
