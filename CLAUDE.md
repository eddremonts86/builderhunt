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
