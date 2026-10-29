# Airtable attachment cutover

Status: prepared, not deployed. Airtable cancellation remains blocked on this cutover and the planning replacements.

The October 28 export has been verified locally after recovering six large QC PDFs on October 29: 92 tables, 41,872 records, 311,750 linked-record references, 9,910 unique attachment files, zero attachment errors, SQLite integrity OK. This is a live-source export, not an atomic snapshot or a final delta export. Automation/interface coverage and external URL targets are separate from attachment preservation.

The private Spaces bucket `bowlus-hawley-attachments` is in SFO3, assigned to Bowlus Shop Operations. Standard Spaces subscription: $5/month base; usage overages can apply. CDN is off. No Google/SOP content is part of this migration.

## Release prerequisites

1. Finish uploads from the verified local export. Each object uses an immutable attachment ID/hash key, private ACL, SHA-256 metadata, Content-MD5 transport verification, and post-upload length/ETag checks. Keep the local snapshot.
2. Apply migration 034 and run `node apps/postgres-sync/src/import-task-attachment-catalog.js SNAPSHOT_FOLDER UPLOAD_CHECKPOINT` using the authorized sync database connection. Every task needs an entry, including an explicit empty list. The importer rejects missing/unverified attachments before opening a transaction.
3. Compare the catalog against current Hawley templates and reconcile changes since the export. Do not overwrite newer native attachment edits with an old snapshot.
4. Configure encrypted `HAWLEY_SPACES_ACCESS_KEY`, `HAWLEY_SPACES_SECRET_KEY`, `HAWLEY_SPACES_BUCKET`, and `HAWLEY_SPACES_REGION` on the app. Use a read-only bucket key at runtime. Credentials stay outside Git and logs.
5. Verify real private-object downloads with runtime credentials. Verify missing entries fail before creating an Asana project. Run a controlled project-creation attachment test, then deploy.
6. Revoke the migration writer key after uploads and independent verification. Keep an audit of counts, hashes, deployment commit and the tested project; never store secrets in it.

Project creation now resolves attachments from `core.task_attachment_catalog` and generates a fresh short-lived download URL immediately before each upload to Asana. Missing catalog entries or unverified references fail closed. No expiring Airtable URL fallback remains in this path. This branch does not change the production app until merged and deployed.

New task creation/editing must maintain the catalog (empty list for no files). Upload/edit UI is future work. The existing production app continues using Airtable attachment lookup until release prerequisites pass.

Traceability: https://github.com/ProdEngineerBowlus/bowlus-hawley/issues/4
