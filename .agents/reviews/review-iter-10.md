# Review iteration 10 — issues only

Evidence scope: independently reviewed the approved plan, iteration-09 findings, iteration-10 commits `fddd34b`/`6b97e76`, the changed forms/routes/tests, and the unchanged replay, onboarding, pass, camera, and authorization callers needed to establish consequences. I relied on the recorded green full gate in `LOOP-SUMMARY.md` and did not rerun it. The worktree is clean, and `adversarial-loop`, the user checkout's `main`, and `origin/main` all resolve to published SHA `6b97e76`; the summary records tick SHA `fddd34b`.

## Medium — cross-cutting security/data integrity: submission keys do not follow deliberate payload changes

**Location:** `apps/web/src/components/hooks.ts:20-28`; `apps/web/src/screens/People.tsx:37-50,230-251`; `apps/web/src/screens/Parking.tsx:30-46,85-96`; `apps/api/src/http.ts:97-103`.

`useSubmitKey` retains one key until success but never binds or rotates it when the user changes the request payload or target after an attempted submission. The server stores the successful first request and hashes method, URL, and body. If that response is lost, then the user edits any field before retrying, the old key and new body reach `defineRoute`, which returns `idempotency_key_reuse`. The form's error path keeps the same key, so every further retry remains stuck until remount. The new UI test retries only an identical body and therefore does not reach this path.

**Consequence:** a normal lost-response-then-edit workflow can make unit/site/zone/slot/person creation impossible in the current form even though the original write committed.

**Correction:** track the request target plus a canonical payload fingerprint with the submission key. Reuse the key only for an exact retry and rotate before sending when the target or payload was deliberately changed. Add a rendered lost-response test that edits the payload and proves the next request uses a fresh key rather than entering a permanent 422 loop.

## Medium — criterion 6 / data integrity: replay can strand a local-auth person without credentials

**Location:** `apps/api/src/services/people.ts:23-37`; `apps/api/src/http.ts:117-119`; `apps/web/src/screens/People.tsx:247-250`; `apps/api/test/api.test.ts:383-395`.

In local-auth mode, `addPerson` creates the account and returns its only temporary password. `replaySafe` deliberately stores that response with `temporaryPassword: null`. If the committed response is lost, a same-key retry returns 201 without the credential, and `People` interprets the falsy password as `users.invited`, although the person is already a member and no invitation exists. A search of `apps/**` found no password-reset/recovery path. The new API test explicitly accepts the missing replay credential and checks only deduplication, so it does not establish a usable onboarding outcome.

**Consequence:** the person exists and consumes the membership, but neither the administrator nor the person has a usable credential; the UI falsely reports an invitation.

**Correction:** never persist or replay the raw one-time password. Replace local new-user creation with a recoverable invitation/password-setup flow, or add an explicit credential-recovery action and return an accurate replay state. Add a lost-response UI/API test proving the new person can complete sign-in.

## Medium — criterion 7 / data integrity: the Super Admin cross-property person write still ignores idempotency

**Location:** `apps/api/src/http.ts:150-169`; `apps/api/src/routes/people.ts:299-319`; `apps/web/src/screens/People.tsx:247`; `apps/web/test/crud-roles.test.tsx:196-213`.

`POST /v1/platform/tenants/:slug/members` still uses `definePlatformRoute`, which has no idempotency plumbing. `People` supplies a key, but the endpoint ignores it. The `busy` guard blocks only concurrent clicks; after a committed response is lost, a retry calls `addPerson` again and reaches `already_member`, with the same lost temporary-password outcome for a new local user. The rendered Super Admin test mocks `post` and only verifies that a key argument was passed; it never executes the server route.

**Consequence:** cross-property person creation can report failure after success and strand the new account, so a required Super Admin write remains non-replay-safe.

**Correction:** add tenant-scoped replay handling to the platform member route, including target URL/body hashing, and use the recoverable onboarding response above. Execute a same-key lost-response retry against the real endpoint and assert one account, membership, and audit plus a usable onboarding outcome.

## Medium — criterion 1: the real generated/share/public-route/gate chain remains unexecuted

**Location:** `apps/web/test/pass-e2e.test.tsx:29-54,109-161`; `apps/web/src/App.tsx:64`; `apps/web/src/app-context.tsx:99-122`.

No iteration-10 evidence closes the prior finding. `pass-e2e` still begins with a fabricated `TOKEN`, mounts `GuestPass` directly, and mocks lookup/redeem. It does not execute resident generation/share, the real unauthenticated `/pass` bootstrap through `AppProvider`, or server HMAC, verify-code, version, and expiry validation for the rendered artifact. Separate green server and rendered tests do not join those stages.

**Consequence:** the supplied execution evidence does not establish that the artifact a resident actually sends survives the real public route and is accepted by the gate as that same live two-hour pass.

**Correction/verification:** issue a live pass through the API, invoke the real resident Share control, open its fragment URL through `/pass` at a mobile viewport, decode the rendered QR, and perform real lookup/redeem. Assert exact token identity, two-hour expiry, and HMAC plus verify-code tamper rejection.

## Medium — criteria 3 and 4: the shipped camera acquisition/model path remains unexecuted

**Location:** `apps/web/test/attendant-camera.test.tsx:11-24,55-110`; `e2e/live-plate.mjs:1-21`.

No iteration-10 evidence closes the prior finding. The rendered tests replace `LiveCamera` with a button that emits an already-decoded plate. They do not execute `getUserMedia`, the shipped ONNX/model loader and decoder, a camera fixture, or a responsive browser. The existing fake-camera browser story still has no recorded run and covers check-in only.

**Consequence:** actual camera acquisition and plate decoding remain unverified for both check-in and check-out.

**Correction/verification:** run and record the 390×844 fake-camera check-in story with the real model and `.y4m` fixture; add and run the equivalent checkout story. Assert the visible plate, `/v1/checkout/match` request/result, browser/model/fixture versions, and a clean console.

## Medium — criteria 6 and 7: complete entity CRUD and cross-property operations remain unexecuted

**Location:** `apps/web/test/crud-roles.test.tsx:82-213`; `apps/web/src/screens/People.tsx:225-315`; `apps/web/src/screens/Parking.tsx:34-250`.

The expanded rendered test completes create/edit/delete only for a unit. It creates but does not edit/delete a person; creates site/zone/slot but does not edit or retire site/zone, does not edit a slot, and deletes only an existing mocked slot. Its Super Admin case performs only a mocked person POST in the second property, not operations across the required entities. Setting `window.innerWidth` in jsdom does not execute layout and therefore does not verify mobile usability.

**Consequence:** complete person/building/slot CRUD, Super Admin operations across buildings, and mobile behavior remain unverified in context.

**Correction/verification:** drive create/read/edit/delete or retire for person, site, unit, and slot through the real routed screens and real API at a narrow browser viewport. Switch a Super Admin to a second property and perform representative unit/site/slot/person writes there, asserting persisted results and regular-admin cross-property denial.

## Low — accessibility: manual assistive-technology and visual verification remains outstanding

**Location:** Resident Share/GuestPass, Attendant pass/camera flows, policy editor, Parking/People/Units, and platform property switching.

No evidence covers keyboard-only traversal, VoiceOver/Safari, 200%/400% zoom, 320px reflow, light/dark contrast, or physical touch targets. Static semantics and automated tests cannot establish full WCAG conformance.

**Verification:** perform and record those manual checks with browser/AT versions and correct any failures.
