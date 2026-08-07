import { organizationMembers } from '~/shared/lib/db/schema'

import { defineTableCapability, registerTableCapability } from '../capability'

/**
 * The team roster.
 *
 * `listOrganizationMembers` had no `ORDER BY`, so the roster's order was whatever Postgres
 * returned — the same defect the dispute queue had, and for the same reason it went unnoticed: on
 * a handful of rows the order looks stable because nothing has made Postgres change its mind yet.
 *
 * **Nothing is `searchable`.** The name and email a person would search by live on `auth_users`,
 * one join away, and a capability describes one table — see `defineTableCapability`, which throws
 * on a column from another relation. Declaring `userId` searchable to have *something* there would
 * be a search box that matches opaque ids, which is worse than the surface saying it has none: the
 * grid passes `searchable={false}` and the toolbar renders no box at all.
 *
 * The names still reach the page. `pageOrganizationMembers` resolves them for the fifty rows it
 * returned, the same page-then-enrich shape as `pagePlatformUsersWithBilling`.
 */
export const ORGANIZATION_MEMBERS_TABLE = 'organization_members'

export const ORGANIZATION_ROLES = ['owner', 'admin', 'member'] as const

export const organizationMembersCapability = registerTableCapability(defineTableCapability({
  table: ORGANIZATION_MEMBERS_TABLE,
  sortable: {
    // Backed by `organization_members_org_created_id_idx`. Ascending by default: a roster reads as
    // "who has been here longest", and the owner is almost always row one.
    joinedAt: { column: organizationMembers.createdAt },
  },
  filterable: {
    role: { column: organizationMembers.role, values: ORGANIZATION_ROLES, facet: true },
  },
  groupable: [],
  searchable: [],
  tiebreaker: organizationMembers.id,
  defaultSort: [{ id: 'joinedAt', dir: 'asc' }],
  organizationColumn: organizationMembers.organizationId,
}))

export const ORGANIZATION_MEMBER_FILTER_LABELS: Record<string, string> = {
  role: 'Role',
}
