import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

describe('migration integrity manifest', () => {
  it('matches every journaled SQL migration and snapshot', async () => {
    const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8'))
    const { stdout } = await execFileAsync(process.execPath, ['scripts/db/verify-migration-integrity.mjs'])
    expect(JSON.parse(stdout)).toMatchObject({ valid: true, migrations: journal.entries.length })
  })
})
