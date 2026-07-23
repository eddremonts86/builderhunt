import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

describe('migration integrity manifest', () => {
  it('matches every journaled SQL migration and snapshot', async () => {
    const { stdout } = await execFileAsync(process.execPath, ['scripts/db/verify-migration-integrity.mjs'])
    expect(JSON.parse(stdout)).toMatchObject({ valid: true, migrations: 27 })
  })
})
