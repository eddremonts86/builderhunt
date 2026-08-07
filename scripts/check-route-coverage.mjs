// Every route under src/routes/api/** must either use a recognized auth
// guard or be explicitly allowlisted as public with a stated reason. This is
// a pragmatic stand-in for a full per-action authorization-matrix mapping
// (docs/architecture/authorization-matrix.md already documents the policy in
// prose) — it catches the concrete, recurring failure mode instead: a new
// route added without requireTenantPrincipal/requirePlatformAdminPrincipal/
// an explicit session check, which would otherwise serve tenant or account
// data to anyone.

import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const root = process.cwd()
const apiRoot = join(root, 'src/routes/api')

// path (relative to repo root) -> why this route needs no auth guard.
const publicAllowlist = new Map([
  ['src/routes/api/auth/$.ts', 'delegates entirely to better-auth\'s own request handler, which does its own per-endpoint auth'],
  ['src/routes/api/changelog/index.ts', 'reads only via listPublicChangelogEntries, an explicit public DTO repository'],
  ['src/routes/api/changelog/$slug.ts', 'reads only via findPublicChangelogEntryBySlug, an explicit public DTO repository'],
  ['src/routes/api/incidents/index.ts', 'reads only via listPublicIncidents, an explicit public DTO repository'],
  ['src/routes/api/status/index.ts', 'operational health check; touches no tenant or account data'],
  ['src/routes/api/ai/config.ts', 'documented public-safe AI feature-flag config, no secrets'],
  ['src/routes/api/solutions/config.ts', 'documented public-safe Solutions feature-flag readiness config, no secrets — same pattern as ai/config.ts'],
  ['src/routes/api/feeds/$searchId.ts', 'documented public RSS feed, gated by a capability token rather than a session'],
  ['src/routes/api/webhooks/stripe.ts', 'Stripe cannot hold a user session — Stripe-Signature verification (receiveStripeWebhook) is the entire authentication mechanism, enforced before any DB write'],
  ['src/routes/api/e2e/outbox.ts', 'E2E-only email-outbox debug seam; hard-gated on E2E_MODE=true and returns a bare 404 for every method in any other mode'],
  ['src/routes/api/e2e/billing-provider.ts', 'E2E-only seam that tells the in-memory FakeBillingProvider a seeded subscription exists; same hard E2E_MODE=true gate as outbox.ts, a bare 404 otherwise, and it can only ever reach the fake — getBillingProvider() never returns the real Stripe adapter while E2E_MODE is set'],
  ['src/routes/api/portfolio/$claimId.ts', 'fail-closed public portfolio API — reads only via getPublicPortfolioClaim, an explicit published/verified-only DTO repository; never a bare 404 vs. data distinction that would leak claim state'],
  ['src/routes/api/analytics/conversion.ts', 'fires from anonymous landing/explore/signup pages by design; validates a closed event schema server-side and never reads/returns tenant or account data'],
  ['src/routes/api/privacy/profile-removal.ts', 'deliberately unauthenticated — the person requesting removal need not have a BuilderHunt account; IP+profile rate-limited, and possessing the returned challenge is the only thing the verify step accepts as authorization'],
  ['src/routes/api/privacy/profile-removal/verify.ts', 'deliberately unauthenticated — matching the caller-supplied challenge against its stored hash IS the authorization check (see profile-removal.ts); rate-limited per (ip, requestId)'],
  ['src/routes/api/status/subscribe.ts', 'deliberately unauthenticated public subscribe/unsubscribe form; IP rate-limited, anti-enumeration response shape, and the unsubscribe GET is itself the authorization check (token hash match)'],
])

const guardPatterns = [
  { name: 'tenant', pattern: /requireTenantPrincipal|withTenantContext/ },
  { name: 'platform-admin', pattern: /requirePlatformAdminPrincipal/ },
  { name: 'organization-lifecycle', pattern: /getOrganizationLifecycle/ },
  { name: 'session', pattern: /auth\.api\.getSession/ },
  // The public scheduling routes authenticate an accountless candidate by capability, not by session.
  // That IS a guard, and a strict one: `withCapabilityRequest` reads the secret from an invitation-
  // scoped HttpOnly cookie, hashes it in application code, and resolves it against a stored hash
  // through one narrowly privileged command before any tenant context is entered — see
  // src/lib/scheduling/capability-context.ts and drizzle/0077-0078. Allowlisting these as "public"
  // would be the wrong model: they are authenticated, just not by a user session.
  { name: 'scheduling-capability', pattern: /withCapabilityRequest|withCapabilityContext/ },
  // A table page route hands the whole sequence to `tablePageHandler`, which calls
  // `requireTenantPrincipal` before it parses anything and opens `withTenantContext` around the
  // load — see src/shared/lib/table/handler.ts. The guard is there rather than in the route file,
  // which is the point of having one; listing it here is the same call as `withCapabilityRequest`
  // above, and allowlisting these routes as "public" would be plainly wrong.
  { name: 'table-page', pattern: /tablePageHandler/ },
]

async function collectRouteFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectRouteFiles(full)))
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(full)
    }
  }
  return files
}

const files = await collectRouteFiles(apiRoot)
const findings = []
const usedAllowlistEntries = new Set()

for (const absolutePath of files) {
  const path = relative(root, absolutePath)
  if (publicAllowlist.has(path)) {
    usedAllowlistEntries.add(path)
    continue
  }
  const source = await readFile(absolutePath, 'utf8')
  const matched = guardPatterns.some(({ pattern }) => pattern.test(source))
  if (!matched) findings.push(`${path}: no recognized auth guard and not on the public allowlist`)
}

for (const path of publicAllowlist.keys()) {
  if (!usedAllowlistEntries.has(path)) findings.push(`${path}: allowlisted but no longer exists — remove the stale entry`)
}

if (findings.length > 0) {
  console.error(findings.join('\n'))
  process.exit(1)
}

console.log(JSON.stringify({ routes: files.length, publicAllowlisted: publicAllowlist.size, valid: true }))
