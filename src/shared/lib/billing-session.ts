import { createServerFn } from '@tanstack/react-start'

export const getAppOrganizationPlan = createServerFn({ method: 'GET' }).handler(async () => {
  const [server, tenantPrincipal, tenantContext, entitlements] = await Promise.all([
    import('@tanstack/react-start/server'),
    import('./auth/tenant-principal'),
    import('./db/tenant-context'),
    import('./repositories/entitlements'),
  ])

  const request = new Request('http://builderhunt.local/pricing', {
    headers: server.getRequestHeaders(),
  })

  try {
    const principal = await tenantPrincipal.requireTenantPrincipal(request)
    const entitlement = await tenantContext.withTenantContext(principal, (transaction) =>
      entitlements.getOrganizationEntitlement(transaction, principal.organizationId),
    )

    return { plan: entitlement.tier, status: entitlement.status }
  } catch (error) {
    if (error instanceof tenantPrincipal.TenantAuthorizationError) return null
    throw error
  }
})
