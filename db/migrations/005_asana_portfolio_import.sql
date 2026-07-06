create table if not exists raw.asana_portfolios (
  gid text primary key,
  name text,
  workspace_gid text,
  workspace_name text,
  raw_json jsonb not null,
  synced_at timestamptz not null default now()
);

create table if not exists raw.asana_portfolio_projects (
  portfolio_gid text not null,
  project_gid text not null,
  portfolio_name text,
  project_name text,
  task_type text,
  raw_json jsonb not null,
  synced_at timestamptz not null default now(),
  primary key (portfolio_gid, project_gid)
);

alter table raw.asana_projects
  add column if not exists created_at timestamptz,
  add column if not exists workspace_gid text,
  add column if not exists workspace_name text,
  add column if not exists permalink_url text;

alter table raw.asana_tasks
  add column if not exists assignee_email text,
  add column if not exists created_at timestamptz,
  add column if not exists start_on date,
  add column if not exists start_at timestamptz,
  add column if not exists due_at timestamptz,
  add column if not exists permalink_url text,
  add column if not exists num_subtasks integer;

create table if not exists raw.asana_task_project_memberships (
  task_gid text not null,
  project_gid text not null,
  section_gid text not null default '',
  section_name text,
  is_source_project boolean not null default false,
  raw_json jsonb not null,
  synced_at timestamptz not null default now(),
  primary key (task_gid, project_gid, section_gid)
);

create index if not exists idx_asana_portfolio_projects_project
  on raw.asana_portfolio_projects (project_gid);

create index if not exists idx_asana_tasks_project_gid
  on raw.asana_tasks (project_gid);

create index if not exists idx_asana_tasks_parent_gid
  on raw.asana_tasks (parent_gid);

create index if not exists idx_asana_task_memberships_project
  on raw.asana_task_project_memberships (project_gid);

grant select, insert, update, delete on raw.asana_portfolios to bowlus_sync;
grant select, insert, update, delete on raw.asana_portfolio_projects to bowlus_sync;
grant select, insert, update, delete on raw.asana_projects to bowlus_sync;
grant select, insert, update, delete on raw.asana_tasks to bowlus_sync;
grant select, insert, update, delete on raw.asana_task_project_memberships to bowlus_sync;
