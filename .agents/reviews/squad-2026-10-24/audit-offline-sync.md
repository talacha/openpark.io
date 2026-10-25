# Audit: offline-first, on-device ALPR, sync and conflict handling

Track `audit-offline-sync` · 2026-10-24 · read-only (no source edits; this file is the only write).
Scope: `apps/web` (PWA, SW, queue, ALPR), `apps/api` (idempotency, sessions, migrations), `packages/core` (fees), `deploy/`.

How findings were established: every item cites file:line read in this session. Nothing was executed (no app run, no browser, no Postgres). Items whose truth depends on deployment config I could not see are marked **[unverified at runtime]**.

---

## 0. Answers to the five questions

### (a) What works offline today

| Area | Offline today? | Evidence |
| --- | --- | --- |
| Cold start of the PWA (reopen app with no signal) | **No.** The shell HTML is cached, but boot calls `/v1/auth/memberships` + `/v1/me`; a network `TypeError` is swallowed, `who` stays `null`, and `AppShell` redirects to `/login`. | `app-context.tsx:79-101`, `Shell.tsx:47` (OS-01) |
| App already open, then signal drops | Partly. Loaded screens stay; navigation to a route whose lazy chunk was never fetched fails (see OS-07). Routes are not lazy-split by `React.lazy`, only `manualChunks`, so most code is in the entry chunks. | `App.tsx:1-21`, `vite.config.ts:10-18` |
| Any GET (dashboard, sessions, slots, units, users, rates, suggestion, occupancy, open-session list) | **No.** SW skips `/v1/*`; `useApi` has no cache, it shows an error. | `sw.js:15`, `hooks.ts:6-16` (OS-06) |
| Admin writes (sites, zones, slots, units, users, rate plans, settings, bulk import) | **No.** All use online-only `post/patch/del`. | `api.ts:55-60`, `Parking.tsx:52,146,157`, `People.tsx:62` (OS-11) |
| Attendant check-in (manual or camera) | **Queues only.** `write('/v1/sessions')` stores the request when `fetch` throws `TypeError`. No ticket, no slot, no local occupancy. Slot suggestion (`/v1/slots/suggest`) is unavailable offline. | `Attendant.tsx:542`, `api.ts:68-78` (OS-12) |
| Guest-pass redemption | **No, by design.** Always online `post`. | `Attendant.tsx:537-540` |
| Attendant check-out | **Queues blind.** Offline there is no match, no fee preview; `queueOffline` sends `payment.amount: 0` and the server prices at replay time. | `Attendant.tsx:739-743`, `sessions.ts:236-243` (OS-02, critical) |
| Payment, void, fee override, slot status | **No.** Online only. | `sessions.ts` routes |
| Plate read (camera) | **Yes, after the models were loaded once online** (OS-19). | `alpr/loader.ts`, `sw.js:17-36` |
| QR scan (ticket and pass) | Yes; `jsqr` is bundled, `BarcodeDetector` is native. But the lookup that follows needs the network. | `QrScanner.tsx`, `qr.ts` |
| Plate-format validation | Yes; registry JSON is bundled via `import.meta.glob`. | `alpr/plates.ts:4-5` |

Is the shell and every route precached? **No.** `sw.js:6` precaches only `/`, `/icon.svg`, `/manifest.webmanifest`. Hashed `/assets/*.js|css` are cached lazily at first online fetch (network-first, `sw.js:38-45`). There is no build-time manifest, so a freshly installed PWA that never visited a screen cannot render it offline. All client routes resolve to `/` (SPA), so route *URLs* are fine; route *code and data* are the gap.

API GET caching strategy: **none.** There is no stale-while-revalidate, no IndexedDB read model, no last-known-good store.

### (b) Plate reads offline

- Read path is fully on-device and makes **no network call**: `reader.read()` runs `letterbox → detector.run → cropResizeRgb → ocr.run → decodePlate` over `onnxruntime-web/wasm` (`alpr/reader.ts:41-57`, `alpr/loader.ts:41-47`). Stabilizer and registry are local (`alpr/plates.ts`).
- **Assets are not precached by the SW.** Models (`public/models/*.onnx`, 7.8 MB + 5.3 MB) are excluded from the SW (`sw.js:16`) and cached by the app itself in Cache Storage `openpark-models-v1`, SHA-256 verified against `/models/manifest.json` (`loader.ts:3-24`). The ORT wasm (14.2 MB) and loader `.mjs` are cache-first in `openpark-reader-v2` (`sw.js:17-36`). **All of this is populated lazily the first time the camera component mounts online** (`LiveCamera.tsx:38`). A device that was never online with the camera open cannot read plates offline (OS-19).
- Failure behaviour: when load fails, `status='unavailable'`, the UI says "reader off" and the `Capture` button falls to `onSnap` → server `/v1/alpr/read` (`LiveCamera.tsx:38-40,65-70`; `Attendant.tsx:328-340`), which errors offline with `att.offline` and closes the camera. Manual keypad entry remains.
- VLM fallback: **never runs in the browser.** It is server-side only (`services/alpr`, `apps/api/src/routes/misc.ts:43-90`). Offline there is no second-opinion read, no make/model/colour suggestion (`vehicle: {}` at `Attendant.tsx:317`). Architecture doc itself lists this as Phase 2.
- 3-5 frame voting: implemented client-side by `PlateStabilizer` (need 2 of last 5). Good.
- Cache eviction risk: neither Cache Storage nor IndexedDB is protected with `navigator.storage.persist()`; iOS Safari can evict after ~7 days without use (OS-19).

### (c) Indicator and connectivity detection

- `SyncBadge` (`components/SyncBadge.tsx`) is mounted once in the topbar (`Shell.tsx:35`).
- **It renders `null` when online, nothing pending, no conflicts, no note** (`SyncBadge.tsx:52`). There is no persistent online state, and no "syncing" state at all (no in-flight flag).
- Detection: `navigator.onLine` + `online`/`offline` events + a 30 s timer that runs only `if (navigator.onLine)` (`SyncBadge.tsx:28,47-48`). The "heartbeat" is `request('GET','/healthz')` (`:37`) but it only runs after `onLine` is already true, and **on the Vercel web app and in `vite dev` `/healthz` is not proxied** (`apps/web/vercel.json` rewrites only `/v1/*` and `/openapi.json`; `vite.config.ts:19` proxies only `/v1`, `/openapi.json`). The SPA fallback answers `200 text/html`, `request()` turns that into an `ApiError` (`api.ts:37-41`), `sync()` swallows it as non-network (`SyncBadge.tsx:41`), and **`flush` never runs** (OS-05, **[unverified at runtime]** because `VITE_API_URL` is unset in the repo; nginx does proxy `/healthz`, `deploy/nginx.conf:19`).
- Live-update channel: SSE (`useLiveEvents`, `hooks.ts:53-84`) or 15 s poll; its `live` boolean is returned but not surfaced anywhere as connectivity.

### (d) Sync design as built

| Concern | Today |
| --- | --- |
| Queue | IndexedDB `openpark-offline` v1, stores `queue` and `conflicts`, autoIncrement key (`offline.ts:6-14`). One record = `{method,path,body,key,tenant,token:'',at,user}` |
| Ordering | FIFO by autoIncrement id; stops at first network error (`offline.ts:62`) or `>=500`/`401` (`:64`) |
| Retries | Fixed 30 s timer + `online` event. No backoff, no jitter, no max attempts, no attempt counter, no age limit |
| Idempotency key | `crypto.randomUUID()` per `write()` call (`api.ts:69`), stored with the request, replayed in the `idempotency-key` header (`SyncBadge.tsx:18`). Server stores `(tenant_id,key)->response`, body-hash checked (`http.ts:97-122`) |
| Replay safety | Good for sequential retry after lost response. **Unsafe under concurrency** (OS-08, OS-09) |
| Conflict classification | Every non-2xx other than `>=500`/`401` becomes a "conflict" and leaves the queue (`offline.ts:65-72`). `CONFLICT_CODES` is used only to silence a `console.warn` (`:48,69`) |
| Optimistic concurrency | **None.** No `version`, no `updated_at`, no `If-Match`/ETag anywhere in `apps/api` (grep: zero hits for `updated_at`/`version` outside `rate_plan.version`) |
| Ordering authority | Server arrival order only. Client `at` is stored in IDB but never transmitted (`SyncBadge.tsx:15-19` omits it; no caller sets `deviceAt`; grep `deviceAt` in `apps/web/src` = 0) |
| Clock skew | `device_clock_gap` warning if `|deviceAt-now| > 300 s` (`sessions.ts:34,91`); dead in practice because no client sends `deviceAt`. No supervisor approval step (doc promises one, `ARCHITECTURE.md` fees section) |
| Conflict surfacing | `Queue.tsx`: list of rejected writes with code + server message, buttons `Retry` and `Done` (= delete). No server state, no diff, no resolution actions. Route is visible to all non-residents (`App.tsx:87-89`, `menu.ts:26`) |

Scenario matrix (what happens now):

| Scenario | Result today |
| --- | --- |
| Two devices check out the same session offline | First replay wins. Second: `checkOut` finds session closed → `getOpenById` throws `409 not_open` (`sessions.ts:186-192`) for `confirmedSession`, or `404 no_open_session` for plate/ticket. Lands in `conflicts` with a code string. **Second attendant already collected cash**; nothing links that payment to the winning session |
| Slot already occupied at replay | `409 slot_unavailable` or `assigned_slot_taken` (`sessions.ts:126-134`) → conflicts list. No auto-reassign; the physical car is in the lot and has **no session** until a human re-submits |
| Same plate checked in on two devices | Second gets `409 already_inside` (`sessions.ts:104-109`) → conflicts. Reasonable, but `in_at` of the *winner* is server replay time, not physical arrival, so the fee is wrong (OS-03) |
| Rate plan changed while offline | Check-in replay pins `site.default_rate_plan_id` at replay time (`sessions.ts:142`), not the plan in force when the car arrived. Check-out uses the pinned plan of the open session, ok |
| Edits to the same entity (slot note/status/type, unit, site, tenant settings) | Last write wins, silently (`slots.ts:220-250`, `auth.ts:92-110`, `passes.ts:79-90`, `rates.ts:28-33`). Not offline-capable anyway, but two online admins already collide |
| Replay of a request whose response was lost | Safe when sequential (stored response replayed with `Idempotent-Replayed: true`) |
| Two flushes at once (two tabs, timer + `online` event) | Second request sees `request_in_progress 409` or a spurious domain 409 and is **moved to conflicts although the first succeeded** (OS-08, OS-09) |

---

## 1. Findings

Severity: **C**ritical (money/data wrong, or feature does not work at all), **H**igh, **M**edium, **L**ow.

### OS-01 · C · Offline cold start redirects signed-in users to /login
Evidence: `app-context.tsx:79-101` (`reload()`: only `ApiError` 400/401/403 handled; a `TypeError` falls through to `setLoaded(true)` with `me=null, who=null`); `Shell.tsx:47` (`if (!who) return <Navigate to="/login" />`); `App.tsx:36-42` (`TenantGate` → `homeFor(null, who)` = `/login`).
Fix:
1. New file `apps/web/src/snapshot.ts` exposing
   ```ts
   export interface Snapshot { v: 1; userId: string; tenant: string; savedAt: string; who: Who; me: Me; sites: SiteInfo[] }
   export async function saveSnapshot(s: Snapshot): Promise<void>;           // IDB store 'kv' key 'snapshot'
   export async function loadSnapshot(userId?: string): Promise<Snapshot | null>;
   export async function clearSnapshot(): Promise<void>;                     // called by signOut()
   ```
2. In `AppProvider.reload()` (`app-context.tsx`) after a successful load call `saveSnapshot`. In the `catch`, if `isNetworkError(e)` (import from `api.ts`) then hydrate `who/me/sites` from `loadSnapshot()` and set a context flag `stale: true`; never `clear()` on network errors. Keep the existing 401 path (`setSession(null)` + `clearSnapshot()`).
3. Add `offlineReady: boolean` to `AppCtx`. Expose to screens so they can disable online-only actions with a tooltip instead of failing.
4. Also persist the Supabase session (already `persistSession: true`, `auth.ts:7`); verify offline `supabase.auth.getSession()` does not throw on refresh failure (wrap in try/catch in `accessToken()`, `api.ts:22-25`, fall back to the stored `access_token` even if expired, since the API request will fail anyway and the queue needs *a* token string only at replay).
Test: vitest with `fake-indexeddb`, mock `fetch` to throw `TypeError`, render `<AppProvider>` and assert `me` hydrated and no redirect.

### OS-02 · C · Offline check-out charges the wrong amount and records payment as 0
Evidence: `Attendant.tsx:739-743` (`queueOffline` posts `payment: { amount: 0 }`); `sessions.ts:236-237` (`now = app.now(); quote(..., now)`: fee computed at *replay* time); `sessions.ts:241` (`out_at = $2` = replay time); `sessions.ts:251,267` (payment event stores the client-provided `amount`). Example: car leaves at 14:00 offline, phone syncs at 18:00 → guest is priced for 4 extra hours (or hits the daily cap), cash taken at the gate was the attendant's guess, ledger says $0. Violates the doc rule "fee comes only from the session's two server timestamps" and shift-report integrity.
Fix (depends on OS-03, OS-04 design in §2):
1. Client sends `clientAt` (µs ISO string) in every queued mutation. Server uses `out_at = clamp(clientAt)` for offline replays (rules in §2.4), not `app.now()`.
2. `CheckOutBody` (`routes/sessions.ts:35-40`) gains `observedFee: z.number().int().min(0).optional()` and `offline: z.boolean().optional()`. Handler computes the authoritative fee at `out_at`; if `payment.amount !== fee` and `offline`, record the payment with the *tendered* amount and add event `payment_variance { expected, tendered }`, flagged for the supervisor queue. Never silently take 0.
3. UI: offline check-out screen asks the attendant for the amount tendered and shows "fee will be confirmed on sync". Optionally cache the rate plan (OS-06) and compute a **provisional** fee on-device with `@openpark/core` `computeFee` (pure TS, already shared) from a locally cached open-session snapshot.

### OS-03 · C · Client capture time is never sent; `device_at`/clock-gap logic is dead
Evidence: `api.ts:75` stores `at: new Date().toISOString()` (ms); `SyncBadge.tsx:15-19` `send()` posts only `body` and the key, not `at`; `grep deviceAt apps/web/src` = 0; server accepts `deviceAt` (`routes/sessions.ts:9`) but check-in/out use `app.now()` for `in_at`/`out_at` (`sessions.ts:90,140-142,236,241`).
Effect: an offline check-in made at 08:12 and synced at 09:40 has `in_at = 09:40`; the guest is undercharged and the audit trail lies.
Fix: see §2 (envelope + server rules). Concretely:
- `apps/web/src/clock.ts` (new): `export function nowMicros(): string` (OS-04) and `export function newMutationId(): string` (UUIDv7).
- `api.ts write()` must put `clientAt: nowMicros()`, `mutationId`, `deviceId`, `clientSeq` in the request body envelope (§2.2) and in the queue record.
- `SyncBadge.send()` must send the stored envelope unchanged (never regenerate).
- `CheckInBody`/`CheckOutBody` (`routes/sessions.ts:18-40`): replace `deviceAt` with `clientAt: MicroTs`, keep `deviceAt` as a deprecated alias for one release.

### OS-04 · H · Microsecond precision is lost everywhere and fabricated as `.000`
Evidence:
- Postgres columns are `timestamptz` (µs): `001_init.sql` `session.in_at`/`out_at` (l.168-169), `session_event.server_at`/`device_at` (l.189-190).
- Writes: `app.now()` returns `new Date()` (`server.ts:73,84`), a ms-precision JS `Date`, bound as a pg parameter (`sessions.ts:140-142,241`), so rows get `...123000`. `addEvent` does `coalesce($8, now())` (`sessions.ts:47`) with `$8` almost always set, so DB `now()` (transaction start, µs) is almost never used.
- Reads: `pg` has no `setTypeParser` override (`grep setTypeParser apps/api/src` = none), so timestamptz → `Date`, µs truncated on every read-back/JSON response.
- Client: `new Date().toISOString()` (`api.ts:75`), `Date.now()` for QR dedupe, no `performance.timeOrigin`.
- `computeFee`/`stayMinutes` use `getTime()` (ms) (`packages/core/src/fees.ts:35-39`); fine for minute billing, but ordering of two events inside one ms is undecidable with `Date`.
- Zod `z.string().datetime({offset:true})` accepts arbitrary fractional digits in zod 3.24, so µs strings can already be sent (verify with the test below), but `new Date(str)` in handlers truncates (`sessions.ts:91`).
Fix:
1. `apps/api/src/db.ts`: register parsers so timestamptz stays a string with 6 fractional digits:
   ```ts
   import pg from 'pg';
   pg.types.setTypeParser(1184 /* timestamptz */, (s) => s);   // keep wire text, e.g. '2026-10-24 10:41:22.076123+00'
   ```
   and add `export const isoMicros = (pgText: string): string` that normalises to `YYYY-MM-DDTHH:mm:ss.ffffffZ`. Touch the few readers that expect `Date` (`sessions.ts:107,209,220,228,254` use `.toISOString()`/`getTime()`); change `OpenSession.in_at: Date` to `string` and give `computeFee` an overload accepting `Date | { micros: bigint }` (see core change below).
2. `packages/core/src/time.ts` (new, pure): 
   ```ts
   export type MicroTs = string;                         // 'YYYY-MM-DDTHH:mm:ss.ffffffZ', always UTC, always 6 digits
   export function parseMicros(ts: MicroTs): bigint;     // microseconds since epoch
   export function formatMicros(us: bigint): MicroTs;
   export function compareMicros(a: MicroTs, b: MicroTs): -1 | 0 | 1;
   export function stayMinutesMicros(inAt: MicroTs, outAt: MicroTs): number;  // floor((out-in)/60_000_000n), RangeError if negative
   ```
   `computeFee` takes `Date | MicroTs` for in/out; internal use `stayMinutesMicros`.
3. Server clock: replace `app.now()` for persisted times with SQL `clock_timestamp()` inside the transaction (`insert ... values (..., clock_timestamp())` or `select clock_timestamp()` once per request and pass the text back). Keep `app.now` only for tests via an injectable `nowSql` string (tests currently inject a fake `now`; keep a test hook `SELECT $1::timestamptz` when `cfg.TEST_CLOCK` set).
4. Client: `apps/web/src/clock.ts`:
   ```ts
   const originUs = BigInt(Math.round(performance.timeOrigin * 1000));
   export function nowMicros(): MicroTs {
     const us = originUs + BigInt(Math.round(performance.now() * 1000));
     return formatMicros(us);
   }
   ```
   Caveat to document in code: browsers coarsen `performance.now()` (typically 5 µs to 100 µs; 1 ms in some privacy modes), and `performance.timeOrigin + now()` is a *monotonic* clock anchored to wall time at page load; it drifts from wall time if the OS clock is adjusted. So the value is *monotonic and unique per device*, not "true" µs wall time. Therefore ordering authority must not depend on it alone (see §2.3). Re-anchor on `visibilitychange` and every 60 s: if `|Date.now() - (timeOrigin+now())| > 250 ms`, recompute `originUs` and log a `clock_resync`.
5. Tests: see §4.

### OS-05 · H · Heartbeat route is not served on the web host; sync may never start **[unverified at runtime]**
Evidence: `SyncBadge.tsx:37` `request('GET','/healthz')`; `apps/web/vercel.json` rewrites (`/v1/:path*`, `/openapi.json`, `/(.*)`→`/index.html`); `vite.config.ts:19-20` proxies only `/v1` and `/openapi.json`; `api.ts:37-41` converts a 200 HTML body into `ApiError`; `SyncBadge.tsx:41` ignores non-network errors. `deploy/nginx.conf:19` does proxy `/healthz`, so Docker works.
Fix: add `GET /v1/ping` (public, `cache-control: no-store`, `204`, no DB) in `apps/api/src/server.ts` next to `/healthz`; register it before the 404 handler. The client uses `/v1/ping` only (already covered by every proxy rule). Remove `/healthz` use from the web. Implement through the new connectivity module in OS-15, with `fetch(..., { cache: 'no-store', signal: AbortSignal.timeout(4000) })`.

### OS-06 · H · No read cache: every list/detail screen is dead offline
Evidence: `sw.js:15` (`url.pathname.startsWith('/v1/')` bypass), `hooks.ts:6-16` (`useApi` = fetch on mount, error string on failure).
Fix (stale-while-revalidate in the app, not in the SW, so auth headers and tenancy stay explicit):
1. New `apps/web/src/readcache.ts`: IDB store `reads` keyed `tenant|userId|GET path+query` with `{ body, etag, fetchedAt }`.
   ```ts
   export async function cachedGet<T>(path: string, opts?: { maxAgeMs?: number }): Promise<{ data: T; stale: boolean; fetchedAt: string }>;
   ```
   Behaviour: try network (timeout 4 s) → store → return fresh; on network error return stored with `stale: true`; on none throw.
2. `useApi` (`hooks.ts`) returns `{data, error, loading, reload, stale, fetchedAt}`; `QueryState` shows a muted "Last updated hh:mm" chip when stale (one shared component, avoids per-screen code, supports the DRY goal).
3. Prefetch set for attendant/supervisor devices on login and every 5 min while online: `/v1/me`, `/v1/sites`, `/v1/slots?site=…` (full), `/v1/rate-plans?site=…`, `/v1/sessions?status=open&limit=500`, `/v1/occupancy`, units list. This is the **open-session mirror** that offline check-out needs (OS-02, OS-12).
4. Purge on sign-out and when `userId` or `tenant` changes. RLS is server-side, so the cache is keyed by user to avoid cross-user leakage on shared devices.
5. Add `ETag`/`If-None-Match` (weak ETag = `W/"<max(version)>-<count>"`) on list endpoints later; not required for v1.

### OS-07 · M · Service worker: no real precache, poisoned-cache and wrong-fallback hazards
Evidence: `sw.js`.
- `:6` precache is `['/', '/icon.svg', '/manifest.webmanifest']`; hashed assets only cached after first successful fetch (`:38-43`).
- `:44` offline fallback is `caches.match('/')` for *every* failed GET, including a failed `/assets/x.js` or `/ort/*.wasm`: the browser receives HTML for a script/module → `SyntaxError`, white screen. Restrict to `e.request.mode === 'navigate'`.
- `:39-41` caches any `res.ok`, with no content-type check on this branch. Vercel rewrites unknown paths (e.g. a stale hashed chunk after deploy) to `index.html` with 200 (`apps/web/vercel.json`) → `text/html` stored under a `.js` URL (the reader branch has the guard, `:30-31`, the generic branch does not).
- `skipWaiting()` + `clients.claim()` (`:7,13`) swaps the SW under a running page; with fixed cache name `openpark-shell-v1` (`:3`) old and new chunks can mix.
- `register('/sw.js')` runs only in PROD, on `load` (`main.tsx:27-29`); no update prompt.
Fix: replace the hand-written SW with `vite-plugin-pwa` (Workbox `injectManifest`) in `apps/web/vite.config.ts`:
```ts
VitePWA({
  strategies: 'injectManifest', srcDir: 'src', filename: 'sw.ts',
  injectManifest: { globPatterns: ['**/*.{js,css,html,svg,woff2,webmanifest}'], globIgnores: ['models/**', 'ort/**'], maximumFileSizeToCacheInBytes: 4_000_000 },
  registerType: 'prompt',
})
```
`apps/web/src/sw.ts`: `precacheAndRoute(self.__WB_MANIFEST)`; `NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/v1\//, /^\/openapi\.json/] })`; keep the `/models/*` and `/ort/*` rules as separate Workbox `CacheFirst` routes with `CacheableResponsePlugin({statuses:[200]})` + a content-type guard plugin; add `cleanupOutdatedCaches()`. Show a "New version available" toast (shadcn `sonner`/Alert) and call `updateSW(true)` only when the queue is empty and no check-in flow is mid-way. Add `public/_headers` equivalent in `vercel.json` for `/sw.js` `cache-control: no-cache`.

### OS-08 · H · Concurrent flush double-sends and misfiles successes as conflicts
Evidence: `offline.ts:57-77` `flush` has no lock; it is called from the `online` event, the 30 s timer and mount (`SyncBadge.tsx:44-48`), and `SyncBadge` is mounted once per open tab. Two concurrent passes both read `listQueue()`, both send item N with the same key; the loser gets `409 request_in_progress` (`http.ts:124-126`) or a domain 409, which `flush` treats as a terminal conflict (`offline.ts:65-72`) and deletes the queue row (`:75`).
Also: every 4xx except 401 is terminal, including `408`, `425`, `429`, `403` expired-permission, and `409 request_in_progress`. All of these must retry.
Fix in `apps/web/src/offline.ts`:
```ts
export async function flush(send: Sender, as?: string, signal?: AbortSignal): Promise<FlushResult>
```
1. Wrap the whole pass in `navigator.locks.request('openpark-flush', { ifAvailable: true }, async (lock) => { if (!lock) return { synced:0, conflicts:0, skipped:true }; ... })` (fallback to an in-memory mutex when `navigator.locks` is missing).
2. Classify results in a pure function `classify(r: SendResult): 'done' | 'retry' | 'conflict' | 'auth'` placed in `offline.ts` and unit-tested: `2xx→done`; `401→auth(stop)`; `408|425|429|5xx|409 request_in_progress→retry (stop, backoff)`; `409` with code in `CONFLICT_CODES`, `404 no_open_session|session_not_found`, `422 idempotency_key_reuse`, `400/422 validation`, `403→conflict`; unknown 4xx→conflict.
3. Add per-item `attempts`, `nextAttemptAt`, `lastError` to the queue record (schema v2, OS-13).
4. Re-read the row inside the same readwrite transaction before delete so a concurrent deletion is idempotent.

### OS-09 · H · Server idempotency is racy for concurrent identical requests
Evidence: `http.ts:97-128`. The key row is inserted *after* `handler` runs (`:118-121`); the pre-check is a plain `select` (`:101`). Two concurrent requests with the same key both execute the handler; the loser either blocks on the slot row lock then fails with `slot_unavailable`/`already_inside` (a *different* error than the original success) or reaches the insert and gets `23505` → `request_in_progress` after doing real work. The platform-route variant already reserves first (`http.ts:181-206`), the tenant variant does not.
Fix: in `defineRoute`, replace the select-then-run with a reservation inside the same transaction:
```ts
const ins = await db.query(
  `insert into idempotency_key (tenant_id, key, request_hash, status) values ($1,$2,$3,0)
   on conflict (tenant_id, key) do nothing returning 1`, [ctx.tenantId, idemKey, hash]);
if (!ins.rowCount) {  // someone else owns it
  const prior = (await db.query('select request_hash, status, response from idempotency_key where tenant_id=$1 and key=$2 for share', [ctx.tenantId, idemKey])).rows[0];
  // 'for share' blocks until the owner's tx commits/rolls back; then re-read
  if (!prior) /* owner rolled back */ return retryOnce();
  if (prior.request_hash !== hash) throw 422 idempotency_key_reuse;
  return { replayed: true, status: prior.status, body: prior.response };
}
... handler ...
await db.query('update idempotency_key set status=$3, response=$4 where tenant_id=$1 and key=$2', ...);
```
Because the insert is uncommitted until the handler commits, the second request waits on the unique index (`insert ... on conflict do nothing` blocks on an in-flight conflicting tx), then sees the committed row and replays. Migration `019_idempotency_status.sql`:
```sql
alter table idempotency_key alter column status drop not null;   -- optional; keep not null with 0 sentinel instead
alter table idempotency_key add column if not exists mutation_id uuid, add column if not exists client_at timestamptz(6);
create index if not exists idempotency_key_created on idempotency_key (created_at);
```
Also store 4xx *business* responses for mutation replay? Not needed: failed handlers roll back, so a retry re-evaluates against current state, which is the right semantics for the conflict queue.
Also: `idempotency_key` TTL is 7 days (`misc.ts:134`); the offline queue has no max age. Either bound the queue age at 6 days (reject older locally into a visible "expired" state) or raise `purge_idempotency_keys` to 30 days.

### OS-10 · H · Optimistic concurrency does not exist
Evidence: no `version`/`updated_at` columns on `site, zone, slot, unit, app_user, membership, tenant, session`; `PATCH /v1/slots/:code` uses `select ... for update` then `coalesce` merge (`slots.ts:221-248`); `PATCH /v1/tenant` and `/v1/pass-policy` do read-modify-write on `settings` jsonb (`auth.ts:92-110`, `passes.ts:79-90`); `POST /v1/rate-plans` computes `max(version)+1` without a lock (`rates.ts:28-33`) so two concurrent creates race on `unique (tenant_id, site_id, name, version)` and the loser sees a 500.
Fix: see §2.5 (migration + helper). Summary: add `version bigint not null default 1` and `updated_at timestamptz(6) not null default clock_timestamp()` to mutable tables with a trigger bumping both; `PATCH`/`DELETE` require `If-Match: "<version>"` (428 if absent after a deprecation window), return `412` (or `409 version_conflict`) with `{ current }`; responses carry `ETag`. For rate plans take `pg_advisory_xact_lock(hashtext(site_id::text || name))` before computing the next version.

### OS-11 · H · Only two mutations can be queued
Evidence: `write()` is called at `Attendant.tsx:542` (check-in), `:734`, `:741` (check-out). All else is `post/patch/del` (`api.ts:55-60`).
Fix: v1 offline scope = check-in, check-out, payment, slot out-of-service/available, plate correction. Everything else (admin CRUD, bulk import, users, rates, integrations) stays online-only but must say so in the UI (disabled button + tooltip "Needs a connection") instead of failing after submit. Implement through a typed mutation registry (§2.6) so `write()` stops being stringly typed (`write(path, body, method)`).

### OS-12 · M · Offline check-in gives the attendant nothing to hand over
Evidence: `Attendant.tsx:553` shows only "Saved offline"; ticket code is generated server-side at insert (`auth.ts:76-78`, `sessions.ts:140-143`); slot suggestion needs the network (`Attendant.tsx:520-ish useApi('/v1/slots/suggest')`).
Fix: (1) client-generated session id: `POST /v1/sessions` accepts optional `id` (UUIDv7) used as `session.id`, giving a stable local handle and making the insert itself idempotent on `(tenant_id,id)`. (2) Provisional ticket: client prints/shows QR containing the session id + a locally generated 8-char code with a per-device prefix `D<deviceShort>-<base32 counter>`; server accepts `ticketCode` only if it matches `^D[A-Z0-9]{2}-[A-Z0-9]{5}$` and is unique, else assigns its own and returns `ticketRemap`. (3) Local slot suggestion over the cached slot list and a local occupancy overlay (queued check-ins mark the slot "pending-occupied"). (4) Show the queue in the attendant home as "Pending (n)".

### OS-13 · M · Queue has no dependency, backoff, expiry, or durability controls
Evidence: `offline.ts:6-14,57-77`; `SyncBadge.tsx:48`.
Fix (schema v2 via `onupgradeneeded` when `e.oldVersion < 2`): record gains `mutationId, type, entity, entityId, baseVersion, clientAt, clientSeq, deviceId, attempts, nextAttemptAt, lastError, dependsOn?: string[]`. Backoff `min(5 min, 2^attempts * 1 s) * (0.5+random())`. Ordering: by `(clientSeq)` per device; items with `dependsOn` wait until the dependency is `done`; if a dependency lands in `conflicts` the dependents move to `blocked` (not sent) and show under the same conflict card. Request persistent storage once after sign-in: `navigator.storage.persist()`; surface `navigator.storage.estimate()` in the Queue screen. Catch `QuotaExceededError` in `enqueue` and show a blocking error (currently the exception bubbles from `write()` as an unknown error).

### OS-14 · M · Clock-gap handling is a warning only, and a negative stay would 500
Evidence: `sessions.ts:34,90-91`; `packages/core/src/fees.ts:35-39` throws `RangeError` when `out < in`; `checkOut` does not catch it (only `rates.ts:47-51` does), so an `in_at` produced by a skewed/late-replayed check-in later than a correct `out_at` gives HTTP 500.
Fix: in `checkOut`, if `out_at < in_at` clamp `out_at = in_at` and add warning `negative_stay_clamped` plus event; never 500. Implement gap policy in §2.4 (hard cap, supervisor approval flag stored on the event, `needs_review` boolean on `session`).

### OS-15 · M · "Online" is invisible and "syncing" does not exist
Evidence: `SyncBadge.tsx:52` returns `null` when healthy; no in-flight state; detection relies on `navigator.onLine` (`:28,47-48`), which is true behind captive portals, dead Wi-Fi and a down API.
Fix: new `apps/web/src/connectivity.ts` + `ConnectivityProvider` + `<StatusPill />` (replaces `SyncBadge`):
```ts
export type Link = 'online' | 'offline' | 'degraded';
export type SyncState = 'idle' | 'syncing' | 'attention';
export interface Connectivity { link: Link; sync: SyncState; pending: number; conflicts: number; lastOkAt: string | null; lastSyncAt: string | null }
export function startConnectivity(opts: { ping: () => Promise<void>; flush: () => Promise<FlushResult>; now?: () => number }): { subscribe(fn): () => void; probeNow(): Promise<void>; stop(): void };
```
Rules: ping `GET /v1/ping` (OS-05) with `cache:'no-store'`, 4 s timeout; interval 10 s while online, 2 s → 4 s → 8 s → 15 s backoff while offline; hysteresis: 2 consecutive failures → offline, 1 success → online; any `fetch` that throws `TypeError` inside `request()` calls `connectivity.reportFailure()` immediately; `online`/`offline`/`visibilitychange` events only trigger `probeNow()`, never set state directly. Share across tabs with `BroadcastChannel('openpark-link')` and let only the Web Lock holder ping. `sync` becomes `syncing` while a flush holds the lock, and `attention` when conflicts > 0. On a transition to `online`, run `flush()`, then `reloadAll()` (invalidate read cache, refetch visible `useApi`).
UI (shadcn): `Badge` in the topbar, always rendered: green dot "Online", amber "Offline · n saved", blue spinner "Syncing n", red "n need review". Add `aria-live="polite"` text for transitions, i18n keys `link.online|offline|syncing|attention` to **all** locale files (parity check, `AGENTS.md`). Use logical CSS only. Also show a full-width thin banner on the attendant layout when offline.

### OS-16 · M · SSE gives no catch-up after a gap
Evidence: `hooks.ts:72-79` (`onopen` only sets `live`; no refetch on reconnect; 3 s fixed retry, no backoff); `misc.ts:149-166` (events carry no `id:`, no `Last-Event-ID` handling; `emit` is fire-and-forget NOTIFY); token in query string (`api.ts:79-82`) ends up in access logs.
Fix: on every `es.onopen` after the first and on every `connectivity → online`, call `cb.current()` immediately. Server: add `id: <tenant_seq>` to each SSE frame (OS-10 `tenant_seq`), accept `Last-Event-ID`, and replay from `tenant_event` (small table, 10 min TTL) or answer `event: resync` so the client refetches. Move the token to a short-lived one-time `ticket` (`POST /v1/events/ticket` → 60 s JWT) to keep bearer tokens out of URLs.

### OS-17 · M · Conflict UI is a list of error codes with a "Done" button that deletes data
Evidence: `Queue.tsx:17-40`; `offline.ts:34-45` (`dismissConflict` deletes with no audit; `retryConflict` re-queues the *same* body and key).
Fix: §2.7. Minimum fix now: replace `Done` with `Discard…` requiring a reason and writing an `audit_event` (`offline.discard`) via `POST /v1/offline/discards` before local delete; show `clientAt`, entity, plate, the server's `current` state and the available resolutions.

### OS-18 · M · Rate plan pinned at replay time, not at arrival
Evidence: `sessions.ts:78,142` (`site.default_rate_plan_id` read at replay). A plan change between arrival and sync prices the guest on the new plan.
Fix: `CheckInBody.ratePlanId?: string` (client sends the id/version it displayed from the cached plan); server accepts it if the plan exists, belongs to the site, and `active_from <= clientAt`; otherwise picks the plan that was default at `clientAt` using `rate_plan.active_from` (`order by active_from desc limit 1 where active_from <= $clientAt`) and records `rate_plan_resolved_by: 'client'|'time'|'current'` in the event payload.

### OS-19 · M · Offline plate reading depends on an accidental first online camera open
Evidence: `loader.ts:23-44` loads on `LiveCamera` mount (`LiveCamera.tsx:38`); `sw.js:16` leaves models to the app; `scripts/fetch-models.mjs` writes `public/models` and `public/ort` (git-ignored, `.gitignore:12`), build fails loudly if GitHub is unreachable (`fetch-models.mjs:21-22`, good).
Fix:
1. `apps/web/src/alpr/prefetch.ts`: `export async function prefetchPlateModels(onProgress?: (p: number) => void): Promise<'ready'|'failed'>` that does everything `loadPlateModels` does for *fetching* (manifest, both models into `openpark-models-v1`, `ort-*.mjs` and `.wasm` via `fetch` so the SW stores them) without creating ORT sessions. Call it after sign-in for roles attendant/supervisor/admin when `ai_mode !== 'off'`, on Wi-Fi if `navigator.connection?.saveData` is false, in `requestIdleCallback`.
2. Request `navigator.storage.persist()` at the same time; expose `readerState: 'missing'|'downloading'|'ready'|'failed'` in connectivity context and show it in the Attendant home ("Plate reader ready offline" / "Download for offline use (27 MB)") plus a manual retry button.
3. Move the model cache name into the version of `manifest.json` (`cache = 'openpark-models-' + manifest.version`) and evict older caches in `activate`.
4. Offline UX in `LiveCamera.tsx:65-70`: if no reader, do **not** call `onSnap` when `!navigator.onLine`/link offline; show "Reader not downloaded, enter plate manually" and keep camera for QR.
5. Send `read.engine: 'onnx-web'` and `latencyMs` with the check-in (fields exist server-side `routes/sessions.ts:28-31`; the client sends only `textRaw`/`confidence`, `Attendant.tsx:530`).
6. Keep the crop: store the 128×64 OCR crop JPEG in IDB with the queued check-in and upload on sync via `POST /v1/sessions/:id/crop` so `plate_read.crop_key` is populated for training and audit (architecture promises crop storage).
7. Test: `apps/web/test/plate-model-cache.test.ts` already covers cache-hit offline. Add `prefetch.test.ts` and a Playwright offline smoke (`e2e/offline.mjs`) using `context.setOffline(true)` after a warm-up.

### OS-20 · M · Event ordering has no commit-order cursor
Evidence: `session_event.id bigserial` (`001_init.sql:182`); sequences allocate at insert time, not commit time, so a reader polling `id > last` can skip an event committed late. `server_at` defaults to `now()` = transaction start (`001_init.sql:189`) and is overridden with ms Date.
Fix: §2.5 `tenant_seq` table and `server_seq` column, allocated in-transaction.

### OS-21 · L · Queue ownership gaps on sign-out and cross-user devices
Evidence: `offline.ts:30,57-60`, `app-context.tsx:121`. Writes queued by user A stay forever if A never signs in again on that device; no UI shows them to B (silent). `token:''` is stored (`api.ts:75`), fine, but `user` may be `''` if enqueue happens before `me` loads (`setQueueOwner('')`), and `''` rows are replayed by anyone (`offline.ts:60` only skips when `w.user` truthy).
Fix: on sign-out, if queue has rows for the user, block sign-out with a confirm dialog ("n unsynced actions will stay on this device"). Treat `user===''` as invalid at enqueue (throw). Show other users' pending counts (not content) in the Queue screen.

### OS-22 · L · Test coverage gaps
`apps/web/test/offline.test.ts` covers FIFO, 5xx, 401, ownership, retry. Missing: concurrency/locking, classify(), backoff, schema migration, SW behaviour, cold-start offline, microsecond ordering, two-device races at the API, e2e offline. No `fast-check` dependency present. See §4.

---

## 2. Target design

### 2.1 Principles

1. The server is the only authority for **order** and **money**. The device is authoritative only for **what it observed and when** (capture time), and that claim is bounded by server checks.
2. Every mutation is an immutable command with its own identity, replayable any number of times with the same result.
3. Conflicts are detected by comparing a **base version** the client saw with the current server version; the server never merges silently except by the explicit rules in §2.4.
4. Time is carried as ISO-8601 UTC strings with exactly 6 fractional digits (`MicroTs`) and never round-tripped through `Date` on either side.

### 2.2 Mutation envelope (request body, all queueable endpoints)

```ts
// packages/core/src/sync.ts (shared by web, api, sdk-ts)
export const MicroTs = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
export const Envelope = z.object({
  mutationId: z.string().uuid(),          // UUIDv7, == Idempotency-Key header, also unique in DB
  deviceId: z.string().uuid(),            // generated once per install, stored in IDB (kv 'deviceId'); registered via device table
  clientSeq: z.number().int().min(1),     // per-device monotonically increasing counter persisted in IDB (survives reload)
  clientAt: MicroTs,                      // capture time, performance.timeOrigin + performance.now(), see OS-04
  clockOffsetMs: z.number().optional(),   // last measured (serverNow - clientNow) in ms from /v1/ping Date/`x-server-time` header, informational
  baseVersion: z.number().int().optional(), // entity row version the client saw (for updates)
  offline: z.boolean().default(false),    // true when it sat in the queue (>1 flush attempt or captured while link=offline)
});
```
Header `Idempotency-Key: <mutationId>` stays (existing contract). `x-server-time` response header on `/v1/ping` (`clock_timestamp()` µs) gives clients a skew estimate: `offset = serverAt - (t0+t1)/2` using the ping round trip.

### 2.3 Ordering: three keys, never one
Per session timeline order is `(server_seq)` ascending. Display/analysis may also use `effective_at`. Concretely `session_event` gains:
- `server_seq bigint` — allocated from `tenant_seq` in the same transaction as the write (gapless within a tenant, commit-ordered because the counter row is locked until commit). Source of truth for "what happened after what" and for sync cursors/SSE ids.
- `received_at timestamptz(6) default clock_timestamp()` — Postgres clock at execution time.
- `client_at timestamptz(6)`, `device_id`, `client_seq` — what the device claimed.
- `effective_at timestamptz(6)` — the instant used for billing/occupancy, derived by §2.4 (equals `client_at` when accepted, else `received_at`).
Total order for equal `effective_at`: `(effective_at, device_id, client_seq, server_seq)`. This is a deterministic tiebreak independent of arrival order, used only for display and fee maths; `server_seq` stays the replication cursor. An HLC is unnecessary here because the server sequence is the authority; if peer-to-peer sync is ever added, upgrade `clientAt` to an HLC `(wall µs, counter, deviceId)`.

### 2.4 Server acceptance rules for `clientAt` (single function)
`apps/api/src/services/clock.ts`:
```ts
export interface ClockVerdict { effectiveAt: MicroTs; source: 'client' | 'server'; skewMs: number; flags: ('clock_gap' | 'future' | 'stale' | 'negative_clamped')[]; needsApproval: boolean }
export function resolveEffectiveAt(args: { clientAt?: MicroTs; receivedAt: MicroTs; offline: boolean; lastKnownForSession?: MicroTs; maxPastHours: number; maxFutureSec: number; gapApprovalSec: number }): ClockVerdict;
```
Rules (config per site, defaults in brackets):
1. No `clientAt` → `server`, effectiveAt = receivedAt (legacy clients).
2. Online request (`offline=false`): trust server clock; record `skewMs`; flag `clock_gap` if `|skew| > 300 s` (existing behaviour made real).
3. Offline replay: accept `clientAt` if `receivedAt - maxPastHours(48 h) <= clientAt <= receivedAt + maxFutureSec(5 s)`.
   - Future by more than 5 s → clamp to `receivedAt`, flag `future`.
   - Older than 48 h → `source='server'`, flag `stale`, `needsApproval=true`.
   - If a measured `clockOffsetMs` is present and `|offset| > gapApprovalSec (300 s)`, apply `clientAt + offset` as the effective time, flag `clock_gap`, `needsApproval=true`.
4. For a check-out, `effectiveAt` must be `>= session.in_at`; otherwise clamp to `in_at` and flag `negative_clamped` (fixes OS-14). For a check-in, effectiveAt must be `>= the previous event for that vehicle`.
5. `needsApproval=true` sets `session.needs_review = true` and emits `read.needs_review`-style event `session.needs_review`; the supervisor approves or overrides in the conflict UI. The fee is computed at `effectiveAt` immediately (so the guest is not blocked) and is marked `fee_provisional`.

### 2.5 Database migrations (`apps/api/migrations/019_sync_concurrency.sql`, new)

```sql
-- 1. per-tenant gapless, commit-ordered sequence
create table tenant_seq (
  tenant_id uuid primary key references tenant(id) on delete cascade,
  seq bigint not null default 0
);
alter table tenant_seq enable row level security;
create policy tenant_isolation on tenant_seq using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);
grant select, insert, update on tenant_seq to openpark_app;

create function next_tenant_seq() returns bigint language plpgsql as $$
declare v bigint;
begin
  insert into tenant_seq (tenant_id, seq) values (current_setting('app.tenant_id')::uuid, 1)
  on conflict (tenant_id) do update set seq = tenant_seq.seq + 1 returning seq into v;
  return v;
end $$;
grant execute on function next_tenant_seq() to openpark_app;

-- 2. session_event: capture, receive, effective time and ordering keys (append-only table stays insert-only)
alter table session_event
  add column server_seq   bigint,
  add column received_at  timestamptz(6) not null default clock_timestamp(),
  add column client_at    timestamptz(6),
  add column effective_at timestamptz(6),
  add column client_seq   bigint,
  add column mutation_id  uuid;
alter table session_event alter column server_at type timestamptz(6);
alter table session_event alter column device_at type timestamptz(6);
update session_event set effective_at = server_at, client_at = device_at where effective_at is null;
create unique index session_event_mutation on session_event (tenant_id, mutation_id, type) where mutation_id is not null;
create index session_event_seq on session_event (tenant_id, server_seq);

-- 3. session: microsecond columns, version, review flags
alter table session
  alter column in_at type timestamptz(6),
  alter column out_at type timestamptz(6),
  add column version bigint not null default 1,
  add column updated_at timestamptz(6) not null default clock_timestamp(),
  add column in_received_at timestamptz(6),
  add column out_received_at timestamptz(6),
  add column needs_review boolean not null default false,
  add column fee_provisional boolean not null default false;

-- 4. version + updated_at on every mutable aggregate
do $$ declare t text; begin
  foreach t in array array['site','zone','slot','unit','tenant','membership'] loop
    execute format('alter table %I add column if not exists version bigint not null default 1, add column if not exists updated_at timestamptz(6) not null default clock_timestamp()', t);
  end loop;
end $$;

create function bump_version() returns trigger language plpgsql as $$
begin
  if row(new.*) is distinct from row(old.*) then
    new.version := old.version + 1; new.updated_at := clock_timestamp();
  end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['site','zone','slot','unit','tenant','membership','session'] loop
    execute format('create trigger %I before update on %I for each row execute function bump_version()', t || '_bump', t);
  end loop;
end $$;

-- 5. idempotency: remember who/when, keep longer than the maximum queue age
alter table idempotency_key add column if not exists mutation_id uuid, add column if not exists client_at timestamptz(6);
```
(`timestamptz` already stores µs; `(6)` makes it explicit and documents intent. The `unit` table name is from `docs/DOMAIN.md`; confirm column/table names against migrations 003/013 before applying. The `bump_version` trigger compares `row(new.*)` with `row(old.*)` so no-op updates do not bump the version; the trigger must be defined before the first versioned write; `session` triggers assume the app role keeps its current update grants.)

API helpers (`apps/api/src/services/concurrency.ts`, new):
```ts
export function ifMatch(req: FastifyRequest): number | null;                      // parses If-Match: "7" or W/"7"
export async function updateIfVersion(db: Db, table: 'site'|'zone'|'slot'|'unit'|'tenant', id: string, expected: number | null, set: string, args: unknown[]): Promise<{ version: number; row: Record<string, unknown> }>;
//   update ... set ... where id=$1 and version=$2 returning *; zero rows => throw HttpError(412, 'version_conflict', ..., { current: <fresh row>, expected })
```
`defineRoute` gets `ifMatch: 'required' | 'optional'` and adds `ETag: "<version>"` to GET-by-id and mutation responses. Rate plans: `select pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))` before computing the next version.

### 2.6 Merge rules per entity (deterministic; implemented in `apps/api/src/services/merge.ts`)

| Entity / command | Rule | Conflict result |
| --- | --- | --- |
| `session.check_in` (same plate, other open session) | If the open session was created by the **same `mutationId`** → replay. Else `already_inside`. If the existing one has `effective_at` later than the incoming and **same site**, keep the earlier as truth: mark the later one `void` with reason `duplicate_offline_checkin`, supervisor sees both. | 409 `already_inside` + `{ current: {session} }` → conflict card with "Keep existing / Replace with mine (earlier time)" |
| `session.check_in` slot taken | If `reason=explicit` and the slot is held by a session whose `effective_at` is later than ours, ours wins the slot and the later one is re-suggested a free slot (event `slot_moved`). If held by an earlier session → auto-assign `suggestSlot` and record `slot_reassigned {requested, assigned}` instead of failing (the car is physically in the lot). Only `site_full` is a hard conflict. | auto-resolved with event; hard conflict only when no slot |
| `session.check_out` already closed | If the existing close has the same `mutationId` → replay. Different mutation on a closed session: first `effective_at` wins; second is stored as event `duplicate_checkout { payment? }`, its payment stays recorded as `payment` with `orphan=true` for reconciliation | 409 `not_open` + `{ current }` (informational card, payment reconciliation action) |
| `session.check_out` unknown/ambiguous plate | Never auto-pick. Queue stores the **session id** when known from the cache (OS-06); plate-only offline check-outs resolve at replay only on exact match among sessions open at `effective_at` | 404 `no_open_session` + candidates |
| `payment.record` | Append-only, always accepted for a closed session (money cannot be dropped); variance vs fee becomes `payment_variance` | none |
| `slot.status` (available / out_of_service / reserved) | Last-writer-wins by `effective_at` **only if** `baseVersion` matches; else `412` + `current`. Never changes an `occupied` slot (existing rule `slot_occupied`) | 412 `version_conflict` |
| `slot/site/zone/unit/user/tenant` edits (online only) | `If-Match` required; on mismatch `412` with `current`; UI offers field-level three-way merge: base (from the form's load), mine, theirs | 412 |
| `rate_plan.create` | Never conflicts (new version); advisory lock serialises version numbers | none |
| `plate_read.correction` | Append-only, newest `effective_at` wins for `corrected_to` | none |
| `void`, `fee_override` | Supervisor-only, require `baseVersion` of the session; stale → 412 | 412 |

### 2.7 Conflict review UI
Route `/t/:slug/conflicts` (rename of `/queue`; keep a redirect) and one reusable `ConflictCard`:
```
<ConflictCard conflict={c} />   // shadcn Card + Badge(reason) + Collapsible(details) + ButtonGroup(actions)
type Conflict = { id; mutationId; type; clientAt; effectiveAt?; serverCode; message; mine: unknown; current?: unknown; actions: ConflictAction[] }
type ConflictAction = 'keep_server' | 'apply_mine_as_new' | 'reassign_slot' | 'close_stale_and_retry' | 'record_orphan_payment' | 'discard'
```
Layout: left "What you did offline (time, who, plate, slot)", right "What the server has now"; actions as buttons; destructive actions open a shadcn `AlertDialog` with a required reason. Resolution calls `POST /v1/offline/resolutions { mutationId, action, reason }`, which is itself idempotent and writes an `audit_event`. Roles: attendants see only their own conflicts and may only choose non-destructive actions; supervisors see the tenant-wide list (new `GET /v1/offline/conflicts`, fed by the server, not only by local IDB, so a lost phone does not lose the conflict). Server-side persistence: table `sync_conflict(id, tenant_id, mutation_id, device_id, user_id, type, code, mine jsonb, current jsonb, status, created_at timestamptz(6), resolved_by, resolved_at, resolution)` with RLS and insert on any non-retryable rejection **before** responding, plus a `GET /v1/offline/conflicts?status=open`. This changes today's design where a rejected write exists only in the rejecting phone's IndexedDB.

### 2.8 Client sync engine (web)
Files: `apps/web/src/sync/{db.ts,queue.ts,engine.ts,classify.ts,mutations.ts}` replacing `offline.ts` (keep re-exports during migration).
```ts
// mutations.ts: typed registry so write() is not stringly typed
export type MutationType = 'check_in' | 'check_out' | 'payment' | 'slot_status' | 'plate_correction';
export function buildMutation<T extends MutationType>(type: T, input: MutationInput[T], ctx: { userId: string; tenant: string }): QueuedMutation;
// queue.ts
export async function enqueue(m: QueuedMutation): Promise<void>;
export async function nextDue(now: number, as: string): Promise<QueuedMutation | null>;
// engine.ts
export function createSyncEngine(deps: { send: Sender; now: () => number; lock?: LockManager }): { run(): Promise<FlushResult>; subscribe(fn): () => void };
```
One IDB database with versioned stores: `queue` (index `by_due [nextAttemptAt]`, `by_seq [deviceId, clientSeq]`), `conflicts`, `reads`, `kv` (deviceId, clientSeq counter, snapshot). `clientSeq` is allocated in the same IDB transaction as the enqueue to survive crashes.

### 2.9 SDKs
Add `mutationId`/`clientAt` envelope types and `ifMatch` support to `packages/sdk-ts` (`Apache-2.0`) and `packages/sdk-py`; publish `MicroTs` helpers in `packages/core` and mirror in Python (`datetime` with microseconds is native there).

---

## 3. Work packages (parallelisable)

Dependencies: WP-C (shared types + migration) is the only hard prerequisite for WP-D and WP-F; WP-A, WP-B and WP-E can start immediately.

| WP | Name | Findings | Owner files | Depends on | Size |
| --- | --- | --- | --- | --- | --- |
| **WP-A** | SW / precache / offline shell | OS-01, OS-06, OS-07, OS-19 (1-3) | `apps/web/vite.config.ts`, `apps/web/src/sw.ts` (new), delete `public/sw.js`, `src/main.tsx`, `src/snapshot.ts`, `src/readcache.ts`, `src/components/hooks.ts`, `QueryState.tsx`, `app-context.tsx`, `vercel.json` | none | L |
| **WP-B** | Connectivity + indicator | OS-05, OS-15, OS-16 (client half) | `apps/web/src/connectivity.ts`, `components/StatusPill.tsx` (replaces `SyncBadge.tsx`), `components/hooks.ts` (`useLiveEvents`), `Shell.tsx`, all 7+1 locale JSONs, `apps/api/src/server.ts` (`/v1/ping`) | none (server `/v1/ping` is 10 lines) | M |
| **WP-C** | Shared contracts: MicroTs + envelope + clock | OS-03, OS-04 (client+core) | `packages/core/src/time.ts`, `packages/core/src/sync.ts`, `packages/core/src/fees.ts` (accept `MicroTs`), `apps/web/src/clock.ts`, `packages/sdk-ts`, `packages/sdk-py`, `packages/core/test/time.property.test.ts` | none | M |
| **WP-D** | API concurrency + migrations | OS-02 (server), OS-04 (server), OS-09, OS-10, OS-14, OS-18, OS-20 | `apps/api/migrations/019_sync_concurrency.sql`, `020_sync_conflict.sql`, `src/db.ts`, `src/http.ts`, `src/services/{clock,concurrency,merge,sessions}.ts`, `src/routes/{sessions,slots,rates,auth,passes,misc}.ts`, `apps/api/test/*` | WP-C (types) | XL |
| **WP-E** | ALPR offline | OS-19 (4-7) | `apps/web/src/alpr/prefetch.ts`, `alpr/loader.ts`, `components/LiveCamera.tsx`, `screens/Attendant.tsx` (read metadata), `e2e/offline.mjs`, `apps/web/test/prefetch.test.ts` | WP-A for storage persist helper (optional) | M |
| **WP-F** | Sync engine (web) | OS-02 (client), OS-08, OS-11, OS-12, OS-13, OS-21 | `apps/web/src/sync/*`, `api.ts` (`write`), `screens/Attendant.tsx`, `apps/web/test/sync-*.test.ts` | WP-C, WP-D for the new fields (can build against a mock) | XL |
| **WP-G** | Conflict UI | OS-17, OS-22 (UI tests) | `apps/web/src/screens/Conflicts.tsx` (rename of `Queue.tsx`), `components/ConflictCard.tsx`, `menu.ts`, `App.tsx`, locales, `apps/api/src/routes/offline.ts` (conflict list/resolution endpoints) | WP-D, WP-F | L |

Suggested sequencing: parallel wave 1 = A, B, C, E; wave 2 = D (after C types merged), then F and G on top of D.

---

## 4. Test plan

Add `fast-check` (pinned, e.g. `fast-check@3.23.2`) as a devDependency of `packages/core`, `apps/api`, `apps/web`.

**Property tests (microsecond granularity)** — `packages/core/test/time.property.test.ts`:
1. `parseMicros(formatMicros(x)) === x` for any `bigint` in `[0, 4102444800000000]`.
2. `compareMicros` is a total order consistent with bigint comparison for strings that differ only in the last digit (`...123456Z` vs `...123457Z`).
3. A generated sequence of N events with random device ids, random `clientSeq`, random arrival permutation: the sort key `(effective_at, device_id, client_seq)` yields the same order for every permutation (determinism).
4. `stayMinutesMicros(a, b)` equals `floor((b-a)/60e6)` and never throws for `b >= a`; `RangeError` otherwise.
5. `resolveEffectiveAt` invariants: result `<= receivedAt + maxFutureSec`; result `>= in_at` when given; flags consistent; idempotent (`resolve(resolve(x)) == resolve(x)`).
6. Round trip through Postgres: `apps/api/test/time.pg.test.ts` inserts `'2026-10-24T10:41:22.076123Z'`, reads back through the pg client and asserts the string is unchanged (guards the type parser change).

**API integration** (`apps/api/test`, needs Postgres):
- 20 concurrent identical `POST /v1/sessions` with the same key → exactly one session, 19 replays, no `slot_unavailable`.
- Two devices check out the same session concurrently → one `closed`, one `duplicate_checkout` event, payment orphan recorded, no 500.
- Offline replay with `clientAt` 3 hours old → `in_at == clientAt`, `fee` priced on 3 h, `fee_provisional` unset; 72 h old → `stale` + `needs_review`.
- `clientAt` in the future → clamped, flag `future`.
- `If-Match` stale on `PATCH /v1/slots/:code` → `412` with `current`.
- Rate plan: 10 concurrent creates same name → versions 1..10, no 500.
- RLS: `tenant_seq`, `sync_conflict` isolation test next to existing isolation tests.

**Web unit** (`apps/web/test`): `classify()` table; flush lock (two concurrent `run()` calls → one send); backoff schedule with fake timers; IDB v1→v2 migration; `connectivity` hysteresis with scripted ping results; `useApi` stale fallback; `loadSnapshot` cold-start (OS-01); `LiveCamera` offline-without-reader shows manual message.

**E2E** (Playwright, new `e2e/offline.mjs`): sign in, open camera once (warm models), `context.setOffline(true)`, reload (must stay signed in), check in by camera fixture (`e2e/live-plate.mjs` already has a fixture path), check out, assert badge "Offline · 2 saved"; `setOffline(false)` and assert badge goes Syncing → Online and the sessions list shows both with `in_at` equal to the offline capture time (±1 ms).

---

## 5. Things verified fine

- Idempotency body-hash guard and `Idempotent-Replayed` header (`http.ts:100-131`), keys scoped per tenant by PK and RLS.
- Open-session uniqueness enforced by a partial unique index (`001_init.sql:178`) and slot claim by conditional update (`sessions.ts:126`), so the DB (not app code) prevents double occupancy.
- `session_event`, `audit_event`, `rate_plan` insert-only for the app role (`001_init.sql:274`).
- Model integrity: SHA-256 pinned in `models.lock.json`, verified at build (`fetch-models.mjs:17-22`) and again in the browser (`loader.ts:15-24`); build fails loudly offline (matches `AGENTS.md`).
- ORT runtime files are versioned by name so an app/runtime mismatch cannot be cached (`fetch-models.mjs:42-47`).
- Queue replay is owner-scoped and keeps order on network errors (`offline.ts:57-64`; tests `apps/web/test/offline.test.ts`).
- On-device read path has no network call after assets are present; plate registry is bundled (`alpr/plates.ts:4-5`).

## 6. Not verified / limits

- No code was executed; OS-05 and OS-07 (Vercel rewrite behaviour) are derived from `vercel.json`/`nginx.conf` reading, not a live request.
- Real `performance.now()` resolution per browser/OS was not measured; the design treats it as monotonic-unique, not as true wall-clock µs.
- Did not inspect `services/alpr` (Python) beyond its HTTP contract, `packages/sdk-*`, `apps/marketing`, or other migration files (002-018) for existing triggers on `session`/`slot`; the migration above must be reconciled with them (notably 003/013 for `unit`, 009 for `membership`, 014 for stay alerts).
- Zod fractional-second acceptance for `z.string().datetime({offset:true})` should be confirmed by the first test in §4 before relying on it.
