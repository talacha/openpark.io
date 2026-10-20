# OpenPark

Open-source parking platform: live slot counts, which car is in which slot, and exact stay time and fee at check-out. Design: [ARCHITECTURE.md](ARCHITECTURE.md).

## Run it

```bash
cp .env.example .env            # change the three secrets
docker compose up -d --build    # web :8080, api, postgres (+ one-shot migrator)
docker compose --profile ai up -d   # optional: ALPR worker + VLM server (off by default)
```

Open http://localhost:8080/signup. (`TRIAL_SIGNUP=true` in `.env.example` opens self-service signup; it defaults to off, see below.) Signup creates a tenant with a demo site (52 slots) and a rate plan from the country template.

## Develop

```bash
pnpm install
docker run -d --name openpark-pg -e POSTGRES_USER=openpark -e POSTGRES_PASSWORD=openpark -e POSTGRES_DB=openpark -p 54329:5432 postgres:16-alpine
pnpm --filter @openpark/core build
pnpm migrate                    # as the owner role; creates the RLS-bound openpark_app role
pnpm dev:api                    # :3000
pnpm dev:web                    # :5173, proxies /v1 to the API
pnpm dev:marketing              # :4321 (set PUBLIC_API_URL / PUBLIC_APP_URL)

pnpm test                       # core, api (needs Postgres at :54329 or TEST_ADMIN_URL), web, marketing, sdk
pnpm e2e                        # Playwright against running api + web (uses installed Chrome)
```

Python (`services/alpr`, `packages/sdk-py`): `pip install -e 'services/alpr[dev]' && pytest`.

## Layout

| Path | What | License |
| --- | --- | --- |
| `packages/core` | Fee engine, plate normalisation, inventory import/diff | AGPL-3.0 |
| `apps/api` | Fastify + Zod API, Postgres RLS migrations, pg-boss jobs, SSE | AGPL-3.0 |
| `apps/web` | React + Vite PWA: admin console and attendant app, 7 locales + pseudo-locale | AGPL-3.0 |
| `apps/marketing` | Astro static site for openpark.io | AGPL-3.0 |
| `packages/ui` | Design tokens and plate chip shared by app and marketing | AGPL-3.0 |
| `services/alpr` | Python ALPR worker: fast-alpr ONNX pair + optional VLM fallback | AGPL-3.0 |
| `packages/sdk-ts`, `packages/sdk-py` | Official SDKs, webhook verification | Apache-2.0 |
| `schemas/` | Inventory JSON Schema (draft 2020-12) | Apache-2.0 |
| `registry/plates/` | Plate-format registry, one file per region | Apache-2.0 |
| `deploy/` | Dockerfiles, nginx, Helm chart | AGPL-3.0 |

## Status against ARCHITECTURE.md

Built and tested: tenancy with Postgres RLS (isolation, append-only history and used-rate-plan immutability enforced by grants), check-in/check-out with idempotent writes and every exception in the table, fee engine (matches the worked example), versioned rate plans, audit timeline, shift report, inventory export/import with ranges, diff, conflicts and rollback, webhooks (HMAC, retried), SSE, API keys per tenant and site, roles, OpenAPI 3.1, offline-first attendant queue, localization with RTL and tenant terminology, ALPR worker with ONNX engine (verified end to end in containers), docker compose.

Not built yet:

| Gap | Note |
| --- | --- |
| Passkeys, OIDC/SAML | Email + password only (scrypt, HS256 session tokens). |
| S3 / Azure Blob / GCS storage | Interface exists; only local disk is implemented. |
| Terraform modules (AWS/GCP/Azure) | Helm chart exists but has not been linted or installed (no `helm` here). |
| Gate (MQTT/webhook), IP camera (RTSP/ONVIF), payment adapters, ESC/POS printers | Webhooks exist; adapters do not. |
| 3-5 frame character voting | `vote()` exists in the worker but `/v1/alpr/read` takes one image. |
| VLM fallback against a real model | Code and tests use fakes; no model was run. |
| Live plate box on the capture screen, QR scan at check-out, entry/exit crop side by side | Capture is a still frame; check-out takes a typed ticket code or plate. |
| Per-tenant model benchmark, training-data export, customer portal, Weblate | |
| `x-` extension keys | Accepted and validated on import, not persisted. |
| Device clock gap | Flagged as a warning; no supervisor approval step yet. |
| Translations (es-ES, pt-BR, fr, de, ar) | Drafts; have native speakers review before launch. |

## Closed preview: the trial feature flag

Self-service trial signup is behind a flag and **off by default** while OpenPark is in friends-and-family testing.

| Where | Flag | Off means |
| --- | --- | --- |
| API | `TRIAL_SIGNUP` (default `false`) | `POST /v1/signup` returns `403 signup_closed`; `GET /v1/config` reports `trialSignup: false` |
| App | reads `/v1/config` | No organisation signup. With Supabase Auth, invited people can still create an account; they join their organisation automatically |
| Marketing | `PUBLIC_TRIAL_SIGNUP` (build time, default off) | The trial form and "Try it free" buttons are replaced by a closed-preview notice and a sign-in link |

Onboarding testers while it is off: a platform super admin (`SUPERADMIN_EMAILS`) calls `POST /v1/platform/tenants` (or uses the Platform screen) to create an organisation and invite its owner by email. For invite-only on Supabase, also turn off "Allow new users to sign up" in the Supabase Auth settings and use *Invite user*.
To open the trial later: set `TRIAL_SIGNUP=true` on the API and `PUBLIC_TRIAL_SIGNUP=true` on the marketing site, and redeploy both.
