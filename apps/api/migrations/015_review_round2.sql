-- Stay alerts look back far enough for every configured threshold (policy allows up to 72 h), and idempotency records expire.
create or replace function due_stay_alerts(p_now timestamptz) returns table (tenant_id uuid, session_id uuid, kind text)
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
    and s.in_at + make_interval(secs => ((k.hours + 24) * 3600)::double precision) > p_now   -- alert within a day of the threshold, never for stays long overdue
    and not exists (select 1 from stay_alert a where a.session_id = s.id and a.kind = k.kind and (a.status in ('sent', 'skipped') or a.attempts >= 5))
$$;

create function purge_idempotency_keys(p_days int) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from idempotency_key where created_at < now() - make_interval(days => p_days);
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function purge_idempotency_keys from public;
grant execute on function purge_idempotency_keys to openpark_app;
