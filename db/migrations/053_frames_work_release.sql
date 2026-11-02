-- Frames work (Frame-A/B) moves from the cycle's Fabrication project (F22.26) into its Frames project (FR22.26) from
-- the Frames stage's start cycle on. Earlier cycles keep it in Fabrication.
alter table hb.workflow_stages add column if not exists starts_from_cycle text not null default '';
update hb.workflow_stages set starts_from_cycle = 'C22.26',
       notes = 'Phase A1/A2 (pilot VINs) and, from C22.26, the cycle''s Frame-A/B work. A1/A2 move into the VIN project at the Frames gate; Frame-A/B work stays here.'
 where stage_key = 'frames' and starts_from_cycle = '';

-- One row per cycle whose Frame-A/B work was released into its Frames project. The Project Creator run holds links.
create table if not exists hb.frames_work_releases (
  cycle_key text primary key,
  project_name text not null,
  project_creation_run_id text not null,
  task_count integer not null default 0,
  released_by text not null default '',
  released_at timestamptz not null default now()
);

grant select, insert, update, delete on hb.frames_work_releases to bowlus_app, bowlus_sync;
grant select on hb.frames_work_releases to bowlus_readonly;
