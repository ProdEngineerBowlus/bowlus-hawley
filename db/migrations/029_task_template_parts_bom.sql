create table if not exists raw.airtable_cnc_sheets (
  record_id text primary key,
  fields_json jsonb not null,
  airtable_created_at timestamptz,
  modified_at timestamptz,
  source_table_name text,
  synced_at timestamptz not null default now()
);

create table if not exists hb.cnc_parts_master (
  part_record_id text primary key,
  part_number text,
  part_name text,
  quantity_on_sheet numeric(12, 4),
  total_count numeric(12, 4),
  retired boolean not null default false,
  material_name text,
  sheet_material_names text[] not null default '{}'::text[],
  model_type_record_ids text[] not null default '{}'::text[],
  component_names text[] not null default '{}'::text[],
  sub_component_record_ids text[] not null default '{}'::text[],
  installation_phase_record_ids text[] not null default '{}'::text[],
  cnc_sheet_record_ids text[] not null default '{}'::text[],
  task_record_ids text[] not null default '{}'::text[],
  engineering_change_record_ids text[] not null default '{}'::text[],
  frame_class_names text[] not null default '{}'::text[],
  fields_json jsonb not null default '{}'::jsonb,
  source_system text not null default 'airtable_cnc_parts_master',
  source_synced_at timestamptz,
  normalized_at timestamptz not null default now()
);

create table if not exists hb.cnc_sheets (
  sheet_record_id text primary key,
  sheet_name text,
  sheet_number numeric(12, 4),
  material_name text,
  sheet_dimensions text,
  sheet_cost numeric(12, 4),
  inventory_location text,
  gross_weight numeric(12, 4),
  average_price_per_part numeric(12, 4),
  frame_class_names text[] not null default '{}'::text[],
  model_type_names text[] not null default '{}'::text[],
  part_record_ids text[] not null default '{}'::text[],
  task_record_ids text[] not null default '{}'::text[],
  fields_json jsonb not null default '{}'::jsonb,
  source_system text not null default 'airtable_cnc_sheets',
  source_synced_at timestamptz,
  normalized_at timestamptz not null default now()
);

create table if not exists hb.task_template_part_links (
  task_record_id text not null,
  part_record_id text not null,
  link_sources text[] not null default '{}'::text[],
  source_synced_at timestamptz,
  normalized_at timestamptz not null default now(),
  primary key (task_record_id, part_record_id)
);

create table if not exists hb.task_template_cnc_sheet_links (
  task_record_id text not null,
  sheet_record_id text not null,
  link_sources text[] not null default '{}'::text[],
  source_synced_at timestamptz,
  normalized_at timestamptz not null default now(),
  primary key (task_record_id, sheet_record_id)
);

create table if not exists hb.task_template_materials (
  task_record_id text not null,
  material_name text not null,
  material_sources text[] not null default '{}'::text[],
  source_synced_at timestamptz,
  normalized_at timestamptz not null default now(),
  primary key (task_record_id, material_name)
);

create index if not exists idx_hb_cnc_parts_master_part_number
  on hb.cnc_parts_master(part_number);

create index if not exists idx_hb_task_template_part_links_part
  on hb.task_template_part_links(part_record_id);

create index if not exists idx_hb_task_template_cnc_sheet_links_sheet
  on hb.task_template_cnc_sheet_links(sheet_record_id);

create index if not exists idx_hb_task_template_materials_material
  on hb.task_template_materials(material_name);

create or replace view reporting.task_template_bom as
with part_summary as (
  select
    link.task_record_id,
    count(*)::integer as part_count,
    array_agg(part.part_number order by part.part_number) filter (where part.part_number is not null) as part_numbers,
    array_agg(part.part_name order by part.part_number) filter (where part.part_name is not null) as part_names
  from hb.task_template_part_links link
  left join hb.cnc_parts_master part on part.part_record_id = link.part_record_id
  group by link.task_record_id
), sheet_summary as (
  select
    link.task_record_id,
    count(*)::integer as sheet_count,
    array_agg(sheet.sheet_name order by sheet.sheet_name) filter (where sheet.sheet_name is not null) as sheet_names
  from hb.task_template_cnc_sheet_links link
  left join hb.cnc_sheets sheet on sheet.sheet_record_id = link.sheet_record_id
  group by link.task_record_id
), material_summary as (
  select
    task_record_id,
    count(*)::integer as material_count,
    array_agg(material_name order by material_name) as material_names
  from hb.task_template_materials
  group by task_record_id
)
select
  template.task_record_id,
  template.tasks_key,
  template.task_name,
  template.primary_phase_name,
  template.required_skill_level,
  coalesce(parts.part_count, 0) as part_count,
  coalesce(parts.part_numbers, '{}'::text[]) as part_numbers,
  coalesce(parts.part_names, '{}'::text[]) as part_names,
  coalesce(sheets.sheet_count, 0) as sheet_count,
  coalesce(sheets.sheet_names, '{}'::text[]) as sheet_names,
  coalesce(materials.material_count, 0) as material_count,
  coalesce(materials.material_names, '{}'::text[]) as material_names,
  template.source_synced_at,
  template.normalized_at
from hb.task_templates template
left join part_summary parts on parts.task_record_id = template.task_record_id
left join sheet_summary sheets on sheets.task_record_id = template.task_record_id
left join material_summary materials on materials.task_record_id = template.task_record_id;

grant select, insert, update, delete on raw.airtable_cnc_sheets to bowlus_sync;

grant select, insert, update, delete on
  hb.cnc_parts_master,
  hb.cnc_sheets,
  hb.task_template_part_links,
  hb.task_template_cnc_sheet_links,
  hb.task_template_materials
to bowlus_sync;

grant select on
  hb.cnc_parts_master,
  hb.cnc_sheets,
  hb.task_template_part_links,
  hb.task_template_cnc_sheet_links,
  hb.task_template_materials,
  reporting.task_template_bom
to bowlus_app, bowlus_readonly;
