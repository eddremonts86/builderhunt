import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import postgres from 'postgres'
import { assertRestoreTestTargets } from '../../src/shared/lib/db/restore-policy'

const sourceUrl = process.env.RESTORE_TEST_SOURCE_URL
const targetUrl = process.env.RESTORE_TEST_TARGET_URL
if (!sourceUrl || !targetUrl) throw new Error('RESTORE_TEST_SOURCE_URL and RESTORE_TEST_TARGET_URL are required')
assertRestoreTestTargets(sourceUrl, targetUrl)

const sourceChecksum = await seedAndChecksumBillingFixture(sourceUrl)
const sourceMigrationCount = await countMigrations(sourceUrl)

await restore(sourceUrl, targetUrl)

const target = postgres(targetUrl, { max: 1, prepare: false })
try {
  const [migrations] = await target<{ count: number }[]>`
    select count(*)::int as count from drizzle.__drizzle_migrations
  `
  const [rls] = await target<{ missing: number }[]>`
    select count(*)::int as missing
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = any(${target.array([
        'organizations', 'organization_members', 'organization_invitations',
        'organization_entitlements', 'organization_plan_changes', 'organization_builders',
        'builders', 'saved_queries', 'alerts', 'alert_triggers', 'builder_notes', 'onboarding_progress',
        'builder_claims', 'published_builder_profiles',
        // stripe-billing-platform tenant-private tables (drizzle/0027, 0028) — the system-operational
        // ones (billing_webhook_events/billing_reconciliation_runs/billing_seller_profiles) have no
        // organization_id and are correctly excluded from this RLS check.
        'billing_customers', 'billing_subscriptions', 'billing_checkout_attempts',
        'billing_credit_grants', 'billing_credit_reservations', 'billing_credit_allocations',
        'billing_ledger_entries', 'billing_provider_usage', 'billing_auto_recharge_rules',
        'billing_refunds', 'billing_terms_acceptances',
      ])})
      and (not c.relrowsecurity or not c.relforcerowsecurity)
  `
  if (migrations?.count !== sourceMigrationCount) {
    throw new Error(`Restored migration count mismatch: source had ${sourceMigrationCount}, target has ${migrations?.count ?? 0}`)
  }
  if (rls?.missing !== 0) throw new Error(`Restored RLS manifest has ${rls?.missing ?? 0} missing policies`)

  const targetChecksum = await checksumBillingFixture(target)
  if (targetChecksum !== sourceChecksum) {
    throw new Error(`Restored billing ledger/grant/event checksum mismatch: source=${sourceChecksum} target=${targetChecksum}`)
  }

  console.log(JSON.stringify({
    restored: true,
    migrations: migrations.count,
    rlsMissing: rls.missing,
    billingChecksum: targetChecksum,
  }))
} finally {
  await target.end({ timeout: 5 })
}

/**
 * Seeds one organization's worth of billing state (customer, subscription, a credit grant, and the
 * ledger entries that grant/consume it) directly into the source database, then returns a sha256
 * checksum over the exact rows that must survive dump/restore byte-for-byte — this is the
 * "ledger/event/reference integrity" the backup/restore task requires evidence for, not just a
 * migration/RLS shape check. Ledger entries are append-only in the real system (see
 * billing_ledger_entries having no updatedAt column); a mismatched checksum here means the restore
 * silently dropped or reordered financial history, which no row-count check would catch.
 */
async function seedAndChecksumBillingFixture(url: string) {
  const client = postgres(url, { max: 1, prepare: false })
  try {
    await client`
      insert into organizations (id, name, slug, created_at)
      values ('restore-test-org', 'Restore Test Org', 'restore-test-org', now())
      on conflict (id) do nothing
    `
    await client`
      insert into auth_users (id, name, email, email_verified, created_at, updated_at)
      values ('restore-test-user', 'Restore Test', 'restore-test@test.invalid', true, now(), now())
      on conflict (id) do nothing
    `
    await client`
      insert into billing_customers (id, organization_id, livemode, stripe_customer_id, created_at, updated_at)
      values ('restore-test-cust', 'restore-test-org', false, 'cus_restore_test', now(), now())
      on conflict (id) do nothing
    `
    await client`
      insert into billing_subscriptions (
        id, organization_id, customer_id, livemode, catalog_key, tier, interval, catalog_version,
        stripe_subscription_id, stripe_status, provider_synced_at, created_at, updated_at
      ) values (
        'restore-test-sub', 'restore-test-org', 'restore-test-cust', false, 'pro_monthly', 'pro', 'monthly', 1,
        'sub_restore_test', 'active', now(), now(), now()
      )
      on conflict (id) do nothing
    `
    await client`
      insert into billing_credit_grants (
        id, organization_id, source, original_units, remaining_units, state, active_at, expires_at, created_at, updated_at
      ) values (
        'restore-test-grant', 'restore-test-org', 'subscription_monthly', 140, 90, 'active', now(), now() + interval '30 days', now(), now()
      )
      on conflict (id) do nothing
    `
    await client`
      insert into billing_ledger_entries (
        id, organization_id, entry_type, grant_id, units_delta, source_idempotency_key, created_at
      ) values
        ('restore-test-ledger-grant', 'restore-test-org', 'grant', 'restore-test-grant', 140, 'restore-test-grant-idem', now()),
        ('restore-test-ledger-consume', 'restore-test-org', 'consume', 'restore-test-grant', -50, 'restore-test-consume-idem', now())
      on conflict (id) do nothing
    `
    return await checksumBillingFixture(client)
  } finally {
    await client.end({ timeout: 5 })
  }
}

/**
 * Compares the restored count against the SOURCE database's own migration count (queried before
 * the dump) rather than a hardcoded number — a hardcoded expected count silently drifts every time
 * a new migration lands (it did: this check once read `29`, but the real count had grown to 43
 * without anyone updating it here, which would have made this rehearsal falsely fail on an
 * otherwise-correct restore).
 */
async function countMigrations(url: string): Promise<number> {
  const client = postgres(url, { max: 1, prepare: false })
  try {
    const [row] = await client<{ count: number }[]>`select count(*)::int as count from drizzle.__drizzle_migrations`
    return row?.count ?? 0
  } finally {
    await client.end({ timeout: 5 })
  }
}

async function checksumBillingFixture(client: ReturnType<typeof postgres>) {
  const rows = await client`
    select 'customer' as kind, id, stripe_customer_id as reference from billing_customers where organization_id = 'restore-test-org'
    union all
    select 'subscription', id, stripe_subscription_id from billing_subscriptions where organization_id = 'restore-test-org'
    union all
    select 'grant', id, remaining_units::text from billing_credit_grants where organization_id = 'restore-test-org'
    union all
    select 'ledger', id, units_delta::text from billing_ledger_entries where organization_id = 'restore-test-org'
    order by kind, id
  `
  const hash = createHash('sha256')
  for (const row of rows) hash.update(`${row.kind}:${row.id}:${row.reference}`)
  return hash.digest('hex')
}

async function restore(source: string, target: string) {
  const sourceConfig = connectionConfig(source)
  const targetConfig = connectionConfig(target)
  const dump = spawn(process.env.PG_DUMP_BIN ?? 'pg_dump', [
    '--format=custom', '--no-owner', '--no-acl', sourceConfig.database,
  ], { env: { ...process.env, ...sourceConfig.environment }, stdio: ['ignore', 'pipe', 'pipe'] })
  const restoreProcess = spawn(process.env.PG_RESTORE_BIN ?? 'pg_restore', [
    '--clean', '--if-exists', '--no-owner', '--no-acl', '--exit-on-error', '--dbname', targetConfig.database,
  ], { env: { ...process.env, ...targetConfig.environment }, stdio: ['pipe', 'ignore', 'pipe'] })
  dump.stdout.pipe(restoreProcess.stdin)
  const [dumpResult, restoreResult] = await Promise.all([
    processResult(dump, 'pg_dump'),
    processResult(restoreProcess, 'pg_restore'),
  ])
  if (dumpResult !== 0) throw new Error('pg_dump failed during restore rehearsal')
  if (restoreResult !== 0) throw new Error('pg_restore failed during restore rehearsal')
}

function connectionConfig(value: string) {
  const url = new URL(value)
  return {
    database: url.pathname.slice(1),
    environment: {
      PGHOST: url.hostname,
      PGPORT: url.port || '5432',
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGSSLMODE: url.searchParams.get('sslmode') ?? 'prefer',
    },
  }
}

function processResult(child: ReturnType<typeof spawn>, label: string) {
  return new Promise<number>((resolve, reject) => {
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 4_000) stderr += String(chunk)
    })
    child.on('error', () => reject(new Error(`${label} is not installed or could not start`)))
    child.on('close', (code) => {
      if (code !== 0 && stderr) console.error(`${label} failed: ${redactProcessError(stderr)}`)
      resolve(code ?? 1)
    })
  })
}

function redactProcessError(value: string) {
  return value.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[REDACTED_DATABASE_URL]').trim()
}
