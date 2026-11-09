# Airtable archive in Postgres

Goal: nothing is lost when Airtable is cancelled. Every table of every Bowlus Airtable base is kept in Hawley's
Postgres, separate from live Hawley data.

## Where it lives

- `raw.airtable_records`: one row per Airtable record (`table_id`, `table_name`, `record_id`, `fields_json` keyed by
  field name, `airtable_created_at`, `synced_at` = when the export was captured). Linked records are kept as record id
  arrays inside `fields_json`.
- `raw.airtable_schema_tables`: each table's schema (fields, types, links); `raw_json->>'base_id'` names the base.
- Nothing in the HB build reads these, so loading an archive never overwrites live Hawley data. Live mirrors
  (`raw.airtable_cnc_parts_master`, `raw.airtable_work_force`, ...) are separate and untouched.
- `reporting.airtable_engineering_changes` is a view over the Engineering Changes table.

## Loaded so far

| Captured | Source | Bases | Tables | Records |
|---|---|---|---|---|
| 2026-10-28 | `Documents\Hawley Recovery\airtable-2026-10-28\records-only.sqlite` | 5 | 89 with records (91 incl. empty) | 41,870 |

Excluded on purpose: `ENV Table` (tokens) and the `Information & Passwords` field of `Serial Numbers & Deviations`.
Size: about 99 MB.

## Before cancelling Airtable

1. Take a final export with the same exporter (records-only SQLite: `source_tables`, `source_records`).
2. Copy it to a path without spaces and load it:
   `node scripts/hawley-db.mjs admin -- node scripts/import-airtable-archive.mjs <file.sqlite> <captured-at ISO> --dry-run`,
   then again without `--dry-run`. Newer captures replace older rows; records deleted in Airtable since stay as they
   were last captured.
3. Finish the attachment upload (see `airtable-attachment-cutover.md`); this archive holds attachment metadata, not files.
