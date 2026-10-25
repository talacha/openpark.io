-- Sync concurrency: session_event ordering, idempotency, advisory locks for in-flight duplicates
-- Package P2 (OS-02, OS-03, OS-04, OS-09, OS-10)

-- 1. Plain sequence for gapless, commit-ordered server_seq per tenant
-- per PLAN: "server_seq comes from the database (clock_timestamp(), a sequence)"
-- Using a plain sequence avoids locking one row per tenant which would serialize all writes.
create sequence if not exists session_event_server_seq;

-- RLS is not needed - the sequence is not per-tenant. openpark_app needs USAGE to get nextval.
grant usage, select on sequence session_event_server_seq to openpark_app;

-- 2. session_event: add ordering and timing columns (append-only table stays insert-only)
-- device_id: UUID from X-Device-Id header
-- client_seq: monotonically increasing integer from X-Client-Seq header
-- server_seq: gapless, commit-ordered sequence from session_event_server_seq
-- effective_at: the authoritative timestamp for ordering (derived from deviceAt/receivedAt per rules)
-- received_at: clock_timestamp() at time of insert (server arrival time)
-- clock_flag: stored as text[] to hold 'clock_ahead', 'clock_gap' or empty
-- Note: No NOT NULL default on received_at/effective_at - readers use coalesce(received_at, server_at)
alter table session_event
  add column if not exists device_id   uuid,
  add column if not exists client_seq  bigint,
  add column if not exists server_seq  bigint default nextval('session_event_server_seq'),
  add column if not exists received_at timestamptz(6),
  add column if not exists effective_at timestamptz(6),
  add column if not exists clock_flag  text[] check (clock_flag is null or clock_flag <@ array['clock_ahead', 'clock_gap']);

-- Backfill received_at from server_at for legacy rows only where explicitly null
update session_event set received_at = server_at where received_at is null;

-- Backfill effective_at from server_at for legacy rows only where explicitly null
update session_event set effective_at = server_at where effective_at is null;

-- Indexes for efficient queries
-- Primary ordering index: (tenant_id, server_seq) for SSE cursor and event ordering
create index if not exists session_event_server_seq on session_event (tenant_id, server_seq);

-- Composite index for session timeline queries: (session_id, effective_at, device_id, client_seq, server_seq)
create index if not exists session_event_session_effective on session_event (session_id, effective_at, device_id, client_seq, server_seq);

-- 3. session: add version, updated_at, and microsecond columns
-- version: optimistic concurrency control (increments on each update)
-- updated_at: timestamp of last modification
-- in_received_at, out_received_at: server receipt timestamps (for ordering)
-- in_effective_at, out_effective_at: authoritative timestamps for billing
-- needs_review: flag for clock skew or other issues requiring supervisor approval (not used in iteration 1)
-- fee_provisional: flag for provisional fees that may be adjusted on review
alter table session
  alter column in_at type timestamptz(6) using in_at::timestamptz(6),
  alter column out_at type timestamptz(6) using out_at::timestamptz(6),
  add column if not exists version bigint not null default 1,
  add column if not exists updated_at timestamptz(6) not null default clock_timestamp(),
  add column if not exists in_received_at timestamptz(6),
  add column if not exists out_received_at timestamptz(6),
  add column if not exists in_effective_at timestamptz(6),
  add column if not exists out_effective_at timestamptz(6),
  add column if not exists needs_review boolean not null default false,
  add column if not exists fee_provisional boolean not null default false;

-- Backfill received_at for existing sessions only where null (no rewrite, no stamping)
update session set in_received_at = in_at where in_received_at is null;
update session set out_received_at = out_at where out_received_at is null;

-- 4. Version + updated_at on mutable aggregates (site, zone, slot, unit, tenant, membership)
alter table site
  add column if not exists version bigint not null default 1,
  add column if not exists updated_at timestamptz(6) not null default clock_timestamp();

alter table zone
  add column if not exists version bigint not null default 1,
  add column if not exists updated_at timestamptz(6) not null default clock_timestamp();

alter table slot
  add column if not exists version bigint not null default 1,
  add column if not exists updated_at timestamptz(6) not null default clock_timestamp();

alter table unit
  add column if not exists version bigint not null default 1,
  add column if not exists updated_at timestamptz(6) not null default clock_timestamp();

alter table tenant
  add column if not exists version bigint not null default 1,
  add column if not exists updated_at timestamptz(6) not null default clock_timestamp();

alter table membership
  add column if not exists version bigint not null default 1,
  add column if not exists updated_at timestamptz(6) not null default clock_timestamp();

-- 5. Bump version trigger: increments version and updated_at on row changes
-- Uses row comparison to avoid bumping on no-op updates
-- security invoker: the trigger runs as the table owner/updater, no definer needed
create or replace function bump_version() returns trigger
language plpgsql security invoker set search_path = pg_catalog as $$
begin
  if row(new.*) is distinct from row(old.*) then
    new.version := old.version + 1;
    new.updated_at := clock_timestamp();
  end if;
  return new;
end $$;

-- Apply trigger to all versioned tables
do $$
declare t text;
begin
  foreach t in array array['site', 'zone', 'slot', 'unit', 'tenant', 'membership', 'session'] loop
    execute format('drop trigger if exists %I on %I', t || '_bump', t);
    execute format('create trigger %I before update on %I for each row execute function bump_version()', t || '_bump', t);
  end loop;
end $$;

-- Revoke EXECUTE from PUBLIC as per convention from migrations 002 onward
revoke execute on function bump_version() from public;

-- 6. idempotency_key: add mutation_id, client_at for offline queue correlation, and state for reservation-first pattern
-- migration 018 introduced platform_idempotency_key, so this extends the existing tenant-scoped table
alter table idempotency_key
  add column if not exists mutation_id uuid,
  add column if not exists client_at timestamptz(6),
  add column if not exists state text not null default 'done' check (state in ('pending', 'done'));

-- 7. Ensure openpark_app has proper grants
-- session_event is insert-only for openpark_app, so no UPDATE/DELETE grants needed
-- (already handled in 001_init.sql)

-- 8. Add index on effective_at for efficient queries
create index if not exists session_event_effective_at on session_event (tenant_id, effective_at, device_id, client_seq);

-- 9. Drop unused (id, version) indexes - they defeat HOT updates since version changes on every row update
-- The primary key index on id alone is sufficient for lookups
drop index if exists session_version;
drop index if exists site_version;
drop index if exists zone_version;
drop index if exists slot_version;
drop index if exists unit_version;

-- 10. Drop idempotency_key_state index - no query uses (tenant_id, state)
drop index if exists idempotency_key_state;
