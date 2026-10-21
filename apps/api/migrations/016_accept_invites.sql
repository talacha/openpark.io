-- Someone who already has an account is never attached to a property without saying yes: they are invited, and accept here.
create function my_invites(p_email text)
returns table (tenant_id uuid, slug text, name text, roles text[], unit text, superadmin boolean)
language sql stable security definer set search_path = public as $$
  select i.tenant_id, t.slug, t.name, i.roles, u.code, i.superadmin
  from membership_invite i join tenant t on t.id = i.tenant_id left join unit u on u.id = i.unit_id
  where i.email = lower(p_email) and t.suspended_at is null
  order by t.name
$$;

create function accept_invite(p_user uuid, p_email text, p_tenant uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare found boolean;
begin
  insert into membership (tenant_id, user_id, roles, unit_id)
    select tenant_id, p_user, roles, unit_id from membership_invite where email = lower(p_email) and tenant_id = p_tenant
    on conflict do nothing;
  get diagnostics found = row_count;
  update app_user set is_superadmin = true
    where id = p_user and exists (select 1 from membership_invite where email = lower(p_email) and tenant_id = p_tenant and superadmin);
  delete from membership_invite where email = lower(p_email) and tenant_id = p_tenant;
  return found;
end $$;

revoke execute on function my_invites, accept_invite from public;
grant execute on function my_invites, accept_invite to openpark_app;
