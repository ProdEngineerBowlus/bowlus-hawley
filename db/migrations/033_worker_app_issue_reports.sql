-- Worker-reported app issues are evidence records, not labor records.  They
-- flag a daily performance card for manager review without changing timer,
-- task completion, capacity, or efficiency calculations.

create table if not exists core.worker_app_issue_reports (
  worker_app_issue_report_id bigserial primary key,
  issue_key text not null unique,
  worker_key text not null,
  worker_name text,
  worker_email text,
  work_date date not null,
  asana_task_gid text,
  task_name text,
  issue_type text not null default 'app_issue'
    check (issue_type in ('app_issue', 'task_not_visible', 'timer_failed', 'assignment_mismatch', 'other')),
  detail text,
  status text not null default 'open'
    check (status in ('open', 'reviewed', 'resolved', 'dismissed')),
  reported_by_email text,
  reported_at timestamptz not null default now(),
  resolved_by_email text,
  resolved_at timestamptz,
  resolution_note text,
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_worker_app_issue_reports_worker_date
  on core.worker_app_issue_reports(worker_key, work_date, reported_at desc);
create index if not exists idx_worker_app_issue_reports_open
  on core.worker_app_issue_reports(status, work_date, worker_key)
  where status in ('open', 'reviewed');

comment on table core.worker_app_issue_reports is
  'Worker-reported Hawley app issues. Open or reviewed records mark the associated manager-only daily performance card Needs review; they never alter labor or pace values.';

grant select, insert, update, delete on core.worker_app_issue_reports to bowlus_app, bowlus_sync;
grant usage, select on sequence core.worker_app_issue_reports_worker_app_issue_report_id_seq to bowlus_app, bowlus_sync;
