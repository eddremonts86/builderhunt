import { createFileRoute, useNavigate } from '@tanstack/react-router'
import * as React from 'react'
import { requirePlatformAdminPage } from '~/shared/lib/auth/auth-session'
import { DisputeQueue } from '~/modules/admin/billing/DisputeQueue'
import { pickTableSearchParams, serializeTableSearch, tableSearchSchema } from '~/shared/lib/table/query-url'
import type { TableSearch } from '~/shared/lib/table/types'

export const Route = createFileRoute('/_dashboard/admin/disputes')({
  // The flat params, not a parsed `TableSearch` — the router re-serializes whatever this returns,
  // and a parsed object would put a JSON blob where `?filter.outcome=open` belongs.
  validateSearch: (raw: Record<string, unknown>) => pickTableSearchParams(raw),
  beforeLoad: async () => {
    await requirePlatformAdminPage()
  },
  component: DisputeQueueRoute,
})

function DisputeQueueRoute() {
  const params = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const search = React.useMemo(() => tableSearchSchema(params), [params])

  const onSearchChange = React.useCallback((next: TableSearch) => {
    void navigate({ search: serializeTableSearch(next), replace: true })
  }, [navigate])

  return <DisputeQueue search={search} onSearchChange={onSearchChange} />
}
