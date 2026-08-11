# Working in this repository

## Test runs: at least 6 workers, or 80 % of the machine's cores

Whichever is higher. On a 14-core machine that is 11.

```bash
pnpm test:e2e --workers=11
```

The full chromium suite takes 2 min 53 s at `--workers=6` and 7.6 min at `--workers=1` on a
14-core Mac. **Do not default to `--workers=1` "to be safe"** — that habit costs hours across a
session. Shut the dev server down before a parallel run; competing with Vite for cores is what
produces the collapse that gets misread as parallelism being unsafe.

The CI gate (`ci:local`, `.github/workflows/quality.yml`) stays at `--workers=1` for a
**correctness** reason, not a resource one. Iterate parallel, gate serial, and do not change the
gate on the strength of one green parallel run. The full reasoning, including the failure modes
each mode catches that the other hides, is in
[`docs/operations/development.md`](./docs/operations/development.md#running-the-test-suites--worker-count).

## Before reporting something as done

- Capture exit codes to a file and check them directly. A pipeline's exit status is the *last*
  command's, so `pnpm type-check | tail` reports `tail` succeeding.
- Unit tests connect as a superuser and therefore bypass GRANTs and RLS. Evidence that a
  tenant boundary holds has to come from e2e or `pnpm test:rls:local`.
- Nothing ships until `pnpm ci:local` has zero failed steps.

## Finish a plan, move it

A plan with no open or partial tasks whose three files all say `implemented` is finished, and a finished
plan lives in `plans/implemented/<phase>/` — not in its phase directory with a status header nobody reads.

```bash
git mv plans/phase-1/NN-name plans/implemented/phase-1/NN-name
```

`pnpm plans:check-implemented` enforces it in both directions and runs in `pnpm ci:local` and in CI: a
finished plan left behind fails, and an unfinished plan in the archive fails. It also refuses a `- [x]`
whose own text says "not implemented" unless the task links the `plans/phase-5/` plan that now owns the
work.

The archive is split by phase because plan numbers are unique only *within* one: phase 3 is numbered 01-13
and twelve of those collide with phase 1's.

**Moving a plan means fixing its links.** Everything under `plans/` uses relative paths, and the archive
sits one level deeper than a phase directory, so `../../docs/x` becomes `../../../docs/x`. Verify with the
resolver rather than by eye — the move on 2026-08-11 touched 411 references and 54 of the breaks were
pure depth shifts. Why it matters: `plans/_meta/phase-1-order.md` and every plan's `Depends on` header are
navigation, and a plan nobody can follow from its dependencies is a plan nobody reads.

## Deploys

A push to `master` that goes green on Quality **deploys to production and applies migrations**
(`.github/workflows/deploy.yml`). Treat merging to `master` as a release, and confirm before
pushing there. See [`docs/operations/deploy-runbook.md`](./docs/operations/deploy-runbook.md) and
[`docs/operations/host-maintenance.md`](./docs/operations/host-maintenance.md).

## Migrations

Never edit a migration file under `drizzle/` that has already been applied — drizzle-kit hashes
migration contents, so changing even a comment makes it re-run. Add a new one instead. Parallel
sessions collide on the migration *number* before they collide on anything else; check the highest
existing one before generating.
