-- Phase-by-phase release pilot (ramp step 4). A pilot VIN gets its Asana project with Phase A1 only; each next
-- phase is released into the same project a few working days before that phase's cycle starts. Releases are
-- manual ("Release now") during the pilot. Fabrication cycle projects are not part of this: they stay full copies.
create table if not exists hb.release_pilots (
  vin text primary key,
  lead_working_days integer not null default 2 check (lead_working_days between 0 and 20),
  asana_project_gid text,
  enrolled_by text not null default '',
  enrolled_at timestamptz not null default now()
);

-- One row per released phase. The Project Creator run holds the task links and status.
create table if not exists hb.phase_releases (
  vin text not null references hb.release_pilots (vin) on delete cascade,
  phase_name text not null,
  production_record_id text,
  cycle_label text,
  project_creation_run_id text not null,
  task_count integer not null default 0,
  released_by text not null default '',
  released_at timestamptz not null default now(),
  primary key (vin, phase_name)
);

grant select, insert, update, delete on hb.release_pilots, hb.phase_releases to bowlus_app, bowlus_sync;
grant select on hb.release_pilots, hb.phase_releases to bowlus_readonly;
