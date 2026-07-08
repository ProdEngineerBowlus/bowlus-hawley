create or replace view reporting.hawley_cycle_calendar as
select
  nullif(regexp_replace(coalesce(fields_json->>'Cycle Number', ''), '[^0-9]+', '', 'g'), '')::int as cycle_number,
  case
    when nullif(regexp_replace(coalesce(fields_json->>'Cycle Number', ''), '[^0-9]+', '', 'g'), '') is null then ''
    else 'C' || nullif(regexp_replace(coalesce(fields_json->>'Cycle Number', ''), '[^0-9]+', '', 'g'), '')
  end as cycle_label,
  case
    when coalesce(fields_json->>'Start Date', '') ~ '^\d{4}-\d{2}-\d{2}$' then (fields_json->>'Start Date')::date
    else null
  end as start_date,
  case
    when coalesce(fields_json->>'End Date', '') ~ '^\d{4}-\d{2}-\d{2}$' then (fields_json->>'End Date')::date
    else null
  end as end_date,
  nullif(regexp_replace(coalesce(fields_json->>'Days In Cycle', ''), '[^0-9]+', '', 'g'), '')::int as days_in_cycle,
  fields_json->'Holidays' as holidays,
  synced_at
from raw.airtable_cycles
where nullif(regexp_replace(coalesce(fields_json->>'Cycle Number', ''), '[^0-9]+', '', 'g'), '') is not null;
