import { createFileRoute, redirect } from '@tanstack/react-router'
import { Sparkles, ArrowRight, ListChecks } from 'lucide-react'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { LinkButton } from '~/components/ui'
import { SEARCH_SOURCE_COUNT } from '~/shared/lib/search-connectors'

export const Route = createFileRoute('/onboarding/success')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) {
      throw redirect({ to: '/auth/sign-in', search: { redirect: '/onboarding/success' } })
    }
    return { user }
  },
  component: SuccessStep,
})

function SuccessStep() {
  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center p-6">
      <div className="max-w-xl w-full text-center" data-testid="onboarding-success">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-bh-success/10 border border-bh-success/30 mb-6">
          <Sparkles className="w-10 h-10 text-bh-success" aria-hidden="true" />
        </div>

        <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-3">
          🎉 Your radar is live!
        </h1>
        <p className="text-bh-text-muted text-lg mb-8">
          You'll get fresh picks in your dashboard every day. Your saved searches run continuously across {SEARCH_SOURCE_COUNT} sources.
        </p>

        <div className="card p-5 mb-6 text-left">
          <p className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim mb-3 flex items-center gap-2">
            <ListChecks className="w-3.5 h-3.5" aria-hidden="true" />
            What's next
          </p>
          <ul className="space-y-2 text-sm text-bh-text">
            <li className="flex items-start gap-2">
              <span className="text-bh-accent mt-0.5">→</span>
              <span>Your "For you" section will start showing fresh builders today</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-bh-accent mt-0.5">→</span>
              <span>Click "Save search" on any result to add more radars</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-bh-accent mt-0.5">→</span>
              <span>Search your own name to find and claim your profile</span>
            </li>
          </ul>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <LinkButton to="/dashboard" variant="primary" className="inline-flex" data-testid="onboarding-go-dashboard">
            Go to dashboard
            <ArrowRight className="w-4 h-4" aria-hidden="true" />
          </LinkButton>
          <LinkButton to="/search" variant="secondary" className="inline-flex">
            Run another search
          </LinkButton>
        </div>
      </div>
    </div>
  )
}
