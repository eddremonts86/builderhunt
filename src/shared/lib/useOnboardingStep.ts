import * as React from 'react'
import { trackConversionEvent } from './conversion-client'
import { stepKeyForRoute, type OnboardingRouteName } from './onboarding-shared'
import type { OnboardingStepKey } from './onboarding-v2'
import type { SegmentPreset } from './user-segments'

/**
 * One place every onboarding screen reports itself from (plan: phase-2/03-onboarding-segmentado).
 *
 * ## What it does, and why it is one hook rather than seven copies
 *
 * Each screen needs the same three things: the route the person is on, an event saying they saw this
 * step, and a way to say they finished it. Three of the screens had already grown their own copy of
 * the first, and the funnel needs all seven to agree on what a step is called — so it lives here.
 *
 * The step key comes from `(route, preset)`, never from the screen's own name: `onboarding/search`
 * is `hiring_search` on one route and `investing_discovery` on another, and a funnel that recorded
 * "the search screen" would add four different things together.
 *
 * ## Why the server state moves here too
 *
 * `complete()` also advances `onboarding_progress.current_step_key`. Before this, nothing in the
 * interface wrote it: the v2 machine was fully built and the column stayed null for everybody, so
 * the per-step funnel had a schema and no data. A stale advance answers 409 and is ignored — the
 * server's state is the authority, and a screen that could not update it must not block the person
 * standing in front of it.
 *
 * Everything here is best-effort. Telemetry that can fail a signup is worse than no telemetry.
 */
export interface OnboardingStepContext {
  flowVersion: 1 | 2
  preset: SegmentPreset
  stepKey: OnboardingStepKey
}

export interface OnboardingStepState {
  /** `general` until the server answers — the flow v1 already had, and the right default for any failure. */
  preset: SegmentPreset
  /** Whether this account is in the v2 cohort. `false` until the server answers. */
  inCohort: boolean
  /** True once the status request has settled, so a screen can avoid deciding a route too early. */
  resolved: boolean
  /** Records the step as completed and moves the server's state on. Safe to call more than once. */
  complete: () => Promise<void>
  /** Records that somebody left the flow here — skip, or the dashboard link. */
  exit: () => void
}

interface StatusV2 {
  preset?: SegmentPreset
  rollout?: { inCohort?: boolean }
}

export function useOnboardingStep(route: OnboardingRouteName): OnboardingStepState {
  const [preset, setPreset] = React.useState<SegmentPreset>('general')
  const [inCohort, setInCohort] = React.useState(false)
  const [resolved, setResolved] = React.useState(false)
  // Refs as well as state: `complete()` may be called from an event handler created before the
  // status landed, and a stale closure would report the general step for a segmented account.
  const presetRef = React.useRef<SegmentPreset>('general')
  /**
   * Which flow the events belong to.
   *
   * The v1 and v2 screens are the same components — somebody outside the cohort walks
   * `welcome → search → save → success` through this very hook. Reporting version 2 for them would
   * make the version split, and therefore every cohort comparison the ramp exists to enable, a
   * single series wearing two labels.
   */
  const flowVersionRef = React.useRef<1 | 2>(1)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch('/api/onboarding/v2', { credentials: 'include' })
        if (response.ok && !cancelled) {
          const body = (await response.json()) as StatusV2
          if (body.preset) {
            presetRef.current = body.preset
            setPreset(body.preset)
          }
          const cohort = body.rollout?.inCohort === true
          flowVersionRef.current = cohort ? 2 : 1
          setInCohort(cohort)
        }
      } catch {
        // Deliberately silent: `general`, not in the cohort, is already the safe answer.
      } finally {
        if (!cancelled) {
          setResolved(true)
          trackConversionEvent('onboarding_step_viewed', 'onboarding', {
            onboarding: contextFor(route, presetRef.current, flowVersionRef.current),
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [route])

  const complete = React.useCallback(async () => {
    const context = contextFor(route, presetRef.current, flowVersionRef.current)
    trackConversionEvent('onboarding_step_completed', 'onboarding', { onboarding: context })

    /**
     * Only v2 advances the v2 machine.
     *
     * Somebody outside the cohort walks `welcome → search → save`, skipping the goal step the v2
     * flow puts in between — so their second advance names a step the server does not think they are
     * on, and every one after it answers 409. Correctly: the request was well formed and the state
     * disagreed. But it is a question with no reason to be asked, and the browser logs every 409 to
     * the console, which is how the v1 journey spec caught this.
     *
     * The event above still fires for v1, because the funnel wants both cohorts. It is the *state*
     * that belongs to one of them.
     */
    if (flowVersionRef.current !== 2) return

    try {
      await fetch('/api/onboarding/v2', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // A 409 here means the state moved underneath this screen — re-reading is the client's job,
        // and there is nothing to re-read at the moment somebody is leaving the step.
        body: JSON.stringify({ action: 'advance', from: context.stepKey }),
      })
    } catch {
      // Best-effort: the person moves on either way.
    }
  }, [route])

  const exit = React.useCallback(() => {
    trackConversionEvent('onboarding_flow_exited', 'onboarding', {
      onboarding: contextFor(route, presetRef.current, flowVersionRef.current),
    })
  }, [route])

  return { preset, inCohort, resolved, complete, exit }
}

function contextFor(
  route: OnboardingRouteName,
  preset: SegmentPreset,
  flowVersion: 1 | 2,
): OnboardingStepContext {
  return {
    flowVersion,
    preset,
    stepKey: stepKeyForRoute(route, preset) as OnboardingStepKey,
  }
}
