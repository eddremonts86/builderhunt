import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import postgres from 'postgres'
import { assertRestoreTestTargets } from '../../src/shared/lib/db/restore-policy'

const sourceUrl = process.env.RESTORE_TEST_SOURCE_URL
const targetUrl = process.env.RESTORE_TEST_TARGET_URL
if (!sourceUrl || !targetUrl) throw new Error('RESTORE_TEST_SOURCE_URL and RESTORE_TEST_TARGET_URL are required')
assertRestoreTestTargets(sourceUrl, targetUrl, { allowCrossHost: process.env.RESTORE_TEST_ALLOW_CROSS_HOST === 'true' })

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
        // calendar-scheduling-interview-intelligence tables (drizzle/0080–0095). Every one is tenant-private
        // with RLS forced, and the point of listing them here is that a restore which lost a policy would
        // otherwise present a candidate's transcript to anyone with a connection — the failure a restore
        // rehearsal exists to catch before an incident does.
        'user_calendars', 'calendar_events', 'calendar_event_exceptions', 'event_participants',
        'scheduling_invitations', 'candidate_submissions', 'candidate_documents', 'document_extractions',
        'candidate_links', 'candidate_web_imports', 'privacy_consents',
        'interview_briefs', 'interview_sessions', 'transcript_segments', 'interview_suggestions',
        'interview_reports',
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

  // ── No audio survives a restore, because none was ever stored ──────────────────────────────────
  //
  // Asserted against the restored database rather than trusted from the schema, because a restore is exactly
  // where a column could arrive from an older dump: `pg_restore` recreates whatever the dump held, and a dump
  // taken before an audio column was removed would bring it back. The interview feature's central promise is
  // that audio is never stored, and a promise that is only true in the current migration is not a promise.
  const [audioColumns] = await target<{ found: number; names: string | null }[]>`
    select count(*)::int as found, string_agg(table_name || '.' || column_name, ', ') as names
    from information_schema.columns
    where table_schema = 'public'
      and (table_name like 'interview%' or table_name like 'candidate%' or table_name like 'transcript%')
      and (
        column_name ~* '(audio|waveform|pcm|recording|mp3|wav|webm|opus|blob)'
        or (column_name ~* 'media' and column_name !~* 'media_type')
      )
  `
  if ((audioColumns?.found ?? 0) > 0) {
    throw new Error(`Restored schema has audio-shaped columns: ${audioColumns?.names ?? 'unknown'}`)
  }

  // And no object key that looks like audio. A document row is metadata plus a key into private storage, so a
  // key ending in an audio extension would mean the storage layer holds a recording whatever the schema says.
  //
  // **This is a backstop that cannot fire against a current schema**, and saying so is more useful than
  // implying it is a proven guard: `candidate_documents_no_audio_check` already refuses an `audio/*` media
  // type at insert time, so a live database can never hold such a row. The case it covers is the one a restore
  // rehearsal exists for — a dump taken *before* that constraint existed, restored into a database that now
  // has it. Verified by dropping the constraint in a source database and confirming this throws; without that
  // step the assertion would report clean forever and nobody would know.
  const [audioKeys] = await target<{ found: number }[]>`
    select count(*)::int as found from candidate_documents
    where object_key ~* '\.(mp3|wav|webm|ogg|opus|m4a|flac)$'
       or declared_media_type ~* '^audio/'
  `
  if ((audioKeys?.found ?? 0) > 0) {
    throw new Error(`Restored data has ${audioKeys?.found} document rows pointing at audio objects`)
  }

  console.log(JSON.stringify({
    restored: true,
    migrations: migrations.count,
    rlsMissing: rls.missing,
    audioColumns: audioColumns?.found ?? 0,
    audioObjectKeys: audioKeys?.found ?? 0,
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
  // `pg_dump` must match the server major version. The local dev
  // environment has the app database inside a Docker container
  // (pg18+); if the host's `pg_dump` is older (e.g. Homebrew pg16
  // on macOS) it refuses with "server version mismatch" and the
  // rehearsal reports a spurious failure. In that case we fall
  // back to running `pg_dump` / `pg_restore` *inside* the container
  // via `docker exec`, which always has the matching client.
  //
  // The override env vars `PG_DUMP_BIN` and `PG_RESTORE_BIN` win
  // over this auto-detection so CI / prod can pin a specific
  // pg-client image (e.g. `ghcr.io/example/pg18-client`) without
  // needing Docker on the host.
  const serverVersion = await detectServerMajorVersion(sourceConfig)
  const { dumpBin, restoreBin } = await resolveClientBins(serverVersion, sourceConfig)
  const dump = spawn(dumpBin, [
    '--format=custom', '--no-owner', '--no-acl', sourceConfig.database,
  ], { env: { ...process.env, ...sourceConfig.environment }, stdio: ['ignore', 'pipe', 'pipe'] })
  const restoreProcess = spawn(restoreBin, [
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

/**
 * Read the server's `server_version_num` so we know which pg_dump
 * major version we need. Returns `null` on failure — the caller
 * then proceeds with the host's `pg_dump` and may surface a
 * version-mismatch error from pg_dump itself, which is still
 * more informative than a script-level guess.
 */
async function detectServerMajorVersion(config: ReturnType<typeof connectionConfig>): Promise<number | null> {
  const probe = spawn('psql', [
    '--no-psqlrc', '--no-align', '--tuples-only', '--command', 'show server_version_num',
    config.database,
  ], { env: { ...process.env, ...config.environment }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  probe.stdout?.on('data', (chunk) => { stdout += String(chunk) })
  probe.stderr?.on('data', (chunk) => { stderr += String(chunk) })
  const code: number = await new Promise((resolve) => probe.on('close', (c) => resolve(c ?? 1)))
  if (code !== 0) return null
  const trimmed = stdout.trim()
  const num = Number.parseInt(trimmed, 10)
  if (Number.isNaN(num)) return null
  // `server_version_num` is YYYYMM (e.g. 180004 for 18.4). The major
  // version is the first two digits.
  return Math.floor(num / 10000)
}

/**
 * Read the host's `pg_dump --version` and return its major version,
 * or `null` if it cannot be determined.
 */
async function detectClientMajorVersion(bin: string): Promise<number | null> {
  const probe = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  probe.stdout?.on('data', (chunk) => { stdout += String(chunk) })
  const code: number = await new Promise((resolve) => probe.on('close', (c) => resolve(c ?? 1)))
  if (code !== 0) return null
  const match = /(\d+)(?:\.\d+)?/.exec(stdout)
  return match ? Number.parseInt(match[1], 10) : null
}

/**
 * Pick the `pg_dump` / `pg_restore` binaries the rehearsal should
 * use. Priority:
 *   1. Explicit `PG_DUMP_BIN` / `PG_RESTORE_BIN` env vars.
 *   2. If the host's `pg_dump` is older than the server, fall
 *      back to `docker exec` into the container named
 *      `BUILDERHUNT_DB_CONTAINER` (default `builderhunt-db`).
 *   3. Otherwise the host's `pg_dump` / `pg_restore`.
 *
 * In CI / prod, set `PG_DUMP_BIN` to a `pg_dump` whose major
 * version matches the server and step 1 wins. In local dev with
 * Docker, step 2 is automatic.
 */
async function resolveClientBins(
  serverMajor: number | null,
  config: ReturnType<typeof connectionConfig>,
): Promise<{ dumpBin: string; restoreBin: string }> {
  const explicitDump = process.env.PG_DUMP_BIN
  const explicitRestore = process.env.PG_RESTORE_BIN
  if (explicitDump && explicitRestore) {
    return { dumpBin: explicitDump, restoreBin: explicitRestore }
  }
  if (serverMajor === null) {
    return { dumpBin: explicitDump ?? 'pg_dump', restoreBin: explicitRestore ?? 'pg_restore' }
  }
  const hostDump = explicitDump ?? 'pg_dump'
  const hostRestore = explicitRestore ?? 'pg_restore'
  const hostDumpMajor = await detectClientMajorVersion(hostDump)
  if (hostDumpMajor !== null && hostDumpMajor >= serverMajor) {
    return { dumpBin: hostDump, restoreBin: hostRestore }
  }
  // Host client is too old. Try the Docker fallback.
  const container = process.env.BUILDERHUNT_DB_CONTAINER ?? 'builderhunt-db'
  if (await isDockerContainerRunning(container)) {
    return {
      dumpBin: explicitDump ?? dockerExecBin(container, 'pg_dump'),
      restoreBin: explicitRestore ?? dockerExecBin(container, 'pg_restore'),
    }
  }
  throw new Error(
    `pg_dump major version (${hostDumpMajor ?? 'unknown'}) is older than the server ` +
    `(major ${serverMajor}). Install postgresql-client-${serverMajor} or set PG_DUMP_BIN / ` +
    `PG_RESTORE_BIN to a matching client.`,
  )
}

function dockerExecBin(container: string, cmd: string): string {
  // `spawn` passes the rest of the args after the binary name, so
  // we wrap `docker exec` in a small shell that adds the container
  // and the requested command.
  return `docker exec ${container} ${cmd}`
}

async function isDockerContainerRunning(container: string): Promise<boolean> {
  const probe = spawn('docker', ['inspect', '--type=container', container], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise((resolve) => {
    probe.on('error', () => resolve(false))
    probe.on('close', (code) => resolve(code === 0))
  })
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
