import { defineConfig, devices } from 'playwright/test'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

/**
 * The local E2E port, read from `.env` in preference to the environment.
 *
 * That precedence looks backwards and is not. This file is evaluated **twice per run in different
 * environments**: once by the main process at startup, and again by every worker process. `pnpm
 * test:e2e` is a bare `playwright test` with no dotenvx wrapper, so at the first evaluation
 * `process.env.E2E_PORT` is unset and the fallback wins — but something in the module graph then
 * pulls in dotenvx, which injects `.env` with `override: true`. By the time a worker re-evaluates
 * this file, `E2E_PORT` *is* set, to `.env`'s value.
 *
 * The result was a main process starting `vite dev` on 3100 while every worker asked for 3120, and
 * `override: true` means the environment cannot win that argument — so this reads `.env` first and
 * both evaluations agree on the same number. An exported `E2E_PORT` still works when `.env` is
 * silent, which is what CI and a one-off `E2E_PORT=… pnpm test:e2e` rely on.
 *
 * How it hid: nearly every spec runs against a per-worker server from tests/e2e/harness/server.ts,
 * so ~919 tests passed and only the handful using this shared baseURL failed — `ECONNREFUSED`, ~700
 * tests in, in specs that pass when run alone. Any stray server on the `.env` port masks it
 * completely, which is what made it read as flake. `scripts/ci/local-quality.sh` now refuses to
 * start when that port is occupied, so the mask is gone too.
 */
function localE2EPort(): string {
  try {
    const match = /^E2E_PORT=(\d+)/m.exec(readFileSync(join(process.cwd(), '.env'), 'utf8'))
    if (match) return match[1]
  } catch { /* no `.env` — CI passes the port through APP_URL instead */ }
  return process.env.E2E_PORT ?? '3100'
}

const baseURL =
  process.env.CI && process.env.APP_URL
    ? process.env.APP_URL
    : `http://localhost:${localE2EPort()}`
const PORT = new URL(baseURL).port || '80'

// Pre-compute a single REDIS_URL pointing at the local Redis container.
// The container is expected to be running on the standard 6379 port (the
// repo's docker-compose.yml's `redis` service publishes it).
/**
 * `127.0.0.1`, not `localhost`, and the difference is a whole afternoon.
 *
 * This file is evaluated by a bare `playwright test` with no dotenvx wrapper (see the comment above),
 * so `.env`'s `REDIS_URL=redis://127.0.0.1:6379` is often **not** in `process.env` yet and this
 * fallback is what the webServer actually gets. On macOS `localhost` resolves to `::1` first, while
 * docker-compose publishes Redis on IPv4 — so the app cannot reach Redis, and
 * `rate-limit.ts` **fails closed under E2E_MODE by design**.
 *
 * The symptom is nothing like the cause: every sign-up is refused with "Too many accounts created
 * from this device recently", while every counter in Redis reads 1. The message describes a limit that
 * was never consulted.
 */
const redisURL = process.env.REDIS_URL ?? `redis://127.0.0.1:${process.env.REDIS_PORT ?? '6379'}`
// Wave 1 Task 1 — single global prefix for this run is the baseline;
// per-worker prefixes are derived inside `tests/e2e/harness/cache.ts` and
// written into the test process's process.env.E2E_REDIS_PREFIX by the
// test's own beforeAll hook.
const e2eRunId = process.env.E2E_RUN_ID ?? `run-${randomBytes(4).toString('hex')}`

// The harness (`tests/e2e/harness/env.ts`) runs inside the *test-runner* process,
// which does not inherit `webServer.env` below. This config file is loaded
// by that same runner process, so mirroring the E2E seam vars here makes a
// bare `pnpm test:e2e` work without exporting anything in the shell.
process.env.E2E_MODE ??= 'true'
process.env.REDIS_URL ??= redisURL
process.env.E2E_RUN_ID ??= e2eRunId

// Parallelism: the Wave 1 Task 1 isolation spec MUST run with --workers=2
// to prove isolation. Configured here as the default so a bare `pnpm
// exec playwright test tests/e2e/harness/isolation.spec.ts` exercises the
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
  // 30s locally, 90s on CI.
  //
  // Not a concession to flake. The e2e harness runs `vite dev`, which compiles a route tree the
  // first time something asks for it, and a cold GitHub runner is several times slower at that than
  // a developer laptop with a warm cache. Specs that cross two route trees — `/admin/claims`
  // redirecting a non-admin to the dashboard, the calendar page — spent the whole 30s budget on
  // compilation and failed with a screenshot showing skeletons, which reads as a broken page and is
  // a build step. Individual specs already carry `test.setTimeout(120_000)` for exactly this, with
  // the same explanation; this stops the next one having to rediscover it.
  //
  // Production never pays it: it serves a build, not a dev server.
  timeout: process.env.CI ? 90_000 : 30_000,
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Screenshot baselines are per-OS: the files a developer generates on macOS
  // are not the files Linux CI compares against. Both sets now exist — 22 darwin
  // and 22 linux — so the note that used to stand here, that the suite stayed
  // opt-in "until Linux baselines exist", is spent. It is still its own projects
  // (`pnpm test:visual`), and the quality workflow runs them as their own step,
  // before the preview server binds the port they need.
  //
  // `testIgnore` on the two default projects is only half of that: a bare
  // `playwright test` runs EVERY project, so `test:e2e` names the two it wants
  // explicitly. Dropping that filter silently puts the visual suite back in CI.
  projects: [
    // The full sequential release-matrix journey only needs to run once.
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      grepInvert: /@mobile-only/,
      testIgnore: /visual\//,
    },
    // Chromium-based mobile emulation (viewport + touch + UA), not WebKit —
    // keeps CI to a single browser engine install. This is checking
    // responsive layout/touch operability, not iOS Safari-specific
    // behavior, and only runs tests tagged `@mobile-only`.
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grep: /@mobile-only/, testIgnore: /visual\// },
    // Opt-in: `pnpm test:visual`. Same two viewports, but only the screenshot
    // baselines, so a deliberate design change regenerates exactly those files.
    {
      name: 'visual-desktop',
      testDir: './tests/e2e/visual',
      use: { ...devices['Desktop Chrome'] },
      grepInvert: /@mobile-only/,
    },
    {
      name: 'visual-mobile',
      testDir: './tests/e2e/visual',
      use: { ...devices['Pixel 7'] },
      grep: /@mobile-only/,
    },
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
      // Invite-only sign-up is deliberately NOT pinned here.
      //
      // An earlier attempt set ACCESS_ALLOWLIST_ENABLED='false' in this block and it did nothing:
      // dotenvx loads `.env` over `process.env` with `override: true`, so whatever a developer has in
      // `.env` wins over anything passed here. Worth remembering before pinning any other flag this
      // way.
      //
      // The suite therefore runs with the gate in whatever state the environment says, and the
      // fixtures cope: `allowlistEmailForSignup` in harness/fixtures/principals.ts pre-approves each
      // principal's address before sign-up. That keeps the gate under test in its real configuration
      // instead of switching it off to make fixtures pass.
      REDIS_URL: redisURL,
      E2E_RUN_ID: e2eRunId,
      /**
       * The per-device signup limit, raised for the harness only.
       *
       * `SIGNUP_DEVICE_DAILY_LIMIT` defaults to **3** and keys on a hash of the device cookie, the UA
       * family and `BETTER_AUTH_SECRET` over a 24-hour window. `team-accounts.spec.ts` alone signs up
       * three accounts from one machine by design, so a full run exhausts the budget and the *next*
       * test to sign up fails with "Too many accounts created from this device recently" — a failure
       * that looks like a broken sign-up flow and is a working abuse control doing its job.
       *
       * Raised rather than disabled: the gate stays in the request path, so a regression that breaks it
       * still surfaces. And it is safe to pin here for the reason the comment above explains in the
       * negative — dotenvx overrides only keys that exist in `.env`, and this one lives only as a
       * default in `env.ts`.
       */
      SIGNUP_DEVICE_DAILY_LIMIT: '500',
      /**
       * The segmented landing pages, on for the shared server (plan: phase-2/06-landing-segmentada).
       *
       * `segmented-landing.spec.ts` is about what a crawler and an anonymous visitor receive from
       * those three URLs, and it uses this shared server rather than a per-worker one. With the flag
       * at its default the routes 404 and the whole file tests a feature that is switched off.
       *
       * Safe to pin here for the reason the `ACCESS_ALLOWLIST_ENABLED` note above explains in the
       * negative: dotenvx overrides only keys that are present in `.env`, and this one lives solely
       * as a default in `env.ts`. Adding it to a personal `.env` would take that back.
       *
       * The *off* state is covered separately, on a per-worker server whose environment the harness
       * controls — see `segmented-landing-flag.spec.ts`.
       */
      SEGMENTED_LANDING_ENABLED: 'true',
      // On for the shared server, so any spec that visits `/u/<handle>` or `/for/builders` through
      // it sees the feature as it ships. The two self-managed specs spawn their own worker servers
      // and declare the flag themselves — on in `self-managed-profile.spec.ts`, off in
      // `self-managed-flag.spec.ts` — because a per-worker server inherits `process.env`, not this.
      SELF_MANAGED_PROFILES_ENABLED: 'true',
    },
  },
})
