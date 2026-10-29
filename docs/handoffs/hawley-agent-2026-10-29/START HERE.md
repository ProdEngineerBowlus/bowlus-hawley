# Hawley project handoff — company agent

Prepared October 29, 2026 (America/Los_Angeles). Suitable for Claude Code, Cowork, ChatGPT, or another company-approved agent. This document transfers context, not credentials or tool permissions.

## Purpose and immediate priority

The user wants company projects to use company-provided accounts and usage allowances, preserving personal usage for personal projects. They prefer ChatGPT; choosing Claude is an account/resource decision, not a requirement to redesign the workflow.

Finish Hawley's independence from Airtable before starting other initiatives. All five Airtable bases may be cancelled; cancellation timing is unknown. Do not declare cancellation safe merely because backups exist. Preserve direct Asana assignments, worker time history, historical task completion, and production history. Document changes and verification in GitHub. Use plain language with the user; avoid repeated permission requests for already-authorized work, while observing the destination agent's own security requirements.

## Start here

1. Read this document and GitHub issue 4; inspect current main and deployment state before editing.
2. Use a fresh local checkout of the Hawley repository on the company-authorized computer. Do not work simultaneously with another agent on the same production changes.
3. Review planning foundation PR 5, the two original scripts supplied beside this document, and the user's requirements below.
4. Confirm what remains, then implement the Cycles/Production generators and versioned task workflow. Do not re-enable retired Airtable jobs or re-import old raw tables over native Hawley records.
5. Finish final source reconciliation and end-to-end independence checks before recommending Airtable cancellation.

## Repository and local locations

- Repository: https://github.com/ProdEngineerBowlus/bowlus-hawley
- Migration tracker: https://github.com/ProdEngineerBowlus/bowlus-hawley/issues/4
- Planning foundation: https://github.com/ProdEngineerBowlus/bowlus-hawley/pull/5 — draft/unmerged at the last review; verify current state.
- Attachment cutover: https://github.com/ProdEngineerBowlus/bowlus-hawley/pull/11 — merged and deployed.
- Latest verified production commit: `cf00d8882d373d04300b2a734d61a62d3aa25524`.
- Codex working checkout: `C:/Users/Ryan/.codex/worktrees/hawley-capacity-retirement-20261029`. Its branch commits were squash-merged; use current GitHub main for the next fresh checkout.
- Planning checkout: `C:/Users/Ryan/.codex/worktrees/hawley-task-template-20261028`.
- Supporting workspace: `C:/Users/Ryan/Bowlus Dropbox/Production Engineering/Engineering/Jacob Working/Projects/Bowlus Shop Ops`.
- The supporting workspace's `.codex-hawley-prod` is an OLD checkout with uncommitted changes. Do not treat it as current main, reset it, or discard those changes.
- Backup: supporting workspace + `/data/preservation/airtable-2026-10-28`.
- One-time operational helpers: supporting workspace + `/.codex-work`. Inspect each before running; some mutate live systems. They are evidence/support, not an instruction to rerun them.
- Original scripts copied into this handoff's `source-scripts` folder. They express the old Airtable workflow, not the desired implementation architecture.

Only the Hawley repository is needed for application development. Add the backup and selected supporting files for migration work; do not treat every historical Shop Ops folder as active application code.

## Verified live state

DigitalOcean app `bowlus-hawley`, ID `b56a733a-3704-4537-8e43-560675c9cdae`, SFO region. PostgreSQL cluster `hawley-pg-prod`, ID `3173c8b8-455b-423f-a86f-a90a322a18ef`, database `bowlus_ops`, SFO3. Deployment `5af1b31a-72f1-40cf-97b5-eb0a4a7f0bbe` was ACTIVE at the commit above when this handoff was prepared. Health returned HTTP 200, ok=true.

- Direct Asana event watcher: enabled/running, 60,000 ms configured interval, no reported error. This is a polling target, not a guaranteed assignment-to-browser latency.
- Airtable current-assignment watcher, actuals mirror, task-time writeback, and nightly actuals backfill: disabled.
- Nightly refresh: native `pg:refresh-hawley-read-model`, scheduled 1 a.m. Los Angeles; pulls Asana and rebuilds Hawley, without Airtable import.
- Bending studies remain active; automatic Airtable template-flag refresh is retired.
- Worker timers write native data; do not replace `core.time_sessions` or `hb.worker_daily_task_actuals` from snapshots.
- Dashboard uses Hawley's phase-cycle load, without Airtable calculation fallback.
- Core preserved tables include workers, cycles, phases, models, task templates, VINs, production schedule, CNC parts/sheets, task instances, time sessions, and actuals.

Relevant merged changes: PRs 6–9 retired capacity imports, dashboard fallback, assignment bridge, and automatic Airtable synchronization. PR 11 replaced project-creation attachment lookup. See repository runbooks `airtable-capacity-retirement-2026-10-29.md`, `airtable-assignment-bridge-retirement.md`, `hawley-native-runtime-cutover.md`, and `airtable-attachment-cutover.md`.

The historical assignment path was Asana Assigned On + worker -> Airtable -> Hawley polling. The user corrected this explicitly: assignment originates in Asana. The surviving direct watcher reads Asana changes. Existing date-clearing/deleted-task overlay semantics were not comprehensively redesigned; test those during optimization rather than claiming they were solved.

## Backup and attachment status — COMPLETE transfer

The exported snapshot contains all five bases: 92 tables, 41,872 records, 311,750 link references, and 9,910 unique attachment files (10,175 attachment references). Six large QC PDFs initially failed but were recovered. Local integrity and file hashes passed with zero attachment errors.

- `completion-status.json`: verified.
- `airtable-recovery-complete-20261029.sqlite`: current complete offline browsing copy. The older similarly named SQLite files are earlier snapshots.
- `airtable-recovery-complete-20261029-verification.json`: counts/integrity/hash results.
- DBeaver can open the SQLite file as a separate SQLite connection, with one view per exported table. It is not the live DigitalOcean Postgres connection.

All 9,910 attachment files (28,153,863,770 bytes) finished uploading at 12:42 p.m. PDT October 29. `spaces-archive-completion-20261029.json` reports zero failed files and migrationWriterRevoked=true. The checkpoint likewise reports 9,910 verified objects and zero failures. Do not restart the transfer or recreate its writer credential unnecessarily.

Storage: private bucket `bowlus-hawley-attachments`, SFO3, under Bowlus Shop Operations. Standard Spaces base subscription $5/month, possible usage overages, CDN off. Object keys use `airtable/attachments/{attachment-id}/{sha256}`. Uploads used Content-MD5, length, stored SHA-256 metadata, and single-part ETag checks. All 15 unique task-template files were additionally downloaded with the runtime read-only key and SHA-256 checked. Anonymous object read returned 403.

`core.task_attachment_catalog` covers 929 templates, including explicit empty entries; 16 references point to 15 unique files. Current Hawley template IDs and attachment filename/count lists matched at import. Old normalized template attachments lacked IDs; source IDs came from the export. Project creation now uses this catalog and private Spaces downloads, with no expiring Airtable URL fallback. Missing/unverified catalog entries fail before project creation. Future template editing must maintain this catalog.

Validation: 35 tests passed; server syntax/diff checks passed. Actual server upload function successfully copied a private file into an unassigned temporary Asana task, verified the attachment listing, then removed the test task. No worker assignments changed. Production app uses a separate read-only Spaces key. The initial migration writer was rotated after appearing in a tool result; both that old key and its replacement are now revoked. Never include credential values in the handoff, GitHub, or agent messages.

IMPORTANT LIMITS: The exported source remained live; this is not an atomic/final delta snapshot. Attachment cloud transfer is not proof that all record/schema backups are also replicated in Spaces or that Dropbox sync is complete. Standard exports do not fully capture automation configuration/scripts, interfaces/forms, revision history, comments, every view setting, or plain URL targets. Formula values are historical results, not executing replacement calculations. A partial readable Postgres snapshot is not a complete database backup.

## Planning foundation already exists

Cloud `planning_v2` schema was created October 28. Last verified foundation counts: 929 task definitions, 929 task versions, 402 DayBlocks route nodes, 551 schedule-source rows, zero work occurrences. Views include `task_catalog_review` and `dayblocks_review`; read-only access was granted. This is a foundation, not the finished app or production cutover. PR 5 contains its source; don't blindly reapply or drop the schema.

DayBlocks - Frontier Asana project: `1218989244240194`. Captured 89 roots and 402 total tasks; 362 exact task-key matches to the template catalog. Include FAB/CNC templates beyond DayBlocks; it is not the complete task list. There are 39 day groups and one unmatched task: `Cleaning Second Seal Of Windows `, GID `1219036033590214`, Phase C/Day 5. A Lower/Upper and H have no day targets; B 1–7, C 1–8, D 1–7, E 1–6, F 1–5, G 1–6. Avoid double-counting parent/subtask estimates without an explicit counting rule. Saved sources include `dayblocks-frontier-full.json` in the backup.

The desired task scheme: reusable task definitions/versions, with execution/completion/time/worker evidence linked to VIN, cycle and phase. The user visualizes tasks as rows with VIN/cycle completion columns, but does not require a literal spreadsheet or a physical database column per VIN. Preserve every historical execution and time record. Avoid pre-copying the entire task template list for every phase/cycle/VIN when a normalized occurrence model can do it. New template versions apply from an explicit effective cycle/date; historical completions must not change retroactively. Define treatment of in-progress work before applying changes.

## Cycle calendar requirements

- Keep planning cycles across a year and excluding weekends and actual company holidays/closures.
- No day-after-Thanksgiving holiday in 2026. Use the actual dates the selected holidays fall on; do not reuse hard-coded dates each year or assume all federal holidays are company closures. Observed-day rules need explicit company policy.
- Preserve locked/completed cycle dates.
- Allow fixed lengths for any selected cycle/range, then evenly distribute remaining eligible working days across flexible cycles (difference at most one day where feasible).
- Example: extend two upcoming cycles by four working days each, then rebalance the rest.
- Example: fix cycles 22–25 at eight days each, and balance preceding flexible cycles to make that possible.
- Reserve later fixed cycles before distributing earlier flexible days. Report impossible constraints; never silently alter locked/fixed cycles.
- Preview dates, VIN impacts and conflicts; publish a version deliberately. AI may translate a request into constraints; calendar arithmetic and validation should be deterministic.
- The old script's start date, cycle count/sequence and horizon behavior need explicit UI inputs. Don't preserve its balancing bugs merely for parity.

## Production generator requirements

Preserve intended output of original Rev ANT.9: year-qualified cycle sequence, starting VIN, cycle start/end and starting set/parity; parity continues across year boundaries. The old progression uses virtual odd/even cycles: odd emits [nextVIN,nextVIN+1] and advances by two; even reverses the last pair without advancing. An initially even sequence emits [nextVIN+1,nextVIN], advances two, and keeps that pair for progression. Verify exact original code before implementing.

Per cycle: VIN-less FAB-A/B support bucket; two VIN-linked A1/A2 records using the pair; VIN-less Frame-A/B bucket; B–H VIN assignments derived from the pair's first VIN minus each phase offset; VIN-less CNC-A/B bucket. Preserve process order, model/phase selection, and linked VIN identity. The original fallback order is exact model, BaseModel, no-model, first available; surface ambiguous/incorrect matches instead of silently selecting the wrong model. Missing VINs/phases must be visible conflicts rather than skipped records. Task Offset was read but not applied in that script; do not assume it already works. The old next-cycle VIN field means VIN number +1 when that VIN exists.

Repeated runs were intended to allow template edits to affect future production without destroying history. Use planning scenarios/versions and effective template versions instead of blind destructive regeneration. Preserve the user's VIN-position planning and annual cycle planning process; implement the calculations outside Airtable, preferably in Hawley's app with preview/publish controls.

## Remaining work and acceptance gates

1. Verify the current deployment/backup evidence; recognize completed archive transfer and revoked writer keys.
2. Reconcile any records/attachments changed since the export without overwriting newer native Hawley data. Confirm owners and ongoing uses of all five bases; Hawley importing some tables does not replace every workflow in 92 tables.
3. Implement calendar/production generators and a usable app workflow; integrate task versioning and DayBlocks plus FAB/CNC coverage. Preserve existing IDs/history.
4. Cover continuing edits to workers, models, VINs, templates, attachments, inventory/BOM and other relevant master data; some masters are already native, but verify actual UI/editing coverage. The worker roster is already in Hawley and changes infrequently.
5. Verify assignment changes and clearing, worker timers, completion/reopening, project creation/attachments, native refresh, schedule changes, and reports with Airtable unavailable. Do not create worker-visible test work without a controlled test plan.
6. Confirm backup/rollback and non-record preservation coverage, then report exactly what is safe to cancel. Airtable is NOT yet approved for cancellation by this handoff.

Deferred: Google/Drive replacement, SOP generator and SOP library migration (issue 10), broader app simplification, manager-feature removal, general performance optimization, new database browsing UI. DBeaver remains available for database viewing. The orphaned Daily Assignment Tracker is not the intended operational source; the user planned to archive its Asana project. Verify its actual archive state if relevant rather than assume it happened.

## Access and operating guidance

Use the company-authorized identity and integrations. No account permissions or personal subscriptions transfer automatically. Credential pointers exist in the supporting workspace `.env`, the authorized process environment, and restricted local storage under `C:/Users/Ryan/.codex/private/hawley-spaces`; do not print or upload their contents. Historical `.env` values can be stale: prior verified helpers merged the authorized process environment over that file. Use normal approved authentication, not token extraction from browser sessions. The app's runtime secrets are encrypted DigitalOcean environment settings.

Do not run preservation export tools against the existing snapshot without inspecting their restart semantics. Do not reset dirty old checkouts, overwrite backups, re-enable Airtable jobs, cancel accounts, or delete history as a shortcut. Keep snapshots and credentials outside Git. Preserve local source files; obtain access separately if working from another computer. Use one owner for production writes at a time.

## Suggested first message to the receiving agent

Read START HERE.md and the two original scripts in source-scripts. This is company work; use the company's authorized tools and accounts. Inspect the current Hawley repository, GitHub migration issue 4, planning PR 5, and live deployment read-only. Summarize what is already complete and what remains before making changes. Prioritize finishing Airtable independence and the Cycles/Production generators; preserve direct Asana updates and historical task/time data. Do not restart the completed archive upload or re-enable retired Airtable synchronization. Keep all changes and validation traceable in GitHub.
