#!/usr/bin/env node
/**
 * Proves the production entrypoint actually *serves* its security posture.
 *
 * ## The gap this closes
 *
 * `server/security.mjs` has 22 unit cases and they are good ones. They prove the module returns the
 * right headers. **Nothing proved the server sends them**, because `server.prod.mjs` is started in
 * exactly one place — `start.sh` / the Dockerfile `CMD` — and no test, no e2e spec and no `ci:local`
 * step ever runs it. The e2e harness spawns `vite dev`; the accessibility gate uses `vite preview`.
 * Neither applies a single security header.
 *
 * That is the same failure this repository already fixed once, recorded in
 * `tests/unit/security/http-security.test.ts`: "a tested copy in `src/shared/lib/security/` that
 * nothing imported, and an untested inline copy in `server.prod.mjs` that actually shipped". The copies
 * were merged, but the *serving* stayed unverified — a header that a function returns and a server drops
 * looks identical from a unit test.
 *
 * So this boots the real entrypoint, makes real requests, and reads real response headers.
 *
 * ## Why it is a script and not a vitest file
 *
 * It needs `dist/`. `pnpm test` runs before `pnpm build` in the quality job, so a vitest file asserting
 * this would fail on a clean checkout for a reason that has nothing to do with the assertion. This runs
 * after the build step instead, which is also the only point at which the claim is even meaningful.
 *
 * Usage:
 *   pnpm build && node scripts/ci/verify-production-headers.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import net from 'node:net'

const SERVER_ENTRY = 'server.prod.mjs'
const BUILD_OUTPUT = 'dist/server/server.js'

if (!existsSync(BUILD_OUTPUT)) {
  console.error(`FAIL: ${BUILD_OUTPUT} is missing — run \`pnpm build\` first. This check is only meaningful against a build.`)
  process.exit(1)
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.unref()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

const port = await freePort()
const origin = `http://127.0.0.1:${port}`

/**
 * `NODE_ENV=production` with an http origin on purpose: it is the combination that must NOT emit HSTS,
 * and asserting the absence is how we know the flag is read rather than the header hardcoded.
 */
const child = spawn('node', [SERVER_ENTRY], {
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    HOST: '127.0.0.1',
    APP_URL: origin,
    VITE_APP_URL: origin,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let serverLog = ''
child.stdout.on('data', (chunk) => { serverLog += chunk })
child.stderr.on('data', (chunk) => { serverLog += chunk })

async function waitForServer(deadlineMs = 45_000) {
  const started = Date.now()
  while (Date.now() - started < deadlineMs) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${serverLog.slice(-1500)}`)
    try {
      // Any answered request proves it is listening. A 404 is fine — this check is about headers, and
      // headers are applied to every response path including the ones the app handler never sees.
      await fetch(`${origin}/__header_probe__`, { redirect: 'manual' })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
  }
  throw new Error(`server never answered on ${origin}:\n${serverLog.slice(-1500)}`)
}

const failures = []
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
    failures.push(name)
  }
}

try {
  await waitForServer()
  console.log(`server up on ${origin} (pid ${child.pid})\n`)

  // ── The site-wide posture, on an ordinary path ─────────────────────────────────────────────────
  const site = await fetch(`${origin}/`, { redirect: 'manual' })
  const siteCsp = site.headers.get('content-security-policy') ?? ''
  console.log('site-wide headers:')
  check('serves a Content-Security-Policy at all', siteCsp.length > 0, 'header absent')
  check("CSP has default-src 'self'", siteCsp.includes("default-src 'self'"), siteCsp.slice(0, 120))
  check("CSP has frame-ancestors 'none'", siteCsp.includes("frame-ancestors 'none'"))
  check('CSP still allows remote images site-wide', siteCsp.includes("img-src 'self' data: https:"))
  check('X-Content-Type-Options is nosniff', site.headers.get('x-content-type-options') === 'nosniff')
  // No security header may arrive twice. A repeated header is joined by the client, and a joined
  // `Content-Security-Policy` is not a stricter policy — it is two policies, each enforced.
  for (const name of ['content-security-policy', 'referrer-policy', 'x-frame-options', 'cache-control']) {
    const value = site.headers.get(name)
    check(`${name} is not duplicated`, value === null || !/(.+?),\s*\1/.test(value), value ?? '')
  }
  check('X-Frame-Options is DENY', site.headers.get('x-frame-options') === 'DENY')
  check('Referrer-Policy is strict-origin-when-cross-origin', site.headers.get('referrer-policy') === 'strict-origin-when-cross-origin')
  check('Permissions-Policy denies camera and microphone', (site.headers.get('permissions-policy') ?? '').includes('camera=()'))
  check('Cross-Origin-Opener-Policy is same-origin', site.headers.get('cross-origin-opener-policy') === 'same-origin')
  check('no CORS surface is advertised', site.headers.get('access-control-allow-origin') === null, site.headers.get('access-control-allow-origin') ?? '')
  // Production over http: the header must be absent, which proves `secure` is read.
  check('HSTS is absent over http even in production', site.headers.get('strict-transport-security') === null)

  // ── The candidate-facing scheduling surface ────────────────────────────────────────────────────
  console.log('\npublic scheduling headers (the strict variant):')
  for (const path of ['/schedule/probe-invitation', '/api/public/scheduling/probe-invitation/slots']) {
    const response = await fetch(`${origin}${path}`, { redirect: 'manual' })
    const csp = response.headers.get('content-security-policy') ?? ''
    check(`${path} drops remote images`, csp.includes("img-src 'self' data:") && !csp.includes("img-src 'self' data: https:"), csp.slice(0, 140))
    check(`${path} forbids iframes`, csp.includes("frame-src 'none'"))
    check(`${path} sends Referrer-Policy: no-referrer`, response.headers.get('referrer-policy') === 'no-referrer', response.headers.get('referrer-policy') ?? '')
    // Exact value, not `includes`. The looser form is what let a duplicated `Referrer-Policy` through on
    // the first run of this gate: `"no-referrer, no-referrer".includes('no-referrer')` is true.
    check(`${path} sends Cache-Control: no-store exactly once`, response.headers.get('cache-control') === 'no-store', response.headers.get('cache-control') ?? '')
    check(`${path} keeps the shared base directives`, csp.includes("default-src 'self'") && csp.includes('upgrade-insecure-requests'))
  }

  // A path that only *looks* like the scheduling surface must keep the site-wide policy. Without this
  // the prefix check could be `includes('schedule')` and nobody would notice.
  const lookalike = await fetch(`${origin}/schedules-report`, { redirect: 'manual' })
  check(
    '/schedules-report keeps the site-wide policy',
    (lookalike.headers.get('content-security-policy') ?? '').includes("img-src 'self' data: https:"),
    lookalike.headers.get('content-security-policy')?.slice(0, 120) ?? '',
  )

  // ── The CSRF mutation-origin gate, also never exercised over HTTP until now ────────────────────
  console.log('\nCSRF mutation-origin gate:')
  const foreign = await fetch(`${origin}/api/queries`, {
    method: 'POST',
    headers: { cookie: 'better-auth.session_token=x', origin: 'https://evil.test', 'content-type': 'application/json' },
    body: '{}',
    redirect: 'manual',
  })
  check('a cookie-bearing cross-origin mutation is refused 403', foreign.status === 403, `status=${foreign.status}`)
  check('the 403 still carries the security headers', (foreign.headers.get('content-security-policy') ?? '').length > 0)

  const noOrigin = await fetch(`${origin}/api/queries`, {
    method: 'POST',
    headers: { cookie: 'better-auth.session_token=x', 'content-type': 'application/json' },
    body: '{}',
    redirect: 'manual',
  })
  check('a cookie-bearing mutation with no Origin is refused 403', noOrigin.status === 403, `status=${noOrigin.status}`)

  const bearer = await fetch(`${origin}/api/queries`, {
    method: 'POST',
    headers: { authorization: 'Bearer nonsense', 'content-type': 'application/json' },
    body: '{}',
    redirect: 'manual',
  })
  // Not 403: a bearer-only request carries no cookie and is therefore not CSRF-exposed. It is
  // authorized (and here rejected) by the route's own check, which is a different answer.
  check('a bearer-only mutation is not blocked by the CSRF gate', bearer.status !== 403, `status=${bearer.status}`)
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
  failures.push('server startup')
} finally {
  child.kill('SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 300))
  if (child.exitCode === null) child.kill('SIGKILL')
}

console.log()
if (failures.length > 0) {
  console.error(`${failures.length} production header check(s) failed:`)
  for (const name of failures) console.error(`  - ${name}`)
  process.exit(1)
}
console.log('Every production header check passed.')
