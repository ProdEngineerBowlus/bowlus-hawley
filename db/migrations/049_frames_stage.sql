-- Frames stage (department layout pilot). A pilot VIN's Phase A1/A2 tasks are released into that cycle's Frames
-- project (FR22.26, one section per VIN) instead of the VIN project. When they are all complete an admin passes
-- the Frames gate: Hawley releases Phase B into the VIN project and moves the A1/A2 tasks there. Frame-A/B work
-- stays in Frames and is not moved.
alter table hb.phase_releases add column if not exists target text not null default 'vin' check (target in ('vin', 'frames'));

-- One Frames project per cycle, shared by every pilot VIN whose A1/A2 falls in that cycle.
create table if not exists hb.frames_projects (
  cycle_label text primary key,
  project_name text not null,
  asana_project_gid text,
  created_at timestamptz not null default now()
);

-- Gate passes between departments, per VIN. status: passing (in progress), passed, failed (retry allowed).
create table if not exists hb.vin_gates (
  vin text not null,
  gate text not null check (gate in ('frames')),
  status text not null default 'passing' check (status in ('passing', 'passed', 'failed')),
  passed_by text not null default '',
  passed_at timestamptz not null default now(),
  result jsonb not null default '{}'::jsonb,
  primary key (vin, gate)
);

grant select, insert, update, delete on hb.frames_projects, hb.vin_gates to bowlus_app, bowlus_sync;
grant select on hb.frames_projects, hb.vin_gates to bowlus_readonly;

-- Pilot VINs use the Frames stage (A1/A2 in Frames, gate before Phase B). Off returns a VIN to A1/A2 in its VIN project.
alter table hb.release_pilots add column if not exists frames_stage boolean not null default true;
