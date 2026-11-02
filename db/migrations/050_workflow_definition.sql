-- Workflow definition (issue 49, step 1): the department stages and the gates between them, editable in
-- Admin > Releases instead of written in code. Seeded with today's behaviour, so nothing changes on deploy.
create table if not exists hb.workflow_stages (
  stage_key text primary key,
  name text not null,
  sort_order integer not null default 0,
  portfolio text not null default '' check (portfolio in ('', 'VIN', 'Frames', 'CNC', 'Fabrication')),
  project_scope text not null default 'cycle' check (project_scope in ('cycle', 'vin', 'none')),
  -- {cycle} -> "22.26", {vin} -> "337", {model} -> the VIN's model.
  project_name_pattern text not null default '',
  phases text[] not null default '{}'::text[],
  work_areas text[] not null default '{}'::text[],
  -- Work that becomes part of the VIN build: moved into the VIN project when the stage's gate passes.
  moves_to_vin boolean not null default false,
  active boolean not null default true,
  notes text not null default '',
  updated_by text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists hb.workflow_gates (
  gate_key text primary key,
  name text not null,
  from_stage text not null references hb.workflow_stages (stage_key),
  to_stage text not null references hb.workflow_stages (stage_key),
  scope text not null default 'vin' check (scope in ('vin', 'cycle', 'cycle_phase')),
  -- What must be true before Pass is allowed. More rules (cart contents verified, ...) come with the handoff engine.
  rule text not null default 'all_tasks_complete' check (rule in ('all_tasks_complete')),
  checklist text[] not null default '{}'::text[],
  pass_role text not null default 'admin' check (pass_role in ('admin')),
  active boolean not null default true,
  notes text not null default '',
  updated_by text not null default '',
  updated_at timestamptz not null default now()
);

insert into hb.workflow_stages (stage_key, name, sort_order, portfolio, project_scope, project_name_pattern, phases, work_areas, moves_to_vin, active, notes) values
  ('frames', 'Frames', 10, 'Frames', 'cycle', 'FR{cycle}', '{A1,A2}', '{Frame-A,Frame-B}', true, true, 'Phase A1/A2 are VIN work and move into the VIN project at the Frames gate; Frame-A/B work stays here. Pilot VINs only for now.'),
  ('cnc', 'CNC', 20, 'CNC', 'cycle', 'CNC{cycle}', '{}', '{CNC-A,CNC-B}', false, false, 'Not switched on yet: CNC work still goes out in the Fabrication project until testing is approved.'),
  ('fabrication', 'Fabrication', 30, 'Fabrication', 'cycle', 'F{cycle}', '{}', '{FAB-A,FAB-B}', false, true, 'Released in full each cycle.'),
  ('inventory', 'Inventory', 40, '', 'none', '', '{}', '{}', false, false, 'Cycle boxes to the Installation line (handoff engine, later).'),
  ('installation', 'Installation', 50, 'VIN', 'vin', '{vin} - {model}', '{B,C,D,E,F,G,H}', '{}', true, true, 'Phases B to H in the VIN project.'),
  ('soqs', 'SOQS', 60, 'VIN', 'vin', '{vin} - {model}', '{}', '{}', true, false, 'Service, Options, Q.C., Shipping. Contributes its own work to the VIN build.')
on conflict (stage_key) do nothing;

insert into hb.workflow_gates (gate_key, name, from_stage, to_stage, scope, rule, checklist, pass_role, active, notes) values
  ('frames', 'Frame to Installation', 'frames', 'installation', 'vin', 'all_tasks_complete', '{}', 'admin', true, 'Passing releases the next phase into the VIN project and moves the A1/A2 tasks there.')
on conflict (gate_key) do nothing;

-- Gate passes may now reference any defined gate.
alter table hb.vin_gates drop constraint if exists vin_gates_gate_check;

grant select, insert, update, delete on hb.workflow_stages, hb.workflow_gates to bowlus_app, bowlus_sync;
grant select on hb.workflow_stages, hb.workflow_gates to bowlus_readonly;
