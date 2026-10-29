-- User-approved correction (2026-10-29): C19 2026 ran 12 working days, Oct 8 - Oct 23, matching
-- Airtable's Days In Cycle and the task completion evidence (117 tasks finished Oct 21-23). C19 is a
-- past cycle, so the Cycles tab cannot change it; this records the correction as a plan version.
-- The cycles_sync_production_schedule_dates trigger updates the linked schedule rows.
select pg_advisory_xact_lock(1212241740, 1212301892);

insert into hb.cycle_plan_versions (
  cycle_plan_version_id, plan_year, plan_hash, inputs_json, cycles_json, previous_cycles_json,
  changed_cycle_numbers, note, published_by
)
select
  'cycle-plan:correction-2026-c19-12-days',
  2026,
  'manual-correction',
  jsonb_build_object('source', 'manual correction', 'cycle', 19, 'endDate', '2026-10-23', 'days', 12),
  jsonb_build_array(to_jsonb(c) || jsonb_build_object('end_date', '2026-10-23', 'days_in_cycle', 12)),
  jsonb_build_array(to_jsonb(c)),
  '{19}'::integer[],
  'C19 2026 corrected from Oct 8-20 (9 days) to Oct 8-23 (12 days) to match Airtable and completed work.',
  'migration 037'
from hb.cycles c
where c.cycle_record_id = 'recIzaAy6PcgB1woG'
  and c.end_date = '2026-10-20'
on conflict (cycle_plan_version_id) do nothing;

update hb.cycles
   set end_date = '2026-10-23',
       days_in_cycle = 12,
       source_system = 'hawley_cycle_correction',
       normalized_at = now()
 where cycle_record_id = 'recIzaAy6PcgB1woG'
   and end_date = '2026-10-20';
