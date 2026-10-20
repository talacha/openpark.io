-- Supabase serves the `public` schema over its Data API (PostgREST) to the `anon` and `authenticated`
-- roles. OpenPark talks to Postgres only as `openpark_app`, so close every door those roles could use.
-- Harmless on plain Postgres (the roles simply do not exist there).

-- Tables without RLS were readable by anyone holding the public anon key (password hashes!).
alter table app_user enable row level security;
alter table schema_migration enable row level security;
drop policy if exists app_access on app_user;
create policy app_access on app_user to openpark_app using (true) with check (true);

-- Functions are executable by PUBLIC by default, so the SECURITY DEFINER ones were callable as RPC.
revoke execute on all functions in schema public from public;
grant execute on function create_tenant, user_memberships, resolve_api_key, emit_event, app_tenant to openpark_app;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
      -- Supabase grants these roles access to every FUTURE table by default; undo that too.
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
      execute format('alter default privileges in schema public revoke all on functions from %I', r);
    end if;
  end loop;
end $$;
