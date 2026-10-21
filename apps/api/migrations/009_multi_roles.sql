-- People can hold several roles at once. Roles, least to most access: resident, attendant, supervisor, admin.
-- (Super Admin is a platform-wide flag on the user, not a membership role.) `owner` is retired: owners become admins,
-- and auditors, who were read-only, become attendants.
alter table membership add column roles text[];
update membership set roles = case role when 'owner' then array['admin'] when 'auditor' then array['attendant'] else array[role] end;
alter table membership alter column roles set not null;
alter table membership drop constraint membership_resident_has_unit;
alter table membership drop constraint membership_role_check;
alter table membership drop column role;
alter table membership add constraint membership_roles_valid
  check (cardinality(roles) > 0 and roles <@ array['resident', 'attendant', 'supervisor', 'admin']);
alter table membership add constraint membership_resident_has_unit check (not ('resident' = any(roles)) or unit_id is not null);

alter table membership_invite add column roles text[];
update membership_invite set roles = case role when 'owner' then array['admin'] when 'auditor' then array['attendant'] else array[role] end;
alter table membership_invite alter column roles set not null;
alter table membership_invite drop constraint membership_invite_role_check;
alter table membership_invite drop constraint membership_invite_check;
alter table membership_invite drop column role;
alter table membership_invite add constraint membership_invite_roles_valid
  check (cardinality(roles) > 0 and roles <@ array['resident', 'attendant', 'supervisor', 'admin']);
alter table membership_invite add constraint membership_invite_resident_has_unit check (not ('resident' = any(roles)) or unit_id is not null);

update api_key set role = 'admin' where role = 'owner';
update api_key set role = 'attendant' where role = 'auditor';

drop function user_memberships(uuid);
create function user_memberships(p_user uuid)
returns table (tenant_id uuid, slug text, name text, roles text[], unit_id uuid, suspended boolean)
language sql stable security definer set search_path = public as $$
  select m.tenant_id, t.slug, t.name, m.roles, m.unit_id, t.suspended_at is not null
  from membership m join tenant t on t.id = m.tenant_id where m.user_id = p_user
$$;

create or replace function claim_invites(p_user uuid, p_email text) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into membership (tenant_id, user_id, roles, unit_id)
    select tenant_id, p_user, roles, unit_id from membership_invite where email = lower(p_email)
    on conflict do nothing;
  get diagnostics n = row_count;
  delete from membership_invite where email = lower(p_email);
  return n;
end $$;

revoke execute on function user_memberships from public;
grant execute on function user_memberships to openpark_app;

-- Supervisors are told when ANY car passes the stay thresholds (10 h, 11 h, 12 h by default), not only guest-pass stays.
create table stay_alert (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  session_id uuid not null references session(id) on delete cascade,
  kind text not null check (kind in ('reminder_1', 'reminder_2', 'overstay')),
  status text not null default 'pending' check (status in ('pending', 'sent', 'skipped', 'failed')),
  attempts int not null default 0,
  detail jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (session_id, kind)
);
alter table stay_alert enable row level security;
create policy tenant_isolation on stay_alert using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
grant select, insert, update on stay_alert to openpark_app;

create function due_stay_alerts(p_now timestamptz) returns table (tenant_id uuid, session_id uuid, kind text)
language sql stable security definer set search_path = public as $$
  select s.tenant_id, s.id, k.kind
  from session s
  join tenant t on t.id = s.tenant_id
  cross join lateral (values
    ('reminder_1', coalesce((t.settings->'passPolicy'->'reminderHours'->>0)::numeric, 10)),
    ('reminder_2', coalesce((t.settings->'passPolicy'->'reminderHours'->>1)::numeric, 11)),
    ('overstay',   coalesce((t.settings->'passPolicy'->>'maxStayHours')::numeric, 12))
  ) as k(kind, hours)
  where s.status = 'open' and t.suspended_at is null
    and s.in_at + make_interval(secs => (k.hours * 3600)::double precision) <= p_now
    and not exists (select 1 from stay_alert a where a.session_id = s.id and a.kind = k.kind and (a.status in ('sent', 'skipped') or a.attempts >= 5))
$$;
revoke execute on function due_stay_alerts from public;
grant execute on function due_stay_alerts to openpark_app;

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
