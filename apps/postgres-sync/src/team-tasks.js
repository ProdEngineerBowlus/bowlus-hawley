// Team tasks: helpers come from the Asana "Helpers" People field (gid in hb.team_task_settings). Every HB
// rebuild mirrors the field into hb.task_helpers, so helpers see the task and can log their own time.

export async function syncTaskHelpers(client) {
  const settings = await client.query(`select helpers_field_gid from hb.team_task_settings where settings_key = 'default'`);
  const fieldGid = settings.rows[0]?.helpers_field_gid;
  if (!fieldGid) return { skipped: "Helpers field not set up", helpers: 0 };
  const source = `
    select distinct a.gid as asana_task_gid, lower(p ->> 'email') as helper_email, p ->> 'name' as helper_name, p ->> 'gid' as helper_asana_gid
      from raw.asana_tasks a,
           jsonb_array_elements(coalesce(a.custom_fields_json, '[]'::jsonb)) f,
           jsonb_array_elements(case when jsonb_typeof(f -> 'people_value') = 'array' then f -> 'people_value' else '[]'::jsonb end) p
     where f ->> 'gid' = $1 and coalesce(p ->> 'email', '') <> ''`;
  const removed = await client.query(
    `delete from hb.task_helpers h
      where not exists (select 1 from (${source}) s where s.asana_task_gid = h.asana_task_gid and s.helper_email = h.helper_email)`,
    [fieldGid]
  );
  const upserted = await client.query(
    `insert into hb.task_helpers (asana_task_gid, helper_email, helper_name, helper_asana_gid, synced_at)
     select asana_task_gid, helper_email, helper_name, helper_asana_gid, now() from (${source}) s
     on conflict (asana_task_gid, helper_email) do update
       set helper_name = excluded.helper_name, helper_asana_gid = excluded.helper_asana_gid, synced_at = now()
     where hb.task_helpers.helper_name is distinct from excluded.helper_name`,
    [fieldGid]
  );
  const total = await client.query(`select count(*)::int as n from hb.task_helpers`);
  return { helpers: total.rows[0].n, added_or_renamed: upserted.rowCount || 0, removed: removed.rowCount || 0 };
}

// Lower-case, de-duplicated trial list from free text ("a@x.com, b@x.com").
export function parseTrialEmails(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(/[\s,;]+/);
  return [...new Set(list.map(email => String(email).trim().toLowerCase()).filter(email => /^[^@\s]+@[^@\s]+$/.test(email)))];
}
