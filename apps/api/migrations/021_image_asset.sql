-- Optimised images live in Postgres as a BLOB, keyed by a deterministic hash of their identity
-- (tenant + type + subject + event/action + optional department number). Re-uploading the same identity
-- replaces the row instead of creating another object, so avatars and enforcement evidence are idempotent.
create table image_asset (
  tenant_id uuid not null references tenant(id) on delete cascade,
  key text not null,
  type text not null,
  subject_kind text not null check (subject_kind in ('email', 'plate', 'text')),
  subject text not null,
  region text,
  event text,
  department_number text,
  mime text not null,
  data bytea not null,
  bytes int not null check (bytes > 0 and bytes <= 10 * 1024 * 1024),
  width int not null check (width > 0),
  height int not null check (height > 0),
  sha256 text not null,
  created_at timestamptz(6) not null default clock_timestamp(),
  updated_at timestamptz(6) not null default clock_timestamp(),
  primary key (tenant_id, key)
);

-- WebP/JPEG payloads are already compressed; skip TOAST compression on the blob itself.
alter table image_asset alter column data set storage external;

create index image_asset_subject on image_asset (tenant_id, type, subject);

alter table image_asset enable row level security;
create policy tenant_isolation on image_asset using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
grant select, insert, update on image_asset to openpark_app;
