# preflight

Verify that the OpenCode harness can reach the Vercel CLI and the GitHub CLI, and that it can commit code and create pull requests on behalf of the user.

This is a **definition of checks**, not a script to execute blindly. A future agent runs each command read-only where possible, observes the outcome, and reports back. Do **not** push to a remote, do **not** create an actual PR (`gh pr create`), do **not** force-push, do **not** rewrite history.

## Repo context (observed)

- Root instruction files: `AGENTS.md` and `CLAUDE.md` exist at the repo root.
- No existing skill directory: no `.opencode/`, no `skills/`, no `.cursor/rules/`.
- Git remote `origin` = `gh-talacha:talacha/openpark.io.git` (fetch + push), current branch `main`.
- Local git identity: `user.name=Rob Montero`, `user.email=roberto@montero-ortiz.com` (global: `Roberto Montero` / `roberto@montero-ortiz.com`).
- Commit convention (from `AGENTS.md`): commits use `git -c user.email=r@rob.cr commit`; **no AI-attribution lines** in commit messages.
- `.vercel/project.json` links this directory to Vercel project `openpark.io` (org `team_...`).
- Vercel hosts three projects: marketing `www.openpark.io`, app `app.openpark.io`, API `api.openpark.io` (see `README.md` / `ARCHITECTURE.md`).

## Prerequisites

The harness must have these CLIs on `PATH` and authenticated:

- `vercel` (Vercel CLI)
- `gh` (GitHub CLI)
- `git`

## Checks to run

Run each command in the repo root unless noted. Record the exact output and exit code.

| # | Command | What it confirms | Expected outcome | Failure mode |
|---|---------|------------------|------------------|--------------|
| 1 | `vercel whoami` | Vercel CLI is installed and logged in as a user | Prints the logged-in Vercel username/email; exit 0 | Not installed, not logged in, or exit non-zero → run `vercel login` (interactive) and retry |
| 2 | `vercel projects ls` | Vercel CLI can list projects under the authed account | Lists projects; expect to see the three OpenPark projects (marketing `www.openpark.io`, app `app.openpark.io`, API `api.openpark.io`); exit 0 | Empty list, auth error, or exit non-zero → token/scope issue; re-auth with `vercel login` |
| 3 | `gh auth status` | GitHub CLI is installed and authenticated | Shows logged-in GitHub user and active scopes; exit 0 | Not installed, `gh auth login` required, or exit non-zero |
| 4 | `gh repo view` | GitHub CLI can read the current repo | Prints repo metadata for `talacha/openpark.io` (or the linked origin); exit 0 | Wrong repo context, not authenticated, or exit non-zero |
| 5 | `git status` | Working tree is readable by git | Prints branch and clean/dirty status; exit 0 | Not a git repo, or exit non-zero |
| 6 | `git log --oneline -3` | Git history is readable | Prints the last 3 commits; exit 0 | No commits yet, or exit non-zero |
| 7 | `git branch --show-current` | Current branch is identifiable | Prints `main`; exit 0 | Detached HEAD or exit non-zero |

## Commit-code confirmation

Meaning: the harness can author a local commit using the repo's commit-identity convention.

Command (run once, **local-only — do not push**):

```bash
git -c user.email=r@rob.cr commit --allow-empty -m "preflight: verify commit access"
```

Expected outcome:
- Creates one empty local commit on the current branch; exit 0.
- The commit must use `user.email=r@rob.cr` (override) and must contain **no AI-attribution lines** (e.g. no "Co-Authored-By: Claude" or similar).

Failure modes:
- `user.email` override not honored → check local/global git config.
- Commit blocked by pre-commit hooks or empty-commit restriction → `--allow-empty` should bypass the latter; inspect hook output.
- Do **not** run `git push` — that mutates remote state. If remote push access must be confirmed separately, do it only with explicit user approval.

## Create-PRs confirmation

Meaning: the `gh pr` subcommand exists and the harness is authenticated to GitHub, so a PR *could* be created if asked. Do **not** actually create a PR.

Commands:

```bash
gh pr --help
gh pr create --help
gh api user
```

Expected outcomes:
- `gh pr --help` and `gh pr create --help` both print usage and exit 0 → the `pr` and `pr create` subcommands exist.
- `gh api user` returns the authenticated GitHub user JSON and exit 0 → auth is good.

Failure modes:
- `gh: 'pr' is not a git command` / unknown subcommand → GitHub CLI too old or broken; reinstall.
- `gh api user` returns `401` or `Not Found` → not authenticated; run `gh auth login`.

## Expected overall outcome

All of checks 1–7 exit 0, the empty local commit succeeds with `user.email=r@rob.cr`, and `gh pr create --help` confirms the PR subcommand exists with `gh api user` authenticated. If every check passes, the harness is cleared to commit code and create pull requests on the user's behalf (push and PR creation still require explicit user approval).

## Caveats

- `vercel whoami` / `vercel projects ls` / `gh auth status` / `gh repo view` are read-only against the remote, but `vercel login` / `gh auth login` are interactive and may open a browser — only run those with user consent.
- The empty commit (`git commit --allow-empty`) mutates local git history (adds a commit). It is local-only and must not be pushed.
- The Git remote uses an SSH-style alias (`gh-talacha:...`); ensure SSH agent/key is available if any remote operation is later approved.
- The three Vercel projects (marketing/app/API) are referenced by name; `vercel projects ls` is the check that they are visible to the authed Vercel account.
