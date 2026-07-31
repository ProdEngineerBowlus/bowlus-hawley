-- Hawley is the operational source for live task time.  Airtable retains the
-- Task Instances Rev1 history and remains the planning surface; this state
-- table only records successful, idempotent time/average writebacks.

create table if not exists sync.airtable_task_time_writeback_state (
  target_table text not null,
  target_record_id text not null,
  payload_hash text not null,
  payload jsonb not null default '{}'::jsonb,
  last_written_at timestamptz not null default now(),
  last_run_id bigint,
  primary key (target_table, target_record_id)
);

create index if not exists idx_airtable_task_time_writeback_state_written
  on sync.airtable_task_time_writeback_state(last_written_at desc);

grant select, insert, update, delete on sync.airtable_task_time_writeback_state to bowlus_sync;
grant select on sync.airtable_task_time_writeback_state to bowlus_app, bowlus_readonly;
