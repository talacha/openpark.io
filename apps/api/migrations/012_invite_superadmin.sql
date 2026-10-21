-- A Super Admin can invite someone as Super Admin; the flag is applied when the invitation is claimed at first sign-in.
alter table membership_invite add column superadmin boolean not null default false;

create or replace function claim_invites(p_user uuid, p_email text) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into membership (tenant_id, user_id, roles, unit_id)
    select tenant_id, p_user, roles, unit_id from membership_invite where email = lower(p_email)
    on conflict do nothing;
  get diagnostics n = row_count;
  update app_user set is_superadmin = true
    where id = p_user and exists (select 1 from membership_invite where email = lower(p_email) and superadmin);
  delete from membership_invite where email = lower(p_email);
  return n;
end $$;
