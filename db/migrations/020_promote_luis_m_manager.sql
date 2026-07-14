do $$
declare
  promoted_user core.app_users%rowtype;
  promoted_count integer := 0;
begin
  update core.app_users
  set
    role = 'manager',
    updated_at = now()
  where lower(username) = 'asana+luism@bowlusroadchief.com'
    and lower(coalesce(worker_email, email, username)) = 'asana+luism@bowlusroadchief.com'
  returning * into promoted_user;

  get diagnostics promoted_count = row_count;

  if promoted_count <> 1 then
    raise exception 'Expected exactly one Luis M app account; promoted % accounts', promoted_count;
  end if;

  insert into core.app_auth_events (
    event_type,
    app_user_id,
    username,
    worker_key,
    role,
    success,
    reason,
    payload
  ) values (
    'admin_set_role',
    promoted_user.app_user_id,
    promoted_user.username,
    promoted_user.worker_key,
    promoted_user.role,
    true,
    'authorized_manager_promotion',
    jsonb_build_object('source', 'migration_020', 'display_name', promoted_user.display_name)
  );
end
$$;
