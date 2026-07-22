import { defineConfig, devices } from 'playwright/test'

// E2E runs against a real dev server + real local Postgres — not a mock.
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

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // team-accounts specs share one local DB — no cross-test isolation between orgs otherwise
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
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
    env: { APP_URL: baseURL, VITE_APP_URL: baseURL },
  },
})
