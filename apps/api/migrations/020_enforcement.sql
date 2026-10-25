create table enforcement_case (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  site_id uuid not null references site(id),
  session_id uuid references session(id),
  vehicle_id uuid references vehicle(id),
  plate_display text,
  plate_region text,
  reasons text[] not null check (cardinality(reasons) > 0 and reasons <@ array['overstay', 'not_checked_in', 'wrong_slot']),
  action text not null check (action in ('fine', 'immobilization')),
  unit_id uuid references unit(id),
  amount_minor int,
  currency text,
  evidence_key text,
  actor_id uuid,
  created_at timestamptz(6) not null default clock_timestamp(),
  check (
    (action = 'fine' and unit_id is not null and amount_minor = 500000 and currency = 'MXN' and evidence_key is null)
    or (action = 'immobilization' and unit_id is null and amount_minor is null and currency is null and evidence_key is not null)
  )
);
create index enforcement_case_recent on enforcement_case (tenant_id, created_at desc);
create index enforcement_case_session on enforcement_case (session_id) where session_id is not null;

alter table enforcement_case enable row level security;
create policy tenant_isolation on enforcement_case using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
grant select, insert on enforcement_case to openpark_app;
