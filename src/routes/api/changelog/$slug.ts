import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { findPublicChangelogEntryBySlug } from '~/shared/lib/repositories/public-content'
import { markdownToPlainText, renderPlatformMarkdown } from '~/shared/lib/markdown'

export const Route = createFileRoute('/api/changelog/$slug')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ params }) => {
        try {
          const row = await findPublicChangelogEntryBySlug(params.slug)
          if (!row) return Response.json({ error: 'Not found' }, { status: 404 })
          return Response.json({
            ...row,
            html: await renderPlatformMarkdown(row.content),
            excerpt: markdownToPlainText(row.content).slice(0, 240),
          })
        } catch (err) {
          console.error('changelog get error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
