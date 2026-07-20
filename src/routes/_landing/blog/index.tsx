import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Calendar, Clock, ArrowRight, BookOpen, Tag as TagIcon } from 'lucide-react'
import { getBlogPosts } from '~/shared/lib/blog-data'

export const Route = createFileRoute('/_landing/blog/')({
  loader: async () => {
    const posts = await getBlogPosts()
    return { posts }
  },
  head: () => ({
    meta: [
      { title: 'Blog — BuilderHunt' },
      {
        name: 'description',
        content: 'Founder stories, technical deep-dives, and practical guides for finding and reaching developers.',
      },
      { property: 'og:title', content: 'BuilderHunt Blog' },
      { property: 'og:description', content: 'Founder stories, technical deep-dives, and practical guides.' },
      { property: 'og:type', content: 'website' },
    ],
  }),
  component: BlogListPage,
})

function BlogListPage() {
  const { posts } = Route.useLoaderData()
  return (
    <div className="container py-12 max-w-4xl animate-fade-in" data-testid="blog-list">
      <header className="mb-8">
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight flex items-center gap-3 mb-2 text-bh-text">
          <BookOpen className="w-7 h-7 text-bh-accent" aria-hidden="true" />
          Blog
        </h1>
        <p className="text-bh-text-muted">
          Founder stories, technical deep-dives, and practical guides.
        </p>
        <p className="text-xs text-bh-text-dim mt-2">
          <a href="/blog/atom.xml" className="text-bh-accent hover:underline" data-testid="blog-rss-link">
            RSS feed
          </a>
        </p>
      </header>

      {posts.length === 0 ? (
        <div className="card text-center py-12 border border-bh-border/60 bg-bh-surface" data-testid="blog-empty">
          <p className="text-bh-text-muted">No posts yet. Check back soon.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {posts.map((post) => (
            <article
              key={post.slug}
              className="card p-6 border border-bh-border/60 bg-bh-surface hover:border-bh-accent/40 hover:shadow-md transition-all rounded-2xl"
              data-testid={`blog-post-card-${post.slug}`}
            >
              <div className="flex items-center gap-3 text-xs text-bh-text-dim mb-3">
                <span className="inline-flex items-center gap-1">
                  <Calendar className="w-3 h-3" aria-hidden="true" />
                  {new Date(post.date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
                </span>
                <span className="inline-flex items-center gap-1">
                  <Clock className="w-3 h-3" aria-hidden="true" />
                  {post.readingTime} min read
                </span>
              </div>
              <h2 className="text-xl font-bold text-bh-text mb-2">
                <Link
                  to="/blog/$slug"
                  params={{ slug: post.slug }}
                  className="hover:text-bh-accent transition-colors"
                  data-testid="blog-post-link"
                >
                  {post.title}
                </Link>
              </h2>
              <p className="text-sm text-bh-text-muted mb-4 leading-relaxed">{post.description}</p>
              <div className="flex items-center gap-2 flex-wrap">
                {post.tags.map((t) => (
                  <span
                    key={t}
                    className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-semibold border bg-bh-accent-soft text-bh-accent border-bh-accent/30"
                  >
                    <TagIcon className="w-2.5 h-2.5" aria-hidden="true" />
                    {t}
                  </span>
                ))}
                <Link
                  to="/blog/$slug"
                  params={{ slug: post.slug }}
                  className="ml-auto text-sm text-bh-accent hover:underline inline-flex items-center gap-1 font-semibold"
                >
                  Read post
                  <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
