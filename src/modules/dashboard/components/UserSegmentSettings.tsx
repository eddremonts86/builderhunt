import * as React from 'react'
import {
  SEGMENT_SCOPE_NOTICE,
  USER_SEGMENT_COPY,
  USER_SEGMENTS,
  type UserSegment,
} from '~/shared/lib/user-segments'
import type { UserPreferencesResponse } from '~/shared/lib/user-preferences-api'
import { trackConversionEvent } from '~/shared/lib/conversion-client'

/**
 * "Primary goal" on `/me` (plan: phase-2/02-segmentacion-usuarios).
 *
 * ## How the feature flag reaches this component
 *
 * It does not. `/api/me/preferences` answers **404** when `USER_SEGMENTATION_ENABLED` is `false`,
 * and this component renders nothing on a 404. So the flag is decided once, on the server, and
 * there is no second copy of the decision to fall out of step with it — a flag threaded through a
 * loader and re-read in a component is two answers to one question, and they drift.
 *
 * The same path covers a request that fails for any other reason: nothing renders. A settings
 * section that cannot save is worse than one that is not there.
 *
 * ## Why radios and not a `<select>`
 *
 * Four options, all visible, each needing a sentence of explanation. A native select shows one at a
 * time and has nowhere to put the descriptions, so the choice would be made without the information
 * that distinguishes the options. `aria-describedby` ties each description to its own radio, so a
 * screen reader announces the explanation with the option rather than after all four.
 */

type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string }

export interface UserSegmentSettingsProps {
  /** Injected by the tests; the page passes nothing and the component fetches for itself. */
  fetchImpl?: typeof fetch
}

export function UserSegmentSettings({ fetchImpl }: UserSegmentSettingsProps = {}) {
  const doFetch = fetchImpl ?? fetch
  const [preferences, setPreferences] = React.useState<UserPreferencesResponse | null>(null)
  const [available, setAvailable] = React.useState(false)
  const [save, setSave] = React.useState<SaveState>({ kind: 'idle' })

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await doFetch('/api/me/preferences', { credentials: 'include' })
        if (cancelled) return
        // 404 is the flag being off. Anything else non-ok is a surface that could not load, and
        // both mean the same thing here: do not render.
        if (!response.ok) return
        const data = (await response.json()) as UserPreferencesResponse
        if (cancelled) return
        setPreferences(data)
        setAvailable(true)
        // Only once the surface is actually on screen. Firing before the fetch resolved would count
        // a prompt nobody could have seen, and the denominator of every rate below it would be wrong.
        trackConversionEvent('segment_prompt_viewed', 'settings', {
          segment: { previous: data.primarySegment, next: data.primarySegment, source: 'settings' },
        })
      } catch {
        // Deliberately silent: a failed preferences fetch must not take the rest of /me down.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [doFetch])

  const choose = React.useCallback(
    async (segment: UserSegment | null) => {
      // Captured before the optimistic update overwrites it — the event needs where we came from.
      const previous = preferences?.primarySegment ?? null
      setSave({ kind: 'saving' })
      // Optimistic, because the control is a radio and leaving it on the old value while a request
      // is in flight makes the interface feel like it ignored the click.
      setPreferences((current) => (current ? { ...current, primarySegment: segment } : current))
      try {
        const response = await doFetch('/api/me/preferences', {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ primarySegment: segment, source: 'settings' }),
        })
        if (!response.ok) {
          setSave({ kind: 'error', message: 'That did not save. Try again.' })
          return
        }
        const data = (await response.json()) as UserPreferencesResponse
        // `segment_selected` for a first choice, `segment_changed` for a replacement. They are
        // different questions — one measures whether the prompt works, the other whether the answer
        // sticks — and a single event could answer neither.
        trackConversionEvent(previous === null ? 'segment_selected' : 'segment_changed', 'settings', {
          segment: { previous, next: segment, source: 'settings' },
        })
        setPreferences(data)
        setSave({ kind: 'saved' })
      } catch {
        setSave({ kind: 'error', message: 'That did not save. Try again.' })
      }
    },
    [doFetch, preferences],
  )

  if (!available || !preferences) return null

  return (
    <section className="card p-6" data-testid="user-segment-settings">
      <fieldset className="border-0 p-0 m-0">
        <legend className="text-lg font-semibold mb-1">Primary goal</legend>
        <p className="text-sm text-bh-text-muted mb-1">
          Telling us what you are here for lets us put the right things first.
        </p>
        {/* The one promise this surface has to make, kept in the contract so the onboarding step and
            the API documentation cannot drift into a different reassurance. */}
        <p className="text-sm text-bh-text-muted mb-4">{SEGMENT_SCOPE_NOTICE}</p>

        <div className="space-y-2">
          {USER_SEGMENTS.map((segment) => {
            const copy = USER_SEGMENT_COPY[segment]
            const describedBy = `segment-${segment}-description`
            return (
              <label
                key={segment}
                className="flex gap-3 items-start p-3 rounded-lg border border-bh-border/60 cursor-pointer hover:bg-bh-surface-2"
              >
                <input
                  type="radio"
                  name="primary-segment"
                  value={segment}
                  className="mt-1"
                  checked={preferences.primarySegment === segment}
                  aria-describedby={describedBy}
                  onChange={() => void choose(segment)}
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

        {/* Clearing is a real choice, not an absence of one, so it gets a control rather than
            requiring somebody to guess that there is no way back to the general experience. */}
        {preferences.primarySegment !== null && (
          <button
            type="button"
            className="mt-3 text-sm underline text-bh-text-muted"
            onClick={() => void choose(null)}
          >
            Clear my selection
          </button>
        )}

        {/* `role="status"` so a screen reader hears the outcome without the focus moving. */}
        <p role="status" aria-live="polite" className="mt-3 text-sm min-h-5">
          {save.kind === 'saving' && 'Saving…'}
          {save.kind === 'saved' && 'Saved.'}
          {save.kind === 'error' && <span className="text-bh-danger">{save.message}</span>}
        </p>
      </fieldset>
    </section>
  )
}
