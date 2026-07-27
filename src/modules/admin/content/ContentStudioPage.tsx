/**
 * One place to see and edit everything public: blog posts, changelog entries and
 * roadmap items.
 *
 * Before this existed, the three surfaces lived in three places with no common
 * entry point — blog posts only in a text editor, changelog and roadmap behind
 * separate admin routes, and no indication anywhere that a database row and a
 * committed file are two different kinds of thing. The tabs are the same
 * components those standalone routes render, so this is a hub rather than a
 * fourth copy.
 */
import * as React from 'react'
import { BookOpen, FileText, Layers, Map } from 'lucide-react'
import { BlogLibrary, type BlogPostRow } from './BlogLibrary'
import { ChangelogManager } from './ChangelogManager'
import { IndexingPanel } from './IndexingPanel'
import { RoadmapManager } from './RoadmapManager'

export const CONTENT_TABS = ['blog', 'changelog', 'roadmap'] as const
export type ContentTab = (typeof CONTENT_TABS)[number]

const TAB_META: Record<ContentTab, { label: string; icon: React.ComponentType<{ className?: string }>; hint: string }> = {
  blog: { label: 'Blog', icon: FileText, hint: 'files in content/posts' },
  changelog: { label: 'Changelog', icon: BookOpen, hint: 'database + content/changelog' },
  roadmap: { label: 'Roadmap', icon: Map, hint: 'database + content/roadmap' },
}

export interface ContentStudioPageProps {
  posts: BlogPostRow[]
  tab: ContentTab
  onTabChange: (tab: ContentTab) => void
}

export function ContentStudioPage({ posts, tab, onTabChange }: ContentStudioPageProps) {
  return (
    <div data-testid="admin-content-page">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Layers className="w-6 h-6 text-bh-accent" aria-hidden="true" />
          Content
        </h1>
        <p className="text-sm text-bh-text-muted mt-1">
          Everything published on the public site. Blog posts are files; changelog entries and roadmap
          items are database rows that <code className="text-bh-accent">pnpm content:sync</code> keeps in
          step with <code className="text-bh-accent">content/</code>.
        </p>
      </header>

      <div
        className="flex items-center gap-1 border-b border-bh-border/40 mb-6"
        role="tablist"
        aria-label="Content type"
      >
        {CONTENT_TABS.map((key) => {
          const meta = TAB_META[key]
          const active = tab === key
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`content-panel-${key}`}
              id={`content-tab-${key}`}
              onClick={() => onTabChange(key)}
              className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors ${
                active
                  ? 'border-bh-accent text-bh-text'
                  : 'border-transparent text-bh-text-dim hover:text-bh-text-muted'
              }`}
              data-testid={`admin-content-tab-${key}`}
            >
              <meta.icon className="w-4 h-4" aria-hidden="true" />
              {meta.label}
              <span className="hidden md:inline text-[10px] font-normal text-bh-text-dim">
                {meta.hint}
              </span>
            </button>
          )
        })}
      </div>

      <div role="tabpanel" id={`content-panel-${tab}`} aria-labelledby={`content-tab-${tab}`}>
        {tab === 'blog' && <BlogLibrary posts={posts} />}
        {tab === 'changelog' && <ChangelogManager />}
        {tab === 'roadmap' && <RoadmapManager />}
      </div>

      {/* Outside the tabs on purpose: the three surfaces are toggled against each
          other ("blog is public, roadmap is not yet"), which is a decision you
          make looking at all three at once. */}
      <div className="mt-10">
        <IndexingPanel />
      </div>

      <section className="mt-10 card p-5 border-bh-border/60" data-testid="admin-content-workflow">
        <h2 className="font-semibold text-sm mb-2">Getting content onto the live site</h2>
        <p className="text-xs text-bh-text-muted leading-relaxed mb-3">
          The public pages read the database, and the database is not in git. Anything typed into the forms
          above exists only in the environment it was typed into — it is not reviewed, not committed, and
          not restored with a backup. The files under <code>content/</code> are the durable copy, and every
          deploy pushes them in.
        </p>
        <dl className="text-xs space-y-2">
          <div className="flex gap-3">
            <dt className="shrink-0 font-mono text-bh-accent w-56">pnpm content:sync</dt>
            <dd className="text-bh-text-muted">
              Upserts every file into this database. Idempotent, and it runs automatically as part of
              <code> pnpm deploy:db</code> on every production deploy.
            </dd>
          </div>
          <div className="flex gap-3">
            <dt className="shrink-0 font-mono text-bh-accent w-56">pnpm content:sync:dry</dt>
            <dd className="text-bh-text-muted">Prints what it would write, changes nothing.</dd>
          </div>
          <div className="flex gap-3">
            <dt className="shrink-0 font-mono text-bh-accent w-56">pnpm content:export</dt>
            <dd className="text-bh-text-muted">
              The other direction: writes the current rows back out as files. Run this after drafting in the
              forms above, then review the diff and commit — that is how a draft becomes permanent.
            </dd>
          </div>
          <div className="flex gap-3">
            <dt className="shrink-0 font-mono text-bh-accent w-56">pnpm content:sync --prune</dt>
            <dd className="text-bh-text-muted">
              Also deletes rows whose file is gone. Only ever touches rows these files own — rows created in
              the forms above are left alone, and are the ones marked <span className="text-bh-cyan">in git</span> when they are not.
            </dd>
          </div>
        </dl>
      </section>
    </div>
  )
}
