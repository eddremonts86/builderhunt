import { spawn } from 'node:child_process'
import postgres from 'postgres'
import { assertRestoreTestTargets } from '../../src/shared/lib/db/restore-policy'

const sourceUrl = process.env.RESTORE_TEST_SOURCE_URL
const targetUrl = process.env.RESTORE_TEST_TARGET_URL
if (!sourceUrl || !targetUrl) throw new Error('RESTORE_TEST_SOURCE_URL and RESTORE_TEST_TARGET_URL are required')
assertRestoreTestTargets(sourceUrl, targetUrl)

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
      ])})
      and (not c.relrowsecurity or not c.relforcerowsecurity)
  `
  if (migrations?.count !== 13) throw new Error(`Restored migration count mismatch: ${migrations?.count ?? 0}`)
  if (rls?.missing !== 0) throw new Error(`Restored RLS manifest has ${rls?.missing ?? 0} missing policies`)
  console.log(JSON.stringify({ restored: true, migrations: migrations.count, rlsMissing: rls.missing }))
} finally {
  await target.end({ timeout: 5 })
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
