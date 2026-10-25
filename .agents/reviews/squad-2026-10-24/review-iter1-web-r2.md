# Iteration 1 adversarial re-review (round 2): web packages P1, P3, P4

Reviewer: rereview-web. Scope: `apps/web/**`, `deploy/nginx.conf`, `packages/ui/src/tokens.css`. Source was not edited (only this file was added; two throwaway probe tests were created and deleted).
Method: PLAN.md (incl. "Contract amendments"), `review-iter1-web.md` (RW-01..RW-32), `git diff -- apps/web deploy packages/ui` plus untracked files, the gate commands, runtime probes (fake-indexeddb, `vm.Script`, built CSS grep, contrast maths).

## Gate results

| Command | Result |
| --- | --- |
| `pnpm --filter @openpark/core build` | PASS |
| `pnpm --filter @openpark/web exec tsc --noEmit -p .` | PASS (0 errors) |
| `pnpm --filter @openpark/web exec vitest run` | PASS, 23 files, 149 tests. 0 new tests since round 1 (`sw-logic.test.ts` only). `shell-collapse` now passes, but only because it mocks `useSync` (see RW-33). |
| `pnpm --filter @openpark/web check:css` | PASS |
| `pnpm --filter @openpark/web build` | PASS (`tsc`, fetch-models, pseudo, `vite build`; `dist/` produced) |
| `node --check dist/sw.js` | PASS, **but this check is misleading**: the package is `"type":"module"`, so Node parses the file as ESM. As a classic script (how the SW is registered, `register('/sw.js')` with no `type:'module'`) `new vm.Script(src)` fails with `Cannot use import statement outside a module`. `dist/sw.js` line 2 is still `import … from '../offline-cache/sw-logic.js'` (RW-15). |
| `dist` manifest | No `dist/sw-manifest.json`, no precache list. `vite.config.ts` and `index.html` are untouched. |
| Locale parity | PASS. 8 files, 558 keys each, 0 missing. The `sync.*` copy is unchanged (RW-11). |

## Verdict summary

The fix round repaired only the compile/test blockers (RW-26, RW-27, the RW-02 render loop, plus `neutral` and the `crypto.subtle.digest` await). **Of the 31 prior findings, 4 are fixed, 1 is half fixed, and 26 are untouched.** It also introduced one new critical bug in the RW-02 fix (RW-33). The binding amendment "the `@layer components` wrap is REVERTED" was not applied. None of P1, P3 or P4 meets its acceptance bar.

Severity: C = data loss, wrong money, app unusable, or build broken. H = feature does not work or a security/privacy hole. M = wrong behaviour in edge cases or quality/a11y gap. L = polish.

## Status of every prior finding

| ID | Sev | Status | Evidence |
| --- | --- | --- | --- |
| RW-01 | C | **OPEN** | `api.ts:2` still imports `enqueue` from `./offline.js`; `api.ts:60-68` unchanged (`token: ''`, `at: new Date().toISOString()`). `grep -rn "sync/engine\|engine\." src` outside `src/sync` and `ConnectionStatus`/`useSync` returns nothing: `engine.enqueue` has no caller. `SyncBadge` (the only legacy `flush()` caller) is no longer mounted. `Attendant.tsx:741` still posts `payment: { amount: 0 }`; `Attendant.tsx` has no diff. |
| RW-02 | C | **PARTIAL** | The infinite render loop is gone (stable `snapshot`), but the replacement is stale by one update, see RW-33. |
| RW-03 | C | **OPEN, reproduced** | With `fake-indexeddb`, two `enqueue` calls produce `clientSeq` `[0, 0]` and `getDevice()` returns a different `deviceId` on each call (`ff982244…` then `6fb048d0…`). `saveDevice` is never called by the engine; `storage.ts:164` still uses `keyPath:'id'` while `put({deviceId, clientSeq})` has no `id`. `engine.ts:289` still sends `X-Device-Id: unknown` fallback, forbidden by the amendment. |
| RW-04 | C | **OPEN** | `engine.ts:187-194` unchanged: lock callback ignores the `ifAvailable` null argument, `lockResult` is always `undefined`, so the fallback `doFlush` always runs a second time outside the lock. |
| RW-05 | C | **OPEN** | `doFlush` still iterates `getAll()` in key order, re-sends `conflict`/`failed` items, `continue`s past backed-off items, `break`s on the first failure. |
| RW-06 | C | **OPEN** | `engine.ts:251-269`: network error (`status 0`) falls to the final `else` and dead-letters the item as `failed`; 408/425 not retried; 403/404 not `conflict`; no timer re-runs the flush. |
| RW-07 | H | **OPEN** | `engine.ts:293-302` uses `getSession().token` (null under Supabase), no tenant/user binding on items, `fetch(item.path)` ignores `BASE`. |
| RW-08 | C | **OPEN, reproduced** | After the engine loads on a fresh profile, `indexedDB.databases()` lists an empty `openpark-offline` v1, and the legacy `pendingCount()` throws `NotFoundError: No objectStore named queue`. Legacy rows are never deleted or marked after migration. |
| RW-09 | H | **PARTIAL** | API side done: `apps/api/src/server.ts:181` registers `/v1/healthz` (P2). Web side open: `fetch('/v1/healthz')` ignores `BASE`, no interval re-probe, initial status is `'online'`, no hysteresis. |
| RW-10 | M | **OPEN** | `ids.ts` untouched (22-char base64url, millisecond "micros"). |
| RW-11 | M | **OPEN** | `ConnectionStatus.tsx` untouched; locale copy unchanged ("Needs attention {count}"). |
| RW-12 | M | **OPEN** | `Queue.tsx:65` `Number(w.deviceAt) / 1000` is still `NaN`; hard-coded `'Conflict'`/`'Failed'`; Discard is labelled `att.done`; `retry()` neither clears `nextAttemptAt` nor flushes and does not refresh counts; no engine subscription. |
| RW-13 | M | **OPEN** | No tests added for engine, classify, migration, ids, ConnectionStatus, ThemeProvider or shared components. |
| RW-14 | M | **OPEN** | The deleted `why` comments in `api.ts` (empty-body note, `write()` doc, `PublicConfig` realtime note, `accessToken` doc) and `app-context.tsx` are still deleted. |
| RW-15 | C | **NOT FIXED (cosmetic)** | Type annotations were stripped, but the file still starts with `import … from '../offline-cache/sw-logic.js'`. A classic SW cannot import, and `../offline-cache` is outside the served root. `register('/sw.js')` still rejects and is swallowed. There is still no service worker. |
| RW-16 | C | **OPEN** | `sw.js:148,152` `cloned.headers.set(...)` on an immutable `Headers` still throws, so every `GET /v1/*` fails once the SW is alive; `/v1/events` is still piped through `handleApiRequest`; no read path on network failure. |
| RW-17 | H | **OPEN** | `vite.config.ts` untouched; no manifest emitted; `contentTypeMatches(res,'document')` rejects every JS/CSS asset; `APP_CACHE_VERSION='v1'` never changes; `generateVersion` still uncalled. |
| RW-18 | H | **OPEN** | `cacheFirst` caches any `res.ok`; `MODELS_MANIFEST` still names `ort-1.18.0-simd.*` with `sha256:'placeholder-models-sha'`, but `dist/ort` contains `ort-1.30.0-simd.*`. `vercel.json` and `nginx.conf` newly added `immutable, max-age=31536000` on `/models/*` and `/ort/*` (non-hashed names), which makes the stale-model problem worse. |
| RW-19 | H | **OPEN** | Models are still downloaded sequentially inside `install`, `skipWaiting()` still runs in `install`, `main.tsx` still has two registration blocks, `console.log` in production, and nothing listens to `op:sw-update`. |
| RW-20 | C | **OPEN** | `app-context.tsx:87` saves under `m.user.id`; `:92,:109,:136,:141` load/clear with the literal `'current-user'`. Offline cold start still redirects to `/login`; sign-out never clears the stored PII. |
| RW-21 | H | **OPEN** | `clearApiCache` still has zero callers; SW side still a no-op. |
| RW-22 | M | **OPEN** | `prefetchModelsIfOnline`, `requestStoragePersistence`, `getReaderState` have no callers; `alpr/offline.ts:23` `const isOnline = checkConnection();` still lacks `await`. |
| RW-23 | M | **OPEN** | See RW-18 for the `immutable` headers; `/manifest.webmanifest` still has no `no-cache`. |
| RW-24 | L | **OPEN** | No SW compile test. |
| RW-26 | C | **FIXED** | `main.tsx` imports `@base-ui/react/direction-provider`; `StatusBadge` maps `neutral → secondary`; `sw-manifest.ts` awaits the digest. tsc and build pass. |
| RW-27 | H | **FIXED** | `ui/input.tsx` is `forwardRef` again and has no diff. |
| RW-28 | H | **OPEN, now verified** | Built CSS (`dist/assets/index-*.css`) contains **0** matches for `.bg-success`, `text-success-foreground`, `bg-info\/10`, `bg-warning`, `--color-success/warning/info`. `grep color-success src/styles.css` returns nothing. The new Button/Badge/Alert variants and `ConnectionStatus` (`Badge variant="success"/"warning"`) render with no background or colour. Contrast of the solid pairs is unchanged: light success 1.81:1, warning 1.81:1, info 1.34:1, dark info 4.07:1 (all fail AA 4.5:1). Token blocks are still duplicated in `tokens.css`, `styles.css :root`, `.dark`, `:root:where(.dark)`. |
| RW-29 | H | **OPEN** | `tokens.css:38` still switches the whole palette on `prefers-color-scheme`, not on `.dark`. |
| RW-30 | H | **OPEN** | `index.html` has no pre-paint script; `ThemeProvider` still sits inside `AppProvider` (which renders `null` until `/v1/me` returns), initial `resolvedTheme` is `'light'`, `toggleTheme` from `'system'` is a no-op and does not persist. |
| RW-31 | H | **OPEN, violates the binding amendment** | `styles.css` still wraps the legacy CSS in `@layer components { … }` (diff shows the whole block re-indented). The amendment says this is REVERTED for iteration 1. Effects listed in RW-31 of round 1 (78 `.btn` buttons turning solid primary, doubled card border and ring, input padding) still apply. |
| RW-32 | M | **OPEN** | `ConfirmDialog` still stores state in a `useRef` and renders no dialog; `ViewState`, `PageHeader`, `alert.tsx` (`[svg]:text-success` is not a valid v4 variant), `button.tsx` (`disabled` while loading, unnamed spinner) unchanged. |

## New findings

### RW-33 · P1 · C · `useSync` snapshot is updated after the listeners run, so the UI is always one update behind, and the tests hide it
- `sync/engine.ts:129-142`: `triggerListeners()` calls every listener first (`:130-132`) and only afterwards assigns the new `this.snapshot` (`:134-141`). `useSyncExternalStore` calls `getSnapshot()` synchronously inside the `onChange` callback, gets the old object, sees no change and does not re-render. The new snapshot is only seen by the next, unrelated notification.
- It also allocates a new object (new `flushNow` closure) on every call, even when nothing changed, so `getSnapshot` is not stable between real changes either.
- Repro (probe test, deleted afterwards): `renderHook(() => useSync())`, then `await engine.enqueue('POST','/v1/x',{a:1})`. Result: `engine.getPending() === 1`, `result.current.pending === 0`, `result.current.status === 'offline'` unchanged. The badge would never show queued changes until some later event fires.
- `test/shell-collapse.test.tsx` now mocks `../src/sync/useSync.js` entirely (`vi.fn(() => ({status:'online',…}))`), so the real hook and engine are never exercised by any test. This is the cover under which RW-02 was "fixed".
- Fix (exact):
  ```ts
  private publish() {
    const next = { status: this.status, pending: this.pending, conflicts: this.conflicts,
                   failed: this.failed, lastSyncedAt: this.lastSyncedAt, flushNow: this.flushNow };
    const prev = this.snapshot;
    if (prev.status === next.status && prev.pending === next.pending && prev.conflicts === next.conflicts
        && prev.failed === next.failed && prev.lastSyncedAt === next.lastSyncedAt) return;
    this.snapshot = next;                      // assign BEFORE notifying
    for (const l of this.listeners) l();
  }
  ```
  Make `flushNow` a bound, stable method (`readonly flushNow = () => void this.runFlush()`), replace the `(status, pending, conflicts, failed)` listener signature with `() => void`, and do not invoke the listener from `subscribe()`. Initial `status` should be `'unknown'` until the first probe, not `'online'`.
- Test to add: real `useSync` + real `engine` (in-memory store): after `enqueue`, `result.current.pending === 1`; `getSnapshot()` returns the same reference across two calls with no change. Keep `shell-collapse` mocking `useSync` only if a second test covers the hook.

### RW-34 · P4 · C · The "plain JS" service worker fix is cosmetic; `node --check` is the wrong gate
- `node --check` passes because the repo is `"type":"module"` (ESM parse). The browser registers `/sw.js` as a classic script. Verified: `new vm.Script(fs.readFileSync('dist/sw.js','utf8'))` → `SyntaxError: Cannot use import statement outside a module`. Result is the same as round 1: no SW installs on a fresh client, offline shell does not exist, and the previous working SW is no longer shipped.
- Fix: implement RW-15 as written (bundle `src/sw.ts` with esbuild/Vite to an IIFE `dist/sw.js`, inject the hashed asset list and a build id, delete `public/sw.js`), and gate it with a test that compiles the built output as a classic script (`vm.Script`) and asserts it contains no `import`/`export` statement. Use `register('/sw.js', { type: 'classic' })` only after that holds.

### RW-35 · P3/P1 · M · `ConnectionStatus` online/offline badges render unstyled because the colour utilities do not exist
- A direct consequence of RW-28, called out because it is the only visible P1 UI. In the built CSS `bg-success`, `bg-warning` and their foregrounds are absent, so the Online badge is a bare dot (colour-only, RW-11) and the Offline badge has neither tint nor contrast. Fix by registering the tokens in `@theme inline` (`--color-success: var(--success); --color-success-foreground: var(--success-foreground);` and the same for warning, info, and `--color-destructive-foreground`), then re-grep the built CSS for each class used in `ui/badge.tsx`, `ui/button.tsx`, `ui/alert.tsx`, `ConnectionStatus.tsx`, `shared/*`.

### RW-36 · P1 · M · Dead code still ships and keeps a dead test green
- `components/SyncBadge.tsx` and `test/sync-badge.test.tsx` remain. The test passes (1 test) and counts toward "149 passing" while exercising a component nothing mounts. `offline-cache/indexeddb.ts` still defines a second device store and `incrementClientSeq` (a competing device id and counter). Delete `SyncBadge.tsx`, port its test to `ConnectionStatus`, and remove the second device store (as RW-03 specified).

## What was checked and found fine
- RW-26 and RW-27 are really fixed: tsc passes, `vite build` passes, `Input` forwards its ref again (call sites `Inventory.tsx:63`, `Bulk.tsx:106`, `People.tsx:146`, `Resident.tsx:202` are safe).
- `DirectionProvider` wrapper is inside `I18nProvider`, so `useI18n().dir` resolves; no runtime error in tests.
- Locale key parity (558 keys in all eight files) and logical-CSS check pass. No new third-party dependency; `@openpark/core: workspace:*` is a workspace link, and `prebuild` ran in the build log.
- `/v1/healthz` exists on the API (`server.ts:181`), so the engine can leave "offline" once the web-side issues in RW-09 are fixed.
- `ConnectionStatus` is mounted once (`Shell.tsx`).

## Required fixes, in order
1. RW-33 (publish ordering and stable snapshot), then RW-01 (route `write()` through `engine.enqueue`, `Attendant.tsx` offline check-out without `amount`), RW-03 (one transaction that allocates `clientSeq`, device id persisted, header omitted when absent), RW-04, RW-05, RW-06, RW-07, RW-08, RW-09 (web side), RW-10.
2. RW-34/RW-15/RW-16/RW-17/RW-18/RW-19 (build the SW through Vite, drop SW API caching, content-type guards, no `immutable` on non-hashed model paths), RW-20/RW-21 (snapshot key, clearing).
3. RW-31 (revert the `@layer components` wrap, per the binding amendment), RW-28/RW-35 (register tokens, AA-passing foregrounds, grep the built CSS), RW-29, RW-30.
4. RW-11, RW-12, RW-13, RW-14, RW-22, RW-23, RW-24, RW-32, RW-36.

VERDICT: NEEDS_CHANGES
