---
inclusion: always
---

# Autonomous operation policy (overnight adversarial-review run)

The team has enabled Autopilot and authorized fully autonomous operation for this
project. Work without stopping to ask for approval, permission, or clarification.
Do not pause the run to pose a question. Keep moving and leave a reviewable trail.

## Standing decisions (already made — never re-ask these)

- **Overstay fine (req #5):** `$5000 MXN` is a **configurable per-tenant policy**,
  stored as `tenant.settings.passPolicy.overstayCharge` in integer minor units
  (`$5000 MXN = 500000`). Change only the **default/seed** so MXN-currency tenants
  get `500000` out of the box; do not hardcode it globally or for non-MXN tenants.
  The 12h overstay message states the configured amount (currency-formatted from the
  policy value, never a literal) plus the "move the vehicle" instruction. Build no new
  enforcement, billing, or payment-collection mechanism — it stays an announced charge.
- **Git flow:** after every loop iteration, once the gate is green, commit on the
  `adversarial-loop` branch, fast-forward `main` in the user's checkout, and
  `git push origin main`. Normal push only.
- **Loop stop condition:** 10 fix-and-review iterations, OR the reviewer reports no
  remaining blocking/high/medium findings, OR the wall-clock reaches **2:00 PM America/Mexico_City
  (20:00 UTC) on 2026-10-21** — whichever comes first. (This supersedes the earlier 12h-from-start
  ceiling; the user extended the time box. The 10-iteration and no-findings caps are unchanged, so
  the 10-iteration cap is the likely stop before the clock.)
- **Model/agent per step:** best high-capability model for planning, implementation,
  and adversarial review (reviewer on a different model from the implementer); the most
  affordable capable model for mechanical git/bookkeeping steps.

## How to resolve a question autonomously

When an ambiguous choice arises, do NOT ask. Pick the option that:
1. satisfies the seven acceptance criteria and the cross-cutting bars
   (UX, accessibility, mobile-first/responsive, performance, security);
2. is the lowest-risk and most reversible; and
3. matches existing patterns in the codebase (ARCHITECTURE.md, docs/DOMAIN.md, CLAUDE.md).

Then record the decision and its rationale in that iteration's review report and commit
message, and in `.agents/reviews/LOOP-SUMMARY.md`, so the team can review it in the morning.

## Hard limits that still require stopping (report, do not force past)

Autonomy does not override safety. STOP and report (do not silently work around) only if:

- a `git push` is rejected because the remote moved (never force-push);
- the verification gate (`pnpm --filter @openpark/core build && pnpm typecheck &&
  pnpm test` plus `pnpm --filter @openpark/web check:css`) cannot be made green after an
  honest fix attempt — never weaken, skip, or delete a test to go green;
- an action would be destructive beyond this repo/worktree, touch production or hosted
  infrastructure (deploy, apply migrations to a hosted DB), or exfiltrate secrets.

Everything short of those: decide and proceed.
