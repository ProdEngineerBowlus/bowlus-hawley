-- Part change records are "Part Revisions" (PR-209), not ECOs: ECO is Bowlus's separate formal process, and these
-- everyday CAD/part changes must not be confused with it. Replaces the ECO-n number with PR-n; ids are unchanged.
alter table parts.engineering_changes drop column if exists eco_number;
alter table parts.engineering_changes add column if not exists change_number text generated always as ('PR-' || eco_id::text) stored;

comment on table parts.engineering_changes is
  'Part Revision records (PR-n): why a CNC part changed and the first VIN it applies to. Everyday CAD/part changes, not formal ECOs. Seeded from the Airtable "Engineering Changes" table (airtable_record_id set).';
