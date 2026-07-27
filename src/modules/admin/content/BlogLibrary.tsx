/**
 * Read-only management view over the file-based blog.
 *
 * Deliberately not a CRUD form. Posts live in `content/posts/*.md`, and that is
 * the reason /blog survives a database restore and can be reviewed in a diff
 * before it is public. A create/edit form here would write into a container
 * filesystem that the next deploy replaces — the entry would vanish and nobody
 * would know why. So this surface answers the questions an editor actually has:
 * what exists, when was it published, which file holds it, and does it look
 * right in public.
 */
import * as React from 'react'
import { Calendar, Clock, ExternalLink, FileText, Rss, Search, Tag as TagIcon } from 'lucide-react'
import { Input } from '~/components/ui'

export interface BlogPostRow {
  slug: string
  title: string
  description: string
  date: string
  tags: string[]
  author: string
  readingTime: number
  file: string
}

export function BlogLibrary({ posts }: { posts: BlogPostRow[] }) {
  const [query, setQuery] = React.useState('')
  const [activeTag, setActiveTag] = React.useState<string | null>(null)

  const tags = React.useMemo(
    () => [...new Set(posts.flatMap((p) => p.tags))].sort(),
    [posts],
  )

  const visible = posts.filter((p) => {
    if (activeTag && !p.tags.includes(activeTag)) return false
    if (!query.trim()) return true
    const haystack = `${p.title} ${p.description} ${p.slug} ${p.tags.join(' ')}`.toLowerCase()
    return haystack.includes(query.trim().toLowerCase())
  })

  return (
    <div data-testid="admin-blog-library">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <FileText className="w-6 h-6 text-bh-accent" aria-hidden="true" />
          Blog
          <span className="text-sm font-normal text-bh-text-dim">({posts.length})</span>
        </h1>
        <p className="text-sm text-bh-text-muted mt-1">
          Public at{' '}
          <a href="/blog" className="text-bh-accent hover:underline" target="_blank" rel="noreferrer">
            /blog
          </a>
          {' · '}
          <a href="/blog/atom.xml" className="text-bh-accent hover:underline" target="_blank" rel="noreferrer">
            <Rss className="w-3 h-3 inline" aria-hidden="true" /> feed
          </a>
        </p>
      </header>

      <div className="card p-4 mb-6 border-bh-border/60">
        <p className="text-sm font-semibold mb-1">Posts are files, on purpose</p>
        <p className="text-xs text-bh-text-muted leading-relaxed">
          Add a post by copying <code className="text-bh-accent">content/posts/_TEMPLATE.md</code> to
          {' '}<code className="text-bh-accent">content/posts/&lt;slug&gt;.md</code>, filling in the frontmatter
          (the <code>slug</code> must equal the filename), and committing it. The loader caches for five
          minutes, so a new post appears within that window without a restart. Nothing here writes to the
          container filesystem — an edit made in a running container would be discarded by the next deploy.
        </p>
      </div>

      <div className="flex items-center gap-2 flex-wrap mb-4">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-bh-text-dim" aria-hidden="true" />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by title, slug or tag…"
            className="w-full pl-9"
            aria-label="Filter posts"
            data-testid="admin-blog-search"
          />
        </div>
        {tags.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setActiveTag(activeTag === t ? null : t)}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors ${
              activeTag === t
                ? 'bg-bh-accent-soft text-bh-accent border-bh-accent/40'
                : 'text-bh-text-dim border-bh-border/60 hover:border-bh-accent/30'
            }`}
            data-testid={`admin-blog-tag-${t}`}
          >
            <TagIcon className="w-2.5 h-2.5" aria-hidden="true" />
            {t}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {posts.length === 0 ? (
          <p className="text-sm text-bh-text-muted">
            No posts found. In production this usually means <code>content/</code> did not make it into
            the image — check the <code>COPY content ./content</code> line in the Dockerfile.
          </p>
        ) : visible.length === 0 ? (
          <p className="text-sm text-bh-text-muted">No post matches that filter.</p>
        ) : (
          visible.map((p) => (
            <div key={p.slug} className="card p-4 flex items-start gap-3" data-testid={`admin-blog-row-${p.slug}`}>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm">{p.title}</p>
                <p className="text-xs text-bh-text-muted mt-1 line-clamp-2">{p.description}</p>
                <p className="text-xs text-bh-text-dim mt-1 flex items-center gap-3 flex-wrap">
                  <span className="inline-flex items-center gap-1">
                    <Calendar className="w-3 h-3" aria-hidden="true" />
                    {p.date}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Clock className="w-3 h-3" aria-hidden="true" />
                    {p.readingTime} min
                  </span>
                  <code className="text-bh-text-dim">content/posts/{p.file}</code>
                  {p.tags.length > 0 && <span>{p.tags.join(', ')}</span>}
                </p>
              </div>
              <a
                href={`/blog/${p.slug}`}
                target="_blank"
                rel="noreferrer"
                className="btn-icon shrink-0"
                aria-label={`View ${p.title} in public`}
                data-testid="admin-blog-view"
              >
                <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
              </a>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
