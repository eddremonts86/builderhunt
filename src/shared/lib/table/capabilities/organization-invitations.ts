import { organizationInvitations } from '~/shared/lib/db/schema'

import { defineTableCapability, registerTableCapability } from '../capability'

/**
 * Pending invitations.
 *
 * A separate capability from the roster rather than a merged "people" list, because they are
 * different records with different actions: a member has a role you can change and a seat you can
 * free; an invitation has an expiry, a resend and a cancel. Merging them would mean a grid whose
 * every column is conditional on which kind of row it is.
 *
 * `status = 'pending'` is **not** a filter dimension. It is the surface's own predicate, passed as
 * `scope` — accepted/rejected/cancelled invitations are not actionable from Team settings and
 * offering a chip that surfaces them would be offering rows with no working controls.
 */
export const ORGANIZATION_INVITATIONS_TABLE = 'organization_invitations'

export const INVITABLE_ROLES = ['admin', 'member'] as const

export const organizationInvitationsCapability = registerTableCapability(defineTableCapability({
  table: ORGANIZATION_INVITATIONS_TABLE,
  sortable: {
    // Backed by `organization_invitations_org_created_id_idx`.
    createdAt: { column: organizationInvitations.createdAt },
    // Backed by `organization_invitations_org_expires_id_idx` — "which of these lapses first" is
    // the question an owner chasing a stalled invite actually has.
    expiresAt: { column: organizationInvitations.expiresAt },
  },
  filterable: {
    // Nullable in the schema, so no `values` allowlist: a row with a null role would be
    // unreachable by any chip, and rejecting the values that do exist would be worse.
    role: { column: organizationInvitations.role, facet: true },
  },
  groupable: [],
  searchable: [organizationInvitations.email],
  tiebreaker: organizationInvitations.id,
  defaultSort: [{ id: 'createdAt', dir: 'desc' }],
  organizationColumn: organizationInvitations.organizationId,
}))

export const ORGANIZATION_INVITATION_FILTER_LABELS: Record<string, string> = {
  role: 'Role',
}
