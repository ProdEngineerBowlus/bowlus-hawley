create table if not exists hb.phase_cycle_pace_overrides (
  phase_cycle_pace_override_id text primary key,
  cycle_number integer not null,
  cycle_label text,
  phase_label text not null,
  phase_label_key text not null,
  true_start_date date not null,
  note text,
  active boolean not null default true,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_hb_phase_cycle_pace_override unique (cycle_number, phase_label_key)
);

create index if not exists idx_hb_phase_cycle_pace_overrides_cycle
  on hb.phase_cycle_pace_overrides(cycle_number, active);

grant select, insert, update, delete on
  hb.phase_cycle_pace_overrides
to bowlus_app, bowlus_sync;

grant select on
  hb.phase_cycle_pace_overrides
to bowlus_readonly;
