import { createFileRoute } from '@tanstack/react-router'
import { getAppAuthSession, getIsAppAdmin } from '~/shared/lib/auth/auth-session'
import { BillingOperationsPage } from '~/modules/admin/billing/BillingOperationsPage'
import { SellerConfiguration } from '~/modules/admin/billing/SellerConfiguration'

export const Route = createFileRoute('/_dashboard/admin/billing')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    if (!(await getIsAppAdmin())) {
      throw new Error('Forbidden')
    }
    return { user }
  },
  component: AdminBillingPage,
})

/** Combines the live operations summary (plans/stripe-billing-platform/tasks.md §9 task 7) with the
 * pre-existing seller/tax configuration form (§3) on the same admin route — both are platform-admin-
 * only billing surfaces, and this route was the only one either ever had. */
function AdminBillingPage() {
  return (
    <div className="space-y-8">
      <BillingOperationsPage />
      <SellerConfiguration />
    </div>
  )
}
