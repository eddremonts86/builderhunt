import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { organizationInvitations } from '~/shared/lib/db/schema'
import { INVITATION_INTENTS, ROLE_TITLE_MAX_LENGTH } from '~/shared/lib/organizations/invitation-personalization'

/**
 * Plan 59 phase 0 — the two personalization columns and their CHECK constraints.
 *
 * The constraints are asserted against the migration **text**, following the same pattern as
 * `billing-tenant-isolation.test.ts`: a CHECK constraint is not reachable from the Drizzle schema
 * object, and inserting through `DATABASE_URL` would exercise `organization_invitations`' forced RLS
 * as the `builderhunt_app` role rather than the constraint. Live behaviour is proven where it can be:
 * `pnpm test:migrations:local` replays every migration from zero twice, and plan 59's e2e journey
 * writes through the real broker role.
 */
const MIGRATION = readFileSync(join(process.cwd(), 'drizzle', '0165_invitation_personalization.sql'), 'utf8')

describe('organization_invitations personalization columns', () => {
  const columns = getTableConfig(organizationInvitations).columns
  const byName = new Map(columns.map((column) => [column.name, column]))

  it('names the columns invitation_intent and invitee_role_title', () => {
    // The TypeScript field is `roleTitle` while the column is `invitee_role_title`; a rename on either
    // side without the other is a silent read of undefined.
    expect(byName.has('invitation_intent')).toBe(true)
    expect(byName.has('invitee_role_title')).toBe(true)
  })

  it('leaves both nullable, so every pre-existing invitation is still valid', () => {
    // Not a detail: `NOT NULL` here would fail the migration on any deployment with a pending
    // invitation, and a DEFAULT would invent a sender's reason for every historical row.
    expect(byName.get('invitation_intent')?.notNull).toBe(false)
    expect(byName.get('invitee_role_title')?.notNull).toBe(false)
    expect(byName.get('invitation_intent')?.hasDefault).toBe(false)
    expect(byName.get('invitee_role_title')?.hasDefault).toBe(false)
  })

  it('adds columns and removes nothing', () => {
    expect(MIGRATION).toMatch(/ADD COLUMN "invitation_intent" text/)
    expect(MIGRATION).toMatch(/ADD COLUMN "invitee_role_title" text/)
    expect(MIGRATION).not.toMatch(/DROP\s+(COLUMN|TABLE|INDEX|CONSTRAINT|POLICY)/i)
    expect(MIGRATION).not.toMatch(/REVOKE/i)
  })
})

describe('the intent CHECK constraint', () => {
  it('allows NULL and exactly the four contract values', () => {
    expect(MIGRATION).toMatch(/"invitation_intent" IS NULL/)
    for (const intent of INVITATION_INTENTS) {
      expect(MIGRATION).toContain(`'${intent}'`)
    }
  })

  it('lists no value the contract does not define', () => {
    // Guards the direction the loop above cannot: a fifth value added to the SQL and to nothing else
    // would let the database accept an intent no copy map has an entry for.
    const listed = MIGRATION.match(/IN \((?<values>[^)]*)\)/)?.groups?.values ?? ''
    const values = listed.split(',').map((v) => v.trim().replace(/^'|'$/g, '')).filter(Boolean)
    expect(values.sort()).toEqual([...INVITATION_INTENTS].sort())
  })
})

describe('the role-title CHECK constraint', () => {
  it('allows NULL', () => {
    expect(MIGRATION).toMatch(/"invitee_role_title" IS NULL/)
  })

  it('requires the stored value to be already trimmed', () => {
    // Length alone would accept '   ' as a three-character title, which renders as a blank line the
    // recipient cannot account for. Requiring `= btrim(...)` makes an untrimmed write an error rather
    // than a silently ugly card.
    expect(MIGRATION).toMatch(/"invitee_role_title" = btrim\("invitee_role_title"\)/)
  })

  it('bounds the length in characters, not bytes, at the contract maximum', () => {
    // `char_length`, not `octet_length`: an accented name or an emoji must not cost the sender part of
    // their allowance.
    expect(MIGRATION).toMatch(/char_length\("invitee_role_title"\)/)
    expect(MIGRATION).not.toMatch(/octet_length/)
    expect(MIGRATION).toMatch(new RegExp(`BETWEEN 1 AND ${ROLE_TITLE_MAX_LENGTH}\\b`))
  })

  it('agrees with the TypeScript contract about the maximum', () => {
    // One number, two places. A change to `ROLE_TITLE_MAX_LENGTH` that does not reach a new migration
    // means the route accepts a title the database then rejects with a 500.
    const bound = Number(MIGRATION.match(/BETWEEN 1 AND (\d+)/)?.[1])
    expect(bound).toBe(ROLE_TITLE_MAX_LENGTH)
  })
})
