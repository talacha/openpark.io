# OpenPark SDLC Orchestration Plan

Purpose: a planner/dispatcher/controller that spawns sub-agents to tackle SDLC tasks, with an adversarial review gate before merge and a human-gated deploy. Built on the existing `.agents/` review loop (iterations 1–10 in `.agents/reviews/`, plan in `.agents/tasks/plan.md`, verdicts in `.agents/tasks/review-verdict.json`).

## Roles

| Role | Responsibility | Tool used |
| --- | --- | --- |
| **Planner** | Decompose a goal into ordered, verifiable SDLC tasks (plan → implement → review → verify → merge → deploy). Writes the task spec. | This document + `scripts/dispatch.mjs` |
| **Dispatcher** | Spawns a sub-agent per task with exact instructions, entrypoints, and acceptance criteria. Records each task under `.agents/tasks/`. | `scripts/dispatch.mjs` |
| **Controller** | Tracks task state (queued / in-review / fixing / approved / blocked), enforces the review gate, and holds merge/deploy until approved. | `scripts/dispatch.mjs` |
| **Adversarial Reviewer** | Read-only review of the implemented diff + verification evidence. Writes `.agents/tasks/review-verdict.json` (`APPROVED` or `CHANGES_REQUESTED` with findings). Must not modify the repo. | Separate sub-agent |
| **Gatekeeper** | When verdict is `APPROVED` and the gate is green, merges to `main` (fast-forward, never force) and — only with explicit human confirmation — deploys. | Human + `scripts/dispatch.mjs` |

## SDLC workflow (per task)

1. **Plan** — Planner writes a task spec: goal, files in scope, entrypoints, acceptance criteria, verification commands.
2. **Dispatch** — Dispatcher spawns an implementer sub-agent with the spec.
3. **Implement** — Implementer writes code + tests, runs the local verification gate.
4. **Review** — Adversarial reviewer (different model from implementer) reviews the diff + evidence, writes `review-verdict.json`.
5. **Fix loop** — If `CHANGES_REQUESTED`, implementer fixes each finding with a test, re-runs the gate, re-submits for review. Repeat.
6. **Gate** — Gate must be GREEN before merge:
   - `pnpm --filter @openpark/core build`
   - `pnpm typecheck`
   - `pnpm test`
   - `pnpm --filter @openpark/web check:css`
7. **Merge** — Fast-forward onto `main`, normal push, never force-push. Requires gate green + verdict `APPROVED`.
8. **Deploy** — Only with explicit human confirmation. Vercel auto-deploys `main` to three projects (marketing `www.openpark.io`, app `app.openpark.io`, API `api.openpark.io`).

## Safety rules (hard stops — report, do not force past)

- Never force-push; never rewrite pushed history unless the owner asks.
- Never apply a migration to a hosted DB or touch production/hosted infrastructure from the controller. Local test-DB migrations only.
- Never exfiltrate or print secrets; never pass secrets as tool arguments; never write secrets to files.
- Merge/deploy require explicit human confirmation — the controller does not autonomously push to `main` or trigger production deploys.
- Never weaken, skip, or delete a test to make the gate green.

## Integration points (already in repo)

- Verification gate: `.agents/tasks/plan.md` section "Verification gate" (same four commands above).
- Review trail: `.agents/reviews/LOOP-SUMMARY.md`, `review-iter-01.md`…`review-iter-10.md`, `run-start.txt`.
- Task state: `.agents/tasks/plan.md`, `review.json`, `review-verdict.json`, `task-epd-feedback/`.
- Commit identity: `git -c user.email=r@rob.cr commit`, no AI attribution lines.
- Vercel: three projects auto-deploy from `main`; repository secrets `API_URL` and `CRON_SECRET` drive the 5-minute pass-reminder cron (`.github/workflows/pass-reminders.yml`).

## Where new task state lives

- `.agents/tasks/<task-slug>/` — one directory per dispatched task: `spec.md`, `status.json`, `evidence/`, `review-verdict.json`.
- `.agents/tasks/review-verdict.json` — current active verdict (`APPROVED` / `CHANGES_REQUESTED` + findings).
- `.agents/tasks/plan.md` — the active implementation plan (updated as tasks complete).
