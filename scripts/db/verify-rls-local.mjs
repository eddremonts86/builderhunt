import postgres from 'postgres'
import { createHash } from 'node:crypto'

const appUrl = process.env.RLS_TEST_APP_URL
const authUrl = process.env.RLS_TEST_AUTH_URL
const workerUrl = process.env.RLS_TEST_WORKER_URL
const platformUrl = process.env.RLS_TEST_PLATFORM_URL
if (!appUrl || !authUrl || !workerUrl || !platformUrl) throw new Error('All exact-role test URLs are required')
for (const value of [appUrl, authUrl, workerUrl, platformUrl]) {
  const databaseName = new URL(value).pathname.slice(1)
  if (!/^builderhunt_security_test_[A-Za-z0-9_]+$/.test(databaseName)) {
    throw new Error('RLS verifier refuses to run outside a named builderhunt_security_test database')
  }
}

const app = postgres(appUrl, { max: 2 })
const auth = postgres(authUrl, { max: 1 })
const worker = postgres(workerUrl, { max: 1 })
const platform = postgres(platformUrl, { max: 1 })

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

  const claimMissing = await app`select id from builder_claims`
  if (claimMissing.length !== 0) throw new Error('Missing user context exposed builder claims')
  const subjectClaims = await app.begin(async (transaction) => {
    await transaction`select set_config('app.user_id', 'user-a', true)`
    return transaction`select id from builder_claims order by id`
  })
  assertIds(subjectClaims, ['claim-a'], 'claim subject isolation')
  let crossSubjectClaimDenied = false
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.user_id', 'user-a', true)`
      await transaction`
        insert into builder_claims (
          id, builder_identity_id, subject_user_id, evidence_source, evidence_reference, status, created_at
        ) values ('claim-cross', 'identity-b', 'user-b', 'email', 'x@test.invalid', 'pending', now())
      `
    })
  } catch (error) {
    crossSubjectClaimDenied = error?.code === '42501'
  }
  if (!crossSubjectClaimDenied) throw new Error('Cross-subject claim insert was not denied')

  const billingMissing = await app`select id from billing_customers`
  if (billingMissing.length !== 0) throw new Error('Missing context exposed billing customers')
  const scopedBilling = (organizationId) => app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', ${organizationId}, true)`
    return transaction`select id from billing_customers order by id`
  })
  const [billingTenantA, billingTenantB] = await Promise.all([scopedBilling('org-a'), scopedBilling('org-b')])
  assertIds(billingTenantA, ['billing-cust-a'], 'billing customer org-a isolation')
  assertIds(billingTenantB, ['billing-cust-b'], 'billing customer org-b isolation')

  // billing_customers is financial state — the app role gets SELECT only, never INSERT/UPDATE,
  // even inside its own tenant (spec.md: "Browser roles cannot mutate financial state directly").
  let appBillingInsertDenied = false
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`
        insert into billing_customers (id, organization_id, livemode, stripe_customer_id, created_at, updated_at)
        values ('billing-cust-hack', 'org-a', false, 'cus_hack', now(), now())
      `
    })
  } catch (error) {
    appBillingInsertDenied = error?.code === '42501'
  }
  if (!appBillingInsertDenied) throw new Error('App role inserted financial-state billing row')

  let appBillingUpdateDenied = false
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`update billing_customers set stripe_customer_id = 'hacked' where id = 'billing-cust-a'`
    })
  } catch (error) {
    appBillingUpdateDenied = error?.code === '42501'
  }
  if (!appBillingUpdateDenied) throw new Error('App role updated financial-state billing row')

  // billing_checkout_attempts is the one owner-initiated table the app role CAN write —
  // but only within its own tenant, never a spoofed organization_id.
  let checkoutSpoofDenied = false
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`
        insert into billing_checkout_attempts (
          id, organization_id, actor_user_id, livemode, action, catalog_key, idempotency_key,
          consent_versions, status, expires_at, created_at, updated_at
        ) values (
          'attempt-cross', 'org-b', 'user-a', false, 'subscription', 'pro_monthly', 'idem-cross',
          '{"terms":"v1","privacy":"v1"}', 'open', now() + interval '1 hour', now(), now()
        )
      `
    })
  } catch (error) {
    checkoutSpoofDenied = error?.code === '42501'
  }
  if (!checkoutSpoofDenied) throw new Error('App role created a checkout attempt under a spoofed organization')

  const billingWorkerMissing = await worker`select id from billing_customers`
  if (billingWorkerMissing.length !== 0) throw new Error('Worker missing context exposed billing customers')
  const workerBillingA = await worker.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    return transaction`select id from billing_customers order by id`
  })
  assertIds(workerBillingA, ['billing-cust-a'], 'worker billing org-a isolation')
  let workerBillingCrossTenantDenied = false
  try {
    await worker.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-b', true)`
      await transaction`update billing_customers set stripe_customer_id = 'cross-tenant-hack' where id = 'billing-cust-a'`
    })
    const [unchanged] = await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      return transaction`select stripe_customer_id from billing_customers where id = 'billing-cust-a'`
    })
    workerBillingCrossTenantDenied = unchanged?.stripe_customer_id === 'cus_test_a'
  } catch {
    workerBillingCrossTenantDenied = true
  }
  if (!workerBillingCrossTenantDenied) throw new Error('Worker cross-tenant billing update was not denied')

  let platformBillingDenied = false
  try {
    await platform`select id from billing_customers`
  } catch (error) {
    platformBillingDenied = error?.code === '42501'
  }
  if (!platformBillingDenied) throw new Error('Platform role accessed tenant billing customer data')

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

  const platformUsers = await platform`select id from auth_users order by id`
  if (!platformUsers.some((row) => row.id === 'user-a')) throw new Error('Platform account directory access failed')
  let platformProductDenied = false
  try {
    await platform`select id from saved_queries`
  } catch (error) {
    platformProductDenied = error?.code === '42501'
  }
  if (!platformProductDenied) throw new Error('Platform role accessed tenant product tables')

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
    claimSubjectIsolation: subjectClaims.map((row) => row.id),
    crossSubjectClaimInsert: 'denied',
    authProductAccess: 'denied',
    workerMissingContext: 'denied',
    workerTenantIsolation: workerAlerts.map((row) => row.id),
    workerCrossTenantInsert: 'denied',
    workerAuthColumns: 'restricted',
    platformProductAccess: 'denied',
    personalOrganizationBootstrap: 'atomic',
    billingTenantA: billingTenantA.map((row) => row.id),
    billingTenantB: billingTenantB.map((row) => row.id),
    appBillingInsert: 'denied',
    appBillingUpdate: 'denied',
    checkoutAttemptSpoof: 'denied',
    workerBillingMissingContext: 'denied',
    workerBillingTenantIsolation: workerBillingA.map((row) => row.id),
    workerBillingCrossTenantUpdate: 'denied',
    platformBillingAccess: 'denied',
  }))
} finally {
  await Promise.all([app.end(), auth.end(), worker.end(), platform.end()])
}

function assertIds(rows, expected, label) {
  const actual = rows.map((row) => row.id)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} failed: ${JSON.stringify(actual)}`)
  }
}
