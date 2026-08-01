import { BadgeCheck, ExternalLink, Sparkles, Star, UserCircle, Wand2 } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import type { PublicPortfolio as PublicPortfolioData } from '~/shared/lib/portfolio'
import { PortfolioTimelineSlot } from './PortfolioTimelineSlot'

interface PublicPortfolioProps {
  portfolio: PublicPortfolioData | null
  /** Only set when the builder identity behind this claim also has a published aggregate profile
   * — an unpublished/suppressed/missing target renders no link, not a dead one. */
  builderId?: string | null
  /** True only when the viewer's own session is this claim's subject — never derived client-side. */
  isOwner?: boolean
}

/** No contact form, no AI-impersonation widget — this is a static, verified, owner-curated page. Anything the owner didn't opt into simply isn't rendered (no "coming soon" placeholders). */
export function PublicPortfolio({ portfolio, builderId = null, isOwner = false }: PublicPortfolioProps) {
  if (!portfolio) {
    return (
      <div className="p-8 max-w-2xl mx-auto text-center py-24" data-testid="portfolio-not-found">
        <p className="text-bh-text-muted">This portfolio isn't available.</p>
      </div>
    )
  }

  const name = portfolio.displayName ?? portfolio.username

  return (
    <div className="p-8 max-w-3xl mx-auto" data-testid="public-portfolio" data-theme={portfolio.theme}>
      <header className="card rounded-3xl p-8 mb-6 text-center">
        {portfolio.avatarUrl && (
          <img
            src={portfolio.avatarUrl}
            alt=""
            className="w-20 h-20 rounded-full mx-auto mb-4 border border-bh-border"
          />
        )}
        <h1 className="text-2xl font-bold text-bh-text flex items-center justify-center gap-2">
          {name}
          <span title="Verified — proved control of this account" aria-label="Verified">
            <BadgeCheck className="w-5 h-5 text-bh-accent" aria-hidden="true" />
          </span>
        </h1>
        <p className="text-sm text-bh-text-dim mt-1">@{portfolio.username} · {portfolio.source}</p>
        {portfolio.headline && (
          <p className="text-lg text-bh-text mt-4 font-medium">{portfolio.headline}</p>
        )}
        {portfolio.introduction && (
          <p className="text-bh-text-muted mt-3 leading-relaxed whitespace-pre-line">{portfolio.introduction}</p>
        )}
        <div className="flex items-center justify-center gap-2 mt-5 flex-wrap">
          <a
            href={portfolio.profileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary btn-sm inline-flex items-center gap-1.5"
          >
            View on {portfolio.source} <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
          </a>
          {builderId && (
            <Link
              to="/builders/$builderId"
              params={{ builderId }}
              className="btn-secondary btn-sm inline-flex items-center gap-1.5"
              data-testid="portfolio-builder-profile-link"
            >
              <UserCircle className="w-3.5 h-3.5" aria-hidden="true" />
              Full builder profile
            </Link>
          )}
        </div>
        {isOwner && (
          <p className="text-xs text-bh-text-dim mt-3">
            <Link to="/me" className="inline-flex items-center gap-1 text-bh-accent hover:underline" data-testid="portfolio-manage-link">
              <Sparkles className="w-3 h-3" aria-hidden="true" />
              Manage this portfolio in your Account
            </Link>
          </p>
        )}
      </header>

      {/* Opt-in AI persona (plans/UI/tasks.md Wave 7 "Add opt-in AI persona to public
          portfolios") — only ever the read-only, already-computed artifact the owner opted into
          showing; this page never invokes AI itself. Deliberately renders only summary, focus,
          strengths, and provenance — narrower than the full persona shape the route allows for,
          on purpose. */}
      {portfolio.aiPersona && (
        <section className="card rounded-3xl p-6 mb-6" aria-labelledby="portfolio-ai-persona-heading" data-testid="portfolio-ai-persona">
          <h2 id="portfolio-ai-persona-heading" className="text-sm font-semibold uppercase tracking-wider text-bh-text-dim mb-3 flex items-center gap-2">
            <Wand2 className="w-4 h-4 text-bh-accent" aria-hidden="true" />
            AI-summarized profile
          </h2>
          <p className="text-bh-text leading-relaxed">{portfolio.aiPersona.summary}</p>
          <p className="text-sm text-bh-text-muted mt-3">
            <span className="font-medium text-bh-text">Focus:</span> {portfolio.aiPersona.primaryFocus}
          </p>
          {portfolio.aiPersona.strengths.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-3">
              {portfolio.aiPersona.strengths.map((strength) => (
                <span key={strength} className="badge">{strength}</span>
              ))}
            </div>
          )}
          <p className="text-xs text-bh-text-dim mt-4">
            Generated by {portfolio.aiPersona.model} on {new Date(portfolio.aiPersona.enrichedAt).toLocaleDateString()} — an AI summary, not the owner's own words.
          </p>
        </section>
      )}

      <PortfolioTimelineSlot events={portfolio.timeline} isOwner={isOwner} />

      {portfolio.projects.length > 0 && (
        <section aria-labelledby="portfolio-projects-heading">
          <h2 id="portfolio-projects-heading" className="text-sm font-semibold uppercase tracking-wider text-bh-text-dim mb-3">
            Selected projects
          </h2>
          <ul className="space-y-3" role="list">
            {portfolio.projects.map((project) => (
              <li key={project.id}>
                <a
                  href={project.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="card card-hover p-4 flex items-center justify-between gap-3 block"
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-bh-text truncate">{project.name}</p>
                    {project.description && (
                      <p className="text-sm text-bh-text-muted truncate mt-0.5">{project.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0 text-xs text-bh-text-dim">
                    {project.language && <span>{project.language}</span>}
                    <span className="flex items-center gap-1">
                      <Star className="w-3.5 h-3.5" aria-hidden="true" /> {project.stars}
                    </span>
                  </div>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
