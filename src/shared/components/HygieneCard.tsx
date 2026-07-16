import * as React from 'react'
import { Check, X, Activity, GitPullRequest, FileText, Zap } from 'lucide-react'
import { computeHygiene, estimateRepoSignalsFromBuilder, hygieneGrade, type ProjectHygiene } from '~/shared/lib/hygiene'

interface HygieneCardProps {
  builder: {
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

export function HygieneCard({ builder }: HygieneCardProps) {
  const repos = React.useMemo(() => estimateRepoSignalsFromBuilder(builder), [builder])
  const hygiene: ProjectHygiene = React.useMemo(() => computeHygiene(repos), [repos])
  const grade = hygieneGrade(hygiene.globalScore)

  return (
    <div className="card p-5" data-testid="hygiene-card">
      <div className="flex items-start gap-4">
        <ScoreRing score={hygiene.globalScore} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-base font-semibold">Project hygiene</h3>
            <span className={`text-[10px] uppercase tracking-wider font-bold ${grade.color}`}>
              {grade.label}
            </span>
          </div>
          <p className="text-xs text-bh-text-dim">
            Estimated from {repos.length} {repos.length === 1 ? 'repo' : 'repos'}. Real GitHub
            scans would refine this; v1 uses heuristics.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 mt-4">
        <Metric
          icon={Activity}
          label="Issue close rate"
          value={`${hygiene.issueCloseRate}%`}
        />
        <Metric
          icon={GitPullRequest}
          label="Avg resolution"
          value={
            hygiene.averageResolutionDays > 0
              ? `${hygiene.averageResolutionDays} days`
              : '—'
          }
        />
        <Metric
          icon={FileText}
          label="Documentation"
          value={`${hygiene.documentationScore}%`}
        />
        <Metric
          icon={Zap}
          label="CI/CD"
          value={hygiene.hasCICD ? 'Active' : 'Not detected'}
          ok={hygiene.hasCICD}
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
