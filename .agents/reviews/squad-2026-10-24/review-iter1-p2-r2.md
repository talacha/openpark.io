# Adversarial re-review, iteration 1, package P2 (API concurrency + microsecond time), round 2

Reviewer: rereview-p2 (read-only on the repo; scratch copy in `/tmp`, deleted afterwards). Branch `squad/2026-10-24`, working tree as found at 16:00 MDT.
Inputs: `PLAN.md` (including "Contract amendments", binding), `review-iter1-p2.md` (R2-01..R2-20 of round 1), `git diff -- apps/api packages/core` plus untracked `migrations/019_sync_concurrency.sql` and `src/time.ts`.

Finding IDs in this file are `R2-NN` as the task asks. They restart at 01 and are **new**; round-1 IDs are quoted as `[r1 R2-NN]`.

## Summary

The tree does not compile. `apps/api/src/http.ts` was left with a duplicated trailing block, an invalid `digest('bigint')` call, a `BigInt(hex, 16)` call that throws at runtime, and a two-argument `db.query` that does not type-check. `src/time.ts` uses `HttpError` without importing it. Result: `pnpm --filter @openpark/api exec vitest run` fails at load for all 7 suites (0 tests run) and `pnpm typecheck` fails. The fix-p2 summary says as much ("Incomplete"), and the work is indeed incomplete: of the 20 round-1 findings, 4 are fixed (healthz, CORS expose headers, UTC formatting, reservation-first fast-fail once the file compiles), 3 are partly fixed, and the rest are untouched (nothing reads a device header, nothing writes `effective_at`/`server_seq`, there is no `If-Match`, no `ETag`, no 412, and not one API test was added).

To judge the logic that is there, I copied `apps/api` and `packages/core` to a scratch directory, applied only the minimal edits needed to compile (delete the duplicate block, replace the bigint lock with `hashtextextended`, import `HttpError`), and ran the existing suite plus throwaway probes. Those results are quoted below and labelled "scratch". Nothing in the repo was modified except this file.

fix-p2 may still be editing: `http.ts` has mtime 15:59, one minute before I started. The verdict is about the tree as found.

## Commands run

| Command | Result |
| --- | --- |
| `pnpm --filter @openpark/core build` | PASS |
| `packages/core` `vitest run` | PASS, 65 tests / 6 files |
| `pnpm --filter @openpark/api exec tsc --noEmit` (repo tree) | FAIL: `src/http.ts(185,5)`, `(185,6)`, `(186,3)`, `(186,4)`, `(187,1)` TS1128 |
| `pnpm --filter @openpark/api exec vitest run` (repo tree) | FAIL: 7 suites fail to transform (`http.ts:185:4 Unexpected "}"`), 0 tests run |
| `pnpm typecheck` (repo tree) | FAIL (same error) |
| Scratch copy, 4-line compile patch only: `tsc --noEmit` | PASS after patch; before patch also reports `http.ts(110,92)` bigint encoding, `(112,66)` and `(112,107)` "Expected 1 arguments, but got 2", `time.ts(136,15)` `Cannot find name 'HttpError'` |
| Scratch copy: `vitest run` | 134 pass, 1 fail (`serverless-cost > durable webhook retries`, pre-existing: Postgres container clock is ~1.9 h off the host clock, `next_attempt_at` compared against host `Date.now()`) |
| Scratch copy, first attempt with the literal lock expression (`BigInt(hex, 16)`) | 500 on the first idempotent request; 78 of 135 tests fail |
| Scratch probe file (8 cases, deleted) | results below |
| psql on a throwaway database with the 18 prior migrations plus 019, 200k `session_event` and 50k `session` rows (database dropped) | results in R2-06 |

## Round-1 findings, verified

| Round-1 ID | Claimed | Verified state |
| --- | --- | --- |
| R2-01 wire columns | not done | NOT FIXED. `grep resolveEffectiveAt\|serverMicroTs apps/api/src` matches only the definitions in `time.ts`. Probe D: `session_event` rows have `device_id`, `client_seq`, `server_seq`, `effective_at`, `received_at`, `clock_flag` all NULL. |
| R2-02 offline pricing | not done | NOT FIXED. Probe G: check-in, clock +6 h, check-out with `deviceAt = now-3h, offline: true, payment.amount 0` → `200`, `outAt` = server time, 360 minutes, fee 23000. Priced at replay time, $0 payment accepted. |
| R2-03 headers | not done | NOT FIXED. `grep -i x-device-id\|x-client-seq\|if-match apps/api/src` is empty. Probe D with `X-Device-Id` and `X-Client-Seq` set: stored NULL. |
| R2-04 If-Match/ETag/412, rate-plan race | not done | NOT FIXED. Probe F: `PATCH /v1/slots/B1-001` with `If-Match: "999"` → `200`, no `ETag`. `git status` shows `slots.ts`, `rates.ts`, `people.ts` untouched. |
| R2-05 `/v1/healthz` | done | FIXED. Both paths → `200`, `Cache-Control: no-store`, `time` matches the 6-digit regex, no auth. |
| R2-06 in-flight duplicate | done | FIXED in logic once the file compiles. Probe A (scratch): 20 concurrent identical check-ins → one `201`, nineteen `409` with `Retry-After`, exactly one session. See R2-02/R2-03 below for what is wrong around it. |
| R2-07 request schema | not done | NOT FIXED. `gate` is still dropped from `DeviceEnvelope`; ms-ISO `deviceAt` → `400 device_time_invalid` (Probe D); `deviceAt: 2020-01-01T00:00:00.000000Z` → `201`; `payment` is still accepted and ignored by `CheckInBody`. |
| R2-08 `resolveEffectiveAt` | partly | PARTLY. Rule 6 (`needsApproval` false) and the `offline` ignore are in; `clockOffsetMs` is accepted and ignored (fine). But the function throws `HttpError` from `time.ts` (not imported, see R2-01 below), and the 48 h rule is implemented there while nothing calls it. |
| R2-09 actor in hash | done | FIXED for users. Probe B (scratch): attendant re-using the owner's key and body → `422 idempotency_key_reuse`. API keys: see R2-08 below. |
| R2-10 µs precision | not done | NOT FIXED. Responses and stored `in_at` still come from `app.now()` and `toISOString()` (ms). Probe D events show `device_at` as ms ISO. |
| R2-11 migration safety | partly | PARTLY. Table rewrite is gone for `session_event` columns that are nullable, but see R2-06 below: new rewrites remain. |
| R2-12 definer fn | done | FIXED. `next_tenant_seq`/`tenant_seq` removed from the draft; `bump_version` is `security invoker`, `search_path` pinned, no EXECUTE for PUBLIC/anon (psql: `has_function_privilege('public'|'anon','bump_version()','execute')` = f). Sequence usage granted to `openpark_app` (t). |
| R2-13 `(id, version)` indexes | done | FIXED (not created; `drop index if exists` kept). |
| R2-14 plain sequence | done | FIXED in the file; see R2-07 below for the already-applied-draft problem. |
| R2-15 CORS expose | done | FIXED. Preflight probe: `204`, `access-control-allow-headers` echoes `x-device-id,x-client-seq,if-match,idempotency-key`, expose header `Idempotent-Replayed, ETag, Retry-After`. |
| R2-16 UTC | done | FIXED. Probe H: with the session `TimeZone` set to `America/Mexico_City`, the helper still returns the UTC instant (`20:09:34.300411Z`). |
| R2-17 dead cleanup | done | FIXED (block removed). Replaced by a different dead `update ... set state = 'pending'` (R2-12 below). |
| R2-18 tests | not done | NOT FIXED. `ls apps/api/test` has no new file (9 entries, all pre-existing). |
| R2-19 `toMicroTs` | not done | NOT FIXED. `typeof toMicroTs(' 2026-10-24T16:31:33.430512Z ')` → `bigint`; `+99:99` offset accepted (`2026-10-20T05:52:33.000000Z`). `git diff packages/core` is only the index export. |
| R2-20 nested error shape | amended in PLAN | FIXED by the contract amendment. `HttpError.headers` exists and `server.ts` applies them (Probe A shows `Retry-After`). |

## New findings

### R2-01 · blocking · The tree does not compile; every API suite fails at load

`apps/api/src/http.ts`:
- `:181-187` is a copy of the last five lines of the handler (`// After-commit work ... return reply.code(...)`, `},`, `});`, `}`) left after the closing `}` of `defineRoute`. `tsc` reports TS1128 five times; vitest/esbuild fails with `Unexpected "}"` at `:185:4`.
- `:110` `createHash('sha256')....digest('bigint')`: `'bigint'` is not a `BinaryToTextEncoding` (TS2345). The variable is never used.
- `:111-112` `BigInt(ctx.tenantId.replace(/-/g,''), 16)` and `BigInt(hash.slice(0, 16), 16)`: `BigInt()` takes one argument (TS2554 twice), and `BigInt('5f1e…')` without a `0x` prefix throws `SyntaxError: Cannot convert … to a BigInt` for any hex string containing a letter. Reproduced: with the three compile errors patched but this expression kept, the first idempotent request returns `500` and 78 of 135 existing tests fail.
- `Number(lockId & 0xffff…n)` as the `pg_try_advisory_xact_lock($1)` argument loses precision above 2^53 and can exceed the signed bigint range, so even a corrected version would collide or error.

`apps/api/src/time.ts:136` throws `new HttpError(...)` but the file has no `import { HttpError } from './http.js'` (TS2304).

Fix (exact):
1. Delete `http.ts` lines 181-187 (the second copy of the `// After-commit work` block through the stray `}`).
2. Replace lines 109-120 with:
   ```ts
   const lock = await db.query('select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as got', [`${ctx.tenantId}:${idemKey}`]);
   if (!lock.rows[0]?.got) throw new HttpError(409, 'request_in_progress', 'A request with this Idempotency-Key is still being processed', undefined, { 'Retry-After': '1' });
   ```
   and delete `lockKey`, `lockId`, and the unused `lockResult` variable name.
3. `time.ts`: add `import { HttpError } from './http.js';` (http.ts does not import time.ts, so there is no cycle), or better, return a typed result and let the route throw (R2-04).
4. Re-run `pnpm --filter @openpark/core build && pnpm typecheck && pnpm --filter @openpark/api exec vitest run` and attach the counts.

### R2-02 · blocking · Sync columns, `effective_at`, header envelope, `If-Match`/ETag/412, offline pricing, tests: still not implemented

[r1 R2-01, R2-02, R2-03, R2-04, R2-07, R2-10, R2-18], all reproduced above. The PLAN's "Ordering on the server", "Offline check-out pricing" and "API responses the sync engine relies on" sections are unmet. Concretely the sync engine in P1 (`apps/web/src/sync/engine.ts`) sends `X-Device-Id`, `X-Client-Seq`, `deviceAt` and `If-Match`; the server stores none of them and prices at replay time. Shipping this iteration with P1 merged would re-introduce OS-02 (wrong-time money) exactly as audited.

`services/sessions.ts` was only touched to add `clientSeq`/`serverSeq` optional parameters to `addEvent`; no caller passes them. `routes/sessions.ts` adds three copies of an unused `deviceAtUs` parse, an unused `req` argument in three handlers, and a body-level `offline`, `deviceId`, `clientSeq` (the contract amendment says device identity travels in headers only and the API ignores body copies).

Fix (exact, in order; each item is independently testable):
1. `services/sessions.ts`: add `receivedAt(db)` = `select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t` (reuse `serverMicroTs`). In `checkIn`/`checkOut` call it once, then `resolveEffectiveAt({ clientAt: normalizeDeviceAt(input.deviceAt), receivedAt })`, and write `in_at`/`out_at` as `$n::timestamptz` of `verdict.effectiveAt` (string, not `Date`).
2. `addEvent`: allocate nothing in Node. Insert `effective_at`, `received_at`, `clock_flag`, `device_id`, `client_seq` (server_seq comes from the column default). Remove the `serverSeq` parameter.
3. `routes/sessions.ts`: read `req.headers['x-device-id']` (uuid-validate, else NULL + warning) and `req.headers['x-client-seq']` (non-negative integer, else NULL); drop `deviceId`, `clientSeq`, `offline` from the body schema; add `gate: z.string().optional()` back; one `normalizeDeviceAt()` (accept MicroTs, else pad ms-ISO via core `toMicroTs`, else 400 `device_time_invalid`); enforce 422 `device_time_out_of_window` before any write; remove `payment` from `CheckInBody`; delete the unused locals.
4. `checkOut`: price with `quote(db, s, new Date(Number(parseMicroTs(outAt) / 1000n)))` for the fee only; clamp `outAt` to `>= in_at` and add flag `negative_clamped`; reject `payment.amount === 0` when `fee.total > 0` with `422 payment_amount_required`.
5. `ETag`/`If-Match`: new `services/concurrency.ts` with `parseIfMatch` and `updateIfVersion` (update ... `where version = $n`, zero rows → load current inside the same `withTenant` transaction, throw `HttpError(412, 'version_mismatch', ..., { current, currentVersion })`). Wire into PATCH/DELETE of site, zone, slot, unit (`routes/slots.ts`, `routes/people.ts`; PLAN amendments allow these files). Set `ETag: "<version>"` on GET-by-id and mutation responses; include `version` and `updatedAt` (MicroTs) in the body. Missing `If-Match` stays allowed.
6. Rate-plan race: `pg_advisory_xact_lock(hashtextextended(site_id||':'||name, 0))` before `max(version)+1` in `POST /v1/rate-plans` (`routes/rates.ts`).
7. Tests: see R2-14.

### R2-03 · high · In-flight duplicates return 409 for 19 of 20 concurrent identical requests, including after the first one already committed

Probe A (scratch, after fixing the compile errors): 20 concurrent identical `POST /v1/sessions` → `{"201":1,"409W":19}`. All 19 are `409 request_in_progress, Retry-After: 1`; none is a replay. That is within the contract (the client retries after 1 s and then gets the replay), but the audit's acceptance test (§4: "20 concurrent identical requests: one session, nineteen replays") is not met as written, and the 409 body carries no hint to the client. This is a contract decision rather than a bug, so it is flagged for the PLAN owner only: with the advisory lock released at commit, a request that loses the race but arrives after commit does replay; those that arrive during the transaction get 409. Behaviour is correct; the audit test must assert "one 201, every other response is 409+Retry-After or a replay, exactly one session row".

Severity high only because the cross-package expectation is untested. Fix: write the API test accordingly (R2-14) and document in the route registry summary.

### R2-04 · high · `resolveEffectiveAt` throws an HTTP error from a pure helper and is still unreachable

`time.ts:136` throws `HttpError(422, ...)` from the same function that returns a verdict, and `time.ts` is imported nowhere. The helper also allocates `Error('invalid MicroTs format')` for unparsable input (a generic 500 in the error handler). The contract amendment fixes exactly four rules; the code implements them (verified by reading: missing → server; +5 s inclusive; −48 h inclusive; `clock_gap` above 300 s; `needsApproval` false), but it has no unit test in the API package. A `Math.round` is applied to both windows (the float-noise `RangeError` from round 1 is gone).

Fix: have `resolveEffectiveAt` throw a plain `class DeviceTimeError extends Error` (code `device_time_out_of_window` | `device_time_invalid`), mapped to `HttpError` in `routes/sessions.ts`; add `apps/api/test/time.test.ts` (no DB): boundaries at +5 s, +5 s+1 µs, −48 h, −48 h−1 µs, `clock_gap` at exactly 300 s and 300.000001 s, missing, garbage input, idempotence, "result never later than receivedAt+5 s".

### R2-05 · medium · The ordering index and the SSE cursor use columns nothing populates; the `GET /v1/sessions/:id/events` order is unchanged

`routes/sessions.ts` adds `effective_at`, `client_seq`, `server_seq` to the select but keeps `order by e.id`; `device_id`/`gate` are still returned. `received_at` has no default (the migration makes it nullable with no default after the volatile-default fix), so even a manual insert leaves it NULL. Round-1 R2-01.4 asked for `order by coalesce(e.effective_at, e.server_at), e.device_id, e.client_seq, e.server_seq, e.id`.

Fix: apply that order-by; `alter table session_event alter column received_at set default clock_timestamp();` (metadata-only, existing rows stay NULL and readers use `coalesce(received_at, server_at)`).

### R2-06 · medium · Migration 019 still rewrites hot tables under ACCESS EXCLUSIVE and is not re-runnable by hand without churn

Measured on a throwaway DB (200k `session_event`, 50k `session`):
- `relfilenode` changed for both tables after 019 (`session_event` 102398→102778, `session` 102438→102791): full rewrites. Causes: `add column server_seq bigint default nextval(...)` (volatile default; reproduced on a 100k-row temp table: rewrite = true, and every legacy row gets a distinct `server_seq` assigned in physical order, which is not their event order) and `add column updated_at timestamptz(6) not null default clock_timestamp()` on `session`, `site`, `zone`, `slot`, `unit`, `tenant`, `membership` (volatile → rewrite of each; `slot` and `unit` are large in real tenants).
- Adding the column nullable and then `alter column ... set default` does not rewrite (measured: true).
- The two backfills (`update session_event set effective_at = server_at`, `received_at = server_at`, then two `update session ...`) rewrite each table again inside the single migration transaction (`migrate.ts` wraps each file in `begin/commit`). Run time on the 250k rows: 3.3 s; on production-sized tables this is a long lock.
- Re-run is clean (`NOTICE ... already exists, skipping`, row counts unchanged), which is good.

Fix: `session_event`: `add column server_seq bigint` (nullable, no default), then `alter column server_seq set default nextval('session_event_server_seq')`; legacy rows stay NULL. For the seven `updated_at` columns: `add column updated_at timestamptz(6)` then `alter column updated_at set default clock_timestamp()` and let the trigger fill it on the first update (readers use `coalesce(updated_at, now())` or the API sets it). Remove all four backfill `update` statements; readers use `coalesce(received_at, server_at)`, `coalesce(effective_at, server_at)`. Drop the columns nothing writes yet: `in_received_at`, `out_received_at`, `in_effective_at`, `out_effective_at`, `needs_review`, `fee_provisional`, `idempotency_key.mutation_id`, `client_at`, `state` (or keep and write them in this iteration).

### R2-07 · medium · The rewritten 019 never applies to a database that already ran the earlier draft

The persistent dev database `openpark` (container `openpark-pg`) has `019_sync_concurrency.sql` recorded in `schema_migration` at 2026-10-24 18:21:30 UTC. It still has `tenant_seq`, a `SECURITY DEFINER next_tenant_seq()` executable by PUBLIC (`prosecdef = t`), `received_at not null default clock_timestamp()` (the old table rewrite already happened there), the `clock_flag` check on `text`, and the five `(id, version)` indexes (`session_version`, `site_version`, `zone_version`, `slot_version`, `unit_version`). The runner skips applied files by name, so the fix is invisible there, and anyone who ran the draft (the orchestrator, fix-web testing) keeps the old schema while CI gets the new one. Tests use fresh databases, so they will not notice.

Fix: either (a) rename the rewritten file to `020_sync_concurrency.sql` and make it first drop the draft objects (`drop function if exists next_tenant_seq(); drop table if exists tenant_seq;`, drop the five indexes, `drop constraint session_event_clock_flag_check`, alter `clock_flag` to `text[]`), and delete 019; or (b) leave 019 and tell the user to recreate the local database. Nothing from the draft shipped to Supabase (nothing is merged), so (b) is acceptable if stated in the summary.

### R2-08 · medium · API keys share one idempotency actor per site

`http.ts:106` `actor = ctx.userId ?? 'apikey:' + (ctx.siteId ?? '')`. `Ctx` has no api-key id, so every tenant-wide key (site null) shares the actor `apikey:` and every key for a given site shares `apikey:<site>`. Key A can replay key B's stored response when it knows the `Idempotency-Key` and the body is identical. The contract amendment says "user id or api key id".

Fix: add `apiKeyId: string | null` to `Ctx`, set it where the API key is resolved (`server.ts` authenticate path), and use `ctx.userId ?? ctx.apiKeyId`. Test: two API keys, same key header and body → second gets `422 idempotency_key_reuse`.

### R2-09 · medium · `bump_version()` fires on every row update of `slot`, `session`, `unit`, … and compares whole rows

`019` step 5 attaches `before update` triggers to seven tables that do `row(new.*) is distinct from row(old.*)`. That is cheap, but any `UPDATE` that touches only `updated_at` or `version` itself (the trigger's own output, or a future writer that sets `version = version + 1` explicitly) is a double bump, and a no-op `UPDATE` on a table with a `json`-typed column (none today; all `jsonb`) would raise an equality-operator error. More important: there is no way to opt in per request, and `updateIfVersion` (R2-02.5) must not also increment `version` itself, or optimistic locking skips a version.

Fix: document in the migration comment that application code must never set `version`/`updated_at`; add one assertion test (update a slot, check `version` +1, `updated_at` advanced; update to the same values, check `version` unchanged).

### R2-10 · medium · Check-in response, `already_inside` details and event timelines still leak server time as ms `Date`

[r1 R2-10] Probe C: `already_inside` returns `"inAt":"2026-10-20T14:00:00.000Z"`, i.e. a ms ISO derived from `open.in_at.toISOString()`; probe D check-in `inAt` is the same. The PLAN requires every time on the wire used for sync to be MicroTs. Mixed clocks are still present: `received_at`/`effective_at` (DB `clock_timestamp()`) next to `server_at` (Node `app.now()`). Cross-tenant leakage in 409 details was checked: `already_inside` and `slot_unavailable` detail objects come from queries inside the same `withTenant` transaction; nothing added in this round builds a `current` object, so nothing new leaks.

Fix: as in round 1 R2-10.2: select `to_char(col at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` for the response/details fields; keep Node `Date` for the fee math only.

### R2-11 · medium · Server-side secrets in idempotency storage

The redaction replacer (`http.ts` `JSON.stringify(..., (k,v) => k === 'temporaryPassword' ? null : v)`) is unchanged. Idempotent routes that return one-time secrets: `POST /v1/passes` (QR token, stored), `POST /v1/users` and tenant creation (`temporaryPassword`, handled), `POST /v1/webhooks` (`secret`, not idempotent today), `POST /v1/api-keys` (`key`, not idempotent today). Because the hash now includes the actor, cross-user replay is closed. Remaining exposure is the stored plaintext pass token in `idempotency_key.response` (retention: `purge_idempotency_keys`).

Fix (low effort): add `'token'`, `'qr'`, `'secret'`, `'key'` to the redaction list only if the route is idempotent and the replay does not need it; for passes, replay needs the token, so instead document the exposure and shorten `purge_idempotency_keys` to match the 2 h QR TTL. Not blocking.

### R2-12 · low · Dead and redundant statements in the reservation path

`http.ts`: after a successful `insert ... returning key` there is an extra `update idempotency_key set state = 'pending'` that sets the value just inserted (one extra round trip per idempotent write); the `if (!prior.rows[0]) throw 409` branch cannot be reached while the advisory lock is held; `state` is never read by the replay branch (it relies on `status`). Comments contain `R2-06` round-1 tags.

Fix: delete the redundant `update`; drop the `state` column or use it (`where state = 'done'`); remove finding IDs from comments (comments explain why, not tickets).

### R2-13 · low · Core `toMicroTs` unchanged

[r1 R2-19] Reproduced again: returns a `bigint` for whitespace-padded input; accepts `+99:99`. P1 calls `toMicroTs` on stored queue items (`sync/storage.ts`). Fix: `packages/core/src/time.ts:~151` `return s as MicroTs;` (after `parseMicroTs(s)` validation), reject offset hours > 23 or minutes > 59, add both cases to `time.test.ts`.

### R2-14 · blocking · No API tests were added (acceptance requires them)

`apps/api/test` still contains only the nine pre-existing files. The task requires tests with the fixes and forbids calling the work done without them.

Required cases (each must fail on the pre-fix code):
- 20 concurrent identical `POST /v1/sessions`: one `201`, others `409`+`Retry-After: 1` or replay with `Idempotent-Replayed`; exactly one session row.
- Reservation held by an open transaction: duplicate returns `409` in under 200 ms and does not hold a pool connection (a second request on the same pool completes).
- Same key, different body → `422 idempotency_key_reuse`; same key from a second user and from a second API key → `422`.
- Failed (4xx) request leaves no `idempotency_key` row and the key can be retried.
- Replay returns original status and body with `Idempotent-Replayed: true`.
- P1's exact envelope (`Idempotency-Key`, `X-Device-Id`, `X-Client-Seq`, body `deviceAt`) is persisted: `device_id`, `client_seq`, `effective_at` equal to the µs given; `server_seq` strictly increasing.
- `deviceAt` older than 48 h → `422 device_time_out_of_window`; >5 s ahead → clamped + `clock_ahead` stored; ms-ISO accepted and padded.
- Offline check-out priced at `deviceAt`; `$0` payment with positive fee rejected.
- Stale `If-Match` → `412` with `error.details.current` and `currentVersion`; matching → `200` with `ETag`; missing → allowed.
- 10 concurrent rate-plan creates for one name → versions 1..10, no 5xx.
- `GET /v1/healthz` and `/healthz` shape, `Cache-Control: no-store`, regex, no auth.
- Preflight allows `x-device-id`, `x-client-seq`, `if-match`; exposes `ETag`, `Retry-After`, `Idempotent-Replayed`.
- Sequence grant as `openpark_app`: `select nextval('session_event_server_seq')` succeeds; `bump_version` is not callable by `anon`.
- µs round trip through `GET /v1/sessions/:id/events`.

## What I checked and found fine

- Advisory lock design (once the expression is replaced by `hashtextextended`): transaction-scoped, released at commit/rollback, safe under Supabase transaction pooling; a rolled-back owner leaves no row so the key is retryable; 4xx business conflicts are not stored (probe C, repeat → same 409).
- Actor in hash: user-vs-user replay closed (Probe B).
- `/v1/healthz` and `/healthz`: unauthenticated, no tenant data, only the server clock; UTC-safe (Probe H).
- CORS preflight echoes the new request headers and exposes `ETag`, `Retry-After`, `Idempotent-Replayed`.
- Grants: `openpark_app` has `usage` on `session_event_server_seq`; `session_event` stays insert-only (no grants were added); `bump_version` is `security invoker`, `search_path` pinned, EXECUTE revoked from PUBLIC.
- Re-running 019 against a migrated database is a no-op (no errors, counts unchanged).
- No cross-tenant data in any new 409/412 detail (no 412 exists yet).
- Core package: `pnpm --filter @openpark/core build` PASS; 65 core tests PASS.

## Not verified

- Behaviour of the repo tree under test (it does not compile); results labelled "scratch" are on a copy with four compile edits and nothing else.
- Table-rewrite duration on a production-sized `session_event`; measured only on 250k rows.
- Supabase pgbouncer behaviour for `pg_try_advisory_xact_lock` (transaction-scoped, expected safe).
- The pre-existing `serverless-cost` failure is environmental (container clock behind host) and not attributed to P2.

VERDICT: NEEDS_CHANGES
