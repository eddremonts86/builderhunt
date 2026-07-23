import * as React from 'react'
import { Outlet, createFileRoute } from '@tanstack/react-router'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'

// Layout for /settings/billing and /settings/billing/return.
// The billing overview UI is in /settings/billing/index.tsx; the pending
// Checkout return experience is in /settings/billing/return.tsx.
export const Route = createFileRoute('/_dashboard/settings/billing')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    return { user }
  },
  component: () => <Outlet />,
})
