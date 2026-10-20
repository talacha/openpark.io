-- Webhook deliveries that survive without a long-running worker: one attempt right away, failures are retried by the
-- periodic cron tick with backoff (no function ever sleeps while waiting to retry).
create table webhook_delivery (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  event text not null,
  payload jsonb not null,
  at timestamptz not null default now(),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'delivered', 'dead')),
  last_error text
);
create index on webhook_delivery (next_attempt_at) where status = 'pending';

alter table webhook_delivery enable row level security;
create policy tenant_isolation on webhook_delivery using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
grant select, insert, update on webhook_delivery to openpark_app;

create function due_webhook_deliveries(p_now timestamptz, p_limit int) returns table (id uuid, tenant_id uuid)
language sql stable security definer set search_path = public as $$
  select d.id, d.tenant_id from webhook_delivery d join tenant t on t.id = d.tenant_id
  where d.status = 'pending' and d.next_attempt_at <= p_now and t.suspended_at is null
  order by d.next_attempt_at limit p_limit
$$;
revoke execute on function due_webhook_deliveries from public;
grant execute on function due_webhook_deliveries to openpark_app;

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
