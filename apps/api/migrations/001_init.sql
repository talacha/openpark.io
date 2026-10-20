-- OpenPark v1 schema. Every tenant-owned table carries tenant_id and an RLS policy
-- comparing it to app.tenant_id, which the API sets per transaction.

do $$ begin
  if not exists (select from pg_roles where rolname = 'openpark_app') then
    create role openpark_app login password 'openpark_app';
  end if;
end $$;

create function app_tenant() returns uuid language sql stable as
$$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;

create table tenant (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}$'),
  name text not null,
  country text,
  default_locale text not null default 'en',
  locales text[] not null default '{en}',
  currency char(3) not null default 'USD',
  plate_regions text[] not null default '{}',
  ai_mode text not null default 'off' check (ai_mode in ('off', 'assist', 'auto')),
  slot_types jsonb not null default '[]',
  terminology jsonb not null default '{}',
  settings jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table app_user (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text,
  password_hash text not null,
  locale text,
  created_at timestamptz not null default now()
);

create table membership (
  tenant_id uuid not null references tenant(id) on delete cascade,
  user_id uuid not null references app_user(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'supervisor', 'attendant', 'auditor')),
  primary key (tenant_id, user_id)
);

create table api_key (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  site_id uuid,
  name text not null,
  prefix text not null,
  key_hash text not null unique,
  role text not null default 'attendant',
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table rate_plan (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  site_id uuid,
  name text not null,
  version int not null,
  rules jsonb not null,
  currency char(3) not null,
  tax_mode text not null default 'none',
  active_from timestamptz not null default now(),
  unique (tenant_id, site_id, name, version)
);

create table site (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  code text not null,
  name text not null,
  timezone text not null,
  address text,
  default_rate_plan_id uuid references rate_plan(id),
  settings jsonb not null default '{"aiThreshold": 0.95}',
  retired_at timestamptz,
  unique (tenant_id, code)
);
alter table rate_plan add foreign key (site_id) references site(id) on delete cascade;
alter table api_key add foreign key (site_id) references site(id) on delete cascade;

create table zone (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  site_id uuid not null references site(id) on delete cascade,
  code text not null,
  name text not null,
  labels jsonb not null default '{}',
  level int,
  sort int not null default 0,
  unique (site_id, code)
);

create table slot (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  site_id uuid not null references site(id) on delete cascade,
  zone_id uuid not null references zone(id) on delete cascade,
  code text not null,
  type text not null,
  attributes jsonb not null default '{}',
  status text not null default 'available' check (status in ('available', 'occupied', 'reserved', 'out_of_service')),
  assignment jsonb,
  ext_ref text,
  note text,
  retired_at timestamptz,
  unique (site_id, code)
);
create index on slot (site_id, status, type) where retired_at is null;

create table vehicle (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  plate_display text not null,
  plate_norm text not null,
  plate_region text not null,
  plate_class text,
  body_type text,
  make text,
  model text,
  color text,
  year int,
  unique (tenant_id, plate_region, plate_norm)
);

create table account (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  name text not null,
  contact text,
  external_ref text
);

create table permit (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  account_id uuid references account(id),
  ref text not null,
  vehicle_ids uuid[] not null default '{}',
  slot_id uuid references slot(id),
  kind text not null default 'monthly',
  rate_plan_id uuid references rate_plan(id),
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  unique (tenant_id, ref)
);

create table device (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  site_id uuid not null references site(id) on delete cascade,
  kind text not null check (kind in ('phone', 'ip_camera', 'gate')),
  name text not null,
  lane text,
  direction text check (direction in ('in', 'out', 'both'))
);

create table session (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  site_id uuid not null references site(id),
  vehicle_id uuid not null references vehicle(id),
  slot_id uuid references slot(id),
  ticket_code text not null,
  in_at timestamptz not null,
  out_at timestamptz,
  in_by uuid,
  out_by uuid,
  rate_plan_id uuid references rate_plan(id),
  fee int,
  fee_breakdown jsonb,
  status text not null default 'open' check (status in ('open', 'closed', 'void')),
  unique (tenant_id, ticket_code)
);
create unique index session_one_open_per_vehicle on session (tenant_id, site_id, vehicle_id) where status = 'open';
create index on session (tenant_id, site_id, in_at desc);

create table session_event (
  id bigserial primary key,
  tenant_id uuid not null references tenant(id) on delete cascade,
  session_id uuid not null references session(id),
  type text not null,
  actor_id uuid,
  device_id uuid,
  gate text,
  server_at timestamptz not null default now(),
  device_at timestamptz,
  payload jsonb not null default '{}'
);
create index on session_event (session_id, id);

create table plate_read (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  session_id uuid references session(id),
  device_id uuid,
  crop_key text,
  text_raw text,
  text_norm text,
  region text,
  confidence real,
  engine text,
  latency_ms int,
  corrected_to text,
  decided_by text,
  created_at timestamptz not null default now()
);

create table audit_event (
  id bigserial primary key,
  tenant_id uuid not null references tenant(id) on delete cascade,
  actor_id uuid,
  action text not null,
  entity text,
  before jsonb,
  after jsonb,
  at timestamptz not null default now()
);

create table idempotency_key (
  tenant_id uuid not null references tenant(id) on delete cascade,
  key text not null,
  request_hash text not null,
  status int not null,
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (tenant_id, key)
);

create table inventory_import (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  mode text not null check (mode in ('merge', 'replace')),
  status text not null default 'previewed' check (status in ('previewed', 'applied', 'rolled_back')),
  doc jsonb not null,
  diff jsonb not null,
  snapshot jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  applied_at timestamptz
);

create table webhook_endpoint (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  url text not null,
  secret text not null,
  events text[] not null default '{}',
  active boolean not null default true
);

-- Row-level security: tenant_id must equal the per-transaction setting.
do $$
declare t text;
begin
  foreach t in array array['membership','api_key','rate_plan','site','zone','slot','vehicle','account','permit',
    'device','session','session_event','plate_read','audit_event','idempotency_key','inventory_import','webhook_endpoint']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant()) with check (tenant_id = app_tenant())', t);
  end loop;
end $$;
alter table tenant enable row level security;
create policy tenant_isolation on tenant using (id = app_tenant()) with check (id = app_tenant());

-- Privileges: the app role cannot rewrite history or used rate plans.
grant usage on schema public to openpark_app;
grant select, insert, update, delete on tenant, membership, api_key, site, zone, slot, vehicle, account, permit,
  device, session, plate_read, idempotency_key, inventory_import, webhook_endpoint to openpark_app;
grant select, insert, update on app_user to openpark_app;
grant select, insert on rate_plan, session_event, audit_event to openpark_app;
grant usage, select on all sequences in schema public to openpark_app;

-- Cross-tenant lookups that must work before a tenant context exists.
create function create_tenant(p_slug text, p_name text, p_country text, p_locale text, p_currency text,
  p_timezone text, p_regions text[]) returns uuid language plpgsql security definer set search_path = public as $$
declare tid uuid;
begin
  insert into tenant (slug, name, country, default_locale, locales, currency, plate_regions)
  values (p_slug, p_name, p_country, p_locale, array[p_locale], p_currency, p_regions) returning id into tid;
  return tid;
end $$;

create function user_memberships(p_user uuid) returns table (tenant_id uuid, slug text, name text, role text)
language sql stable security definer set search_path = public as $$
  select m.tenant_id, t.slug, t.name, m.role from membership m join tenant t on t.id = m.tenant_id where m.user_id = p_user
$$;

create function resolve_api_key(p_hash text) returns table (tenant_id uuid, site_id uuid, role text)
language sql stable security definer set search_path = public as $$
  select tenant_id, site_id, role from api_key where key_hash = p_hash and revoked_at is null
$$;

-- Notify listeners (SSE hub) after commit.
create function emit_event(p_tenant uuid, p_type text, p_payload jsonb) returns void language sql as $$
  select pg_notify('openpark_events', jsonb_build_object('tenant', p_tenant, 'type', p_type, 'data', p_payload)::text)
$$;

grant execute on function create_tenant, user_memberships, resolve_api_key, emit_event, app_tenant to openpark_app;
