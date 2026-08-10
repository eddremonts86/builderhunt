import { createFileRoute } from '@tanstack/react-router'
import { HomePage } from '~/modules/landing/components/HomePage'

export const Route = createFileRoute('/_landing/')({
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
  const { user } = Route.useRouteContext()
  return <HomePage isAuthed={!!user.userId} />
}
