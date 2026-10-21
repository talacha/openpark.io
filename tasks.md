# Remaining work (handoff for another harness)

State at handoff: `main` is at `6aef2ec` (plus this file), everything below it is committed, pushed and deployed. Migrations
001–016 are applied to the live Supabase project (`xtgmwosyekeigfeorfst`). All suites pass locally: core 36, API 99, web 52,
marketing 9, SDK 6 (Python suites not run since the multi-role work; `pytest` is not installed on this machine).
Read first: `CLAUDE.md`, `docs/DOMAIN.md`, `docs/PENDING.md` (the owner's original request list, all ticked).

## Working rules (from the owner)

- **Commit identity**: `git -c user.email=r@rob.cr commit`, **no Claude/AI attribution lines** in commit messages. (Commits `aa60650`..`6aef2ec` wrongly carry
  a `Co-Authored-By` trailer from a harness reminder; do not repeat it, and do not rewrite pushed history unless the owner asks.)
- Push to `main` only to ship; deployment is Vercel auto-deploy (three projects: marketing `www.openpark.io`, app `app.openpark.io`, API `api.openpark.io`).
- **Secrets**: never print them, never pass them as tool arguments, never write them to files. Generate in a shell variable and pipe via stdin
  (`printf %s "$S" | vercel env add NAME production --sensitive --yes`, `gh secret set` with `GH_TOKEN=$(gh auth token -u rmontero)`).
  Do not create anything in the unrelated "Andela" Supabase org.
- Keep hosting cost near zero (Vercel Hobby, Supabase free tier): no held-open connections, no always-on workers.
- Closed friends-and-family preview: `TRIAL_SIGNUP` stays off.
- Apply DB migrations to Supabase via the Supabase MCP `apply_migration`, and add `insert into schema_migration (name) values ('0xx_….sql') on conflict do nothing;`
  in the same call. Run `get_advisors` (security) afterwards.
- New UI strings go in **all** locale files (`apps/web/src/locales/*.json`, except `en-XA.json`, which `node scripts/pseudo.mjs` regenerates).
- Local tooling: Postgres `docker run -d --name openpark-pg -e POSTGRES_PASSWORD=openpark -e POSTGRES_USER=openpark -e POSTGRES_DB=openpark -p 54329:5432 postgres:16-alpine`;
  API `cd apps/api && TRIAL_SIGNUP=true PORT=3000 npx tsx src/main.ts`; web `cd apps/web && npx vite --port 5173`; browser scripts in `e2e/*.mjs`
  (`node e2e/crud.mjs`, `people-roles.mjs`, `menu.mjs`, `guest-pass.mjs`, `smoke.mjs`, `live-plate.mjs <shots> <plate.y4m>`).

## 1. Resume the adversarial review loop (iterations 5–10 of 10)

The owner asked: "have a separate agent review your work adversarially, and autonomously implement the recommendations it makes; 10 iterations or until the
reviewer has no more feedback." Four iterations are done (commits `cdcf3fb`, `b334541`, `bee41a4`, `6aef2ec`). Iteration 5's reviewer was launched when the loop was
paused and its findings were **not captured**; start iteration 5 again.

Per iteration: spawn a fresh read-only reviewer agent (it must not modify the repo; it may run tests and use a local Postgres), give it the list of
already-fixed/accepted items (below) and a fresh angle, take its ≤10 verified findings, fix each with a test, run all suites + the relevant browser
scripts, apply any new migration to Supabase, commit, push, verify the deploy, repeat. Stop when a reviewer answers exactly "NO FURTHER FEEDBACK".

Already fixed (tell reviewers not to re-report): stale edit forms; webhook SSRF (`apps/api/src/netguard.ts`, IPv6 forms, connect-time DNS guard);
unverified-email claims; units import deleting invited units; last-admin race; live plate threshold; retired-site references; stay-alert windows; one-time passwords in
idempotency records; malformed ids -> 500; zone rename labels; slot validation; pass-reason i18n; double submit; client-clock pass expiry; site-limited keys administering the tenant and
touching other sites' sessions/passes/exports; cross-tenant attachment of existing accounts (now invitations); orphaned passes; service-worker/ORT caching; stale docs; attendants reading
residents' names; offline queue replay under another user / 401 handling; invitations on the closed onboarding screen.

Accepted as-is (tell reviewers not to re-report): migration 009 mapped `auditor` to `attendant`; migration 011 flipped `ai_mode` off to assist; with local sign-in the response to adding an
email reveals whether it already has an account (documented in `apps/api/src/services/people.ts`); a lost one-time password cannot be recovered (UI explains: remove and re-add).

Angles planned for iteration 5 (use them): every route in `apps/api/src/routes/*.ts` checked for who can reach it, site-limited-key scope and personal-data exposure
(`/v1/audit`, `/v1/reports/shifts`, `/v1/sessions`, `/v1/occupancy`, `/v1/me`, SSE and webhook payloads); fee/payment/override amounts (integer minor units, negatives, overrides without reason);
plate normalisation and simultaneous check-ins of one plate / ticket collisions; any screen still assuming a single `me.role`; camera stream release in `LiveCamera.tsx`/`QrScanner.tsx`;
what `apps/web` build does if GitHub is unreachable for `scripts/fetch-models.mjs` (must fail loudly, not ship without the reader).

## 2. Known gaps in the product

- **Entities without screens or API**: Accounts, Permits, Vehicles, Devices (tables exist: `account`, `permit`, `vehicle`, `device`). See the matrix in `docs/DOMAIN.md`.
- **Rate plans**: no screen to choose which plan is a site's default, or to retire one (editing creates a new version, which exists).
- **Property settings screen**: tenant name, country, currency, default locale/terminology are only set at sign-up or via `PATCH /v1/tenant` (AI/locale pages cover part).
- **Password recovery for local-auth accounts**: no admin "reset password" (careful: must not allow taking over an account that belongs to other properties).
- **Offline check-out**: an offline check-out is queued by plate and priced by the server on replay; no local fee preview (cached open sessions + rate plans would allow one).
- **Plate reader**: only the two synthetic fixtures in `apps/web/test/fixtures/plates` have reference reads (the other four read nothing in the Python reference too); add real photos.
  Model files have unversioned names (`apps/web/models.lock.json`); a new model under the same name needs a rename to bust caches.
- **Supervisor notifications** use the notifier in `apps/api/src/notify`; Resend (email) and Twilio (SMS/WhatsApp) keys are **not set** in Vercel, so messages are only logged.
- **Python suites** (`services/alpr`, `packages/sdk-py`) not re-run after the multi-role changes; install pytest in `services/alpr/.venv` and run `pytest services/alpr packages/sdk-py -q`.
- Spanish (Spain) and other non-English locales are machine-written drafts (es-ES derived from es-MX by word swaps); have native speakers review before launch.
- `ARCHITECTURE.md` screens/roadmap section predates the multi-role model beyond the role table.

## 3. Things to verify on the live site (the owner cannot be asked every time)

Sign in as the Super Admin (`r@rob.cr`, member of `city-towers-green-black` with role Admin, no unit):
- Menu shows Resident view, Platform view, Operator view, Admin (incl. Organisations) and a Property switcher.
- Resident view explains how to give yourself a unit; People → Edit yourself → tick Resident + unit → the view then works.
- People: invite form shows five role checkboxes incl. Super Admin; `demo@openpark.io` is a pending invitation (Edit/Remove visible); Super Admin can be set on it.
- Units / Sites & slots / Integrations CRUD work against Supabase (they were only browser-tested against local Postgres).
- Camera at `/t/<slug>/a/checkin`: the plate reader loads (`/models/manifest.json`, `/ort/ort-1.30.0-simd.*` return 200) and auto-submits; QR scan works.
- Supabase Auth: keep "Confirm email" ON (the API trusts Supabase tokens' email without an explicit `email_verified` claim); advisor warns "leaked password protection disabled" — enable if the plan allows.
- GitHub Actions secrets `API_URL` and `CRON_SECRET` exist so `.github/workflows/pass-reminders.yml` drives stay/pass alerts and webhook retries; the daily retention cron also calls `purge_idempotency_keys`.
- Free-tier caveats to keep in mind: built-in Supabase email is ~2/hour; the project pauses after about a week of inactivity (the 5-minute cron keeps it awake); no backups.
