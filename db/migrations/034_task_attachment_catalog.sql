create table if not exists core.task_attachment_catalog (
  task_record_id text primary key,
  source_base_id text not null,
  source_table_id text not null,
  source_field_id text not null,
  source_snapshot text not null,
  attachment_files jsonb not null check (jsonb_typeof(attachment_files) = 'array'),
  imported_at timestamptz not null default now()
);
comment on table core.task_attachment_catalog is
  'Verified permanent attachment object references. Empty arrays explicitly certify tasks without attachments. No signed URLs or credentials.';
grant select on core.task_attachment_catalog to bowlus_app, bowlus_readonly;
grant select, insert, update on core.task_attachment_catalog to bowlus_sync;
