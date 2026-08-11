export type OrganizationRole = 'owner' | 'admin' | 'member'

export interface TenantPrincipal {
  userId: string
  organizationId: string
  role: OrganizationRole
  requestId: string
}

export type PermissionAction =
  | 'organization:read'
  | 'organization:update'
  | 'organization:invite'
  | 'organization:manage-members'
  /**
   * Read the organization-administration overview on the dashboard (member and seat counts, plan state,
   * privacy-request counts).
   *
   * A distinct action rather than a reuse of an existing one, and both alternatives were wrong:
   * `organization:read` is true for every member, and this overview is owner/admin-only; `organization:invite` and
   * `organization:manage-members` happen to return the same answer today, so borrowing one would work — until a
   * future decision to let members invite colleagues silently widened who can read the workspace's plan state and
   * privacy-request counts. A read and a mutation that agree by coincidence should not share a name.
   */
  | 'organization:admin-overview'
  | 'organization:transfer'
  | 'organization:delete'
  | 'resource:create'
  | 'resource:read'
  | 'resource:update'
  | 'resource:delete'
  | 'resource:share'
  | 'resource:export'
  | 'billing:availability'
  | 'billing:read'
  | 'billing:mutate'
  | 'billing:refund'
  | 'billing:portal'
  | 'billing:auto-recharge'
  | 'billing:contact'
  // plan: calendar-scheduling-interview-intelligence. spec.md §Authorization: "Calendar records
  // are owned by one user inside one organization", participants "receive read-only
  // event/interview access", and "organization admins receive no implicit [candidate-data]
  // access". These actions therefore never consult `elevated` — being an owner or admin of the
  // organization grants nothing on someone else's calendar.
  | 'calendar:read'
  | 'calendar:mutate'
  | 'calendar:respond'
  | 'scheduling:manage'
  | 'candidate-data:read'

export interface ResourceAuthorizationContext {
  creatorUserId?: string | null
  visibility?: 'private' | 'organization'
  /** Set when the caller has an explicit, access-granted `event_participants` row for the event. */
  isGrantedParticipant?: boolean
}

export function can(
  principal: TenantPrincipal,
  action: PermissionAction,
  resource: ResourceAuthorizationContext = {},
): boolean {
  const elevated = principal.role === 'owner' || principal.role === 'admin'

  switch (action) {
    case 'organization:read':
    case 'resource:create':
      return true
    case 'organization:update':
    case 'organization:invite':
    case 'organization:manage-members':
    case 'organization:admin-overview':
    case 'resource:export':
      return elevated
    case 'organization:transfer':
    case 'organization:delete':
      return principal.role === 'owner'
    // spec.md §Permissions and UX: "Owners can subscribe, preview and confirm
    // changes, open Portal, buy packs, configure capped auto-recharge, and
    // submit eligible refund requests. Admins see read-only billing and usage
    // data. Members see only feature availability and an owner-contact action."
    case 'billing:availability':
      return true
    case 'billing:read':
      return elevated
    case 'billing:mutate':
    case 'billing:refund':
    case 'billing:portal':
    case 'billing:auto-recharge':
    case 'billing:contact':
      return principal.role === 'owner'
    case 'resource:read':
      return (
        resource.creatorUserId === principal.userId || resource.visibility === 'organization'
      )
    case 'resource:update':
    case 'resource:delete':
    case 'resource:share':
      return (
        resource.creatorUserId === principal.userId ||
        (resource.visibility === 'organization' && elevated)
      )
    // Owner, or a participant the owner explicitly granted access to. Deliberately no `elevated`
    // branch: an admin who is not on the event sees nothing, mirroring the RLS policies in
    // drizzle/0069_calendar_scheduling_rls_grants.sql.
    case 'calendar:read':
      return resource.creatorUserId === principal.userId || resource.isGrantedParticipant === true
    // Mutation and candidate data are owner-only — a participant reads, never writes, and never
    // reaches the candidate's submission behind the invitation.
    case 'calendar:mutate':
    case 'scheduling:manage':
    case 'candidate-data:read':
      return resource.creatorUserId === principal.userId
    // RSVP: a participant answers for themselves. The owner is also a participant on their own
    // event, so this covers both without a separate branch.
    case 'calendar:respond':
      return resource.isGrantedParticipant === true || resource.creatorUserId === principal.userId
  }
}
