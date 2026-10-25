# Iteration 1 adversarial review: web packages P1, P3, P4

Reviewer: review-web. Scope: `apps/web/**`, `deploy/nginx.conf`, `packages/ui/src/tokens.css`, web-facing parts of `packages/core`. Source was not edited.
Method: PLAN.md and `audit-offline-sync.md` (OS-01..OS-22, section 2.8), `git diff` plus untracked files, the gate commands below, a locale diff script, and contrast maths.

## Gate results

| Command | Result |
| --- | --- |
| `pnpm --filter @openpark/core build` | PASS |
| `pnpm --filter @openpark/web exec tsc --noEmit` | **FAIL**, 3 errors: `components/shared/StatusBadge.tsx(10,17)` (`'neutral'` is not a Badge variant), `main.tsx(10,35)` (`@base-ui/react/direction` does not exist), `offline-cache/sw-manifest.ts(13,36)` (un-awaited `crypto.subtle.digest`). The web build runs `tsc --noEmit` first, so it cannot proceed. |
| `pnpm --filter @openpark/web exec vitest run` | **FAIL**. 142 of 149 tests pass. `test/shell-collapse.test.tsx` (7 tests) kills the worker with a V8 heap OOM, also with `NODE_OPTIONS=--max-old-space-size=512` (RW-02). The 7 tests in that file never ran. |
| `pnpm --filter @openpark/web check:css` | PASS |
| `pnpm --filter @openpark/web build` | **FAIL** at `tsc`. Running `vite build --outDir /tmp/rw-dist` alone also fails: `Missing "./direction" specifier in "@base-ui/react"` (RW-26). |
| Generated sw manifest in `dist` | **Cannot be inspected.** Nothing generates it: `vite.config.ts` is untouched, there is no `sw-manifest.json`, and `generateVersion()` in `sw-manifest.ts` is never called (RW-17). `public/sw.js` fails `node --check` (RW-15). |
| Locale parity (node script over `src/locales/*.json`) | PASS. `ar, de, en, es-ES, es-MX, fr, pt-BR` all have 558 identical keys and the 4 new `sync.*` keys. `en-XA.json` lacks them until `scripts/pseudo.mjs` regenerates it during build. The `term.*` and `sessions.count` placeholder differences are pre-existing ICU plural/term forms, not regressions. |
| New tests | `test/sw-logic.test.ts` only (16 tests of helper functions). **No tests exist for the sync engine, ids, storage, classification, ConnectionStatus, ThemeProvider or shared components.** P1's claim of `ids.ts` unit tests is false. |

## Summary

None of the three packages meets its acceptance bar.

- P1: the new sync engine is not connected to anything that writes. `write()` still enqueues into the legacy queue, and nothing flushes that queue any more. Offline writes are never replayed.
- P4: the shipped service worker does not parse.
- P3: the production build is broken, and the legacy-class layering change visibly alters most existing screens.

Severity: C = data loss, wrong money, app unusable, or build broken. H = feature does not work or a security/privacy hole. M = wrong behaviour in edge cases or quality/a11y gap. L = polish.

---

## P1: sync engine and ConnectionStatus

### RW-01 · P1 · C · The engine is not wired in; offline writes now vanish
- `apps/web/src/api.ts:2` imports `enqueue` from `./offline.js`, and `api.ts:60-68` (`write()`) still calls it with `key: crypto.randomUUID()`, `token: ''` and `at: new Date().toISOString()`. `engine.enqueue()` (`sync/engine.ts:43`) has no callers (`grep -rn "engine\.\|enqueue(" src`).
- `SyncBadge` was removed from `Shell.tsx` and `AppMenu.tsx`. It was the only caller of the legacy `flush()`. Result: an offline check-in or check-out goes into `openpark-offline`, and no code ever sends it.
- `screens/Attendant.tsx:741` still posts `payment: { amount: 0 }`, and nothing sets `offline: true`, so offline check-out is still priced at $0 (OS-02 unfixed). `Attendant.tsx` is untouched in `git status`, although P1 owns "the queue/check-in/check-out call sites in Attendant.tsx".
- Fix:
  1. In `api.ts`, delete the `offline.js` import and make `write()` call `engine.enqueue(method, path, body, ifMatch)` on `isNetworkError`. Return `{ queued: true }` only after `enqueue` resolves, and surface a thrown `QuotaExceededError`.
  2. In `Attendant.tsx` `queueOffline()`, send `{ site, plate, ticket, offline: true }` with no `payment.amount`, and show the "fee confirmed on sync" estimate wording.
  3. Delete `components/SyncBadge.tsx` and `test/sync-badge.test.tsx`, or port that test to ConnectionStatus.
  4. Keep `offline.ts` only as the read-side of the migration.

### RW-02 · P1 · C · `useSync` loops forever and crashes the Shell test
- `sync/useSync.ts:23-24` passes `() => doGetState()` as `getSnapshot`. `doGetState` (`:34-43`) builds a new object on every call. `useSyncExternalStore` requires a referentially stable snapshot, so React re-renders in a loop.
- Repro: `NODE_OPTIONS=--max-old-space-size=512 pnpm --filter @openpark/web exec vitest run test/shell-collapse.test.tsx` ends in `FATAL ERROR: JavaScript heap out of memory` / `Worker exited unexpectedly`. In a real browser the Shell would hit React's "Maximum update depth exceeded".
- Fix: have the engine hold one immutable snapshot object (`{status, pending, conflicts, failed, lastSyncedAt}`) and replace it only when a value changes. `getSnapshot` returns `engine.snapshot` (same reference between changes). `flushNow` is a stable module function, not part of the snapshot. Subscribe via a `Set` and do not call the listener synchronously from `subscribe`.
- `shell-collapse.test.tsx` mocks `../src/offline.js` for `SyncBadge`. Update it to mock `../src/sync/useSync.js` instead.

### RW-03 · P1 · C · Device id and `X-Client-Seq` are never persisted
- `sync/storage.ts:164` creates the `device` store with `keyPath: 'id'`, but `saveDevice` (`:96`) does `put({deviceId, clientSeq})` with no `id`. That throws `DataError`. `getDevice` (`:83`) reads key `'op-device'`, which is never written, so it returns a fresh `crypto.randomUUID()` and `clientSeq: 0` on every call.
- `engine.ts:55` does `clientSeq: this.deviceState.clientSeq++` in memory only. `engine.ts:61` then calls `getDevice()` again, which returns a new random `deviceId` and resets the counter to 0. `saveDevice` is never called by the engine.
- Result: every mutation gets the same `clientSeq` (0, 1 at most) and `sendItem` sends a different `X-Device-Id` each time, which defeats the server ordering key `(effective_at, device_id, client_seq)` and the PLAN requirement "created once per browser profile".
- The audit asked for `clientSeq` to be allocated in the same IDB transaction as the enqueue. Two tabs each hold their own in-memory counter, so they collide.
- Fix: in `storage.ts` use `createObjectStore('device')` with no keyPath and a fixed key `'op-device'`, or `keyPath:'id'` with `{id:'op-device', ...}`. Add `allocate(item)`: one `readwrite` transaction over `device` + `queue` that gets or creates the device record, does `seq = rec.clientSeq + 1`, writes it back and `put`s the item with that `clientSeq`. `engine.enqueue` must use it and never cache `deviceState`. `sendItem` must read the device id from the item (store `deviceId` on each item), not from `this.deviceState?.deviceId ?? 'unknown'` (`engine.ts:263`).
- Also delete the duplicate device store in `offline-cache/indexeddb.ts` (DB `openpark-offline-cache`, store `device`, `getDeviceInfo`, `incrementClientSeq`). Two competing device ids/counters is a trap.

### RW-04 · P1 · C · Double flush across tabs and within a tab
`engine.ts:161-168`:
```ts
const lockResult = await (navigator.locks as any).request?.('op-sync-flush', {ifAvailable:true}, async () => doFlush()).catch(() => null);
if (lockResult === undefined) await this.runFlushWithFallback();
```
- With `ifAvailable:true` the callback is invoked with `null` when another holder has the lock. The callback ignores its argument and flushes anyway, so the lock does not exclude anything.
- `doFlush()` returns `undefined`, so `lockResult` is always `undefined`. The fallback `runFlushWithFallback()` therefore runs a second `doFlush()` after every locked flush. That second flush is outside the Web Lock, so it runs concurrently with another tab's locked flush.
- If `navigator.locks` is missing, `(navigator.locks as any).request` throws a synchronous TypeError before `.catch`. The fallback is never reached.
- The localStorage lease (`:171-205`) is check-then-set (TOCTOU), expires after 5 s while a flush may take longer, and `releaseLease` deletes a lease it may not own.
- The `status === 'syncing'` guards (`:68, :157`) are per-tab and set only after the lock is taken. Two events in the same tick (the `online` event plus `visibilitychange`) both pass.
- Effect: every item is sent twice with the same key. The loser gets `409 request_in_progress`. The domain 409/412 paths can misfile a success as a conflict (the OS-08 repro).
- Fix (exact):
  ```ts
  private flushing = false;
  private async runFlush() {
    if (this.flushing || !navigator.onLine) return;
    this.flushing = true;
    try {
      if (navigator.locks?.request) {
        await navigator.locks.request('op-sync-flush', { ifAvailable: true }, async (lock) => {
          if (!lock) return;          // another tab is flushing
          await this.doFlush();
        });
      } else {
        await this.doFlushWithLease(); // fallback only when locks are absent
      }
    } finally { this.flushing = false; }
  }
  ```
  Make the lease fallback atomic: write `{id, ts}`, re-read after ~50 ms and proceed only if the id is still yours, and refresh the lease while flushing. Add a unit test with two engine instances sharing a mocked `navigator.locks` that asserts one `fetch` per item.

### RW-05 · P1 · C · Ordering violations and head-of-line blocking in `doFlush`
`engine.ts:211-257`:
- `listPending()` returns `getAll()`, which is in primary-key order (`mutationId`), not `clientSeq` order. The key is a base64url string (RW-10), so the order is neither chronological nor causal. A check-out can be sent before its check-in. In-memory mode uses Map insertion order.
- Conflict and failed items are not filtered out. The loop has no `if (item.status !== 'pending') continue`. Every flush re-sends each conflict item, gets the same 409, sets `syncFailed` and `break`s. All later items never flush, so one conflict blocks the queue forever. PLAN says conflicts are "terminal for the queue item" and shown in the conflict UI. This also bumps `attempts` on each re-send.
- `engine.ts:215-220`: an item in backoff is skipped with `continue`, so later items (higher `clientSeq`) are sent ahead of it, violating per-device order.
- `break` after a conflict stops everything. If independent ordering is not guaranteed, the intended behaviour is: stop at a retryable failure (preserve order), but skip terminal items and continue only with items that do not depend on them. For iteration 1, treat the first non-`pending` item as a blocker only if later items share the same entity (plate or ticket), otherwise continue.
- Fix: `const items = (await listPending()).filter(i => i.status === 'pending').sort((a,b) => a.clientSeq - b.clientSeq);`. On a backoff skip, `break` (do not `continue`) so order is preserved. On a terminal item, mark it and continue to the next item whose plate and site differ. Add a `by_seq` index (`[deviceId, clientSeq]`) as in the audit.

### RW-06 · P1 · C · Response classification does not match PLAN.md
`engine.ts:222-246`:
- A network failure returns `status: 0` (`:310`). It matches no retry branch and falls to the final `else`, so the item is marked **`failed` permanently**. Going offline mid-flush therefore dead-letters the queue.
- Retry set is only `429 | 5xx | code==='request_in_progress'`. Missing: `408`, `425`, `status 0`, and a response whose body is not JSON. Per OS-08: `408|425|429|5xx|409 request_in_progress → retry`.
- `403` (expired permission) falls to "failed" with no way back. The audit says `403 → conflict` (supervisor decides).
- `401` keeps the item `pending` and sets `attention`, but there is no resume path: no timer, no re-check after sign-in or token refresh, and `updateStatus` increments `attempts` and stores `lastError` on every attempt.
- `412` (`version_mismatch`) and `422` map to `conflict`, which is right. Add 404 `no_open_session`/`session_not_found`, any 400 and any other 4xx to `conflict`, not `failed`.
- Only `request_in_progress` is read from `error.code`. That matches the server (`{error:{code,message}}` at `http.ts:118`). The PLAN text shows `{"error":"request_in_progress"}` (a string). Keep reading the nested form and also accept a string. PLAN should be corrected.
- No automatic retry: nothing re-runs `doFlush` after `nextAttemptAt` passes. Recovery depends on the browser `online` event or a visibility change, so with `navigator.onLine === true` and a flaky API the queue stalls indefinitely. Backoff therefore never "thunders" but also never resumes.
- Fix: extract a pure, unit-tested `classify({status, code}): 'done'|'retry'|'conflict'|'auth'` (the audit's section 2.8 `classify.ts`) with this table: 2xx → done; 401 → auth; `status 0|408|425|429|>=500|409/request_in_progress` → retry; `403|404|409|412|422|other 4xx` → conflict. Add a single `setTimeout` scheduled at `min(nextAttemptAt)` after each flush, and a 15 s idle re-probe while pending items exist. Do not count a retry as an `attempt` for network errors (cap by time, not count).

### RW-07 · P1 · H · Replays can use the wrong credentials, user, tenant or origin
- `engine.ts:267-271` takes the token from `getSession().token`. With Supabase auth (production) the token lives in `supabase.auth`, and `session.token` is null. Replays go out with no `Authorization`, get 401, and the engine parks in `attention`. Use `await accessToken()` (`api.ts`).
- Items have no `tenant` or `userId`. `sendItem` uses whatever tenant and token are current at replay time. A queue written by user A (tenant X) is replayed under user B or tenant Y on a shared device (the legacy queue guarded this with `user`, and OS-21 raised it). `storage.ts:218-231` drops `oldItem.user` and `oldItem.tenant` on migration.
- `fetch(item.path)` (`:285`) and `fetch('/v1/healthz')` (`:134`) ignore `VITE_API_URL` (`api.ts` `BASE`). In a cross-origin deployment they hit the wrong host.
- Fix: add `tenant`, `userId`, `deviceId` to `SyncItem` at enqueue (from `getSession().tenant` and `me.user.id`; refuse to enqueue with an empty user). In `doFlush`, skip items whose `tenant`/`userId` differ from the current session and show them as "other account" in the Queue screen. Build requests with the exported `BASE`, and reuse `headers()` from `api.ts`.

### RW-08 · P1 · C · Queue migration re-sends old items on every load and can break the legacy DB
`sync/storage.ts:192-239`, called from the engine constructor at import time (every tab, every load):
- It never deletes or marks migrated rows in `openpark-offline.queue`. Every page load re-reads them and `put`s them over the new store by `mutationId`, which (a) resets a `conflict` item back to `pending`, and (b) re-queues items that already synced. Replays are idempotent only while the server still holds the key; after that window they double-apply. The old `conflicts` store is ignored, so unresolved conflicts are lost to the UI.
- `indexedDB.open('openpark-offline', 1)` with no `onupgradeneeded` creates an **empty v1 database with no stores** on a fresh profile. `offline.ts`'s `open()` (`:8-16`) then never gets its upgrade callback, so every later `tx('queue', …)` throws `NotFoundError`. Because the engine is imported by `Shell`, this runs before any write. Combined with RW-01, offline writes on a fresh profile throw.
- `clientSeq` for migrated items comes from `device.clientSeq++` on a non-persisted device (RW-03).
- Migrated check-outs with `payment.amount === 0` keep the $0 bug. Tag them `offline:true` and drop `amount` (or move them to `conflict` with a reason).
- Fix: open with `indexedDB.open(name)` (no version) and bail out if `!db.objectStoreNames.contains('queue')`. Run migration once under the `op-sync-flush` lock. Per row: `newStore.put(...)` and `delete` from the old store in the same logical step, preserving `user` and `tenant` (RW-07). Do the same for old `conflicts` → `status:'conflict'`. Add a fake-indexeddb test (`fake-indexeddb` is already a dependency).

### RW-09 · P1 · H (needs P2) · Heartbeat route does not exist, so the engine stays "offline" forever
- `engine.ts:134` probes `GET /v1/healthz` and requires `res.ok` plus JSON with an `ok` key. The API registers only the root `/healthz` (`apps/api/src/server.ts:166`). `grep -rn "v1/healthz" apps/api/src` returns nothing, so the request returns 404 (`api.openpark.io` rewrite) and the engine sets `offline`. It never flushes, and ConnectionStatus shows "Offline" while online.
- The root `/healthz` is not usable either: Vercel rewrites `/(.*)` to `index.html` (200 HTML), which the JSON check rejects.
- No periodic probe: `checkConnectivity` runs once at init and on `online`/`visibilitychange`. After a failure nothing re-probes, and the 5 s abort `setTimeout` leaks on a throw before `clearTimeout`.
- The status starts `'online'` before the first probe (`:16`), so the badge claims "Online" for a moment when the device is not.
- NEEDS_FROM_OTHER_PACKAGE (P2): register `app.get('/v1/healthz', …)` (no auth, `Cache-Control: no-store`, `{ok:true,time}`) per PLAN. Keep `/healthz`.
- Web fix: probe through `BASE`, with `AbortSignal.timeout(4000)`. Run `setInterval` of 10 s when online and 2 → 4 → 8 → 15 s backoff while offline, and require 2 consecutive failures before showing offline (hysteresis). Initial status `'unknown'`, rendered as syncing/neutral. Call the probe immediately when `request()` in `api.ts` catches a `TypeError`. Only the Web Lock holder should probe (the audit's OS-15).

### RW-10 · P1 · M · `ids.ts` is not a UUIDv7
- `ids.ts:42-44` returns a 22-character base64url string. The contract says `Idempotency-Key`/`mutationId` is a UUIDv7, and the server and SDK expect a UUID.
- `nowMicros()` (`:47-56`) returns **milliseconds** (`Math.floor(timeOrigin + now)`), not µs. The Node fallback returns `Date.now()*1000n`, which overflows the 48-bit field. The "bump 1 µs" bumps 1 ms.
- `compareUuidv7` (`:62-66`) claims lexicographic base64url order equals time order. It does not (base64 alphabet order differs from ASCII: `-` and digits sort before upper case, `_` and lower case after). It is dead code, but it is wrong.
- The version and variant bits are set at the right byte offsets (6 and 8 of the 16 bytes), but the result is then base64url-encoded, so it can never be parsed as a UUID.
- Fix: implement the RFC 9562 layout (48-bit ms timestamp, 12-bit monotonic counter in `rand_a`, 62 random bits) and format as `xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx`. Use a monotonic counter when the ms is equal. Test: matches `/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/`, 10 000 ids are strictly increasing as strings.

### RW-11 · P1 · M · ConnectionStatus: a11y, layout shift, copy
`components/ConnectionStatus.tsx`:
- Online state (`:12-19`) is an 8 px coloured dot with the label `sr-only`. That is colour-only for sighted users and fails WCAG 1.4.1. Show a visible text label (or at least an icon plus text).
- Announcements: the component returns a different element per state, so the `role="status"` live region is re-created on each transition. Screen readers usually do not announce content that arrives together with a new live-region node, and `aria-label` changes on a `role=status` are not announced. Also `:36` has `aria-live` only on the syncing badge.
- Fix: render one persistent wrapper `<div role="status" aria-live="polite" aria-atomic="true">` whose text node changes, and wrap the content (Badge or Link) inside it.
- Layout shift: online renders an 8 px dot, offline and syncing render a text pill, so the header jumps and `grow` neighbours move. Reserve a `min-inline-size` (about `7rem`) or always render icon plus short text.
- `variant="success"` on the online Badge inherits unstyled/low-contrast colours (RW-28).
- The attention state links to `/queue`, a staff screen listed only in the supervisor/admin menu (`menu.ts:55,67`). Attendants (the people who create the conflicts) can reach the route but have no menu entry. Add it to the attendant menu or link to a screen they can open.
- Copy (`locales/*.json`): "Needs attention {count}", "Syncing {count}", "Se requiere atención 3" put a bare number after the phrase, with no noun and no plural. Use ICU plurals: "{count, plural, one {# change needs review} other {# changes need review}}" and "Syncing {count, plural, one {# change} other {# changes}}". Offline state should say what is saved: "Offline · {count} saved". de "Achtung erforderlich {count}" is unidiomatic (use "{count} zur Prüfung"). All 7 locales need the same edit.
- RTL: `me-1` and `px-2` are logical or symmetric, so RTL is fine. Mounted once (Shell only): confirmed.

### RW-12 · P1 · M · Queue screen defects
`screens/Queue.tsx`:
- `:65` `new Date(Number(w.deviceAt) / 1000)` — `deviceAt` is an RFC 3339 string, so `Number()` is NaN and every pending row shows "Invalid Date". Use `new Date(w.deviceAt)` (ms precision is fine for display) or `formatDate`.
- `:77, :94` hard-coded English fallbacks `'Conflict'`, `'Failed'`, and raw server messages shown to users. Use i18n keys and map error codes to text (`labels.ts` style).
- `:81, :98` "Discard" is labelled `att.done` ("Done") and deletes the unsynced mutation locally with no reason and no audit. This is OS-17's exact complaint. Minimum: a confirm with a warning and the label "Discard".
- `:25-29` no subscription: the list never updates when the engine changes state (the comment admits it). Subscribe to the engine, or use `BroadcastChannel`.
- `retry()` calls `updateStatus(id,'pending',…)`, which increments `attempts`, never clears `nextAttemptAt`/`lastError`, and does not trigger a flush. Add `syncStore.requeue(id)` that resets those fields, then call `engine.flushNow()`.
- `mutationId.slice(0, 8)` is meaningless to users. Show plate or ticket, the action, and the capture time.
- Unused import `Link`. Labels hard-code `/checkin`, `/checkout` substring checks that do not match other paths.

### RW-13 · P1 · M · Missing tests
No tests for: `classify`, backoff and schedule, double flush (two instances plus mocked `navigator.locks`), FIFO by `clientSeq`, Idempotency-Key stable across retries, device id persistence, migration (fake-indexeddb, idempotent re-run), `useSync` snapshot stability, ConnectionStatus states and live region, offline check-out body (`offline:true`, no `amount`), and `shell-collapse` after the RW-02 fix. Add `apps/web/test/sync-engine.test.ts`, `sync-classify.test.ts`, `sync-migration.test.ts`, `sync-ids.test.ts`, `connection-status.test.tsx`. Nothing weakened or deleted is allowed; keep `offline.test.ts` for the legacy read path while it exists.

### RW-14 · P1/P4 · M · Unrelated comment deletions
`git diff` shows dozens of explanatory comments deleted from `api.ts` (for example the Fastify empty-body note, the `write()` doc comment, the `PublicConfig` realtime note) and `app-context.tsx` (the `canEditPassPolicy` rationale, the AC-5.4 Spanish-default note, role docs). PLAN says "Comments explain why". Restore them (`git diff apps/web/src/api.ts apps/web/src/app-context.tsx` shows each removal). New comments in `engine.ts` and `sw.js` mostly restate code ("Success: remove from queue").

---

## P4: offline shell, API read cache, offline boot, ALPR prefetch

### RW-15 · P4 · C · `public/sw.js` is TypeScript and cannot run
- Verified: `node --check apps/web/public/sw.js` → `SyntaxError: Unexpected token ':'` at line 29 (`let assets: { url: string; size: number }[] = []`). Line 2 is `import … from '../offline-cache/sw-logic.js'`. Files in `public/` are copied verbatim, registration is a classic script (`register('/sw.js')`, no `type:'module'`), and `../offline-cache` is outside the served root.
- Effect on a fresh install: `register()` rejects and is swallowed by `.catch(() => {})`. There is **no service worker and no offline shell at all**, a regression from the previous (working) `sw.js`. Existing clients keep the old SW until it is replaced.
- Fix: build the SW with Vite. Either `vite-plugin-pwa` with `strategies:'injectManifest'` (pin the exact version; the audit's OS-07 recipe), or a small Vite plugin that bundles `src/sw.ts` (esbuild, `format:'iife'`) to `dist/sw.js` and injects `__PRECACHE__` (the hashed asset list from the bundle) plus a build hash. Delete `public/sw.js`. Add a test that `new vm.Script(builtSwSource)` compiles.

### RW-16 · P4 · C · Even if it parsed, every API GET would fail
`sw.js:141-143, :169-206`:
- `fetch` responses and their clones have immutable headers. `cloned.headers.set('X-From-Cache','0')` (`:197`) throws `TypeError: Headers are immutable`, so `respondWith` rejects and **every `GET /v1/*` fails while online**.
- `/v1/events` (SSE) is routed through the same handler: `response.clone()` plus `cache.put` would try to buffer an endless stream.
- The API cache is write-only. There is no read path on network failure, so OS-06 (offline reads) is not delivered.
- `cacheControl.includes('no-store')` is the only guard. `private` responses, `Set-Cookie`, `Vary: Authorization` and 401/403 handling are ignored. The path-only key drops the query string (`?site=A` and `?site=B` collide).
- Offline reads belong in the app, per the audit's OS-06 design (stale-while-revalidate keyed `tenant|userId|GET path+query` in IDB), not in the SW. Fix: remove `handleApiRequest`, let `/v1/*` bypass the SW (`return;` without `respondWith`), and implement `readcache.ts` plus `useApi` stale state. If an SW-level cache is kept: skip `/v1/events`, `/v1/auth*`, `/v1/healthz`, `/v1/alpr*`, `Cache-Control: no-store|private`, non-200; key on `tenant + userId (from JWT sub, not a token hash) + full URL`; construct new `Response` objects with copied headers; add the network-failure read path; and cap entries.

### RW-17 · P4 · H · Precache is empty and the SW never updates
- `vite.config.ts` is unchanged. Nothing emits `sw-manifest.json`. The SPA fallback (`/(.*)` → `index.html`, Vercel) answers `/sw-manifest.json` with HTML 200, so `res.json()` throws (`sw.js:33`), the dev fallback list is used (`/`, `/index.html`, icon, webmanifest), and **no hashed JS/CSS is ever precached**.
- Even with a manifest, `sw.js:81` requires `contentTypeMatches(res, 'document')` for every asset, so each JS/CSS/font response is rejected and not cached (and no failure is recorded). Only HTML passes.
- `APP_CACHE_VERSION = 'v1'` and the SW bytes are identical across deploys, so browsers never see a new SW and the "install" step never re-runs. Stale chunk handling therefore depends entirely on runtime caching.
- `offline-cache/sw-manifest.ts:12-13` `generateVersion` uses `crypto.subtle.digest` without `await` (tsc error), is async-incompatible, and is never called.
- Fix: the build plugin from RW-15 produces the asset list with revisions (hash) and bakes it into the SW (`__PRECACHE__`) so the SW file changes on every deploy. Install: `cache.addAll(shellAssets)` under a cache name that includes the build hash. Use the destination-appropriate content-type guard per asset (script → javascript, style → css, etc.), not `'document'`. Activate: delete other `op-app-*` caches. Exclude `models/**` and `ort/**` from the precache list.

### RW-18 · P4 · H · Runtime cache poisoning; model and ORT names are stale
- `sw.js:294-296` `cacheFirst` stores any `res.ok` response with no content-type check. Vercel serves `index.html` (200) for any unknown path, so a stale hashed chunk or a missing `/models/*.onnx` gets cached as `text/html` under a `.js`/`.onnx` URL and then served cache-first forever. This is OS-07's poisoned-cache hazard, still present. The reader branch of the old SW had this guard.
- `MODELS_MANIFEST` (`sw.js:11-21`) hard-codes `ort-1.18.0-simd.*` and `sha256:'placeholder-models-sha'`, but `public/ort/` contains `ort-1.30.0-simd.mjs/.wasm`. `models.lock.json` pins the names and hashes. Read the manifest at build time instead.
- The SW uses cache `op-models-v1` while `alpr/loader.ts:3` uses `openpark-models-v1`. Two stores, with the SW not verifying SHA-256, so the loader's checksum protection is bypassed when the SW answers.
- `vercel.json` and `nginx.conf` set `immutable, max-age=31536000` on `/models/*` and `/ort/*`. Model filenames are **not content-hashed**, so a bump in `models.lock.json` will never reach clients (browser and SW both cache-first, and the loader's SHA check would then fail forever). Either put the lock hash in the path (`/models/<sha8>/…`), or use `no-cache` plus ETag for `/models/*`.
- Fix: guard every cache write with `contentTypeMatches` for the request destination plus `res.status === 200 && !res.redirected`. For models require `application/octet-stream` (or the actual type) and verify the SHA-256 from the manifest before `put`. Derive the models cache name from the manifest hash and delete older ones in `activate`.

### RW-19 · P4 · H · Install blocking, SW takeover, no update flow
- `sw.js:55-67` downloads ORT wasm and both models (~25 MB+) **sequentially inside `install`'s `waitUntil`**, before the app assets. A slow connection delays activation for minutes. `modelCache.put(...)` is not awaited, so writes can be cut off when `install` resolves. Models must be best-effort and out of the install critical path (separate "prefetch" message).
- `self.skipWaiting()` runs at the end of `install` (`:98`) and `clients.claim()` in `activate`, swapping the worker under open pages. Combined with a cache name that does not change, old pages can mix new chunks.
- `main.tsx:46-62`: `controllerchange` is dispatched as `op:sw-update`, but nothing listens for that event (`grep -rn "op:sw-update" src` finds only the dispatchers). It also fires on the **first** install (due to `clients.claim`), and the log says "reloading" but nothing reloads. There are two separate `if ('serviceWorker' in navigator …)` blocks, and `console.log` calls ship to production.
- Fix: drop `skipWaiting()` in `install`. Post `SKIP_WAITING` only after the user confirms an "Update available" `Alert`/toast, and only when the sync queue is empty and no check-in flow is open. Reload on `controllerchange` only if the page previously had a controller. Remove the logs and merge the two blocks. SW update toast strings need locale keys in all 7 files.

### RW-20 · P4 · C · Offline boot snapshot never loads and never clears
`app-context.tsx`:
- Save (`:87`) uses `saveSnapshot(m.user?.id ?? '', tenant, …)`, storing key `snapshot-<userId>-<tenant>`. Load (`:92`) and clear (`:109, :136, :141`) use `'current-user'`, a different key. **The snapshot is never found, so offline cold start still redirects to `/login` (OS-01 unfixed)**, and `signOut`/401 never delete the stored snapshot (PII for `who`, `me`, `sites` stays on a shared device).
- `tenant` is read before the membership/slug reconciliation (`:71`), so on first login it is `''`. The snapshot is stored under tenant `''`.
- The early return `if (!(await accessToken())) { clear(); … }` at `:71` runs before the offline fallback. With Supabase, `getSession()` offline with an expired JWT (about 1 h) returns no session, so an offline boot longer than an hour goes to `/login` regardless of the snapshot.
- No expiry: nothing checks `savedAt`. A revoked user stays signed in offline indefinitely. 401 on a later online load does clear (once the key bug is fixed), but nothing bounds the offline window.
- `get('/v1/sites')` is fetched twice per reload (`:86-87`). Snapshot persistence failures (IDB error) are not network errors and propagate into the `catch`, silently skipping the rest of the method.
- Fix: key the snapshot by `userId` taken from the last session: store `{userId, tenant}` in a small `kv` record (`lastSession`) and `loadSnapshot()` reads it with no arguments (the audit's signature). `clearSnapshot()` clears all on sign-out/401. Move the offline fallback ahead of the `accessToken()` check: if `navigator.onLine === false` or a network error occurs, hydrate from the snapshot when `Date.now() - savedAt < 7 days`, set `offlineReady=true`, and never call `clear()`. A 401/403 from the server always clears. Write the snapshot after both calls in a `try/catch` that logs but does not alter state. Use one `sites` fetch. Test: fake-indexeddb, `fetch` throws `TypeError` → `me` hydrated, no redirect; 401 → snapshot removed.

### RW-21 · P4 · H · API cache isolation and logout clearing do not work
- `clearApiCache()` (`api.ts:83-103`) has **zero callers** (`grep -rn clearApiCache src`). Sign-out, 401 and tenant switch do not purge anything.
- The SW side (`sw.js:360-381`) is a no-op: keys are strings like `api:<tenant>:<hash>:/v1/…`, which `cache.keys()` returns as Requests resolved against the SW scope (pathname `/api:...`), so `startsWith('/v1/')` is false and nothing is deleted. It also reads `url.searchParams.get('tenant'|'auth')`, which never exist.
- The key embeds a SHA-256 of the whole `Authorization` header. Supabase rotates tokens about hourly, so old entries are never matched again and never cleaned, and `clearApiCache` only hashes the **current** token, so earlier entries for the same user survive logout on a shared device. The key should use the user id (JWT `sub`) plus tenant, not the bearer token.
- Fix as in RW-16 (preferred: delete SW API caching). If kept: on sign-out and tenant switch call `caches.delete('op-api-v1')` outright, which is simpler than selective deletion.

### RW-22 · P4 · M · ALPR prefetch not wired or incorrect (OS-19)
`alpr/loader.ts:56-152`, `alpr/offline.ts`:
- `prefetchModelsIfOnline`, `requestStoragePersistence`, `getReaderState` have **no callers**. Nothing prefetches after sign-in and `navigator.storage.persist()` is never called. `grep -rn "persist()" src` finds only the definition. (No persist spam, but also no persistence.)
- `offline.ts:19` `const isOnline = checkConnection();` — missing `await`, so the Promise is always truthy; it also checks only `saveData`, not online state.
- `readerReadiness()` (`loader.ts:116-124`) returns `'downloading'` whenever an SW controller exists and `'ready'` otherwise, which is inverted and unrelated to the cache contents. `subscribeReaderReadiness` is a no-op.
- `postMessageToSw` waits for `PRECACHE_MODELS_DONE` on `channel.port1`, but the SW replies with `e.source?.postMessage(...)` (to the client, not the port) **before** `precacheModels()` finishes. The page always waits the full 30 s, then runs the fallback.
- The fallback does `import('onnxruntime-web/wasm')` just to run `fetch` (it pulls the ORT bundle for nothing), `cache.put` is not awaited, there is no SHA-256 verification, and it writes to `openpark-models-v1` using the `ort.mjs` names from the manifest (correct) while the SW writes `op-models-v1` (RW-18).
- Fix: implement `prefetch.ts` as the audit says (reuse `modelBytes()` for each file so SHA-256 and the loader cache are used, fetch `ort-*.mjs`/`.wasm`, no ORT session). Return `'ready'|'failed'` and keep a real `readerState` in a small store. Call it once after sign-in in `requestIdleCallback`, only for attendant/supervisor/admin with `ai_mode !== 'off'`, and call `navigator.storage.persist()` once guarded by a `localStorage` flag. Show the state in the Attendant home with a retry button, and add `test/prefetch.test.ts`.

### RW-23 · P4 · M · Hosting rules
- `vercel.json`: header rules for `/sw-manifest.json` are present, but the file does not exist (RW-17). Headers for `/models/(.*)` apply to the SPA rewrite output as well, so a missing model returns `index.html` with a one-year immutable header from the CDN. Fix: do not mark `/models/*` `immutable` unless the path is versioned (RW-18). Add `Cache-Control: no-cache` for `/manifest.webmanifest`.
- `nginx.conf`: `location /models/` and `/ort/` use `try_files $uri =404` (good, no SPA swallowing). `add_header` in a location replaces any server-level `add_header`; confirm no security headers are lost. Same `immutable` concern as above.

### RW-24 · P4 · L · SW test coverage
`test/sw-logic.test.ts` tests pure helpers that the real SW does not use correctly (it never passes the destination to `contentTypeMatches`). Add: SW source compiles (RW-15), install pre-caches only same-type assets, immutable-header handling, and cache write refuses `text/html` for `.js`.

---

## P3: UI foundation

### RW-26 · P3 · C · Production build is broken
- `main.tsx:10` imports `DirectionProvider` from `@base-ui/react/direction`. The package exports `./direction-provider` (`ls node_modules/@base-ui/react | grep -i direction` → `direction-provider`). `vite build` fails: `Missing "./direction" specifier in "@base-ui/react"`; `tsc` fails with TS2307. Fix: `import { DirectionProvider } from '@base-ui/react/direction-provider'` and confirm the exported name.
- `components/shared/StatusBadge.tsx:10`: `tone` includes `'neutral'`, which `Badge` has no variant for (TS2322). Map `neutral → 'secondary'`.

### RW-27 · P3 · H · `ui/input.tsx` overwritten: refs dropped (React 18.3.1)
- `git diff apps/web/src/components/ui/input.tsx` removes `React.forwardRef` and the `ref` pass-through. `apps/web/package.json` pins `react ^18.3.1`, where function components do not receive `ref`. These call sites break, with `ref.current` always `null` and a React warning: `screens/Inventory.tsx:63`, `screens/Bulk.tsx:106`, `screens/People.tsx:146` (`file.current?.click()` for the file picker, so the "choose file" action stops working), and `screens/Resident.tsx:202` (`guestNameRef` focus). `PlateInput.tsx` forwards a ref to its own input, so it is unaffected.
- This is exactly the "overwritten components/ui files" risk. Fix: revert `input.tsx` to the previous `forwardRef` version (keep any intended change as additive). Check `git diff apps/web/src/components/ui` for other unintended removals before accepting: `button.tsx`, `badge.tsx` and `alert.tsx` are additive (variants, `loading`, `displayName`) and acceptable except as noted in RW-28/RW-32.

### RW-28 · P3 · H · Semantic colour tokens: no utilities, failing contrast, duplicated definitions
- `styles.css` `@theme inline` (lines 52-110) registers `--color-destructive` but **no** `--color-success`, `--color-warning`, `--color-info`, or their `-foreground` variants (`grep -n "color-success\|color-warning\|color-info" src/styles.css` returns nothing). Tailwind v4 emits colour utilities only for theme-registered colours, so `bg-success`, `text-success-foreground`, `bg-info/10`, `text-warning` etc. on the new Button/Badge/Alert variants should produce no CSS. I could not confirm this in built CSS because `vite build` fails (RW-26); treat it as unverified until the build runs, but the registration is plainly missing. Fix: add `--color-success: var(--success); --color-success-foreground: var(--success-foreground);` and the same for warning and info, and a `--color-destructive-foreground` (used by `shared/ViewState.tsx`, also unmapped).
- Contrast of the solid variants in light mode (WCAG 2.x ratios, computed): `--success-foreground #064e3b` on `--success #0f7a4b` = **1.81:1**; warning `#78350f` on `#b45309` = **1.81:1**; info `#1e3a8a` on `#1d4ea8` = **1.34:1**. All fail AA (4.5:1). Dark mode info `#1e3a8a` on `#60a5fa` = 4.07:1 also fails. Use white text on the light solids (5.38 / 5.02 / 7.76) and `#0b1f4d` on the dark info (6.27). The 10 % tint alerts: `text-warning` on its tint is about 4.34:1 (fails); use a darker warning ink for text.
- Tokens are defined three times with different values: `packages/ui/src/tokens.css`, `styles.css :root`, and `.dark` plus `:root:where(.dark)` (identical duplicate blocks). `--info` is `#1d5fa8` in tokens and `#1d4ea8` in `styles.css`, which silently changes the legacy `.banner`, `.pill.info`, and focus-outline colour. Add `--warning` alongside the existing `--warn` only if both are needed; prefer aliasing (`--warning: var(--warn)`). Keep one definition site (tokens.css, shared with `apps/marketing/src/layouts/Base.astro`).

### RW-29 · P3 · H · Theme toggle does not control most colours
- `packages/ui/src/tokens.css:37` still switches `--bg --surface --ink --line --accent …` with `@media (prefers-color-scheme: dark)`. The shadcn colours are mapped from these (`--color-card: var(--surface)`, `--color-primary: var(--accent)`, `--color-input: var(--control-border)`, and so on). So ThemeProvider's `.dark` class only changes the semantic extras. User chooses **Light on a dark OS**: legacy and shadcn surfaces stay dark while `.dark` is removed. **Dark on a light OS**: the page stays light with a few dark accents.
- Fix: in tokens.css make the dark values apply to `:root:where(.dark)` and keep the media query only as the no-JS default scoped to `:root:not(.light)`; ThemeProvider adds `.light` or `.dark` explicitly. `apps/marketing` imports the same file: re-check it renders unchanged with no class.

### RW-30 · P3 · H · Dark-mode flash and ThemeProvider defects
- `theme/ThemeProvider.tsx:26-47` applies the class in `useEffect` after first paint. `index.html` has no pre-paint script, and `main.tsx:24-26` mounts `ThemeProvider` **inside** `AppProvider`, which returns `null` until the first `/v1/me` round-trip completes (`app-context.tsx:151`). A dark-theme user sees a white page for the length of the network request, then a flash.
- `useState<ResolvedTheme>('light')` is wrong on first render for dark users.
- `toggleTheme` (`:62-68`) does not persist, and from `'system'` returns `'system'` (a no-op).
- `colorScheme` is set inline only for the resolved value, while `styles.css:103` keeps `html { color-scheme: light dark; }`.
- Fix: add to `index.html` `<head>` an inline script (CSP: this app has none, but note it) that reads `localStorage['op.theme']` and `matchMedia`, then sets `document.documentElement.classList` and `style.colorScheme` synchronously. Mount `ThemeProvider` above `AppProvider`. Initialise `resolvedTheme` lazily from the DOM class. Make `toggleTheme` call `setTheme(resolved === 'dark' ? 'light' : 'dark')`. Add a test (jsdom + `matchMedia` stub).

### RW-31 · P3 · H · Wrapping legacy CSS in `@layer components` visibly changes existing screens
Before: the legacy rules were **unlayered**, so they beat every Tailwind utility (utilities live in `@layer utilities`). Now they are in `@layer components`, so any utility on the same element wins. 102 `<Button … className="…btn…">` (78 with no `variant`), 71 `<Card className="card …">`, and 44 `<Input>` pair a shadcn component with a legacy class. Concrete regressions to expect:
1. **Buttons (`.btn`, 78 call sites without a variant):** `Button` default is `bg-primary text-primary-foreground`. Previously `.btn { background: var(--surface); color: var(--ink) }` won, so these looked like neutral secondary buttons. Now they become solid green primary buttons. Also `rounded-lg` beats `border-radius: var(--radius-sm)`, `px-2.5` beats `padding-inline:16px` (touch targets are saved by `min-block-size:44px`, which is not overridden), `font-medium` beats `font-weight:600`, and `border-transparent` removes the 1px line border. The visual hierarchy primary vs neutral is lost on screens such as Attendant, Queue, Inventory.
2. **Cards (`.card`):** shadcn `Card` brings `ring-1` plus `rounded-xl`, `py-4`, `gap-4`. Previously `.card { box-shadow: var(--shadow) }` replaced the ring. Now both the legacy `border: 1px solid` and the ring render: a doubled outline, a different radius, and extra vertical padding. `.stack` is still unlayered and keeps `display:grid` over `Card`'s `flex flex-col`.
3. **Inputs/selects/textareas:** `input, select, textarea { border: 1px solid var(--control-border); padding: 10px 12px; background: var(--surface); }` now lose to the shadcn `Input` classes (`border-input`, `px-2.5 py-1`, `bg-transparent`, `dark:bg-input/30`). `--control-border` (`#6f7971`) exists specifically to meet 3:1 non-text contrast; `--color-input` maps to it, so light mode survives, but `dark:bg-input/30` and the padding change are visible, and native `select`/`textarea` (which do not use shadcn) keep the old look, so form controls become inconsistent within one form.
4. **Focus:** `button:focus-visible, a:focus-visible { outline: 3px solid var(--info) }` is now overridden by `outline-none` on `Button`. The shadcn ring replaces it (acceptable), but `a` elements styled as buttons keep the legacy outline: two focus styles.
5. **Media queries still unlayered:** the `@media (max-width:767px)` and `@media (min-width:768px)` blocks remain outside the layer, so on mobile `.main`/`.att`/`.tabbar` rules beat utilities while desktop rules lose. Wrap them in the same `@layer components` to keep behaviour uniform.
6. **Typography:** `th, td` and `table` rules in the layer now lose to the shadcn `Table` classes (padding, `whitespace-nowrap`, header colours).
- The plan said "screen migrations off legacy classes are deferred", so P3 must not change the look of the unmigrated screens. Options: (a) revert the layering and leave legacy CSS unlayered until the screens migrate, or (b) keep the layer but replace each affected `.btn`/`.card`/`input` rule with a version that sets the shadcn variables, and add a visual regression check (screenshots of Attendant, Queue, Inventory, Settings in light/dark/RTL) before merge. Recommend (a) for iteration 1.

### RW-32 · P3 · M · New shared components are incomplete or unsafe
- `shared/ConfirmDialog.tsx`: `useConfirm` stores state in a `useRef`, so nothing re-renders; `isOpen` and `options` are read once during render and never update. The `Dialog` imports are unused and no dialog is rendered. It is non-functional, and the new `ui/alert-dialog.tsx` is not used. Rebuild on `AlertDialog` with `useState` and a rendered `<ConfirmHost/>`, support `requireText`, and focus the cancel button for destructive actions.
- `shared/ViewState.tsx`: hard-coded English ("No results", "An error occurred", "Try again", the empty-state body) with no i18n; loading skeleton has no `role="status"`/`aria-busy`; the error block has no `role="alert"`; uses a raw `<button>` with `text-destructive-foreground` (no token, RW-28) instead of `Button`; the empty-state svg is `0 0 24 24` without `aria-hidden`.
- `shared/PageHeader.tsx`: breadcrumbs use `<a href>` (full page reload, ignores the router and `BASE`), a leftover `TODO: Add breadcrumb component` although `ui/breadcrumb.tsx` now exists, English `aria-label="Breadcrumb"`, and a `/` separator that does not mirror in RTL.
- `shared/StatusBadge.tsx`: colour only; add an icon or leading text so status is not conveyed by colour alone (WCAG 1.4.1).
- `ui/alert.tsx`: `[svg]:text-success` / `[svg]:text-warning` / `[svg]:text-info` are not valid Tailwind v4 variants (the existing classes use `*:[svg]:` and `[&_svg]:`). `alertIcons` is exported but nothing renders an icon. The default role flips for non-destructive variants from `alert` to `status`; check existing banners that rely on `role="alert"` (none found in `grep`, since they set the role explicitly).
- `ui/button.tsx`: `loading` sets `disabled`, which drops keyboard focus mid-submit; prefer `aria-disabled` plus `aria-busy` and ignore clicks while loading. The spinner has no accessible name. The `touch` size is `h-14` with no `min-inline-size`.
- No tests for any shared component, and no locale keys were added for the new default strings (P3's own "pending" list).
- `package.json` adds `"prebuild": "pnpm --filter @openpark/core build"` (works with pnpm's pre/post scripts; verified in the build log) and `@openpark/core: workspace:*`. No new third-party dependency. `cn` is `shadcn-ui/cn`, already present. `sonner` and `next-themes` are not present anywhere (`grep` clean).

---

## What I checked and found fine
- Locale key parity across all 7 locale files, plus the 4 `sync.*` keys (script above).
- `ConnectionStatus` is mounted exactly once (`Shell.tsx:35`). `AppMenu` no longer renders a badge.
- `check:css` passes. `ConnectionStatus` uses logical utilities (`me-1`, symmetric padding).
- Idempotency-Key is stable per item in the engine (`mutationId` is generated once at `enqueue` and reused in `sendItem`). `deviceAt` is stored at capture and re-sent unchanged.
- Engine reads the API's actual error envelope (`{error:{code}}`), so `request_in_progress` is detectable.
- `nginx.conf` `/models/` and `/ort/` locations 404 rather than fall back to `index.html`.
- No new unpinned third-party dependencies were added.

## NEEDS_FROM_OTHER_PACKAGE
- P2: register `GET /v1/healthz` (`apps/api/src/server.ts`, near `:166`; no auth, `Cache-Control: no-store`, `{ok:true,time:<MicroTs>}`). The engine cannot leave "offline" without it (RW-09).
- PLAN.md / P2: the contract says `409 {"error":"request_in_progress"}` but the server emits `{error:{code,message,details}}`. The engine reads the nested form; amend PLAN or have P2 confirm.

## Fix order (suggested)
1. RW-26 (build), RW-27, RW-02 (so tests run), then RW-01 (wire `write()`), RW-03, RW-04, RW-05, RW-06, RW-07, RW-08, RW-09, RW-10.
2. RW-15, RW-16, RW-17, RW-18, RW-19 (rebuild the SW through Vite), RW-20, RW-21.
3. RW-28, RW-29, RW-30, RW-31 (P3 visual and theming), then RW-11, RW-12, RW-22, RW-23, RW-32, RW-13, RW-14, RW-24.

VERDICT: NEEDS_CHANGES
