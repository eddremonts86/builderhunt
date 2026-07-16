import { createFileRoute } from '@tanstack/react-router'
import { getAllPosts } from '~/shared/lib/blog'

const SITE = 'https://builderhunt.dev'

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '&': return '&amp;'
      case "'": return '&apos;'
      case '"': return '&quot;'
      default: return c
    }
  })
}

export const Route = createFileRoute('/blog/atom.xml')({
  component: () => null,
  server: {
    handlers: {
      GET: async () => {
        const posts = await getAllPosts()
        const now = new Date().toISOString()
        const entries = posts
          .map((p) => {
            const url = `${SITE}/blog/${p.slug}`
            return `  <entry>
    <title>${escapeXml(p.title)}</title>
    <id>${url}</id>
    <link href="${url}" />
    <updated>${new Date(p.date).toISOString()}</updated>
    <published>${new Date(p.date).toISOString()}</published>
    <summary>${escapeXml(p.description)}</summary>
    <author>
      <name>${escapeXml(p.author)}</name>
    </author>
  </entry>`
          })
          .join('\n')
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>BuilderHunt Blog</title>
  <id>${SITE}/blog</id>
  <link href="${SITE}/blog" />
  <link href="${SITE}/blog/atom.xml" rel="self" />
  <updated>${now}</updated>
${entries}
</feed>
`
        return new Response(xml, {
          status: 200,
          headers: {
            'Content-Type': 'application/atom+xml; charset=utf-8',
            'Cache-Control': 'public, max-age=3600, s-maxage=3600',
          },
        })
      },
    },
  },
})
