# Adversarial review gate (OpenPark SDLC orchestration)

The adversarial reviewer is a separate sub-agent (different model from the implementer). It is read-only: it may run tests and use a local Postgres, but it must not modify the repo.

## Inputs the reviewer receives

- The implemented diff (files changed).
- The task spec (goal, scope, acceptance criteria) from `.agents/tasks/<task-slug>/spec.md`.
- Verification evidence: gate results (`pnpm --filter @openpark/core build`, `pnpm typecheck`, `pnpm test`, `pnpm --filter @openpark/web check:css`) and any new/extended test files.
- The list of already-fixed/accepted items (from prior iterations in `.agents/reviews/`) so it does not re-report them.

## What the reviewer checks (per acceptance criterion)

- Each route in `apps/api/src/routes/*.ts`: who can reach it, site-limited API-key scope, personal-data exposure (`/v1/sessions`, `/v1/audit`, `/v1/reports/shifts`, `/v1/me`, SSE, webhook payloads).
- Amounts: integer minor units, negatives, overrides without reason.
- Plate normalisation, simultaneous check-ins of one plate, ticket collisions.
- Screens still assuming a single `me.role`; camera stream release in `LiveCamera.tsx`/`QrScanner.tsx`.
- Web build behaviour if GitHub is unreachable for `scripts/fetch-models.mjs` (must fail loudly).
- Locale key/placeholder parity across all seven `apps/web/src/locales/*.json`; `en-XA.json` is generated (do not edit).
- New tables: RLS enabled + grant to `openpark_app`; history tables insert-only.
- Money: integer minor units everywhere.
- Webhooks: public addresses only; `WEBHOOKS_ALLOW_PRIVATE=true` for local dev/tests.

## Verdict output

Write `.agents/tasks/review-verdict.json`:

```json
{
  "verdict": "APPROVED" | "CHANGES_REQUESTED",
  "findings": [
    { "severity": "blocking|high|medium|low", "summary": "...", "detail": "...", "file": "...", "fix": "..." }
  ],
  "reviewedBy": "adversarial-reviewer",
  "reviewedAt": "...",
  "diffSha": "..."
}
```

- `APPROVED` → stop; gatekeeper may merge (human-confirmed) and deploy (human-confirmed).
- `CHANGES_REQUESTED` → implementer fixes each finding **with a test**, re-runs the gate, re-submits. Repeat until `APPROVED` or stop condition.

## Stop conditions (whichever comes first)

- Verdict `APPROVED` / no remaining blocking/high/medium findings.
- 10 fix-and-review iterations.
- 12-hour wall-clock from `.agents/reviews/run-start.txt` (`2026-10-21T03:52:23Z`).

## Hard stops (report, do not force past)

- `git push` rejected because the remote moved (never force-push).
- The verification gate cannot be made green after an honest fix attempt — never weaken, skip, or delete a test to go green.
- Any action that touches production/hosted infrastructure, applies a migration to a hosted DB, or exfiltrates secrets.

## Merge/deploy gates (human-confirmed only)

Before merge:
1. Verdict is `APPROVED`.
2. Gate is GREEN (all four commands above pass).
3. Commit identity: `git -c user.email=r@rob.cr commit`; no AI attribution lines.
4. Fast-forward onto `main`; normal push; never force-push.

Before deploy:
1. Merge already pushed to `origin/main`.
2. Explicit human confirmation (the controller does not deploy autonomously).
3. Vercel auto-deploys `main` to three projects: marketing (`www.openpark.io`), app (`app.openpark.io`), API (`api.openpark.io`).
