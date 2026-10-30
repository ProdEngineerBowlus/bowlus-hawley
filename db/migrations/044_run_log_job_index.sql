-- The worker page's sync status reads the latest run per job. Without this index every poll scanned the
-- whole run_log (480 MB by 2026-10-30); overlapping scans filled the read pool and took the page down.
create index if not exists run_log_job_name_id_idx on sync.run_log (job_name, id desc);
analyze sync.run_log;
