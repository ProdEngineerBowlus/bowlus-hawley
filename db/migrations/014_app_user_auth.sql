create table if not exists core.app_users (
  app_user_id bigserial primary key,
  username text not null unique,
  display_name text,
  email text unique,
  worker_key text,
  worker_name text,
  worker_email text,
  role text not null default 'worker' check (role in ('worker', 'manager', 'admin')),
  active boolean not null default false,
  password_hash text,
  password_set_at timestamptz,
  temporary_password boolean not null default true,
  last_login_at timestamptz,
  failed_login_count integer not null default 0,
  locked_until timestamptz,
  source_system text not null default 'hawley_work_force',
  source_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists core.app_sessions (
  app_session_id bigserial primary key,
  session_token_hash text not null unique,
  app_user_id bigint not null references core.app_users(app_user_id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  ip_address text,
  user_agent text
);

create table if not exists core.app_auth_events (
  app_auth_event_id bigserial primary key,
  event_type text not null,
  app_user_id bigint references core.app_users(app_user_id) on delete set null,
  username text,
  worker_key text,
  role text,
  success boolean not null default false,
  reason text,
  ip_address text,
  user_agent text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_app_users_worker_key
  on core.app_users(worker_key);

create index if not exists idx_app_users_worker_email
  on core.app_users(lower(worker_email));

create index if not exists idx_app_sessions_user_active
  on core.app_sessions(app_user_id, expires_at)
  where revoked_at is null;

create index if not exists idx_app_auth_events_created
  on core.app_auth_events(created_at desc);

insert into core.app_users (
  username,
  display_name,
  email,
  worker_key,
  worker_name,
  worker_email,
  role,
  active,
  source_system,
  source_synced_at
)
select
  lower(nullif(worker_email, '')) as username,
  worker_name,
  lower(nullif(worker_email, '')) as email,
  'asana-' || trim(both '-' from regexp_replace(
    case
      when lower(nullif(worker_email, '')) like 'asana+%' then substring(lower(nullif(worker_email, '')) from 7)
      else lower(nullif(worker_email, ''))
    end,
    '[^a-z0-9]+',
    '-',
    'g'
  )) as worker_key,
  worker_name,
  lower(nullif(worker_email, '')) as worker_email,
  'worker',
  false,
  'hawley_work_force',
  source_synced_at
from (
  select distinct on (lower(nullif(worker_email, ''))) *
  from hb.work_force
  where actively_employed
    and nullif(worker_email, '') is not null
  order by lower(nullif(worker_email, '')), source_synced_at desc nulls last, worker_name
) workforce
on conflict (username) do update set
  display_name = excluded.display_name,
  email = excluded.email,
  worker_key = excluded.worker_key,
  worker_name = excluded.worker_name,
  worker_email = excluded.worker_email,
  source_system = excluded.source_system,
  source_synced_at = excluded.source_synced_at,
  updated_at = now();

grant select, insert, update on core.app_users to bowlus_app;
grant select, insert, update, delete on core.app_sessions to bowlus_app;
grant select, insert on core.app_auth_events to bowlus_app;
grant usage, select on sequence core.app_users_app_user_id_seq to bowlus_app;
grant usage, select on sequence core.app_sessions_app_session_id_seq to bowlus_app;
grant usage, select on sequence core.app_auth_events_app_auth_event_id_seq to bowlus_app;

grant select, insert, update, delete on core.app_users to bowlus_sync;
grant select, insert, update, delete on core.app_sessions to bowlus_sync;
grant select, insert, update, delete on core.app_auth_events to bowlus_sync;
grant usage, select on sequence core.app_users_app_user_id_seq to bowlus_sync;
grant usage, select on sequence core.app_sessions_app_session_id_seq to bowlus_sync;
grant usage, select on sequence core.app_auth_events_app_auth_event_id_seq to bowlus_sync;
