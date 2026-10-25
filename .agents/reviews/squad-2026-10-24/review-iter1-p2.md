# Adversarial review, iteration 1, package P2 (API concurrency + microsecond time)

Reviewer: review-p2 (read-only on source). Branch `squad/2026-10-24`, working tree as found at 14:06 MDT.
Scope read: `PLAN.md`, `audit-offline-sync.md`, `git diff` of `apps/api/**` and `packages/core/src/index.ts`, untracked `apps/api/migrations/019_sync_concurrency.sql`, `apps/api/src/time.ts`, `packages/core/src/time.ts`, `packages/core/test/time.test.ts`, plus P1's `apps/web/src/sync/engine.ts` for the contract match.

## Summary

Most of what the P2 summary lists as done exists only as schema and an unused helper. The new columns, `next_tenant_seq()` and `resolveEffectiveAt()` are never called from a request path. A live probe shows `effective_at` and `server_seq` NULL on every new event, `out_at` still taken from `app.now()`, and an offline check-out with `payment.amount: 0` recorded as a $0 payment. There is no `If-Match`, `ETag`, 412, `/v1/healthz` or rate-plan race fix. The reservation-first idempotency works for the happy path but blocks instead of returning `409 request_in_progress` and can starve the connection pool. The P2 summary overstates what was delivered; treat OS-02, OS-03, OS-04, OS-10, OS-20 and CR-32 (server side) as not done.

Evidence is from running code, not just reading: the `pnpm --filter @openpark/core build` + `exec vitest run` and `pnpm --filter @openpark/api exec vitest run` runs below, a throwaway API probe file (deleted afterwards), a throwaway `resolveEffectiveAt` boundary script (deleted), and `psql` experiments inside a rolled-back transaction.

## Commands run

| Command | Result |
| --- | --- |
| `pnpm --filter @openpark/core build` | PASS |
| `pnpm --filter @openpark/core exec vitest run` | PASS, 65 tests (29 in `time.test.ts`) |
| `pnpm --filter @openpark/api exec vitest run` | 134 pass, 1 fail: `serverless-cost.test.ts > durable webhook retries` |
| API probe tests (8 + 4 cases, scratch file `test/zz-r2-probe.test.ts`, deleted) | all informational, results quoted below |
| `resolveEffectiveAt` boundary script (scratch, deleted) | results quoted in R2-08 |
| `psql` rewrite and timezone experiments (rolled back, temp tables only) | results quoted in R2-11 and R2-16 |

The one failing API test is not caused by P2. The Postgres container clock is 54 minutes behind the host (`date -u` on host 20:08, in `openpark-pg` 19:14). The test compares DB `now()` + backoff with host `Date.now()`. It is environmental, but it does show that Node and DB clocks can differ by a lot, which matters for R2-10.

No new API test file exists (`git status --porcelain apps/api/test` is empty). The "134 passed" line therefore says nothing about P2 behaviour.

---

## Findings

### R2-01 · blocking · The sync columns and helpers are never used; ordering and `effective_at` are not delivered

Evidence: `grep -rn "resolveEffectiveAt\|next_tenant_seq\|serverMicroTs" apps/api/src` only matches the definitions. `addEvent` (`services/sessions.ts:47-54`) accepts `serverSeq` but no caller passes it. Probe A (check-in, then SELECT of the event rows): `{"type":"check_in","server_seq":null,"effective_at":null,"client_seq":null,"device_id":null}` and the same for `slot_assigned`. `session.in_effective_at`, `in_received_at`, `needs_review`, `fee_provisional` are never written either. PLAN "Ordering on the server" is therefore not met: rows cannot be ordered by `(effective_at, device_id, client_seq, server_seq)`.

Fix (coder):
1. In `services/sessions.ts` add `async function receivedAt(db): Promise<MicroTs>` = `select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`. Call it once at the top of `checkIn` and `checkOut` and pass the same value to every `addEvent` of the request.
2. Call `resolveEffectiveAt({ clientAt: input.deviceAt, receivedAt, ... })` in `checkIn` and `checkOut` (see R2-08 for the rule fixes). Use `verdict.effectiveAt` for `session.in_at` / `out_at` and for the fee, and persist `received_at` (DB default is fine), `effective_at`, `clock_flag`, `device_id`, `client_seq`, `server_seq` on every `session_event` insert in `addEvent`.
3. Change `addEvent` so `server_seq` is allocated inside it (`select next_tenant_seq()` or `nextval`, see R2-14) instead of being an optional caller argument. Remove the `serverSeq` parameter. Without this a forgotten call site silently writes NULL.
4. Add the index-ordered read: `GET /v1/sessions/:id/events` (`routes/sessions.ts:238`) already selects the new columns, so change `order by e.id` to `order by coalesce(e.effective_at, e.server_at), e.device_id, e.client_seq, e.server_seq, e.id`.
5. Add an API test: check-in with `deviceAt` 2 h in the past (see R2-03 for how it is sent), assert `session_event.effective_at = deviceAt` to the microsecond and `server_seq` strictly increasing within the tenant.

### R2-02 · blocking · Offline check-out still prices at replay time and records a $0 payment

Evidence: `services/sessions.ts:241` `const now = app.now();` then `quote(db, s, now, ...)` and `out_at = $2` (`now`). `deviceAt` is only used for the `device_clock_gap` warning (`:96`) and stored in `device_at`. Probe K: `POST /v1/sessions/:id/checkout` with `{ deviceAt: <now-3h as MicroTs>, offline: true, payment: { method:'cash', amount: 0 } }` returned `200`, `minutes: 0`, `fee.total: 0` (the fake test clock), `outAt == inAt`, and a `payment` event with `amount: 0` and `effective_at: null`. PLAN "Offline check-out pricing": "The queue never records a $0 payment ... the server prices the stay at `effective_at` with the rate plan that was active then." The server accepted the $0 payment without complaint.

Fix (coder):
1. `checkOut`: compute `verdict = resolveEffectiveAt(...)` (R2-01/R2-08), then `outAt = verdict.effectiveAt`. Clamp `outAt` to `>= in_at` and flag `negative_clamped` (OS-14: a `RangeError` from `computeFee` is currently an unhandled 500).
2. Price with `quote(db, s, new Date(Number(parseMicroTs(outAt) / 1000n)), ...)`. A `Date` is fine for minute billing; it is not fine for storage, so write `out_at` from the µs string (`$2::timestamptz`), never from that `Date`.
3. Rate plan for check-in replay: `site.default_rate_plan_id` is read at replay time (`:142` area). Use the plan whose `active_from <= effectiveAt` ordered by `active_from desc` (OS-18; in PLAN scope only as "plan that was active then" for check-out, so at minimum honour the pinned `s.rate_plan_id` as today).
4. Payment: if `body.offline`-style replay (a `deviceAt` older than receivedAt - 300 s counts) and `payment.amount === 0` while `fee.total > 0`, do not record `amount: 0`. Reject with `422 {"code":"payment_amount_required"}` or record the payment with `amount = fee.total` and `payload.variance = { expected, tendered: 0 }`. Pick one and document it in the route summary. The client contract says the queue "never records a $0 payment", so the server must not accept one when the fee is positive.
5. Tests: (a) check-in at T, offline check-out with `deviceAt = T + 3 h` replayed 6 h later, assert `fee` is the 3 h price and `out_at = deviceAt`. (b) `payment.amount 0` with positive fee is rejected or flagged, per the choice above.

### R2-03 · blocking · The envelope the API reads is not the envelope P1 sends

Evidence: P1 `apps/web/src/sync/engine.ts:259-283` sends `Idempotency-Key`, headers `X-Device-Id` and `X-Client-Seq`, body `deviceAt`, optional header `If-Match`. The API never reads a header other than `idempotency-key` (`grep -n "x-device-id\|x-client-seq\|if-match" apps/api/src` is empty). It reads body fields `deviceId`, `clientSeq`, `offline` (`routes/sessions.ts:12-22`), which P1 does not send. `resolveEffectiveAt` additionally ignores `deviceAt` unless `offline === true` (`time.ts:~139`), so even a correct P1 request gets `effectiveAt = receivedAt`. P1 also sends the literal string `'unknown'` as device id when none is persisted (`engine.ts:263`), which `z.string().uuid()` would reject with a 400 if it were moved to the header path unvalidated.

Fix (coder):
1. In `routes/sessions.ts` read `req.headers['x-device-id']` and `req.headers['x-client-seq']`. Validate with `z.string().uuid().safeParse` and `z.coerce.number().int().min(0)`; on invalid values store NULL and add warning `device_id_invalid` instead of failing the write. Body `deviceId`/`clientSeq` stay as a fallback for old callers.
2. Delete the `offline` input from the contract path: the effective time must follow PLAN rules purely from `deviceAt` vs `receivedAt`. If the field is kept for telemetry, never let it change the pricing decision.
3. Add a cross-package test that sends exactly P1's envelope (`Idempotency-Key`, `X-Device-Id`, `X-Client-Seq`, body `deviceAt`) to `POST /v1/sessions` and asserts the stored `device_id`, `client_seq`, `effective_at`.
4. Note for the orchestrator (P1, not P2): `engine.ts:263` should not send `'unknown'`; omit the header instead.

### R2-04 · blocking · No optimistic concurrency is exposed: no `If-Match`, no `ETag`, no 412, rate-plan race not fixed

Evidence: only the version columns, the `bump_version()` trigger and five indexes exist. Nothing reads or returns `version`. Probe G: `PATCH /v1/slots/B1-001?site=DEMO-01` returned `200` with no `ETag` header and the body has no `version`; with `If-Match: "999"` it still returned `200`. Probe F: six concurrent `POST /v1/rate-plans` for the same new name returned `500,201,500,500,500,500` (unique violation on `(tenant_id, site_id, name, version)`). `git status` shows `routes/rates.ts`, `routes/slots.ts`, `routes/auth.ts` untouched. OS-10 and CR-32 server side are therefore not delivered.

Fix (coder):
1. New `apps/api/src/services/concurrency.ts`:
   ```ts
   export function parseIfMatch(h: string | string[] | undefined): number | null | 'invalid'
   // accepts `"7"`, `W/"7"`, and bare `7`; returns null when absent; 'invalid' for anything else (including `*` and lists with more than one tag)
   export async function updateIfVersion(db, table, where, expected, setSql, args): Promise<{ row }>   // `... where <where> and version = $n returning *`; zero rows => load current row in the SAME tenant tx and throw HttpError(412, 'version_mismatch', ..., { current, currentVersion })
   ```
   Missing `If-Match` on PATCH/DELETE of site, zone, slot, unit stays allowed in iteration 1 (log `x-openpark-warning: if_match_missing`); `invalid` is a 400.
2. Wire it into the PATCH/DELETE handlers of sites, zones, slots, units in `routes/slots.ts` and `routes/people.ts`. These files are not in the PLAN owner list for P2 except via "CR-32 (sites/zones/slots/units If-Match)", so list any edit outside `http.ts`/`sessions.ts` as a hand-off if the orchestrator disagrees.
3. Return `ETag: "<version>"` on GET-by-id and on the mutation response, and include `version` and `updatedAt` (MicroTs, see R2-10) in the body.
4. `current` in the 412 body must be loaded inside the same `withTenant` transaction (RLS scoped) and, for site-scoped API keys, filtered by `ctx.siteId`; the existing `already_inside` and `slot_unavailable` payloads follow that pattern, keep it. Never build `current` from a second raw connection.
5. Rate plans: in `POST /v1/rate-plans` take `select pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))` with `site.id` and `body.name` before computing `max(version)+1`. Test: 10 concurrent creates give versions 1..10 and no 5xx.
6. Add `ETag` and `Retry-After` to `exposedHeaders` (R2-15).

### R2-05 · high · `GET /v1/healthz` does not exist

Evidence: PLAN requires a new `GET /v1/healthz` returning `{ok:true,time}` with `Cache-Control: no-store`, keeping root `/healthz`. The diff only changes the root route (`server.ts:166`). Probe E: `/healthz` → `200 {"ok":true,"time":"2026-10-24T19:15:22.032120Z"}`; `/v1/healthz` → `404`. The web app on Vercel and the vite dev proxy only forward `/v1/*` (OS-05), so P1's connectivity probe cannot work.

Fix (coder): register both paths in `server.ts` with one handler:
```ts
for (const path of ['/healthz', '/v1/healthz']) app.get(path, async (_req, reply) => { reply.header('Cache-Control', 'no-store'); ... });
```
Use the UTC-safe SQL from R2-16. Add a test asserting status, `Cache-Control: no-store`, and the regex `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$` on `time` for both paths, without any auth header.

### R2-06 · high · In-flight duplicates block on a pooled connection instead of returning `409 request_in_progress` + `Retry-After: 1`; one slow request starves the tenant

Evidence: `http.ts:107-111` inserts the reservation inside the handler transaction. An uncommitted row is invisible to other sessions, so the `state === 'pending'` branch (`:127`) is dead; a concurrent duplicate waits inside `insert ... on conflict do nothing` until the first transaction ends. Probe I: with an uncommitted reservation held for 2.5 s the duplicate request waited 2526 ms and then ran as a fresh request (`201`, no `Retry-After`). Probe J: 12 duplicates blocked on one in-flight key; an unrelated `GET /v1/occupancy` for the same API process did not complete in 2 s (pool max 10, `db.ts:9`). That is the exact scenario PLAN lists (two tabs, timer + `online` event, retries after a timeout), and it turns an offline-sync retry storm into an API outage. The `23505` catch (`:165`) and the "row vanished" 409 (`:121`) are also dead or wrong (a vanished row means the owner rolled back, which should retry the reservation, not report "in progress").

Fix (coder):
1. At the top of the transaction, before the insert, take a non-blocking advisory lock: `select pg_try_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0)) as got` with `tenantId` and the key. If `got` is false, throw `HttpError(409, 'request_in_progress', ..., undefined, { 'Retry-After': '1' })` right away. Extend `HttpError` with an optional `headers` map and have the error handler (`server.ts:144`) apply them.
2. Keep the insert after the lock. Because the lock is held until the first request commits, a duplicate that gets the lock afterwards sees the committed row (`rowCount === 0`) and replays it.
3. Delete the `pending` state handling and the unreachable `23505` branch. If `state` is kept in the schema for future use, say so in the migration comment; otherwise drop the column (the existing `status = 0` sentinel is enough).
4. Test (API): hold a transaction that took the advisory lock for 1 s, send the duplicate, assert `409`, `Retry-After: 1`, and that the response arrives in under 200 ms. Add the 20-concurrent-identical-requests test from the audit (exactly one session, 19 replays).

### R2-07 · high · Regressions in the request schema

Evidence (all reproduced, probe C):
- `gate` was dropped. The old `Device` object had `gate`; the new `DeviceEnvelope` (`routes/sessions.ts:12-22`) does not, and zod strips unknown keys. `POST /v1/sessions` with `gate: 'G1'` stores `gate = NULL` on both events.
- Old ms ISO `deviceAt` is rejected. PLAN: "The API also accepts the old ms ISO form and pads it to µs". `deviceAt: '2026-10-24T10:00:00.123Z'` → `400 device_time_invalid`.
- `deviceAt` 6 years old (`2020-01-01T00:00:00.000000Z`) → `201`; PLAN: older than 48 h → `422 {"error":"device_time_out_of_window"}`.
- `deviceAt` in 2099 → `201`, `in_at` stays the server time, no `clock_ahead` flag stored.
- `CheckInBody` now silently accepts and ignores `payment`.

Fix (coder):
1. Add `gate: z.string().optional()` back to `DeviceEnvelope`.
2. One helper `normalizeDeviceAt(s?: string): MicroTs | undefined` in `time.ts`: accept MicroTs as is, otherwise `toMicroTs()` from core (ms ISO with `Z` or offset), and throw `HttpError(400,'device_time_invalid')` only when neither parses. Use it in all three handlers instead of the three copy-pasted `try/catch` blocks (also removes the unused `deviceAtUs` and `req` locals).
3. Enforce the 48 h window in the handler: `receivedAt - deviceAt > 48 h` → `HttpError(422,'device_time_out_of_window')`. This must happen before any write.
4. Remove `payment` from the check-in body.

### R2-08 · high · `resolveEffectiveAt` deviates from the contract and has a money-affecting hole

Boundary script results (receivedAt = `2026-10-24T16:31:33Z`):

| Case | Result | Verdict |
| --- | --- | --- |
| clientAt = +5.000000 s, offline | accepted as client time | OK (inclusive) |
| clientAt = +5.000001 s, offline | clamped, `clock_ahead` | OK |
| clientAt = -48 h exactly, offline | accepted, `clock_gap`, needsApproval | boundary OK |
| clientAt = -48 h - 1 µs, offline | server time, `stale`, needsApproval | WRONG, contract says reject 422 |
| clientAt = +6 s, **online** | server time, **no flag** | WRONG, contract says clamp + `clock_ahead` regardless |
| clientAt = -3 h, **online** (no `offline`) | server time, `clock_gap`, needsApproval | WRONG, deviceAt ignored (see R2-03) |
| clientAt = -3 h, offline | client time, `clock_gap`, **needsApproval = true** | needsApproval must be false in iteration 1 |
| offline, `clockOffsetMs = +9e9` | effectiveAt = **2027-02-05** | WRONG, unbounded |
| offline, `clockOffsetMs = -9e9` | effectiveAt = 2026-07-12 | WRONG, unbounded |
| garbage / ms-ISO `clientAt` | silently server time, no flag | WRONG, hides bad input |
| `maxPastHours = 0.07` | `BigInt(0.07 * 3600 * 1000 * 1000)` throws `RangeError` (float noise; 0.1, 0.3 and 1/3 happen to work). `maxPastUs` has no `Math.round`, `maxFutureUs` does | latent bug |

Money impact: `clockOffsetMs` is applied after the window check (`time.ts:195-199`) and is never re-clamped, so a client that sends it can move `effective_at` (and therefore the price) by months. It is not reachable yet only because nothing calls the function.

Fix (coder):
1. Delete `clockOffsetMs` from `resolveEffectiveAt`, or if kept, clamp the final `effectiveUs` to `[receivedUs - maxPastUs, receivedUs + maxFutureUs]` after applying it, and cap the accepted offset at ±`gapApprovalSec`.
2. Follow PLAN exactly, independent of `offline`: missing → `receivedAt`; more than 5 s ahead → `receivedAt` + `clock_ahead`; older than 48 h → throw a typed error the route maps to `422 device_time_out_of_window`; otherwise `effectiveAt = deviceAt`, and if `|deviceAt - receivedAt| > 300 s` add `clock_gap` (warning stored on the event). Set `needsApproval = false` always in iteration 1 ("approval UI is later work"); drop `needsApproval` or leave it unused, but do not let it flip `needs_review`.
3. Use `Number.isInteger`-safe math: compute `maxPastUs = BigInt(Math.round(maxPastHours * 3_600_000_000))`.
4. `clock_flag` column (migration) is `text check (clock_flag in ('clock_ahead','clock_gap'))`, a single value; the function returns an array that can contain `stale` and `negative_clamped`, which would violate the CHECK. Make the column `text[]` with no CHECK (or `jsonb`) and store the whole `flags` array; widen the TS type to match.
5. Unit tests (API `test/time.test.ts`, no DB): the whole table above, including exact boundaries (`+5 s`, `+5 s + 1 µs`, `-48 h`, `-48 h - 1 µs`), plus idempotence `resolve(resolve(x)) == resolve(x)` and: result is never more than 5 s after `receivedAt`.

### R2-09 · medium · The idempotency hash does not include the actor; one user can replay another user's response

Evidence: `http.ts:103` hashes `method + req.url + body`. Probe B: user A (owner) and user B (attendant) in the same tenant sent the same `Idempotency-Key` and body; B received A's stored `201` body with `Idempotent-Replayed: true` and the same session id. Stored responses contain things like pass QR tokens (`POST /v1/passes` is `idempotent: true`), so a leaked or guessed key replays another user's payload. The redaction (`:139`) only nulls the key `temporaryPassword`.

Fix (coder): include `ctx.userId ?? ''` and `ctx.siteId ?? ''` in the hash input (and keep method, `req.url`, body); a different actor with the same key then gets `422 idempotency_key_reuse`. Extend the redaction replacer to also null `secret`, `token`, `password` and `qrToken`-style keys (grep the idempotent routes' return shapes first; `/v1/passes` returns the pass token). Add a test with two users and one key.

### R2-10 · high · Microsecond precision is still lost on the API path, and two clocks are mixed

Evidence:
- No `pg.types.setTypeParser` anywhere (`grep -rn setTypeParser apps/api/src` empty). Every timestamptz read is a JS `Date` (ms). `GET /v1/sessions/:id/events` returns `server_at`, `device_at`, `effective_at` as ms ISO strings.
- `in_at` and `out_at` are still written from `app.now()` (`services/sessions.ts:95,230,241`), a ms `Date`; responses use `now.toISOString()` (`:134`, `:233`); `already_inside` uses `open.in_at.toISOString()` (`:104`); `new Date(input.deviceAt)` at `:96` truncates the device time.
- Mixed clocks: probe A showed `received_at` (DB `clock_timestamp()`, 19:15) next to `server_at` (Node, 20:09) on the same event. Any ordering that mixes `effective_at`/`received_at` (DB) with `in_at`/`out_at`/`server_at` (Node) is wrong whenever the two clocks differ, which they do in this very environment.

Fix (coder):
1. Persisted times for check-in, check-out, events and payments come from SQL `clock_timestamp()` (via the `receivedAt` value in R2-01), never `app.now()`. Keep `app.now()` only for the fee calculation of previews and for existing tests that inject a clock; add `cfg.TEST_CLOCK` semantics as the audit suggests only if a test needs it.
2. Return times as MicroTs strings by selecting `to_char(col at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` in the session/event queries that feed API responses (`getOpenById`/`OPEN_SQL`, `GET .../events`, the check-in/check-out `out` objects). Do not register a global type parser in this iteration: dozens of call sites (`.toISOString()`, `.getTime()`) expect `Date` and the change is not testable with the targeted run. Record the global parser as follow-up.
3. Replace `new Date(input.deviceAt)` at `:96` with `parseMicroTs` arithmetic.
4. Test (API): insert via `deviceAt: '2026-10-24T10:41:22.076123Z'` and assert `GET .../events` returns `...076123Z` unchanged.

### R2-11 · medium · Migration 019: table rewrite, no-op backfills, full-table updates in one transaction

Evidence (psql, temp tables, rolled back):
- `add column received_at timestamptz(6) not null default clock_timestamp()` changed `relfilenode` (97094 → 97103), i.e. a full rewrite under `ACCESS EXCLUSIVE`, because the default is volatile; it also stamped 100000 existing rows with 6973 distinct migration-time values. `add column ... default 1` and `alter column ... type timestamptz(6)` did not rewrite.
- Lines 55-56 `update session_event set received_at = server_at where received_at is null` can never match (the column is NOT NULL with a default), so legacy rows get the migration time as `received_at`, not their arrival time.
- Line 52 `update session_event set effective_at = server_at` and lines 85-86 `update session set in_received_at = in_at ...` rewrite the whole tables a second time inside the single migration transaction (`migrate.ts:16-22` wraps each file in one `begin/commit`).
- `create policy tenant_isolation on tenant_seq` has no `drop policy if exists`; the migration is not safe to re-run by hand (the runner's `schema_migration` table protects the normal path).
- Unused schema: `in_received_at`, `out_received_at`, `in_effective_at`, `out_effective_at`, `needs_review`, `fee_provisional`, `idempotency_key.mutation_id`, `client_at` are never written.

Fix (coder):
1. `add column received_at timestamptz(6)` (nullable, no default), then `alter table session_event alter column received_at set default clock_timestamp()` (metadata-only). Do not back-fill; readers use `coalesce(received_at, server_at)`. Same for `effective_at`: no `update`, readers use `coalesce(effective_at, server_at)`.
2. Remove lines 52, 56 and the two `update session` statements.
3. Drop columns nothing writes yet (or add them in the iteration that writes them). Keep `needs_review` only if R2-08 is changed to set it.
4. Add `drop policy if exists tenant_isolation on tenant_seq;` before `create policy`.

### R2-12 · medium · New `SECURITY DEFINER` function is executable by PUBLIC; convention from 002 not followed

Evidence: `pg_proc` after migration: `next_tenant_seq` `prosecdef = t`, `proacl = {=X/openpark,openpark=X/openpark,openpark_app=X/openpark}`, so `PUBLIC` (including Supabase `anon`/`authenticated` through the Data API) can call it. 002, 003, 005, 006, 009, 015, 016, 018 all `revoke execute ... from public` after creating a function. `bump_version` has no pinned `search_path` either (007 pins them for the Supabase linter). The definer is also unnecessary: `tenant_seq` has RLS plus a grant to `openpark_app`.

Fix (coder): make `next_tenant_seq` `SECURITY INVOKER` (remove `security definer`), add `set search_path = pg_catalog, public`, then `revoke execute on function next_tenant_seq() from public; grant execute on function next_tenant_seq() to openpark_app;`. For `bump_version()`: `set search_path = pg_catalog` and `revoke execute on function bump_version() from public;` (triggers do not need EXECUTE for the table owner/updater). Add a RLS test next to the existing isolation tests: tenant A cannot read tenant B's `tenant_seq` row, and `openpark_app` without `app.tenant_id` set gets zero rows.

### R2-13 · medium · `(id, version)` indexes on the hottest tables defeat HOT updates

Evidence: `019:160-164` creates `session_version`, `site_version`, `zone_version`, `slot_version`, `unit_version` on `(id, version)`. `id` is already the primary key, so the indexes add no lookup benefit, and because `version` changes on every update (trigger), every `slot` flip and `session` close becomes a non-HOT update with extra index maintenance and bloat. Also `idempotency_key_state` (`tenant_id, state`) has no query that uses it.

Fix (coder): delete those five `create index` statements and `idempotency_key_state`. The `where id = $1 and version = $2` update uses the primary key.

### R2-14 · medium · `tenant_seq` as designed serializes all tenant writes and invites deadlocks; a plain sequence is what PLAN asks for

Evidence: `next_tenant_seq()` updates one row per tenant; that row lock is held to commit, so every check-in/out/payment of a tenant is serialized behind it once wired. In `checkIn` the slot row is locked first, then events call the sequence; another request that already holds the tenant row and then wants the same slot row deadlocks (`checkOut` locks session, slot, then events, then `recordPayment` writes more events). PLAN says "`server_seq` comes from the database (`clock_timestamp()`, a sequence)". It does not require gapless or commit order in iteration 1.

Fix (coder): replace with a real sequence: `create sequence session_event_server_seq; alter table session_event alter column server_seq set default nextval('session_event_server_seq'); grant usage, select on sequence session_event_server_seq to openpark_app;` (the one-time `grant usage, select on all sequences` in 001 does not cover sequences created later, which is the trap the task brief points at). Drop `tenant_seq`, `next_tenant_seq()` and the unused table if no later iteration needs it; if the orchestrator wants to keep it for the SSE cursor, call it as the last statement before commit and document the lock cost. Test: two concurrent check-ins in the same tenant both succeed, `server_seq` unique and increasing.

### R2-15 · medium · CORS does not expose `ETag` or `Retry-After`

Evidence: `server.ts:76` `exposedHeaders: ['Idempotent-Replayed']`. The app (`app.openpark.io`) calls the API (`api.openpark.io`) cross-origin, so the browser hides every header not exposed. P1 cannot read `ETag` for `If-Match` or `Retry-After` for backoff.

Fix (coder): `exposedHeaders: ['Idempotent-Replayed', 'ETag', 'Retry-After']`. Keep allowed headers reflective (default) so `X-Device-Id`, `X-Client-Seq`, `If-Match` pass the preflight; add a test that sends a preflight with those headers and asserts `204` and the `access-control-allow-headers` echo.

### R2-16 · medium · Server time is labelled `Z` but formatted in the session time zone

Evidence: `server.ts:167` and `time.ts:~35` use `to_char(clock_timestamp(), '...HH24:MI:SS.US"Z"')`. With `set time zone 'America/Mexico_City'`: `2026-10-24T13:14:57.208488Z` for the same instant that is `19:14:57Z` in UTC (reproduced with psql). Supabase and the local container default to UTC today, so this passes tests and fails the day a role/database `TimeZone` is changed.

Fix (coder): `to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` in both places (one shared SQL constant in `time.ts`, imported by `server.ts`). Test: run the query after `set local time zone 'America/Mexico_City'` and assert the UTC instant.

### R2-17 · medium · Dead and harmful failure cleanup in `defineRoute`

Evidence: `http.ts:155-163` calls `app.db.raw(... delete from idempotency_key ... state = 'pending')` after the transaction already rolled back (the reservation row never committed). `raw` has no tenant context, so RLS (`tenant_id = app_tenant()`) makes the delete match nothing, and it takes one extra pool connection per failed request. Probe D confirmed no `pending` row remains after a 409 business conflict, i.e. rollback already did the cleanup. `idemState` is a closure variable mutated inside the transaction callback only to feed this block.

Fix (coder): delete the `.catch` cleanup block and the `idemState` variable; keep the plain `throw e`.

### R2-18 · medium · No API tests were added

Evidence: `git status --porcelain apps/api/test` is empty; PLAN lists "API tests" as P2-owned and the audit §4 lists the cases. The 134 passing tests all pre-date the change.

Fix (coder): add `apps/api/test/sync-concurrency.test.ts` and `apps/api/test/time.test.ts` covering at least: 20 concurrent identical `POST /v1/sessions` (one session, 19 replays); in-flight duplicate → 409 + `Retry-After` (R2-06); replay returns the stored status/body with `Idempotent-Replayed`; same key + different body → `422 idempotency_key_reuse`; failed request leaves no `idempotency_key` row and the key can be retried; same key from a second user → 422 (R2-09); P1's exact envelope persisted (R2-03); offline check-out priced at `deviceAt` and no $0 payment (R2-02); `deviceAt` out of window → 422; stale `If-Match` → 412 with `current`; 10 concurrent rate-plan creates → versions 1..10; `/v1/healthz` shape; µs round trip (R2-10); `tenant_seq`/sequence grants as `openpark_app`.

### R2-19 · low · Core `toMicroTs` returns a `bigint` for whitespace-padded input and accepts impossible offsets

Evidence: `packages/core/src/time.ts:154` `return parseMicroTs(s) as unknown as MicroTs;` returns a bigint. Reproduced: `typeof toMicroTs(' 2026-10-24T16:31:33.430512Z ')` → `"bigint"`. Offset `+99:99` is accepted (`toMicroTs('2026-10-24T10:31:33+99:99')` → `2026-10-20T05:52:33.000000Z`). Reachable from P1's queue migration (`sync/storage.ts:225`) only if stored strings carry whitespace, so low.

Fix (coder): line 154 → `return s as MicroTs;` (after `parseMicroTs(s)` validation). Reject offsets with hours > 23 or minutes > 59. Add both cases to `time.test.ts`.

### R2-20 · low · Contract text says flat error bodies; the server nests them

Evidence: PLAN: `409 {"error":"request_in_progress"}`, `412 {"error":"version_mismatch","current":{...},"currentVersion":n}`. The real handler (`server.ts:145`) sends `{ error: { code, message, details } }` and P1 parses exactly that (`apps/web/src/api.ts:42-46`). `HttpError` also cannot set response headers (needed for `Retry-After`).

Fix: keep the nested shape (changing it breaks every existing client and test). Put `current` and `currentVersion` inside `details` and ask the orchestrator to amend PLAN.md; add `headers?: Record<string,string>` to `HttpError` (R2-06).

---

## What I checked and found fine

- Rollback of the reservation: a handler that throws after the reservation leaves no `idempotency_key` row (probe D), so the same key is retryable. 4xx results are not stored, so a retry re-evaluates against current state (matches the audit).
- 8 concurrent identical check-ins: one `201`, seven `201` with `Idempotent-Replayed: true`, one session id, one `idempotency_key` row `state=done` (probe A).
- Same key, different body: `422 idempotency_key_reuse` still works through the new path (`http.ts:123-125`).
- RLS on `tenant_seq` exists with the standard `app_tenant()` policy; `session_event`, `audit_event`, `rate_plan` remain insert-only for `openpark_app` (the grants in 001 are untouched; the new columns inherit them; the 019 `update session_event` runs as the owner).
- `parseMicroTs`/`formatMicroTs` round-trip, leap-year, Feb-30, hour 24, negative epochs; `alter column ... type timestamptz(6)` does not rewrite; `bump_version` works on `session`, `slot`, `site`, `zone`, `unit`, `tenant`, `membership` (tests pass and probe updates succeeded).
- `resolveEffectiveAt` window boundaries are inclusive at exactly +5 s and -48 h with correct ms/µs units on those branches.
- Healthz exposure: unauthenticated, no tenant data, only server time; `Cache-Control: no-store` present on the root route.

## Not verified

- No load test beyond the 12-request pool probe; the pool-starvation result depends on `max = 10`.
- Table-rewrite cost was measured on 100k temp rows, not on production-sized `session_event`.
- `GET`/`PATCH` behaviour of sites, zones, units was not probed (same code path as slots: no `If-Match`, no `ETag`).
- Vercel serverless behaviour of advisory locks (transaction pooling in Supabase pgbouncer) is untested; `pg_try_advisory_xact_lock` is transaction-scoped and safe under transaction pooling, session-level advisory locks would not be.

VERDICT: NEEDS_CHANGES
