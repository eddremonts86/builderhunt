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

  // user_devices — account-subject (app.user_id). App role is scoped read/write for its own
  // user_id (request-path device-cookie upsert); worker role got an unscoped, SELECT-only grant in
  // 0045 for cross-user linked-account clustering (there's no single user_id to scope a clustering
  // read by) — never INSERT/UPDATE, those stay exclusively with app.
  const devicesMissing = await app`select id from user_devices`
  if (devicesMissing.length !== 0) throw new Error('Missing user context exposed user_devices')
  const scopedDevices = (userId) => app.begin(async (transaction) => {
    await transaction`select set_config('app.user_id', ${userId}, true)`
    return transaction`select id from user_devices order by id`
  })
  const [devicesA, devicesB] = await Promise.all([scopedDevices('user-a'), scopedDevices('user-b')])
  assertIds(devicesA, ['device-a'], 'user_devices user-a isolation')
  assertIds(devicesB, ['device-b'], 'user_devices user-b isolation')

  let crossSubjectDeviceInsertDenied = false
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.user_id', 'user-a', true)`
      await transaction`
        insert into user_devices (id, user_id, device_hash, ua_family, trust_state)
        values ('device-cross', 'user-b', 'hash-cross', 'chrome', 'new')
      `
    })
  } catch (error) {
    crossSubjectDeviceInsertDenied = error?.code === '42501'
  }
  if (!crossSubjectDeviceInsertDenied) throw new Error('Cross-subject user_devices insert was not denied')

  const workerDevicesAll = await worker`select id from user_devices order by id`
  assertIds(workerDevicesAll, ['device-a', 'device-b'], 'user_devices worker cross-user read')

  let workerDeviceInsertDenied = false
  try {
    await worker`
      insert into user_devices (id, user_id, device_hash, ua_family, trust_state)
      values ('device-worker-insert', 'user-a', 'hash-worker', 'chrome', 'new')
    `
  } catch (error) {
    workerDeviceInsertDenied = error?.code === '42501'
  }
  if (!workerDeviceInsertDenied) throw new Error('Worker role was able to insert into user_devices')

  // account_risk — account-subject, but app has NO grant at all: risk stage/score is written
  // exclusively by trusted worker/platform paths, never the browser-facing role.
  let appAccountRiskDenied = false
  try {
    await app`select user_id from account_risk`
  } catch (error) {
    appAccountRiskDenied = error?.code === '42501'
  }
  if (!appAccountRiskDenied) throw new Error('App role accessed account_risk')

  const riskMissing = await worker`select user_id from account_risk`
  if (riskMissing.length !== 0) throw new Error('Missing user context exposed account_risk')
  const scopedRisk = (userId) => worker.begin(async (transaction) => {
    await transaction`select set_config('app.user_id', ${userId}, true)`
    return transaction`select user_id from account_risk order by user_id`
  })
  const [riskA, riskB] = await Promise.all([scopedRisk('user-a'), scopedRisk('user-b')])
  if (riskA.length !== 1 || riskA[0].user_id !== 'user-a') throw new Error('account_risk worker user-a isolation failed')
  if (riskB.length !== 1 || riskB[0].user_id !== 'user-b') throw new Error('account_risk worker user-b isolation failed')

  let workerCrossSubjectRiskDenied = false
  try {
    await worker.begin(async (transaction) => {
      await transaction`select set_config('app.user_id', 'user-a', true)`
      await transaction`update account_risk set stage = 'blocked' where user_id = 'user-b'`
    })
    const [unchanged] = await worker.begin(async (transaction) => {
      await transaction`select set_config('app.user_id', 'user-b', true)`
      return transaction`select stage from account_risk where user_id = 'user-b'`
    })
    workerCrossSubjectRiskDenied = unchanged?.stage === 'observe'
  } catch {
    workerCrossSubjectRiskDenied = true
  }
  if (!workerCrossSubjectRiskDenied) throw new Error('Worker cross-subject account_risk update was not denied')

  const platformRiskMissing = await platform`select user_id from account_risk`
  if (platformRiskMissing.length !== 0) throw new Error('Platform role read account_risk rows with missing context')
  const platformRiskA = await platform.begin(async (transaction) => {
    await transaction`select set_config('app.user_id', 'user-a', true)`
    return transaction`select user_id from account_risk order by user_id`
  })
  if (platformRiskA.length !== 1 || platformRiskA[0].user_id !== 'user-a') {
    throw new Error('Platform account_risk user-a scoped read failed')
  }

  // seat_usage_daily — tenant-private (app.organization_id), same shape as other tenant tables.
  const seatUsageMissing = await app`select id from seat_usage_daily`
  if (seatUsageMissing.length !== 0) throw new Error('Missing context exposed seat_usage_daily')
  const scopedSeatUsage = (organizationId) => app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', ${organizationId}, true)`
    return transaction`select id from seat_usage_daily order by id`
  })
  const [seatUsageA, seatUsageB] = await Promise.all([scopedSeatUsage('org-a'), scopedSeatUsage('org-b')])
  assertIds(seatUsageA, ['usage-a'], 'seat_usage_daily org-a isolation')
  assertIds(seatUsageB, ['usage-b'], 'seat_usage_daily org-b isolation')

  let crossTenantSeatUsageInsertDenied = false
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`
        insert into seat_usage_daily (id, organization_id, user_id, day, action, count, credit_units)
        values ('usage-cross', 'org-b', 'user-a', '2026-01-01', 'searches', 1, 0)
      `
    })
  } catch (error) {
    crossTenantSeatUsageInsertDenied = error?.code === '42501'
  }
  if (!crossTenantSeatUsageInsertDenied) throw new Error('Cross-tenant seat_usage_daily insert was not denied')

  // session_signals / abuse_signals — system-operational, no RLS; app gets no grant at all.
  let appSessionSignalsDenied = false
  try {
    await app`select id from session_signals`
  } catch (error) {
    appSessionSignalsDenied = error?.code === '42501'
  }
  if (!appSessionSignalsDenied) throw new Error('App role accessed session_signals')

  let appAbuseSignalsDenied = false
  try {
    await app`select id from abuse_signals`
  } catch (error) {
    appAbuseSignalsDenied = error?.code === '42501'
  }
  if (!appAbuseSignalsDenied) throw new Error('App role accessed abuse_signals')

  await worker`
    insert into abuse_signals (id, type, severity, user_id, organization_id)
    values ('signal-worker', 'seat_overuse', 'low', 'user-a', 'org-a')
  `
  const workerAbuseSignals = await worker`select id from abuse_signals order by id`
  if (workerAbuseSignals.length !== 1 || workerAbuseSignals[0].id !== 'signal-worker') {
    throw new Error('Worker abuse_signals read/write failed')
  }
  const platformAbuseSignals = await platform`select id from abuse_signals order by id`
  if (platformAbuseSignals.length !== 1 || platformAbuseSignals[0].id !== 'signal-worker') {
    throw new Error('Platform abuse_signals read failed')
  }

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
    userDevicesA: devicesA.map((row) => row.id),
    userDevicesB: devicesB.map((row) => row.id),
    crossSubjectDeviceInsert: 'denied',
    appAccountRiskAccess: 'denied',
    accountRiskWorkerIsolation: [riskA[0].user_id, riskB[0].user_id],
    workerCrossSubjectRiskUpdate: 'denied',
    platformAccountRiskScoped: platformRiskA.map((row) => row.user_id),
    seatUsageDailyA: seatUsageA.map((row) => row.id),
    seatUsageDailyB: seatUsageB.map((row) => row.id),
    crossTenantSeatUsageInsert: 'denied',
    appSessionSignalsAccess: 'denied',
    appAbuseSignalsAccess: 'denied',
    workerAbuseSignals: workerAbuseSignals.map((row) => row.id),
    platformAbuseSignals: platformAbuseSignals.map((row) => row.id),
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
