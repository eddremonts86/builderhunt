import { createFileRoute, useNavigate } from '@tanstack/react-router'
import * as React from 'react'
import { requirePlatformAdminPage } from '~/shared/lib/auth/auth-session'
import { RefundQueue } from '~/modules/admin/billing/RefundQueue'
import { pickTableSearchParams, serializeTableSearch, tableSearchSchema } from '~/shared/lib/table/query-url'
import type { TableSearch } from '~/shared/lib/table/types'

export const Route = createFileRoute('/_dashboard/admin/refunds')({
  /*
   * The queue's whole state — which organization, which states, the sort, the cursor — is the URL.
   *
   * That is what makes "here is the queue I am looking at" a link an operator can paste into a
   * support thread, and it is why the organization id became a filter rather than staying a text
   * box wired to a Load button.
   *
   * It returns the *flat params*, not a parsed `TableSearch`: TanStack Router re-serializes
   * whatever `validateSearch` returns, so returning the parsed object would put a JSON blob in the
   * address bar instead of `?filter.organizationId=org_x&filter.state=pending`.
   */
  validateSearch: (raw: Record<string, unknown>) => pickTableSearchParams(raw),
  beforeLoad: async () => {
    await requirePlatformAdminPage()
  },
  component: RefundQueueRoute,
})

function RefundQueueRoute() {
  const params = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const search = React.useMemo(() => tableSearchSchema(params), [params])

  const onSearchChange = React.useCallback((next: TableSearch) => {
    // `replace`, so paging and filtering do not fill the back button with every intermediate view.
    void navigate({ search: serializeTableSearch(next), replace: true })
  }, [navigate])

  return <RefundQueue search={search} onSearchChange={onSearchChange} />
}
