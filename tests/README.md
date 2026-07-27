# Tests

Every test in the project lives here, grouped by what it actually exercises.

| Directory | What it holds | Runner | Command |
|---|---|---|---|
| `unit/` | Vitest suites, mirroring the `src/` tree one-for-one. `unit/security/` holds the tenant-isolation suites, which provision a real disposable Postgres. | Vitest | `pnpm test:unit` |
| `e2e/` | Playwright specs plus the `harness/` that boots a server, seeds roles and fakes outbound services. | Playwright | `pnpm test:e2e` |
| `regression/` | Standalone Node scripts that check one shipped feature end to end against a running app. Each is self-contained and prints its own pass/fail. | `node` | `node tests/regression/<name>.mjs` |
| `artifacts/` | Output written by a run (currently the sanitized a11y report). Git-ignored. | — | — |

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
