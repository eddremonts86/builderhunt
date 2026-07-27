import { createFileRoute } from '@tanstack/react-router'
import { getAllPosts } from '~/shared/lib/blog'
import { SITE_URL as SITE } from '~/shared/lib/site-url'

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
        // XML carries no <meta>, so the blog surface's directive has to travel as
        // a header. `X-Robots-Tag` is the documented equivalent and is what keeps
        // the feed out of the index while the blog itself is hidden.
        const { getSurfaceRobots } = await import('~/shared/lib/repositories/public-surface-indexing')
        const { robotsMetaContent } = await import('~/shared/lib/seo/surfaces')
        const robots = robotsMetaContent(await getSurfaceRobots('blog'))
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
            ...(robots ? { 'X-Robots-Tag': robots } : {}),
          },
        })
      },
    },
  },
})
