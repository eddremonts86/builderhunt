import { createFileRoute } from '@tanstack/react-router'
import { BuilderProfilePage } from '~/modules/builder-profile/components/BuilderProfilePage'
import { getPublicBuilder } from '~/shared/lib/public-data'
import { ThemeProvider } from '~/shared/lib/theme/ThemeProvider'

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
    try {
      const builder = await getPublicBuilder({ data: params.builderId })
      return { builder: builder as LoaderBuilder | null }
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
  component: () => (
    <ThemeProvider>
      <BuilderProfilePage />
    </ThemeProvider>
  ),
})
