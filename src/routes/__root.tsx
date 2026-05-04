import { createRootRoute } from '@tanstack/react-router'
import { RootDocument, RootErrorBoundary } from './-root-components'
import { NotFoundPage } from '~/components/composite/NotFoundPage'
import appCss from '~/shared/styles/globals.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'BuilderHunt — Discover Active Builders' },
      { name: 'description', content: 'Find active open-source builders across GitHub, Reddit, HN and DEV.to' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: RootDocument,
  errorComponent: RootErrorBoundary,
  notFoundComponent: NotFoundPage,
})