-- Residents, units and guest passes; external identities (Supabase Auth / any OIDC); platform super admin.

-- Identities: a user is either local (password_hash) or external (auth_id = the provider's `sub`).
alter table app_user alter column password_hash drop not null;
alter table app_user add column auth_id text unique;
alter table app_user add column is_superadmin boolean not null default false;
alter table app_user add column phone text;

alter table tenant add column suspended_at timestamptz;
alter table tenant add column suspended_reason text;

-- Units: a resident belongs to a unit, not to a parking slot.
create table unit (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  site_id uuid references site(id) on delete set null,
  code text not null,
  name text not null,
  unique (tenant_id, code)
);

alter table membership drop constraint membership_role_check;
alter table membership add constraint membership_role_check
  check (role in ('owner', 'admin', 'supervisor', 'attendant', 'auditor', 'resident'));
alter table membership add column unit_id uuid references unit(id) on delete restrict;
alter table membership add constraint membership_resident_has_unit check (role <> 'resident' or unit_id is not null);

-- Invitations by email, claimed automatically when that email signs in (external identity mode).
create table membership_invite (
  tenant_id uuid not null references tenant(id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin', 'supervisor', 'attendant', 'auditor', 'resident')),
  unit_id uuid references unit(id) on delete cascade,
  invited_by uuid,
  created_at timestamptz not null default now(),
  primary key (tenant_id, email),
  check (role <> 'resident' or unit_id is not null)
);

-- A resident's guest pass. The QR token is derived (HMAC of id + qr_version), never stored.
create table pass (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  site_id uuid not null references site(id),
  unit_id uuid not null references unit(id),
  host_user_id uuid not null references app_user(id),
  guest_name text not null,
  guest_phone text,
  guest_email text,
  plate_hint text,
  status text not null default 'active' check (status in ('active', 'checked_in', 'completed', 'cancelled')),
  qr_version int not null default 1,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  checked_in_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  session_id uuid references session(id),
  overstay_charge int,
  check (guest_phone is not null or guest_email is not null)
);
-- One pass per unit at a time: from creation until check-out (or cancellation).
create unique index pass_one_active_per_unit on pass (tenant_id, unit_id) where status in ('active', 'checked_in');
create index on pass (tenant_id, host_user_id, created_at desc);
create index on pass (session_id);

-- Each notification kind is sent once per pass (check-in/out alerts, 10h/11h reminders, 12h overstay).
create table pass_notification (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  pass_id uuid not null references pass(id) on delete cascade,
  kind text not null check (kind in ('checked_in', 'checked_out', 'reminder_1', 'reminder_2', 'overstay')),
  status text not null default 'pending' check (status in ('pending', 'sent', 'skipped', 'failed')),
  attempts int not null default 0,
  detail jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (pass_id, kind)
);

do $$
declare t text;
begin
  foreach t in array array['unit', 'membership_invite', 'pass', 'pass_notification'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant()) with check (tenant_id = app_tenant())', t);
  end loop;
end $$;

grant select, insert, update, delete on unit, membership_invite, pass_notification to openpark_app;
grant select, insert, update on pass to openpark_app;

-- ---------------------------------------------------------------------------------------------
-- Cross-tenant lookups (SECURITY DEFINER). Each is explicitly granted to the app role only.
-- ---------------------------------------------------------------------------------------------

drop function user_memberships(uuid);
create function user_memberships(p_user uuid)
returns table (tenant_id uuid, slug text, name text, role text, unit_id uuid, suspended boolean)
language sql stable security definer set search_path = public as $$
  select m.tenant_id, t.slug, t.name, m.role, m.unit_id, t.suspended_at is not null
  from membership m join tenant t on t.id = m.tenant_id where m.user_id = p_user
$$;

create function tenant_by_slug(p_slug text) returns table (id uuid, slug text, name text, suspended boolean)
language sql stable security definer set search_path = public as $$
  select id, slug, name, suspended_at is not null from tenant where slug = p_slug
$$;

-- Turn pending invitations for a verified email into memberships; returns how many were claimed.
create function claim_invites(p_user uuid, p_email text) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into membership (tenant_id, user_id, role, unit_id)
    select tenant_id, p_user, role, unit_id from membership_invite where email = lower(p_email)
    on conflict do nothing;
  get diagnostics n = row_count;
  delete from membership_invite where email = lower(p_email);
  return n;
end $$;

-- Passes whose reminder or overstay notice is due, across tenants. Thresholds come from each tenant's
-- settings.passPolicy (defaults: reminders at 10h and 11h, overstay at 12h after check-in).
create function due_pass_reminders(p_now timestamptz) returns table (tenant_id uuid, pass_id uuid, kind text)
language sql stable security definer set search_path = public as $$
  select p.tenant_id, p.id, k.kind
  from pass p
  join session s on s.id = p.session_id and s.status = 'open'
  join tenant t on t.id = p.tenant_id
  cross join lateral (values
    ('reminder_1', coalesce((t.settings->'passPolicy'->'reminderHours'->>0)::numeric, 10)),
    ('reminder_2', coalesce((t.settings->'passPolicy'->'reminderHours'->>1)::numeric, 11)),
    ('overstay',   coalesce((t.settings->'passPolicy'->>'maxStayHours')::numeric, 12))
  ) as k(kind, hours)
  where p.status = 'checked_in' and t.suspended_at is null
    and s.in_at + make_interval(secs => (k.hours * 3600)::double precision) <= p_now
    and not exists (select 1 from pass_notification n where n.pass_id = p.id and n.kind = k.kind and (n.status in ('sent', 'skipped') or n.attempts >= 5))
$$;

-- Platform (super admin) operations.
create function platform_tenants() returns table (
  id uuid, slug text, name text, country text, created_at timestamptz, suspended_at timestamptz, suspended_reason text,
  members int, sites int, open_sessions int)
language sql stable security definer set search_path = public as $$
  select t.id, t.slug, t.name, t.country, t.created_at, t.suspended_at, t.suspended_reason,
    (select count(*)::int from membership m where m.tenant_id = t.id),
    (select count(*)::int from site s where s.tenant_id = t.id and s.retired_at is null),
    (select count(*)::int from session x where x.tenant_id = t.id and x.status = 'open')
  from tenant t order by t.created_at desc
$$;

create function platform_set_suspended(p_slug text, p_suspend boolean, p_reason text, p_actor uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare tid uuid;
begin
  update tenant set suspended_at = case when p_suspend then now() else null end,
                    suspended_reason = case when p_suspend then p_reason else null end
    where slug = p_slug returning id into tid;
  if tid is null then return false; end if;
  insert into audit_event (tenant_id, actor_id, action, entity, after)
    values (tid, p_actor, case when p_suspend then 'platform.suspend' else 'platform.resume' end, 'tenant:' || p_slug,
            jsonb_build_object('reason', p_reason));
  return true;
end $$;

-- New functions are executable by PUBLIC by default; only the app role may call them.
revoke execute on function user_memberships, tenant_by_slug, claim_invites, due_pass_reminders, platform_tenants, platform_set_suspended from public;
grant execute on function user_memberships, tenant_by_slug, claim_invites, due_pass_reminders, platform_tenants, platform_set_suspended to openpark_app;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
    end if;
  end loop;
end $$;
