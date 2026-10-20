-- Supabase's linter: functions without a fixed search_path can be hijacked by objects in an earlier schema.
-- These two only use built-ins, so pin them to pg_catalog.
alter function app_tenant() set search_path = pg_catalog;
alter function emit_event(uuid, text, jsonb) set search_path = pg_catalog;
