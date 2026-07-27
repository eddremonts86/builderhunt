// Restore a BuilderHunt database backup, creating the cluster roles first.
//
// Usage: pnpm db:restore --target <db-url> [--file <path>] [options]
//
//   --file <path>       Backup to restore. Default: newest backup in BACKUP_DIR.
//                       Three formats are auto-detected by content, not by filename:
//                         • gzipped plain SQL  — what scripts/db/backup.ts writes
//                         • pg_dump custom     — what Coolify's scheduled backup writes
//                         • gzipped custom     — the same, compressed
//   --target <url>      Database to restore into. Default: DATABASE_URL. Refuses to run
//                       against DATABASE_URL itself unless --force is passed, because this
//                       is destructive (both dump paths drop and recreate what they touch).
//   --force             Confirm you mean to overwrite --target === DATABASE_URL.
//   --roles-file <path> Apply this SQL to the target cluster before restoring, instead of
//                       the in-repo scripts/db/roles.sql. Point it at the
//                       `*.roles.sql` captured next to the dump by
//                       scripts/ops/builderhunt-backup-sync.sh when you want the cluster's
//                       actual role list rather than the repo's expected one.
//   --skip-roles        Do not create roles. Only correct when restoring into a cluster
//                       that already has them (e.g. a scratch database beside the live one).
//   --skip-verify       Skip the post-restore RLS check. Not recommended.
//
// Why the roles step exists
// =========================
// `pg_dump` of a single database does not include roles — they are cluster-level objects
// that live in `pg_dumpall`. Every `CREATE POLICY ... TO builderhunt_app` in the dump fails
// with `role "builderhunt_app" does not exist` when restoring into a fresh cluster, while
// `ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY` restores fine. The result is RLS forced
// with zero policies: fail-closed, so not a data leak, but an unusable database — and the
// obvious incident-time "fix" (drop RLS, or grant BYPASSRLS) turns it into a real one.
// Found by the 2026-07-26 restore test; see docs/operations/database-restore.md.
//
// Env:
//   DATABASE_URL — restore target when --target is omitted
//   BACKUP_DIR   — where to look for the newest backup (default: /var/backups/builderhunt)
//   PSQL_BIN / PG_RESTORE_BIN — override the binaries (default: psql / pg_restore)

import { spawn } from 'child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { gunzipSync } from 'zlib'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/builderhunt'
const BACKUP_DIR = process.env.BACKUP_DIR ?? '/var/backups/builderhunt'
const PSQL_BIN = process.env.PSQL_BIN ?? 'psql'
const PG_RESTORE_BIN = process.env.PG_RESTORE_BIN ?? 'pg_restore'
const DEFAULT_ROLES_SQL = join(fileURLToPath(new URL('.', import.meta.url)), 'roles.sql')

/** pg_dump custom-format archives start with the literal bytes `PGDMP`. */
const CUSTOM_FORMAT_MAGIC = Buffer.from('PGDMP')
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b])

type Format = 'plain' | 'custom'

interface Args {
  file?: string
  target?: string
  rolesFile?: string
  force: boolean
  skipRoles: boolean
  skipVerify: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { force: false, skipRoles: false, skipVerify: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') args.file = argv[++i]
    else if (argv[i] === '--target') args.target = argv[++i]
    else if (argv[i] === '--roles-file') args.rolesFile = argv[++i]
    else if (argv[i] === '--force') args.force = true
    else if (argv[i] === '--skip-roles') args.skipRoles = true
    else if (argv[i] === '--skip-verify') args.skipVerify = true
    else {
      console.error(`[restore] unknown argument: ${argv[i]}`)
      process.exit(1)
    }
  }
  return args
}

function newestBackup(dir: string): string | null {
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
    .filter((f) => f.startsWith('builderhunt-') && /\.(sql\.gz|dmp|dmp\.gz)$/.test(f))
    .map((f) => ({ name: f, mtime: statSync(join(dir, f)).mtime.getTime() }))
    .sort((a, b) => b.mtime - a.mtime)
  return files.length > 0 ? join(dir, files[0].name) : null
}

/**
 * Detects the archive format from its bytes rather than its extension — Coolify names its
 * dumps by database and timestamp with no format hint, and a mis-detected format fails deep
 * inside psql with a confusing parse error instead of here.
 */
function readBackup(path: string): { format: Format; body: Buffer } {
  let body = readFileSync(path)
  if (body.subarray(0, 2).equals(GZIP_MAGIC)) body = gunzipSync(body)
  const format: Format = body.subarray(0, 5).equals(CUSTOM_FORMAT_MAGIC) ? 'custom' : 'plain'
  return { format, body }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const filePath = args.file ?? newestBackup(BACKUP_DIR)
  if (!filePath) {
    console.error(`[restore] no --file given and no backups found in ${BACKUP_DIR}`)
    process.exit(1)
  }
  if (!existsSync(filePath)) {
    console.error(`[restore] file not found: ${filePath}`)
    process.exit(1)
  }

  const target = args.target ?? DATABASE_URL
  if (target === DATABASE_URL && !args.force) {
    console.error(
      '[restore] refusing to restore over DATABASE_URL without --force '
      + '(this is destructive — the dump drops and recreates every object it touches). '
      + 'Pass --target <scratch-db-url> to restore into a different database, '
      + 'or --force to confirm you mean to overwrite DATABASE_URL.',
    )
    process.exit(1)
  }

  console.log(`[restore] reading ${filePath}`)
  const { format, body } = readBackup(filePath)
  console.log(`[restore] detected ${format === 'custom' ? 'pg_dump custom-format archive' : 'plain SQL'}`)

  // Roles first. A dump's CREATE POLICY statements name roles that only exist at cluster
  // level, so this has to happen before pg_restore, not after.
  if (args.skipRoles) {
    console.warn('[restore] --skip-roles: assuming the target cluster already has the builderhunt_* roles')
  } else {
    const rolesFile = args.rolesFile ?? DEFAULT_ROLES_SQL
    if (!existsSync(rolesFile)) {
      console.error(`[restore] roles file not found: ${rolesFile}`)
      process.exit(1)
    }
    console.log(`[restore] creating cluster roles from ${rolesFile}`)
    // ON_ERROR_STOP is deliberately off here, and success is judged by the postcondition
    // below instead of the exit code. A `pg_dumpall --roles-only` file always contains a
    // `CREATE ROLE` for the cluster's own bootstrap superuser (usually `postgres`), which
    // already exists on any live target — aborting on that would make the captured
    // roles dump unusable, which is the opposite of the point.
    await runPsql(target, readFileSync(rolesFile), { stopOnError: false })

    const missing = await missingRoles(target)
    if (missing.length > 0) {
      console.error(
        `[restore] role bootstrap did not produce ${missing.join(', ')} — aborting before `
        + 'pg_restore, because restoring now would silently drop every RLS policy bound to '
        + `the missing role(s). Check that ${redact(target)}'s user has CREATEROLE.`,
      )
      process.exit(1)
    }
    await printRoles(target)
  }

  console.log(`[restore] applying to ${redact(target)}`)
  const exitCode = format === 'custom'
    ? await runPgRestore(target, body)
    // ON_ERROR_STOP is deliberately off for plain SQL: `--clean --if-exists` still emits
    // drops for objects that may not exist on a first restore into an empty database.
    // The verification step below is what decides whether the result is acceptable.
    : await runPsql(target, body, { stopOnError: false })
  if (exitCode !== 0) {
    console.error(`[restore] ${format === 'custom' ? 'pg_restore' : 'psql'} exited ${exitCode}`)
    if (!args.skipVerify) console.error('[restore] running verification anyway to report what landed')
    else process.exit(1)
  }

  console.log('[restore] verifying row counts')
  await printRowCounts(target)

  if (args.skipVerify) {
    console.warn('[restore] --skip-verify: RLS integrity was NOT checked')
    process.exit(exitCode === 0 ? 0 : 1)
  }

  const ok = await verifyRlsIntegrity(target)
  if (!ok || exitCode !== 0) process.exit(1)
  console.log('[restore] done')
}

/**
 * The check that would have caught the 2026-07-26 defect. A restore is only correct if every
 * table with RLS turned on also has policies: `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`
 * and `CREATE POLICY` are separate entries in the archive, and only the second kind depends
 * on roles existing — so a roles-less restore leaves RLS on with nothing behind it. Row
 * counts and table counts both look perfect in that state, which is why this has to be an
 * explicit assertion rather than something an operator eyeballs.
 */
async function verifyRlsIntegrity(url: string): Promise<boolean> {
  const postgres = (await import('postgres')).default
  const sql = postgres(url, { max: 1, prepare: false })
  try {
    const [totals] = await sql<{ policies: number; rls_tables: number; tables: number }[]>`
      select
        (select count(*)::int from pg_policies where schemaname = 'public') as policies,
        (select count(*)::int from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity) as rls_tables,
        (select count(*)::int from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r') as tables
    `
    const unprotected = await sql<{ relname: string }[]>`
      select c.relname
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relkind = 'r'
         and c.relrowsecurity
         and not exists (select 1 from pg_policies p
                          where p.schemaname = 'public' and p.tablename = c.relname)
       order by c.relname
    `
    const bypass = await sql<{ rolname: string }[]>`
      select rolname from pg_roles
       where rolname like 'builderhunt%' and (rolbypassrls or rolsuper)
       order by rolname
    `

    console.log(`[restore]   tables: ${totals.tables}, RLS-enabled: ${totals.rls_tables}, policies: ${totals.policies}`)

    let ok = true
    if (unprotected.length > 0) {
      console.error(
        `[restore] FAIL: ${unprotected.length} table(s) have RLS enabled with ZERO policies — `
        + 'the restore lost the tenant-isolation policies. This is what a roles-less '
        + 'pg_restore looks like: re-run with the roles step (do not "fix" it by disabling '
        + 'RLS). Affected: '
        + `${unprotected.slice(0, 10).map((r) => r.relname).join(', ')}`
        + `${unprotected.length > 10 ? `, +${unprotected.length - 10} more` : ''}`,
      )
      ok = false
    }
    if (bypass.length > 0) {
      console.error(
        `[restore] FAIL: role(s) ${bypass.map((r) => r.rolname).join(', ')} have SUPERUSER or `
        + 'BYPASSRLS, which defeats every policy that was just restored',
      )
      ok = false
    }
    if (ok) console.log('[restore]   RLS integrity OK — every RLS-enabled table has policies')
    return ok
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/**
 * The roles this application's policies bind to, read out of `scripts/db/roles.sql` so there
 * is one source of truth — `test/security/restore-roles-bootstrap.test.ts` already keeps that
 * file in step with the migrations. Used to check the roles step by its result rather than by
 * whichever exit code a hand-captured roles dump happens to produce.
 */
function requiredRoles(): string[] {
  const sql = readFileSync(DEFAULT_ROLES_SQL, 'utf8')
  return [...sql.matchAll(/CREATE\s+ROLE\s+(builderhunt_[a-z_]+)/gi)].map((m) => m[1].toLowerCase())
}

async function missingRoles(url: string): Promise<string[]> {
  const postgres = (await import('postgres')).default
  const sql = postgres(url, { max: 1, prepare: false })
  try {
    const rows = await sql<{ rolname: string }[]>`
      select rolname from pg_roles where rolname like 'builderhunt%'
    `
    const present = new Set(rows.map((r) => r.rolname))
    return requiredRoles().filter((role) => !present.has(role))
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function printRoles(url: string) {
  const postgres = (await import('postgres')).default
  const sql = postgres(url, { max: 1, prepare: false })
  try {
    const rows = await sql<{ rolname: string }[]>`
      select rolname from pg_roles where rolname like 'builderhunt%' order by rolname
    `
    console.log(`[restore]   roles present: ${rows.map((r) => r.rolname).join(', ') || 'none'}`)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

function runPsql(url: string, sql: Buffer, opts: { stopOnError: boolean }): Promise<number> {
  return new Promise((resolve) => {
    const argv = [url]
    if (opts.stopOnError) argv.push('--set', 'ON_ERROR_STOP=1')
    const proc = spawn(PSQL_BIN, argv, { stdio: ['pipe', 'inherit', 'inherit'] })
    // psql can exit (e.g. on ON_ERROR_STOP) before consuming all of stdin —
    // writing to the now-closed pipe throws EPIPE, which is expected here,
    // not a bug in this script; the real failure is `proc`'s exit code.
    proc.stdin.on('error', () => {})
    proc.on('error', () => resolve(1))
    proc.stdin.write(sql)
    proc.stdin.end()
    proc.on('close', (code) => resolve(code ?? 1))
  })
}

/**
 * pg_restore reads the archive from stdin. `--exit-on-error` is intentionally NOT used:
 * on a real recovery you want every object it can create, and then a verdict from
 * verifyRlsIntegrity — not a half-restored database abandoned at the first error.
 * Errors are echoed so they land in the drill log.
 */
function runPgRestore(url: string, archive: Buffer): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(
      PG_RESTORE_BIN,
      ['--dbname', url, '--clean', '--if-exists', '--no-owner', '--no-acl'],
      { stdio: ['pipe', 'inherit', 'pipe'] },
    )
    let errorCount = 0
    let stderr = ''
    proc.stderr.on('data', (chunk) => {
      const text = String(chunk)
      errorCount += (text.match(/^pg_restore: error:/gm) ?? []).length
      if (stderr.length < 8_000) stderr += text
    })
    proc.stdin.on('error', () => {})
    proc.on('error', () => resolve(1))
    proc.stdin.write(archive)
    proc.stdin.end()
    proc.on('close', (code) => {
      if (errorCount > 0) {
        console.error(`[restore] pg_restore reported ${errorCount} error(s):`)
        console.error(redactProcessError(stderr).split('\n').slice(0, 20).join('\n'))
        if (/role "[a-z_]+" does not exist/.test(stderr)) {
          console.error(
            '[restore] those "role does not exist" errors mean the cluster roles were '
            + 'missing before pg_restore ran. Do not paper over it: create the roles '
            + '(scripts/db/roles.sql), drop and recreate the target database, and restore again.',
          )
        }
      }
      // pg_restore exits 0 with warnings in some versions; treat any counted error as failure.
      resolve(code === 0 && errorCount === 0 ? 0 : (code ?? 1))
    })
  })
}

async function printRowCounts(url: string) {
  const postgres = (await import('postgres')).default
  const sql = postgres(url, { max: 1, prepare: false })
  try {
    for (const table of ['auth_users', 'organizations', 'builders', 'saved_queries']) {
      try {
        const [row] = await sql.unsafe(`select count(*)::int as count from ${table}`)
        console.log(`[restore]   ${table}: ${row.count} rows`)
      } catch {
        console.log(`[restore]   ${table}: table not present`)
      }
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

function redact(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.password = parsed.password ? '***' : ''
    return parsed.toString()
  } catch {
    return '<unparseable url>'
  }
}

function redactProcessError(value: string): string {
  return value.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[REDACTED_DATABASE_URL]').trim()
}

main().catch((e) => {
  console.error('[restore] fatal:', e)
  process.exit(1)
})
