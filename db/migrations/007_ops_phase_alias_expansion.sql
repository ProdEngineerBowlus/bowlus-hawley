insert into ops.work_area_aliases
  (work_area_key, display_name, skill_level_field, phase_names, section_names, task_keywords, notes)
values
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
