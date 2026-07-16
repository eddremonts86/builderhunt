import * as React from 'react'
import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { ArrowLeft, Calendar, Clock, Tag as TagIcon, ArrowRight } from 'lucide-react'
import { getPostBySlug, getRelatedPosts } from '~/shared/lib/blog'

export const Route = createFileRoute('/blog/$slug')({
  loader: async ({ params }) => {
    const post = await getPostBySlug(params.slug)
    if (!post) throw notFound()
    const related = await getRelatedPosts(params.slug, 3)
    return { post, related }
  },
  head: ({ loaderData }) => {
    if (!loaderData) return { meta: [{ title: 'Post not found — BuilderHunt' }] }
    const { post } = loaderData
    const title = `${post.title} — BuilderHunt Blog`
    return {
      meta: [
        { title },
        { name: 'description', content: post.description },
        { property: 'og:title', content: post.title },
        { property: 'og:description', content: post.description },
        { property: 'og:type', content: 'article' },
        { property: 'article:published_time', content: post.date },
        { property: 'article:author', content: post.author },
        { name: 'twitter:card', content: 'summary_large_image' },
      ],
    }
  },
  component: BlogPostPage,
})

function BlogPostPage() {
  const { post, related } = Route.useLoaderData()

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: post.description,
    datePublished: post.date,
    author: { '@type': 'Person', name: post.author },
    publisher: { '@type': 'Organization', name: 'BuilderHunt' },
    keywords: post.tags.join(', '),
  }

  return (
    <article className="min-h-[calc(100vh-4rem)] p-6 max-w-3xl mx-auto" data-testid={`blog-post-${post.slug}`}>
      <Link to="/blog" className="btn-ghost btn-sm mb-4 inline-flex" data-testid="blog-back">
        <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
        All posts
      </Link>

      <header className="mb-8">
        <div className="flex items-center gap-3 text-xs text-bh-text-dim mb-3">
          <span className="inline-flex items-center gap-1">
            <Calendar className="w-3 h-3" aria-hidden="true" />
            {new Date(post.date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
          </span>
          <span className="inline-flex items-center gap-1">
            <Clock className="w-3 h-3" aria-hidden="true" />
            {post.readingTime} min read
          </span>
          {post.tags.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <TagIcon className="w-3 h-3" aria-hidden="true" />
              {post.tags.join(', ')}
            </span>
          )}
        </div>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-2" data-testid="blog-post-title">
          {post.title}
        </h1>
        <p className="text-bh-text-muted">{post.description}</p>
        <p className="text-xs text-bh-text-dim mt-2">By {post.author}</p>
      </header>

      <div
        className="prose prose-invert max-w-none text-bh-text-muted leading-relaxed"
        data-testid="blog-post-body"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: post.html }}
      />

      <footer className="mt-12 pt-8 border-t border-bh-border">
        <div className="card p-5 bg-gradient-to-br from-bh-accent/5 to-bh-cyan/5 border-bh-accent/20 text-center">
          <h2 className="text-lg font-semibold mb-1">Find active developers</h2>
          <p className="text-sm text-bh-text-muted mb-4">
            Search across 12 sources, save your queries, get daily alerts.
          </p>
          <Link to="/explore" className="btn-primary inline-flex" data-testid="blog-cta-explore">
            Try the explorer
            <ArrowRight className="w-4 h-4" aria-hidden="true" />
          </Link>
        </div>

        {related.length > 0 && (
          <div className="mt-8" data-testid="blog-related">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-bh-text-dim mb-3">
              Related posts
            </h3>
            <ul className="space-y-2">
              {related.map((r) => (
                <li key={r.slug}>
                  <Link
                    to="/blog/$slug"
                    params={{ slug: r.slug }}
                    className="card p-3 flex items-center gap-3 hover:border-bh-accent/30 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm text-bh-text truncate">{r.title}</p>
                      <p className="text-xs text-bh-text-dim">{r.date} · {r.readingTime} min</p>
                    </div>
                    <ArrowRight className="w-4 h-4 text-bh-text-dim" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </footer>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
    </article>
  )
}
