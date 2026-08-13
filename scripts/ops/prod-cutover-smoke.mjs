#!/usr/bin/env node
/**
 * Production role-cutover smoke/soak script (security-and-multitenancy tasks
 * 17/18). Plain fetch, no Playwright/e2e framework — a one-off operational
 * script, not part of the e2e harness.
 *
 * Exercises the same route families as scripts/db/verify-api-isolation-local.mjs
 * against the real deployed app, now running under least-privilege DB roles
 * (builderhunt_app/worker/auth/platform) instead of the bhuser superuser.
 *
 * Modes:
 *   --once   run one pass, print results, exit non-zero on any failure
 *   (default) loop continuously until --hours elapses, sleeping --interval-ms
 *             between passes — a soak that keeps the least-privilege roles
 *             under sustained traffic, since there are no real users yet to
 *             generate it organically. It no longer feeds a readiness gate:
 *             the shadow-read observation window it was built for is retired
 *             (see the note at the top of tenant-readiness.ts).
 *
 * Env: SMOKE_BASE_URL, SMOKE_EMAIL, SMOKE_PASSWORD
 */

// The default has to be the host the app is actually served on. It was
// `builderhunt.eduardoinerarte.dk` until 2026-08-13, four days after that hostname was dropped
// from the application's domains — every path on it answers `503 no available server` from the
// proxy, so an unattended run reported the whole route matrix as failing and the failure said
// nothing about the roles this script exists to exercise.
const BASE = process.env.SMOKE_BASE_URL || 'https://builderhunt.dev'
const EMAIL = process.env.SMOKE_EMAIL || 'edd_admin@local.com'
const PASSWORD = process.env.SMOKE_PASSWORD || 'Passw0rd!234'
const ONCE = process.argv.includes('--once')
const HOURS = Number(process.argv.find((a) => a.startsWith('--hours='))?.split('=')[1] ?? 24)
const INTERVAL_MS = Number(process.argv.find((a) => a.startsWith('--interval-ms='))?.split('=')[1] ?? 60_000)

const cookies = new Map()

function applySetCookie(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  for (const sc of raw) {
    const [pair] = sc.split(';')
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    cookies.set(pair.slice(0, eq), pair.slice(eq + 1))
  }
}

function cookieHeader() {
  return Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ')
}

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    // Origin is required by the app's own CSRF/origin check on cookie-
    // authenticated mutations (security-and-multitenancy task 12).
    headers: { 'Content-Type': 'application/json', Origin: BASE, ...(opts.headers ?? {}), Cookie: cookieHeader() },
    redirect: 'manual',
  })
  applySetCookie(res)
  return res
}

async function signIn() {
  const res = await req('/api/auth/sign-in/email', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASSWORD }) })
  if (!res.ok) throw new Error(`sign-in failed: ${res.status} ${await res.text().catch(() => '')}`)
}

async function check(name, fn) {
  try {
    const result = await fn()
    return { name, ok: true, detail: result }
  } catch (err) {
    return { name, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function okStatus(path, opts, expect = [200]) {
  const res = await req(path, opts)
  if (!expect.includes(res.status)) {
    const body = await res.text().catch(() => '')
    throw new Error(`${path} -> ${res.status}: ${body.slice(0, 300)}`)
  }
  return res.status
}

async function runPass() {
  const started = Date.now()
  await signIn()

  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  const results = []

  results.push(await check('dashboard-stats', () => okStatus('/api/dashboard/stats')))
  results.push(await check('me-builder', () => okStatus('/api/me/builder')))
  results.push(await check('explore-guest-search', async () => {
    // Anonymous guest path — deliberately without the session cookie.
    const res = await fetch(`${BASE}/explore?q=rust`)
    if (!res.ok) throw new Error(`explore -> ${res.status}`)
    return res.status
  }))
  results.push(await check('saved-queries-list', () => okStatus('/api/queries')))
  results.push(await check('saved-queries-create', async () => {
    const res = await req('/api/queries', {
      method: 'POST',
      body: JSON.stringify({ name: `soak-${runId}`, keywords: [`soak-${runId}`], sources: ['github'] }),
    })
    if (![200, 201].includes(res.status)) throw new Error(`create -> ${res.status}`)
    const data = await res.json()
    return data.id
  }))
  results.push(await check('alerts-list', () => okStatus('/api/alerts')))
  results.push(await check('sprints-list', () => okStatus('/api/sprints')))
  results.push(await check('exports-builders', () => okStatus('/api/export/builders')))
  results.push(await check('organizations-team', () => okStatus('/api/organizations/team')))
  results.push(await check('plans-me', () => okStatus('/api/plans/me')))
  results.push(await check('admin-incidents', () => okStatus('/api/admin/incidents')))
  results.push(await check('admin-metrics', () => okStatus('/api/admin/metrics')))
  results.push(await check('admin-metrics-conversion', () => okStatus('/api/admin/metrics/conversion')))
  results.push(await check('status', async () => {
    const res = await fetch(`${BASE}/api/status`)
    if (!res.ok) throw new Error(`status -> ${res.status}`)
    const data = await res.json()
    if (!data?.checks?.db?.ok) throw new Error(`db check failed: ${JSON.stringify(data.checks.db)}`)
    return data
  }))

  const durationMs = Date.now() - started
  const failed = results.filter((r) => !r.ok)
  return { at: new Date().toISOString(), durationMs, total: results.length, failed: failed.length, results }
}

async function main() {
  if (ONCE) {
    const pass = await runPass()
    console.log(JSON.stringify(pass, null, 2))
    process.exit(pass.failed > 0 ? 1 : 0)
  }

  const deadline = Date.now() + HOURS * 60 * 60 * 1000
  let iteration = 0
  let totalFailures = 0
  while (Date.now() < deadline) {
    iteration += 1
    const pass = await runPass().catch((err) => ({ at: new Date().toISOString(), error: err.message, failed: 1, total: 1, results: [] }))
    totalFailures += pass.failed ?? 1
    const remainingHours = ((deadline - Date.now()) / 3_600_000).toFixed(2)
    console.log(`[${pass.at}] iteration ${iteration}: ${pass.total - pass.failed}/${pass.total} ok, remaining ${remainingHours}h`)
    if (pass.failed > 0) {
      console.log(JSON.stringify(pass.results.filter((r) => !r.ok), null, 2))
    }
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS))
  }
  console.log(`Soak complete: ${iteration} iterations, ${totalFailures} total check failures.`)
  process.exit(totalFailures > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
