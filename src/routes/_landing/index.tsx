import { createFileRoute } from '@tanstack/react-router'
import { HomePage } from '~/modules/landing/components/HomePage'
import { getSegmentedLandingEnabled } from '~/shared/lib/segmented-landing-flag'

export const Route = createFileRoute('/_landing/')({
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
  return <HomePage isAuthed={!!user.userId} showSegmentSelector={segmentedLanding} />
}
