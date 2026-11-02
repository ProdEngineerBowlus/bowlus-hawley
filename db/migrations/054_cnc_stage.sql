-- CNC department projects (CNC21.26 in CNC - 2026), like Frames: from the CNC stage's start cycle on, CNC-A/B work
-- leaves the Fabrication project and is released into the cycle's CNC project. Off until the stage is switched on and
-- given a start cycle in Admin > Releases > Workflow settings.
create table if not exists hb.cnc_projects (
  cycle_label text primary key,
  project_name text not null,
  asana_project_gid text,
  created_at timestamptz not null default now()
);

create table if not exists hb.cnc_work_releases (
  cycle_key text primary key,
  project_name text not null,
  project_creation_run_id text not null,
  task_count integer not null default 0,
  released_by text not null default '',
  released_at timestamptz not null default now()
);

update hb.workflow_stages
   set notes = 'CNC-A/B work for each cycle, in its own CNC project (CNC21.26). Off until switched on with a start cycle; until then CNC work stays in the Fabrication project.'
 where stage_key = 'cnc' and notes like 'Not switched on yet%';

grant select, insert, update, delete on hb.cnc_projects, hb.cnc_work_releases to bowlus_app, bowlus_sync;
grant select on hb.cnc_projects, hb.cnc_work_releases to bowlus_readonly;
