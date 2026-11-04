# Daily Assignment Tracker retirement — October 1, 2026

## Decision and boundary

User authorized retirement of the orphaned Asana Daily Assignment Tracker and its legacy worker/dashboard consumers, accepting interruption to the old dashboard. This retires the tracker, not source production tasks or Asana as a whole. Hawley still imports source Asana tasks and supports its existing completion/writeback workflows.

## Verified before retirement

- Asana project 1214157321063250, Daily Assignment Tracker: 712 tasks (358 completed, 354 incomplete), unarchived.
- SW_Machine port 5173 served the old Daily Worker App: its read-only assignment API returned source=asana, the tracker project ID and 10 workers on October 1.
- Port 3087 served the old Shop Ops dashboard; deployed code still called fetchTrackerSnapshot and used the tracker line overview.
- TrueSync was scheduled and successful, with TRUE_SYNC_RUN_DAILY_TRACKER=true.
- Cloud Hawley was healthy while its last tracker import was July 12; normal nightly read-model refresh does not invoke the tracker importer.

## Applied changes

1. Exported the seven affected Windows task definitions before disabling them:
   - ShopOps-DailyWorkerApp
   - ShopOps-DashboardHost
   - ShopOps-DashboardWatchdog
   - ShopOps-DashboardKiosk
   - ShopOps-KioskWatchdog
   - PLH Dashboard Kiosk
   - PLH Dashboard Kiosk Direct
2. Stopped the verified legacy Node listeners on ports 5173 and 3087. Existing browser windows were not killed or redirected; old kiosk pages may show stale data or a connection error.
3. Set SW_Machine Shop Ops flags: TRUE_SYNC_RUN_DAILY_TRACKER=false, AIRSYNC_RUN_DAILY_TRACKER=false, DAILY_TRACKER_RETIRED=true. The Dropbox-synchronized local copy was also verified with these values.
4. Added an early return in Shop Ops apps/airsync/DailyAssignmentSync.js: when DAILY_TRACKER_RETIRED is true, runDailyAssignmentSync returns skipped before touching dependencies. This also blocks manual calls through the shared normal entrypoint. Existing legacy migration utilities remain historical code and must not be invoked.
5. Archived the Asana project using its API, then fetched it again to verify archived=true. No tasks were deleted or marked completed.
6. Left ShopOps-TrueSync and ShopOps-FlaskControl enabled. The retired app launchers must not be manually restarted from the old control page.

The scoped deployment procedure is preserved in tools/operations/retire-legacy-daily-tracker.ps1. It is machine-specific and was executed over the existing authenticated SSH route. It is not an unattended deployment job. The script backs up affected source/task definitions and only the three previous flag values, not a full credential file.

## Verification

- Seven affected scheduled tasks reported Disabled; TrueSync and Flask reported Ready.
- Post-change listener check found 5087 (Flask), with no listeners on 5173 or 3087.
- node --check passed on the modified deployed tracker module.
- A direct invocation of the synchronized module with DAILY_TRACKER_RETIRED=true and null dependencies returned the retirement skip result, proving the guard exits before data access.
- Asana project archive was read back successfully.
- Cloud health at 2026-10-01T14:20:23Z: ok=true, 8,356 assignment rows, 2,825 worker actual rows. Asana-event and worker-actual watchers were running without reported errors; worker actual import completed at 14:20:11Z. Nightly refresh remained scheduled.

Cloud health is not an authenticated end-to-end worker interaction test. The live HAWLEY_WORKER_USE_DAT_SNAPSHOTS setting was not exposed by the public API and was not modified. Latest fetched origin/main (5a737e5) uses the HB read model by default; DAT snapshot mode requires an explicit true flag. Historical DAT rows remain in Postgres for provenance. No cloud deployment or destructive database cleanup was performed.

## Rollback

Remote backup directory:
C:\Users\prode\Bowlus Dropbox\Production Engineering\Engineering\Jacob Working\Projects\Bowlus Shop Ops\data\retirement-backups\daily-tracker-2026-10-01

Contains original task XML, DailyAssignmentSync.js, and previous-flags.json. For an explicitly requested rollback: unarchive project 1214157321063250; restore the three flag values and tracker source from backup; re-enable only the required exported legacy tasks; start their normal watchdogs and verify the APIs. Preserve unrelated configuration and do not overwrite the whole .env. Timer/state/history files were retained. Restoring tracker service should be a deliberate decision rather than automatic recovery.

## Remaining migration work

- If the shop screen used the retired local kiosk, point it to the intended Hawley display after confirming the correct view and authentication.
- Optional cloud DAT snapshot/import code still exists. Retiring that code is a separate source cleanup; normal cloud refresh already excludes its import.
- Other TrueSync/Airtable responsibilities remain active. This change is tracker independence, not complete Asana/Airtable independence.

Final scheduled-run verification: TrueSync started at 2026-10-01T14:20:27Z and completed successfully at 14:21:15Z with runDailyTracker=false. Its tracker step was skipped explicitly because TRUE_SYNC_RUN_DAILY_TRACKER=false. Both retired ports remained closed.
