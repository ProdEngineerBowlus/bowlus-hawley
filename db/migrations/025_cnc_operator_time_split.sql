-- CNC cut windows are not all operator labor.  Retain the observed window for
-- diagnostics, credit historical program runtime as machine time, and write
-- only the excess (load / unload / interruption) to David's labor ledger.

alter table core.cnc_machine_runs
  add column if not exists actual_window_minutes numeric(10, 2),
  add column if not exists credited_machine_minutes numeric(10, 2),
  add column if not exists derived_manual_minutes numeric(10, 2),
  add column if not exists support_time_session_key text;

create index if not exists idx_cnc_machine_runs_worker_date_stopped
  on core.cnc_machine_runs(worker_key, work_date, stopped_at desc);

comment on column core.cnc_machine_runs.actual_window_minutes is
  'Wall-clock window from operator Start cut to Stop cut.';
comment on column core.cnc_machine_runs.credited_machine_minutes is
  'Machine runtime credited from the historical program estimate, capped by the observed window.';
comment on column core.cnc_machine_runs.derived_manual_minutes is
  'Observed window in excess of the historical program estimate; credited once to the operator as support labor.';
comment on column core.cnc_machine_runs.support_time_session_key is
  'Derived core.time_sessions key for the support-labor portion of this run.';

grant select, insert, update, delete on core.cnc_machine_runs to bowlus_app, bowlus_sync;
