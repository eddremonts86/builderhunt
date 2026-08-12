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

## A plan has three homes, decided by outcome

| Root | Means |
|---|---|
| `plans/<phase>/` | live work: open or partial tasks remain, or it is `blocked` and waiting on something |
| `plans/implemented/<phase>/` | done and tested — no open *or* partial tasks, `implemented` in all three files |
| `plans/rejected/<phase>/` | `superseded` — never built, and never will be under this number |

```bash
git mv plans/phase-1/NN-name plans/implemented/phase-1/NN-name
git mv plans/phase-1/NN-name plans/rejected/phase-1/NN-name
```

Leaving a plan in its phase directory with a status header nobody reads is the failure this prevents:
`plans/phase-1/` has to answer "what is left?" honestly, and until 2026-08-11 it listed seven entries when
the real answer was two.

`blocked` moves nowhere. It is work waiting on a decision or a dependency, and the live directory is where
waiting work stays visible — filing it as rejected writes off work nobody cancelled.

`pnpm plans:check-implemented` enforces every root in both directions, in `pnpm ci:local` and in CI: a
finished plan left behind fails, an unfinished plan in the archive fails, a `superseded` plan outside
`rejected/` fails, and anything that is not `superseded` inside it fails. It also refuses a `- [x]` whose own
text says "not implemented" unless the task links the `plans/phase-5/` plan that now owns the work.

Each root is split by phase because plan numbers are unique only *within* one: phase 3 is numbered 01-13 and
twelve of those collide with phase 1's. The number never changes on a move — a two-digit prefix is the plan's
position in `plans/_meta/phase-1-order.md`, not its address — so a phase directory keeps gaps where moved
plans used to be, and `pnpm plans:check-order` reads all three roots as one contiguous 01..N sequence.

**Moving a plan means fixing its links, and the breakage is invisible in a diff.** Everything under `plans/`
navigates by relative path, and both archive roots sit one level deeper than a phase directory, so
`../../docs/x` becomes `../../../docs/x` — and every reference *to* the moved plan needs repointing too. Run
`pnpm plans:check-links` rather than reading the diff: it resolves all ~1,140 relative links under `plans/`
and it is the only thing that catches this. The 2026-08-11 archive move broke 54 links and the rejected move
broke another 41, across 20 files, with every link text unchanged and every path still looking plausible.
Why it matters: `phase-1-order.md` and every plan's `Depends on` header are navigation, and a plan nobody can
follow from its dependencies is a plan nobody reads.

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
