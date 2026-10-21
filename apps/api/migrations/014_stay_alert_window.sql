-- Supervisors are alerted about cars that crossed a threshold recently, not about every stay ever left open:
-- on first deploy, stays open for days would otherwise each send a message.
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
    and s.in_at > p_now - interval '48 hours'
    and s.in_at + make_interval(secs => (k.hours * 3600)::double precision) <= p_now
    and not exists (select 1 from stay_alert a where a.session_id = s.id and a.kind = k.kind and (a.status in ('sent', 'skipped') or a.attempts >= 5))
$$;
