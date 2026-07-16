// Daily DB backup to local disk. Run via cron at 03:00 UTC.
// Usage: pnpm tsx scripts/db/backup.ts
//
// Configurable via env:
//   DATABASE_URL — required (same as the app)
//   BACKUP_DIR — directory to write backups (default: /var/backups/builderhunt)
//   BACKUP_KEEP — number of daily backups to retain (default: 30)

import { spawn } from 'child_process'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { gzipSync } from 'zlib'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/builderhunt'
const BACKUP_DIR = process.env.BACKUP_DIR ?? '/var/backups/builderhunt'
const KEEP = Number(process.env.BACKUP_KEEP ?? 30)

async function main() {
  if (!existsSync(BACKUP_DIR)) {
    try {
      mkdirSync(BACKUP_DIR, { recursive: true })
    } catch (e) {
      console.error(`Cannot create ${BACKUP_DIR}:`, e instanceof Error ? e.message : e)
      process.exit(1)
    }
  }

  const now = new Date()
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, '') // YYYYMMDD
  const filename = `builderhunt-${stamp}-${now.getTime()}.sql.gz`
  const outPath = join(BACKUP_DIR, filename)

  console.log(`[backup] starting dump to ${outPath}`)

  // Run pg_dump
  const dump = await runPgDump(DATABASE_URL)
  if (!dump) {
    console.error('[backup] pg_dump failed')
    process.exit(1)
  }

  // Compress and write
  const compressed = gzipSync(dump)
  await Bun?.write?.(outPath, compressed) ?? writeFile(outPath, compressed)

  const sizeMB = (compressed.length / 1024 / 1024).toFixed(2)
  console.log(`[backup] wrote ${outPath} (${sizeMB} MB)`)

  // Rotate old backups
  rotate(BACKUP_DIR, KEEP)
  console.log(`[backup] done, kept last ${KEEP} backups`)
}

function runPgDump(url: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const proc = spawn('pg_dump', [url, '--no-owner', '--no-acl', '--clean', '--if-exists'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    proc.stdout.on('data', (chunk) => chunks.push(chunk))
    let stderr = ''
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks))
      } else {
        console.error('[backup] pg_dump stderr:', stderr)
        resolve(null)
      }
    })
  })
}

async function writeFile(path: string, data: Buffer) {
  const { writeFile } = await import('fs/promises')
  await writeFile(path, data)
}

function rotate(dir: string, keep: number) {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith('builderhunt-') && f.endsWith('.sql.gz'))
    .map((f) => ({ name: f, mtime: statSync(join(dir, f)).mtime.getTime() }))
    .sort((a, b) => b.mtime - a.mtime)

  if (files.length <= keep) return
  for (const f of files.slice(keep)) {
    const p = join(dir, f.name)
    unlinkSync(p)
    console.log(`[backup] removed old backup ${f.name}`)
  }
}

main().catch((e) => {
  console.error('[backup] fatal:', e)
  process.exit(1)
})
