# Tests

Every test in the project lives here, grouped by what it actually exercises.

| Directory | What it holds | Runner | Command |
|---|---|---|---|
| `unit/` | Vitest suites, mirroring the `src/` tree one-for-one. `unit/security/` holds the tenant-isolation suites, which provision a real disposable Postgres. | Vitest | `pnpm test:unit` |
| `e2e/` | Playwright specs plus the `harness/` that boots a server, seeds roles and fakes outbound services. | Playwright | `pnpm test:e2e` |
| `e2e/visual/` | Screenshot baselines for the public surfaces. Opt-in, not part of the default e2e run — see below. | Playwright | `pnpm test:visual` |
| `regression/` | Standalone Node scripts that check one shipped feature end to end against a running app. Each is self-contained and prints its own pass/fail. | `node` | `node tests/regression/<name>.mjs` |
| `artifacts/` | Output written by a run — the sanitized a11y report and the Lighthouse reports. Git-ignored. | — | — |

## Visual baselines

Playwright names snapshot files per project *and* per operating system, so the
files generated on macOS are not the files Linux CI compares against. The visual
suite therefore lives in its own pair of projects and is excluded from
`pnpm test:e2e`: a baseline that does not exist for the current platform would
otherwise fail every unrelated change.

The gate is wired in and required: `advisory.yml`'s visual job runs it on every
pull request and every push to `dev` and `master`, comparing against the
committed `*-linux.png` files.

Which is why regenerating is a two-sided job, and why doing only the first side
is what this section used to tell you to do:

- **macOS baselines** — `pnpm test:visual --update-snapshots`, then commit the
  `*-darwin.png` files. This is the half a developer can produce, and it is the
  half CI never looks at.
- **Linux baselines** — dispatch **Refresh Linux visual baselines**
  (`gh workflow run visual-baselines.yml`, optionally `-f grep=<filter>`),
  download the `linux-visual-baselines` artifact, unzip it over
  `tests/e2e/visual/`, and commit the files that changed for the reason you
  expect. The workflow rewrites the baselines on the runner that judges them and
  then re-runs the suite bare against the result — a baseline captured from a
  page that had not settled is accepted by `--update-snapshots` and fails on the
  next push, so that second run is the one that certifies it.

Do both. Skipping the second is not a cosmetic omission: it leaves the linux
baselines showing the old design, and they drift silently until a diff grows past
`MAX_DIFF_PIXEL_RATIO`. The alerts empty state moved to the table shell and its
mobile baseline failed at ratio 0.02 — while its desktop twin, stale in exactly
the same way, passed at roughly 0.0098.

## Conventions

Unit tests mirror their subject's path: `src/shared/lib/onboarding.ts` is tested by
`tests/unit/shared/lib/onboarding.test.ts`. They import the subject through the `~` alias
(`~/shared/lib/onboarding`) rather than a relative path, so moving either file does not break
the other.

A test that provisions a database belongs in `unit/security/` or `e2e/`, not in a plain `unit/`
suite — those are expected to run without external services.

Regression scripts are deliberately plain Node with no framework: they are written against a
deployed or locally running app, and several predate the Playwright harness. New end-to-end
coverage should go to `e2e/` instead.
