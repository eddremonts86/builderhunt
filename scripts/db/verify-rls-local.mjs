import postgres from 'postgres'
import { createHash } from 'node:crypto'

const appUrl = process.env.RLS_TEST_APP_URL
const authUrl = process.env.RLS_TEST_AUTH_URL
const workerUrl = process.env.RLS_TEST_WORKER_URL
if (!appUrl || !authUrl || !workerUrl) throw new Error('RLS_TEST_APP_URL, RLS_TEST_AUTH_URL, and RLS_TEST_WORKER_URL are required')
for (const value of [appUrl, authUrl, workerUrl]) {
  const databaseName = new URL(value).pathname.slice(1)
  if (!/^builderhunt_security_test_[A-Za-z0-9_]+$/.test(databaseName)) {
    throw new Error('RLS verifier refuses to run outside a named builderhunt_security_test database')
  }
}

const app = postgres(appUrl, { max: 2 })
const auth = postgres(authUrl, { max: 1 })
const worker = postgres(workerUrl, { max: 1 })

try {
  const missing = await app`select id from organization_builders order by id`
  if (missing.length !== 0) throw new Error('Missing context exposed tenant rows')

  const scoped = (organizationId) => app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', ${organizationId}, true)`
    return transaction`select id from organization_builders order by id`
  })
  const [tenantA, tenantB] = await Promise.all([scoped('org-a'), scoped('org-b')])
  assertIds(tenantA, ['tracked-a'], 'org-a isolation')
  assertIds(tenantB, ['tracked-b'], 'org-b isolation')

  let crossTenantInsertDenied = false
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`
        insert into organization_builders (
          id, organization_id, builder_identity_id, creator_user_id,
          visibility, status, private_metadata, created_at, updated_at
        ) values (
          'tracked-cross', 'org-b', 'identity-b', 'user-b',
          'private', 'tracked', '{}', now(), now()
        )
      `
    })
  } catch (error) {
    crossTenantInsertDenied = error?.code === '42501'
  }
  if (!crossTenantInsertDenied) throw new Error('Cross-tenant insert was not denied')

  const afterCommit = await app`select id from organization_builders`
  if (afterCommit.length !== 0) throw new Error('Pooled tenant context leaked after commit')

  const organizations = await auth`select id from organizations order by id`
  const organizationIds = organizations.map((row) => row.id)
  if (!organizationIds.includes('org-a') || !organizationIds.includes('org-b')) {
    throw new Error('Auth broker organization lifecycle failed')
  }
  let authProductAccessDenied = false
  try {
    await auth`select id from organization_builders`
  } catch (error) {
    authProductAccessDenied = error?.code === '42501'
  }
  if (!authProductAccessDenied) throw new Error('Auth broker accessed product tenant data')

  const workerMissing = await worker`select id from alerts`
  if (workerMissing.length !== 0) throw new Error('Worker missing context exposed alerts')
  const workerAlerts = await worker.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    return transaction`select id from alerts order by id`
  })
  assertIds(workerAlerts, ['alert-a'], 'worker org-a isolation')
  let workerCrossTenantDenied = false
  try {
    await worker.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`
        insert into alert_triggers (
          id, organization_id, alert_id, user_id, event_type, payload, matched_at
        ) values ('trigger-cross', 'org-b', 'alert-b', 'user-b', 'any_activity', '{}', now())
      `
    })
  } catch (error) {
    workerCrossTenantDenied = error?.code === '42501'
  }
  if (!workerCrossTenantDenied) throw new Error('Worker cross-tenant trigger insert was not denied')
  let workerAuthColumnsDenied = false
  try {
    await worker`select name from auth_users limit 1`
  } catch (error) {
    workerAuthColumnsDenied = error?.code === '42501'
  }
  if (!workerAuthColumnsDenied) throw new Error('Worker accessed unapproved auth user columns')

  const bootstrapUserId = 'user-bootstrap'
  const bootstrapHash = createHash('sha256')
    .update(`builderhunt:personal-organization:v1:${bootstrapUserId}`)
    .digest('hex')
    .slice(0, 24)
  const bootstrapOrganizationId = `org_personal_${bootstrapHash}`
  await auth`
    insert into auth_users (id, name, email, email_verified, created_at, updated_at)
    values (${bootstrapUserId}, 'Bootstrap', 'bootstrap@test.invalid', true, now(), now())
    on conflict (id) do nothing
  `
  await auth`
    select bootstrap_personal_organization(
      ${bootstrapUserId},
      ${bootstrapOrganizationId},
      ${`personal-${bootstrapHash}`},
      ${`${bootstrapOrganizationId}:owner`}
    )
  `
  const bootstrapEntitlement = await app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', ${bootstrapOrganizationId}, true)`
    return transaction`select tier, status, seat_limit from organization_entitlements`
  })
  if (bootstrapEntitlement.length !== 1 || bootstrapEntitlement[0].tier !== 'free') {
    throw new Error('Atomic personal organization bootstrap failed')
  }

  console.log(JSON.stringify({
    missingContext: 'denied',
    tenantA: tenantA.map((row) => row.id),
    tenantB: tenantB.map((row) => row.id),
    crossTenantInsert: 'denied',
    poolReuse: 'clean',
    authProductAccess: 'denied',
    workerMissingContext: 'denied',
    workerTenantIsolation: workerAlerts.map((row) => row.id),
    workerCrossTenantInsert: 'denied',
    workerAuthColumns: 'restricted',
    personalOrganizationBootstrap: 'atomic',
  }))
} finally {
  await Promise.all([app.end(), auth.end(), worker.end()])
}

function assertIds(rows, expected, label) {
  const actual = rows.map((row) => row.id)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} failed: ${JSON.stringify(actual)}`)
  }
}
