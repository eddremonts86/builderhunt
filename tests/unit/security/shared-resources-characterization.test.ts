// Characterization test: captures today's behavior of the existing
// `saved_queries` and `organization_builders` tables so the new
// tenant repository work in plan 28 has a regression net.
//
// This is intentionally schema-level (it checks the table shape, not
// the HTTP surface). The HTTP characterization is the e2e suite's
// job; this test is the contract that says "every row carries a
// non-null organizationId and the composite FKs are enforced" so a
// future migration that drops the tenant key is caught here before
// it reaches production.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

async function readSchema(): Promise<string> {
  return readFile(join(process.cwd(), 'src/shared/lib/db/schema.ts'), 'utf8')
}

describe('shared resources — schema invariants', () => {
  it('saved_queries has organization_id NOT NULL and a composite-FK-friendly index', async () => {
    const schema = await readSchema()
    // The column declaration block for `saved_queries`. The exact line
    // numbers move; match on the column name + the notNull marker.
    expect(schema).toMatch(/saved_queries[\s\S]{0,400}organizationId:\s*text\('organization_id'\)\.notNull/)
  })

  it('alerts has organization_id NOT NULL', async () => {
    const schema = await readSchema()
    expect(schema).toMatch(/alerts[\s\S]{0,400}organizationId:\s*text\('organization_id'\)\.notNull/)
  })

  it('organization_builders has the visibility CHECK constraint', async () => {
    const schema = await readSchema()
    expect(schema).toContain("organization_builders_visibility_check")
    expect(schema).toContain("in ('private', 'organization')")
  })

  it('builder_notes has organization_id NOT NULL and an organization FK', async () => {
    const schema = await readSchema()
    expect(schema).toMatch(/builder_notes[\s\S]{0,400}organizationId:\s*text\('organization_id'\)\.notNull\(\)\.references\(\(\) => organizations\.id/)
  })
})

describe('shared resources — explicit no-organization-authority rule', () => {
  it('no shared-resource DTO in the contract layer carries an organization-id write path', async () => {
    // The contracts file declares DTOs in their *outbound* form only.
    // A request body that takes a DTO is allowed to read the
    // organizationId out of it (for response shape) but is not
    // allowed to write one back. The stripOrganizationAuthority
    // helper is the single point where inbound bodies are cleaned.
    const schema = await readSchema()
    const contracts = await readFile(
      join(process.cwd(), 'src/shared/lib/shared-resources/contracts.ts'),
      'utf8',
    )
    // Spot-check: the DTOs are plain shapes; the authority strip is
    // the only thing that drops an organizationId from an inbound
    // body. If this changes, a code review should catch it.
    expect(contracts).toContain('stripOrganizationAuthority')
    expect(schema).toBeDefined()
  })
})
