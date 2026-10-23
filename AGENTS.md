# OpenPark — agent guidance

pnpm monorepo (TypeScript apps/packages) plus two Python projects. `ARCHITECTURE.md` is the design source of truth; `README.md` has the status table of what is/isn't built; `CLAUDE.md` duplicates some of this. `docs/DOMAIN.md` is the vocabulary reference.

## Workspace layout

| Path | What |
| --- | --- |
| `packages/core` | Fee engine, plate normalisation, inventory import/diff (pure TS, shared by API) |
| `packages/ui` | Design tokens + plate chip (React, peer dep) |
| `packages/sdk-ts` | TypeScript SDK |
| `packages/sdk-py` | Python SDK |
| `apps/api` | Fastify + Zod API, Postgres RLS migrations, pg-boss jobs, SSE |
| `apps/web` | React + Vite PWA (admin + attendant), 7 locales + pseudo-locale |
| `apps/marketing` | Astro static site |
| `services/alpr` | Python ALPR worker (ONNX, optional VLM fallback) |
| `e2e` | Playwright smoke scripts |
| `schemas/` | Inventory JSON Schema |
| `registry/plates/` | Plate-format registry (one JSON per region) |

## Required commands

```bash
pnpm install                          # pnpm 11, allowBuilds enables esbuild/sharp/onnxruntime-node scripts
cp .env.example .env                  # change POSTGRES_PASSWORD, OPENPARK_APP_PASSWORD, JWT_SECRET
docker run -d --name openpark-pg -e POSTGRES_USER=openpark -e POSTGRES_PASSWORD=openpark -e POSTGRES_DB=openpark -p 54329:5432 postgres:16-alpine
pnpm --filter @openpark/core build    # REQUIRED before api/sdk typecheck or run (they import core's dist/)
pnpm migrate                          # runs as the owner role (ADMIN_DATABASE_URL); creates the RLS-bound openpark_app role
pnpm dev:api                          # :3000
pnpm dev:web                          # :5173, proxies /v1 to the API
pnpm dev:marketing                    # :4321 (set PUBLIC_API_URL / PUBLIC_APP_URL)
pnpm typecheck
pnpm test                             # core, api, web, marketing, sdk-ts (api tests need Postgres at :54329 or TEST_ADMIN_URL)
pnpm e2e                              # Playwright against running api + web (uses installed Chrome)
pytest services/alpr packages/sdk-py -q   # Python (venv at services/alpr/.venv)
```

### Single test shortcuts

```bash
pnpm --filter @openpark/api exec vitest run -t "full flow"      # by name
pnpm --filter @openpark/core exec vitest run test/fees.test.ts  # by file
```

### Build/test order matters

1. Build `packages/core` first (it has no deps); api and sdk-ts import `core`'s `dist/`.
2. `pnpm build` runs all package builds; `prebuild` for api already rebuilds core.
3. CI runs: `pnpm install --frozen-lockfile` → core build → `pnpm typecheck` → `pnpm test` → `web check:css` → `web build` → `marketing build` → Python `pytest` → docker image builds.

## Web-specific gotchas

- **CSS logical properties only** — `pnpm --filter @openpark/web check:css` fails on physical `left`/`right` (RTL guard). Add `rtl-ok` to a line to exempt.
- **`en-XA.json` is generated** by `scripts/pseudo.mjs` during build — do not edit by hand.
- **Locale files must have identical keys/placeholders** across `apps/web/src/locales/*.json` — add new keys to every file.
- **Model files** are downloaded by `scripts/fetch-models.mjs` (SHA-256 pinned) into `apps/web/public/models/` and `public/ort/` (both git-ignored). `predev` runs it — network required; the build must fail loudly if GitHub is unreachable, not ship without the reader.

## API/database specifics

- Tenancy is enforced in Postgres (RLS on `app.tenant_id`), not app code. The API connects as role `openpark_app`; `Database.withTenant()` sets the setting per request.
- Cross-tenant lookups (login memberships, API-key resolve, tenant create) go through `SECURITY DEFINER` functions in `migrations/001_init.sql`.
- `session_event`, `audit_event`, `rate_plan` are insert-only for the app role — history is append-only; edits create a new version.
- New tables need RLS enabled plus a grant.
- Money is integer minor units everywhere.
- Routes use `defineRoute` / `definePublicRoute` (auth, permission check, tenant transaction, idempotency-key replay, post-commit hooks) — don't register raw Fastify routes for tenant endpoints.
- Webhooks may only target public addresses (`netguard.ts`, enforced at connect time). Set `WEBHOOKS_ALLOW_PRIVATE=true` for local dev and tests.
- Empty env strings are treated as unset (`config.ts`).

## Deploy & secrets

- Push to `main` only to ship; Vercel auto-deploys three projects (marketing `www.openpark.io`, app `app.openpark.io`, API `api.openpark.io`).
- Commit identity: `git -c user.email=r@rob.cr commit`. No Claude/AI attribution lines in commit messages.
- Never print secrets, never pass them as tool arguments, never write them to files. Generate in a shell variable and pipe via stdin (`printf %s "$S" | vercel env add NAME production --sensitive --yes`, `gh secret set` with `GH_TOKEN=$(gh auth token -u rmontero)`).
- `docker compose up -d --build` → web, api, postgres (+ one-shot migrator). `--profile ai` adds ALPR worker + VLM server.
- nginx resolves the API at request time via `DNS_RESOLVER` — keep that when changing the proxy.

## Feature flag

- `TRIAL_SIGNUP` defaults `false` (closed friends-and-family preview). `/v1/signup` returns `403 signup_closed` when off. Turn on for first-run setup, then off again.

## Maintenance

- Pass-reminder cron: `.github/workflows/pass-reminders.yml` calls `GET /v1/cron/pass-reminders` every 5 min (Vercel Hobby allows daily crons only). Needs `API_URL` and `CRON_SECRET` repo secrets.
- `pnpm-workspace.yaml` uses `allowBuilds` (pnpm 11) to permit esbuild/sharp install scripts.
- Supabase free tier pauses after ~1 week of inactivity; the 5-minute cron keeps it awake; built-in Supabase email is ~2/hour.