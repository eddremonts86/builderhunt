import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { can, canManageTeamSettings, toInvitationSummaryDto, toOrganizationSummaryDto } from '~/shared/lib/organizations/contracts'
import type { InvitationRecord } from '~/shared/lib/auth/organization-lifecycle'

describe('organization contracts', () => {
  it('maps an organization record + role into a summary DTO with no extra fields', () => {
    const dto = toOrganizationSummaryDto({ id: 'org-1', name: 'Acme', slug: 'acme' }, 'admin', false)
    expect(dto).toEqual({ id: 'org-1', name: 'Acme', slug: 'acme', role: 'admin', isPersonal: false })
  })

  it('maps an invitation record into a summary DTO without leaking inviterId/organizationId', () => {
    // The full record, through a variable: the mapper's parameter names only the five fields it
    // reads, and an inline literal would be excess-property-checked against that rather than
    // proving what this test is about — that the extra fields do not reach the DTO.
    const record: InvitationRecord = {
      id: 'invite-1',
      organizationId: 'org-1',
      organizationName: 'Acme',
      email: 'a@example.com',
      role: 'member',
      status: 'pending',
      expiresAt: new Date('2026-08-01T00:00:00Z'),
      inviterId: 'user-a',
      // Present on the record and deliberately absent from the DTO below — this test's whole point is
      // that extra fields do not reach it, and personalization is now two more of them.
      intent: 'hiring',
      roleTitle: 'Staff Engineer',
    }
    const dto = toInvitationSummaryDto(record)
    expect(dto).toEqual({
      id: 'invite-1',
      email: 'a@example.com',
      role: 'member',
      status: 'pending',
      expiresAt: '2026-08-01T00:00:00.000Z',
    })
    expect(dto).not.toHaveProperty('organizationId')
    expect(dto).not.toHaveProperty('inviterId')
  })

  it('re-exports can() from the authorization module', () => {
    expect(typeof can).toBe('function')
  })

  it('canManageTeamSettings allows owner/admin only, never a plain member', () => {
    expect(canManageTeamSettings('owner')).toBe(true)
    expect(canManageTeamSettings('admin')).toBe(true)
    expect(canManageTeamSettings('member')).toBe(false)
  })
})

describe('team-account module boundary (forward-looking ratchet)', () => {
  it('no plans/implemented/27-team-accounts UI module imports db/schema directly or compares role to a literal', async () => {
    const dirs = ['src/modules/dashboard', 'src/routes/_dashboard/settings']
    for (const dir of dirs) {
      const files = await collectTsFiles(dir).catch(() => [])
      for (const file of files) {
        const source = await readFile(file, 'utf8')
        expect(source, `${file} must not import db/schema directly`).not.toMatch(/from ['"]~\/shared\/lib\/db\/(schema|index)['"]/)
        expect(source, `${file} must not compare .role to a string literal — use can() instead`).not.toMatch(/\.role\s*(===|!==)\s*['"]/)
      }
    }
  })
})

async function collectTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await collectTsFiles(full)))
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) files.push(full)
  }
  return files
}
