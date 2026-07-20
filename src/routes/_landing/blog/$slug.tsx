import * as React from 'react'
import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { ArrowLeft, Calendar, Clock, Tag as TagIcon, ArrowRight } from 'lucide-react'
import { getBlogPostPage } from '~/shared/lib/blog-data'

export const Route = createFileRoute('/_landing/blog/$slug')({
  loader: async ({ params }) => {
    const page = await getBlogPostPage({ data: params.slug })
    if (!page) throw notFound()
    return page
  },
  head: ({ loaderData }) => {
    if (!loaderData) return { meta: [{ title: 'Post not found — BuilderHunt' }] }
    const { post } = loaderData
    const title = `${post.title} — BuilderHunt Blog`
    const url = `https://builderhunt.dev/blog/${post.slug}`
    return {
      meta: [
        { title },
        { name: 'description', content: post.description },
        { property: 'og:title', content: post.title },
        { property: 'og:description', content: post.description },
        { property: 'og:type', content: 'article' },
        { property: 'og:url', content: url },
        { property: 'article:published_time', content: post.date },
        { property: 'article:author', content: post.author },
        { name: 'twitter:card', content: 'summary_large_image' },
        { name: 'twitter:title', content: post.title },
        { name: 'twitter:description', content: post.description },
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
    <article className="container py-12 max-w-4xl animate-fade-in" data-testid={`blog-post-${post.slug}`}>
      <div className="card p-8 md:p-12 border border-bh-border/60 bg-bh-surface rounded-2xl shadow-sm">
        <Link to="/blog" className="btn-ghost btn-sm mb-6 inline-flex" data-testid="blog-back">
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
          <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight mb-3 text-bh-text" data-testid="blog-post-title">
            {post.title}
          </h1>
          <p className="text-bh-text-muted text-base leading-relaxed mb-3">{post.description}</p>
          <p className="text-xs text-bh-text-dim">By {post.author}</p>
        </header>

        <div
          className="prose prose-invert max-w-none text-bh-text-muted leading-relaxed pt-6 border-t border-bh-border/40"
          data-testid="blog-post-body"
          dangerouslySetInnerHTML={{ __html: post.html }}
        />

        <footer className="mt-12 pt-8 border-t border-bh-border/40">
          <div className="card p-6 bg-gradient-to-br from-bh-accent/5 to-bh-cyan/5 border border-bh-accent/20 text-center rounded-xl">
            <h2 className="text-lg font-bold mb-1 text-bh-text">Find active developers</h2>
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
                      className="card p-4 flex items-center gap-3 border border-bh-border/50 bg-bh-surface hover:border-bh-accent/30 transition-all rounded-xl"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-sm text-bh-text truncate">{r.title}</p>
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
      </div>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
    </article>
  )
}
