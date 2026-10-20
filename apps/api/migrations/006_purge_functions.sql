-- The nightly plate-image purge must see every tenant's rows, but the API should never hold owner credentials.
-- Two narrow SECURITY DEFINER functions let the app role do exactly this and nothing more.
create function expired_plate_crops(p_limit int) returns table (id uuid, crop_key text)
language sql stable security definer set search_path = public as $$
  select r.id, r.crop_key from plate_read r join tenant t on t.id = r.tenant_id
  where r.crop_key is not null
    and r.created_at < now() - make_interval(days => coalesce((t.settings->>'retentionDays')::int, 30))
  order by r.created_at limit p_limit
$$;

create function clear_plate_crop(p_id uuid) returns void
language sql security definer set search_path = public as $$
  update plate_read set crop_key = null where id = p_id
$$;

revoke execute on function expired_plate_crops, clear_plate_crop from public;
grant execute on function expired_plate_crops, clear_plate_crop to openpark_app;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select from pg_roles where rolname = r) then
      execute format('revoke all on all functions in schema public from %I', r);
    end if;
  end loop;
end $$;
