import { createFileRoute, Link, notFound } from '@tanstack/react-router'

import { SelfManagedProfile } from '~/modules/builder-profile/components/SelfManagedProfile'
import { HANDLE_PATTERN } from '~/shared/lib/self-managed/contracts'
import {
  resolvePublicSelfManagedProfile,
  type PublicSelfManagedProfilePage,
} from '~/shared/lib/self-managed/public-profile'
import { pageMeta } from '~/shared/lib/page-meta'
import { robotsMetaTag } from '~/shared/lib/seo/surfaces'
import { SITE_URL } from '~/shared/lib/site-url'
import { ThemeProvider } from '~/shared/lib/theme/ThemeProvider'
import { LinkButton } from '~/components/ui/link'

const SITE_NAME = 'BuilderHunt'

/**
 * A self-managed builder's public page (plan: phase-2/07-perfiles-autogestionados).
 *
 * ## Three visibility states, three different HTTP answers
 *
 * `public` is served and indexable. `unlisted` is served — it means reachable by anyone holding the
 * link — and carries `noindex`, because "share this with one person" and "put this in Google" are
 * different requests. `draft` and soft-deleted are `notFound()`, the same 404 as a handle nobody
 * ever took: distinguishing them would turn this route into a way to learn that a draft exists.
 *
 * ## The malformed handle is a 404, not a 500
 *
 * Same reasoning as `/r/$slug` and `/blog/$slug`: the inner Zod validator would throw on a handle
 * the pattern rejects, and to a visitor "not a valid handle" is simply "no such profile". The
 * validator still runs server-side, so nothing unsafe gets through this check being lenient.
 */
export const Route = createFileRoute('/u/$handle')({
  loader: async ({ params }): Promise<PublicSelfManagedProfilePage> => {
    if (!HANDLE_PATTERN.test(params.handle)) throw notFound()
    const page = await resolvePublicSelfManagedProfile({ data: params.handle })
    if (!page) throw notFound()
    return page
  },
  head: ({ loaderData, params }) => {
    if (!loaderData) return { meta: [{ title: `Profile not found — ${SITE_NAME}` }] }
    const { profile, listed } = loaderData
    const title = `${profile.displayName} (@${profile.handle}) — ${SITE_NAME}`
    const description = profile.headline
      ?? `${profile.displayName} keeps a self-managed profile on ${SITE_NAME}.`
    return {
      meta: [
        ...pageMeta({ title, description, url: `${SITE_URL}/u/${params.handle}` }),
        { property: 'og:type', content: 'profile' },
        // Unlisted is reachable by link and must stay out of the index. `robotsMetaTag` emits both
        // `robots` and `googlebot`, because the root sets its own `googlebot` and Google honours
        // the named tag over the generic one.
        ...robotsMetaTag(listed ? { noindex: false, nofollow: false } : { noindex: true, nofollow: false }),
      ],
    }
  },
  component: PublicSelfManagedProfilePageRoute,
})

function PublicSelfManagedProfilePageRoute() {
  const { profile, attachments } = Route.useLoaderData()

  return (
    <ThemeProvider>
      <div className="min-h-screen bg-bh-bg">
        <header className="border-b border-bh-border/60 bg-bh-surface">
          <div className="container flex items-center justify-between py-4">
            <Link to="/" className="text-lg font-bold tracking-tight text-bh-text">{SITE_NAME}</Link>
            <LinkButton to="/auth/sign-up" variant="primary" size="sm">Sign up free</LinkButton>
          </div>
        </header>

        <main className="container py-10 md:py-14">
          <SelfManagedProfile profile={profile} attachments={attachments} />
        </main>
      </div>
    </ThemeProvider>
  )
}
