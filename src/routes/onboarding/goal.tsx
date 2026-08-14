import * as React from 'react'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { Button } from '~/components/ui'
import { parseSegmentHint } from '~/shared/lib/landing-segment-hint'
import { trackConversionEvent } from '~/shared/lib/conversion-client'
import {
  SEGMENT_SCOPE_NOTICE,
  USER_SEGMENT_COPY,
  USER_SEGMENTS,
  type UserSegment,
} from '~/shared/lib/user-segments'

/**
 * The goal step (plan: phase-2/03-onboarding-segmentado).
 *
 * ## The hint preselects; it never persists
 *
 * A segmented landing CTA links here with `?goal=hiring`, and that decides which option starts
 * checked. It does not write anything. The URL is attacker-controlled — anybody can send anybody a
 * link — and a value written from one would be a preference somebody never expressed showing up in
 * their account. The write happens when they press Continue, and `source` is `onboarding`, which is
 * the honest description of where the choice was made whatever link brought them.
 *
 * A manipulated hint is indistinguishable from no hint: `parseSegmentHint` returns `null` for both,
 * so the URL cannot be used to probe which values the enum accepts.
 *
 * ## Skipping is a first-class answer
 *
 * The spec is explicit that onboarding never blocks the dashboard. "I would rather not say" is a
 * button, not a hidden escape — it advances on the general route, which is the flow v1 already had.
 */
export const Route = createFileRoute('/onboarding/goal')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) {
      throw redirect({ to: '/auth/sign-in', search: { redirect: '/onboarding/goal' } })
    }
    return { user }
  },
  component: GoalStep,
})

function GoalStep() {
  const navigate = useNavigate()
  const [selected, setSelected] = React.useState<UserSegment | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Read once, on mount: a hint is about arrival, and re-reading it would let a history change
  // silently move a choice somebody had already made on this screen.
  React.useEffect(() => {
    const hinted = parseSegmentHint(typeof window === 'undefined' ? null : window.location.search)
    if (hinted) setSelected(hinted)
    trackConversionEvent('segment_prompt_viewed', 'onboarding', {
      segment: { previous: null, next: hinted, source: 'onboarding' },
    })
  }, [])

  const persist = React.useCallback(
    async (segment: UserSegment | null) => {
      setSaving(true)
      setError(null)
      try {
        if (segment) {
          const response = await fetch('/api/me/preferences', {
            method: 'PATCH',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ primarySegment: segment, source: 'onboarding' }),
          })
          // A 404 is the feature being off. Continuing is right: the goal step is an addition to
          // onboarding, and failing to record a preference must never strand somebody in a flow.
          if (!response.ok && response.status !== 404) {
            setError('We could not save that. You can continue and set it later in your account.')
            setSaving(false)
            return
          }
          trackConversionEvent('segment_selected', 'onboarding', {
            segment: { previous: null, next: segment, source: 'onboarding' },
          })
        } else {
          trackConversionEvent('segment_skipped', 'onboarding', {
            segment: { previous: null, next: null, source: 'onboarding' },
          })
        }
        await navigate({ to: '/onboarding/search' })
      } catch {
        setError('We could not save that. You can continue and set it later in your account.')
        setSaving(false)
      }
    },
    [navigate],
  )

  return (
    <main className="container max-w-2xl py-12">
      <fieldset className="border-0 p-0 m-0">
        <legend className="text-3xl font-bold tracking-tight mb-2">What brings you here?</legend>
        <p className="text-bh-text-muted mb-1">
          We will put the right things first. You can change this any time.
        </p>
        <p className="text-sm text-bh-text-muted mb-6">{SEGMENT_SCOPE_NOTICE}</p>

        <div className="space-y-3" data-testid="goal-options">
          {USER_SEGMENTS.map((segment) => {
            const copy = USER_SEGMENT_COPY[segment]
            const describedBy = `goal-${segment}-description`
            return (
              <label
                key={segment}
                className="flex gap-3 items-start p-4 rounded-xl border border-bh-border/60 cursor-pointer hover:bg-bh-surface-2"
              >
                <input
                  type="radio"
                  name="goal"
                  value={segment}
                  className="mt-1"
                  checked={selected === segment}
                  aria-describedby={describedBy}
                  onChange={() => setSelected(segment)}
                />
                <span>
                  <span className="block font-medium">{copy.label}</span>
                  <span id={describedBy} className="block text-sm text-bh-text-muted">
                    {copy.description}
                  </span>
                </span>
              </label>
            )
          })}
        </div>

        {error && (
          <p role="alert" className="mt-4 text-sm text-bh-danger">
            {error}
          </p>
        )}

        <div className="flex items-center gap-3 mt-8">
          <Button onClick={() => void persist(selected)} disabled={!selected || saving}>
            Continue <ArrowRight className="w-4 h-4 ml-1" aria-hidden="true" />
          </Button>
          {/* Not a link styled as an afterthought: declining is an answer the product accepts. */}
          <button
            type="button"
            className="text-sm underline text-bh-text-muted"
            onClick={() => void persist(null)}
            disabled={saving}
          >
            I would rather not say
          </button>
        </div>
      </fieldset>
    </main>
  )
}
