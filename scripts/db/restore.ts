// Restore a backup produced by scripts/db/backup.ts (plain-SQL pg_dump, gzipped).
// Usage: pnpm tsx scripts/db/restore.ts [--file <path>] [--target <db-url>] [--force]
//
//   --file <path>    Backup file to restore (default: newest *.sql.gz in BACKUP_DIR).
//   --target <url>   Database to restore into (default: DATABASE_URL). Refuses to run
//                     against a URL that matches DATABASE_URL unless --force is passed —
//                     this script is destructive (backup.ts's dump uses --clean --if-exists,
//                     so restoring drops and recreates every object it touches).
//   --force          Required to restore over --target === DATABASE_URL.
//
// Configurable via env (same as backup.ts):
//   DATABASE_URL — restore target when --target is omitted
//   BACKUP_DIR   — directory to look for the newest backup (default: /var/backups/builderhunt)

import { spawn } from 'child_process'
import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { gunzipSync } from 'zlib'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/builderhunt'
const BACKUP_DIR = process.env.BACKUP_DIR ?? '/var/backups/builderhunt'

function parseArgs(argv: string[]) {
  const args: { file?: string; target?: string; force: boolean } = { force: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') args.file = argv[++i]
    else if (argv[i] === '--target') args.target = argv[++i]
    else if (argv[i] === '--force') args.force = true
  }
  return args
}

function newestBackup(dir: string): string | null {
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
    .filter((f) => f.startsWith('builderhunt-') && f.endsWith('.sql.gz'))
    .map((f) => ({ name: f, mtime: statSync(join(dir, f)).mtime.getTime() }))
    .sort((a, b) => b.mtime - a.mtime)
  return files.length > 0 ? join(dir, files[0].name) : null
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
      + '(this is destructive — the dump was taken with --clean --if-exists). '
      + 'Pass --target <scratch-db-url> to restore into a different database, '
      + 'or --force to confirm you mean to overwrite DATABASE_URL.',
    )
    process.exit(1)
  }

  console.log(`[restore] reading ${filePath}`)
  const { readFileSync } = await import('fs')
  const compressed = readFileSync(filePath)
  const sql = gunzipSync(compressed)

  console.log(`[restore] applying to ${redact(target)}`)
  const exitCode = await runPsql(target, sql)
  if (exitCode !== 0) {
    console.error('[restore] psql failed')
    process.exit(1)
  }

  console.log('[restore] verifying row counts')
  await printRowCounts(target)
  console.log('[restore] done')
}

function runPsql(url: string, sql: Buffer): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn('psql', [url, '--set', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'inherit', 'inherit'] })
    // psql can exit (e.g. on ON_ERROR_STOP) before consuming all of stdin —
    // writing to the now-closed pipe throws EPIPE, which is expected here,
    // not a bug in this script; the real failure is `proc`'s exit code.
    proc.stdin.on('error', () => {})
    proc.stdin.write(sql)
    proc.stdin.end()
    proc.on('close', (code) => resolve(code ?? 1))
  })
}

async function printRowCounts(url: string) {
  const postgres = (await import('postgres')).default
  const sql = postgres(url, { max: 1, prepare: false })
  try {
    for (const table of ['auth_users', 'builders', 'saved_queries']) {
      try {
        const [row] = await sql.unsafe(`select count(*)::int as count from ${table}`)
        console.log(`[restore]   ${table}: ${row.count} rows`)
      } catch {
        console.log(`[restore]   ${table}: table not present`)
      }
    }
  } finally {
    await sql.end()
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

main().catch((e) => {
  console.error('[restore] fatal:', e)
  process.exit(1)
})
