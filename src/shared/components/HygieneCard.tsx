// table-surface-ok: a fixed summary of one profile's hygiene checks, not a queried collection.
import * as React from 'react'
import { Check, X, Activity, GitPullRequest, FileText, Zap } from 'lucide-react'
import {
  computeHygiene,
  estimateRepoSignalsFromBuilder,
  hygieneGrade,
  projectHygieneEnvelopeSchema,
  type ProjectHygiene,
  type RepoSignals,
} from '~/shared/lib/hygiene'

interface HygieneCardProps {
  builderId?: string
  source?: string
  builder: {
    username?: string
    followersCount?: number
    topics?: string[]
    language?: string | null
    metadata?: Record<string, unknown>
  }
}

function ScoreRing({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, score))
  const grade = hygieneGrade(score)
  return (
    <div className="relative w-20 h-20 flex items-center justify-center" data-testid="hygiene-score-ring">
      <svg className="absolute inset-0" viewBox="0 0 80 80">
        <circle cx="40" cy="40" r="32" fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="6" />
        <circle
          cx="40"
          cy="40"
          r="32"
          fill="none"
          stroke="currentColor"
          strokeWidth="6"
          strokeDasharray={`${(pct / 100) * 201} 201`}
          strokeLinecap="round"
          transform="rotate(-90 40 40)"
          className={grade.color}
        />
      </svg>
      <div className="text-center">
        <div className="text-2xl font-bold text-bh-text">{pct}</div>
        <div className="text-[10px] uppercase tracking-wider text-bh-text-dim">/ 100</div>
      </div>
    </div>
  )
}

function formatRelativeDate(iso: string): string {
  const ms = Date.parse(iso)
  if (isNaN(ms)) return 'recently'
  const diff = Date.now() - ms
  const day = 24 * 60 * 60 * 1000
  if (diff < day) return 'today'
  if (diff < 30 * day) return `${Math.max(1, Math.floor(diff / day))}d ago`
  return `${Math.floor(diff / (30 * day))}mo ago`
}

/** Fetches the real hygiene envelope for GitHub builders; `null` while
 * loading, `'estimated'` for non-GitHub / no-data / error (fall back to the
 * heuristic), or the parsed envelope on success. */
function useRealHygiene(builderId: string | undefined, isGitHub: boolean) {
  const [state, setState] = React.useState<'loading' | 'estimated' | { signals: RepoSignals[]; hygiene: ProjectHygiene; computedAt: string }>(
    isGitHub && builderId ? 'loading' : 'estimated',
  )

  React.useEffect(() => {
    if (!isGitHub || !builderId) {
      setState('estimated')
      return
    }
    let cancelled = false
    fetch(`/api/builders/${encodeURIComponent(builderId)}/hygiene`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: unknown) => {
        if (cancelled) return
        if (!data || (data as { estimated?: boolean }).estimated) {
          setState('estimated')
          return
        }
        const parsed = projectHygieneEnvelopeSchema.safeParse(data)
        if (!parsed.success) {
          setState('estimated')
          return
        }
        setState({ signals: parsed.data.signals, hygiene: parsed.data.hygiene, computedAt: parsed.data.computedAt })
      })
      .catch(() => {
        if (!cancelled) setState('estimated')
      })
    return () => {
      cancelled = true
    }
  }, [builderId, isGitHub])

  return state
}

export function HygieneCard({ builderId, source, builder }: HygieneCardProps) {
  const isGitHub = source === 'github'
  const real = useRealHygiene(builderId, isGitHub)
  const loading = real === 'loading'

  const estimatedRepos = React.useMemo(() => estimateRepoSignalsFromBuilder(builder), [builder])
  const repos = typeof real === 'object' ? real.signals : estimatedRepos
  const hygiene: ProjectHygiene = React.useMemo(
    () => (typeof real === 'object' ? real.hygiene : computeHygiene(estimatedRepos)),
    [real, estimatedRepos],
  )
  const grade = hygieneGrade(hygiene.globalScore)

  return (
    <div className="card p-5" data-testid="hygiene-card">
      <div className="flex items-start gap-4">
        <ScoreRing score={loading ? 0 : hygiene.globalScore} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-base font-semibold">Project hygiene</h3>
            {!loading && (
              <span className={`text-[10px] uppercase tracking-wider font-bold ${grade.color}`}>
                {grade.label}
              </span>
            )}
          </div>
          <p className="text-xs text-bh-text-dim">
            {loading ? (
              'Loading real GitHub data…'
            ) : typeof real === 'object' ? (
              <>From {real.signals.length} public repos · {formatRelativeDate(real.computedAt)}</>
            ) : (
              'Estimated from profile signals — not real repo data'
            )}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 mt-4">
        <Metric
          icon={Activity}
          label="Issue close rate"
          value={loading ? '—' : `${hygiene.issueCloseRate}%`}
        />
        <Metric
          icon={GitPullRequest}
          label="Avg resolution"
          value={
            loading
              ? '—'
              : hygiene.averageResolutionDays > 0
                ? `${hygiene.averageResolutionDays} days`
                : '—'
          }
        />
        <Metric
          icon={FileText}
          label="Documentation"
          value={loading ? '—' : `${hygiene.documentationScore}%`}
        />
        <Metric
          icon={Zap}
          label="CI/CD"
          value={loading ? '—' : hygiene.hasCICD ? 'Active' : 'Not detected'}
          ok={loading ? undefined : hygiene.hasCICD}
        />
      </div>

      <ul className="mt-4 space-y-1 text-xs text-bh-text-muted">
        <li className="flex items-center gap-1.5">
          {hygiene.issueCloseRate >= 70 ? (
            <Check className="w-3 h-3 text-bh-success" />
          ) : (
            <X className="w-3 h-3 text-bh-text-dim" />
          )}
          Resolves issues promptly
        </li>
        <li className="flex items-center gap-1.5">
          {hygiene.documentationScore >= 60 ? (
            <Check className="w-3 h-3 text-bh-success" />
          ) : (
            <X className="w-3 h-3 text-bh-text-dim" />
          )}
          README + Contributing + License
        </li>
        <li className="flex items-center gap-1.5">
          {hygiene.hasCICD ? (
            <Check className="w-3 h-3 text-bh-success" />
          ) : (
            <X className="w-3 h-3 text-bh-text-dim" />
          )}
          Has automated CI/CD
        </li>
      </ul>

      {typeof real === 'object' && real.signals.length > 0 && (
        <div className="mt-4 border-t border-bh-border/40 pt-3">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-bh-text-dim uppercase tracking-wider text-[10px]">
                <th className="text-left font-medium pb-1">Repo</th>
                <th className="text-right font-medium pb-1">Close rate</th>
                <th className="text-center font-medium pb-1">Docs</th>
                <th className="text-center font-medium pb-1">CI</th>
              </tr>
            </thead>
            <tbody>
              {repos.map((r) => {
                const total = r.openIssues + r.closedIssues
                const closeRate = total === 0 ? null : Math.round((r.closedIssues / total) * 100)
                const hasDocs = r.hasReadme && r.hasContributing && r.hasLicense
                return (
                  <tr key={r.name} className="text-bh-text-muted">
                    <td className="py-1 truncate max-w-[120px]" title={r.name}>{r.name}</td>
                    <td className="text-right">{closeRate === null ? '—' : `${closeRate}%`}</td>
                    <td className="text-center">
                      {hasDocs ? <Check className="w-3 h-3 text-bh-success inline" /> : <X className="w-3 h-3 text-bh-text-dim inline" />}
                    </td>
                    <td className="text-center">
                      {r.hasWorkflows ? <Check className="w-3 h-3 text-bh-success inline" /> : <X className="w-3 h-3 text-bh-text-dim inline" />}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Metric({
  icon: Icon,
  label,
  value,
  ok,
}: {
  icon: typeof Activity
  label: string
  value: string
  ok?: boolean
}) {
  return (
    <div className="bg-bh-bg-alt/40 rounded-lg p-2 border border-bh-border/40">
      <div className="flex items-center gap-1 text-[10px] text-bh-text-dim uppercase tracking-wider">
        <Icon className="w-2.5 h-2.5" aria-hidden="true" />
        {label}
      </div>
      <div className={`text-sm font-semibold mt-0.5 ${ok === false ? 'text-bh-text-dim' : 'text-bh-text'}`}>
        {value}
      </div>
    </div>
  )
}
