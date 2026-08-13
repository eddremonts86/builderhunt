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
// table-surface-bounded: the library is the filesystem — one row per post file, read whole. A capability would exist only to satisfy this gate.
import * as React from 'react'
import { Calendar, Clock, ExternalLink, FileText, Rss, Search, Tag as TagIcon } from 'lucide-react'
import { DataTable, DateCell, EmptyCell, NumberCell, PrimaryCell } from '~/shared/components/table'
import { emptyTableSearch } from '~/shared/lib/table/query-url'
import type { ColumnDef } from '~/shared/lib/table/columns'
import type { PageResult, TableQuery } from '~/shared/lib/table/types'
import type { BlogPostSummary } from '~/shared/lib/blog'

/** The loader's summary shape, re-exported under the name this component has always used. */
export type BlogPostRow = BlogPostSummary

export function BlogLibrary({ posts }: { posts: BlogPostRow[] }) {
  const [query, setQuery] = React.useState<TableQuery>(() => emptyTableSearch().query)

  /**
   * A `PageResult` the shell cannot tell is not SQL.
   *
   * Sorting and filtering run over the **complete** parsed set, and that is correct precisely
   * because it is complete — phase 3's rule is that partial data changes what is *correct*, not
   * merely what is fast. There is nothing partial here: every post in `content/posts/` is in this
   * array.
   *
   * There is deliberately **no capability** for this surface. A capability exists to resolve a
   * client-supplied id into a database column through an allowlist; nothing here resolves anything,
   * because nothing here reaches a database. Registering one whose every field was a placeholder,
   * purely so the sort-index guard could report an exemption, would be adding a lie to satisfy a
   * checklist. The guard sweeps registered capabilities, this is not one, and the reason is here.
   */
  const page: PageResult<BlogPostRow> = React.useMemo(() => {
    const term = query.search.trim().toLowerCase()
    const tagFilter = query.filters.tags ?? []

    const searched = term === ''
      ? posts
      : posts.filter((post) =>
        `${post.title} ${post.description} ${post.slug} ${post.tags.join(' ')}`.toLowerCase().includes(term))
    let rows = tagFilter.length > 0
      ? searched.filter((post) => post.tags.some((tag) => tagFilter.includes(tag)))
      : searched

    const sortTerm = query.sort[0]
    rows = [...rows].sort((a, b) => {
      if (!sortTerm) return b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug)
      const direction = sortTerm.dir === 'asc' ? 1 : -1
      const left = sortTerm.id === 'title' ? a.title : sortTerm.id === 'readingTime' ? String(a.readingTime).padStart(6, '0') : a.date
      const right = sortTerm.id === 'title' ? b.title : sortTerm.id === 'readingTime' ? String(b.readingTime).padStart(6, '0') : b.date
      // Two posts published on the same day would otherwise reshuffle on every render; the slug is
      // unique by construction (it must equal the filename), so it is the natural tiebreaker.
      return left === right ? a.slug.localeCompare(b.slug) : (left < right ? -1 : 1) * direction
    })

    // Counted before the tag filter, so a chip says what it would add rather than zero.
    const tagCounts = new Map<string, number>()
    for (const post of searched) {
      for (const tag of post.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
    }

    return {
      rows,
      nextCursor: null,
      total: rows.length,
      facets: {
        tags: [...tagCounts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([value, count]) => ({ value, count })),
      },
    }
  }, [posts, query])

  const columns = React.useMemo<ColumnDef<BlogPostRow>[]>(() => [
    {
      id: 'title',
      header: 'Post',
      kind: 'primary',
      sortable: true,
      priority: 'primary',
      value: (post) => post.title,
      cell: (post) => <PrimaryCell title={post.title} meta={post.description} />,
    },
    {
      id: 'date',
      header: 'Published',
      kind: 'date',
      sortable: true,
      value: (post) => post.date,
      // The calendar icon went with the raw date string. A `date` column is the only thing in the
      // table shaped like a date, so an icon saying so is decoration in a 168px track that now has
      // two lines of real content to fit.
      cell: (post) => <DateCell value={post.date} />,
    },
    {
      id: 'readingTime',
      header: 'Reading',
      kind: 'number',
      sortable: true,
      priority: 'secondary',
      value: (post) => post.readingTime,
      cell: (post) => <NumberCell value={post.readingTime} unit=" min" />,
    },
    {
      id: 'file',
      header: 'File',
      kind: 'category',
      priority: 'detail',
      value: (post) => post.file,
      // A path is a literal filesystem key, which is one of the two things DESIGN.md:221 keeps a
      // monospace face for.
      cell: (post) => <code className="truncate text-xs" title={`content/posts/${post.file}`}>content/posts/{post.file}</code>,
    },
    {
      id: 'tags',
      header: 'Tags',
      kind: 'category',
      priority: 'detail',
      value: (post) => post.tags.join(', '),
      cell: (post) => post.tags.length > 0
        ? <span className="truncate" title={post.tags.join(', ')}>{post.tags.join(', ')}</span>
        : <EmptyCell label="No tags" />,
    },
    {
      id: 'actions',
      header: 'Actions',
      kind: 'actions',
      cell: (post) => (
        <a
          href={`/blog/${post.slug}`}
          target="_blank"
          rel="noreferrer"
          className="btn-icon shrink-0"
          aria-label={`View ${post.title} in public`}
          data-testid="admin-blog-view"
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      ),
    },
  ], [])

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

      <DataTable
        label="Blog posts"
        columns={columns}
        page={page}
        query={query}
        onQueryChange={setQuery}
        rowTestId={(post) => `admin-blog-row-${post.slug}`}
        rowId={(post) => post.slug}
        filterLabels={{ tags: 'Tag' }}
        emptyState={(
          <div className="px-4 py-12 text-center text-sm text-bh-text-muted" data-testid="admin-blog-empty">
            No posts found. In production this usually means <code>content/</code> did not make it into
            the image — check the <code>COPY content ./content</code> line in the Dockerfile.
          </div>
        )}
      />
    </div>
  )
}
