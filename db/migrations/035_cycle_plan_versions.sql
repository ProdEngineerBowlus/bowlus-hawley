-- Published cycle calendar versions. Each publish records its inputs, the resulting cycles and a
-- snapshot of the year's hb.cycles rows before the change, so every calendar edit is traceable.
create table if not exists hb.cycle_plan_versions (
  cycle_plan_version_id text primary key,
  plan_year integer not null,
  plan_hash text not null,
  inputs_json jsonb not null,
  cycles_json jsonb not null,
  previous_cycles_json jsonb not null,
  changed_cycle_numbers integer[] not null default '{}'::integer[],
  note text not null default '',
  published_by text not null default '',
  published_at timestamptz not null default now()
);

create index if not exists cycle_plan_versions_year_idx
  on hb.cycle_plan_versions (plan_year, published_at desc);

-- Versions are append-only evidence: no update or delete grants.
grant select, insert on
  hb.cycle_plan_versions
to bowlus_app, bowlus_sync;

grant select on
  hb.cycle_plan_versions
to bowlus_readonly;
