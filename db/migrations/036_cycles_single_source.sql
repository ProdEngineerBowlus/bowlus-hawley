-- hb.cycles is the single source of cycle dates. The cycle generator publishes into it, and the
-- production schedule's copied cycle dates follow it automatically, whoever changes a cycle.

create or replace function hb.sync_production_schedule_cycle_dates()
returns trigger
language plpgsql
as $$
begin
  update hb.production_schedule
     set start_date = new.start_date,
         end_date = new.end_date,
         days_in_cycle = new.days_in_cycle,
         normalized_at = now()
   where cycle_record_id = new.cycle_record_id
     and (start_date is distinct from new.start_date
          or end_date is distinct from new.end_date
          or days_in_cycle is distinct from new.days_in_cycle);
  return null;
end;
$$;

drop trigger if exists cycles_sync_production_schedule_dates on hb.cycles;
create trigger cycles_sync_production_schedule_dates
  after update of start_date, end_date, days_in_cycle on hb.cycles
  for each row
  when (old.start_date is distinct from new.start_date
        or old.end_date is distinct from new.end_date
        or old.days_in_cycle is distinct from new.days_in_cycle)
  execute function hb.sync_production_schedule_cycle_dates();

-- One-time alignment: on 2026-10-29 all linked schedule dates already matched hb.cycles, but 48 rows
-- (C19-C22) still carried older day counts, which Project Creator copies into Asana "Days in Cycle".
update hb.production_schedule ps
   set start_date = c.start_date,
       end_date = c.end_date,
       days_in_cycle = c.days_in_cycle,
       normalized_at = now()
  from hb.cycles c
 where c.cycle_record_id = ps.cycle_record_id
   and (ps.start_date is distinct from c.start_date
        or ps.end_date is distinct from c.end_date
        or ps.days_in_cycle is distinct from c.days_in_cycle);

-- Baseline: record the cycles already in Hawley as the generator's starting version for each year,
-- so cycle history starts from the current table. Reads only; no cycle or schedule row changes.
insert into hb.cycle_plan_versions (
  cycle_plan_version_id, plan_year, plan_hash, inputs_json, cycles_json, previous_cycles_json,
  changed_cycle_numbers, note, published_by
)
select
  'cycle-plan:baseline-' || years.plan_year,
  years.plan_year,
  'baseline',
  jsonb_build_object('source', 'hb.cycles', 'reason', 'Baseline of existing cycles before Hawley cycle generator publishing'),
  years.cycles,
  years.cycles,
  '{}'::integer[],
  'Baseline of existing hb.cycles rows (imported from Airtable). No dates changed.',
  'migration 036'
from (
  select extract(year from start_date)::int as plan_year,
         jsonb_agg(jsonb_build_object(
           'cycle_record_id', cycle_record_id,
           'cycle_number', cycle_number,
           'cycle_label', cycle_label,
           'start_date', start_date,
           'end_date', end_date,
           'days_in_cycle', days_in_cycle,
           'quarter', quarter,
           'holidays', holidays,
           'source_system', source_system
         ) order by start_date, cycle_number) as cycles
    from hb.cycles
   where cycle_number is not null and start_date is not null
   group by 1
) years
on conflict (cycle_plan_version_id) do nothing;
