import { createFileRoute } from '@tanstack/react-router'
import { BuilderProfilePage } from '~/modules/builder-profile/components/BuilderProfilePage'

const SITE_URL = 'https://builderhunt.dev'
const SITE_NAME = 'BuilderHunt'

interface LoaderBuilder {
  id: string
  username: string
  displayName: string | null
  bio: string | null
  avatarUrl: string | null
  source: string
}

export const Route = createFileRoute('/builders/$builderId')({
  loader: async ({ params }) => {
    // Lazy-import server-only deps (drizzle/postgres) so they never end up
    // in the client bundle — same pattern as ~/shared/lib/blog.ts.
    try {
      const [{ db }, { builders }, { eq }] = await Promise.all([
        import('~/shared/lib/db/index'),
        import('~/shared/lib/db/schema'),
        import('drizzle-orm'),
      ])
      const [builder] = await db
        .select({
          id: builders.id,
          username: builders.username,
          displayName: builders.displayName,
          bio: builders.bio,
          avatarUrl: builders.avatarUrl,
          source: builders.source,
        })
        .from(builders)
        .where(eq(builders.id, params.builderId))
      return { builder: (builder ?? null) as LoaderBuilder | null }
    } catch (err) {
      console.error('Builder profile loader error:', err)
      return { builder: null as LoaderBuilder | null }
    }
  },
  head: ({ loaderData, params }) => {
    const builder = loaderData?.builder
    const url = `${SITE_URL}/builders/${params.builderId}`
    if (!builder) {
      return {
        meta: [
          { title: `Builder not found — ${SITE_NAME}` },
          { property: 'og:url', content: url },
        ],
      }
    }
    const name = builder.displayName ?? builder.username
    const title = `${name} — ${SITE_NAME}`
    const description = builder.bio ?? `${name}'s builder profile on ${SITE_NAME}, aggregated from ${builder.source}.`
    const image = builder.avatarUrl ?? `${SITE_URL}/brand/og-image.png`
    return {
      meta: [
        { title },
        { name: 'description', content: description },
        { property: 'og:title', content: title },
        { property: 'og:description', content: description },
        { property: 'og:type', content: 'profile' },
        { property: 'og:url', content: url },
        { property: 'og:image', content: image },
        { name: 'twitter:card', content: 'summary' },
        { name: 'twitter:title', content: title },
        { name: 'twitter:description', content: description },
        { name: 'twitter:image', content: image },
      ],
    }
  },
  component: BuilderProfilePage,
})
