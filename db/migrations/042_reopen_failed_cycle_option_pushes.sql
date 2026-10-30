-- The 2026-10-30 16:03 UTC cycle plan publish recorded 215 Asana Cycle pushes as "pushed", but the
-- C1.27 option was never created (the option request was double-wrapped and rejected), so each push
-- was an empty update and no task changed in Asana (verified on task 1218323489433856). Re-open those
-- pushes so "Retry Asana update" on the Cycles tab can add the options and send them again.
update hb.cycle_plan_versions
   set asana_push_json = (
     select coalesce(jsonb_agg(case when p ->> 'status' = 'pushed'
                                    then p || jsonb_build_object('status', 'pending', 'error', 'Reopened: option was missing at publish')
                                    else p end), '[]'::jsonb)
       from jsonb_array_elements(asana_push_json) p)
 where cycle_plan_version_id = 'cycle-plan:793dd983-a176-4aa7-b011-d9877a7f7a3e:2026';
