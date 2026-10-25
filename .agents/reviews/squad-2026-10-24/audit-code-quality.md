# Audit: code quality, clean code, DRY vs WET (whole repo)

Track: `audit-code-quality` · Date: 2026-10-24 · Repo: `/Users/robcr/Projects/openpark.io` @ `292f398` + a dirty working tree (see §0.3)
Mode: read-only. The only file written is this report.

Severity scale (as requested): **blocking** = wrong behaviour or lost data today, and it undermines the offline/sync goals · **high** = serious defect or large structural duplication · **medium** = real maintainability or correctness risk · **low** = polish.
Sibling reports in this folder use C/H/M/L. Mapping: blocking≈C, high≈H, medium≈M, low≈L.

---

## 0. Scope, method, limits

### 0.1 What was read and run

- Read in full: `AGENTS.md`, `ARCHITECTURE.md` (first 200 lines), `docs/DOMAIN.md`, every file under `apps/api/src` (routes, services, notify, jobs, http, server, db, auth, config), the migrations that define RLS and grants (`001`, `002`, `003`, `005`, `009`, `017`, `018`), all of `packages/core/src`, `packages/sdk-ts/src`, `packages/sdk-py`, `packages/ui/src`, `services/alpr/app`, and the web files listed in the findings (`api.ts`, `offline.ts`, `SyncBadge.tsx`, `hooks.ts`, `app-context.tsx`, `App.tsx`, `menu.ts`, `i18n.tsx`, `pass.ts`, `attendant-flow.ts`, `Attendant.tsx` (hot spots), `Bulk.tsx`, `Inventory.tsx`, `Rates.tsx`, `Settings.tsx`, `Platform.tsx`, `Integrations.tsx`, `GuestPasses.tsx`, `Sessions.tsx`, `Slots.tsx`, `Queue.tsx`, `Dashboard.tsx`, `People.tsx` (first 140 lines), `Parking.tsx` (first 70 lines), `alpr/*`, `LiveCamera.tsx`, `Shell.tsx`, `AppMenu.tsx`).
- Skimmed (structure and grep only): `Resident.tsx`, `Auth.tsx`, rest of `People.tsx` and `Parking.tsx`, `components/ui/*` (vendored shadcn), `apps/marketing`, `e2e/*`, `scripts/*`, test files.
- Commands run (all read-only): `wc -l`, `rg`, `git ls-files`, `git status`, and three `tsc --noEmit` runs:
  1. `--noUnusedLocals --noUnusedParameters` on `apps/api`, `apps/web`, `packages/core`, `packages/sdk-ts`.
  2. The same projects with `test/` added to `include`, using temporary tsconfig files created in `/tmp` and deleted afterwards.
  3. A crude exported-but-never-imported scan (script in `/tmp`, deleted).
- `npx knip` is not installed, so it was not used. The unused-dependency check was a manual scan of `package.json` vs imports.
- **Not run:** vitest, pytest, Playwright, any DB-backed test. No Postgres was available and the audit must not mutate state. Every finding below is from reading code, not from observing a failure, unless it says "tsc reported".

### 0.2 Size of the codebase

About 20.8k lines of TS/TSX/Py/SQL/Astro/mjs including tests and e2e, excluding vendored `components/ui`, `public/ort`, `.venv` and the lockfile.
`apps/api/src` is 4.6k lines in 34 files, `apps/web/src` 5.0k (excluding `ui/`), `packages/core/src` 0.5k, tests about 5.5k.
Files over 400 lines: see §3.4 (CQ-27).

### 0.3 Dirty working tree

`git status` shows uncommitted edits to `apps/web/package.json`, `components/AppMenu.tsx`, `components/Shell.tsx`, `components/ui/sidebar.tsx`, `styles.css`, `test/shell-collapse.test.tsx`, `supabase/.temp/cli-latest`, plus untracked `apps/web/scripts/dev.mjs` and `.sidebar-reference/`.
That is the UX track's sidebar work in progress. **No work package below touches those files.** Where a fix would need them (CQ-01), the fix is placed in a different file.

### 0.4 Other audit tracks already in this folder

`audit-offline-sync.md` (OS-01…22, WP-A…G) and `audit-crud-routes.md` (CR-01…44, WP-00…14) were written in parallel.
They already plan to rewrite most of `apps/api/src/routes/*`, `apps/web/src/screens/*`, `http.ts`, `server.ts`, `db.ts`, `api.ts`, `offline.ts`, `SyncBadge.tsx`, `hooks.ts`, `app-context.tsx`, `menu.ts`, `App.tsx`, `e2e/*`, and the SDKs.
To avoid three tracks editing the same files, this report does two things:

1. Findings that those plans already cover are listed here with a **cross-reference** and the *code-quality acceptance criteria* the owning package must meet. They are not given a new work package.
2. The work packages in §5 own only files the other plans do not list, mostly **new** files, and give the other packages shared helpers to adopt. Enforcement of the adoption is by lint rules (§6), so nobody has to edit someone else's file.

---

## 1. Executive summary

**Overall.** The structure is sound where it matters most. Every tenant endpoint goes through `defineRoute`, every tenant table has RLS and a policy, money is integer minor units end to end, and the fee engine is pure and tested. The problems are duplication that has grown with feature speed, a handful of integrity bugs on the offline path, and no tooling that would stop either from getting worse.

Counts: see the index in §2 (58 findings).

### Top 12, in the order to fix them

| # | ID | Sev | One line |
| --- | --- | --- | --- |
| 1 | CQ-01 | blocking | `SyncBadge` is mounted twice in every tab (`Shell.tsx:35`, `AppMenu.tsx:177`), so two flush loops race and misfile successful writes as conflicts. |
| 2 | CQ-02 | blocking | Queued writes carry no capture time; the web sends no `deviceAt` anywhere, and offline check-out records payment `0`. Fee and `in_at` are set at replay time. |
| 3 | CQ-03 | high | `/v1/alpr/read` holds a DB transaction (and a pooled connection) open across a 15 s HTTP call. The pool is 2 on Vercel. |
| 4 | CQ-05 | high | Four different plate normalisers; the web and the search API strip every non-`A-Z0-9` character, which erases Arabic and `Ñ` plates the architecture says must match. |
| 5 | CQ-11 | high | Five copy-pasted bulk-import pipelines (about 45 lines of route and 12 lines of parser each). |
| 6 | CQ-13 | high | Idempotency logic duplicated between `defineRoute` and `definePlatformRoute`; only one secret field is redacted; coverage is inconsistent across creates. |
| 7 | CQ-12 | high | Authenticated identity routes are registered as "public", so OpenAPI shows no security on them and each handler re-implements auth and `req.params as {…}` casts. |
| 8 | CQ-50 | high | No lint, no formatter, no unused-code gate. Tests are not type-checked (tsc finds 5 errors in API tests and 35 in web tests). |
| 9 | CQ-27 | high | `Attendant.tsx` is 820 lines with five screens and six helper components in it. `passes.ts` (516) and `people.ts` (475) are close behind. |
| 10 | CQ-29 | high | Two styling systems run side by side: shadcn components plus about 100 legacy `className="btn …"` uses over a 242-line `styles.css`. |
| 11 | CQ-30 | high | The web app does not depend on `@openpark/core`, so it re-implements plate logic, hand-copies `RateRules`, and reaches the plate registry through a four-level relative glob. |
| 12 | CQ-28 | high | Three copies of the import/export UI (`Inventory.tsx`, `Bulk.tsx`, the Units card in `People.tsx`) that already diverge (idempotency keys, rollback). |

### What to do first

1. **Land `WP-Q1` (shared contracts in `packages/core`)**. It is additive, small, and every other package imports from it.
2. In parallel: **`WP-Q6`** (guardrails: lint rules, test type-check, untrack generated files), **`WP-Q9`** (ALPR service), **`WP-Q4`** (DB guards) and **`WP-Q5`** (test gaps). These touch files nobody else owns.
3. Hand the "adoption checklists" in §5.3 to the owners of the CRUD and offline work packages. Several blocking and high findings (CQ-01, CQ-02, CQ-11, CQ-12, CQ-13) are fixed there, not in a new package.

---

## 2. Finding index

| ID | Sev | Area | Title | Fixed in |
| --- | --- | --- | --- | --- |
| CQ-01 | blocking | web sync | `SyncBadge` mounted twice; concurrent flush misfiles successes as conflicts | OS WP-F + OS WP-B (acceptance in §5.3) |
| CQ-02 | blocking | web+api sync | Capture time never sent; offline check-out pays `0`; `deviceAt`, `deviceId`, `gate` are dead params | OS WP-C/D/F |
| CQ-03 | high | api | ALPR read holds a DB transaction across an HTTP call | WP-Q3 (+ CRUD WP-00 option) |
| CQ-04 | high | api+web | Payment amount is never reconciled with the fee | OS WP-D + CRUD WP-04 |
| CQ-05 | high | core/web/api/py | Plate normalisation diverges (4 implementations); non-Latin plates are erased | WP-Q1 + WP-Q7 |
| CQ-06 | medium | web/api | Country tables disagree (14 vs 6 vs 6): picking Colombia creates a USD/US tenant | WP-Q1 + WP-Q7 |
| CQ-07 | medium | web/api | Hard-coded thresholds disagree with each other and with tenant policy | WP-Q1 + CRUD WPs |
| CQ-08 | medium | web | `Rates.tsx`: cap of `0`, device-timezone datetimes, hard-coded sample dates | CRUD WP-03 |
| CQ-09 | medium | db/jobs | Delivery and ledger tables are never purged | WP-Q4 |
| CQ-10 | low | db | `migrate()` has no lock; SQL functions are redefined 3–6 times | WP-Q4 |
| CQ-11 | high | api | Five bulk-import pipelines copy-pasted | CRUD WP-10 using WP-Q1/Q2 pieces |
| CQ-12 | high | api | Identity routes registered as public; `req.params` casts | CRUD WP-00 |
| CQ-13 | high | api | Idempotency duplicated, under-redacted, inconsistently applied | CRUD WP-00 / OS WP-D |
| CQ-14 | medium | api | Mixed-responsibility route and service files; file names lie | CRUD WP-01…12; WP-Q3 for services |
| CQ-15 | medium | api | 160 untyped `rows[0]`; response key casing is mixed | WP-Q2 (helpers) + CRUD WP-00 |
| CQ-16 | medium | api | Duplicated SQL fragments | WP-Q2 (`lookups.ts`) |
| CQ-17 | medium | api | Three pairs of near-identical notification flows | WP-Q3 |
| CQ-18 | medium | api+web+sdk | Schema fragments redefined 3–5 times each | WP-Q1 |
| CQ-19 | medium | api | Ad-hoc PG error inspection (7 casts) | WP-Q2 |
| CQ-20 | low | api | Magic numbers | WP-Q2 |
| CQ-21 | low | api | Env boolean boilerplate ×6 | WP-Q2 |
| CQ-22 | low | api | Dead or unused code | WP-Q11 |
| CQ-23 | low | api+web | "property" vs "tenant" vs "community"; email in URL path | CRUD WP-06, WP-Q11 |
| CQ-24 | medium | api | Server messages use a second i18n system; English-only duration | WP-Q3 |
| CQ-25 | low | api | Manual `begin/commit` in `server.ts` | CRUD WP-00 |
| CQ-26 | medium | api+web | Money maths (`/100`, `*100`) in 9 places, no currency exponent | WP-Q1 + WP-Q7 |
| CQ-27 | high | web+api | God files (>400 lines) | CRUD WP-04, WP-09; WP-Q3 |
| CQ-28 | high | web | Three import/export UIs | CRUD WP-10 |
| CQ-29 | high | web | Two styling systems | UX track + CRUD WPs, lint rule in WP-Q6 |
| CQ-30 | high | web | Web ignores `@openpark/core` | WP-Q1 + WP-Q7 |
| CQ-31 | medium | web | Error text: `errText` vs raw `ApiError.message` (12 sites) | WP-Q7 + lint |
| CQ-32 | medium | web | `me!` ×25, `null as never` context, dead `can()` branches | WP-Q7 + OS WP-A |
| CQ-33 | medium | web | Hand-copied API DTO interfaces | WP-Q7 |
| CQ-34 | medium | web | URLs built by string concatenation (12 sites) | WP-Q7 |
| CQ-35 | medium | web | Form and mutation boilerplate | CRUD WP-00 `useWrite` (CR-20) |
| CQ-36 | medium | web | Homemade Collapsible/Tabs; 6 unused shadcn files; 4 native dialogs | CRUD WP-00 (CR-12) |
| CQ-37 | medium | web | Dates bypass `useFormat` and the site timezone | WP-Q7 + lint |
| CQ-38 | medium | web | `useApi` stale-response race; inline `QueryState` copy | OS WP-A |
| CQ-39 | low | web | Unused imports, locals, exports | WP-Q11 |
| CQ-40 | low | web | Three import-path styles | WP-Q6 lint |
| CQ-41 | low | web | Magic numbers | WP-Q7 |
| CQ-42 | low | marketing | Locale tables duplicated; 7 locales built, 2 surfaced | WP-Q10 |
| CQ-43 | low | web | `LiveCamera` stale `regions`; stabiliser built once | OS WP-E |
| CQ-44 | medium | core | Dead and unwired code (`exportSlots`, `correctConfusables`) | WP-Q1 decision |
| CQ-45 | medium | core | Fee-engine test gaps | WP-Q5 |
| CQ-46 | medium | sdk-ts | `any`, unguarded `JSON.parse`, thin coverage, licence boundary | CRUD WP-13 |
| CQ-47 | low | sdk | TS and Python SDK surfaces drift | CRUD WP-13 |
| CQ-48 | medium | alpr | Pin check never called; `vote()` unused; no input limits | WP-Q9 |
| CQ-49 | medium | api | Three pooled connections per request; Fastify decorations typed through `as unknown as App` | CRUD WP-00 / OS WP-D (`server.ts`) |
| CQ-50 | high | tooling | No lint/format/knip; tests not type-checked; strict unused flags off | WP-Q6 |
| CQ-51 | medium | api tests | Security-critical pure functions have no tests | WP-Q5 |
| CQ-52 | medium | web tests | Test setup duplicated across 13 files | WP-Q6 |
| CQ-53 | medium | e2e | 15 independent scripts, one wired, none in CI | WP-Q8 |
| CQ-54 | medium | CI | No lint, e2e, Python lint, dependency audit | WP-Q6 |
| CQ-55 | medium | repo | Tracked generated files and root clutter | WP-Q6 |
| CQ-56 | low | docs | `AGENTS.md`, `CLAUDE.md`, README status overlap | WP-Q6 |
| CQ-57 | medium | db | No automated check that every tenant table has RLS + policy + grant | WP-Q4 |
| CQ-58 | low | db | JS `Date` (ms) is the only clock for stay times | OS WP-C/D (OS-04) |

Counts: blocking 2 · high 11 · medium 31 · low 14 · total 58.

---

## 3. Findings

Format: **Evidence** (file:line) · **Why it matters** · **Fix** (precise enough to implement) · **Cross-ref**.

### 3.1 Correctness and integrity

#### CQ-01 · blocking · Two `SyncBadge` instances race the offline queue
- **Evidence:** `components/Shell.tsx:35` renders `<SyncBadge />` in the top bar; `components/AppMenu.tsx:177` renders another in the sidebar footer. Each instance runs its own `useEffect` (`SyncBadge.tsx:33-50`): on mount, on the `online` event, and every 30 s it calls `sync()` → `flush(send, userId)`. `flush` (`offline.ts:57-75`) has no lock; it reads `listQueue()` and sends item N. Two instances read the same queue and both send item N with the same `Idempotency-Key`.
- **Why it matters:** the loser gets either `409 request_in_progress` (`http.ts:124-126`) or a domain 409 such as `already_inside`, because `defineRoute` checks the key with a plain `select` *before* running the handler (`http.ts:101`) and only inserts it at the end (`:118`). `flush` treats any non-5xx, non-401 response as a conflict (`offline.ts:65-72`), writes it to the `conflicts` store, then deletes the queue row (`:75`). A write that actually succeeded now shows up as a conflict needing a human. This happens on every reconnect in every tab, not only with multiple tabs. `audit-offline-sync.md` OS-08 describes the race but says `SyncBadge` is "mounted once per open tab"; it is mounted twice.
- **Fix (does not touch `Shell.tsx` or `AppMenu.tsx`):**
  1. New module `apps/web/src/sync/engine.ts` exporting `startSync(): () => void`. It is reference-counted, so mounting N badges starts one timer and one set of listeners.
  2. `flush` runs under `navigator.locks.request('openpark-flush', { ifAvailable: true }, …)` with an in-memory mutex fallback.
  3. A pure `classify(r: SendResult): 'done' | 'retry' | 'conflict' | 'auth'` where `408|425|429|5xx|409 request_in_progress → retry`.
  4. `SyncBadge` becomes a thin view over `useSyncState()`.
  5. Ask the UX track to delete one of the two `<SyncBadge />` mounts when their sidebar change lands.
- **Cross-ref:** OS-08, OS-15, OS WP-B and WP-F own the implementation. **Acceptance test:** mount two badges, fire `online`, assert `fetch` is called once per queued write and `listConflicts()` stays empty.

#### CQ-02 · blocking · Capture time is lost; offline check-out records `0`
- **Evidence:** `rg 'deviceAt|deviceId' apps/web/src` returns nothing. The server accepts them (`routes/sessions.ts:9`, `routes/passes.ts:10`) but uses `app.now()` for `in_at` (`services/sessions.ts:90,142`) and `out_at` (`:236,241`); `deviceAt` only feeds a warning (`:91`). `Attendant.tsx:741` queues `payment: { method: pay, amount: 0 }`. `api.ts:75` stores a client `at` that nothing reads. `QueuedWrite.token` is always `''` (`api.ts:75`) and never read.
- **Why it matters:** an offline check-in at 08:12 synced at 09:40 starts the fee clock at 09:40 and the audit trail records the wrong arrival. Offline check-out prices the stay at replay time and books zero payment.
- **Fix:** the envelope design is in `audit-offline-sync.md` §2.2 (`clientAt` microsecond string, `mutationId`, `deviceId`, `clientSeq`). Code-quality additions: (a) delete `QueuedWrite.token`; (b) define the envelope once as a Zod schema in `packages/core` (OS WP-C) and import it from both `routes/sessions.ts` and `routes/passes.ts` instead of the two copies of `Device` (`routes/sessions.ts:9`, `routes/passes.ts:10`); (c) add a regression test that fails if any call to `write()` in `src/` omits the envelope.
- **Cross-ref:** OS-02, OS-03, OS-04.

#### CQ-03 · high · ALPR read pins a DB connection during a 15 s HTTP call
- **Evidence:** `routes/misc.ts:42-95`. `defineRoute` wraps the whole handler in `withTenant` (`http.ts:97`). Inside it the handler calls `fetch(ALPR_URL/read, { signal: AbortSignal.timeout(15_000) })` (`misc.ts:55-58`), then `app.storage.put` (`:79`), then inserts. `DB_POOL_MAX` is 2 on Vercel (`config.ts:46`).
- **Why it matters:** two slow reads exhaust the pool and every other request on that instance waits. The same shape applies to any handler that awaits network I/O.
- **Fix:** (1) add `tx?: 'tenant' | 'none'` to `RouteDef` (default `'tenant'`). With `'none'` the handler receives `ctx` and `app` but no `db`, and uses `app.db.withTenant(ctx.tenantId, fn)` for short reads and writes. (2) Rewrite the ALPR route as: short tx to read tenant + site → call the worker with no transaction → short tx to insert `plate_read` and emit. (3) Move the handler to a new `routes/alpr.ts` (a 55-line contiguous block leaves `misc.ts`). (4) Replace the crop key `${Date.now()}-${Math.random()…}` (`misc.ts:78`) with `crypto.randomUUID()`.
- **Owner:** WP-Q3 does steps 2–4; step 1 is a one-field change in `http.ts` that CRUD WP-00 owns (listed in §5.3).

#### CQ-04 · high · Payments are not reconciled with the fee
- **Evidence:** `services/sessions.ts:264-269` `recordPayment` stores whatever `amount` it is given and numbers receipts `R-{ticket}-{n+1}`. `routes/sessions.ts:8` allows `amount ≥ 0` with no upper bound and `:97-103` allows any number of payments per closed session. The web sends the fee from the *preview* it fetched earlier (`Attendant.tsx:732`), but the server computes the fee again at confirm time (`sessions.ts:237`).
- **Why it matters:** over- and under-payment are silently accepted, two payments can be recorded for one fee, and the shift report (`routes/misc.ts:106-108`) sums them.
- **Fix:** in `recordPayment`, load `session.fee`, sum prior `payment` events, and compare. Return `{ receiptNo, paid, due, variance }`. If `paid > due` reject with `409 overpayment` unless the caller has `fee.override`; if `paid < due` record it and add a `payment_variance` event (this matches OS-02's design). Add a test for each branch.
- **Cross-ref:** OS-02, OS WP-D. CRUD WP-04 owns the session routes.

#### CQ-05 · high · Four plate normalisers; two destroy non-Latin plates
- **Evidence:**
  - `packages/core/src/plate.ts:27-30`: NFKC, uppercase, strip separators only, fold Arabic-Indic digits. Correct per `ARCHITECTURE.md` ("`plate_norm` … native script").
  - `apps/web/src/alpr/plates.ts:7`: `s.toUpperCase().replace(/[^A-Z0-9]/g, '')`. Deletes every non-ASCII letter. Used at `Attendant.tsx:319` and `:791`.
  - `Attendant.tsx:658-659`: the same regex inline, for check-out search.
  - `routes/sessions.ts:140,145`: `q.plate.toUpperCase().replace(/[^A-Z0-9]/g, '')` for the sessions log filter.
  - `services/alpr/app/main.py:47`: `.replace(" ", "").replace("-", "")`, a fourth rule, for de-duplicating candidates.
- **Why it matters:** an Arabic, Cyrillic or `Ñ`-bearing plate normalises to a shorter string (or `''`) on the client and in search, but to the full string in `vehicle.plate_norm`. Search and autocomplete miss it. The product ships an `ar` locale and `registry/plates/` is meant to grow.
- **Fix:** keep `normalizePlate` in core as the only implementation. Web: `export { normalizePlate } from '@openpark/core'` in `alpr/plates.ts` (keeps imports stable); replace the two inline regexes with it. API: filter with `v.plate_norm like $n` using `normalizePlate(q.plate)`. Python: de-duplicate on `c.text.upper()` after removing the same separator set (document that Python only de-duplicates and never writes `plate_norm`). Add one core test with an Arabic plate, one with `Ñ`, and one test in the API that searches for each.

#### CQ-06 · medium · Country tables disagree
- **Evidence:** `screens/Auth.tsx:16` offers 14 countries; `screens/Platform.tsx:64` offers 6; `services/demo.ts:13-26` knows 6 (`MX, US, BR, DE, FR, ES`). `provisionTenant` does `COUNTRIES[input.country] ?? DEFAULT_COUNTRY` (`tenants.ts:26`) and `DEFAULT_COUNTRY` is US.
- **Why it matters:** a user who picks Colombia gets `currency: 'USD'`, timezone `America/New_York`, plate region `US`, locale `en`, but `tenant.country = 'CO'`. Silent wrong defaults.
- **Fix:** move the table to `packages/core/src/countries.ts` (§5.2 contract) and export `COUNTRY_CODES`. The signup and platform forms render from it; `provisionTenant` rejects an unknown code with `400 country_unsupported`. Until a country has real defaults, it is not offered.

#### CQ-07 · medium · Thresholds that should agree do not
- **Evidence:** AI auto-accept threshold: `0.95` at `routes/misc.ts:72`, `routes/slots.ts:36`, `Settings.tsx:18`; `0.85` at `Attendant.tsx:322`. `DOMAIN.md` documents the field as 0.5–1; the slider is 0.8–0.99 (`Settings.tsx:48`).
  Stay alerts use per-tenant `reminderHours` and `maxStayHours` (`passes.ts:17-31`, `due_stay_alerts` in `009_multi_roles.sql`), but `/v1/occupancy` hard-codes `interval '10 hours'` and `'12 hours'` (`routes/slots.ts:170-177`) for the capacity-bar overlays.
- **Why it matters:** the same site behaves differently on the web than on the server, and a tenant that changes its policy sees alerts at one time and the capacity bar at another.
- **Fix:** `AI_THRESHOLD_DEFAULT = 0.95` exported from core (`schemas.ts`) and used in all four places. The occupancy handler loads the policy (`loadPolicy(db)`) and uses `policy.reminderHours[0]` and `policy.maxStayHours` in one query with `count(*) filter (where …)`.

#### CQ-08 · medium · `Rates.tsx` edge cases
- **Evidence:** `Rates.tsx:60`: `onChange={(e) => set('dailyCap', e.target.value ? Math.round(Number(e.target.value) * 100) : null)}`. The string `"0"` is truthy, so typing `0` sets a cap of `0`, which charges nothing for any stay over 24 h blocks. `Rates.tsx:18,28-29`: `new Date(local).toISOString()` interprets the datetime in the *device* timezone, while the rest of the app promises site-timezone display; the default simulator times are the literal strings `'2026-10-20T08:12'` and `'2026-10-20T14:09'`.
- **Fix:** add `toMinor`/`fromMinor` (CQ-26) and a `localToUtc(local: string, tz: string): string` helper (§5.2, `lib/dates.ts`); cap input empty → `null`, `"0"` → rejected with a field error. Default simulator times: derive from `new Date()` truncated to the hour, shown in site timezone.
- **Cross-ref:** CR-15, CRUD WP-03 owns the screen.

#### CQ-09 · medium · Ledger tables grow without bound
- **Evidence:** `jobs.ts:107-120` purges plate crops; `015_review_round2.sql:18` purges idempotency keys. Nothing deletes `webhook_delivery` (delivered or dead), `stay_alert`, `pass_notification`, or `inventory_import` (whose `doc`/`diff`/`snapshot` are large JSON). The app role also has no `delete` grant on the first three (`005`, `009`, `003`).
- **Fix:** migration adds `purge_delivery_history(p_days int) returns int` (security definer, `search_path = public`, `revoke … from public; grant … to openpark_app`) that deletes delivered/dead webhook deliveries, sent/skipped alerts and notifications, and applied/rolled-back imports older than `p_days`. Call it from `Jobs.purge` and from `/v1/cron/retention`, with a default of 90 days and a `retentionDays`-style tenant setting later.

#### CQ-10 · low · Migration runner and SQL function archaeology
- **Evidence:** `migrate.ts:15-30` has no advisory lock, so two containers starting together can both apply a migration. `user_memberships` is dropped and recreated in `003`, `009` and `018`; `claim_invites` is redefined in `003`, `009`, `012`, `018` (twice); `accept_invite` in `016` and `018` (twice).
- **Fix:** wrap the loop in `select pg_advisory_lock(727274)` / `pg_advisory_unlock`. Add `apps/api/migrations/README.md` stating that function bodies are redefined and listing the *current* migration for each function; add a test (CQ-57) that fails if a `security definer` function has no `set search_path`.

### 3.2 API structure and DRY

#### CQ-11 · high · Five bulk-import pipelines, copy-pasted
- **Evidence:**
  - Parsers: `services/units.ts:36-48`, `usersimport.ts:30-42`, `sites.ts:34-46`, `community.ts:29-41`, `routes/inventory.ts:12-34`. Same 12 lines each (`{ text }` unwrapping, `JSON.parse`, `locate(text)`, `HttpError(400,'invalid_json')`, Zod `safeParse`, `schema_invalid` with `issues.map(path,message)`). `locateJsonError` is passed in as a callback to four of them (`routes/people.ts:194,211,312,329`) instead of being imported.
  - Routes: units `people.ts:188-215`, users `people.ts:307-349`, sites `slots.ts:260-304`, community `auth.ts:127-165`, inventory `inventory.ts:50-96`. Each re-implements: insert into `inventory_import`, `summary` counts, `select … where id=$1 and kind=… for update`, `job_not_found`, `dry_run`, `not_previewed`, update status, and the rollback twin. Units has no rollback route at all.
- **Why it matters:** about 250 duplicated lines; a fix (for example the `dry_run` message) must be made five times; the units path already diverged.
- **Fix (CRUD WP-10 owns the routes; these are the shared parts):**
  ```ts
  // apps/api/src/services/bulk/parse.ts
  export function parseJsonDoc<T>(raw: unknown, schema: z.ZodType<T>, label: string): T;
  //   accepts the document or { text }; imports locateJsonError itself; throws the same HttpErrors as today.

  // apps/api/src/services/bulk/kind.ts
  export interface BulkKind<Doc, Diff, Applied, Snap = never> {
    kind: 'inventory' | 'units' | 'sites' | 'users' | 'community';
    perm: Permission;
    schema: z.ZodType<Doc>;
    modes: boolean;                                   // merge/replace supported
    preview(db: Db, doc: Doc, mode: 'merge' | 'replace'): Promise<Diff>;
    summarize(diff: Diff): Record<string, number>;
    apply(a: { app: App; db: Db; ctx: Ctx; doc: Doc; mode: 'merge' | 'replace' }): Promise<{ applied: Applied; snapshot?: Snap }>;
    rollback?(a: { db: Db; ctx: Ctx; snapshot: Snap }): Promise<unknown>;
  }
  export function registerBulkRoutes(app: App, kind: BulkKind<…>): void;   // or the /v1/imports factory in CR-30
  ```
  Each existing `services/{units,usersimport,sites,community,inventory}.ts` exports one `BulkKind` constant and deletes its own `parse*Doc`. Route paths stay as they are until CRUD WP-10 introduces `/v1/imports`.
- **Cross-ref:** CR-30, CR-13.

#### CQ-12 · high · Identity routes registered as public; `params` casts
- **Evidence:** `routes/people.ts:25-63` registers `/v1/auth/invitations`, `/v1/auth/invitations/:slug/accept` and `/v1/auth/memberships` with `definePublicRoute`, then each handler calls `app.identify(req)` itself. In the OpenAPI registry they get `perm: 'public'` (`http.ts:138`) and therefore no `security` block (`:232`). `definePublicRoute` and `definePlatformRoute` handlers have no `params`, so the code casts: `req.params as { slug: string }` at `people.ts:38,392,405,443,453`. `/v1/signup` with an external token has the same shape (`auth.ts:48`).
- **Fix:** in `http.ts` add `defineIdentityRoute(app, { method, path, summary, body?, query?, handler({ app, req, reply, identity, body, query, params }) })` that calls `app.identify` and registers `perm: 'identity'` so OpenAPI emits the bearer scheme. Add `params` and `query` to the handler arguments of `definePublicRoute` and `definePlatformRoute`. Migrate the three identity routes and delete the five casts.
- **Owner:** CRUD WP-00 (it owns `http.ts`). **Acceptance:** `rg "req.params as" apps/api/src` returns nothing; the generated `openapi.json` has `security` on `/v1/auth/memberships`.

#### CQ-13 · high · Idempotency: duplicated, under-redacted, inconsistently applied
- **Evidence:**
  - Duplicated: the request hash `createHash('sha256').update(\`${method} ${url} ${JSON.stringify(body ?? null)}\`)` at `http.ts:100` and `:185`; the "key required" check at `:92` and `:168`; the replacer `(k, v) => (k === 'temporaryPassword' ? null : v)` at `:120` and `:209`.
  - Under-redacted: only `temporaryPassword` is stripped. `POST /v1/api-keys` returns `{ key }` (`auth.ts:182`) and `POST /v1/webhooks` returns `{ secret }` (`:245`). Making either replay-safe today would persist the secret in `idempotency_key.response` in clear.
  - Inconsistent: `idempotent: true` on session, pass, units/sites/community/users apply and rollback routes; `replaySafe` on unit, site, zone, slot, user creates and imports; **neither** on `POST /v1/rate-plans` (`rates.ts:24`, creates a new version per call), `POST /v1/api-keys`, `POST /v1/webhooks`, and `POST /v1/inventory/import/:job/apply|rollback` (`inventory.ts:64,83`).
  - Race: see OS-09 (the key row is inserted after the handler runs).
- **Fix:** extract one module:
  ```ts
  // apps/api/src/idempotency.ts
  export const DEFAULT_SECRET_FIELDS = ['temporaryPassword'] as const;
  export function requestHash(method: string, url: string, body: unknown): string;
  export function redact(body: unknown, fields: readonly string[]): unknown;
  export interface IdempotencyStore {
    reserve(key: string, hash: string): Promise<'reserved' | { status: number; body: unknown } | 'in_flight' | 'reuse'>;
    commit(key: string, status: number, body: unknown): Promise<void>;
    release(key: string): Promise<void>;
  }
  ```
  `defineRoute` and `definePlatformRoute` each supply a store (tenant table vs platform table) and share the same flow. Add `secretFields?: string[]` to `RouteDef`; set `['key']` on api-keys and `['secret']` on webhooks, then make both `replaySafe`. Make rate-plan create `replaySafe`, and inventory apply/rollback `idempotent`.
- **Owner:** CRUD WP-00 (CR-35) with OS WP-D (OS-09). **Acceptance:** a unit test per store; `rg "temporaryPassword'" apps/api/src/http.ts` returns nothing.

#### CQ-14 · medium · Mixed-responsibility files with misleading names
- **Evidence:**
  - `routes/people.ts` (475 lines): public config, invitations, memberships, profile, avatar upload, units CRUD, units import, users CRUD, user import, invites, platform tenants, suspend/resume.
  - `routes/slots.ts` (305): sites, zones, slots, slot suggest, occupancy, sites bulk.
  - `routes/auth.ts` (248): signup, login, `/v1/me`, tenant settings, community bulk, API keys, webhooks.
  - `routes/misc.ts` (167): OpenAPI, plate regions, signed files, ALPR, reports, audit, two crons, SSE.
  - `services/passes.ts` (516): policy, token, presentation, resident ops, gate ops, notifications, reminders, stay alerts.
  - `services/sites.ts` holds the sites import; `services/units.ts` holds the units import; `services/community.ts` is only an import. Names say nothing about bulk.
- **Fix:** route files are split by CRUD WP-01…12 (`routes/{sites,slots,units,users,api-keys,webhooks,community,platform,…}.ts`). Services: WP-Q3 splits `passes.ts` into `services/passes/{policy,token,passes,gate,notify,stay-alerts}.ts` with `services/passes.ts` kept as a barrel `export * from './passes/…'` so no importer changes. Bulk services move under `services/bulk/` with the `BulkKind` pattern (CQ-11).

#### CQ-15 · medium · Untyped rows and mixed key casing
- **Evidence:** 160 uses of `.rows[0]` in `apps/api/src` across 19 files (`routes/people.ts` 30, `routes/slots.ts` 28, `services/passes.ts` 17, `services/sessions.ts` 15, `routes/auth.ts` 11, `server.ts` 8, …). `pg` returns `any`, so every access is unchecked. JSON key casing is mixed: `/v1/sessions` returns `ticket_code`, `in_at`, `in_by`; `/v1/units` returns `pass_status`; `/v1/me` returns `tenant.default_locale`, `retention_days` next to `unitVerified`, `avatarUrl`; `/v1/occupancy` returns `outOfService`, `issuedPending`, `last24h` next to `zone_name`. OpenAPI responses are `{ '200': OK, '4XX': … }` only (`http.ts:231`), so no client type can be generated (CR-34).
- **Fix:** (a) `apps/api/src/sql.ts` (new, no existing file edited):
  ```ts
  export async function one<T>(db: Db, sql: string, args?: unknown[]): Promise<T>;        // throws if no row
  export async function maybeOne<T>(db: Db, sql: string, args?: unknown[]): Promise<T | undefined>;
  export async function many<T>(db: Db, sql: string, args?: unknown[]): Promise<T[]>;
  ```
  New and rewritten code uses these with an explicit row type. (b) Response schemas: add `response?: z.ZodTypeAny` to `RouteDef` (CRUD WP-00) and map rows to camelCase DTOs in a `dto.ts` next to each route file; use the same Zod schema for OpenAPI. Do not mass-convert existing routes in one change; convert per resource as CRUD WPs touch them.

#### CQ-16 · medium · Duplicated SQL fragments
- **Evidence:**
  - Supervisor/admin recipients: inline at `passes.ts:359-361`, again as a function `staffRecipients` at `:456-459` that the first copy does not use.
  - "Default rate plan of any site": `routes/slots.ts:32`, `services/sites.ts:111` and `:167`.
  - "Site id by code, not retired": `routes/people.ts:134,153`, `routes/auth.ts:175`, `services/sites.ts:129`, `units.ts:66`.
  - Slot-type validation (`select slot_types from tenant` + `types.some(...)`): `routes/slots.ts:190-191` and `:232-234`.
  - Occupancy: three queries with the same site predicate (`routes/slots.ts:166-177`) that can be one `count(*) filter (...)` query.
  - Stay-alert retry window `interval '10 minutes'`: `passes.ts:335` and `:465`; attempts cap `5` in `009_multi_roles.sql` `due_stay_alerts`.
- **Fix:** `apps/api/src/services/lookups.ts` (new):
  ```ts
  export async function siteIdByCode(db: Db, code: string, opts?: { includeRetired?: boolean }): Promise<string | undefined>;
  export async function defaultRatePlanId(db: Db): Promise<string | null>;
  export async function staffRecipients(db: Db): Promise<Recipient[]>;      // supervisors, else admins
  export async function assertSlotType(db: Db, type: string): Promise<void>; // 400 slot_type_unknown
  export async function tenantRow<K extends 'currency' | 'plate_regions' | 'slot_types' | 'ai_mode'>(db: Db, ...cols: K[]): Promise<Pick<TenantRow, K>>;
  ```
  WP-Q3 uses `staffRecipients` and the retry-window constant inside `services/passes/*`. Other owners adopt the rest as they edit their files; the lint rule in §6 flags a second `select id from site where code`.

#### CQ-17 · medium · Three pairs of near-identical notification flows
- **Evidence:** `sendPassNotification` (`passes.ts:352-409`) vs `sendStayAlert` (`:470-491`): both loop recipients, call `app.notifier.send`, count `sent/undeliverable/failed`, and compute `const status = outcome.sent ? 'sent' : outcome.failed ? 'failed' : 'skipped'` (`:405`, `:488`). `processPassReminders` (`:415-447`) vs `processStayAlerts` (`:494-516`): group due rows by id, take the latest kind, mark earlier ones skipped, record, send. `recordNotification` (`:331`) vs `recordStayAlert` (`:461`): same upsert SQL for two tables.
- **Fix:** inside `services/passes/notify.ts`: `deliver(app, parties: { recipient: Recipient; msg: Rendered }[]): Promise<Outcome>` and `statusOf(outcome)`; a generic `processDue<K extends string>(app, rows, { order: K[], skipOlder, record, send })`. Keep both tables for now; fold into a single `notification_ledger(subject_type, subject_id, kind)` only if the schema is touched for another reason.

#### CQ-18 · medium · Schema fragments redefined across files
- **Evidence:**

  | Fragment | Copies |
  | --- | --- |
  | `ROLES` / `Role` | `api/auth.ts:7`, `web/app-context.tsx:8`, SQL check in `009_multi_roles.sql`, plus three Zod enums (`routes/people.ts:15`, `routes/auth.ts:26`, `usersimport.ts:11`) |
  | Phone E.164 regex `^\+[1-9]\d{7,14}$` | `routes/sessions.ts:15`, `services/passes.ts:135`, `routes/people.ts:67`, `web/attendant-flow.ts:70`, `Resident.tsx:209` |
  | Site/zone code regex | `routes/slots.ts:28,74`, `services/sites.ts:7`, and three web `pattern=` attributes (`Parking.tsx:67,214,251`); slot variant at `slots.ts:185` |
  | IANA timezone check | `routes/slots.ts:10`, `services/sites.ts:9` |
  | Payment method `cash\|card\|account` | `routes/sessions.ts:8`, `services/sessions.ts:28`, `sdk-ts/src/index.ts:31`, web `Pay` type (`Attendant.tsx:625`), shift-report SQL (`misc.ts:106-108`) |
  | Plate source `manual\|ai_assist\|ai_auto` | `routes/sessions.ts:26`, `routes/passes.ts:59`, `services/sessions.ts:16`, `web/attendant-flow.ts:8`, `sdk-ts:21` |
  | Webhook event list | `routes/auth.ts:28`, `jobs.ts:9`, `web/Integrations.tsx:16`, `web/hooks.ts:78` |
  | `plate`, `vehicle`, `read`, `Device` bodies | `routes/sessions.ts:7-33` and `routes/passes.ts:10,55-63` (identical objects) |
  | `slot status` enum | `core/inventory.ts:4`, `routes/slots.ts:223`, `web/Parking.tsx:21` |
- **Fix:** one module per concern in `packages/core/src` (contract in §5.2: `roles.ts`, `schemas.ts`). API routes and services import from it; web imports the same constants and Zod schemas for form validation. The SDK is Apache-2.0 and must not import the AGPL core (CQ-46), so it keeps its own copies until it is generated from OpenAPI.

#### CQ-19 · medium · Ad-hoc Postgres error checks
- **Evidence:** seven casts: `services/sessions.ts:145`, `services/tenants.ts:36-37`, `services/passes.ts:182`, `server.ts:67`, `http.ts:124`, `http.ts:191`, plus the `['22P02','22003','22007','22008']` literal at `server.ts:148`.
- **Fix:** `apps/api/src/pgerrors.ts` (new): `export const PG = { UNIQUE: '23505', INVALID_TEXT: '22P02', … } as const; export function isPgError(e: unknown): e is { code: string; constraint?: string }; export function isUniqueViolation(e: unknown, constraint?: string): boolean;`. Replace the seven sites when each file is next touched; the lint rule bans new `as { code?: string }` casts.

#### CQ-20 · low · Magic numbers in the API
`server.ts:75` body limit `12 * 1024 * 1024`; `misc.ts:57` ALPR timeout `15_000`; `misc.ts:162` SSE heartbeat `25_000`; `people.ts:87` avatar `102_400`; `people.ts:122` `limit 500`; `jobs.ts:49,52,59,80` retry limit 6, backoff table, timeouts 5 000 / 10 000; `notifier.ts` timeouts 10 000; `sessions.ts:137` five ticket attempts; `src/auth.ts:52` token TTL `12 * 3600`; `tenants.ts:68` `500000` MXN overstay.
**Fix:** `apps/api/src/limits.ts` exporting a frozen `LIMITS` object with names and units in the key (`ALPR_TIMEOUT_MS`, `AVATAR_MAX_BYTES`, …). Move the MXN overstay default into the country table (`CountryDefaults.overstayCharge`) instead of `currency === 'MXN' ? 500000 : 0` (steering note: it stays a seeded default, not enforcement).

#### CQ-21 · low · Boolean env parsing ×6
`config.ts:24,29,42,45,48,54` each repeat `z.enum(['true','false','1','0']).default(…).transform((v) => v === 'true' || v === '1')`; `http.ts:10` `boolQuery` is the same idea for query strings. **Fix:** `const envBool = (def: boolean) => …` in `config.ts`; reuse for `boolQuery`.

#### CQ-22 · low · Dead or unused API code
`routes/auth.ts:4` imports `hashPassword` (unused; tsc TS6133); `routes/auth.ts:14` defines `slugify` (unused; the real one is `services/tenants.ts:10`); `src/auth.ts:31` `hasRole` is never referenced; permission `'tenant.delete'` (`src/auth.ts:11`) has no route; `routes/people.ts:462-467` `signatureMatches` handles png/jpeg but the body only accepts `image/webp` (`:82`); `people.ts:86` wraps `Buffer.from(…, 'base64')` in a `try/catch` that cannot throw; `jobs.ts:89` double cast `as never … as unknown as typeof fetch`. **Fix:** delete; tsc `noUnusedLocals` (WP-Q6/Q11) keeps it deleted.

#### CQ-23 · low · Terminology drift and PII in paths
- `DOMAIN.md` says the product term is **Community**; code and user-facing strings still say "property": `people.ts:474` returns `'A property needs at least one admin'`; `src/auth.ts:22,26,29` comments; `http.ts:21`. The route is `PATCH /v1/tenant`. "Stay" (domain) vs `session` (code and API) is documented in `DOMAIN.md`, fine.
- `PATCH|DELETE /v1/invites/:email` puts an email address in the URL path, which access logs record (CR-28).
- **Fix:** replace "property" in error messages and comments with "community" in the next pass over each file; the email-in-path change belongs to CRUD WP-06.

#### CQ-24 · medium · Two i18n systems; English-only duration in every language
- **Evidence:** server notifications use `{name}` templates in `notify/messages.ts`; the web uses ICU via `intl-messageformat`. `passes.ts:347` `fmtDuration` returns `"2h 5min"` and is interpolated into the Spanish templates too (`:393`). Amount uses `/ 100` (`:395`).
- **Fix:** `fmtDuration(ms, locale)` using `Intl.DurationFormat` where available, else `Intl.RelativeTimeFormat` fallback; amount via `formatMoney` from core (CQ-26). Longer term: render server messages from the same ICU catalogs (a core `messages/` folder), which also removes the need to translate the same sentence in two places. Not for this phase.

#### CQ-25 · low · Hand-written transactions
`server.ts:55-69` issues `begin/commit/rollback` by hand inside `app.db.raw`. Add `Database.tx<T>(fn)` in `db.ts` (CRUD WP-00 / OS WP-D own that file) and use it here and in `Database.withTenant`.

#### CQ-26 · medium · Money arithmetic scattered
- **Evidence:** `/ 100` or `* 100` at `web/i18n.tsx:92`, `Rates.tsx:37,60`, `GuestPasses.tsx:52`, `api/services/passes.ts:395`; `Math.round(Number(e.target.value) * 100)` in four web inputs. `100` assumes a two-decimal currency; JPY has 0 and KWD has 3.
- **Why it matters:** the invariant "integer minor units everywhere" is right, but the conversion at the edges is not centralised, so a non-2-decimal currency would be wrong in all nine places.
- **Fix:** `packages/core/src/money.ts`:
  ```ts
  export function minorUnitDigits(currency: string): number;          // Intl.NumberFormat(…).resolvedOptions().maximumFractionDigits
  export function toMinor(major: string | number, currency: string): number;   // decimal-string parse, no float multiply; RangeError on NaN
  export function fromMinor(minor: number, currency: string): number;
  export function formatMoney(minor: number, currency: string, locale: string): string;
  ```
  Tests: `toMinor('19.99','MXN') === 1999`, `toMinor('1.005','MXN')` rounds half-up to `101` by string arithmetic (float `1.005*100` is `100.49999999999999`), `toMinor('5','JPY') === 5`, `toMinor('1.234','KWD') === 1234`. Adopt in `useFormat().money` and the four inputs (WP-Q7 provides `lib/money.ts` re-exports).

### 3.3 Web

#### CQ-27 · high · Files over 400 lines
| File | Lines | What is inside | Split into |
| --- | --- | --- | --- |
| `web/src/screens/Attendant.tsx` | 820 | Flow context; capacity bar; home; keypad; capture; review; confirm; host control; slot picker; checkout; bottom-sheet keypad; plate autocomplete; two homemade tab/collapsible widgets | `screens/attendant/{Flow.tsx, Home.tsx, CheckInCapture.tsx, CheckInReview.tsx, CheckInConfirm.tsx, CheckOut.tsx}` and `components/attendant/{Keypad,CapacityBar,HostControl,SlotPicker,PlateAutocomplete,BottomSheetKeypad}.tsx`; keep `Attendant.tsx` as a re-export barrel because `test/*` imports `useFlow` from it |
| `web/src/components/ui/sidebar.tsx` | 725 | vendored shadcn | leave (generated); UX track owns the dirty edit |
| `api/src/services/passes.ts` | 516 | see CQ-14 | six files under `services/passes/` + barrel |
| `api/src/routes/people.ts` | 475 | see CQ-14 | CRUD WP-05/06/11 |
| `web/src/screens/Resident.tsx` | 425 | `ResidentHome` (188 lines), `EditProfile`, `SharePass`, `resizeToWebP` (image maths), own `Collapsible` | `screens/my/*` (CR-08) and `lib/image.ts` for `resizeToWebP` |
| `web/src/screens/People.tsx` | 378 | `Units()` (166 lines, with its own import UI) and `People()` (150 lines) | `screens/units/*`, `screens/users/*` |
| tests: `api/test/passes.test.ts` 634, `api.test.ts` 481, `units-import.test.ts` 436 | | | split by feature when touched; not urgent |
Also over 250 lines: `routes/slots.ts` 305, `001_init.sql` 302, `Parking.tsx` 263 (`SiteCard` alone is 152).
- **Rule going forward:** a lint warning at 300 lines per file and 120 per function (§6), error at 500 / 200.
- **Cross-ref:** CRUD WP-01…12 own the split. The only items outside their lists are the services and `lib/image.ts` (WP-Q3 / WP-Q7).

#### CQ-28 · high · Three import/export UIs
- **Evidence:** `Inventory.tsx` (102 lines, whole file), `Bulk.tsx:55-141` (`ImportExport`), `People.tsx:36-95,140-197` (Units card). `/inventory` is still routed (`App.tsx:78`) although the menu no longer links to it. `Inventory.tsx:39,46` sends no `Idempotency-Key` on preview, apply or rollback; `Bulk.tsx:82,91` and `People.tsx:86,93` do. The Units card has no rollback. `Bulk.tsx:71` special-cases `spec.exportUrl.startsWith('/v1/inventory')`.
- **Fix:** one `<ImportJobPanel kind=…/>` and `components/DiffTable.tsx`; delete `Inventory.tsx`, the Units card, and the `/inventory` route. Owned by CRUD WP-10 (CR-13). **Acceptance:** `rg "inventory/import" apps/web/src` returns one file.

#### CQ-29 · high · Two styling systems
- **Evidence:** shadcn components (`Button`, `Card`, `Alert`, `Badge`, `Input`, `Table`) are used everywhere, and most carry the old class names on top: about 100 lines with `className="…btn…"`, 43 `card`, 60 `banner`, 91 `field`, 67 `stack`, 90 `row`, 74 `muted`, all backed by `styles.css` (242 lines) rules such as `.btn`, `.card`, `.banner`, `.pill`, `.field`. 15 inline `style={{…}}` remain (list: `SyncBadge.tsx:58`, `QrScanner.tsx:55`, `Bulk.tsx:127`, `Inventory.tsx:87`, `People.tsx:171`, `GuestPasses.tsx:55`, `Settings.tsx:38`, `Auth.tsx:86`, `Attendant.tsx:133,221,796`, `LiveCamera.tsx:76`, `Sessions.tsx:65`, `QrCode.tsx:13`).
- **Why it matters:** `className="btn primary"` on a shadcn `<Button>` fights the `variant` prop; two ways to do everything means every screen is restyled twice.
- **Fix (UX track decides the visual target; this is the mechanical plan):** (1) add the `Field`, `Row`/`Stack` layout helpers and an `Alert` wrapper that maps `banner warn|bad|info` to `variant`; (2) as each screen is rewritten, drop `btn|card|banner|pill|field` classes and use `variant`/`size` props; (3) when `rg -c '"[^"]*\bbtn\b' apps/web/src` returns 0, delete those rules from `styles.css`; (4) lint rule bans the legacy class names in new code. Do not edit `styles.css` or `Shell.tsx`/`AppMenu.tsx` before the UX track's sidebar change lands.

#### CQ-30 · high · The web app does not use `@openpark/core`
- **Evidence:** `apps/web/package.json` has no `@openpark/core` dependency. Consequences: `alpr/plates.ts` re-implements `normalizePlate` and `matchPlateClass` (CQ-05) and reads the registry through `import.meta.glob('../../../../registry/plates/*.json')` (`alpr/plates.ts:4`); `Rates.tsx:12` hand-copies `RateRules` as `interface Rules`; `PlateStabilizer` (`alpr/plates.ts:19-37`) is pure TypeScript that belongs in core next to Python's `vote()`.
- **Why it matters:** core is dependency-free (`zod` only) and already browser-safe; the duplication was avoidable. It also blocks CQ-18: forms cannot reuse the API's validators.
- **Fix:** `apps/web/package.json`: add `"@openpark/core": "workspace:*"`; `vite.config.ts` needs no alias (core builds to `dist/`, CI already builds it first). Move `PlateStabilizer` to `packages/core/src/plate-stabilizer.ts` with its tests; export a `loadRegistry`-free `matchesAnyRegion(regions: PlateRegion[], text: string): boolean`. `Rates.tsx` imports `type RateRules`. **Owner:** WP-Q1 adds the dependency and core modules; WP-Q7 switches `alpr/plates.ts`.

#### CQ-31 · medium · Error text is localised in some places and not others
- **Evidence:** `errors.ts:5-12` `errText` translates `err.<code>`. Twelve sites bypass it and show the server's English message: `Slots.tsx:32`, `Rates.tsx:42,46`, `hooks.ts:12` (so every `useApi` error), `People.tsx:87,94`, `Settings.tsx:31`, `Platform.tsx:44,51,53`, `GuestPasses.tsx:33,35`.
- **Why it matters:** an es-MX user sees English error text on those screens.
- **Fix:** `useApi` stores `errText(e)`; replace the other sites with `errText`. Lint rule (§6): `e instanceof ApiError ? e.message` is banned.

#### CQ-32 · medium · Non-null `me!`, context built from `null as never`, dead `can()` branches
- **Evidence:** `me!` appears 25 times (Attendant 13, Settings 4, People 4, Parking 3, Shell 1). `app-context.tsx:41` `createContext<AppCtx>(null as never)`; `Attendant.tsx:76` the same for the flow context; `Attendant.tsx:80` `useApp()?.me` (optional chaining on a non-null context). `app-context.tsx:124` `can(p)` has three cases but its `'admin'` and `'override'` arms are identical, so `can('admin')` is true for supervisors; only `can('override')` is used (`Attendant.tsx:772`). `canEdit = !!me && (me.superadmin || me.roles.includes('admin'))` is repeated in `People.tsx:44,247`, `Parking.tsx:35`, `Resident.tsx:167`, while `menu.ts:21` already has `isAdmin(roles, superadmin)` and `app-context.tsx:49` has `canEditPassPolicy`.
- **Fix:** `useMe(): Me` that throws if `me` is null (all routes using it are behind `TenantGate`); `useFlow()` throws if outside `<Flow>`; replace `can()` with named predicates (`useCan().override`, `.editSettings`, `.attend`) built on `menu.ts` functions; delete the unused branches. OS WP-A owns `app-context.tsx`, so ship the hook as `lib/use-me.ts` first (WP-Q7) and let WP-A re-export it.

#### CQ-33 · medium · Hand-copied API shapes
Local `interface` copies of API rows: `Occ` (`Dashboard.tsx:11`, `Attendant.tsx:97`, different fields), `Row` (`Sessions.tsx`, `Dashboard.tsx`, `Attendant.tsx:102`), `SlotRow` (`Parking.tsx:19`, `Attendant.tsx:476`), `Slot` (`Slots.tsx`, `Inventory.tsx`), `UnitRow` (`People.tsx:20`, `Attendant.tsx:414`), `Rules` (`Rates.tsx:12`), plus `Key`, `Hook`, `Policy`, `Tenant`, `Match`, `Opened`.
**Fix:** `apps/web/src/types.ts` (new) with one definition per API resource, replaced by generated types once OpenAPI has response schemas (CQ-15). Screens migrate as they are rewritten.

#### CQ-34 · medium · URLs by string concatenation
12 sites build queries with templates and without encoding: `Parking.tsx:115,157,162,233`, `Rates.tsx:24`, `Dashboard.tsx:24-25`, `Attendant.tsx:211,425,483,525,711`, `Sessions.tsx:25`, `Slots.tsx:26,31`, `Inventory.tsx:31`, `Bulk.tsx:23-28`. Site and zone codes are restricted today, but `unit` codes are free text (CR-19) and `plate` is user input.
**Fix:** `lib/url.ts`:
```ts
export function qs(params: Record<string, string | number | boolean | null | undefined>): string; // '' or '?a=1&b=2', skips null/undefined/'' , encodes
export function path(strings: TemplateStringsArray, ...values: (string | number)[]): string;       // path`/v1/slots/${code}` → encodeURIComponent on every value
```
and `api.get(path\`…\` + qs({ site, zone }))`.

#### CQ-35 · medium · Form and mutation boilerplate
`Object.fromEntries(new FormData(` 16 times; `setBusy(true)` 15 times; `try/await/setErr(errText)/finally` in at least 20 handlers; submit-key handling exists in `Units`, `Parking`, `Platform` and is missing in `Integrations`, `Slots`, `Rates`, `GuestPasses`.
**Fix:** `useWrite({ method, path, onSuccess })` as specified in CR-20 (it owns the idempotency key, busy flag, error mapping, `form.reset`, and navigation); `lib/forms.ts` `readForm<T extends Record<string,string>>(form: HTMLFormElement): T` for the 16 `FormData` sites.
**Owner:** CRUD WP-00.

#### CQ-36 · medium · Homemade widgets, unused shadcn components, native dialogs
- Homemade `Collapsible` at `Attendant.tsx:28` and `Resident.tsx:56`; homemade `Tabs` (toggle group) at `Attendant.tsx:48`, and the same idea inline in `Bulk.tsx:44-48` and `CheckOut`. `components/ui/collapsible.tsx` and `tabs.tsx` exist.
- Six vendored files have no importer: `ui/dialog.tsx`, `dropdown-menu.tsx`, `empty.tsx`, `label.tsx`, `spinner.tsx`, `tabs.tsx` (and `ui/sidebar.tsx` is imported only from `Shell.tsx` and `AppMenu.tsx`).
- Four native dialogs: `Parking.tsx:187`, `Bulk.tsx:138`, `Resident.tsx:246` use `confirm()`, and `Platform.tsx:49` uses `prompt()`.
- **Fix:** use `ui/collapsible` and `ui/tabs`; use `ui/dialog` for confirm and reason prompts (CR-12 adds `alert-dialog`); delete the vendored files nobody ends up using after the CRUD packages land (WP-Q11).

#### CQ-37 · medium · Dates bypass `useFormat` and the site timezone
`Queue.tsx:27` `new Date(w.at).toLocaleString()`; `Attendant.tsx:594` `toLocaleTimeString()`; `Attendant.tsx:660` and `Resident.tsx:37,176,231` compute durations from `Date.now()`; `Rates.tsx:18,28-29` (CQ-08). `useFormat(timezone, currency)` (`i18n.tsx:87-96`) exists for exactly this.
**Fix:** `lib/dates.ts`: `localToUtc(local: string, tz: string): string`, `utcToLocalInput(iso: string, tz: string): string`, `formatDuration(minutes: number, t): string`. Lint rule bans `toLocale*String` and `new Intl.DateTimeFormat` outside `i18n.tsx` and `lib/`.

#### CQ-38 · medium · `useApi` race and inline copy of `QueryState`
- `hooks.ts:6-16`: `reload` has no cancellation or request counter, so a slow response for an old path can overwrite a newer one; `deps` is spread into `useEffect` with `eslint-disable-line` (`:13,:14`). `Sessions.tsx:43-46` re-implements `QueryState` inline; `Slots.tsx` wires its own error banner.
- **Fix:** keep a `useRef` request id and ignore results from older ids (or pass an `AbortSignal` into `request`); type the hook as `useApi<T>(path: string | null, opts?: { deps?: unknown[] })`. Replace the inline copies with `<QueryState>`.
- **Owner:** OS WP-A (it owns `hooks.ts` and `QueryState.tsx`).

#### CQ-39 · low · Unused imports, locals, exports
tsc (`--noUnusedLocals --noUnusedParameters`) reports: API `routes/auth.ts:4` (`hashPassword`), `:14` (`slugify`); web `Attendant.tsx:25` (all `Table*` imports), `:111` and `:652` (`fmt`), `Auth.tsx:3` (`ApiError`), `Resident.tsx:126` (`guestPhone`), `:334` (`formatPhone`). Exported and never referenced: `hasRole`, `packages/core` `exportSlots` (its docstring promises range collapsing it does not do), `diffSites`, `loadLiveUnits`. **Fix:** delete; enable the flags (WP-Q6 as a warning, WP-Q11 as an error).

#### CQ-40 · low · Three import-path styles
`@/components/ui/x` (alias), `./ui/x.js` (relative with extension) and `../components/…` are mixed, sometimes in one file (`AppMenu.tsx`). **Fix:** lint rule `no-restricted-imports` for relative paths into `components/ui`.

#### CQ-41 · low · Magic numbers in the web app
`hooks.ts:46` `POLL_MS = 15_000` (named, good); `hooks.ts:77` reconnect `3000`; frame sizes `960` (`alpr/live.ts:23`) vs `1280` (`LiveCamera.tsx:61`) and loop intervals `200` (`LiveCamera.tsx:43`), `250` (`alpr/live.ts:33`), `300` (`alpr/live.ts:35`); QR debounce `4000` (`LiveCamera.tsx:47`); `Attendant.tsx:322` `0.85`; `slice(0, 200)` in three diff tables; `reader.ts` `SLOTS = 10`, `OCR_W = 128`. **Fix:** `lib/constants.ts` for non-model values; keep model dimensions beside the model loader with a comment naming the model file they come from.

#### CQ-42 · low · Marketing duplicates the locale tables
`apps/marketing/src/i18n.ts:1-5` redefines `LOCALES`, `NAMES`, `isRtl` that `apps/web/src/i18n.tsx:9,19,32` also define, and builds copy for all 7 locales while `DOMAIN.md` says only es-MX and en are surfaced. **Fix:** import `LOCALES`, `LOCALE_NAMES`, `isRtl` from core `locales.ts` (§5.2); decide whether the marketing site keeps 7 locales (product decision, not code).

#### CQ-43 · low · `LiveCamera` ignores changes to `regions`
`LiveCamera.tsx:56` disables the exhaustive-deps rule for `[qr, plate]`, but `startLiveReading` is created once with `regions` and builds `new PlateStabilizer(opts.regions)` (`alpr/live.ts:14`). A tenant that changes its plate regions keeps the old filter until the camera remounts. **Fix:** add `regions.join(',')` to the deps; tie to OS WP-E.

### 3.4 Core, SDKs, ALPR service

#### CQ-44 · medium · Dead or unwired code in core
- `exportSlots` (`inventory.ts:117-125`) is never referenced and its comment ("Collapse consecutive same-type … into ranges") is false.
- `correctConfusables` (`plate.ts:61`) is exercised only by tests. `ARCHITECTURE.md` says OCR post-correction reads the registry, but no server or web path calls it. `plateDistance` is used (checkout fuzzy match).
- **Fix:** delete `exportSlots`. For `correctConfusables`, decide: either call it in `checkIn` when `plateClass` is null and a confusable correction validates (record the original in `plate_read.corrected_to`, which already exists), or remove it and the architecture sentence. Recommended: wire it in `alpr/read` only, as a *candidate* the attendant confirms, never auto-applied.

#### CQ-45 · medium · Fee-engine test gaps
`packages/core/test/fees.test.ts` has 10 cases, all with `taxMode: 'included'` except one `added`. Missing: `taxMode: 'none'`; `dailyCap: null` with a stay over 24 h (the `days` branch is skipped); exactly 24 h and exactly 48 h (rem = 0); `lostTicket` with `added` tax; `graceMin >= firstPeriodMin`; increments larger than the remaining time; the `cap_adjustment` line sign; and invariants (monotonic non-decreasing in stay length; `total <= ceil(t/1440) * cap` when a cap is set; `lines.reduce(+) === base + tax` when `added`).
**Fix:** `packages/core/test/fees.property.test.ts` (new file; OS WP-C adds `time.property.test.ts`, a different file). Use a small table-driven loop with a seeded generator instead of adding a dependency. Also add a test for `stayMinutes` flooring seconds.

#### CQ-46 · medium · `sdk-ts` quality and boundary
- `index.ts:34` `type Json = Record<string, any>` is the only explicit `any` in shipped source; most methods return it.
- `index.ts:56` `JSON.parse(text)` is unguarded, so an HTML error page from a proxy throws a bare `SyntaxError` (the web `request` guards this at `api.ts:45`).
- It covers about 12 of 95 routes (CR-40); its empty-body POSTs send `content-type: application/json` with no body, which Fastify rejects (`api.ts:40` in the web client works around this).
- Licence: `packages/sdk-ts` is Apache-2.0; `packages/core` is AGPL-3.0. The SDK must not import core, so shared constants cannot come from there.
- **Fix:** generate types from `openapi.json` (once CQ-15 gives it response schemas) into the SDK, keeping the package self-contained; guard the parse; drop `any`. Owned by CRUD WP-13.

#### CQ-47 · low · SDK surface drift
`sdk-ts` has `quote`, `sessionEvents`, `rollbackInventory`; `packages/sdk-py/openpark/__init__.py` has none of those. Both are hand-written. Fix with the OpenAPI generation above, or add a parity test that compares method names (cheap interim guard).

#### CQ-48 · medium · Python ALPR service
- **Evidence:** `engines.py:55-65` `check_model_pin` is defined but never called, while the module docstring says "Models are pinned by SHA-256 when OPENPARK_MODEL_SHA256 is set"; `engines.py:68-92` `vote()` is only used in tests (README: "`vote()` exists … `/v1/alpr/read` takes one image"); `main.py:84` returns `c.__dict__` instead of a declared response model; `main.py:40,56` default model name `Qwen/Qwen3.5-4B` and `VLM_THRESHOLD=0.9` are inline; `main.py:30-32` swallows only `ImportError` (good) but `primary()` is `lru_cache`d, so a later install is not noticed until restart; `engines.py:42-45` `decode_image` has no size or pixel cap (`Image.open` warns above ~89 MP, then decodes), and `validate=False` accepts non-base64 junk.
- **Fix:** call `check_model_pin` from `OnnxEngine.__init__` for whichever model files `fast_alpr` resolves, or delete the claim; add a `ReadResponse` pydantic model and `response_model=ReadResponse` so FastAPI emits it in `/openapi.json`; `MAX_IMAGE_BYTES` (default 8 MB) and `Image.MAX_IMAGE_PIXELS = 40_000_000` enforced in `decode_image`; move env defaults into a `Settings` dataclass read once; tests for pin mismatch, oversized image, malformed base64.

### 3.5 Tests, tooling, repository

#### CQ-49 · medium · Three pooled connections per request; decorations typed by a double cast
- **Evidence:** a normal request checks a client out of the pool three times before the handler runs a statement. `server.ts:93-110` `identify` calls `app.db.raw` once for `app_user`; `server.ts:129` `authenticate` calls `app.db.raw` again for `user_memberships`; `http.ts:97` `defineRoute` then calls `withTenant`, a third checkout. The API-key path is the same shape: `resolve_api_key` (`server.ts:119`), a `withTenant` for the slug and suspension flag (`:122`), then the handler's `withTenant`. `DB_POOL_MAX` is 2 on Vercel (`config.ts:46`). `server.ts:75` builds the app with `Fastify(…) as unknown as App` and then `decorate`s each field, so the compiler cannot tell a missing decoration from a present one.
- **Why it matters:** with a pool of 2, two concurrent requests can occupy the whole pool during authentication alone, and latency doubles when each checkout waits.
- **Fix:** (1) one `app.db.raw` call that returns user row and memberships together (`select … from app_user u, lateral user_memberships(u.id)`), cached on the request as `req.identity`; (2) extend `resolve_api_key` to return `slug` and `suspended` so the API-key path needs no extra tenant transaction; (3) replace the cast with a `declare module 'fastify' { interface FastifyInstance { cfg: Config; db: Database; … } }` augmentation and `Fastify()` returning the augmented type. Target: at most one checkout before the handler's transaction.
- **Owner:** CRUD WP-00 and OS WP-D (they own `server.ts` and `http.ts`). Listed in §5.3.

#### CQ-50 · high · No lint, no formatter, no unused-code gate; tests not type-checked
- **Evidence:** no ESLint, Prettier, Biome, knip, or `.editorconfig` anywhere. Eleven `// eslint-disable-line react-hooks/exhaustive-deps` comments exist (`hooks.ts:13,14`, `QrScanner.tsx:50`, `Auth.tsx:149`, `LiveCamera.tsx:56`, `AppMenu.tsx:69`, `Rates.tsx:31`, `Resident.tsx:135,146`, `Attendant.tsx:715`) for a plugin that is not installed. `apps/web/tsconfig.json` and `apps/api/tsconfig.json` `include` only `src`, so `pnpm typecheck` never checks `test/`. Running tsc over `src` + `test` with the same options reports **5 errors in `apps/api`** (`test/passes.test.ts:385-392`, `test/serverless-cost.test.ts:49`) and **35 in `apps/web`** (for example `test/attendant-camera.test.tsx:41`, `test/crud-roles.test.tsx:35,90-92`: fixtures missing `Me.tenant` fields). `noUnusedLocals` and `noUnusedParameters` are off (CQ-39 shows what that hides).
- **Fix (WP-Q6):**
  1. `eslint.config.js` (flat config) with `typescript-eslint` recommended, `eslint-plugin-react-hooks`, and the `no-restricted-syntax` / `no-restricted-imports` rules in §6. **No formatter yet**: adopting Prettier would reformat most files and conflict with the other two tracks' rewrites.
  2. Per package `tsconfig.test.json` extending the package config with `include: ["src","test"]`, and a root script `pnpm typecheck:tests`. Fix the 40 errors (fixture builders, WP-Q5) before turning it on in CI.
  3. `knip.json` per workspace; run in CI as report-only until WP-Q11.
  4. `noUnusedLocals` / `noUnusedParameters` in `tsconfig.base.json` as part of WP-Q11 (after the other packages merge).

#### CQ-51 · medium · Untested pure and security-critical functions
No test references any of: `signUrl`/`verifySignedUrl` (`storage.ts:28-40`), `signToken`/`verifyToken` (`auth.ts:52-67`), `passToken`/`parsePassToken` (`passes.ts:71-89`; exercised only indirectly), `locateJsonError` (`jsonpos.ts`), `render` in `notify/messages.ts`, `assertPublicHost` and the DNS-guarded agent in `netguard.ts` (`isPrivateAddress` has tests), `Jobs.drainDeliveries` and backoff selection (`jobs.ts:52-78`), `EventHub` (`events.ts`), `loadPlateRegistry` (`registry.ts`).
**Fix (WP-Q5, new test files only):** `storage.test.ts` (tampered key, expired `exp`, wrong secret, equal-length mismatch), `auth-tokens.test.ts` (expired, tampered body, `alg` ignored, wrong secret), `pass-token.test.ts` (round-trip, `|` in guest name, tampered field, wrong prefix, expired), `jsonpos.test.ts` (line/column for 6 malformed inputs), `messages.test.ts` (every locale has every key; unknown locale falls back), `jobs-backoff.test.ts` (attempt n → delay; dead after the sixth).

#### CQ-52 · medium · Web test setup duplicated
`globalThis.IS_REACT_ACT_ENVIRONMENT = true` is pasted into 13 files; `vi.mock('../src/app-context…')` appears in 10 and `vi.mock('../src/api…')` in 8, each with its own hand-built `Me` object (the source of most of the 35 type errors in CQ-50). `MemoryRouter` wrappers are repeated in 9.
**Fix:** `apps/web/test/setup.ts` (sets the flag, `fake-indexeddb/auto`, `@testing-library/jest-dom`), `apps/web/test/builders.ts` (`buildMe(partial?)`, `buildSite(partial?)`, `renderWithApp(ui, { me, route })`), referenced from `vite.config.ts` `test.setupFiles`. Existing tests adopt them when CRUD WP-14 updates their URLs.

#### CQ-53 · medium · e2e scripts
15 files in `e2e/`, each launches Chromium and signs up its own tenant (`rg -l 'chromium.launch' e2e/*.mjs` = 15; `/signup` appears in 14). Only `smoke.mjs` is wired (`e2e/package.json`), and CI (`.github/workflows/ci.yml`) runs none. Selectors depend on CSS classes (`button.menu-head` in 4 scripts) that the sidebar rewrite changes. `smoke.mjs` defines its own `log` and `expand` helpers that no other script shares.
**Fix (WP-Q8, new files):** `e2e/lib/{browser,tenant,assert,run}.mjs` (`launch()`, `signupTenant()`, `step(name, fn)`, error-collecting `page.on('pageerror')`), `e2e/run.mjs` to run all `*.mjs` in series with a summary, selectors by role and name instead of class, and a CI job that boots API + web against the CI Postgres. Scripts adopt the lib when CRUD WP-14 / OS WP-E edit them.

#### CQ-54 · medium · CI gaps
`ci.yml` runs install, core build, typecheck, test, `check:css`, web build, marketing build, Python pytest, and three image builds. Missing: lint (none exists), test type-check, e2e, `ruff`/`mypy` for Python, `pnpm audit`, `helm lint` (README admits the chart is unlinted), and a check that `pnpm-lock.yaml` and generated files (`en-XA.json`) are in sync with sources.
**Fix (WP-Q6):** add jobs `lint`, `typecheck-tests`, `e2e` (after WP-Q8), `python-lint`, `audit` (non-blocking), `helm-lint`.

#### CQ-55 · medium · Tracked generated files and root clutter
- Tracked but generated or local: `.DS_Store`, `apps/marketing/.astro/*` (6 files), `packages/sdk-py/openpark.egg-info/*` and `services/alpr/openpark_alpr.egg-info/*` (10 files), `supabase/.temp/*` (2 files; `cli-latest` is already modified in the working tree and `linked-project.json` names the project). `.gitignore` lacks `.DS_Store`, `.astro`, `*.egg-info`, `.pytest_cache`, `supabase/.temp`.
- Agent and process material lives at the repo root next to product code: `antislop.md` (58 KB), `skills/`, `anti-slop/`, `.opencode/`, `tasks.md`, `scripts/dispatch.mjs`, `.agents/reviews/LOOP-SUMMARY.md` (138 KB), `.sidebar-reference/`.
- **Fix (WP-Q6):** `git rm -r --cached` the generated paths and add the ignore rules; move process material under `tools/agents/` (or a separate repo) and keep `AGENTS.md` at the root pointing to it; do not move anything under `.worktrees/` or `.agents/tasks/` while the orchestrator is running.

#### CQ-56 · low · Overlapping top-level docs
`AGENTS.md` says `CLAUDE.md` "duplicates some of this", and `README.md` carries a status table that overlaps `ARCHITECTURE.md`. **Fix:** make `CLAUDE.md` a one-line pointer to `AGENTS.md`; keep the status table in one place.

#### CQ-57 · medium · No test that every tenant table has RLS, a policy and a grant
Today every table is covered (verified by reading migrations: the `001` loop covers 17 tables, `003` four more, `005` `webhook_delivery`, `009` `stay_alert`, `017` and `002` the global tables). Nothing enforces it: `AGENTS.md` only says "New tables need RLS enabled plus a grant."
**Fix (WP-Q4, new test file `apps/api/test/rls-coverage.test.ts`, runs against the test DB after `migrate`):**
```sql
-- 1. every public table with a tenant_id column has relrowsecurity and at least one policy
select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relkind='r'
   and exists (select 1 from information_schema.columns k where k.table_schema='public' and k.table_name=c.relname and k.column_name='tenant_id')
   and (not c.relrowsecurity or not exists (select 1 from pg_policies p where p.tablename=c.relname));
-- 2. every public table has some grant to openpark_app (or is listed in an explicit allow-list: schema_migration)
-- 3. every security-definer function sets search_path and is not executable by PUBLIC
-- 4. session_event and audit_event grants are exactly select+insert; rate_plan is select+insert
```
Expected result of each query is zero rows; the test prints the offending table names.

#### CQ-58 · low · Stay times use a millisecond clock
`app.now()` returns a JS `Date`; every `in_at`/`out_at` is written from it (`sessions.ts:90,142,236,241`) while Postgres `timestamptz` stores microseconds. This is OS-04's finding; recorded here only so the code-quality acceptance list is complete: after OS WP-C/D, `rg "new Date\(\)|Date.now\(\)" apps/api/src` should list only non-stay uses.

---

## 4. Things verified as good (keep)

- **Tenant endpoints all use `defineRoute`.** The only hand-registered routes are `/v1/events` (SSE, calls `app.authenticate` itself), `/metrics` and `/healthz`. No raw `app.get/post` for tenant data.
- **RLS coverage today is complete** for every tenant-scoped table (CQ-57 lists where), `app_user`, `platform_idempotency_key` and `schema_migration`; `anon`/`authenticated` are revoked; append-only history is enforced by grants (`rate_plan`, `session_event`, `audit_event` are select+insert).
- **Money is integer minor units** in the schema (`fee int`), the fee engine, rate plans, policy (`overstayCharge`) and API. The only issue is the conversion at the edges (CQ-26).
- **`packages/core` is pure and dependency-light** (zod only), with tests for plates, inventory ranges, units diff and fees, and the JSON-Schema file is validated against the Zod docs (`schema.test.ts`, `units.test.ts`).
- **Security helpers use constant-time compare** (`timingSafeEqual` in tokens, signed URLs, pass tokens, webhook verification), webhook targets are guarded at connect time (`netguard.ts`), and the login path verifies against a dummy hash to avoid user enumeration.
- **i18n key parity test exists** (`apps/web/test/i18n.test.ts`) and `check:css` guards RTL.
- **Idempotency design is right in principle** (key, request hash, stored response, `Idempotent-Replayed` header); the problems are duplication and the race (CQ-13, OS-09).
- **API test harness is shared** (`apps/api/test/helpers.ts`: `harness`, `signup`, `addResident`, `waitFor`).

---

## 5. Work packages

### 5.1 Ownership map (no two packages edit the same file)

Legend: **N** = new file only · **E** = edits an existing file that no other plan lists.

| WP | Name | Size | Owns exclusively | Depends on | Findings |
| --- | --- | --- | --- | --- | --- |
| **WP-Q1** | Core contracts | M | N `packages/core/src/{roles,schemas,money,locales,countries,plate-stabilizer}.ts`; E `packages/core/src/inventory.ts` (import `SLOT_STATUSES` only); append lines to `packages/core/src/index.ts`; N tests `packages/core/test/{money,schemas,countries,plate-stabilizer}.test.ts`; E `apps/web/package.json` (add one dependency) and `pnpm-lock.yaml` | none; **merge first** | CQ-05, 06, 07, 18, 26, 30, 44 |
| **WP-Q2** | API shared helpers | S | N `apps/api/src/{sql,pgerrors,limits}.ts`, N `apps/api/src/services/lookups.ts`; E `apps/api/src/config.ts` (`envBool`) | WP-Q1 for `LIMITS` values only | CQ-15 (a), 16, 19, 20, 21 |
| **WP-Q3** | Passes and notification services | M | E/split `apps/api/src/services/passes.ts` → `services/passes/*` + barrel; E `apps/api/src/notify/*`; E `apps/api/src/storage.ts`; N `apps/api/src/routes/alpr.ts` and the deletion of that block from `routes/misc.ts` (one contiguous hunk, `misc.ts:11-16,42-95`) | WP-Q1 (money), WP-Q2 (`staffRecipients`) | CQ-03 (2–4), 14 (services), 17, 24 |
| **WP-Q4** | DB guards and retention | S | N migration `0NN_purge_history.sql` (next free number at merge time; OS and CRUD plans also reserve 019/020); E `apps/api/src/migrate.ts`; E `apps/api/src/jobs.ts`; E `apps/api/src/events.ts` (typing only); N `apps/api/migrations/README.md`; N `apps/api/test/rls-coverage.test.ts` | none | CQ-09, 10, 57 |
| **WP-Q5** | Test gap fill | S | N test files only: `apps/api/test/{storage,auth-tokens,pass-token,jsonpos,messages,jobs-backoff}.test.ts`, `packages/core/test/fees.property.test.ts` | WP-Q3 only if it renames token functions (it must not: barrel keeps exports) | CQ-45, 51 |
| **WP-Q6** | Guardrails, CI, hygiene | M | N `eslint.config.js`, `knip.json`, `tsconfig.test.json` per package, root `package.json` scripts; E `.github/workflows/ci.yml`; E `.gitignore` + `git rm --cached` list; E `apps/web/vite.config.ts` (`test.setupFiles` one line); N `apps/web/test/{setup,builders}.ts`; move process material (CQ-55); E `CLAUDE.md` | none (enable strict TS flags later in WP-Q11) | CQ-40, 50, 52, 54, 55, 56 |
| **WP-Q7** | Web support modules | M | N `apps/web/src/{types.ts}`, N `apps/web/src/lib/{url,money,forms,dates,use-me,image,constants}.ts`; E `apps/web/src/{errors,labels,pass,attendant-flow,i18n}.tsx`; E `apps/web/src/alpr/{plates,live}.ts`; E `apps/web/src/components/{PlateInput,PhoneInput,PasswordInput,Invitations,QrCode}.tsx` | WP-Q1 | CQ-05, 06, 26, 30, 31 (helper), 32 (helper), 33, 34, 37, 41 |
| **WP-Q8** | e2e infrastructure | S | N `e2e/lib/*.mjs`, N `e2e/run.mjs`, E `e2e/package.json`, N CI job (in WP-Q6's `ci.yml` edit, coordinate) | none | CQ-53 |
| **WP-Q9** | ALPR service (Python) | S | E `services/alpr/**` (`app/main.py`, `app/engines.py`, `tests/*`, `pyproject.toml`) | none | CQ-48 |
| **WP-Q10** | Marketing locale tables | XS | E `apps/marketing/src/i18n.ts` (import from core; add dependency in `apps/marketing/package.json`) | WP-Q1 | CQ-42 |
| **WP-Q11** | Closing sweep | M | Whatever the sweep touches after the other packages merge: delete dead exports and imports, turn on `noUnusedLocals` / `noUnusedParameters`, make knip a CI gate, remove unused vendored `ui/*`, re-run the duplicate counts in Appendix A and attach the numbers | all other packages and both sibling plans | CQ-22, 36 (deletion), 39, 50 (4) |

**File-level conflicts with the sibling plans (decide before starting):**

- `packages/core/src/index.ts`: WP-Q1 and OS WP-C both append export lines. Trivial merge; do WP-Q1 first.
- `apps/api/src/routes/misc.ts`: WP-Q3 removes the ALPR block; OS WP-D edits `routes/misc.ts` for clocks and `/v1/ping`. The ALPR block does not overlap their hunks. Announce the move.
- `apps/api/src/jobs.ts`: only WP-Q4 edits it. OS-WP D and CRUD plans do not list it.
- `apps/web/vite.config.ts`: OS WP-A rewrites it (service worker). WP-Q6's change is a single `test.setupFiles` line; apply it after WP-A merges, or ask WP-A to include it.
- `apps/web/package.json` and `pnpm-lock.yaml`: any package that adds a dependency will conflict textually. WP-Q1 adds `@openpark/core`; no other WP in this report adds one; rebase after it merges.
- `http.ts` and `db.ts`: the CRUD plan (WP-00) and the offline plan (WP-D) **both** claim them. That conflict is theirs to resolve; this report asks for six specific changes there (listed in §5.3) so that the owners can do them in the same edit.

**Order:** WP-Q1 first (about a day). WP-Q4, Q5, Q6, Q8, Q9 can start immediately in parallel. After WP-Q1 merges, WP-Q2, Q3, Q7, Q10 start in parallel. WP-Q11 runs last.

### 5.2 Contracts that WP-Q1 must publish (exact signatures)

All in `packages/core/src` (AGPL-3.0, browser-safe, imports only `zod`). Add to `index.ts`: `export * from './roles.js'; export * from './schemas.js'; export * from './money.js'; export * from './locales.js'; export * from './countries.js'; export * from './plate-stabilizer.js';`.

```ts
// roles.ts
export const ROLES = ['resident', 'attendant', 'supervisor', 'admin'] as const;
export type Role = (typeof ROLES)[number];
export const RoleSchema: z.ZodEnum<['resident','attendant','supervisor','admin']>;
export const RoleList: z.ZodEffects<…, Role[], …>;       // min 1, de-duplicated, sorted by ROLES order (today's people.ts:15)

// schemas.ts
export const PHONE_E164: RegExp;                          // /^\+[1-9]\d{7,14}$/
export const PhoneE164: z.ZodString;                      // message: 'use international format, e.g. +525512345678'
export const CODE_RE: RegExp;                             // /^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$/   (site, zone, unit)
export const SLOT_CODE_RE: RegExp;                        // /^[A-Za-z0-9][A-Za-z0-9_.-]{0,29}$/
export const Code: z.ZodString;  export const SlotCode: z.ZodString;
export function isValidTimezone(tz: string): boolean;
export const IanaTimezone: z.ZodEffects<z.ZodString>;
export const PAYMENT_METHODS: readonly ['cash','card','account'];
export const PaymentMethod: z.ZodEnum<…>;
export const PLATE_SOURCES: readonly ['manual','ai_assist','ai_auto'];
export const PlateSource: z.ZodEnum<…>;
export const WEBHOOK_EVENTS: readonly ['session.opened','session.closed','slot.changed','read.needs_review','pass.overstay'];
export const WebhookEvent: z.ZodEnum<…>;  export type WebhookEvent = z.infer<typeof WebhookEvent>;
export const SLOT_STATUSES: readonly ['available','occupied','reserved','out_of_service'];
export const SlotStatus: z.ZodEnum<…>;
export const PlateInput: z.ZodObject<{ display: z.ZodString /*1..20*/; region: z.ZodOptional<z.ZodString> }>;
export const VehicleAttrs: z.ZodObject<{ bodyType?; make?; model?; color?; year? }>;
export const ReadMeta: z.ZodObject<{ textRaw?; confidence? /*0..1*/; engine?; latencyMs? /*int*/; cropKey? }>;
export const AI_THRESHOLD_DEFAULT = 0.95;
export const AI_THRESHOLD_MIN = 0.5, AI_THRESHOLD_MAX = 1;
// NOTE: the offline envelope (clientAt, mutationId, deviceId, clientSeq) is defined by OS WP-C in core/src/sync.ts; routes use that, not a new Device shape.

// money.ts
export function minorUnitDigits(currency: string): number;
export function toMinor(major: string | number, currency: string): number;
export function fromMinor(minor: number, currency: string): number;
export function formatMoney(minor: number, currency: string, locale: string): string;

// locales.ts
export const LOCALES: readonly ['en','es-MX','es-ES','pt-BR','fr','de','ar'];
export type Locale = (typeof LOCALES)[number];
export const SURFACE_LOCALES: readonly ['es-MX','en'];
export const LOCALE_NAMES: Record<Locale, string>;
export function isRtl(locale: string): boolean;

// countries.ts   (moved from apps/api/src/services/demo.ts; demoInventory stays in the API)
export interface CountryDefaults { code: string; name: string; locale: Locale; currency: string; timezone: string;
  plateRegions: string[]; rules: RateRules; overstayCharge: number /* minor units; 500000 for MXN, else 0 */ }
export const COUNTRIES: Record<string, CountryDefaults>;
export const COUNTRY_CODES: readonly string[];
export function countryDefaults(code: string): CountryDefaults | undefined;     // no silent fallback

// plate-stabilizer.ts  (moved from apps/web/src/alpr/plates.ts; same behaviour, constructor takes matcher)
export class PlateStabilizer {
  constructor(opts: { match: (text: string) => boolean; need?: number; window?: number; minConfidence?: number });
  push(reads: { text: string; confidence: number }[]): { text: string; confidence: number; votes: number } | null;
  reset(): void;
}
export function matchesAnyRegion(regions: PlateRegion[], text: string, minLength?: number): boolean;
```

Acceptance: `pnpm --filter @openpark/core test` passes with the new tests listed in §3 (CQ-26 money cases, an Arabic and an `Ñ` plate through `normalizePlate`, `countryDefaults('CO') === undefined`, stabiliser behaviour copied from `apps/web/test/alpr.test.ts`).

### 5.3 Adoption checklists for packages owned by the other two plans

These are acceptance criteria to paste into the owning work package, not new work.

**CRUD WP-00 (owner of `http.ts`, `server.ts`)**
1. `defineIdentityRoute`; `params` and `query` on public and platform handlers (CQ-12). Done when `rg "req.params as" apps/api/src` is empty.
2. One idempotency module shared by tenant and platform routes; `secretFields`; rate-plan, api-key, webhook creates `replaySafe`; inventory apply/rollback `idempotent` (CQ-13).
3. `RouteDef.tx?: 'tenant' | 'none'` and `RouteDef.response?: ZodTypeAny` (CQ-03, CQ-15).
4. `Database.tx()` (CQ-25); then delete the hand-written transaction in `server.ts:55-69`.
5. `useWrite` hook and `readForm` (CQ-35).
6. Enforce route-file size: no route file over 300 lines.

**OS WP-F / WP-B (sync engine and indicator)**
1. One ref-counted sync engine; `navigator.locks` for flush; `classify()` as a tested pure function (CQ-01). Test: two mounted badges, one `online` event, `fetch` called once per queued write, zero conflicts.
2. Remove `QueuedWrite.token` (CQ-02).
3. Ask the UX track to remove the second `<SyncBadge />` mount.

**OS WP-C / WP-D (clock and envelope)**
1. Envelope defined once in core and used by both session and pass routes (CQ-02, CQ-18).
2. Payment reconciliation with fee and `payment_variance` event (CQ-04).
3. `rg "new Date\(\)|Date.now\(\)" apps/api/src` shows only non-stay uses (CQ-58).

**OS WP-A (hooks, app-context, QueryState)**
1. `useApi` ignores stale responses (CQ-38); stores `errText(e)` (CQ-31).
2. Re-export `useMe` from `lib/use-me.ts` and delete `can()` dead arms (CQ-32).

**CRUD WP-10 (imports)**
1. `parseJsonDoc` and `BulkKind` used by all five kinds (CQ-11). Done when `rg "invalid_json" apps/api/src` finds one file.
2. One `<ImportJobPanel>`; `Inventory.tsx`, the Units card and the `/inventory` route deleted (CQ-28).

**CRUD WP-01…12 (screens)**
1. Every rewritten screen: no `me!`, no `e.message` display, no `confirm()`/`prompt()`, no legacy `btn|card|banner|field` class names, URLs built with `qs`/`path`, money through `toMinor`/`formatMoney`, dates through `useFormat` or `lib/dates.ts`. The lint rules in §6 enforce this; a screen is not done while it has warnings from them.

**CRUD WP-13 (SDKs)**
1. Types generated from OpenAPI; guarded JSON parse; no `any`; TS and Python method parity test (CQ-46, CQ-47). The SDK must not import `@openpark/core`.

**CRUD WP-14 / OS WP-E (e2e)**
1. Use `e2e/lib` from WP-Q8 for every script they touch; select by role and accessible name.

---

## 6. Guardrails: lint rules that stop the regressions (WP-Q6)

ESLint flat config; start every rule at `warn`, switch to `error` per directory once its WP has landed. Selectors are `no-restricted-syntax` esquery strings.

| Rule | Selector / config | Prevents |
| --- | --- | --- |
| No native dialogs | `CallExpression[callee.name=/^(confirm\|prompt\|alert)$/]` | CQ-36 |
| No raw `ApiError.message` for display | `ConditionalExpression[test.type="BinaryExpression"][test.operator="instanceof"][test.right.name="ApiError"] > MemberExpression[property.name="message"]` | CQ-31 |
| No `me!` | `TSNonNullExpression > Identifier[name="me"]` | CQ-32 |
| No non-Latin-destroying plate regex | `Literal[regex.pattern=/\\[\\^A-Z0-9\\]/]` | CQ-05 |
| No ad-hoc money maths | `BinaryExpression[operator=/^[\*\/]$/][right.value=100]` | CQ-26 |
| No device-locale date formatting | `CallExpression[callee.property.name=/^toLocale(Date\|Time)?String$/]`; `NewExpression[callee.property.name=/^(DateTimeFormat\|NumberFormat)$/]` outside `i18n.tsx`, `lib/` | CQ-37 |
| No `req.params as` | `TSAsExpression > MemberExpression[property.name="params"]` in `apps/api` | CQ-12 |
| No hand-rolled PG error casts | `TSAsExpression[typeAnnotation.members.0.key.name=/^(code\|constraint)$/]` in `apps/api` | CQ-19 |
| No legacy class names | `JSXAttribute[name.name="className"] Literal[value=/\\b(btn\|banner\|pill\|tablewrap)\\b/]` | CQ-29 |
| Import path style | `no-restricted-imports` pattern `**/components/ui/*` and `./ui/*` (use `@/components/ui/*`) | CQ-40 |
| Size | `max-lines` 300 (warn) / 500 (error); `max-lines-per-function` 120 (warn) / 200 (error), skipping `components/ui/**` | CQ-27 |
| Hooks | `react-hooks/exhaustive-deps` as `warn`; remove the 11 `eslint-disable` comments or justify each | CQ-50 |

---

## Appendix A: scan data (reproduce with the commands shown)

Duplicate counts (`rg -c` over `apps/web/src`, excluding `components/ui`): `Object.fromEntries(new FormData` 16 · `setBusy(true)` 15 · `variant="destructive" className="banner bad"` 23 · `useApi<` 30 · `errText(` 24 · `role="alert"` 26 · `me!` 25 · legacy classes on lines: `btn` ≈100, `card` 43, `banner` 60, `field` 91, `stack` 67, `row` 90, `muted` 74, `pill` 15, `tablewrap` 15 · inline `style={{` 15 sites.
API: `.rows[0]` 160 across 19 files · `ctx.siteId` checks 22 · PG error casts 7 · bulk-import parse functions 5 · bulk-import route blocks 5.
Tests: `IS_REACT_ACT_ENVIRONMENT` 13 files · `vi.mock('../src/app-context` 10 · `vi.mock('../src/api` 8 · `MemoryRouter` 9. Counts of `it(`/`test(`: api 135, web 121, core 36, sdk-ts 6; alpr and sdk-py not counted.
tsc with unused flags: 2 (API) + 6 (web) + 0 (core, sdk-ts). tsc including `test/`: 5 (API) + 35 (web). Source:
`npx --no-install tsc --noEmit --noUnusedLocals --noUnusedParameters -p tsconfig.json` in each package, and the same with a temporary tsconfig whose `include` adds `test`.
Never-referenced exports (script scan): `hasRole`, `exportSlots`, `correctConfusables` (tests only), `verifyWebhook` (tests only, public API of the SDK, fine).
Tracked generated or local files: `git ls-files | rg "(\.DS_Store|\.astro/|egg-info|supabase/\.temp)"` = 19 paths.
Vendored shadcn files with no importer: `dialog`, `dropdown-menu`, `empty`, `label`, `spinner`, `tabs`.

## Appendix B: not verified

- No tests were run. Findings that describe runtime behaviour (CQ-01 race outcome, CQ-03 pool starvation, CQ-13 race) come from reading the code paths; each has an acceptance test described so the owner can reproduce before fixing.
- The `Resident.tsx`, `Auth.tsx`, `Parking.tsx` (after line 70) and `People.tsx` (after line 140) bodies were skimmed by grep and structure, not read line by line.
- Marketing (`Landing.astro`, `Base.astro`) and the Helm chart were not reviewed.
- `components/ui/*` are vendored shadcn files; only their usage was checked.
- The working tree is dirty with the UX track's sidebar change; line numbers for `Shell.tsx`, `AppMenu.tsx`, `styles.css` are from that dirty state.
