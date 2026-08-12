import { createFileRoute } from '@tanstack/react-router'
import { requirePlatformAdminPage } from '~/shared/lib/auth/auth-session'
import { BillingOperationsPage } from '~/modules/admin/billing/BillingOperationsPage'
import { SellerConfiguration } from '~/modules/admin/billing/SellerConfiguration'
import { BetaModeControl } from '~/modules/admin/billing/BetaModeControl'

export const Route = createFileRoute('/_dashboard/admin/billing')({
  beforeLoad: async () => {
    await requirePlatformAdminPage()
  },
  component: AdminBillingPage,
})

/** Combines the live operations summary (plans/phase-1/30-stripe-billing-platform/tasks.md §9 task 7) with the
 * pre-existing seller/tax configuration form (§3) on the same admin route — both are platform-admin-
 * only billing surfaces, and this route was the only one either ever had. */
function AdminBillingPage() {
  return (
    <div className="space-y-8">
      {/*
        First on the page, deliberately. It is the only control here that changes what every tenant in
        the system may spend, so it should not be something an operator scrolls past.
      */}
      <BetaModeControl />
      <BillingOperationsPage />
      <SellerConfiguration />
    </div>
  )
}
