# Reusable task catalog: first migration slice

This prototype separates task definitions and immutable definition versions from VIN/batch work occurrences. It preserves the entire Airtable Tasks catalog, including fabrication and CNC tasks. DayBlocks - Frontier is a sequencing reference overlay, never a filter on the task catalog.

## Scope and isolation

The explicit SQL prototype is in `db/prototypes/planning-v2.sql`, outside the automatic production migration directory. Nothing in the running worker application calls this importer. The isolated cloud schema was explicitly deployed on 2026-10-28. No existing production tables, timers, or Asana tasks were changed.

The local preview uses embedded PostgreSQL (PGlite). Its data directory is not a normal Postgres server connection for DBeaver. Existing DigitalOcean admin access was recovered and verified on 2026-10-28. The earlier readonly probe only described DBeaver access. The isolated cloud deployment is documented below.

Task source identities include the base and record ID. Full field values and metadata are retained in versioned JSON, including model/phase applicability, estimates, skill, FAB/CNC references and attachments. Those fields have not yet been promoted into a complete typed planning engine. Changed definitions add versions; released occurrences keep their pinned version. Cycle is not part of occurrence identity. Imports create no occurrences and do not copy templates per VIN or cycle.

## DayBlocks evidence

Project: https://app.asana.com/1/829365006370166/project/1218989244240194

The 2026-10-28 capture contains 89 project-level tasks and 402 total nodes after recursive subtask retrieval. It covers nine sections: Phase A Lower, Phase A Upper, and B through H. There are 362 exact TasksKey matches into the full 929-template Airtable catalog. A repeated template in the route remains a separate route node; it does not duplicate the task definition.

Day parent tasks provide provisional phase-relative workday targets. Descendants inherit their parent day and project section. Phase B has days 1-7, C 1-8, D 1-7, E 1-6, F 1-5, and G 1-6. Phase A Lower/Upper and H have no Day containers in this capture; no day targets were invented. These are not derived calendar due dates or labor durations.

`Cleaning Second Seal Of Windows` (Asana 1219036033590214, Phase C / Day 5) lacks a TasksKey and remains an unmapped review item. Source hierarchy and payload are preserved. Do not name-match it automatically.

Parent work groups and their children can both carry estimates. No total forecast is emitted yet: the counting rule must be resolved to prevent double-counting. Day containers are classified separately from actual work.

## Reproduce locally

Run `npm ci` including dev dependencies, then:

```text
node apps/postgres-sync/src/preview-planning-v2.js <preservation-directory> <private-output-directory>
```

The input contains the full source-base schema, records.json for Tasks/Cycles/Production/Phases/VINs/Models, and dayblocks-frontier-full.json with projectId, capturedAt, and recursively fetched tasks. Source record fields use Airtable field IDs. Keep all real source data and output outside Git. Templates and route snapshot IDs are deterministic; repeated identical imports do not duplicate them. Schedule source rows are initial reference copies, not a live schedule sync. Use a new preview directory for a newly captured schedule.

Outputs: a persistent local PostgreSQL preview, review.json (counts, sections, warnings), and template-map.json. Verified against the actual preserved input: 929 templates, 402 route nodes, 551 schedule/reference rows, zero work occurrences, and one mapping warning.

## Validation

`npm test` passes 28 tests, including PostgreSQL schema execution, repeatable imports, preservation of released definition versions after catalog edits, cycle reassignment without identity change, hierarchy validation, and transactional rollback on invalid parent links. Existing worker and HB tests also pass.

## Next implementation slices

1. Confirm interpretation of phase-relative days and parent/child estimate ownership. Review the unmapped task, plus day targets missing in A and H.
2. Normalize model/options/phase applicability and FAB/CNC offsets while retaining source IDs. Add working calendars, cycle planning and versioned production-plan scenarios.
3. Add virtual VIN/phase workload expansion and on-demand work release, with explicit batch allocation and quantity handling.
4. Integrate existing session, actual-time, assignment and Asana identity ledgers; do not introduce a second time authority.
5. Reconcile estimates/capacity/history and test end-to-end before production migration or disabling Airtable inputs.

Migration tracking: https://github.com/ProdEngineerBowlus/bowlus-hawley/issues/4

## Cloud deployment verified - 2026-10-28

At 22:17 UTC, deployed into hawley-pg-prod / bowlus_ops / planning_v2 using existing DigitalOcean access and verified CA certificate. Schema creation, import, constraints, count checks, and read grants committed together in one transaction, with a savepoint wrapping the importer. Initial deployment refused to replace an existing schema.

Verified 929 task definitions, 929 immutable versions, 402 DayBlocks nodes, 551 schedule/reference rows, and zero work occurrences. One unmapped DayBlocks task remains flagged above. This is a preserved snapshot, not a live sync or a completed Airtable replacement. The existing Hawley application remains on its current tables.

Granted bowlus_readonly USAGE on planning_v2 and SELECT on its current tables/views. A separate login as this role, with verified TLS, read all 929 catalog rows and 402 route rows. Future tables require separate grants; no global permissions were broadened.

DBeaver: refresh the connection, then expand Databases > bowlus_ops > Schemas > planning_v2. Under Views, open task_catalog_review or dayblocks_review and select Data. Under Tables, inspect the underlying definitions, versions, routes, schedule sources, and empty work_occurrences table.

Private evidence: data/preservation/airtable-2026-10-28/planning-v2-cloud-deployment.json in Shop Ops. Credentials and raw source records are excluded from GitHub. To retire this preview later, verify no application dependencies or new work records, export it, and explicitly review removal. No destructive automatic rollback is installed.
