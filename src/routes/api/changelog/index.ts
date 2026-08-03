import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { listPublicChangelogEntries } from '~/shared/lib/repositories/public-content'
import { markdownToPlainText, renderPlatformMarkdown } from '~/shared/lib/markdown'

export const Route = createFileRoute('/api/changelog/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async () => {
        try {
          const rows = await listPublicChangelogEntries()
          // `content` is markdown (see the column comment in schema.ts and the
          // admin editor's own label). Rendering it here rather than in the
          // page keeps `marked` out of the public client bundle, and gives the
          // list an excerpt that is not full of stray pipes and asterisks.
          return Response.json(
            await Promise.all(
              rows.map(async (row) => ({
                ...row,
                html: await renderPlatformMarkdown(row.content),
                excerpt: markdownToPlainText(row.content).slice(0, 240),
              })),
            ),
          )
        } catch (err) {
          console.error('changelog list error:', err)
          return Response.json([])
        }
      },
    },
  },
})
