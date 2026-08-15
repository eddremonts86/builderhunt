import * as React from 'react'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { Sparkles, ArrowRight, ListChecks } from 'lucide-react'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { LinkButton } from '~/components/ui'
import { successStepCopyFor } from '~/shared/lib/onboarding-shared'
import { useOnboardingStep } from '~/shared/lib/useOnboardingStep'

/**
 * The last step, which now says something different depending on the route (plan:
 * phase-2/03-onboarding-segmentado).
 *
 * It used to say "your radar is live" to everybody, including somebody who had just claimed their
 * own profile and never saved a search — a sentence that was simply untrue for them. The spec asks
 * for "success with one concrete next action", and the concrete action differs per route.
 *
 * The preset is read from the server, exactly as `onboarding/search` reads it, and anything that
 * goes wrong lands on `general`. A last screen that failed to render because a preference did not
 * load would be a worse product than one showing the general copy.
 */
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
  const { preset } = useOnboardingStep('success')
  const copy = successStepCopyFor(preset)

  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center p-6">
      <div className="max-w-xl w-full text-center" data-testid="onboarding-success" data-preset={preset}>
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-bh-success/10 border border-bh-success/30 mb-6">
          <Sparkles className="w-10 h-10 text-bh-success" aria-hidden="true" />
        </div>

        <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-3" data-testid="onboarding-success-heading">
          {copy.heading}
        </h1>
        <p className="text-bh-text-muted text-lg mb-8">{copy.body}</p>

        <div className="card p-5 mb-6 text-left">
          <p className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim mb-3 flex items-center gap-2">
            <ListChecks className="w-3.5 h-3.5" aria-hidden="true" />
            What's next
          </p>
          <ul className="space-y-2 text-sm text-bh-text">
            {copy.next.map((item) => (
              <li key={item} className="flex items-start gap-2">
                <span className="text-bh-accent mt-0.5">→</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <LinkButton
            to={copy.primary.to}
            variant="primary"
            className="inline-flex"
            data-testid="onboarding-go-dashboard"
          >
            {copy.primary.label}
            <ArrowRight className="w-4 h-4" aria-hidden="true" />
          </LinkButton>
          <LinkButton to={copy.secondary.to} variant="secondary" className="inline-flex">
            {copy.secondary.label}
          </LinkButton>
        </div>
      </div>
    </div>
  )
}
