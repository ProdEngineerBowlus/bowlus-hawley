-- NocoDB access to Hawley Postgres (bowlus_ops).
--
-- Run as the admin/migration user (doadmin or bowlus_sync) AFTER creating, in the
-- DigitalOcean control panel (Databases > hawley-pg-prod > Users & Databases):
--   user     nocodb_reader   - NocoDB's connection to Hawley data (read-only)
--   user     nocodb_meta     - owner of NocoDB's own metadata database
--   database nocodb_meta     - NocoDB's users, bases, views and settings (never Hawley data)
--
--   psql "$HAWLEY_SYNC_DATABASE_URL" -f scripts/nocodb-access.sql
--
-- Safe to re-run. Re-run after migrations that add tables to core or ops.
--
-- Read-only on purpose: hb and raw are rebuilt from Asana/Airtable by pg:build:hb and the
-- pull scripts, so edits made in NocoDB would be overwritten. Writable CNC parts tables
-- get their own Hawley-owned schema and their own grants when they exist.

grant connect on database bowlus_ops to nocodb_reader;

grant usage on schema hb, reporting, core, ops to nocodb_reader;
grant select on all tables in schema hb, reporting, core, ops to nocodb_reader;

-- Login secrets: password hashes, session tokens and auth history never leave Hawley.
revoke select on core.app_users, core.app_sessions, core.app_auth_events from nocodb_reader;

-- Tables and views created later by the user running this script are readable too.
-- core is left out so a future secrets table is never granted by default.
alter default privileges in schema hb, reporting, ops grant select on tables to nocodb_reader;

-- NocoDB creates its own tables in nocodb_meta; that grant is run while connected to
-- nocodb_meta (see docs/runbooks/nocodb.md, step 2).
