alter table enforcement_case
  add column fine_issued_at timestamptz(6),
  add column immobilized_at timestamptz(6);

update enforcement_case set fine_issued_at = created_at where action = 'fine';
update enforcement_case set immobilized_at = created_at where action = 'immobilization';

create table enforcement_evidence (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  case_id uuid not null references enforcement_case(id) on delete cascade,
  image_key text not null,
  actor_id uuid,
  created_at timestamptz(6) not null default clock_timestamp()
);
create index enforcement_evidence_case on enforcement_evidence (case_id, created_at, id);

alter table enforcement_evidence enable row level security;
create policy tenant_isolation on enforcement_evidence using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
grant select, insert on enforcement_evidence to openpark_app;
grant update (fine_issued_at, immobilized_at, evidence_key) on enforcement_case to openpark_app;

insert into enforcement_evidence (tenant_id, case_id, image_key, actor_id, created_at)
select tenant_id, id, evidence_key, actor_id, created_at from enforcement_case where evidence_key is not null;
