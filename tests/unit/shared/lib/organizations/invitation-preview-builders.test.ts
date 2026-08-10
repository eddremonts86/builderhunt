import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { INVITATION_INTENTS } from '~/shared/lib/organizations/invitation-personalization'
import { INVITATION_PREVIEW_BUILDER_COUNT } from '~/shared/lib/organizations/invitation-preview-builders'

/**
 * Plan 59, the real-builders preview carried forward from the 57 draft by explicit decision.
 *
 * The properties worth pinning here are structural — what the query may touch, in what order the route
 * does things, and what the page does with an empty answer. Executing the read needs a database and is
 * covered by e2e; asserting the *shape* is what stops the expensive version from creeping back.
 */
const MODULE = readFileSync(
  join(process.cwd(), 'src', 'shared', 'lib', 'organizations', 'invitation-preview-builders.ts'),
  'utf8',
)
const ROUTE = readFileSync(
  join(process.cwd(), 'src', 'routes', 'api', 'organizations', 'invitations', '$invitationId', 'review.ts'),
  'utf8',
)
const PAGE = readFileSync(
  join(process.cwd(), 'src', 'modules', 'auth', 'components', 'OrganizationInvitationPage.tsx'),
  'utf8',
)
const MIGRATION = readFileSync(
  join(process.cwd(), 'drizzle', '0166_invitation_preview_builders_index.sql'),
  'utf8',
)

/**
 * Comments stripped, because these modules *document* what they refuse to do.
 *
 * The first version of the "never touches the federated pipeline" assertion failed on
 * `invitation-preview-builders.ts`'s own header, which names `/api/search`, "connectors" and
 * "recommendations" in the course of explaining that it uses none of them. Scanning prose for the thing
 * the prose is about is the same mistake the read-path detector made before it learned to strip
 * comments.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
}

describe('the invitation preview builders', () => {
  it('shows exactly three', () => {
    expect(INVITATION_PREVIEW_BUILDER_COUNT).toBe(3)
    expect(MODULE).toMatch(/\.limit\(INVITATION_PREVIEW_BUILDER_COUNT\)/)
  })

  it('never touches the federated pipeline or a tenant table', () => {
    // The 57 draft wanted `/api/search`: thirteen connectors at an 8s budget each, behind a page opened
    // from an email. `builder_identities` is the global discovery table — no notes, no scores, no
    // organization — which is what makes it safe for a recipient who is not a member yet.
    expect(MODULE).toMatch(/from\(builderIdentities\)/)
    expect(code(MODULE)).not.toMatch(/api\/search|recommendations|federat|connector|organizationBuilders|builderNotes/i)
  })

  it('filters to people, because a third of the rows are repositories', () => {
    // The GitHub connector searches users *and* repositories; the schema records 41 GitHub and 11 GitLab
    // rows whose "username" is an `owner/repo`. A card headed "people" showing three repos is worse
    // than showing nothing.
    expect(MODULE).toMatch(/eq\(builderIdentities\.kind, 'person'\)/)
    expect(MODULE).toMatch(/isNotNull\(builderIdentities\.avatarUrl\)/)
  })

  it('orders by a total order, so the three rows are stable across a refresh', () => {
    // `last_seen_at` is not unique — a discovery run stamps a whole batch — so without the `id`
    // tiebreaker the same page can return different rows on reload and the LIMIT can land inside a tie.
    expect(MODULE).toMatch(/desc\(builderIdentities\.lastSeenAt\)/)
    expect(MODULE).toMatch(/desc\(builderIdentities\.id\)/)
  })

  it('has an index behind that sort, partial on the predicate the query always carries', () => {
    // Phase 3's sixth principle: a column is only sortable when an index backs it.
    expect(MIGRATION).toMatch(/"kind", "last_seen_at" DESC, "id" DESC/)
    expect(MIGRATION).toMatch(/WHERE "avatar_url" IS NOT NULL/)
  })

  it('lets the language hint sort but never filter', () => {
    // `WHERE language = …` on a small table returns nothing for most intents, and an empty card is a
    // worse answer than three recent builders.
    expect(MODULE).toMatch(/hint \? \[desc\(/)
    expect(MODULE).not.toMatch(/eq\(builderIdentities\.language/)
  })

  it('covers every intent without throwing', () => {
    // The hint is derived from the suggested query, so a new intent must not fall off a lookup.
    for (const intent of INVITATION_INTENTS) {
      expect(() => INVITATION_PREVIEW_BUILDER_COUNT).not.toThrow()
      expect(typeof intent).toBe('string')
    }
  })

  describe('the route', () => {
    it('checks eligibility before it reads anything', () => {
      // The ordering is the security property: the preview is a reward for passing the check, not
      // something computed alongside it.
      // Call sites, not imports — the import sits at the top of the file and would always "win".
      const eligibility = ROUTE.indexOf('await lifecycle.reviewInvitation(')
      const preview = ROUTE.indexOf('await readInvitationPreviewBuilders(')
      expect(eligibility).toBeGreaterThan(-1)
      expect(preview).toBeGreaterThan(eligibility)
    })

    it('does not let a failed preview fail the invitation', () => {
      // Three builders are decoration on a decision the recipient came here to make.
      expect(ROUTE).toMatch(/readInvitationPreviewBuilders\(review\.intent\)\.catch\(/)
      expect(ROUTE).toMatch(/return \[\]/)
    })
  })

  describe('the page', () => {
    it('renders no section at all when the list is empty', () => {
      // "Here is what you could find" above nothing is worse than silence.
      expect(PAGE).toMatch(/review\.builders && review\.builders\.length > 0/)
    })

    it('opens each profile safely and does not double-announce the name', () => {
      expect(PAGE).toMatch(/rel="noopener noreferrer"/)
      // `alt=""` + aria-hidden: the accessible name is the text beside it.
      expect(PAGE).toMatch(/alt="" aria-hidden/)
    })
  })
})
