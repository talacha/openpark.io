# Squad 2026-10-24 work plan

Source audits (same folder): `audit-code-quality.md` (CQ-*), `audit-ui.md` (UI-*), `audit-crud-routes.md` (CR-*), `audit-offline-sync.md` (OS-*).

Coders: `qwen3-coder-next`. Adversarial reviewers: `claude-sonnet-5.5`. Each iteration ships as one PR from `squad/2026-10-24` into `main` (merged right away, the PR is the paper trail).

## Repo rules every coder follows

- Read `AGENTS.md` first. Build `packages/core` before typecheck. Money is integer minor units. Tenant routes use `defineRoute`. New tables need RLS + grant. `session_event`, `audit_event`, `rate_plan` stay insert-only.
- Web CSS: logical properties only (`check:css`). New locale keys go into every `apps/web/src/locales/*.json` except generated `en-XA.json`.
- Edit only the files your package owns. If you must touch a file owned by another package, stop and report it instead.
- No new dependency without an exact pinned version. Never weaken, skip or delete a test.
- Comments explain why, never restate code.
- Do not commit. The orchestrator commits after the gate is green.

## Gate

```bash
pnpm --filter @openpark/core build && pnpm typecheck && pnpm test
pnpm --filter @openpark/web check:css
pnpm --filter @openpark/web build
```

Postgres for API tests: container `openpark-pg` on :54329.

## Cross-package contracts (iteration 1)

These are fixed. Coders implement their side exactly; reviewers check both sides match.

### Time: `MicroTs`

- Lives in `packages/core/src/time.ts`, exported from the core index.
- Wire format: RFC 3339 UTC string with exactly six fractional digits and `Z`, e.g. `2026-10-24T16:31:33.430512Z`. Regex: `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$`.
- Internal representation: `bigint` microseconds since Unix epoch. Never round-trip through JS `Date` when precision matters.
- API: `type MicroTs = string & { __brand: 'MicroTs' }`; `parseMicroTs(s: string): bigint` (throws on bad format); `formatMicroTs(us: bigint): MicroTs`; `compareMicroTs(a, b): -1 | 0 | 1`; `isMicroTs(s): s is MicroTs`; `nowMicroTs(): MicroTs` (browser: `performance.timeOrigin + performance.now()`, converted to integer µs, made strictly monotonic per process by bumping 1 µs when it would not increase; Node: `process.hrtime.bigint()` anchored to `Date.now()` once at load).
- Zod: `microTsSchema` exported from core.

### Mutation envelope (web queue → API)

Every queued write sends:

- Header `Idempotency-Key: <mutationId>`. `mutationId` is a UUIDv7 generated at capture time and never regenerated on retry.
- Header `X-Device-Id: <deviceId>`. A UUID persisted in IndexedDB (`op-device` store), created once per browser profile.
- Header `X-Client-Seq: <n>`. A per-device monotonically increasing integer persisted with the device id.
- Body field `deviceAt: MicroTs`. The capture time on the device. (The API already has a `deviceAt` concept; it now uses this format. The API also accepts the old ms ISO form and pads it to µs, for old queued items.)
- For updates of versioned entities: header `If-Match: "<version>"`.

### API responses the sync engine relies on

- `GET /v1/healthz` (new; keep the existing root `/healthz` for k8s probes) → `200 {"ok":true,"time":"<MicroTs from clock_timestamp()>"}`. No auth, no tenant, `Cache-Control: no-store`. Under `/v1` so the dev proxy, nginx and Vercel already route it.
- Same `Idempotency-Key` replayed after success → the original status and body, header `Idempotent-Replayed: true` (existing name, keep it).
- Same key while the first request is still running → `409 {"error":"request_in_progress"}` with `Retry-After: 1`. This is retryable, never a conflict.
- Same key with a different body → `422 {"error":"idempotency_key_reuse"}`. Terminal.
- Business conflict (slot taken, session already closed, etc.) → `409 {"error":"<specific_code>","current":{...server state...}}`. Terminal for the queue item; shown in the conflict UI.
- Stale `If-Match` → `412 {"error":"version_mismatch","current":{...},"currentVersion":n}`.
- Versioned resources return `ETag: "<version>"` and include `version` and `updatedAt` (MicroTs) in the body.

### Ordering on the server

`session_event` rows order by `(effective_at, device_id, client_seq, server_seq)`. `effective_at` comes from `resolveEffectiveAt(deviceAt, receivedAt)`:

- missing `deviceAt` → `receivedAt`
- `deviceAt` more than 5 s in the future → clamp to `receivedAt` and flag `clock_ahead`
- `deviceAt` older than 48 h → reject `422 {"error":"device_time_out_of_window"}`
- gap above 300 s → accept, flag `clock_gap` (warning stored on the event; approval UI is later work)

`receivedAt` and `server_seq` come from the database (`clock_timestamp()`, a sequence), never from Node.

### Offline check-out pricing

The queue never records a `$0` payment. An offline check-out sends `deviceAt` as the exit time, and the server prices the stay at `effective_at` with the rate plan that was active then. The device may show an estimate labelled as an estimate.

## Contract amendments after iteration-1 review (binding)

- Error bodies keep the existing nested shape: `{"error":{"code":"...","message":"...","details":{...}}}`. Wherever this plan writes `{"error":"x", "current":...}` read it as `error.code = "x"` and `error.details.current` / `error.details.currentVersion`.
- Device identity travels in headers only (`X-Device-Id`, `X-Client-Seq`). The API ignores body copies. The web omits the headers entirely when it has no persisted device id; it never sends `unknown`.
- `deviceAt` is honoured on every check-in/check-out (online and queued), not only when `offline: true`. The API accepts ms-precision ISO strings (padded via core `toMicroTs`).
- `resolveEffectiveAt` has no clock-offset parameter. Exactly the four rules above, nothing else. `clock_gap` is a stored flag, not an approval gate.
- `server_seq` is a plain Postgres sequence (`session_event_server_seq`) with `usage` granted to `openpark_app`. No per-tenant counter table.
- An in-flight duplicate must not block a pool connection: take `pg_try_advisory_xact_lock(hashtext(tenant||key))` before the reservation insert; if the lock is not acquired return `409 request_in_progress` with `Retry-After: 1` immediately.
- Idempotency request hash includes the actor (user id or api key id).
- P2 may edit `routes/slots.ts`, `routes/people.ts`, `routes/rates.ts`, `routes/inventory*.ts` for If-Match/version and the rate-plan race.
- CORS must expose `ETag`, `Retry-After`, `Idempotent-Replayed`.
- P3: the `@layer components` wrap of legacy CSS is REVERTED for now (it visibly changes 78 buttons, cards and inputs). Legacy classes get removed screen by screen in later iterations instead. New semantic tokens must be registered in `@theme inline` and meet WCAG AA (4.5:1 text) in both themes.

## Iteration 1 packages

| Pkg | Owner files | Findings |
| --- | --- | --- |
| P1 web sync engine + status indicator | `apps/web/src/offline.ts` (and new `apps/web/src/sync/*`), `SyncBadge` → `ConnectionStatus`, `Shell.tsx`, `AppMenu.tsx`, the queue/check-in/check-out call sites in `Attendant.tsx`, `Queue` screen, their tests, locale keys prefixed `sync.` | CQ-01, CQ-02, OS-02 (web side), OS-03, OS-05, OS-08, UI-19, UI-20, UI-37 (minimal) |
| P2 API concurrency + time | `packages/core/src/time.ts` (+ test, index export), new migration(s) in `apps/api/migrations/`, `apps/api/src/http.ts` idempotency, `db.ts` time handling, `routes/sessions.ts`, healthz route, API tests | OS-02 (server), OS-03 (server), OS-04, OS-09, OS-10, CR-32 (sites/zones/slots/units If-Match) |
| P3 UI foundation | `apps/web/src/styles.css`, `components/ui/*`, new `components/shared/*`, ThemeProvider + `main.tsx`, `components.json`, web `package.json` deps | UI-01..10, 12..15, 17 (placeholder), 38 (component only) |
| P4 offline shell + ALPR offline | service worker file(s), `vite.config.*`, `index.html`, `app-context.tsx` boot, `apps/web/src/alpr/*` loading/readiness, `scripts/fetch-models.mjs` if needed, `vercel.json`, `deploy/nginx*` | OS-01, OS-06, OS-07, OS-19, UI-19 (cold start) |

Deferred to iteration 2 and later: core contracts and plate normaliser unification (WP-Q1), route map and single-task screens (CR WP-00 onward), screen migrations off legacy classes, import wizard, attendant rebuild, guardrails/lint (WP-Q6), retention and RLS coverage tests (WP-Q4), ALPR Python service, SDK and OpenAPI.

## Live environment

`https://app.openpark.io` deploys from `main`. Post-merge smoke tests use the demo tenant. Credentials are passed in the prompt only; never write them to files. Do not delete or bulk-modify demo data.
