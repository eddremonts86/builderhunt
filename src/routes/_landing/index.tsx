import { createFileRoute } from '@tanstack/react-router'
import { HomePage } from '~/modules/landing/components/HomePage'
import { personaFromSearch } from '~/modules/landing/content/persona-copy'
import { getSegmentedLandingEnabled } from '~/shared/lib/segmented-landing-flag'

export const Route = createFileRoute('/_landing/')({
  /**
   * `?persona=` chooses which of three text blocks the page renders
   * (plan: phase-2/08-homing-page-content-and-sections).
   *
   * Kept as a raw string here and narrowed by `personaFromSearch` at the point of use, so an
   * unrecognised value is indistinguishable from an absent one — the URL is attacker-controlled and a
   * validator that rejected loudly would turn the parameter into a way to probe the enum.
   */
  validateSearch: (search: Record<string, unknown>): { persona?: string } =>
    (typeof search.persona === 'string' ? { persona: search.persona } : {}),
  // Resolved here rather than read in the component: `env.ts` hands the browser a stub, so a
  // component asking it directly would hide the selector on every client render whatever the server
  // has configured. See `segmented-landing-flag.ts`.
  beforeLoad: async () => ({ segmentedLanding: await getSegmentedLandingEnabled() }),
  component: HomeRoute,
})

/**
 * A wrapper, so `HomePage` can stay a presentational component with an explicit prop.
 *
 * It used to be `component: HomePage` with `HomePage` calling `useSession()` itself — which meant
 * the server rendered its signed-out CTAs for a signed-in visitor and the client could render the
 * signed-in ones on its first pass. See `_landing/route.tsx` for what that costs. The session is
 * resolved once, in that layout's `beforeLoad`, and read from route context here.
 */
function HomeRoute() {
  const { user, segmentedLanding } = Route.useRouteContext()
  const { persona } = Route.useSearch()
  return (
    <HomePage
      isAuthed={!!user.userId}
      showSegmentSelector={segmentedLanding}
      persona={personaFromSearch(persona)}
    />
  )
}
