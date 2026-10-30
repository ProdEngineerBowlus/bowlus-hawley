-- Task template system, ramp step 1 (no visible change). Hawley owns versioned task definitions and one
-- work occurrence per definition x VIN (or schedule row for VIN-less FAB/Frame/CNC work). Time and
-- completion attach to the occurrence; its cycle can change without changing its identity.
-- Existing template IDs (Airtable record IDs, = tasks_key) become definition IDs so current links keep working.

-- HB rebuilds update hb.rev1_task_instances; take their gate before any table lock.
select pg_advisory_xact_lock(1212241740, 1212301892);

create table if not exists hb.task_definitions (
  task_definition_id text primary key,
  retired_from_year integer,
  retired_from_cycle integer,
  created_by text not null default '',
  created_at timestamptz not null default now()
);

-- A version applies from its effective cycle onward (null = from the beginning). Released work keeps the
-- version it was released with, so later edits never rewrite history.
create table if not exists hb.task_definition_versions (
  task_definition_id text not null references hb.task_definitions,
  version_number integer not null,
  effective_from_year integer,
  effective_from_cycle integer,
  task_name text not null,
  phase_record_id text,
  phase_name text,
  model_type_record_ids text[] not null default '{}'::text[],
  estimated_task_time_seconds integer,
  estimated_batch_task_time_seconds integer,
  quantity numeric(12, 4),
  task_order numeric(12, 2),
  sop_link text,
  attachment_files_json jsonb not null default '[]'::jsonb,
  task_description text,
  definition_json jsonb not null default '{}'::jsonb,
  note text not null default '',
  created_by text not null default '',
  created_at timestamptz not null default now(),
  primary key (task_definition_id, version_number)
);

create table if not exists hb.work_occurrences (
  occurrence_id text primary key,
  task_definition_id text not null references hb.task_definitions,
  version_number integer not null,
  subject_kind text not null check (subject_kind in ('vin', 'batch')),
  subject_key text not null,
  occurrence_number integer not null default 1 check (occurrence_number > 0),
  production_record_id text,
  cycle_record_id text,
  status text not null default 'released' check (status in ('planned', 'released', 'completed', 'cancelled')),
  released_at timestamptz,
  source text not null,
  created_at timestamptz not null default now(),
  unique (task_definition_id, subject_kind, subject_key, occurrence_number),
  foreign key (task_definition_id, version_number) references hb.task_definition_versions
);

create index if not exists work_occurrences_subject_idx on hb.work_occurrences (subject_kind, subject_key);
create index if not exists work_occurrences_cycle_idx on hb.work_occurrences (cycle_record_id);

alter table hb.rev1_task_instances add column if not exists occurrence_id text;
create index if not exists rev1_task_instances_occurrence_idx on hb.rev1_task_instances (occurrence_id);

-- Version 1 of every existing template.
insert into hb.task_definitions (task_definition_id, created_by)
select tt.task_record_id, 'migration 039'
  from hb.task_templates tt
 where tt.task_record_id is not null
on conflict (task_definition_id) do nothing;

insert into hb.task_definition_versions (
  task_definition_id, version_number, task_name, phase_record_id, phase_name, model_type_record_ids,
  estimated_task_time_seconds, estimated_batch_task_time_seconds, quantity, task_order, sop_link,
  attachment_files_json, task_description, definition_json, note, created_by
)
select tt.task_record_id, 1, coalesce(nullif(tt.task_name, ''), tt.task_record_id), tt.primary_phase_record_id, tt.primary_phase_name,
       coalesce(tt.model_type_record_ids, '{}'::text[]), tt.estimated_task_time_seconds, tt.estimated_batch_task_time_seconds,
       tt.quantity, tt.task_order, nullif(tt.document_link, ''), coalesce(tt.attachment_files_json, '[]'::jsonb), tt.task_description,
       to_jsonb(tt) - 'fields_json', 'Imported from the existing template', 'migration 039'
  from hb.task_templates tt
 where tt.task_record_id is not null
on conflict (task_definition_id, version_number) do nothing;

-- Existing tasks become occurrences: VIN tasks by definition + VIN, VIN-less tasks by their schedule row.
-- Repeats of the same definition on one subject are numbered in task order. Tasks with no matching
-- definition or subject stay unmapped for the step 2 review.
with candidates as (
  select t.rev1_task_instance_id,
         t.tasks_key as task_definition_id,
         case when t.vin is not null then 'vin' else 'batch' end as subject_kind,
         case when t.vin is not null then t.vin::text else t.line_schedule_record_id end as subject_key,
         t.line_schedule_record_id,
         t.cycle_record_id,
         coalesce(t.task_completed, false) as completed
    from hb.rev1_task_instances t
    join hb.task_definitions d on d.task_definition_id = t.tasks_key
   where t.occurrence_id is null
     and (t.vin is not null or t.line_schedule_record_id is not null)
), numbered as (
  select c.*,
         row_number() over (partition by c.task_definition_id, c.subject_kind, c.subject_key order by c.rev1_task_instance_id) as occurrence_number
    from candidates c
), keyed as (
  select n.*, 'occ:' || n.task_definition_id || ':' || n.subject_kind || ':' || n.subject_key || ':' || n.occurrence_number as occurrence_id
    from numbered n
), inserted as (
  insert into hb.work_occurrences (occurrence_id, task_definition_id, version_number, subject_kind, subject_key, occurrence_number,
                                   production_record_id, cycle_record_id, status, released_at, source)
  select k.occurrence_id, k.task_definition_id, 1, k.subject_kind, k.subject_key, k.occurrence_number,
         k.line_schedule_record_id, k.cycle_record_id, case when k.completed then 'completed' else 'released' end, now(), 'migration 039: existing task'
    from keyed k
  on conflict (occurrence_id) do nothing
  returning occurrence_id
)
update hb.rev1_task_instances t
   set occurrence_id = k.occurrence_id
  from keyed k
 where t.rev1_task_instance_id = k.rev1_task_instance_id;

grant select, insert, update on hb.task_definitions, hb.task_definition_versions, hb.work_occurrences to bowlus_app, bowlus_sync;
grant select on hb.task_definitions, hb.task_definition_versions, hb.work_occurrences to bowlus_readonly;
