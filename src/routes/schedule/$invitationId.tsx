import { createFileRoute } from '@tanstack/react-router'
import { CandidatePortal } from '~/modules/scheduling/components/CandidatePortal'

/**
 * The candidate's booking page (plan: calendar-scheduling-interview-intelligence, Phase 5 "Build
 * mobile accountless candidate portal").
 *
 * Public and signed-out by design: there is no account, no login wall, and no redirect to one. The
 * capability in the URL fragment is the entire authorization story, which is what makes this the one
 * page in the app that must not depend on a session.
 *
 * `noindex, nofollow` because the URL identifies one named person interviewing at one named company.
 * A search engine that indexed it would publish that fact, and `robots.txt` is advisory whereas this
 * header is not.
 */
export const Route = createFileRoute('/schedule/$invitationId')({
  head: () => ({
    meta: [
      { title: 'Your interview invitation · BuilderHunt' },
      { name: 'robots', content: 'noindex, nofollow, noarchive' },
      { name: 'referrer', content: 'no-referrer' },
    ],
  }),
  component: SchedulePage,
})

function SchedulePage() {
  const { invitationId } = Route.useParams()
  return (
    <main className="min-h-screen bg-bh-bg text-bh-text">
      <CandidatePortal invitationId={invitationId} />
    </main>
  )
}
