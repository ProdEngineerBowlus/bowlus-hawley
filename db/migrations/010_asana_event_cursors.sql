create table if not exists sync.asana_project_event_cursors (
  project_gid text primary key,
  project_name text,
  portfolio_gid text,
  portfolio_name text,
  sync_token text,
  initialized_at timestamptz,
  last_polled_at timestamptz,
  last_success_at timestamptz,
  last_event_at timestamptz,
  last_event_count integer not null default 0,
  last_changed_task_count integer not null default 0,
  needs_full_recrawl boolean not null default false,
  error_count integer not null default 0,
  last_error text,
  updated_at timestamptz not null default now()
);

create index if not exists idx_asana_event_cursors_last_success
  on sync.asana_project_event_cursors(last_success_at);

grant select, insert, update, delete on sync.asana_project_event_cursors to bowlus_sync;
grant select on sync.asana_project_event_cursors to bowlus_app, bowlus_readonly;
