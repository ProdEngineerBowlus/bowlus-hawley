-- Hawley Cloud - READ ONLY. Run individual statements with Ctrl+Enter.
-- Queries return live DigitalOcean data; they do not trigger source refreshes.

-- 1. Connection identity and encryption.
SELECT current_database() AS database_name, current_user AS database_user,
       (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl_enabled;

-- 2. Browse available tables and views; unreadable raw tables are intentional.
SELECT table_schema, table_name, table_type
FROM information_schema.tables
WHERE table_schema IN ('hb', 'reporting', 'ops', 'sync')
ORDER BY table_schema, table_name;

-- 3. Production schedule, most recent first.
SELECT schedule_name, cycle_label, phase_name, vin, start_date, end_date,
       source_synced_at, normalized_at
FROM hb.production_schedule
ORDER BY start_date DESC NULLS LAST, schedule_name
LIMIT 200;

-- 4. CNC parts and material reference.
SELECT part_number, part_name, material_name, quantity_on_sheet, total_count,
       retired, source_synced_at
FROM hb.cnc_parts_master
ORDER BY part_number
LIMIT 200;

-- 5. Logical task-to-part relationships (not physical foreign keys).
SELECT t.task_name, p.part_number, p.part_name, p.material_name, l.link_sources
FROM hb.task_template_part_links AS l
JOIN hb.task_templates AS t ON t.task_record_id = l.task_record_id
JOIN hb.cnc_parts_master AS p ON p.part_record_id = l.part_record_id
ORDER BY t.task_name, p.part_number
LIMIT 200;

-- 6. Source import timestamps, distinct from calculated/rebuilt timestamps.
SELECT 'task_templates' AS dataset, count(*) AS rows,
       min(source_synced_at) AS oldest_source_import,
       max(source_synced_at) AS latest_source_import,
       max(normalized_at) AS latest_normalization
FROM hb.task_templates
UNION ALL
SELECT 'production_schedule', count(*), min(source_synced_at),
       max(source_synced_at), max(normalized_at) FROM hb.production_schedule
UNION ALL
SELECT 'cnc_parts_master', count(*), min(source_synced_at),
       max(source_synced_at), max(normalized_at) FROM hb.cnc_parts_master;

-- 7. Built-in reports. Filter by the date columns shown in each result as needed.
SELECT * FROM reporting.task_template_bom LIMIT 100;
SELECT * FROM reporting.actual_vs_estimated_by_phase LIMIT 100;
SELECT * FROM reporting.worker_daily_utilization LIMIT 100;

-- 8. Verify that the browsing role has no table write privileges.
-- Expected: zero rows. Checks application tables/views, not function privileges.
SELECT n.nspname AS schema_name, c.relname AS object_name
FROM pg_class AS c
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname IN ('hb', 'reporting', 'raw', 'core', 'sync', 'ops')
  AND c.relkind IN ('r', 'v', 'm', 'p')
  AND has_table_privilege(current_user, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE');
