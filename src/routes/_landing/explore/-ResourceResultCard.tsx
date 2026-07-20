import { ExternalLink, GitFork, Star } from 'lucide-react'
import type { PublicSearchBuilder } from '~/shared/lib/public-data'

const SOURCE_LABELS: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  codeberg: 'Codeberg',
  sourcehut: 'SourceHut',
  npm: 'npm',
  huggingface: 'Hugging Face',
}

const numberFormatter = new Intl.NumberFormat('en-US')

export function ResourceResultCard({ resource }: { resource: PublicSearchBuilder }) {
  const title = resource.displayName ?? resource.username
  const sourceLabel = SOURCE_LABELS[resource.source] ?? resource.source

  return (
    <article className="card flex min-w-0 flex-col p-5 transition-[transform,border-color] hover:-translate-y-0.5 hover:border-bh-accent/30 motion-reduce:transform-none">
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-bh-accent/10 text-bh-accent" aria-hidden="true">
          <GitFork className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 truncate font-semibold text-bh-text">{title}</h3>
            <span className="rounded-full border border-bh-border bg-bh-surface-2 px-2 py-0.5 text-[11px] font-medium text-bh-text-muted">
              {sourceLabel}
            </span>
          </div>
          <p className="mt-1 truncate text-xs text-bh-text-dim">{resource.username}</p>
        </div>
      </div>

      {resource.bio && (
        <p className="mt-4 line-clamp-2 text-sm leading-6 text-bh-text-muted">{resource.bio}</p>
      )}

      {resource.topics.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5" aria-label="Topics">
          {resource.topics.slice(0, 4).map((topic) => (
            <span key={topic} className="rounded-lg bg-bh-surface-2 px-2 py-1 text-xs text-bh-text-muted">
              {topic}
            </span>
          ))}
        </div>
      )}

      <div className="mt-auto flex items-center justify-between gap-4 pt-5 text-xs text-bh-text-muted">
        <div className="flex min-w-0 items-center gap-3">
          {resource.followersCount > 0 && (
            <span className="inline-flex items-center gap-1 whitespace-nowrap">
              <Star className="h-3.5 w-3.5" aria-hidden="true" />
              {numberFormatter.format(resource.followersCount)}
            </span>
          )}
          {resource.language && <span className="truncate">{resource.language}</span>}
        </div>
        <a
          href={resource.profileUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1 rounded-lg font-semibold text-bh-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
        >
          Open resource
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      </div>
    </article>
  )
}
