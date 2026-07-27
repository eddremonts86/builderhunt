// Fresh-cluster restore drill: restore a real backup into a throwaway Postgres cluster that
// has never seen this application, then assert the result is actually usable.
//
// Usage: pnpm db:restore-drill --file <dump> [--roles-file <path>] [--keep] [--skip-roles]
//
//   --file <path>       The backup to restore. Required.
//   --roles-file <path> Passed through to scripts/db/restore.ts.
//   --skip-roles        Passed through — use this to reproduce the original defect.
//   --keep              Leave the container running for inspection (prints the URL).
//   --image <ref>       Postgres image (default: pgvector/pgvector:pg16 — must match
//                       production, because the dump contains `CREATE EXTENSION vector`).
//
// Why this exists separately from scripts/db/restore-test.ts
// =========================================================
// `restore-test.ts` rehearses dump→restore between two databases on ONE server
// (`assertRestoreTestTargets` requires the same host on purpose). That cannot catch a
// missing-roles defect: roles are cluster-level, so a same-cluster restore always finds them
// already present. The 2026-07-26 production restore test failed with 192
// `role "builderhunt_app" does not exist` errors that `restore-test.ts` had been passing
// straight through for months. A fresh cluster is the only place that class of bug appears.
//
// Requires Docker. Nothing here touches production or any long-lived database: the container
// gets an ephemeral name, no volume, and a loopback-only port.

import { spawn, spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { randomBytes } from 'crypto'

interface Args {
  file?: string
  rolesFile?: string
  skipRoles: boolean
  keep: boolean
  image: string
}

function parseArgs(argv: string[]): Args {
  const args: Args = { skipRoles: false, keep: false, image: 'pgvector/pgvector:pg16' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') args.file = argv[++i]
    else if (argv[i] === '--roles-file') args.rolesFile = argv[++i]
    else if (argv[i] === '--image') args.image = argv[++i]
    else if (argv[i] === '--skip-roles') args.skipRoles = true
    else if (argv[i] === '--keep') args.keep = true
    else {
      console.error(`[drill] unknown argument: ${argv[i]}`)
      process.exit(1)
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (!args.file) {
  console.error('[drill] --file <dump> is required')
  process.exit(1)
}
if (!existsSync(args.file)) {
  console.error(`[drill] file not found: ${args.file}`)
  process.exit(1)
}

const suffix = randomBytes(4).toString('hex')
const container = `builderhunt-restore-drill-${suffix}`
// A random high port keeps concurrent drills from colliding; loopback-only so the scratch
// cluster is never reachable off the machine running the drill.
const port = 55_000 + Math.floor(Math.random() * 9_000)
const password = randomBytes(16).toString('hex')
const targetUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/builderhunt`

function docker(argv: string[], opts: { check?: boolean } = {}) {
  const result = spawnSync('docker', argv, { encoding: 'utf8' })
  if (opts.check && result.status !== 0) {
    throw new Error(`docker ${argv[0]} failed: ${result.stderr?.trim() || result.stdout?.trim()}`)
  }
  return result
}

function run(command: string, argv: string[]): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(command, argv, { stdio: 'inherit' })
    proc.on('error', () => resolve(1))
    proc.on('close', (code) => resolve(code ?? 1))
  })
}

function query(sql: string): string {
  const result = docker(['exec', container, 'psql', '-U', 'postgres', '-d', 'builderhunt', '-tAc', sql])
  if (result.status !== 0) throw new Error(`query failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

async function main() {
  if (docker(['version']).status !== 0) {
    console.error('[drill] Docker is not available — this drill needs it to create a throwaway cluster')
    process.exit(1)
  }

  console.log(`[drill] starting throwaway ${args.image} as ${container} on 127.0.0.1:${port}`)
  docker([
    'run', '-d', '--name', container,
    '-e', `POSTGRES_PASSWORD=${password}`,
    '-p', `127.0.0.1:${port}:5432`,
    args.image,
  ], { check: true })

  // Wait for the cluster to accept connections. pg_isready inside the container avoids
  // depending on client tooling on the host for this step.
  let ready = false
  for (let i = 0; i < 60; i++) {
    if (docker(['exec', container, 'pg_isready', '-U', 'postgres']).status === 0) {
      ready = true
      break
    }
    await new Promise((r) => setTimeout(r, 1_000))
  }
  if (!ready) throw new Error('throwaway Postgres never became ready')

  // Prove the premise: this cluster has none of our roles, which is what makes it a valid
  // stand-in for restoring onto new hardware after losing the box.
  const preexisting = docker([
    'exec', container, 'psql', '-U', 'postgres', '-tAc',
    "select count(*) from pg_roles where rolname like 'builderhunt%'",
  ]).stdout.trim()
  if (preexisting !== '0') throw new Error(`expected a cluster with no builderhunt roles, found ${preexisting}`)
  console.log('[drill] confirmed: fresh cluster, 0 builderhunt_* roles')

  docker(['exec', container, 'psql', '-U', 'postgres', '-c', 'create database builderhunt'], { check: true })

  const restoreArgs = ['db:restore', '--file', args.file!, '--target', targetUrl]
  if (args.rolesFile) restoreArgs.push('--roles-file', args.rolesFile)
  if (args.skipRoles) restoreArgs.push('--skip-roles')

  console.log('[drill] running the restore')
  const restoreExit = await run('pnpm', restoreArgs)

  // Independent verification, queried from inside the container rather than trusting the
  // restore script's own verdict — the point of a drill is to check the tool, too.
  const [policies, rlsTables, tables, orphans, roles] = [
    query("select count(*) from pg_policies where schemaname='public'"),
    query("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity"),
    query("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'"),
    query("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity and not exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=c.relname)"),
    query("select count(*) from pg_roles where rolname like 'builderhunt%'"),
  ]

  console.log('\n[drill] independent verification from inside the fresh cluster:')
  console.log(`[drill]   builderhunt roles: ${roles}`)
  console.log(`[drill]   tables: ${tables}`)
  console.log(`[drill]   RLS-enabled tables: ${rlsTables}`)
  console.log(`[drill]   policies: ${policies}`)
  console.log(`[drill]   RLS-enabled tables with ZERO policies: ${orphans}`)

  const failures: string[] = []
  if (restoreExit !== 0) failures.push(`restore exited ${restoreExit}`)
  if (Number(orphans) !== 0) failures.push(`${orphans} table(s) have RLS enabled but no policies`)
  if (Number(policies) === 0) failures.push('no policies were restored at all')
  if (Number(rlsTables) === 0) failures.push('no table has RLS enabled — the dump may be schema-less')

  if (failures.length > 0) {
    console.error(`\n[drill] FAILED: ${failures.join('; ')}`)
    return 1
  }
  console.log('\n[drill] PASSED: fresh-cluster restore produced a complete, policy-bearing database')
  return 0
}

let exitCode = 1
try {
  exitCode = await main()
} catch (e) {
  console.error('[drill] fatal:', e instanceof Error ? e.message : e)
} finally {
  if (args.keep) {
    console.log(`[drill] --keep: container ${container} left running at ${targetUrl}`)
    console.log(`[drill] remove it with: docker rm -f ${container}`)
  } else {
    docker(['rm', '-f', container])
    console.log(`[drill] removed ${container}`)
  }
}
process.exit(exitCode)
