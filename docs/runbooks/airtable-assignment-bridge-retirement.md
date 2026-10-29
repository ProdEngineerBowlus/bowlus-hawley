# Airtable current-assignment watcher retirement

The web-service Airtable current-assignment watcher is disabled unconditionally, including installations with the old enable flag. Direct Asana event watching remains unchanged at its configured 60-second interval. The Asana event watcher retrieves changed tasks and rebuilds HB, whose dated Asana assignments take precedence over Airtable worker links.

No historical records are deleted. The standalone recovery command remains available for explicitly requested recovery; the web service cannot schedule it. Nightly full Task Instances imports, actual-time jobs, and bootstrap behavior remain unchanged pending the broader source migration. This retires the minute-by-minute bridge, not all Airtable dependencies or the separate historical importer.

Polling is not an end-to-end latency guarantee: Asana project event traversal, task fetches, rebuild work and the worker browser refresh add time. Long polls finish before the next poll; the watcher does not overlap itself.

Rollback: revert the server change and redeploy to restore the previous flag-controlled watcher. Verify health reports airtableCurrentAssignments disabled and asanaEvents enabled/running after deployment. Existing assignment records and timers are preserved.
