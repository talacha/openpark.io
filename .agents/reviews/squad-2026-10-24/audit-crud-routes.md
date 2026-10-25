# Audit: CRUD screens, web URLs and API routes

Track `audit-crud-routes`, squad 2026-10-24. Read-only audit; no source file was edited. Date of audit: 2026-10-24.

Scope read: `AGENTS.md`, `ARCHITECTURE.md`, `docs/DOMAIN.md`, `apps/web/src/{App.tsx,main.tsx,menu.ts,app-context.tsx,api.ts,offline.ts}`, `apps/web/src/components/{Shell,AppMenu,hooks,QueryState}`, every file in `apps/web/src/screens/`, `apps/api/src/{http.ts,server.ts}`, every file in `apps/api/src/routes/`, `packages/sdk-ts/src/index.ts`, the `slot`/`zone`/`site`/`membership_invite`/`idempotency_key` DDL, `apps/web/public/sw.js`, `apps/web/vercel.json`, `deploy/nginx.conf`.

Not done: I did not start the API or web app, did not run any test, and did not read `Auth.tsx` beyond its navigation calls, `Resident.tsx` below line 140 except by grep, or the marketing site. Statements marked *(verify)* are inferred from code, not observed at runtime.

## 0. Summary

- **Web router has 29 leaf routes** (37 `<Route>` elements including guards and layouts, `App.tsx:58-104`) mapping to 17 screen files. Almost every admin screen is a "list + create form + inline edit form + delete button" on one URL. **No entity has a detail URL** (not a site, slot, unit, user, session, rate plan, key or webhook).
- **State that should be in the URL is in React state or localStorage**: the active site (`op.site`), every list filter, every tab, every selected row, the check-in draft, the import preview and the "last applied job" needed for rollback.
- **API has 96 routes** (95 `defineRoute`/`definePublicRoute`/`definePlatformRoute` definitions plus the raw `app.get('/v1/events')`). Conventions are good in places (error codes, `Idempotency-Key` plumbing, RLS, 404-over-403 for site-scoped keys) but there is **no GET-by-id for any resource except passes**, slots are not nested though their identity is `(site, code)`, creates return `{id}` without `Location`, DELETE is not replay-stable, pagination has four shapes, and three create endpoints that return one-time secrets or version numbers have no idempotency at all.
- **Total: 44 findings** (10 High, 22 Medium, 12 Low; index in §9). Fix plan is 15 work packages: one foundation package that must land first, then 14 that can run in parallel by resource (§8).

Severity scale: **High** = breaks the stated requirement or loses data/secrets; **Medium** = violates the requirement but works; **Low** = polish/consistency.

## 1. Web screen and route inventory (current state)

Router: `react-router-dom` v6 `<Routes>` in `apps/web/src/App.tsx`, `BrowserRouter` in `main.tsx:15`. SPA fallback exists in `apps/web/vercel.json` (`/(.*)` → `/index.html`) and `deploy/nginx.conf:28`, so all deep links reach the app. The service worker (`public/sw.js:40-45`) falls back to the cached `/` shell for navigations, so deep links boot offline; their data does not (API is never cached) — that is the offline track's concern.

Guards: `TenantGate` (`App.tsx:36-42`) and `Area` (`App.tsx:44-48`, areas `ops|admin|operator|resident|staff`). Both silently `<Navigate>` to home on failure.

| # | Current URL | Component (file) | Tasks performed on that one screen | API calls | Area guard |
| --- | --- | --- | --- | --- | --- |
| 1 | `/` | `Home` (App.tsx:51) | Redirect to role home | – | – |
| 2 | `/login` | `Auth mode=login` (Auth.tsx) | Sign in | `POST /v1/auth/login` or Supabase | public |
| 3 | `/signup` (`?org&country&email`) | `Auth mode=signup` | Sign up | `POST /v1/signup` | public |
| 4 | `/forgot`, `/reset` | `Auth` | Password reset | Supabase | public |
| 5 | `/onboarding` | `Onboarding` (Auth.tsx:126) | Create first organisation; accept invitations | `POST /v1/signup`, invitations | signed in |
| 6 | `/pass#t=<token>` | `GuestPass` (GuestPass.tsx) | Show guest QR. Token in fragment on purpose (never sent to a server) | – | public |
| 7 | `*` | – | Silent redirect to `/` (App.tsx:104) | – | – |
| 8 | `/platform` | `Platform` (Platform.tsx:19) | List orgs **+** create org **+** suspend (native `prompt()`) **+** resume **+** enter org | `GET/POST /v1/platform/tenants`, `…/:slug/suspend|resume` | superadmin (in-component) |
| 9 | `/t/:slug` | `Home` | Redirect to role home | – | `TenantGate` |
| 10 | `/t/:slug/dashboard` | `Dashboard` | View occupancy, recent stays (live) | `GET /v1/occupancy`, `/v1/sessions` | ops |
| 11 | `/t/:slug/sessions` | `Sessions` | Filter list **+** expand row timeline | `GET /v1/sessions`, `/:id/events` | ops |
| 12 | `/t/:slug/slots` | `Slots` | Zone filter **+** grid **+** select slot **+** change status/note | `GET /v1/slots`, `PATCH /v1/slots/:code` | ops |
| 13 | `/t/:slug/passes` | `GuestPasses` | Edit pass policy **+** list passes **+** cancel pass | `GET/PATCH /v1/pass-policy`, `GET /v1/passes`, `POST …/:id/cancel` | ops |
| 14 | `/t/:slug/queue` | `Queue` | View offline queue **+** retry/dismiss conflicts | IndexedDB only | staff |
| 15 | `/t/:slug/parking` | `Parking` (Parking.tsx:30) | Edit community address/notes **+** create site **+** per site: edit, retire, list/create/edit/delete zones, list/filter/create/edit/delete slots | `/v1/tenant`, `/v1/sites*`, `/v1/slots*` | admin |
| 16 | `/t/:slug/inventory` | `Inventory` | Export **+** import preview **+** apply **+** rollback (slots) | `/v1/inventory/*` | admin |
| 17 | `/t/:slug/bulk` | `Bulk` (+ `ImportExport`) | Same import UI for 5 entities, chosen by a state toggle | `/v1/{community,sites,inventory,units,users}/*` | admin |
| 18 | `/t/:slug/rates` | `Rates` | Edit default plan rules (creates new version) **+** fee simulator | `GET/POST /v1/rate-plans`, `…/:id/quote` | admin |
| 19 | `/t/:slug/ai` | `AiSettings` | Edit AI mode, threshold (a *site* field), regions, retention, training export | `PATCH /v1/tenant`, `PATCH /v1/sites/:code` | admin |
| 20 | `/t/:slug/integrations` | `Integrations` | API keys: create/list/revoke **+** webhooks: create/list/edit/delete | `/v1/api-keys*`, `/v1/webhooks*` | admin |
| 21 | `/t/:slug/units` | `Units` (People.tsx:32) | List **+** create **+** inline edit **+** delete **+** import preview/apply | `/v1/units*` | admin |
| 22 | `/t/:slug/users` | `People` (People.tsx:228) | Invite **+** list members **+** list invitations **+** edit roles/unit **+** verify unit **+** remove | `/v1/users*`, `/v1/invites/:email`, `/v1/platform/tenants/:slug/members` | admin |
| 23 | `/t/:slug/a` | `AttendantHome` | Capacity bar **+** recent activity (sort+search) **+** quick check-out | `/v1/occupancy`, `/v1/sessions` | operator |
| 24 | `/t/:slug/a/checkin` | `CheckInCapture` | Camera/QR/keypad capture **+** pass scan | `/v1/passes/lookup`, ALPR on device | operator |
| 25 | `/t/:slug/a/checkin/review` | `CheckInReview` | Pick plate candidate | – | operator |
| 26 | `/t/:slug/a/checkin/confirm` | `CheckInConfirm` | Edit vehicle, choose slot, choose host, submit, **then show ticket on the same route** | `POST /v1/sessions` or `/v1/passes/redeem` | operator |
| 27 | `/t/:slug/a/checkout` | `CheckOut` | Camera/manual tabs **+** match **+** lost ticket **+** fee review **+** payment **+** receipt | `/v1/checkout/match`, `/v1/checkout` | operator |
| 28 | `/t/:slug/r` (+`?edit=1`, `#new`) | `ResidentHome` | Profile header **+** edit profile **+** new pass form **+** active pass (QR, regenerate, cancel) **+** history | `/v1/passes*`, `/v1/me/profile`, `/v1/me/avatar` | resident |

State currently held outside the URL (evidence in §3): active site, all filters/sorts/tabs, selected rows, edit-in-progress records, import previews, last applied job, check-in draft, matched session, receipt/ticket, router `location.state` for `ticket` and `focusPlate`.

## 2. Target route map (web)

Conventions I used, so each work package can follow them without asking:

1. Prefix every tenant route with `/t/:slug`. The slug in the URL is the source of truth for the tenant (CR-07).
2. **Site-owned resources use the path** (`/sites/:site/…`, where `:site` is the site `code`). **Cross-site overview/list screens use `?site=CODE`** (dashboard, sessions, passes, reports). If `?site` is absent the screen `replace`-redirects to the canonical URL using the stored default, so a URL is never ambiguous (CR-01).
3. Each screen does exactly one task: `list`, `detail` (read-only, with action buttons), `new`, `edit`, or a single named workflow step. Destructive actions are a confirm dialog on list/detail (shadcn `AlertDialog`), not a route, unless they need extra input (then a dialog with a form).
4. Filters, sort, search, pagination cursor and tab live in the query string via one shared `useQueryState` hook. Typing = `replace`, discrete choices = `push`.
5. Codes (`site`, `zone`, `slot`, `unit`) are the stable URL keys, matching the inventory JSON ("codes are the stable keys, never database IDs", ARCHITECTURE). Rows without a code (sessions, passes, keys, webhooks, plans, invitations, import jobs) use their UUID.
6. Singleton settings are one edit-form screen at `/settings/<name>`.
7. Old URLs keep working through the redirect table in §2.2.

### 2.1 Current → proposed

"Perm" is the API permission the screen needs to load/act (from `auth.ts:10-24`); "Guard" is the existing web `Area`.

| Current | Proposed URL | Screen component (new/renamed) | Single task | Data needed (API) | Perm / Guard |
| --- | --- | --- | --- | --- | --- |
| `/login` | `/login?next=/t/…` | `Auth(login)` | Sign in, then return to `next` | login | public |
| `/signup`, `/forgot`, `/reset`, `/onboarding` | unchanged | `Auth`, `Onboarding` | – | – | public / signed in |
| `/pass#t=` | unchanged | `GuestPass` | Show guest QR | token in fragment | public |
| `*` | (no redirect) | `NotFound` | Say the page does not exist | – | public |
| (guard failure) | (no redirect) | `Forbidden` | Say access is missing, name the role | – | – |
| `/platform` | `/platform/tenants` | `TenantsList` | List organisations | `GET /v1/platform/tenants` | superadmin |
| `/platform` (create form) | `/platform/tenants/new` | `TenantNew` | Create organisation + invite owner | `POST /v1/platform/tenants` | superadmin |
| `/platform` (row) | `/platform/tenants/:slug` | `TenantDetail` | View org; Suspend/Resume dialog; "Open" link to `/t/:slug/dashboard` | **new** `GET /v1/platform/tenants/:slug`; `PATCH` for suspend | superadmin |
| `/t/:slug/dashboard` | `/t/:slug/dashboard?site=` | `Dashboard` | Live occupancy overview | `/v1/occupancy`, `/v1/sessions?limit=8` | read / ops |
| `/t/:slug/sessions` | `/t/:slug/sessions?site=&status=&q=&plate=&from=&to=&sort=&cursor=` | `SessionsList` | Browse stays | `GET /v1/sessions` | read / ops |
| `/t/:slug/sessions` (row expand) | `/t/:slug/sessions/:sessionId` | `SessionDetail` | View one stay with timeline; Void dialog (reason) | **new** `GET /v1/sessions/:id`, `…/events` | read; `session.void` for Void |
| – | `/t/:slug/sessions/:sessionId/payments/new` | `PaymentNew` | Record payment on a closed stay | `POST /v1/sessions/:id/payments` | `payment` |
| `/t/:slug/slots` | `/t/:slug/sites/:site/slots?zone=&status=&type=&view=` | `SlotsList` | Browse/availability board (grid or table) | `GET /v1/sites/:site/slots` | read / ops |
| `/t/:slug/slots` (select card) | `/t/:slug/sites/:site/slots/:slot` | `SlotDetail` | View one slot, current car | **new** `GET …/slots/:slot` | read |
| `/t/:slug/slots` (status select) | `/t/:slug/sites/:site/slots/:slot/edit` | `SlotEdit` | Edit status+note (attendant/supervisor: `slot.status`; type/zone/attributes: `inventory.edit`) | `PATCH …/slots/:slot` | `slot.status` / `inventory.edit` |
| `/t/:slug/passes` (list) | `/t/:slug/passes?status=&unit=&cursor=` | `PassesList` | Browse guest passes | `GET /v1/passes` | `pass.admin` / ops |
| – | `/t/:slug/passes/:passId` | `PassDetail` | View pass; Cancel dialog | `GET /v1/passes/:id`, `POST …/cancel` | `pass.admin` |
| `/t/:slug/passes` (policy) | `/t/:slug/settings/guest-passes` | `GuestPassPolicy` | Edit pass rules (read-only for supervisors) | `GET/PATCH /v1/pass-policy` | `read` / `settings.edit` |
| `/t/:slug/queue` | `/t/:slug/sync` | `SyncQueue` | Review offline queue and conflicts (device-local) | IndexedDB | staff |
| `/t/:slug/parking` (list) | `/t/:slug/sites` | `SitesList` | List sites | `GET /v1/sites` | read / admin |
| `/t/:slug/parking` (add form) | `/t/:slug/sites/new` | `SiteNew` | Create site | `POST /v1/sites` | `inventory.edit` |
| `/t/:slug/parking` (card) | `/t/:slug/sites/:site` | `SiteDetail` | View site: counts, zones table, link to slots; Retire dialog | **new** `GET /v1/sites/:site` | read |
| `/t/:slug/parking` (manage) | `/t/:slug/sites/:site/edit` | `SiteEdit` | Edit name, tz, address, AI threshold | `PATCH /v1/sites/:site` | `settings.edit` |
| `/t/:slug/parking` (zones table) | `/t/:slug/sites/:site/zones` | `ZonesList` | List zones | **new** `GET /v1/sites/:site/zones` | read |
| `/t/:slug/parking` (zone form) | `/t/:slug/sites/:site/zones/new` | `ZoneNew` | Create zone | `POST …/zones` | `inventory.edit` |
| `/t/:slug/parking` (zone edit card) | `/t/:slug/sites/:site/zones/:zone/edit` | `ZoneEdit` | Edit name/level/labels; Delete dialog on list | `PATCH/DELETE …/zones/:zone` | `inventory.edit` |
| `/t/:slug/parking` (slot form) | `/t/:slug/sites/:site/slots/new` | `SlotNew` | Create slot | `POST …/slots` | `inventory.edit` |
| `/t/:slug/parking` (community card) | `/t/:slug/settings/community` | `CommunitySettings` | Edit address/notes | `GET/PATCH /v1/community` | `settings.edit` |
| `/t/:slug/rates` | `/t/:slug/sites/:site/rate-plans` | `RatePlansList` | List plans (latest version each) | `GET …/rate-plans` | read / admin |
| – | `/t/:slug/sites/:site/rate-plans/new` | `RatePlanNew` | Create a plan with a new name | `POST …/rate-plans` | `rate_plan.edit` |
| `/t/:slug/rates` (editor) | `/t/:slug/sites/:site/rate-plans/:planId` | `RatePlanDetail` | View a version, version history, default flag | **new** `GET /v1/rate-plans/:id` | read |
| `/t/:slug/rates` (editor) | `/t/:slug/sites/:site/rate-plans/:planId/edit` | `RatePlanEdit` | Edit = publish next version (prefilled) | `POST /v1/rate-plans/:id/versions` | `rate_plan.edit` |
| `/t/:slug/rates` (simulator) | `/t/:slug/sites/:site/rate-plans/:planId/simulator` | `RateSimulator` | Quote a fee for in/out times (`?in=&out=` in URL) | `POST /v1/rate-plans/:id/quotes` | read |
| `/t/:slug/units` | `/t/:slug/units?site=&q=&cursor=` | `UnitsList` | List units | `GET /v1/units` | read / admin |
| `/t/:slug/units` (form) | `/t/:slug/units/new` | `UnitNew` | Create unit | `POST /v1/units` | `users.edit` |
| `/t/:slug/units` (row) | `/t/:slug/units/:unit` | `UnitDetail` | View unit, residents, pass state; Delete dialog | **new** `GET /v1/units/:unit` | read |
| `/t/:slug/units` (inline edit) | `/t/:slug/units/:unit/edit` | `UnitEdit` | Edit name/site/floor/note | `PATCH /v1/units/:unit` | `users.edit` |
| `/t/:slug/users` (members) | `/t/:slug/users?role=&q=&cursor=` | `UsersList` | List members | `GET /v1/users` | `users.edit` / admin |
| `/t/:slug/users` (invite form) | `/t/:slug/users/new` | `UserNew` | Add person (member or invitation by auth mode) | `POST /v1/users` | `users.edit` |
| – | `/t/:slug/users/:userId` | `UserDetail` | View member; Verify-unit and Remove dialogs | **new** `GET /v1/users/:id` | `users.edit` |
| `/t/:slug/users` (edit card) | `/t/:slug/users/:userId/edit` | `UserEdit` | Edit roles/unit/superadmin | `PATCH /v1/users/:id` | `users.edit` |
| `/t/:slug/users` (pending) | `/t/:slug/invitations` | `InvitationsList` | List pending invitations | **new** `GET /v1/invitations` | `users.edit` |
| – | `/t/:slug/invitations/:inviteId/edit` | `InvitationEdit` | Edit roles/unit; Withdraw dialog on list | `PATCH/DELETE /v1/invitations/:id` | `users.edit` |
| `/t/:slug/integrations` | `/t/:slug/integrations` → redirect `/integrations/api-keys` | – | – | – | – |
| `/t/:slug/integrations` (keys) | `/t/:slug/integrations/api-keys` | `ApiKeysList` | List keys; Revoke dialog | `GET /v1/api-keys` | `users.edit` |
| – | `/t/:slug/integrations/api-keys/new` | `ApiKeyNew` | Create key; on success show secret once on `…/api-keys/:keyId` (router state, not reload-safe by design) | `POST /v1/api-keys` | `users.edit` |
| – | `/t/:slug/integrations/api-keys/:keyId` | `ApiKeyDetail` | View key (prefix, role, scope, status) | **new** `GET /v1/api-keys/:id` | `users.edit` |
| `/t/:slug/integrations` (hooks) | `/t/:slug/integrations/webhooks` | `WebhooksList` | List webhooks; Delete dialog | `GET /v1/webhooks` | `settings.edit` |
| – | `/t/:slug/integrations/webhooks/new` | `WebhookNew` | Register webhook (secret shown once) | `POST /v1/webhooks` | `settings.edit` |
| – | `/t/:slug/integrations/webhooks/:hookId` | `WebhookDetail` | View webhook, recent deliveries | **new** `GET /v1/webhooks/:id`, `…/deliveries` | `settings.edit` |
| `/t/:slug/integrations` (edit card) | `/t/:slug/integrations/webhooks/:hookId/edit` | `WebhookEdit` | Edit URL/events/paused | `PATCH /v1/webhooks/:id` | `settings.edit` |
| `/t/:slug/inventory`, `/t/:slug/bulk` | `/t/:slug/imports` | `ImportsList` | Past import jobs; link to export | **new** `GET /v1/imports` | admin |
| – | `/t/:slug/imports/new?kind=` | `ImportNew` | Upload/paste a file, choose kind+mode, validate | `POST /v1/imports` | per kind |
| – | `/t/:slug/imports/:jobId` | `ImportJob` | Review diff; Apply; Roll back (dialog) — survives reload | **new** `GET /v1/imports/:id` + `apply`/`rollback` | per kind |
| `/t/:slug/bulk` (export button) | `/t/:slug/exports?kind=&site=` | `ExportsPage` | Download a JSON export | `GET /v1/exports/:kind` | per kind |
| `/t/:slug/ai` | `/t/:slug/settings/ai` | `AiSettings` | Edit AI mode/regions/retention/training (threshold moves to `SiteEdit`) | `PATCH /v1/community` | `settings.edit` |
| – | `/t/:slug/audit?actor=&action=&cursor=` | `AuditLog` | Browse audit events (**no screen exists today**) | `GET /v1/audit` | `audit.read` |
| – | `/t/:slug/reports/shifts?site=&date=` | `ShiftReport` | Shift report (**no screen exists today**) | `GET /v1/reports/shifts` | read |
| `/t/:slug/a` | `/t/:slug/attendant` | `AttendantHome` | Capacity + recent + two big buttons | occupancy, sessions | operator |
| `/t/:slug/a/checkin` | `/t/:slug/attendant/check-in?site=` | `CheckInCapture` | Capture plate/QR | on-device ALPR, `/v1/passes/lookup` | `checkin` |
| `/t/:slug/a/checkin/review` | `/t/:slug/attendant/check-in/candidates` | `CheckInCandidates` | Pick candidate (draft restored from storage) | draft | `checkin` |
| `/t/:slug/a/checkin/confirm` | `/t/:slug/attendant/check-in/confirm` | `CheckInConfirm` | Confirm and submit; on success **navigate** to the session | `POST /v1/sessions` | `checkin` |
| `/t/:slug/a/checkin/confirm` (done state) | `/t/:slug/attendant/sessions/:sessionId` | `AttendantSession` | Show ticket QR/receipt; reopenable, shareable between attendants | **new** `GET /v1/sessions/:id` | read |
| `/t/:slug/a/checkout` | `/t/:slug/attendant/check-out?ticket=&plate=` | `CheckOutFind` | Find the stay (camera/manual) | `POST /v1/checkout/match` | `checkout` |
| `/t/:slug/a/checkout` (matched view) | `/t/:slug/attendant/check-out/:sessionId` | `CheckOutReview` | Review fee, take payment, confirm | `POST /v1/sessions/:id/checkout` | `checkout` |
| `/t/:slug/r` | `/t/:slug/my/passes` | `MyPasses` | Active pass + history | `/v1/passes/active`, `/v1/passes` | `pass.own` / resident |
| `/t/:slug/r#new` | `/t/:slug/my/passes/new` | `MyPassNew` | Create guest pass | `POST /v1/passes` | `pass.own` |
| – | `/t/:slug/my/passes/:passId` | `MyPassDetail` | QR, share, regenerate, cancel dialog | `GET /v1/passes/:id` (extend to own unit) | `pass.own` |
| `/t/:slug/r?edit=1` | `/t/:slug/my/profile` and `/t/:slug/my/profile/edit` | `MyProfile`, `MyProfileEdit` | View / edit own profile + avatar | `/v1/me`, `PATCH /v1/me/profile`, `PUT /v1/me/avatar` | `me` |

### 2.2 Redirects for old URLs

Implement as one array `legacyRedirects` in `apps/web/src/routes/legacy.tsx`, rendered before the catch-all as `<Navigate replace>` (client-side, because hash fragments are never sent to a server so a Vercel/nginx 308 cannot see `#new`). Keep for at least two releases. Redirects never touch `/pass`.

| Old | New |
| --- | --- |
| `/platform` | `/platform/tenants` |
| `/t/:slug/parking` | `/t/:slug/sites` |
| `/t/:slug/slots` | `/t/:slug/sites/<defaultSite>/slots` |
| `/t/:slug/rates` | `/t/:slug/sites/<defaultSite>/rate-plans` |
| `/t/:slug/inventory`, `/t/:slug/bulk` | `/t/:slug/imports/new` (`/bulk` with a remembered entity: `?kind=`) |
| `/t/:slug/ai` | `/t/:slug/settings/ai` |
| `/t/:slug/queue` | `/t/:slug/sync` |
| `/t/:slug/integrations` | `/t/:slug/integrations/api-keys` |
| `/t/:slug/a` | `/t/:slug/attendant` |
| `/t/:slug/a/checkin` | `/t/:slug/attendant/check-in` |
| `/t/:slug/a/checkin/review` | `/t/:slug/attendant/check-in/candidates` |
| `/t/:slug/a/checkin/confirm` | `/t/:slug/attendant/check-in/confirm` |
| `/t/:slug/a/checkout` | `/t/:slug/attendant/check-out` |
| `/t/:slug/r` | `/t/:slug/my/passes` |
| `/t/:slug/r?edit=1` | `/t/:slug/my/profile/edit` |
| `/t/:slug/r#new` | `/t/:slug/my/passes/new` |

`<defaultSite>` comes from the stored preference, falling back to the first site from `GET /v1/sites`. Update `menu.ts` (`:42-43` use `?edit=1` and `#new`), `Shell.tsx:57-65` (`AttendantLayout` base), `SyncBadge.tsx:55` (`/queue`), `homeFor` in `app-context.tsx:62-70`, the `Link to="../…"` relative links (Parking.tsx:258, People.tsx:132, 287, 343, Resident.tsx:168), and the e2e scripts that hard-code old paths (`e2e/crud.mjs:17-88`, `e2e/menu.mjs:97`, `e2e/smoke.mjs:46`, `e2e/ai-settings.mjs:11`, `e2e/guest-pass.mjs:56`).

## 3. Findings: web

### CR-01 · High · The active site is invisible global state, not in the URL
- Evidence: `app-context.tsx:73` reads `localStorage['op.site']`; `:118` writes it; consumers `Dashboard.tsx:24-25`, `Sessions.tsx:25`, `Slots.tsx:26`, `Rates.tsx:24`, `Inventory.tsx:31`, `Bulk.tsx:57,71`, `Settings.tsx:28`, `Attendant.tsx` (`site` from `useApp`); switcher `AppMenu.tsx:106-113`.
- Problem: Two people opening "the same" `/t/x/sessions` see different sites; a shared link, a reload on another device, and back/forward across a site switch are all wrong.
- Fix: Add `useSiteParam()` in `apps/web/src/routes/site.ts`: reads `:site` (path) or `?site=` (query) and falls back to the stored preference only to build a canonical `replace` redirect. `setSiteCode` becomes `navigate(withSite(current, code))`. Remove `site`/`setSiteCode` from `AppCtx` consumers one screen at a time. Keep `op.site` only as the "last used" hint.

### CR-02 · High · Filters, sort, tabs, selection and paging are React state
- Evidence: `Sessions.tsx:22-24` (status, plate, selected id); `Slots.tsx:22-23` (zone, selected slot); `Parking.tsx:116-118,126` (open, zoneFilter, editZone, editSlot); `Bulk.tsx:37` (entity tab); `Attendant.tsx` `RecentActivity` (`sort`, `q`) and `CheckOut` tab (`:698`); `Resident.tsx:103-106` (open sections); `People.tsx:243` (`editing`) and `:239` (`prop`); `Integrations.tsx:30` (`editing`).
- Problem: Reload, share, back button and deep-linking all lose the view. Back from a filtered list leaves the app instead of undoing the filter.
- Fix: Add `useQueryState<T>(schema)` in `apps/web/src/hooks/use-query-state.ts` over `useSearchParams` (zod-parsed, defaults omitted from the URL, `replace` for text input debounced 250 ms, `push` for select/tab changes). Convert each list to it as part of its resource work package. Selection becomes a detail route (CR-04), not state.

### CR-03 · High · Seven screens are multi-purpose (list + create + edit + delete inline)
- Evidence: `Parking.tsx:30-263` (community edit, site create, site edit, retire, zone create/edit/delete, slot create/edit/delete, zone filter); `People.tsx:32-195` Units (create form `:103`, edit card `:116`, table `:127`, delete `:136`, import card `:142-192`); `People.tsx:228-377` Users (invite `:301`, edit `:321`, members `:333`, invitations `:361`); `Integrations.tsx:22-103` (two resources, each list+create+edit+delete); `Platform.tsx:19-92`; `Rates.tsx:20-83` (edit + simulator); `GuestPasses.tsx:19-83` (policy editor + list + cancel); `Resident.tsx:85+` (§1 row 28).
- Problem: Directly violates "one task per screen". Each screen owns 4-8 pieces of local state and several submit handlers.
- Fix: Split to the screens in §2.1. Build four shared primitives first (WP-00): `ListPage` (title, filters slot, table, empty/error/loading, `+ New` link), `DetailPage` (key/value list + action bar), `FormPage` (react-hook-form + zod, owns the `Idempotency-Key`, busy flag, error banner, navigate-to-detail on success), `ConfirmDialog` (CR-12). Each resource package then composes them.

### CR-04 · High · No entity has a detail URL
- Evidence: Sessions expand a row in place (`Sessions.tsx:47-69`); slots open a side card (`Slots.tsx:50-71`); units/users/sites/keys/hooks have only table rows; `App.tsx:71-100` has no `:id` param anywhere.
- Problem: Nothing is linkable, reloadable or back-button correct. A supervisor cannot send a colleague a link to a stay or a slot.
- Fix: Add detail routes per §2.1 and the matching `GET …/:id` endpoints (CR-24). Make list rows real `<Link>`s (`<a>`), which also fixes keyboard and middle-click behaviour (currently `TableRow onClick`, `Sessions.tsx:47`).

### CR-05 · High · Deep links are lost across sign-in
- Evidence: `Shell.tsx:47` `if (!who) return <Navigate to="/login" replace />` with no return target; `Auth.tsx:57,61,68,77,140` all `nav('/')`; `Platform.tsx:56` same.
- Problem: An attendant opening a bookmarked or emailed `/t/x/attendant/check-out/…` ends on the home page after login.
- Fix: Redirect to `/login?next=<encoded pathname+search>`; after sign-in `navigate(safeNext(next) ?? homeFor(...), { replace: true })`. `safeNext` accepts only same-origin paths starting with a single `/` and not `//`.

### CR-06 · Medium · Unknown and forbidden URLs are silently rewritten
- Evidence: `App.tsx:104` catch-all → `/`; `App.tsx:46` and `:39-40` guard failure → home.
- Problem: A typo or a missing role shows the dashboard with a different URL. Users cannot tell "not found" from "not allowed", and support cannot reproduce.
- Fix: Add `NotFound` (404) and `Forbidden` (403, names the missing role) pages with a link home. `Area` renders `Forbidden` in place; the URL stays.

### CR-07 · Medium · Tenant comes from localStorage, not from the URL
- Evidence: `api.ts:12-19` stores `op.session.tenant`; `api.ts:28` sends it as `x-tenant`; `app-context.tsx:84-88` chooses the tenant from storage; `App.tsx:36-42` `TenantGate` redirects to `/t/<stored>` and **drops the rest of the path** when the URL slug differs.
- Problem: ARCHITECTURE says "the tenant comes from the URL path (/t/{tenant-slug}/…)". A user with two memberships who opens a link to the other tenant lands on the wrong tenant's home; the link's path is lost.
- Fix: In `TenantGate`, if `slug !== me.tenant.slug` and the caller has a membership (or is superadmin) call `switchTenant(slug)` and re-render the same sub-path; otherwise render `Forbidden`. Remove the home redirect.

### CR-08 · Medium · Resident screen is addressed by `?edit=1` and `#new`
- Evidence: `Resident.tsx:91-123` mixes `useSearchParams`, `loc.hash` and `window.location.hash` with effects keyed on `loc.key`; `menu.ts:42-43`.
- Problem: Section toggles are the URL contract, hash is invisible to the router, and the code carries a long comment explaining the race. It is the clearest example of "state hidden in the URL fragment".
- Fix: Replace with the five routes under `/my/…` in §2.1. Delete the effects and the `Collapsible` open-state props.

### CR-09 · High · Check-in draft and the created ticket exist only in memory
- Evidence: `Attendant.tsx:79-95` `Flow` is `useState`; `:556-562` the ticket/QR are shown from local `done` state on `/a/checkin/confirm`; `:561` "Done" resets.
- Problem: Reloading, an OS tab kill on a phone, or opening the PWA from the home screen mid-flow loses the plate, vehicle and host. After success there is no URL to reopen the ticket, which an attendant needs for a printed or re-shown QR. Also directly relevant to the offline goals (5, 6).
- Fix: (a) Persist `FlowState` to `sessionStorage` (survives reload) or IndexedDB (survives app kill) keyed by `tenant+site`, restored in `Flow`. (b) On success `navigate(/attendant/sessions/:sessionId, { replace: true })` and render the ticket there from `GET /v1/sessions/:id`; when the check-in was queued offline use the client-generated idempotency key as a temporary id and show "queued". Coordinate with the offline-sync track.

### CR-10 · Medium · Router `location.state` carries business data
- Evidence: `Attendant.tsx:166` `nav(…/checkout, { state: { ticket } })`, `:714` reads it; `:310`/`:524` `focusPlate`.
- Problem: Not shareable; lost on a fresh tab. `state` survives reload only in the same history entry.
- Fix: `?ticket=` on `/attendant/check-out`, or navigate straight to `/attendant/check-out/:sessionId`. `focusPlate` is a UI hint; replace with autofocus-when-empty logic.

### CR-11 · Medium · `CheckOut` is a five-mode screen with no URL for the matched stay
- Evidence: `Attendant.tsx:692-815`: tab (`:698`), plate, ticket, `m` match, `fuzzy`, `lost`, `pay`, `receipt`, `scanning` — nine `useState`s on one route.
- Problem: Reloading after a successful match loses the review; the back button leaves the flow.
- Fix: Two routes (`check-out` find, `check-out/:sessionId` review) as in §2.1; the review screen loads the preview with a `GET` (add `GET /v1/sessions/:id/checkout-preview`, or keep `POST /v1/checkout/match` keyed by `confirmedSession`).

### CR-12 · Medium · Destructive actions: three native dialogs, ten with no confirmation, no AlertDialog component
- Evidence (native): `Platform.tsx:49` `prompt()`, `Parking.tsx:187` `confirm()`, `Bulk.tsx:138` `confirm()`, `Resident.tsx:246` `confirm()`. Evidence (no confirmation): remove zone `Parking.tsx:200`; remove slot `:233`; remove unit `People.tsx:136`; remove member `:352`; withdraw invitation `:369`; revoke API key `Integrations.tsx:64`; delete webhook `:96`; cancel staff pass `GuestPasses.tsx:75`; resume tenant `Platform.tsx:53`; rollback on `Inventory.tsx:99`. `apps/web/src/components/ui/` has no `alert-dialog.tsx` (checked by `grep -rn AlertDialog`, zero hits).
- Problem: Native dialogs are unstyled, untranslatable-by-design, non-accessible on mobile PWAs and block the main thread. Unconfirmed deletes of members, keys and webhooks are one mis-tap away.
- Fix: Add shadcn `alert-dialog` (`pnpm dlx shadcn add alert-dialog`) and `components/ConfirmDialog.tsx` with props `{ title, description, confirmLabel, destructive, requireText?, reason? }`. Use it for every row in this list; `reason` variant for suspend and void.

### CR-13 · Medium · Three copies of the import UI, and import state is lost on reload
- Evidence: `Inventory.tsx` (whole file), `People.tsx:142-192` (Units import card) and `Bulk.tsx:55-141` (`ImportExport`) implement the same validate → preview → apply → rollback panel. Routes `inventory` and `bulk` both registered (`App.tsx:78-79`); `Parking.tsx:258` still links to `../inventory`. Preview and `lastApplied` are `useState` (`Bulk.tsx:63-64`, `Inventory.tsx:24,27`). `Inventory.tsx:39,46` sends no `Idempotency-Key` (uses plain `request`). The Units card has no rollback and neither does the Units API (CR-30).
- Problem: Reload after "Validate" discards the job; after "Apply" the rollback button is gone forever (the job id exists only in state). Duplicate code diverges (idempotency, confirm dialog, rollback).
- Fix: One `ImportJob` screen backed by `GET /v1/imports/:id` (CR-30) so the job survives reload and rollback is always reachable from `/imports`. Delete `Inventory.tsx` and the Units card; keep the diff-table renderer as `components/DiffTable.tsx`.

### CR-14 · Medium · Platform screen has no tenant detail and uses side-effecting buttons
- Evidence: `Platform.tsx:48-54`: `suspend` via `prompt`, `enter` calls `switchTenant` then `nav`, create form inline `:62-67`.
- Fix: Routes in §2.1. "Open" becomes a plain `<Link to="/t/:slug/dashboard">` (the tenant now comes from the URL, CR-07), removing the imperative `switchTenant` + `nav` pair.

### CR-15 · Medium · Rate-plan UI can only republish the default plan; plans and versions are not browsable
- Evidence: `Rates.tsx:25` picks `plans.data.find(is_default) ?? [0]`; `:41` always posts the same `plan.name`. The API lists all versions (`rates.ts:10-19`, `all=true`) but the UI never requests them. `Rates.tsx:28-29` hard-codes demo times `'2026-10-20T08:12'`/`'…14:09'` as simulator defaults.
- Problem: You cannot create a second plan (e.g. "Visitor" vs "Resident"), see version history, or set a different default. The `in_use` immutability rule (DOMAIN) is invisible.
- Fix: Screens `RatePlansList/New/Detail/Edit/Simulator` per §2.1. Simulator times default to "now − 2 h … now" and live in `?in=&out=`.

### CR-16 · Medium · Implemented API with no screen
- Evidence: `GET /v1/audit` (`misc.ts:119`) and `GET /v1/reports/shifts` (`misc.ts:97`) have no web caller (checked by grep of `apps/web/src`); `POST /v1/sessions/:id/void` (`sessions.ts:106`) and `POST /v1/sessions/:id/payments` (`sessions.ts:96`) likewise; `GET /v1/passes/:id` (`passes.ts:69`); zone `labels` (`slots.ts:74,88`) and slot `attributes`/`assignment` are never editable. DOMAIN says Stays can be voided and fee-overridden from "Stays (Platform view)".
- Fix: `AuditLog`, `ShiftReport`, `SessionDetail` (void, payment), `PassDetail`, zone-label fields in `ZoneEdit`, attributes JSON field in `SlotEdit` (admin only).

### CR-17 · Low · Opaque URL segments
- Evidence: `a`, `r`, `parking`, `ai`, `bulk`, `queue`, `passes` (staff) vs the DOMAIN terms Attendant, Resident, Site, AI plate reading, Bulk import/export, Sync, Guest passes.
- Fix: Names in §2.1. `homeFor` (`app-context.tsx:62-70`) uses them and must change.

### CR-18 · Low · Menu: duplicate entry and route-dependent active logic
- Evidence: `menu.ts:55` and `:68` both list `queue`; `AppMenu.tsx:58` marks a group active with `pathname.startsWith(item.to)` which makes `/t/x/a` (home) active for every `/a/*` URL and fails for the new nested resources.
- Fix: Drive the menu from the route table (each route declares `menu: { group, label, icon }`); use `matchPath(item.to + '/*')`; list `sync` once.

### CR-19 · Low · Unit codes are free text but used as URL path segments
- Evidence: `people.ts:130` `code: z.string().trim().min(1).max(30)` (any character); `People.tsx:69,71` encode, but `Parking.tsx:140,146,151,157,162,187,200,233` interpolate site/zone/slot codes raw (safe only because those codes are constrained by the regex at `slots.ts:28,74,185`). The inventory import also uses `export`/`import` as path words (`/v1/units/export`), which would shadow a unit with code `export`.
- Fix: Constrain unit code to `^[A-Za-z0-9][A-Za-z0-9_.-]{0,29}$` (migration to validate existing rows first), add `routes/paths.ts` with typed builders that always `encodeURIComponent`, and reserve `new|edit|export|import` as invalid codes for all four coded resources.

### CR-20 · Low · Copy-pasted mutation boilerplate with inconsistent idempotency
- Evidence: the "busy flag + `useSubmitKey` + `try/catch/finally` + `form.reset` + reload" block appears in `Parking.tsx:44-55,130-135`, `People.tsx:53-65,250-270`, `Platform.tsx:30-46`, `Integrations.tsx:33-39`. `Integrations.tsx:36` uses plain `post` (a new random key per click, so no retry stability), `Rates.tsx:41` uses `request` with no key, `GuestPasses.tsx:35` cancel uses `post` with a fresh key each click.
- Fix: One `useMutation`-style hook `useWrite({ method, path, onSuccess })` that owns key rotation, pending state, error mapping (`errText`) and navigation. Part of the `FormPage` primitive in WP-00. (Cross-track: clean-code audit.)

## 4. Findings: API

Where I cite "good" behaviour it is listed in §6, not here.

### CR-21 · High · `POST /v1/rate-plans` has no idempotency, and the UI sends no key
- Evidence: `rates.ts:23-39` has neither `idempotent` nor `replaySafe`; it computes `version = max+1` (`:30`) and may flip `default_rate_plan_id` (`:35`). `Rates.tsx:41` calls `request('POST', …)` with no `Idempotency-Key`.
- Problem: A double click or a lost response creates two versions and moves the site default twice. Versions are immutable (DOMAIN), so the extra one cannot be removed.
- Fix: Replace with `POST /v1/rate-plans/:id/versions` (new version of an existing plan) and `POST /v1/sites/:site/rate-plans` (new plan name), both `idempotent: true`. Keep the old `POST /v1/rate-plans` as a deprecated alias that requires the key. In the handler, take a transaction-scoped advisory lock on `(site_id, name)` so concurrent requests cannot both read `max(version)` (the `unique (tenant_id, site_id, name, version)` constraint at `001_init.sql:67` turns the race into a 500 today).

### CR-22 · High · `POST /v1/api-keys` and `POST /v1/webhooks` are not replay-safe, and their secrets are shown once
- Evidence: `auth.ts:167-184` and `auth.ts:233-247` have no idempotency flags; they return `key` / `secret` once. `http.ts` stores responses for replay but only blanks `temporaryPassword` (the `JSON.stringify` replacer in the `insert into idempotency_key` call).
- Problem: A lost response produces a credential the user never saw, and the retry creates a second one. The obvious fix (mark `replaySafe`) would write the plaintext key or webhook secret into `idempotency_key.response`, which any `openpark_app` query can read.
- Fix: Mark both `replaySafe`. Extend the redaction in `http.ts` to a per-route list (`redact: ['key', 'secret']`). On replay the response is `201` with the same `id` and `prefix` and `secret: null, secretAlreadyShown: true`; the UI then offers "revoke and create a new key". Add a regression test that `idempotency_key.response` contains no `op_`/`whsec_` substring.

### CR-23 · High · Slots are not nested although their identity is `(site, code)`
- Evidence: `001_init.sql:110` `unique (site_id, code)`; zones are nested (`slots.ts:73,87,103` `/v1/sites/:site/zones/:code`) but slots use `/v1/slots`, `/v1/slots/:code?site=…` (`slots.ts:120,182,205,220`). The SDK and web copy the awkward form (`sdk-ts/src/index.ts` `setSlotStatus`, `Parking.tsx:157,162,233`, `Slots.tsx:31`).
- Problem: `DELETE /v1/slots/B2-001` is ambiguous without a query string; caches, logs and OpenAPI treat it as a different resource per query; the URL is not a stable identity.
- Fix: Add `GET|POST /v1/sites/:site/slots`, `GET|PATCH|DELETE /v1/sites/:site/slots/:slot`, `GET /v1/sites/:site/slots/suggestion`. Keep `/v1/slots*` as deprecated aliases registered through the same handler (`deprecatedFor` flag in the registry emitting `Deprecation: true` and `Link: <new>; rel="successor-version"`).

### CR-24 · High · No GET-by-id for almost every resource
- Evidence: routes present: list + create + patch + delete for sites (`slots.ts:13-69`), zones (`:72-117`), slots, units (`people.ts:107-181`), users (`:218-299`), api keys (`auth.ts:167-203`), webhooks (`:205-247`), rate plans (`rates.ts`); sessions have `/:id/events` but no `/:id` (`sessions.ts:166`). Only `GET /v1/passes/:id` exists (`passes.ts:68`).
- Problem: Blocks every detail screen and every reloadable URL; clients must list-and-filter. For offline sync, nothing can refetch one changed entity.
- Fix: Add the GETs listed in §2.1. Each returns the same representation as the item in the list response. `GET /v1/sessions/:id` includes plate, slot, ticket, fee, fee breakdown, `in_by/out_by`, pass link.

### CR-25 · Medium · DELETE is not replay-stable
- Evidence: second DELETE returns 404 in `slots.ts:59-60` (sites, `retired_at is null`), `:106-107` (zones), `:210` (slots), `people.ts:171-172` (units), `:280` (users), `:375-376` (invites), `auth.ts:198-199` (api keys, `revoked_at is null`), `:227` (webhooks). No DELETE route is `replaySafe` or `idempotent`.
- Problem: A retried or replayed DELETE (flaky network, offline queue) reports an error for a successful operation. `offline.ts:62` treats any non-OK, non-5xx response as a conflict for a human, so a queued delete would land in the supervisor queue.
- Fix: For soft-deleted resources (sites, slots, API keys) return `204` again when the row is already retired/revoked. For hard deletes (zone, unit, webhook, invitation, user) mark the routes `replaySafe` so a retry with the same key replays the first `204`; a new key on a missing row stays `404`. Document: "DELETE is idempotent for the same Idempotency-Key; without a key a repeat returns 404."

### CR-26 · Medium · Write responses are inconsistent; creates carry no `Location`
- Evidence: POST returns `{ id }` (`slots.ts:38,82,200`, `people.ts:141`), `{ id, version }` (`rates.ts:37`), `{ key, prefix }` (`auth.ts:182`), `{ userId, … }` (`people.ts:246`); PATCH returns `settings` (`slots.ts:52`), `{ ok: true }` (`:98`, `people.ts:164,272`), `{ ok, site, slot, status }` (`slots.ts:250`); DELETE returns `{ ok: true }`.
- Fix: One rule enforced in `defineRoute`: POST → `201` + `Location: /v1/<collection>/<key>` + full representation; PATCH → `200` + full representation; DELETE → `204` no body. Add `Location` support to `created()` (`http.ts` `created`), and a response schema per route (CR-34). The web `FormPage` then navigates to `Location` on success.

### CR-27 · Medium · Four pagination shapes; offset paging on a live list
- Evidence: sessions `{ total, items }` with `limit ≤ 500` + `offset` (`sessions.ts:123-162`); passes bare array with `limit ≤ 100` and no offset (`passes.ts:22`); audit bare array `limit ≤ 500` (`misc.ts:121`); units hard `limit 500` (`people.ts:122`); users, api keys, webhooks, rate plans, slots, sites unbounded.
- Problem: Clients cannot page units/users past 500/unbounded; offset on `order by in_at desc` duplicates or skips rows while attendants check in cars; there is no `nextCursor` for the web `cursor=` query param.
- Fix: Shared `Page` zod schema `{ limit: 1..200 default 50, cursor?: string }`; response `{ items, nextCursor: string | null, total?: number }`. Cursor is base64url of `(sort_key, id)` (keyset). `total` only on request (`?count=true`) because `count(*)` per page is the dominant cost (`sessions.ts:155`). Keep `offset` accepted but deprecated.

### CR-28 · Medium · Users and invitations are one collection; invitation keyed by email; inconsistent naming
- Evidence: `GET /v1/users` returns `{ members, invites }` (`people.ts:218-227`); `/v1/invites/:email` (`:351-380`) puts the email in the path (PII in access logs and browser history); the user-facing list is `/v1/auth/invitations` (`:26`); route summaries say "properties" (`:26,35,390`), the schema says tenant, DOMAIN says Community; `/v1/tenant` (`auth.ts:92`) vs `/v1/community/export` (`:123`) vs `/v1/platform/tenants`.
- Fix: `GET /v1/users` → members only (`{items,nextCursor}`); new `/v1/invitations` collection with `GET`, `GET/PATCH/DELETE /:id`. Add `membership_invite.id uuid default gen_random_uuid()` (new migration `019_invite_ids.sql`); keep `/v1/invites/:email` as deprecated alias. Rename `/v1/auth/invitations` → `/v1/me/invitations` (alias kept). Replace "property" with "community" in summaries.

### CR-29 · Medium · Verb-style action endpoints
- Evidence: `POST /v1/sessions/:id/void` (`sessions.ts:106`), `POST /v1/passes/:id/regenerate|cancel` (`passes.ts:37,41`), `POST /v1/passes/redeem` (`:53`), `PATCH /v1/users/:id/verify` (`people.ts:289`), `POST /v1/platform/tenants/:slug/suspend|resume` (`:439,450`), `POST /v1/checkout`, `/v1/checkout/match` (`sessions.ts:65,82`), `POST …/import/:job/apply|rollback` (five places).
- Fix (non-breaking, add then deprecate): `PATCH /v1/sessions/:id { status: 'void', reason }`; `PATCH /v1/passes/:id { status: 'cancelled' }` and `POST /v1/passes/:id/qr-rotations` (regenerate creates a new QR); `PATCH /v1/users/:id { unitVerified: true }`; `PATCH /v1/platform/tenants/:slug { suspended: bool, reason }`; `POST /v1/passes/:id/redemptions`. `/v1/checkout` stays: it is a command that creates a payment and closes a stay; move the match preview to `GET /v1/sites/:site/open-sessions?plate=&ticket=` (read-only should be GET). Import verbs are covered by CR-30. Keep every old route as alias.

### CR-30 · Medium · Five copy-pasted import families; no job read; Units has no rollback
- Evidence: `slots.ts:254-300` (sites), `people.ts:183-215` (units: export/import/apply, **no rollback route**), `:302-349` (users), `auth.ts:119-165` (community), `inventory.ts:37-96` (inventory). Each re-implements the same job lookup, `dry_run`/`not_previewed` checks and `inventory_import` update. There is no `GET` for a job, so a preview cannot be re-fetched. Static words `export`/`import` share the path namespace with the `:code` param (CR-19).
- Fix: One `defineImportRoutes(kind, adapter)` factory; resources `POST /v1/imports { kind, mode, dryRun, doc }` → `201` job; `GET /v1/imports` (paged), `GET /v1/imports/:id`; `POST /v1/imports/:id/apply`, `POST /v1/imports/:id/rollback` (both `idempotent`); `GET /v1/exports/:kind`. Per-kind permission from the adapter. Add `rollback` to units (adapter returns a snapshot) or document why not. Old routes become aliases.

### CR-31 · Medium · Site scope is not applied on three reads
- Evidence: `GET /v1/rate-plans` filters on the optional `site` query only, not on `ctx.siteId` (`rates.ts:9-20`); `POST /v1/rate-plans/:id/quote` reads any plan by id (`:45`); `GET /v1/occupancy` computes `last24h` fees over **all** closed sessions with neither the `site` query nor `ctx.siteId` (`slots.ts:159-161`), while the rest of the response is site-filtered.
- Problem: A site-scoped API key can read other sites' plans and tenant-wide revenue; the dashboard "fees 24 h" tile (`Dashboard.tsx:40`) shows the whole tenant while labelled for the selected site. The second is a correctness bug visible to admins.
- Fix: Add `($n::uuid is null or rp.site_id = $n)` to the plan queries; for occupancy join `site` and reuse the `q.site` / `ctx.siteId` predicates exactly as `issuedPending` does (`slots.ts:166-169`). Add API tests for a site-scoped key on these three routes.

### CR-32 · Medium · PATCH has no concurrency token
- Evidence: no `updated_at`/`version`/ETag on `site`, `zone`, `slot`, `unit`, `membership`, `webhook_endpoint`, `tenant` (grep of migrations for `updated_at|row_version` returned nothing); `slots.ts:244-246` and `:93-96` write whole rows with `coalesce`.
- Problem: Two admins editing the same slot, or an offline edit replayed after a server edit, silently overwrite each other. This is the root of goal 7 for CRUD data.
- Fix: Add `version int not null default 1` plus `updated_at timestamptz(6)` bumped by a trigger; return `ETag: "<version>"`; PATCH accepts `If-Match`. Missing header is allowed for online callers, **required** (`428`) from the offline queue. Mismatch → `412` with the current representation in `details`. Schema/protocol details belong to the sync track; this package supplies the route support and the web `FormPage` plumbing.

### CR-33 · Medium · Permission model on one route differs per field; permissions differ across verbs of one resource
- Evidence: `PATCH /v1/slots/:code` declares `slot.status` (`slots.ts:220`) but checks `inventory.edit` for `type|attributes|zone` inside the handler (`:230`), so OpenAPI `x-permission` is misleading; sites: POST/DELETE need `inventory.edit` (`:27,57`), PATCH needs `settings.edit` (`:43`); webhooks use `settings.edit`, API keys `users.edit` (`auth.ts:168,206`); units are read by `read` but written by `users.edit`.
- Fix: Allow `perm` to be `{ default: P, fields?: Record<field, P> }` and emit both in `x-permission`. Align site PATCH to `inventory.edit`. Add a table of permission-per-route to `docs/` generated from the registry.

### CR-34 · Medium · OpenAPI says almost nothing about responses and misses routes
- Evidence: `http.ts` `openApiDocument()`: every operation has `responses: { '200', '4XX' }`; request bodies always `required: true`; path params always `{ type: 'string' }`; no response schemas; no `201/204/404/409/412`; `GET /v1/events` is registered with raw `app.get` (`misc.ts` near `:150`) so it is absent; `/v1/cron/*` are advertised as public operations; `PATCH /v1/pass-policy` and all imports declare `z.record(z.unknown())` (`passes.ts:80`, `slots.ts:262`).
- Fix: Add optional `responses: { 200?: Zod, 201?: Zod, 204?: null, … }` and `tags` to `RouteDef`; default `201` for POST creates; expose pagination parameters from the shared `Page` schema; register `/v1/events` through a `defineStreamRoute`; hide `/v1/cron/*` behind `x-internal: true`. Add a contract test: every Fastify route (`app.printRoutes`) is in `registry`, every `registry` entry has a 2xx response schema.

### CR-35 · Medium · Idempotency store is per tenant, not per actor/route, and stores unredacted secrets
- Evidence: `001_init.sql:223-231` primary key `(tenant_id, key)`; lookup `http.ts` `select … from idempotency_key where key = $1`; hash is `method + req.url + body` only.
- Problem: Two actors in a tenant that pick the same key for the same request replay each other's stored response (same hash required, so the exposure is low but real for fixed keys such as the web's `verify-${id}`). Secrets: see CR-22. The 7-day purge (`015_review_round2.sql:18`) is the only bound.
- Fix: Key on `(tenant_id, actor_id, key)` (actor = user id or API-key id) via a new migration; add `actor_id` to the lookup; per-route `redact`; document the 7-day replay window in OpenAPI.

### CR-36 · Low · Singleton resources are inconsistently named and shaped
- Evidence: `PATCH /v1/tenant` (no GET; read through `/v1/me`, `auth.ts:72,91`); `GET|PATCH /v1/pass-policy` (`passes.ts:73-89`); `GET /v1/community/export`; `PATCH /v1/me/profile`.
- Fix: `GET|PATCH /v1/community` (alias `/v1/tenant`), `GET|PATCH /v1/community/guest-pass-policy` (alias `/v1/pass-policy`), `GET|PATCH /v1/me`. Return the stored representation from PATCH.

### CR-37 · Low · `site` is sometimes a query param, sometimes body, sometimes path
- Evidence: query: `/v1/slots`, `/v1/sessions`, `/v1/units`, `/v1/rate-plans`, `/v1/occupancy`, `/v1/reports/shifts`; body: `POST /v1/rate-plans` (`rates.ts:25`), `POST /v1/sessions` (`sessions.ts:19`), `POST /v1/checkout`; path: zones.
- Fix: Convention in §2: path when the resource is owned by a site; query for cross-site filters. Body `site` stays only on commands that act on a site's open stays (`/v1/sessions`, `/v1/checkout`).

### CR-38 · Low · Avatar upload is POST and cannot be removed
- Evidence: `people.ts:80-104` `POST /v1/me/avatar` with `replaySafe`; no DELETE in `people.ts` (checked by reading all `avatar` hits).
- Fix: `PUT /v1/me/avatar` (idempotent replace; keep POST alias) and `DELETE /v1/me/avatar` (idempotent, also deletes the stored object).

### CR-39 · Low · Secrets and tokens in query strings
- Evidence: `GET /v1/passes/lookup?token=…` (`passes.ts:47-51`); SSE `access_token` and `tenant` query (`api.ts:eventsUrl`, `server.ts:96`).
- Problem: Query strings are logged by proxies and kept in browser history. Pass tokens last 2 h; the SSE token is the user's bearer.
- Fix: `POST /v1/passes/lookups { token }` (read-only POST, no store); keep SSE as is (EventSource cannot set headers) but have the API mint a 60-second `events` ticket from `POST /v1/events/tickets` and accept only that in the query.

### CR-40 · Medium · `sdk-ts` covers about 12 of 96 routes and its empty-body POSTs likely fail
- Evidence: `packages/sdk-ts/src/index.ts` covers check-in/out, sessions, slots, occupancy, quote, inventory import; nothing for sites, zones, units, users, keys, webhooks, passes, rate plans, imports of other kinds, audit, reports. `request()` always sets `content-type: application/json` (`:34`) so `applyInventory` / `rollbackInventory` (no body) send a JSON content type with an empty body. The web client documents that Fastify rejects exactly that (`apps/web/src/api.ts:32-33`). `JSON.parse(text)` is unguarded (`:42`), so an HTML error page from a proxy throws `SyntaxError`. `sessions()` query type lacks `sort`, `q`, `attendant`, `zone`. *(verify end to end; the Fastify behaviour is corroborated by the web comment, not run here.)*
- Fix: Omit `content-type` when `body === undefined`; try/catch the JSON parse and surface `OpenParkError(status, 'bad_response')`; generate resource clients from `/openapi.json` (or hand-write `sites`, `slots`, `units`, `users`, `apiKeys`, `webhooks`, `passes`, `ratePlans`, `imports`, `audit`) using the new nested paths; add `If-Match` support; test against the real `buildApp` instead of a mock `fetch` (`test/sdk.test.ts` is mock-based *(verify)*).

### CR-41 · Low · Reserved words can collide with codes in the same path position
- Evidence: static `/v1/sites/export`, `/v1/sites/import` (`slots.ts:256,261`), `/v1/units/export|import` (`people.ts:184,189`), `/v1/users/export|import` (`:303,308`) sit beside `/:code`/`/:id` routes. find-my-way gives static segments precedence, so a unit or site whose code is exactly `export` or `import` is unreachable by id.
- Fix: Covered by CR-19 (reserved codes) and CR-30 (`/v1/exports`, `/v1/imports`).

### CR-42 · Low · Inconsistent not-found vs forbidden for site-scoped keys
- Evidence: `slots.ts:60` `DELETE /v1/sites/:code` returns `403` for any request by a site-scoped key even when the site does not exist, while `resolveSite` returns `404` for a foreign site (`services/sessions.ts:39`); `POST /v1/sites` returns `403` (`slots.ts:30`).
- Fix: Rule: if the caller lacks the permission for the verb → `403`; if the caller has the permission but the target is outside their scope or absent → `404`. Move the `ctx.siteId` check into a `scope: 'tenant' | 'site'` field on `RouteDef` instead of per-handler `if`s.

### CR-43 · Low · Free-form `PATCH` bodies are not typed
- Evidence: `PATCH /v1/pass-policy` `body: z.record(z.unknown())` then re-parsed (`passes.ts:80-83`); all imports `z.record(z.unknown())`.
- Fix: Export `PassPolicy.partial()` as the body schema so OpenAPI, the SDK and the form share one definition.

### CR-44 · Low · Realtime stream bypasses the route registry and guards
- Evidence: `misc.ts` `app.get('/v1/events', …)` re-implements authenticate + permission + `501` fallback outside `defineRoute`.
- Fix: `defineStreamRoute` (see CR-34) so it appears in OpenAPI with `text/event-stream`, and it inherits the audit/permission wrapper.

## 5. Per-resource API route map (target)

Existing routes keep working as deprecated aliases (CR-23, 28, 29, 30, 36). `{ci}` = Idempotency-Key **required**, `{rs}` = replay-safe (optional key). All lists use the shared `Page` (CR-27).

| Resource | Collection | Item | Notes |
| --- | --- | --- | --- |
| Community | – | `GET|PATCH /v1/community` | alias `/v1/tenant`; guest pass policy at `/v1/community/guest-pass-policy` |
| Sites | `GET|POST{rs} /v1/sites` | `GET|PATCH|DELETE{rs} /v1/sites/:site` | PATCH needs `inventory.edit` |
| Zones | `GET|POST{rs} /v1/sites/:site/zones` | `GET|PATCH|DELETE{rs} …/:zone` | |
| Slots | `GET|POST{rs} /v1/sites/:site/slots` | `GET|PATCH|DELETE{rs} …/:slot` | `GET …/slots/suggestion` |
| Rate plans | `GET|POST{ci} /v1/sites/:site/rate-plans` | `GET /v1/rate-plans/:id` | `POST …/:id/versions{ci}`, `POST …/:id/quotes`, `PUT /v1/sites/:site/default-rate-plan{ci}` |
| Sessions | `GET /v1/sessions`, `POST{ci} /v1/sessions` (check-in) | `GET|PATCH{ci} /v1/sessions/:id` | `POST …/:id/checkout{ci}`, `POST …/:id/payments{ci}`, `GET …/:id/events` |
| Open stays (read) | `GET /v1/sites/:site/open-sessions?plate=&ticket=` | – | replaces `POST /v1/checkout/match` |
| Units | `GET|POST{rs} /v1/units` | `GET|PATCH|DELETE{rs} /v1/units/:unit` | |
| Users | `GET|POST{rs} /v1/users` | `GET|PATCH|DELETE{rs} /v1/users/:id` | `PATCH {unitVerified}` replaces `/verify` |
| Invitations | `GET /v1/invitations` | `GET|PATCH|DELETE{rs} /v1/invitations/:id` | replaces `/v1/invites/:email`; user view at `/v1/me/invitations` |
| API keys | `GET|POST{rs, redact} /v1/api-keys` | `GET|DELETE{rs} /v1/api-keys/:id` | |
| Webhooks | `GET|POST{rs, redact} /v1/webhooks` | `GET|PATCH|DELETE{rs} /v1/webhooks/:id` | `GET …/:id/deliveries` |
| Guest passes | `GET /v1/passes`, `POST{ci}` | `GET|PATCH{ci} /v1/passes/:id` | `POST …/:id/qr-rotations{ci}`, `POST /v1/passes/lookups`, `POST /v1/passes/:id/redemptions{ci}` |
| Imports/exports | `GET|POST{rs} /v1/imports` | `GET /v1/imports/:id` | `POST …/:id/apply{ci}`, `…/rollback{ci}`, `GET /v1/exports/:kind` |
| Platform tenants | `GET|POST{rs} /v1/platform/tenants` | `GET|PATCH /v1/platform/tenants/:slug` | members: `POST …/:slug/members{rs}` |
| Audit / reports | `GET /v1/audit` (paged) | – | `GET /v1/reports/shifts` |
| Me | – | `GET|PATCH /v1/me`, `PUT|DELETE /v1/me/avatar` | |

## 6. What is already good (do not regress)

- `defineRoute` centralises auth, permission check, tenant transaction, idempotency replay (`Idempotent-Replayed` header) and super-admin audit (`http.ts`); `registry` drives OpenAPI.
- `Idempotency-Key` plumbing exists end to end: `idempotent` (required) for money/session writes, `replaySafe` (optional) for CRUD creates, `platform_idempotency_key` for actor-scoped platform writes; 422 on key reuse with a different body; 409 `request_in_progress` on concurrent duplicates.
- Money is integer minor units; fee quote route is pure.
- RLS-based tenancy; `resolveSite` returns 404, not 403, for out-of-scope sites; codes (`*_not_found`, `*_exists`, `*_in_use`) are consistent and machine-readable.
- Resource nouns are plural and mostly kebab-case (`rate-plans`, `api-keys`).
- Public pass page keeps the token in the URL fragment on purpose (`main.tsx:11-14`, `GuestPass.tsx`): keep as is.
- Web client already has a payload-fingerprint-aware `useSubmitKey` (`components/hooks.ts:32-44`); promote it into the shared hook instead of rewriting it.
- `SPA` fallbacks exist for deep links on both Vercel and nginx.

## 7. Cross-track dependencies

- **Offline (goals 5-7):** CR-09 (persisted check-in draft), CR-25 (replay-stable DELETE), CR-32 (`If-Match`/version), CR-35 (per-actor idempotency), `sync` route name. The sync track owns the queue format and conflict policy; this track supplies routes, headers and URL contracts.
- **UX/shadcn track:** `ConfirmDialog`, `ListPage`, `DetailPage`, `FormPage`, row links, forbidden/not-found pages.
- **Clean-code track:** CR-20 boilerplate, CR-30 import factory, CR-13 duplicate UI.
- **i18n:** new screens add keys to all 7 locale files; `en-XA.json` is generated (AGENTS.md).
- **CSS guard:** `pnpm --filter @openpark/web check:css` bans physical `left/right`; new layouts must use logical properties.

## 8. Work packages

Rule for parallelism: **WP-00 must merge first** (it creates the route registry, primitives and shared API plumbing). WP-01 to WP-14 each own disjoint files, so they can run in parallel branches. Each package includes its own tests (vitest for web/api, one Playwright flow) and its own legacy redirect entry, listed in a per-package file that WP-00 imports with `import.meta.glob` so nobody edits a shared file.

| WP | Scope | Fixes | Owns (new/changed files) | Depends on | Size |
| --- | --- | --- | --- | --- | --- |
| **WP-00 Foundation** | Web: `routes/` registry (typed `paths.ts`, per-resource route modules auto-loaded, `legacy.tsx`), `useQueryState`, `useSiteParam`, `NotFound`/`Forbidden`, `?next=` login return, tenant-from-URL `TenantGate`, `ListPage/DetailPage/FormPage/ConfirmDialog` + shadcn `alert-dialog`, `useWrite` hook, menu from route table. API: `Page` schema, `created()`+`Location`, 201/204 rules, `RouteDef.responses/redact/deprecatedFor/scope`, DELETE `replaySafe` support, idempotency store keyed by actor + redaction (migration `019`), OpenAPI response emission, contract test, `defineStreamRoute` | CR-01, 02, 05, 06, 07, 12, 17 (partial), 18, 20, 26, 27, 32 (plumbing), 33, 34, 35, 42, 43, 44 | `apps/web/src/routes/*`, `components/{ListPage,DetailPage,FormPage,ConfirmDialog}.tsx`, `components/ui/alert-dialog.tsx`, `hooks/*`, `App.tsx`, `menu.ts`, `Shell.tsx`; `apps/api/src/http.ts`, `server.ts`, new migration | – | L |
| **WP-01 Sites & zones** | Sites list/new/detail/edit; zones list/new/edit; move AI threshold into `SiteEdit`; `GET` endpoints; delete `Parking.tsx` | CR-03, 04, 12, 19, 23 (zones), 24, 25 | `screens/sites/*`, `routes/sites.tsx`, `apps/api/src/routes/sites.ts` (split out of `slots.ts`) | WP-00 | M |
| **WP-02 Slots** | Nested slot API + aliases; Slots board with `?zone&status&type&view`; slot detail/new/edit; remove `/slots` inline editor | CR-02, 04, 16 (attributes), 23, 24, 25, 33 | `screens/slots/*`, `routes/slots.ts`, `apps/api/src/routes/slots.ts` | WP-00, WP-01 (site route param) | M |
| **WP-03 Rate plans** | Plans list/new/detail/edit/simulator; `versions`, `quotes` endpoints; advisory lock; scope fix | CR-15, 21, 31 (plans) | `screens/rates/*`, `routes/rates.tsx`, `apps/api/src/routes/rates.ts` | WP-00 | M |
| **WP-04 Sessions & attendant routes** | Sessions list/detail/void/payment; `GET /v1/sessions/:id`; keyset paging; attendant routes rename, persisted check-in draft, session page after check-in, check-out find/review split, `?ticket=`; remove router-state use | CR-02, 04, 09, 10, 11, 16, 24, 27, 29 (void, match) | `screens/sessions/*`, `screens/attendant/*` (split `Attendant.tsx` 820 lines), `apps/api/src/routes/sessions.ts` | WP-00; coordinate with offline track on draft storage | L |
| **WP-05 Units** | Units list/new/detail/edit; code regex migration; remove import card | CR-03, 04, 12, 13 (units card), 19, 24, 25 | `screens/units/*`, `apps/api/src/routes/units.ts` (split from `people.ts`) | WP-00 | S |
| **WP-06 Users & invitations** | Users list/new/detail/edit; invitations list/edit with `id` column; verify via PATCH; platform member placement moved to `UserNew` property picker | CR-03, 04, 12, 24, 25, 28, 29 (verify) | `screens/users/*`, `apps/api/src/routes/users.ts`, migration `019_invite_ids` (coordinate number with WP-00) | WP-00 | M |
| **WP-07 API keys** | List/new/detail with secret-once screen; replay-safe create with redaction | CR-12, 22, 24, 25 | `screens/integrations/api-keys/*`, `apps/api/src/routes/api-keys.ts` | WP-00 | S |
| **WP-08 Webhooks** | List/new/detail/edit; deliveries endpoint; replay-safe create with redaction | CR-12, 22, 24, 25 | `screens/integrations/webhooks/*`, `apps/api/src/routes/webhooks.ts` | WP-00 | S |
| **WP-09 Guest passes & resident** | Staff passes list/detail; policy screen; resident `/my/*` five routes; pass endpoints PATCH/qr-rotations/redemptions/lookups; token out of query | CR-03, 08, 12, 16, 24, 29, 39 | `screens/passes/*`, `screens/my/*`, `apps/api/src/routes/passes.ts` | WP-00 | M |
| **WP-10 Imports/exports** | `/v1/imports`, `/v1/exports`, job read, units rollback; one `ImportJob` UI; delete `Inventory.tsx`, `Bulk.tsx` | CR-13, 30, 41 | `screens/imports/*`, `apps/api/src/routes/imports.ts` (factory) | WP-00; adapters from WP-01/02/05/06 are re-exported, not edited | M |
| **WP-11 Platform, community, AI settings** | Tenants list/new/detail with suspend dialog; `/settings/community`, `/settings/ai`; `/v1/community`, `/v1/me` aliases; avatar PUT/DELETE | CR-12, 14, 36, 38 | `screens/platform/*`, `screens/settings/*`, `apps/api/src/routes/{community,platform}.ts` | WP-00 | S |
| **WP-12 Audit & reports screens** | `AuditLog` and `ShiftReport` with paging/filters | CR-16, 27 | `screens/audit/*`, `screens/reports/*` | WP-00 | S |
| **WP-13 SDK & OpenAPI** | SDK resource clients on nested paths, empty-body fix, `If-Match`, error parsing; real-app SDK tests; publish OpenAPI snapshot test | CR-40 | `packages/sdk-ts/*` | WP-00 (`responses`), then the API packages as they land | M |
| **WP-14 E2E & redirects** | Update `e2e/*.mjs` and `apps/web/test/*` to new URLs; one test per legacy redirect (including the hash and query cases); route-table snapshot test; back-button and reload tests for filters and detail pages | CR-02, 04, 05 | `e2e/*`, `apps/web/test/*` | rolling; final pass after WP-01..12 | M |

Suggested order: WP-00 → (WP-01, 03, 05, 07, 08, 11, 12 in parallel) → (WP-02, 04, 06, 09, 10) → WP-13 and WP-14 continuously.

Acceptance for every package: the screens in its rows of §2.1 exist and load by URL after a hard reload; every filter/tab/page is in the query string and survives reload and back; list rows are links; destructive actions use `ConfirmDialog`; POST/PATCH/DELETE send `Idempotency-Key`; old URLs from §2.2 redirect; `pnpm typecheck`, `pnpm test`, `pnpm --filter @openpark/web check:css` and the locale-key parity check pass.

## 9. Findings index

| Sev | Count | IDs |
| --- | --- | --- |
| High | 10 | CR-01, 02, 03, 04, 05, 09, 21, 22, 23, 24 |
| Medium | 22 | CR-06, 07, 08, 10, 11, 12, 13, 14, 15, 16, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 40 |
| Low | 12 | CR-17, 18, 19, 20, 36, 37, 38, 39, 41, 42, 43, 44 |

Total **44** findings.

## 10. Open questions I could not settle from the code

1. Should an attendant be allowed to open `/sessions` (list) and `/sessions/:id`, or only the attendant-scoped `/attendant/sessions/:id`? Today `sessions` is guarded `ops` (supervisor/admin) while the API grants `read` to attendants. I assumed attendants get the attendant-scoped detail only.
2. `membership_invite` is keyed by `(tenant_id, email)` in the schema (`003_roles_units_passes.sql:29`) while the code now writes multi-role invites (`people.ts:352-365` uses `roles`); I did not check migration `009_multi_roles.sql` for the final shape before proposing the `id` column.
3. Whether the app will keep supporting `x-tenant` header selection for API keys and users together with the URL slug; CR-07 assumes the URL slug wins for browsers and the header remains for API clients.
