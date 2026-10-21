-- Platform (super-admin) writes are not scoped to a tenant, so they cannot use the per-tenant
-- `idempotency_key` table (tenant create has no tenant yet, and its RLS needs app.tenant_id set).
-- This actor-scoped store lets `definePlatformRoute` reserve a (super admin, key) pair, run the write
-- once, and replay the committed response when the same key is retried after a lost response — or
-- return 409 while the first is still in flight. That makes one Super Admin action create exactly one
-- organisation / membership instead of two (the auto-suffixed-slug duplicate it would otherwise create).
create table platform_idempotency_key (
  actor_id uuid not null references app_user(id) on delete cascade,
  key text not null,
  request_hash text not null,
  status int not null,            -- 0 while in flight; the final HTTP status once committed
  response jsonb,                 -- one-time secrets (temporaryPassword) are never stored (stripped on write)
  created_at timestamptz not null default now(),
  primary key (actor_id, key)
);

-- Global table, like `app_user`: RLS on and reachable only by the app role, so the Supabase Data API
-- roles (anon, authenticated) get nothing even though it lives in the public schema.
alter table platform_idempotency_key enable row level security;
create policy app_access on platform_idempotency_key to openpark_app using (true) with check (true);
grant select, insert, update, delete on platform_idempotency_key to openpark_app;
