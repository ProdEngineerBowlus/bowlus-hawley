# Retire redundant Airtable capacity imports

Hawley calculates hb.worker_cycle_bank_rev1 and hb.worker_phase_allocation_rev1 from workers, cycles and task assignments. The imported raw Worker Cycle Bank Rev1 and Worker Phase Allocation Rev1 tables are not inputs to that calculation. Remove those two tables from the nightly/bootstrap Airtable pull and the live source-count health check. Retain existing raw rows for history and diagnostics; no schema or data deletion is required.

The importer now requests 12 tables instead of 14. This also removes the two retired Airtable tables as failure points in the nightly pipeline. Import-summary and health raw counts remain historical counts, not freshness guarantees.

Phase Cycle Load Rev1 remains connected: the admin dashboard still selects the Airtable snapshot when HB is absent or older. Removing that input requires an explicit dashboard-source change and validation. Work Force remains connected until normalization preserves Hawley-owned edits; simply stopping downloads would still allow cached Airtable records to overwrite those edits. Tasks, Production, Cycles, VINs, models, phases, CNC sources, current assignments and actual-time jobs remain outside this change.

Validation: inspect all references to both retired raw tables, verify only count diagnostics remain, run the existing test suite and syntax checks. No new calculations or assignment/time behavior are introduced.

Rollback: revert the two source-list changes and redeploy; retained raw tables and credentials support resuming imports. This is the first disconnection step, not the full Airtable cutover.
