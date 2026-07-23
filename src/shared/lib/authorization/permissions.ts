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

export interface ResourceAuthorizationContext {
  creatorUserId?: string | null
  visibility?: 'private' | 'organization'
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
  }
}
