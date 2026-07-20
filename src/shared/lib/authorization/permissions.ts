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
