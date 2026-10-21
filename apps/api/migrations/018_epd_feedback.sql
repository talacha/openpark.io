-- EPD-team feedback: one migration carries every schema change for this task.
-- FEAT-003 (Track C — Resident view) adds the first columns; FEAT-004 and FEAT-005 append their own below.

-- Resident profile picture: an object-storage key (served only via signed URLs), nullable until a photo is uploaded.
alter table app_user add column avatar_key text;

-- Per-resident opt-in to guest check-in/check-out alerts; default true preserves today's behaviour.
alter table app_user add column notify_guest_events boolean not null default true;

-- Who issued a guest pass. Lets the resident-facing history distinguish host- vs attendant-issued passes without
-- exposing the staff member's identity. Nullable: legacy rows predating this migration are labelled neutrally.
alter table pass add column created_by uuid references app_user(id);

-- Who authorized a walk-in's access to the lot, captured at check-in. Nullable JSONB shaped either
-- { "unit": "A-101" } (the attendant named a community unit) or { "name": "...", "phone": "+52..." }
-- (an ad-hoc "Other" authorizer). Always NULL for a pass redemption, whose host unit is the pass's unit.
alter table session add column authorized_by jsonb;

-- FEAT-005 (Track E — Admin): unit-access verification. Only a verified resident may issue guest passes.

-- Each unit-access grant is verified independently. The column default is a conservative `false`, but the WRITE PATH
-- decides the common case: staff-placed grants (admin/super-admin add) are written verified; bulk-imported and
-- public-request-access grants start unverified and await an admin's Verify. Existing residents predate the feature,
-- so they are backfilled verified to keep the shipped pass flow working.
alter table membership add column unit_verified boolean not null default false;
update membership set unit_verified = true where 'resident' = any(roles);
alter table membership_invite add column unit_verified boolean not null default false;

-- The Ctx resolver reads ctx.unitVerified from this SECURITY DEFINER function. Its `returns table` signature changes,
-- which Postgres cannot do in place, so it is dropped and recreated (base body from migration 009) with the extra
-- column, then its execute grant is re-applied (revoke from public, grant to the app role).
drop function user_memberships(uuid);
create function user_memberships(p_user uuid)
returns table (tenant_id uuid, slug text, name text, roles text[], unit_id uuid, suspended boolean, unit_verified boolean)
language sql stable security definer set search_path = public as $$
  select m.tenant_id, t.slug, t.name, m.roles, m.unit_id, t.suspended_at is not null, m.unit_verified
  from membership m join tenant t on t.id = m.tenant_id where m.user_id = p_user
$$;
revoke execute on function user_memberships from public;
grant execute on function user_memberships to openpark_app;

-- A staff-placed verified invite must stay verified through BOTH acceptance paths: claim_invites (auto-claim at first
-- sign-in; current body migration 012) and accept_invite (explicit accept by an existing account; migration 016). Each
-- is re-created from its current body with unit_verified carried into the membership insert + the select; every other
-- clause (superadmin update, delete from membership_invite, on conflict do nothing) is preserved verbatim.
create or replace function claim_invites(p_user uuid, p_email text) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into membership (tenant_id, user_id, roles, unit_id, unit_verified)
    select tenant_id, p_user, roles, unit_id, unit_verified from membership_invite where email = lower(p_email)
    on conflict do nothing;
  get diagnostics n = row_count;
  update app_user set is_superadmin = true
    where id = p_user and exists (select 1 from membership_invite where email = lower(p_email) and superadmin);
  delete from membership_invite where email = lower(p_email);
  return n;
end $$;

create or replace function accept_invite(p_user uuid, p_email text, p_tenant uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare found boolean;
begin
  insert into membership (tenant_id, user_id, roles, unit_id, unit_verified)
    select tenant_id, p_user, roles, unit_id, unit_verified from membership_invite where email = lower(p_email) and tenant_id = p_tenant
    on conflict do nothing;
  get diagnostics found = row_count;
  update app_user set is_superadmin = true
    where id = p_user and exists (select 1 from membership_invite where email = lower(p_email) and tenant_id = p_tenant and superadmin);
  delete from membership_invite where email = lower(p_email) and tenant_id = p_tenant;
  return found;
end $$;

-- Bulk import/export jobs now also cover sites and users; widen the kind check to include them.
alter table inventory_import drop constraint inventory_import_kind_check;
alter table inventory_import add constraint inventory_import_kind_check check (kind in ('inventory', 'units', 'sites', 'users'));
