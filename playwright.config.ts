import { defineConfig, devices } from 'playwright/test'
import { randomBytes } from 'node:crypto'

// E2E runs against a real dev server + real local Postgres + real local
// Redis — never mocks. The Wave 1 Task 1 isolation harness owns one
// disposable PostgreSQL database and one Redis namespace per Playwright
// worker, so this config has to:
//   1. Set E2E_MODE=true for the vite dev server (gating test-only seams
//      in the app code, e.g. `src/shared/lib/rate-limit.ts` fail-closed).
//   2. Set REDIS_URL so the worker process can connect to the local
//      Redis instance (the in-memory fallback is forbidden in E2E mode).
//   3. Pick a per-run REDIS prefix so repeated invocations cannot collide.
//
// CI provisions its own disposable Postgres (see .github/workflows/quality.yml)
// and seeds env vars before this config's webServer starts the app. In CI,
// prefer the job's own APP_URL (already set for the rest of the quality job)
// so this config's server and the app's own baked-in base URL always agree.
// Locally, ignore process.env.APP_URL even if a shell/tooling layer injected
// it from `.env` (that value is baked for `pnpm dev`'s port, not this
// config's) and always use the fixed E2E dev port instead.
const baseURL =
  process.env.CI && process.env.APP_URL
    ? process.env.APP_URL
    : `http://localhost:${process.env.E2E_PORT ?? '3100'}`
const PORT = new URL(baseURL).port || '80'

// Pre-compute a single REDIS_URL pointing at the local Redis container.
// The container is expected to be running on the standard 6379 port (the
// repo's docker-compose.yml's `redis` service publishes it).
const redisURL = process.env.REDIS_URL ?? `redis://localhost:${process.env.REDIS_PORT ?? '6379'}`
// Wave 1 Task 1 — single global prefix for this run is the baseline;
// per-worker prefixes are derived inside `e2e/harness/cache.ts` and
// written into the test process's process.env.E2E_REDIS_PREFIX by the
// test's own beforeAll hook.
const e2eRunId = process.env.E2E_RUN_ID ?? `run-${randomBytes(4).toString('hex')}`

// The harness (`e2e/harness/env.ts`) runs inside the *test-runner* process,
// which does not inherit `webServer.env` below. This config file is loaded
// by that same runner process, so mirroring the E2E seam vars here makes a
// bare `pnpm test:e2e` work without exporting anything in the shell.
process.env.E2E_MODE ??= 'true'
process.env.REDIS_URL ??= redisURL
process.env.E2E_RUN_ID ??= e2eRunId

// Parallelism: the Wave 1 Task 1 isolation spec MUST run with --workers=2
// to prove isolation. Configured here as the default so a bare `pnpm
// exec playwright test e2e/harness/isolation.spec.ts` exercises the
// concurrency path the spec requires. Other suites can override via
// --workers=1 when they need serialized state — e.g. the existing
// team-accounts spec, which still shares fixtures.
const defaultWorkers = Number(process.env.E2E_WORKERS ?? '2')

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // team-accounts specs share one local DB — no cross-test isolation between orgs otherwise
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: defaultWorkers,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 30_000,
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // The full sequential release-matrix journey only needs to run once.
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, grepInvert: /@mobile-only/ },
    // Chromium-based mobile emulation (viewport + touch + UA), not WebKit —
    // keeps CI to a single browser engine install. This is checking
    // responsive layout/touch operability, not iOS Safari-specific
    // behavior, and only runs tests tagged `@mobile-only`.
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grep: /@mobile-only/ },
  ],
  webServer: {
    command: `pnpm exec vite dev --port ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    // The app's auth client bakes APP_URL/VITE_APP_URL into its own base URL
    // for API calls, read from `.env` regardless of which port `vite dev`
    // actually binds to — override both here so they always match this
    // config's own baseURL, or every request (starting with sign-up) 404s/
    // connection-refuses against whatever port `.env` happens to say.
    env: {
      APP_URL: baseURL,
      VITE_APP_URL: baseURL,
      // Wave 1 Task 1 — E2E seams. E2E_MODE gates the fail-closed path in
      // `src/shared/lib/rate-limit.ts` and is the marker the harness reads
      // via `e2eEnv()` to refuse to run in production mode.
      E2E_MODE: 'true',
      REDIS_URL: redisURL,
      E2E_RUN_ID: e2eRunId,
    },
  },
})
