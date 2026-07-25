import * as React from 'react'
import { GithubIcon, RedditIcon, HackerNewsIcon, DevToIcon, LobstersIcon, StackOverflowIcon, NpmIcon, HuggingFaceIcon, GitLabIcon, CodebergIcon, HashnodeIcon, SourceHutIcon, DevpostIcon } from '~/modules/landing/components/BrandIcons'

export interface PersonCardData {
  id: string
  username: string
  displayName?: string | null
  source: string
  avatarUrl?: string | null
  bio?: string | null
  followersCount?: number
  profileUrl: string
  language?: string | null
  country?: string | null
  topics?: string[]
  score?: number
}

const SOURCE_META: Record<string, { label: string; Icon: React.ComponentType<{ className?: string }> }> = {
  github: { label: 'GitHub', Icon: GithubIcon },
  reddit: { label: 'Reddit', Icon: RedditIcon },
  hn: { label: 'Hacker News', Icon: HackerNewsIcon },
  devto: { label: 'DEV.to', Icon: DevToIcon },
  lobsters: { label: 'Lobsters', Icon: LobstersIcon },
  stackoverflow: { label: 'Stack Overflow', Icon: StackOverflowIcon },
  npm: { label: 'npm', Icon: NpmIcon },
  huggingface: { label: 'Hugging Face', Icon: HuggingFaceIcon },
  gitlab: { label: 'GitLab', Icon: GitLabIcon },
  codeberg: { label: 'Codeberg', Icon: CodebergIcon },
  hashnode: { label: 'Hashnode', Icon: HashnodeIcon },
  sourcehut: { label: 'SourceHut', Icon: SourceHutIcon },
  devpost: { label: 'Devpost', Icon: DevpostIcon },
}

const numberFormatter = new Intl.NumberFormat('en-US')

function ScoreRing({ score }: { score?: number }) {
  if (score == null) return null
  const pct = Math.max(0, Math.min(100, score))
  return (
    <div
      className="relative w-10 h-10 flex items-center justify-center rounded-full bg-bh-surface/40 border border-bh-border shrink-0"
      data-testid="person-score-ring"
    >
      <svg className="absolute inset-0" viewBox="0 0 40 40" aria-hidden="true">
        <circle cx="20" cy="20" r="16" fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="3" />
        <circle
          cx="20"
          cy="20"
          r="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeDasharray={`${(pct / 100) * 100.5} 100.5`}
          strokeLinecap="round"
          transform="rotate(-90 20 20)"
          className="text-bh-accent"
        />
      </svg>
      <span className="text-[10px] font-bold text-bh-text">{pct}</span>
    </div>
  )
}

function Initials({ name, size = 40 }: { name: string; size?: number }) {
  const parts = name.trim().split(/\s+/).slice(0, 2)
  const text = parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || name.slice(0, 2).toUpperCase()
  return (
    <div
      className="flex items-center justify-center rounded-full bg-bh-surface text-bh-text font-semibold text-sm shrink-0"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {text}
    </div>
  )
}

export function PersonResultCard({ builder }: { builder: PersonCardData }) {
  const meta = SOURCE_META[builder.source] ?? { label: builder.source, Icon: GithubIcon }
  const initial = (builder.displayName ?? builder.username ?? '?').trim()
  return (
    <article
      className="card flex w-full min-w-0 max-w-full items-center gap-3 overflow-hidden p-3 transition-colors hover:border-bh-accent/30"
      data-testid={`person-card-${builder.id}`}
    >
      {builder.avatarUrl ? (
        <img
          src={builder.avatarUrl}
          alt=""
          width={40}
          height={40}
          loading="lazy"
          className="w-10 h-10 rounded-full shrink-0 object-cover bg-bh-surface"
        />
      ) : (
        <Initials name={initial} />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <h3 className="font-semibold text-sm text-bh-text truncate">
            {builder.displayName ?? builder.username}
          </h3>
          <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-bh-text-dim shrink-0">
            <span aria-hidden="true"><meta.Icon className="w-3 h-3" /></span>
            {meta.label}
          </span>
        </div>
        <p className="text-xs text-bh-text-muted line-clamp-1">
          @{builder.username}
          {builder.followersCount != null && ` · ${numberFormatter.format(builder.followersCount)} followers`}
          {builder.language && ` · ${builder.language}`}
        </p>
        {builder.bio && (
          <p className="text-xs text-bh-text-dim line-clamp-1 mt-0.5">{builder.bio}</p>
        )}
      </div>
      <div className="hidden shrink-0 sm:block">
        <ScoreRing score={builder.score} />
      </div>
      <a
        href={builder.profileUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="btn-ghost btn-sm shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
        data-testid={`person-card-link-${builder.id}`}
        data-builder-id={builder.id}
      >
        View
      </a>
    </article>
  )
}
