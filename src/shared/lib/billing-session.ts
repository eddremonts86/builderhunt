import { createServerFn } from '@tanstack/react-start'

export const getAppOrganizationPlan = createServerFn({ method: 'GET' }).handler(async () => {
  const [server, tenantPrincipal, tenantContext, entitlements, permissions] = await Promise.all([
    import('@tanstack/react-start/server'),
    import('./auth/tenant-principal'),
    import('./db/tenant-context'),
    import('./repositories/entitlements'),
    import('./billing/permissions'),
  ])

  const request = new Request('http://builderhunt.local/pricing', {
    headers: server.getRequestHeaders(),
  })

  try {
    const principal = await tenantPrincipal.requireTenantPrincipal(request)
    const entitlement = await tenantContext.withTenantContext(principal, (transaction) =>
      entitlements.getOrganizationEntitlement(transaction, principal.organizationId),
    )

    // Derived server-side via can() (billing:mutate — the same gate the real Checkout routes
    // enforce) rather than exposing the raw role to the client, per this codebase's rule that role
    // comparisons only ever happen behind `can()`, never as a client-visible string.
    return { plan: entitlement.tier, status: entitlement.status, canSubscribe: permissions.canMutateBilling(principal) }
  } catch (error) {
    if (error instanceof tenantPrincipal.TenantAuthorizationError) return null
    throw error
  }
})
