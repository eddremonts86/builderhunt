import * as React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

interface TenantQueryContextValue {
  activeOrganizationId: string | null
}

const TenantQueryContext = React.createContext<TenantQueryContextValue>({ activeOrganizationId: null })

export function useActiveOrganizationId(): string | null {
  return React.useContext(TenantQueryContext).activeOrganizationId
}

/**
 * Scopes the dashboard's React Query cache to the active organization.
 *
 * Every private query a Team surface makes should be keyed via
 * `organizationQueryKey` (query-keys.ts), but the cache is cleared *entirely*
 * on an organization change rather than filtered by key prefix: a render
 * between "cancel the old org's in-flight requests" and "drop only its
 * keys" could still paint org A data under org B's chrome. Clearing
 * everything is the only version of this that can't leak — the cost is a
 * refetch of already-loaded global-public data too, which is cheap and rare
 * (organization switches are not a hot path).
 */
export function TenantQueryProvider({
  activeOrganizationId,
  children,
}: {
  activeOrganizationId: string | null
  children: React.ReactNode
}) {
  const [queryClient] = React.useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
  }))
  const previousOrganizationId = React.useRef(activeOrganizationId)

  React.useEffect(() => {
    if (previousOrganizationId.current === activeOrganizationId) return
    queryClient.cancelQueries()
    queryClient.clear()
    previousOrganizationId.current = activeOrganizationId
  }, [activeOrganizationId, queryClient])

  const contextValue = React.useMemo(() => ({ activeOrganizationId }), [activeOrganizationId])

  return (
    <QueryClientProvider client={queryClient}>
      <TenantQueryContext.Provider value={contextValue}>
        {children}
      </TenantQueryContext.Provider>
    </QueryClientProvider>
  )
}
