import { createFileRoute } from '@tanstack/react-router'
import { ShieldCheck } from 'lucide-react'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { ActiveSessionsPanel } from '~/modules/dashboard/components/ActiveSessionsPanel'

export const Route = createFileRoute('/_dashboard/settings/security')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    return { user }
  },
  component: SecuritySettingsPage,
})

function SecuritySettingsPage() {
  return (
    <div data-testid="security-settings-page">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <ShieldCheck className="w-6 h-6 text-bh-accent" aria-hidden="true" />
          Security
        </h1>
        <p className="text-sm text-bh-text-muted mt-1">
          Review and manage the devices signed in to your account.
        </p>
      </header>

      <ActiveSessionsPanel />
    </div>
  )
}
