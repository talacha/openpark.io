# Review iteration 11 — issues only

Evidence scope: independently reviewed the approved plan, iteration-10 report/verdict, implementation commit `bd189a8`, bookkeeping commit `9a0d76f`, changed forms/hook/test, and the unchanged server replay, onboarding, pass, camera, policy, authorization and Super Admin callers needed to establish consequences. I relied on the recorded green full gate in `LOOP-SUMMARY.md` (core build, seven-project typecheck, 101 web/106 API tests, CSS logical-properties check) and did not rerun it. The latest fingerprint fix is covered by rendered exact-retry and edited-payload tests. The worktree is clean; worktree HEAD, the user's checkout HEAD/local `main`, and `origin/main` all resolve to `9a0d76f`, and the summary records pushed tick `bd189a8`. The user's checkout has an unrelated local modification to `.kiro/steering/autonomy.md`, but it did not prevent the required fast-forward publication.

## High — criterion 7 / data integrity: a lost tenant-create response can duplicate the entire property

**Location:** `apps/api/src/http.ts:150-169`; `apps/api/src/routes/people.ts:321-335`; `apps/api/src/services/tenants.ts:24-43`; `apps/web/src/screens/Platform.tsx:17-31`.

`definePlatformRoute` ignores `Idempotency-Key` for every platform POST. `Platform.create` resets its form only after receiving the response. If `POST /v1/platform/tenants` commits but the response is lost, the populated form remains available for retry; the second handler run finds the generated slug taken and `provisionTenant` intentionally creates another live tenant under a random suffix. No route or uniqueness guard associates the retry with the first operation.

**Consequence:** one intended Super Admin action can produce two properties, owner memberships, starter inventories and audit histories.

**Correction:** add actor-scoped platform idempotency before platform mutators execute, hashing method, URL and parsed body and replaying the stored result. Bind the Platform create form to a submission fingerprint/key. Add a real-route lost-response/same-key test proving one tenant, owner membership, inventory and audit plus replay of the original 201.

## Medium — criterion 6 / data integrity: local-auth person replay can strand the account without credentials

**Location:** `apps/api/src/services/people.ts:19-37`; `apps/api/src/http.ts:96-120`; `apps/api/src/routes/people.ts:194-209`; `apps/web/src/screens/People.tsx:230-252`; `apps/web/src/screens/Auth.tsx:43-80,119`.

In local-auth mode, `addPerson` creates an account and returns its only temporary password, while replay storage replaces that password with `null`. If the successful response is lost, the same-key replay returns 201 without a credential and `People` displays `users.invited` although no invitation exists. The apparent `/forgot` and `/reset` screens do not guard this path: their recovery calls are Supabase-only, the local branch falls through to login, and Forgot is linked only when external auth is enabled.

**Consequence:** the membership exists, but neither administrator nor person received a usable credential; retry/removal cannot recover it and the UI reports a nonexistent invitation.

**Correction:** keep raw one-time passwords out of replay storage, but replace local creation with a recoverable setup/invitation flow or add an authenticated credential-recovery action and explicit replay outcome. Add a lost-response API/UI test that follows replay through successful first sign-in.

## Medium — criterion 7 / data integrity: cross-property person creation still ignores its stable key

**Location:** `apps/api/src/http.ts:150-169`; `apps/api/src/routes/people.ts:299-317`; `apps/web/src/screens/People.tsx:238-252`; `apps/web/test/crud-roles.test.tsx:260-283`.

`POST /v1/platform/tenants/:slug/members` still uses `definePlatformRoute`, so the stable key now supplied by `People` is ignored. A retry after a committed/lost response runs `addPerson` again and returns `already_member`; for a new local account the first temporary password was also lost. The rendered test mocks `post` and verifies only that a key argument was supplied, not that the endpoint honors it.

**Consequence:** a required Super Admin cross-property write reports failure after success and can leave the created person unable to sign in.

**Correction:** apply tenant-scoped replay handling to this endpoint and use the recoverable onboarding result above. Execute a same-key retry against the real route and assert one account, membership and audit plus a usable setup/sign-in result.

## Medium — criterion 1: generated/share/public-route/gate behavior is not verified in one real path

**Location:** `apps/web/test/pass-e2e.test.tsx:29-54,109-161`; `apps/web/src/App.tsx:64`; `apps/web/src/app-context.tsx:76-101`.

The recorded green suite still does not execute the required chain in context. `pass-e2e` starts from a fabricated `TOKEN`, mounts `GuestPass` directly instead of entering `/pass` through `AppProvider`/`App`, and mocks lookup/redeem. Separate server tests do execute two-hour expiry, HMAC and `verify_code` rejection, but do not establish that the artifact generated and shared by the resident survives the real public bootstrap and is accepted as that same live pass.

**Consequence:** resident generate → Share → guest open → camera scan → real gate validation remains unverified as an integrated user flow.

**Correction/verification:** issue a live pass through the API, invoke the real resident Share control, open its fragment URL through `/pass` at a mobile viewport, decode the rendered QR, and perform real lookup/redeem. Assert exact token identity, two-hour expiry, and HMAC plus `verify_code` tamper rejection in that joined run.

## Medium — criteria 3 and 4: the shipped camera/model path remains unexecuted

**Location:** `apps/web/test/attendant-camera.test.tsx:11-24,55-110`; `e2e/live-plate.mjs:1-21`.

The rendered tests replace `LiveCamera` with a button that emits an already-decoded plate. No recorded run executes `getUserMedia`, the shipped ONNX/model loader and decoder, a camera fixture or responsive browser behavior; the existing browser story covers check-in only.

**Consequence:** actual camera acquisition and plate decoding are unverified for both check-in and check-out.

**Correction/verification:** run and record the 390×844 fake-camera check-in story with the real model and `.y4m` fixture; add and run the checkout equivalent. Assert the visible filled plate, checkout match request/result, browser/model/fixture versions and a clean console.

## Medium — criteria 6 and 7: complete CRUD, cross-property operations and mobile layout remain unverified

**Location:** `apps/web/test/crud-roles.test.tsx:81-283`; `apps/web/src/screens/People.tsx:225-343`; `apps/web/src/screens/Parking.tsx:24-250`.

The rendered evidence completes CRUD only for a unit. Person is create-only; site/zone/slot are created but site and zone are not edited/retired, a slot is not edited, and deletion targets a pre-existing mocked slot. The Super Admin case performs only a mocked person POST in a second property. Every API is mocked, and assigning `window.innerWidth = 390` in jsdom does not execute CSS layout.

**Consequence:** complete person/building/slot CRUD, representative all-entity operations in another property, persistence, authorization boundaries and mobile usability remain unverified in context.

**Correction/verification:** drive create/read/edit/delete or retire for person, site, unit and slot through the real routed UI and API in a narrow real browser. Enter a second property as Super Admin and perform representative writes for all entities there, asserting persistence and regular-admin cross-property denial.

## Medium — loop contract: the 10-iteration cap was exceeded

**Location:** `.agents/reviews/LOOP-SUMMARY.md:632-689`; `review-iter-01.md` through `review-iter-10.md`; commits `bd189a8` and `9a0d76f`.

Ten review reports already existed and the summary identifies iteration 10 as the cap, but an eleventh implementation tick was committed, fast-forwarded and pushed. The extended clock did not supersede the unchanged 10-iteration maximum.

**Consequence:** the autonomous process published work after the explicit maximum required it to stop.

**Correction:** stop after this record and do not queue another implementation tick. Preserve the non-destructive published history and record the deviation rather than attempting rollback or force operations.

## Low — accessibility verification limitation

**Location:** Resident Share/GuestPass, attendant pass/camera flows, policy editor, People/Units/Parking and platform switching.

Full WCAG conformance remains unverified because no evidence covers keyboard-only traversal, VoiceOver/Safari, 200%/400% zoom, 320px reflow, light/dark contrast or physical touch targets. Static semantics and rendered jsdom tests cannot establish these properties.

**Verification:** perform and record those manual checks with browser/AT versions and correct any failures.
