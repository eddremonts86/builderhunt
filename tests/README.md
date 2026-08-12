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

- **macOS baselines** — `pnpm test:visual --update-snapshots=all`, then commit the
  `*-darwin.png` files. This is the half a developer can produce, and it is the
  half CI never looks at.

  **`=all`, not a bare `--update-snapshots`.** Without a mode the flag presets to
  `changed`, and Playwright's "changed" means "exceeded `MAX_DIFF_PIXEL_RATIO`".
  Renaming the footer's cities moved every public surface and a bare
  `--update-snapshots` rewrote nothing at all — 22 passed, zero files touched —
  because one line of copy is a rounding error in a full-page screenshot. Drift
  under the threshold is precisely the drift that needs a deliberate refresh, since
  it is the drift nothing else will ever report.
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

### Look at a regenerated baseline before committing it

`pnpm visual:inspect` reads a PNG without trusting an image viewer:

```bash
pnpm visual:inspect voids tests/e2e/visual/<spec>-snapshots/<name>-linux.png
pnpm visual:inspect diff  <committed> <regenerated> /tmp/diff.png
pnpm visual:inspect crop  <file> /tmp/band.png <top> <rows>
```

**Why it exists.** On 2026-08-12 the refresh produced an `empty-dashboard` baseline
that looked committable and was not: a 751px band of `rgb(10, 10, 13)` — one
colour, no card borders — exactly where the action queue and the three headline
tiles belong. The page was the same height as a correct render to within 2px, and
the refresh's own re-run passed it twice, because a page missing half its widgets
renders identically every time. Committing it would have made a required gate
defend a dashboard with no numbers on it.

`voids` finds that. It also reports legitimate whitespace — a 232px run below a
mobile empty state is just the page under the content — so compare its
`rows with any content` against the **committed** file rather than judging a
number alone. Equal counts mean nothing vanished.

`diff` answers a question a ratio cannot: *where*. Font-rendering noise scatters a
few pixels over every glyph; a real layout change lands in one contiguous band, and
those two want opposite decisions. Worked example from the same refresh:

| baseline | strict drift | rows touched | verdict |
|---|---|---|---|
| `admin-claims-visual-mobile` | 0.042 | 69, all in 221–324 | one wrapped row |
| `admin-operations-visual-mobile` | 0.012 | 129, spread over 118–1921 | noise |
| `empty-exports-visual-mobile` | 0.000 | 1 | noise |

The first was **not** a code change: at 412px the source-filter input's intrinsic
width differs by a few pixels between platforms, which is enough to tip it past the
wrap boundary, so Linux puts it on its own row and macOS keeps it beside the last
chip. Both baselines are right for their platform. Worth knowing because a control
sitting one font-metric from wrapping will keep producing this churn — the
`-darwin` and `-linux` halves of that surface are expected to disagree
structurally, and a reviewer who assumes a 4% diff must be a regression will chase
it every time.

Strict drift (any channel moving more than 3/255) runs far above what the gate
measures — `toHaveScreenshot` applies pixelmatch's YIQ delta at threshold 0.2,
where 12.5% strict has scored 0.68%. So these numbers describe the change, not
whether CI will fail.

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
