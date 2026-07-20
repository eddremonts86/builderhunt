import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

const migrationDirectory = join(process.cwd(), 'drizzle')
const metadataDirectory = join(migrationDirectory, 'meta')
const manifestPath = join(migrationDirectory, 'migration-hashes.json')
const journal = JSON.parse(await readFile(join(metadataDirectory, '_journal.json'), 'utf8'))
const sqlFiles = (await readdir(migrationDirectory)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()
const snapshotFiles = (await readdir(metadataDirectory)).filter((name) => /^\d{4}_snapshot\.json$/.test(name)).sort()

const expectedSql = journal.entries.map((entry) => `${entry.tag}.sql`)
const expectedSnapshots = journal.entries.map((entry) => `${String(entry.idx).padStart(4, '0')}_snapshot.json`)
assertSameFiles('SQL migrations', expectedSql, sqlFiles)
assertSameFiles('migration snapshots', expectedSnapshots, snapshotFiles)

const migrations = {}
for (const entry of journal.entries) {
  const sqlName = `${entry.tag}.sql`
  const snapshotName = `${String(entry.idx).padStart(4, '0')}_snapshot.json`
  migrations[entry.tag] = {
    sql: await hashFile(join(migrationDirectory, sqlName)),
    snapshot: await hashFile(join(metadataDirectory, snapshotName)),
  }
}
const current = { version: 1, migrations }

if (process.argv.includes('--write')) {
  await writeFile(manifestPath, `${JSON.stringify(current, null, 2)}\n`)
  console.log(JSON.stringify({ written: basename(manifestPath), migrations: journal.entries.length }))
} else {
  const committed = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (JSON.stringify(committed) !== JSON.stringify(current)) {
    throw new Error('Migration hash manifest mismatch; applied migration files are immutable')
  }
  console.log(JSON.stringify({ valid: true, migrations: journal.entries.length }))
}

function assertSameFiles(label, expected, actual) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`${label} do not match drizzle/meta/_journal.json`)
  }
}

async function hashFile(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}
