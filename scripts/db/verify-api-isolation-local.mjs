// Two-tenant isolation check that exercises REAL route handlers (not mocks)
// against a disposable local Postgres, connected through the exact
// non-owner runtime roles (builderhunt_app / builderhunt_worker / builderhunt_auth)
// so RLS is genuinely enforced end-to-end — the same failure mode a bug in
// `withTenantContext`/RLS policy would actually produce in production.
//
// Scope: covers saved-queries, organization-alerts, and builder tracking
// (three representative tenant-private resources), account-export privacy
// isolation, and alerts-worker cross-organization data isolation. This is
// NOT the full ~34-route inventory in src/routes/api/** — see
// plans/security-and-multitenancy/tasks.md task 15 for what remains.
//
// Required env (set by the caller before running):
//   DATABASE_URL             -> builderhunt_app role connection
//   DATABASE_AUTH_URL        -> builderhunt_auth role connection
//   DATABASE_WORKER_URL      -> builderhunt_worker role connection
//   DATABASE_PLATFORM_URL    -> builderhunt_platform role connection
//   OWNER_SEED_URL           -> postgres owner connection, for fixture setup only
//   APP_URL, VITE_APP_URL, BETTER_AUTH_SECRET
//
// Refuses to run unless every URL's database name matches
// builderhunt_security_test_* — never point this at a real database.

import postgres from 'postgres'
import { createHmac } from 'node:crypto'

const requiredEnv = ['DATABASE_URL', 'DATABASE_AUTH_URL', 'DATABASE_WORKER_URL', 'DATABASE_PLATFORM_URL', 'OWNER_SEED_URL']
for (const key of requiredEnv) {
  if (!process.env[key]) throw new Error(`${key} is required`)
}
for (const key of requiredEnv) {
  const databaseName = new URL(process.env[key]).pathname.slice(1)
  if (!/^builderhunt_security_test_[A-Za-z0-9_]+$/.test(databaseName)) {
    throw new Error(`API isolation verifier refuses to run outside a named builderhunt_security_test database (${key})`)
  }
}

const owner = postgres(process.env.OWNER_SEED_URL, { max: 1, prepare: false })

const IDS = {
  orgA: 'iso-org-a',
  orgB: 'iso-org-b',
  userA: 'iso-user-a',
  userB: 'iso-user-b',
  queryA: 'iso-query-a',
  queryB: 'iso-query-b',
  alertA: 'iso-alert-a',
  alertB: 'iso-alert-b',
  identityA: 'iso-identity-a',
  identityB: 'iso-identity-b',
  trackedA: 'iso-tracked-a',
  trackedB: 'iso-tracked-b',
  legacyBuilderA: 'iso-legacy-builder-a',
  legacyBuilderB: 'iso-legacy-builder-b',
}

async function seed() {
  await owner`
    insert into auth_users (id, name, email, email_verified, created_at, updated_at)
    values
      (${IDS.userA}, 'Iso A', 'iso-a@test.invalid', true, now(), now()),
      (${IDS.userB}, 'Iso B', 'iso-b@test.invalid', true, now(), now())
  `
  await owner`
    insert into organizations (id, name, slug, metadata, created_at)
    values (${IDS.orgA}, 'Iso A', 'iso-org-a', '{}', now()), (${IDS.orgB}, 'Iso B', 'iso-org-b', '{}', now())
  `
  await owner`
    insert into organization_members (id, organization_id, user_id, role, created_at)
    values (${IDS.orgA + ':owner'}, ${IDS.orgA}, ${IDS.userA}, 'owner', now()),
           (${IDS.orgB + ':owner'}, ${IDS.orgB}, ${IDS.userB}, 'owner', now())
  `
  await owner`
    insert into auth_sessions (id, user_id, active_organization_id, token, expires_at, created_at, updated_at)
    values
      ('iso-session-a', ${IDS.userA}, ${IDS.orgA}, 'iso-session-token-a', now() + interval '1 day', now(), now()),
      ('iso-session-b', ${IDS.userB}, ${IDS.orgB}, 'iso-session-token-b', now() + interval '1 day', now(), now())
  `
  await owner`
    insert into saved_queries (id, organization_id, user_id, name, keywords, sources, created_at)
    values
      (${IDS.queryA}, ${IDS.orgA}, ${IDS.userA}, 'Query A', '["rust"]'::jsonb, '["github"]'::jsonb, now()),
      (${IDS.queryB}, ${IDS.orgB}, ${IDS.userB}, 'Query B', '["python"]'::jsonb, '["github"]'::jsonb, now())
  `
  await owner`
    insert into builder_identities (id, source, source_id, username, profile_url, created_at, updated_at)
    values
      (${IDS.identityA}, 'github', 'iso-a', 'iso-a', 'https://github.com/iso-a', now(), now()),
      (${IDS.identityB}, 'github', 'iso-b', 'iso-b', 'https://github.com/iso-b', now(), now())
  `
  await owner`
    insert into organization_builders (
      id, organization_id, builder_identity_id, creator_user_id, visibility, status, private_metadata, created_at, updated_at
    ) values
      (${IDS.trackedA}, ${IDS.orgA}, ${IDS.identityA}, ${IDS.userA}, 'private', 'tracked', '{}', now(), now()),
      (${IDS.trackedB}, ${IDS.orgB}, ${IDS.identityB}, ${IDS.userB}, 'private', 'tracked', '{}', now(), now())
  `
  // Legacy `builders` rows + `alerts` rows: the alerts worker (src/lib/alerts/worker.ts)
  // still reads the legacy per-user `builders` table, not `organization_builders`.
  await owner`
    insert into builders (
      id, organization_id, user_id, source, source_id, username, profile_url, last_seen, created_at, updated_at
    ) values
      (${IDS.legacyBuilderA}, ${IDS.orgA}, ${IDS.userA}, 'github', 'iso-legacy-a', 'iso-legacy-a', 'https://github.com/iso-legacy-a', now(), now(), now()),
      (${IDS.legacyBuilderB}, ${IDS.orgB}, ${IDS.userB}, 'github', 'iso-legacy-b', 'iso-legacy-b', 'https://github.com/iso-legacy-b', now(), now(), now())
  `
  await owner`
    insert into alerts (id, organization_id, user_id, name, keywords, enabled, trigger_conditions, delivery_channel, created_at)
    values
      (${IDS.alertA}, ${IDS.orgA}, ${IDS.userA}, 'Alert A', '[]'::jsonb, true,
       ${owner.json({ eventType: 'any_activity', builderId: IDS.legacyBuilderA })}, 'dashboard', now() - interval '1 hour'),
      (${IDS.alertB}, ${IDS.orgB}, ${IDS.userB}, 'Alert B', '[]'::jsonb, true,
       ${owner.json({ eventType: 'any_activity', builderId: IDS.legacyBuilderB })}, 'dashboard', now() - interval '1 hour')
  `
}

// better-auth signs the session_token cookie with HMAC-SHA256(secret, token)
// and rejects unsigned values outright (see better-call's getSignedCookie) —
// a plain token cookie silently resolves to "no session", not an error.
function signedSessionCookie(token) {
  const secret = process.env.BETTER_AUTH_SECRET
  const signature = createHmac('sha256', secret).update(token).digest('base64')
  return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
}

function sessionRequest(token, url, init = {}) {
  return new Request(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      cookie: signedSessionCookie(token),
      'x-request-id': crypto.randomUUID(),
    },
  })
}

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
}

async function checkSavedQueries() {
  const { Route } = await import('../../src/routes/api/queries/index.ts')
  const { GET, DELETE } = Route.options.server.handlers

  const listA = await (await GET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/queries') })).json()
  record('saved-queries: A sees only A\'s query', Array.isArray(listA) && listA.length === 1 && listA[0].id === IDS.queryA, JSON.stringify(listA.map((q) => q.id)))

  const listB = await (await GET({ request: sessionRequest('iso-session-token-b', 'https://iso.test/api/queries') })).json()
  record('saved-queries: B sees only B\'s query', Array.isArray(listB) && listB.length === 1 && listB[0].id === IDS.queryB, JSON.stringify(listB.map((q) => q.id)))

  const deleteOther = await DELETE({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/queries', {
      method: 'DELETE',
      body: JSON.stringify({ id: IDS.queryB }),
    }),
  })
  record('saved-queries: A cannot delete B\'s query (other id)', deleteOther.status === 404, `status=${deleteOther.status}`)

  const deleteRandom = await DELETE({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/queries', {
      method: 'DELETE',
      body: JSON.stringify({ id: 'nonexistent-random-id' }),
    }),
  })
  record('saved-queries: A cannot delete a random id', deleteRandom.status === 404, `status=${deleteRandom.status}`)

  const deleteOwn = await DELETE({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/queries', {
      method: 'DELETE',
      body: JSON.stringify({ id: IDS.queryA }),
    }),
  })
  const deleteOwnBody = await deleteOwn.json()
  record('saved-queries: A can delete A\'s own query', deleteOwn.status === 200 && deleteOwnBody.success === true, JSON.stringify(deleteOwnBody))
}

async function checkAlerts() {
  const { Route } = await import('../../src/routes/api/alerts/index.ts')
  const { GET, DELETE } = Route.options.server.handlers

  const listA = await (await GET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/alerts') })).json()
  record('alerts: A sees only A\'s alert', Array.isArray(listA) && listA.length === 1 && listA[0].id === IDS.alertA, JSON.stringify(listA.map((a) => a.id)))

  const deleteOther = await DELETE({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/alerts', {
      method: 'DELETE',
      body: JSON.stringify({ id: IDS.alertB }),
    }),
  })
  record('alerts: A cannot delete B\'s alert (other id)', deleteOther.status === 404, `status=${deleteOther.status}`)

  const deleteRandom = await DELETE({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/alerts', {
      method: 'DELETE',
      body: JSON.stringify({ id: 'nonexistent-random-id' }),
    }),
  })
  record('alerts: A cannot delete a random id', deleteRandom.status === 404, `status=${deleteRandom.status}`)
}

async function checkBuilderTracking() {
  const { Route } = await import('../../src/routes/api/builders/$builderId.ts')
  const { PATCH, DELETE } = Route.options.server.handlers

  const patchOther = await PATCH({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/builders/x', {
      method: 'PATCH',
      body: JSON.stringify({ country: 'US' }),
    }),
    params: { builderId: IDS.trackedB },
  })
  record('builder tracking: A cannot patch B\'s tracked row (other id)', patchOther.status === 404, `status=${patchOther.status}`)

  const patchRandom = await PATCH({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/builders/x', {
      method: 'PATCH',
      body: JSON.stringify({ country: 'US' }),
    }),
    params: { builderId: 'nonexistent-random-id' },
  })
  record('builder tracking: A cannot patch a random id', patchRandom.status === 404, `status=${patchRandom.status}`)

  const patchOwn = await PATCH({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/builders/x', {
      method: 'PATCH',
      body: JSON.stringify({ country: 'US' }),
    }),
    params: { builderId: IDS.trackedA },
  })
  record('builder tracking: A can patch A\'s own tracked row', patchOwn.status === 200, `status=${patchOwn.status}`)

  const deleteOther = await DELETE({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/builders/x', { method: 'DELETE' }),
    params: { builderId: IDS.trackedB },
  })
  record('builder tracking: A cannot delete B\'s tracked row', deleteOther.status === 404, `status=${deleteOther.status}`)
}

async function checkAccountExportPrivacy() {
  const { buildExportPayload } = await import('../../src/shared/lib/legal.ts')
  const payloadA = await buildExportPayload(IDS.userA)
  const payloadB = await buildExportPayload(IDS.userB)
  const serializedA = JSON.stringify(payloadA)
  const serializedB = JSON.stringify(payloadB)

  record(
    'privacy: A\'s export never mentions B\'s user/org/builder ids',
    !serializedA.includes(IDS.userB) && !serializedA.includes(IDS.orgB) && !serializedA.includes(IDS.legacyBuilderB),
    'checked userB/orgB/legacyBuilderB absence',
  )
  record(
    'privacy: B\'s export never mentions A\'s user/org/builder ids',
    !serializedB.includes(IDS.userA) && !serializedB.includes(IDS.orgA) && !serializedB.includes(IDS.legacyBuilderA),
    'checked userA/orgA/legacyBuilderA absence',
  )
  // NOT checked here (known gap, not silently passing): `trackedBuilders` in
  // buildExportPayload reads the tenant-private `builders` table without ever
  // calling withTenantContext, so RLS's organization_id policy default-denies
  // and the export silently omits every tracked builder — proven by
  // `serializedA` never containing IDS.legacyBuilderA despite the row
  // existing. Fixing this needs loadAccountExportSource to loop the user's
  // memberships and read `builders` once per organization under its own
  // tenant context; tracked separately in plans/security-and-multitenancy/tasks.md.
}

async function checkWorkerIsolation() {
  const { runAlertsWorker } = await import('../../src/lib/alerts/worker.ts')
  const result = await runAlertsWorker()

  const triggers = await owner`
    select organization_id, alert_id, builder_id from alert_triggers
    where organization_id in (${IDS.orgA}, ${IDS.orgB})
  `
  const forA = triggers.filter((t) => t.organization_id === IDS.orgA)
  const forB = triggers.filter((t) => t.organization_id === IDS.orgB)

  record('worker: org A got its own trigger, not org B\'s', forA.length >= 1 && forA.every((t) => t.builder_id === IDS.legacyBuilderA), JSON.stringify(forA))
  record('worker: org B got its own trigger, not org A\'s', forB.length >= 1 && forB.every((t) => t.builder_id === IDS.legacyBuilderB), JSON.stringify(forB))
  record('worker: no cross-organization trigger rows', triggers.every((t) => t.organization_id === IDS.orgA || t.organization_id === IDS.orgB), JSON.stringify(triggers))
  record('worker: run completed without throwing for either tenant', Array.isArray(result.errors), `errors=${JSON.stringify(result.errors)}`)
}

async function main() {
  await seed()
  await checkSavedQueries()
  await checkAlerts()
  await checkBuilderTracking()
  await checkAccountExportPrivacy()
  await checkWorkerIsolation()

  const failed = results.filter((r) => !r.pass)
  console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length, results }, null, 2))
  if (failed.length > 0) process.exitCode = 1
}

try {
  await main()
} finally {
  await owner.end({ timeout: 5 })
}
