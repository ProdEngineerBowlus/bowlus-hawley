create schema if not exists ops;

create or replace function ops.jsonb_display_text(value jsonb)
returns text
language sql
immutable
as $$
  select case
    when value is null then null
    when jsonb_typeof(value) = 'array' then (
      select nullif(string_agg(
        coalesce(item->>'name', item->>'email', item->>'value', item->>'id', item #>> '{}'),
        ', '
        order by ordinality
      ), '')
      from jsonb_array_elements(value) with ordinality as items(item, ordinality)
    )
    when jsonb_typeof(value) = 'object' then
      coalesce(value->>'name', value->>'email', value->>'value', value->>'id', value::text)
    else value #>> '{}'
  end;
$$;

create table if not exists ops.work_area_aliases (
  work_area_key text primary key,
  display_name text not null,
  skill_level_field text,
  phase_names text[] not null default '{}'::text[],
  section_names text[] not null default '{}'::text[],
  task_keywords text[] not null default '{}'::text[],
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ops.manual_work_area_owner_hints (
  owner_hint_key text primary key,
  work_area_key text not null references ops.work_area_aliases(work_area_key),
  owner_person_name text,
  owner_person_email text,
  owner_role text not null default 'practical_anchor',
  confidence_label text not null default 'manual',
  source_label text not null default 'local_hawley_seed',
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into ops.work_area_aliases
  (work_area_key, display_name, skill_level_field, phase_names, section_names, task_keywords, notes)
values
  ('installation_b_h', 'Installation B-H', null, array['Phase B','Phase C','Phase D','Phase E','Phase F','Phase G','Phase H'], array['Phase B','Phase C','Phase D','Phase E','Phase F','Phase G','Phase H'], array['install','installation'], 'Operational installation span across Phase B through Phase H.'),
  ('frames_phase_a', 'Frames / Phase A', 'Frames SL', array['Phase A'], array['Frames','Phase A','Phase A Lower','Phase A Upper'], array['frame','frames'], 'Frames work and Phase A frame-adjacent scope.'),
  ('fab_1_3', 'FAB 1-3', 'FAB SL', array['FAB','Fabrication'], array['FAB','FAB 1','FAB 2','FAB 3','Fabrication'], array['fab','fabrication'], 'Fabrication support scope, especially FAB 1 through FAB 3.'),
  ('soqs', 'SOQS', null, array[]::text[], array['SOQS'], array['soqs','quality','sign off','sign-off'], 'Shop quality/sign-off style operational scope.'),
  ('inventory', 'Inventory', 'QC / Inventory SL', array[]::text[], array['Inventory','QC / Inventory'], array['inventory','parts','stock'], 'Inventory and QC/inventory support scope.'),
  ('cnc', 'CNC', 'CNC SL', array['CNC'], array['CNC'], array['cnc','router','machine'], 'CNC work center.'),
  ('management', 'Management', null, array[]::text[], array['Management'], array['management','review','approve','escalate'], 'Management and scheduling/escalation ownership.'),
  ('phase_a', 'Phase A', 'Phase A SL', array['Phase A','A'], array['Phase A','Phase A Lower','Phase A Upper','A'], array[]::text[], 'Declared Work Force capability for Phase A.'),
  ('phase_b', 'Phase B', 'Phase B SL', array['Phase B','B'], array['Phase B','B'], array[]::text[], 'Declared Work Force capability for Phase B.'),
  ('phase_c', 'Phase C', 'Phase C SL', array['Phase C','C'], array['Phase C','C'], array[]::text[], 'Declared Work Force capability for Phase C.'),
  ('phase_d', 'Phase D', 'Phase D SL', array['Phase D','D'], array['Phase D','D'], array[]::text[], 'Declared Work Force capability for Phase D.'),
  ('phase_e', 'Phase E', 'Phase E SL', array['Phase E','E'], array['Phase E','E'], array[]::text[], 'Declared Work Force capability for Phase E.'),
  ('phase_f', 'Phase F', 'Phase F SL', array['Phase F','F'], array['Phase F','F'], array[]::text[], 'Declared Work Force capability for Phase F.'),
  ('phase_g', 'Phase G', 'Phase G SL', array['Phase G','G'], array['Phase G','G'], array[]::text[], 'Declared Work Force capability for Phase G.'),
  ('phase_h', 'Phase H', 'Phase H SL', array['Phase H','H'], array['Phase H','H'], array[]::text[], 'Declared Work Force capability for Phase H.')
on conflict (work_area_key) do update set
  display_name = excluded.display_name,
  skill_level_field = excluded.skill_level_field,
  phase_names = excluded.phase_names,
  section_names = excluded.section_names,
  task_keywords = excluded.task_keywords,
  notes = excluded.notes,
  active = true,
  updated_at = now();

grant usage on schema ops to bowlus_sync, bowlus_app, bowlus_readonly;
grant execute on function ops.jsonb_display_text(jsonb) to bowlus_sync, bowlus_app, bowlus_readonly;

grant select, insert, update, delete on ops.work_area_aliases to bowlus_sync;
grant select, insert, update, delete on ops.manual_work_area_owner_hints to bowlus_sync;
grant usage, select, update on all sequences in schema ops to bowlus_sync;

grant select on ops.work_area_aliases to bowlus_app, bowlus_readonly;
grant select on ops.manual_work_area_owner_hints to bowlus_app, bowlus_readonly;
