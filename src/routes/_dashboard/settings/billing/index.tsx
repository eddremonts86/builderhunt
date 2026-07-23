import { createFileRoute } from '@tanstack/react-router'
import { Crown } from 'lucide-react'
import { BillingSettingsPage } from '~/modules/billing/BillingSettingsPage'

export const Route = createFileRoute('/_dashboard/settings/billing/')({
  // Auth is enforced by the parent layout (settings/billing.tsx). No loader —
  // all data is fetched client-side via /api/* to keep the SSR bundle clean
  // of the postgres driver.
  component: RouteComponent,
})

function RouteComponent() {
  return (
    <div data-testid="billing-settings-page">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Crown className="w-6 h-6 text-bh-accent" aria-hidden="true" />
          Billing &amp; plan
        </h1>
        <p className="text-sm text-bh-text-muted mt-1">
          What your organization is on, what it includes, and what's changed recently.
        </p>
      </header>
      <BillingSettingsPage />
    </div>
  )
}
