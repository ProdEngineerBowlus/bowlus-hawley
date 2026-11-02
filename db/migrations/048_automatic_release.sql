-- Automatic releases. Pilot VIN phases and each cycle's Fabrication project (F21.26, ...) can be released to Asana
-- automatically on their due date: a set number of working days before the cycle starts. Both are off until an
-- admin turns them on in Admin > Releases.
create table if not exists hb.release_settings (
  settings_key text primary key default 'default' check (settings_key = 'default'),
  auto_vin_phases boolean not null default false,
  auto_fabrication boolean not null default false,
  fabrication_lead_working_days integer not null default 2 check (fabrication_lead_working_days between 0 and 20),
  updated_by text not null default '',
  updated_at timestamptz not null default now()
);
insert into hb.release_settings (settings_key) values ('default') on conflict (settings_key) do nothing;

-- One row per Fabrication cycle project released from Hawley. The Project Creator run holds links and status.
create table if not exists hb.fabrication_releases (
  cycle_key text primary key,
  cycle_label text,
  project_name text not null,
  project_creation_run_id text not null,
  task_count integer not null default 0,
  released_by text not null default '',
  released_at timestamptz not null default now()
);

grant select, insert, update, delete on hb.release_settings, hb.fabrication_releases to bowlus_app, bowlus_sync;
grant select on hb.release_settings, hb.fabrication_releases to bowlus_readonly;
