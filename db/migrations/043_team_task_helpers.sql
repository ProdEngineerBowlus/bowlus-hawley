-- Team tasks: one Asana task (one assignee, chosen by the lead) plus a "Helpers" People field. Helpers see
-- the task on their worker page and log their own time; only the assignee completes it. A trial list
-- limits who sees helper tasks until the feature is enabled for everyone.
create table if not exists hb.team_task_settings (
  settings_key text primary key default 'default' check (settings_key = 'default'),
  helpers_field_gid text,
  trial_worker_emails text[] not null default '{}'::text[],
  enabled_for_all boolean not null default false,
  updated_by text not null default '',
  updated_at timestamptz not null default now()
);
insert into hb.team_task_settings (settings_key) values ('default') on conflict (settings_key) do nothing;

-- Synced from the Asana Helpers field by every HB rebuild.
create table if not exists hb.task_helpers (
  asana_task_gid text not null,
  helper_email text not null,
  helper_name text,
  helper_asana_gid text,
  synced_at timestamptz not null default now(),
  primary key (asana_task_gid, helper_email)
);

grant select, insert, update, delete on hb.team_task_settings, hb.task_helpers to bowlus_app, bowlus_sync;
grant select on hb.team_task_settings, hb.task_helpers to bowlus_readonly;
