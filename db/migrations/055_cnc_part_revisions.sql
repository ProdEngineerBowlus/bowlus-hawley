-- CNC part version tracking, owned by Hawley (never rebuilt from Airtable). A part is a base number (01201); each
-- revision is a letter (A, B, …) whose part number is base || revision (01201B). A released revision applies from
-- its effective VIN on: the revision in effect for a VIN is the released/superseded one with the highest
-- effective_from_vin <= that VIN (null = from the first build). Every insert/update/delete is logged by trigger, so
-- history is complete whichever editor writes here (NocoDB, an Admin page, or a script). Set
-- `set local hawley.actor = '<email>'` in the writing transaction to record who; otherwise the database user is used.
create schema if not exists parts;

create table if not exists parts.cnc_parts (
  part_base text primary key,
  part_name text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists parts.cnc_part_revisions (
  revision_id bigserial primary key,
  part_base text not null references parts.cnc_parts(part_base) on update cascade,
  revision text not null default '',
  part_number text generated always as (part_base || revision) stored,
  status text not null default 'draft' check (status in ('draft', 'released', 'superseded', 'retired')),
  effective_from_vin integer check (effective_from_vin > 0),
  part_name text not null default '',
  material_name text,
  quantity_on_sheet numeric(12, 4),
  cnc_sheet_record_ids text[] not null default '{}'::text[],
  change_reason text not null default '',
  engineering_change_ref text not null default '',
  airtable_record_ids text[] not null default '{}'::text[],
  released_at timestamptz,
  released_by text not null default '',
  created_at timestamptz not null default now(),
  created_by text not null default '',
  updated_at timestamptz not null default now(),
  unique (part_base, revision)
);

create index if not exists idx_parts_cnc_part_revisions_part_number on parts.cnc_part_revisions(part_number);

create table if not exists parts.cnc_part_history (
  history_id bigserial primary key,
  table_name text not null,
  row_key text not null,
  operation text not null check (operation in ('insert', 'update', 'delete')),
  changed_fields text[] not null default '{}'::text[],
  old_row jsonb,
  new_row jsonb,
  changed_by text not null,
  changed_at timestamptz not null default now()
);

create index if not exists idx_parts_cnc_part_history_row on parts.cnc_part_history(table_name, row_key, changed_at);

create or replace function parts.log_cnc_part_change() returns trigger language plpgsql as $$
declare
  old_json jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  new_json jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  changed text[];
begin
  if tg_op = 'UPDATE' then
    select coalesce(array_agg(key order by key), '{}') into changed
      from jsonb_each(new_json) n
     where key <> 'updated_at' and n.value is distinct from old_json -> key;
    if cardinality(changed) = 0 then
      return null;
    end if;
  end if;
  insert into parts.cnc_part_history (table_name, row_key, operation, changed_fields, old_row, new_row, changed_by)
  values (
    tg_table_name,
    coalesce(new_json, old_json) ->> case tg_table_name when 'cnc_parts' then 'part_base' else 'revision_id' end,
    lower(tg_op),
    coalesce(changed, '{}'),
    old_json,
    new_json,
    coalesce(nullif(current_setting('hawley.actor', true), ''), current_user)
  );
  return null;
end $$;

create or replace function parts.touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists cnc_parts_touch on parts.cnc_parts;
create trigger cnc_parts_touch before update on parts.cnc_parts for each row execute function parts.touch_updated_at();
drop trigger if exists cnc_part_revisions_touch on parts.cnc_part_revisions;
create trigger cnc_part_revisions_touch before update on parts.cnc_part_revisions for each row execute function parts.touch_updated_at();
drop trigger if exists cnc_parts_history on parts.cnc_parts;
create trigger cnc_parts_history after insert or update or delete on parts.cnc_parts for each row execute function parts.log_cnc_part_change();
drop trigger if exists cnc_part_revisions_history on parts.cnc_part_revisions;
create trigger cnc_part_revisions_history after insert or update or delete on parts.cnc_part_revisions for each row execute function parts.log_cnc_part_change();

-- The revision of every part in effect for a given VIN.
create or replace function parts.cnc_revisions_for_vin(target_vin integer)
returns setof parts.cnc_part_revisions language sql stable as $$
  select distinct on (r.part_base) r.*
    from parts.cnc_part_revisions r
   where r.status in ('released', 'superseded')
     and coalesce(r.effective_from_vin, 0) <= target_vin
   order by r.part_base, coalesce(r.effective_from_vin, 0) desc, r.revision desc
$$;

-- Current revision per part: the released one with the latest effectivity.
create or replace view parts.cnc_parts_current as
select distinct on (p.part_base)
  p.part_base,
  coalesce(nullif(r.part_name, ''), p.part_name) as part_name,
  r.revision,
  r.part_number,
  r.effective_from_vin,
  r.material_name,
  r.quantity_on_sheet,
  r.released_at,
  r.released_by,
  (select count(*) from parts.cnc_part_revisions all_r where all_r.part_base = p.part_base) as revision_count
from parts.cnc_parts p
left join parts.cnc_part_revisions r on r.part_base = p.part_base and r.status = 'released'
order by p.part_base, coalesce(r.effective_from_vin, 0) desc, r.revision desc;

-- One-time seed from the Airtable mirror (only when the schema is empty). Part numbers ending in a letter after a
-- digit split into base + revision (01201B -> 01201, B); others (DT1A, H9A, …) become a base with an empty revision.
-- Records sharing a part number collapse into one revision that keeps all their Airtable record ids. The highest
-- non-retired letter of each base is released; lower letters are superseded; retired records stay retired.
-- Effectivity is unknown from Airtable, so seeded revisions apply from the first build (null).
do $$
begin
  if to_regclass('hb.cnc_parts_master') is null or exists (select 1 from parts.cnc_parts) then
    return;
  end if;
  perform set_config('hawley.actor', 'migration 055 seed from Airtable', true);

  create temporary table seed_revisions on commit drop as
  select
    case when part_number ~ '^[0-9]+[A-Z]$' then left(part_number, -1) else part_number end as part_base,
    case when part_number ~ '^[0-9]+[A-Z]$' then right(part_number, 1) else '' end as revision,
    bool_and(retired) as retired,
    (array_agg(part_name order by part_record_id) filter (where coalesce(part_name, '') <> ''))[1] as part_name,
    (array_agg(material_name order by part_record_id) filter (where material_name is not null))[1] as material_name,
    (array_agg(quantity_on_sheet order by part_record_id) filter (where quantity_on_sheet is not null))[1] as quantity_on_sheet,
    coalesce(array_agg(distinct sheet_id) filter (where sheet_id is not null), '{}') as cnc_sheet_record_ids,
    array_agg(distinct part_record_id order by part_record_id) as airtable_record_ids
  from hb.cnc_parts_master
  left join lateral unnest(cnc_sheet_record_ids) as sheet_id on true
  where coalesce(part_number, '') <> ''
  group by 1, 2;

  insert into parts.cnc_parts (part_base, part_name)
  select part_base, coalesce((array_agg(part_name order by revision desc) filter (where part_name is not null))[1], '')
    from seed_revisions group by part_base;

  insert into parts.cnc_part_revisions (
    part_base, revision, status, part_name, material_name, quantity_on_sheet, cnc_sheet_record_ids,
    airtable_record_ids, change_reason, released_by, created_by)
  select
    s.part_base, s.revision,
    case
      when s.retired then 'retired'
      when s.revision = max(s.revision) filter (where not s.retired) over (partition by s.part_base) then 'released'
      else 'superseded'
    end,
    coalesce(s.part_name, ''), s.material_name, s.quantity_on_sheet, s.cnc_sheet_record_ids,
    s.airtable_record_ids, 'Imported from Airtable CNC Parts Master', 'airtable import', 'airtable import'
  from seed_revisions s;
end $$;

grant usage on schema parts to bowlus_app, bowlus_sync, bowlus_readonly;
grant select, insert, update, delete on parts.cnc_parts, parts.cnc_part_revisions to bowlus_app, bowlus_sync;
grant select, insert on parts.cnc_part_history to bowlus_app, bowlus_sync;
grant usage, select on sequence parts.cnc_part_revisions_revision_id_seq, parts.cnc_part_history_history_id_seq to bowlus_app, bowlus_sync;
grant select on parts.cnc_parts, parts.cnc_part_revisions, parts.cnc_part_history, parts.cnc_parts_current to bowlus_readonly;
grant execute on function parts.cnc_revisions_for_vin(integer) to bowlus_app, bowlus_sync, bowlus_readonly;

-- NocoDB (read-only for now) sees the new schema when its user exists.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'nocodb_reader') then
    grant usage on schema parts to nocodb_reader;
    grant select on parts.cnc_parts, parts.cnc_part_revisions, parts.cnc_part_history, parts.cnc_parts_current to nocodb_reader;
  end if;
end $$;
