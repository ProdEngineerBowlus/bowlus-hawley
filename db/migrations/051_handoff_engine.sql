-- Handoff engine (issue 49, step 2). A handoff is a physical container moving between departments (CNC cart,
-- Phase cart, Cycle box, Frame) with an expected list of contents. It is packed at the source, delivered, and
-- received at the destination; receiving is the gate. Every step is recorded, so cannibalised carts, remakes and
-- missing parts become visible. Types start off; lines are entered by hand until contents sources arrive (step 3).
create table if not exists hb.handoff_types (
  type_key text primary key,
  name text not null,
  from_stage text not null references hb.workflow_stages (stage_key),
  to_stage text not null references hb.workflow_stages (stage_key),
  scope text not null default 'cycle' check (scope in ('cycle', 'cycle_phase', 'vin')),
  -- Where the expected contents come from. manual = typed in; the others are generated in later steps.
  contents_source text not null default 'manual' check (contents_source in ('manual', 'cnc_parts', 'phase_parts', 'purchased')),
  checklist text[] not null default '{}'::text[],
  active boolean not null default false,
  notes text not null default '',
  updated_by text not null default '',
  updated_at timestamptz not null default now()
);

insert into hb.handoff_types (type_key, name, from_stage, to_stage, scope, contents_source, notes) values
  ('cnc_cart', 'CNC cart', 'cnc', 'fabrication', 'cycle', 'cnc_parts', 'CNC parts for the cycle, rolled to Fabrication to bend and work.'),
  ('phase_cart', 'Phase cart', 'fabrication', 'installation', 'cycle_phase', 'phase_parts', 'Worked parts for one phase, delivered to the Installation line.'),
  ('cycle_box', 'Cycle box', 'inventory', 'installation', 'cycle', 'purchased', 'Purchased components, adhesives and fasteners for the cycle.'),
  ('frame', 'Frame', 'frames', 'installation', 'vin', 'manual', 'A finished frame delivered to the Installation line (today handled by the Frames gate).')
on conflict (type_key) do nothing;

create table if not exists hb.handoffs (
  handoff_id bigserial primary key,
  type_key text not null references hb.handoff_types (type_key),
  cycle_label text not null default '',
  phase text not null default '',
  vin text not null default '',
  label text not null,
  status text not null default 'open' check (status in ('open', 'packing', 'delivered', 'received', 'short')),
  checklist_done text[] not null default '{}'::text[],
  notes text not null default '',
  created_by text not null default '',
  created_at timestamptz not null default now(),
  delivered_by text not null default '',
  delivered_at timestamptz,
  received_by text not null default '',
  received_at timestamptz,
  unique (type_key, cycle_label, phase, vin, label)
);
create index if not exists handoffs_cycle_idx on hb.handoffs (cycle_label, type_key);

create table if not exists hb.handoff_lines (
  line_id bigserial primary key,
  handoff_id bigint not null references hb.handoffs (handoff_id) on delete cascade,
  sort_order integer not null default 0,
  item_key text not null default '',
  item_name text not null,
  expected_qty numeric(12, 2) not null default 1 check (expected_qty >= 0),
  packed_qty numeric(12, 2),
  packed_by text not null default '',
  packed_at timestamptz,
  received_qty numeric(12, 2),
  received_by text not null default '',
  received_at timestamptz,
  issue text not null default '' check (issue in ('', 'missing', 'damaged', 'wrong', 'remake', 'taken')),
  issue_note text not null default ''
);
create index if not exists handoff_lines_handoff_idx on hb.handoff_lines (handoff_id, sort_order);

create table if not exists hb.handoff_events (
  event_id bigserial primary key,
  handoff_id bigint not null references hb.handoffs (handoff_id) on delete cascade,
  event text not null,
  actor text not null default '',
  at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb
);
create index if not exists handoff_events_handoff_idx on hb.handoff_events (handoff_id, at);

grant select, insert, update, delete on hb.handoff_types, hb.handoffs, hb.handoff_lines, hb.handoff_events to bowlus_app, bowlus_sync;
grant usage, select, update on sequence hb.handoffs_handoff_id_seq, hb.handoff_lines_line_id_seq, hb.handoff_events_event_id_seq to bowlus_app, bowlus_sync;
grant select on hb.handoff_types, hb.handoffs, hb.handoff_lines, hb.handoff_events to bowlus_readonly;
