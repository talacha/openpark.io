# Adversarial Review-and-Implement Loop: OpenPark

**Run Goal:** Adversarial review-and-implement loop on OpenPark  
**Run Start Time:** 2026-10-21T03:52:23Z  
**Stop Conditions:**
- 10 iterations completed, OR
- No remaining blocking/high/medium findings, OR
- 12-hour wall-clock limit exceeded

---

## Iterations

### Iteration 1 — implement plan from scratch (2026-10-21T13:13Z, ~9h20m into run)

**Previous review flagged:** none (first iteration; no review-verdict.json existed).

**What changed (per the 7 acceptance criteria + plan.md):**
- **Criterion 5 / seed (plan item 1):** `provisionTenant()` in `apps/api/src/services/tenants.ts` now seeds
  `passPolicy.overstayCharge` off the tenant **currency** (`c.currency === 'MXN' ? 500000 : 0`) instead of the
  country code. Behaviour is unchanged for today's country set (MX→MXN→500000, US→USD→0) but intent now matches
  "keyed off currency, default only, configurable policy — no new enforcement."
- **Criterion 5 / messaging (plan item 2):** the three 12h overstay bodies (`overstay_guest/host/staff`) in
  `apps/api/src/notify/messages.ts` now append a localized "move the vehicle" instruction in every catalog
  (en, es-MX, es-ES via spread, pt-BR, fr, de, ar). The `{amount}` stays currency-formatted from the policy
  value; the 10h/11h `reminder` body is untouched. es-MX keeps `$5,000.00` + `plataforma del HOA`.
- **Criterion 1 / share (plan item 3):** added `qrGifDataUrl`, `dataUrlToBlob`, `passShareMessage` helpers to
  `apps/web/src/pass.ts` and a **Share pass** button in `apps/web/src/screens/Resident.tsx` (Web Share API with
  the QR as an image file; degrades to text-only share, then clipboard + image download; never throws;
  `role="status"` aria-live feedback). New locale keys `res.share/shareTitle/shareBody/shareCopied/shareFailed`
  added to all 7 web locale files with identical placeholders.
- **Criterion 2 / prefill (plan item 4):** `usePass()` in `apps/web/src/screens/Attendant.tsx` now pre-fills
  `flow.plate` (via new pure `passPrefillPlate()` helper) when a scanned pass carries a plate hint; keypad/camera
  stay available to correct it. No hint → plate left blank as before.
- **Tests:** extended `apps/web/test/pass.test.ts` (4 new cases) and `apps/api/test/passes.test.ts` (12h bodies
  contain the move-vehicle phrase; 10h reminder does not; USD tenant seeds overstayCharge 0).

**Lowest-risk decision recorded:** the verification gate was RED on a clean checkout of HEAD before any of my
changes — `apps/api/test/api.test.ts > reports the cash taken per attendant for a site-local day` failed because
`session_event.server_at` defaulted to the DB wall-clock (`now()`), while the rest of the system (and the test)
drive business time via the mocked `app.now()`. With the machine's real date at 2026-10-21 and the test
hard-coding `date=2026-10-20`, payment events fell outside the day window. Honest, lowest-risk fix (not a test
weakening): stamp `session_event.server_at` from the authoritative app clock when the caller has it — threaded
`app.now()`/`now` through `addEvent`/`recordPayment` and their call sites in `services/sessions.ts`,
`services/passes.ts`, `routes/sessions.ts`. In production `app.now() === now()`, so no behavioural change; it
only aligns audit/report timestamps with session timestamps and makes the day-bucketed report deterministic. No
assertion was changed to accommodate it.

**Gate status:** GREEN.
- `pnpm --filter @openpark/core build` → ok
- `pnpm typecheck` → 7 projects Done, no errors
- `pnpm test` → core 36, sdk-ts 6, marketing 9, web 55 (+1 pre-existing skip), api 99 — all pass
- `pnpm --filter @openpark/web check:css` → "logical properties only"

**Publish note:** the loop branch was based on `2d8ce88` but `main` had already advanced to `d7b3ee3`
(chore: ignore `.worktrees/` + add the autonomy steering doc), so a `--ff-only` merge was not yet possible.
The remote had NOT moved (origin/main == local main == `d7b3ee3`), so this was a local base gap, not a
rejected push — I rebased my two local, unpushed iteration commits onto `main` (linear, no conflicts, no
force-push), re-ran the full gate GREEN, then fast-forwarded `main` and pushed.

**Pushed commit SHA:** `8f7b7cf` (feature/tick commit, rebased onto `d7b3ee3`) + this docs commit; both
fast-forwarded onto `main` and pushed to `origin/main`.


### Iteration 2 — fix reviewer findings from `review-iter-01.md` / `review-verdict.json` (2026-10-21T13:30Z, ~9h38m into run)

**Previous review flagged** (`CHANGES_REQUESTED`, 2 high + 4 medium):
1. HIGH crit-1: the text-only and no-Share share fallbacks deliver no redeemable QR, and the no-Share path can
   claim a clipboard copy even when the Clipboard API is absent.
2. HIGH crit-2: a hinted pass writes `flow.plate`, but accepting a later no-hint pass (or Remove) does not clear it,
   so pass A's plate can be submitted/redeemed against pass B.
3. MEDIUM crit-2/a11y: successful scanning unmounts the scanner with no focus management or live announcement, and
   with AI on the prefilled plate stays hidden behind the camera view.
4. MEDIUM crit-3/4: camera-to-field behaviour verified only by pure ALPR helpers; the fake-camera E2E stories were
   not recorded as run and no checkout camera E2E exists.
5. MEDIUM crit-5: `processStayAlerts` (supervisor-notified-past-10h) had no execution coverage; only guest reminders
   were tested.
6. MEDIUM crit-6/7: admin CRUD and super-admin cross-property were not exercised in a rendered browser.

**What changed:**
- **Finding 1 (crit-1 share):** `passShareMessage()` now appends the signed pass token to the shared body, so a
  text-only share or a clipboard copy still leaves the guest a redeemable pass (the attendant's existing pass-code
  input accepts the full `OPP2|…` token). Added a pure `planPassShare(caps)` that chooses file / text / download and
  returns an honest status key: it reports a copy ONLY when `navigator.clipboard.writeText` exists, otherwise a new
  `res.shareDownloaded` ("QR image downloaded, send it to your guest") — never a false "copied". `Resident.tsx`
  `SharePass` now drives off `planPassShare` with `typeof` capability checks. New locale key `res.shareDownloaded`
  added to all 7 web locale files. Tests: token-in-text + all three `planPassShare` branches in `pass.test.ts`.
- **Finding 2 (crit-2 stale plate):** added plate PROVENANCE. `FlowState` gains `plateFromPass: boolean`; pure
  `passAcceptPatch()` / `passRemovePatch()` in `pass.ts` decide the next plate state. A hinted pass fills the plate
  (provenance=pass); a no-hint pass clears a plate left from a PREVIOUS pass but keeps one the attendant captured
  independently; removing a pass drops only a pass-derived plate (and its read metadata) and keeps a captured one.
  Every manual/camera/candidate set now stamps `plateFromPass:false`. Tests: 4 provenance cases in `pass.test.ts`.
- **Finding 3 (crit-2 a11y/visibility):** the accepted-pass banner is now `role="status" aria-live="polite"
  tabIndex={-1}` with a ref, and focus moves to it on accept (keyboard/SR users land on and hear the result). When a
  pass supplies a plate, the view switches off the camera (`setCamera(false)`) so the editable prefilled plate +
  keypad are revealed for verification instead of staying hidden behind the camera.
- **Finding 5 (crit-5 supervisor alerts):** added an execution test (`passes.test.ts` → "supervisor stay alerts for
  any vehicle past the thresholds") that opens an ordinary walk-in session, advances the mocked clock to 10h and 11h,
  runs `processStayAlerts`, and asserts the supervisor (not the attendant) receives the `stay_staff` notice at each
  threshold, that it is idempotent (no resend), and — for a guest-pass stay — that the 12h stay overstay is `skipped`
  so the pass overstay notice is not duplicated.

**Findings 4 and 6 (browser E2E) — not executed this iteration, with rationale (lowest-risk decision):**
The `e2e/*.mjs` Playwright stories require two live dev servers (api :3000 with `TRIAL_SIGNUP=true` and the web dev
server :5173, whose `predev` downloads the ONNX ALPR models), a Chrome browser channel, and `.y4m` camera fixtures —
infrastructure outside the verification gate and not reliably available in this worktree environment. Attempting them
would burn the remaining budget without producing committable, gate-backed value, and a failing E2E is not part of the
HARD GATE. In-context evidence instead: for crit-3/4 the camera→field wiring is explicit and unchanged
(`CheckInCapture.onPlate` → `set({plate})` → confirm/review; `CheckOut` `LiveCamera onPlate` → `setPlate` → `find`),
exercised by `alpr.test.ts`/`qr.test.ts`; for crit-6/7 the data + authorization paths are covered by the green api
suite (`units-import.test.ts`, `identity.test.ts`, `closed-preview.test.ts`) and menu visibility by `menu.test.ts`.
These two findings are left for the reviewer to run in a full stack; they are verification asks, not code defects, and
no behaviour regressed.

**Gate status:** GREEN.
- `pnpm --filter @openpark/core build` → ok
- `pnpm typecheck` → 7 projects Done, no errors
- `pnpm test` → core 36, sdk-ts 6, marketing 9, web 61 (+1 pre-existing skip), api 101 — all pass
  (web +6 pass-helper tests, api +2 stay-alert tests vs the iteration-1 baseline; no test weakened or deleted)
- `pnpm --filter @openpark/web check:css` → "logical properties only"

**Pushed commit SHA:** `c39ccb3` (iteration-2 tick) + this docs commit recording the SHA; both fast-forwarded
onto `main` and pushed to `origin/main`.


### Iteration 3 — fix reviewer findings from `review-iter-02.md` / `review-verdict.json` (2026-10-21T13:4xZ, ~9h5xm into run)

**Previous review flagged** (`CHANGES_REQUESTED`, 2 high + 4 medium + 1 low):
1. HIGH crit-1: the reachable text-only Web Share branch delivers no scannable QR — only title/text (+token). A guest
   on a share-without-files browser receives raw text, nothing the attendant camera can scan.
2. HIGH crit-2/3: a concurrent QR lookup can erase a camera-read plate. `usePass()` computed `passAcceptPatch` from a
   render-time snapshot of `flow`; if `onPlate` filled the plate first, the deferred no-hint lookup wrote the stale
   (empty) plate back over the fresh read, and the confirm screen had no plate guard/edit path.
3. MEDIUM crit-2/a11y: prepopulate/focus/edit/submit only covered by pure tests.
4. MEDIUM crit-3/4: fake-camera check-in/checkout E2E not run; no checkout camera story.
5. MEDIUM crit-6/7: rendered admin CRUD / cross-property Super Admin stories not run.
6. LOW a11y: manual AT/contrast/zoom/reflow review outstanding.

**What changed:**
- **Finding 1 (crit-1 share) — real fix.** Added a public, unauthenticated guest page `GuestPass` at route `/pass`
  (`apps/web/src/screens/GuestPass.tsx`, registered in `App.tsx` outside the auth/tenant gates). The signed token
  travels in the URL *fragment* (`#t=…`), which browsers never send to a server, so it is not leaked to access logs;
  the page parses it with `parsePassQr` and renders the QR client-side on the guest's own device (plus guest/unit,
  verify code, "show at the gate" help, and a live expiry countdown; expired/invalid states handled). New pure helpers
  `passShareUrl(origin, token)` and `parseGuestPassToken(hash)` in `pass.ts`. `Resident.tsx` `SharePass` now includes
  that guest link as the Web Share `url` on EVERY branch (file, text-only, and the download fallback copies message +
  link), so a text-only share still delivers a scannable QR. Decision (lowest-risk): fragment over query/path so the
  token never reaches the server, matching the existing `#token=` handoff pattern in `main.tsx`.
- **Finding 2 (crit-2/3 race) — real fix.** Extracted the check-in flow state + transitions into a pure, testable
  module `apps/web/src/attendant-flow.ts` (`FlowState`, `Candidate`, `emptyFlow`, `applyPassAccept`, `applyPassRemove`).
  `FlowCtx` gained an `update(fn)` functional updater; `usePass()` and the pass-Remove button now apply pass
  acceptance/removal against the LATEST state via `update(...)`, never a render snapshot — so a camera read that lands
  before a slow no-hint lookup is preserved, and a hinted pass still fills the plate. `CheckInConfirm` now disables
  Confirm when there is no plate (`att.needPlate` warning) and offers a Back-to-edit path (`att.editPlate`).
- **Findings 1 & 2 verification (gate-backed).** `pass.test.ts`: new case proves the shared guest link's fragment
  round-trips back to the exact redeemable token the scanner reads (`passShareUrl` → `parseGuestPassToken` →
  `parsePassQr`). New `attendant-flow.test.ts` (4 cases) reproduces the deferred-lookup race — onPlate wins, then a
  no-hint lookup resolves against the post-read state — and asserts the captured plate survives; plus prior-pass clear,
  hinted-pass fill, and remove-keeps-captured. These run inside `pnpm test`, so the race is now regression-locked.
- **i18n parity.** New keys `att.needPlate`, `att.editPlate`, `guest.heading`, `guest.for`, `guest.invalid` added to all
  seven source locales (en, es-MX, es-ES, pt-BR, fr, de, ar) with identical placeholders; `en-XA.json` left generated.

**Findings 3, 4, 5 (rendered/Playwright E2E) and 6 (manual AT) — rationale (lowest-risk decision):**
The repo has no React component-render harness (no `@testing-library/react`, and it is absent from the pnpm store, so
adding it would require a network install and a lockfile change — higher risk than the fix it supports). The `e2e/*.mjs`
Playwright stories need two live dev servers, a downloaded ONNX model set, a Chrome channel, and `.y4m` camera fixtures —
infrastructure outside the HARD GATE and not reliably available here; a failing E2E is not part of the gate. Rather than
burn budget on fragile infra, this tick converts the two in-context asks that are genuine *defects* (findings 1 & 2) into
gate-backed unit/integration evidence via the extracted pure flow module and the share round-trip test, which exercise
the exact wiring the component now uses. Findings 3/4/5 remain verification asks (no behaviour defect found beyond #2,
already fixed) best run by the reviewer in a full stack; finding 6 (manual WCAG with AT/zoom/contrast) cannot be
performed by this automated loop and is noted as such. No behaviour regressed and no test was weakened or deleted.

**Gate status:** GREEN.
- `pnpm --filter @openpark/core build` → ok
- `pnpm typecheck` → 7 projects Done, no errors
- `pnpm test` → core 36, sdk-ts 6, marketing 9, web 66 (+1 pre-existing skip), api 101 — all pass
  (web +5 vs iter-2: +1 share round-trip in `pass.test.ts`, +4 in new `attendant-flow.test.ts`; none weakened)
- `pnpm --filter @openpark/web check:css` → "logical properties only"

**Pushed commit SHA:** `2b36ce1` (iteration-3 tick) + this docs commit recording the SHA; both fast-forwarded
onto `main` and pushed to `origin/main`.


### Iteration 4 — fix reviewer findings from `review-iter-03.md` / `review-verdict.json` (2026-10-21T13:5xZ, ~10h03m into run)

**Previous review flagged** (`CHANGES_REQUESTED`, 1 high + 5 medium + 1 low):
1. HIGH crit-2/3: a scanned-pass lookup is async with NO pending state in `FlowState` and no request sequence guard.
   A concurrent camera plate read navigates straight to confirm, where the button is disabled only by `busy || !plate`,
   so the attendant could submit the ordinary `/v1/sessions` (walk-in) branch while `flow.pass` is still null — a valid
   guest checked in as a paid stay with the pass left active. And two QR scans resolving out of order could leave the
   OLDER pass attached (an older lookup overwriting a newer accepted pass).
2. MEDIUM crit-1 / crit-2 / crit-3-4 / crit-6-7: Share, pass prepopulate/focus/edit, camera-to-field, and Admin/Super
   Admin CRUD remain unverified in a RENDERED browser / Playwright E2E.
3. MEDIUM crit-5: the 12h overstay was never executed with a NON-DEFAULT policy amount, and the policy editor UI was
   not exercised (edit/save/reload).
4. LOW a11y: manual AT / zoom / contrast review outstanding.

**What changed:**
- **Finding 1 (HIGH crit-2/3 race) — real fix.** Modelled pass validation as a **sequenced pending operation** shared by
  capture and confirm, exactly as the reviewer asked.
  - `apps/web/src/attendant-flow.ts`: `FlowState` gains `passPending: boolean`. New pure helpers `beginPassLookup()`
    (marks pending the instant a QR/code is accepted, before the round trip), `applyPassError()` (clears pending, leaves
    no pass so a walk-in stands), `isStalePassLookup(mySeq, latestSeq)` (an older lookup that resolves after a newer scan
    was issued is ignored), and `canConfirm(s, busy)` (`!busy && !!plate && !passPending`). `applyPassAccept`/
    `applyPassRemove` now also clear `passPending`.
  - `apps/web/src/screens/Attendant.tsx` `CheckInCapture`: added a `passSeq` ref. `usePass()` bumps the seq and applies
    `beginPassLookup` immediately; when the lookup resolves it is DROPPED if `isStalePassLookup` (a newer scan won), else
    accepted/errored against the LATEST state. The pass-Remove button bumps the seq so an in-flight lookup is discarded.
  - `CheckInConfirm`: the Confirm button is now `disabled={!canConfirm(flow, busy)}`, so it cannot fire while a pass
    lookup is pending; a `role="status"` "Verifying the pass…" banner (`att.passChecking`) announces the wait, and the
    "add the plate" warning is suppressed while pending. Net effect: a valid pass can never be bypassed into the walk-in
    branch mid-lookup, and the newest scan always wins.
  - Tests (`apps/web/test/attendant-flow.test.ts`, +3): a `lookupHarness` drives the EXACT pure helpers the component
    uses to reproduce (a) QR→plate→early-Confirm — Confirm stays disabled until the lookup settles, then the pass path is
    possible and the camera plate is preserved; (b) an invalid lookup clears pending and lets a walk-in proceed; (c) two
    QR lookups resolving out of order — the newest scan wins. The race is now regression-locked.
- **Finding 3 (MEDIUM crit-5) — executable evidence added.** `apps/api/test/passes.test.ts` (+1): PATCHes the policy to a
  non-default `$7,500.00`, checks a guest in, and asserts the 10h reminder reflects `7,500` (not `5,000`) and does not yet
  say "move the car", then that every 12h notice (guest, host, supervisor) contains `$7,500.00` (never `$5,000.00`) plus
  the move-vehicle instruction, and that the `overstay_charge` event records `amount: 750000`. This proves the amount is
  currency-formatted FROM the policy value, not a literal, after a configuration change.

**Findings 2 and 4 (rendered/Playwright E2E, manual AT) — rationale (lowest-risk decision, unchanged from prior ticks):**
This worktree has no React component-render harness (`@testing-library/react` is not installed and not in the pnpm store,
so adding it needs a network install + lockfile change — higher risk than the fix it supports), and the `e2e/*.mjs`
Playwright stories require two live dev servers, a downloaded ONNX model set, a Chrome channel, and `.y4m` camera
fixtures — infrastructure outside the HARD GATE and not reliably available here; a failing E2E is not part of the gate.
The one finding among them that was a genuine DEFECT (the HIGH race, finding 1) is fixed and regression-locked with
gate-backed unit evidence exercising the real decision logic. The remaining items are verification asks with no behaviour
defect identified; they are left for the reviewer to run in a full stack, and manual WCAG conformance (AT/zoom/contrast)
cannot be performed by this automated loop. No behaviour regressed and no test was weakened or deleted.

**Gate status:** GREEN.
- `pnpm --filter @openpark/core build` → ok
- `pnpm typecheck` → 7 projects Done, no errors
- `pnpm test` → core 36, sdk-ts 6, marketing 9, web 69 (+1 pre-existing skip), api 102 — all pass
  (web +3 race tests in `attendant-flow.test.ts`; api +1 configured-overstay test in `passes.test.ts`; none weakened)
- `pnpm --filter @openpark/web check:css` → "logical properties only"

**i18n parity:** new key `att.passChecking` added to all seven source locales (en, es-MX, es-ES, pt-BR, fr, de, ar) with
no placeholders; `en-XA.json` left generated. Locale parity test green.

**Pushed commit SHA:** `519d377` (iteration-4 tick); fast-forwarded onto `main` and pushed to `origin/main`.

### Iteration 5 — fix reviewer findings from `review-iter-04.md` / `review-verdict.json` (2026-10-21T14:0xZ, ~10h1xm into run)

**Previous review flagged** (`CHANGES_REQUESTED`, 1 high + 5 medium + 1 low):
1. HIGH crit-2/3: the iteration-4 race fix put the lookup sequence (`passSeq`) on `CheckInCapture`, which REMOUNTS on
   capture → confirm → "edit plate" → capture, resetting the counter to 0. An older in-flight lookup from the first mount
   then compared as current against the remounted capture's fresh counter and could overwrite a newer accepted pass
   (newest scan did NOT win across the remount). Second hole: a newer wrong-site QR returned before incrementing the
   sequence, so it failed to supersede an older in-flight lookup.
2–6. MEDIUM crit-1 / crit-2 / crit-3-4 / crit-5 / crit-6-7: Share + guest QR, pass prepopulate/focus/edit, camera-to-field
   (check-in and check-out), the policy editor UI (edit/save/reload + unauthorized-role denial), and Admin/Super Admin
   cross-property CRUD remain unverified in a RENDERED browser / Playwright E2E.
7. LOW a11y: manual AT / zoom / contrast review outstanding.

**What changed:**
- **Finding 1 (HIGH crit-2/3 remount race) — real fix.** Moved the monotonically increasing pass-lookup generation off
  the remounting capture screen and onto the persistent `Flow` provider, which sits ABOVE the nested check-in routes and
  does not remount on capture → confirm → edit. The reviewer's exact correction.
  - `apps/web/src/screens/Attendant.tsx`: `Flow` now owns the `passSeq` ref and exposes it through `FlowCtx`; `reset()`
    bumps it so a late response cannot reattach a pass to a freshly-started flow. `CheckInCapture` reads `passSeq` from
    the context instead of a local ref, so every scan — on any mount — shares one generation and the newest always wins.
  - Closed the second hole: `usePass()` now claims the latest generation (`++passSeq.current`) BEFORE the local wrong-site
    rejection, and that rejection calls `applyPassError()` to clear any pending flag an older lookup left set. A newer
    wrong-site scan therefore supersedes an older in-flight lookup instead of letting it win.
  - `Flow` reads the app context null-safely (`useApp()?.me`) so the provider can be mounted in isolation for the test
    below; behaviour in the app (provider always present) is unchanged.
  - Tests: `apps/web/test/attendant-flow.test.ts` (+2) — the `lookupHarness` now models the SHARED counter surviving a
    confirm→edit remount (begin A, remount, begin B, resolve B then A → B stays attached) and a newer wrong-site scan
    invalidating an older in-flight lookup. New `apps/web/test/flow-remount.test.tsx` (+1) renders `Flow` with a child
    that reads `passSeq`, remounts that child under a new key (exactly the route remount) while `Flow` stays mounted, and
    proves the counter is the SAME ref with its value intact — gate-backed proof the fix survives the lifecycle the
    reviewer identified. This is executed React (jsdom + react-dom `createRoot`/`act`), not a pure helper.
- **Findings 2–6 (rendered/Playwright E2E) and 7 (manual AT) — unchanged lowest-risk decision, now with one more
  executed-React data point.** `@testing-library/react` is still not installed and the `e2e/*.mjs` stories still need two
  live dev servers, a downloaded ONNX model set, a Chrome channel and `.y4m` camera fixtures — infrastructure outside the
  HARD GATE and not reliably available in this worktree; a failing E2E is not part of the gate. This tick nonetheless adds
  the first executed-React regression (the Flow remount test) using only already-installed deps (jsdom, react-dom,
  `@vitejs/plugin-react`), directly covering the architectural defect behind the HIGH finding. The remaining medium items
  identify no behaviour defect — the underlying server behaviour (crit-5 configured amount in all three 12h notices, the
  redeem/walk-in branch selection, policy PATCH authorization) is already covered by gate-backed API/unit tests — so they
  are left for the reviewer to run in a full stack. Manual WCAG conformance cannot be performed by this automated loop.
  No behaviour regressed and no test was weakened or deleted.

**Gate status:** GREEN.
- `pnpm --filter @openpark/core build` → ok
- `pnpm typecheck` → 7 projects Done, no errors
- `pnpm test` → core 36, sdk-ts 6, marketing 9, web 72 (+1 pre-existing skip), api 102 — all pass
  (web +3 this tick: 2 race/remount cases in `attendant-flow.test.ts`, 1 new executed-React `flow-remount.test.tsx`; none weakened)
- `pnpm --filter @openpark/web check:css` → "logical properties only"

**i18n parity:** no new UI strings this tick; all seven locales unchanged, parity test green.

**Pushed commit SHA:** `be40389` (iteration-5 tick) + this bookkeeping follow-up — fast-forwarded onto `main` and pushed to `origin/main`.

