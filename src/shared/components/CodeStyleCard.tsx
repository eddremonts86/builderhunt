import * as React from 'react'
import { Braces, FlaskConical, FileText, GitBranch, TextCursorInput } from 'lucide-react'
import { generateFingerprint, type CodeStyleFingerprint } from '~/shared/lib/code-style'

interface CodeStyleCardProps {
  builder: {
    language?: string | null
    topics?: string[]
    followersCount?: number
    metadata?: Record<string, unknown>
  }
}

const PARADIGM_LABEL: Record<CodeStyleFingerprint['paradigm'], string> = {
  functional: 'Functional',
  oop: 'Object-oriented',
  pragmatic: 'Pragmatic',
}

function MetricBar({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Braces
  label: string
  value: number
}) {
  return (
    <div data-testid="code-style-metric">
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="flex items-center gap-1.5 text-bh-text-dim uppercase tracking-wider text-[10px]">
          <Icon className="w-3 h-3" aria-hidden="true" />
          {label}
        </span>
        <span className="font-semibold text-bh-text">{value}</span>
      </div>
      <div className="h-1.5 rounded-full bg-bh-bg-alt overflow-hidden">
        <div
          className="h-full rounded-full bg-bh-accent"
          style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
        />
      </div>
    </div>
  )
}

export function CodeStyleCard({ builder }: CodeStyleCardProps) {
  const fingerprint = React.useMemo(() => generateFingerprint(builder), [builder])

  return (
    <div className="card p-5" data-testid="code-style-card">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-base font-semibold text-bh-text">Code-style profile</h3>
        <span className="badge badge-neutral" data-testid="code-style-paradigm">
          {PARADIGM_LABEL[fingerprint.paradigm]}
        </span>
      </div>
      <p className="text-xs text-bh-text-dim mb-4">
        Estimated from language and topic signals. v1 uses heuristics; real profiling would
        analyze actual source files.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <MetricBar icon={Braces} label="Modularity" value={fingerprint.modularityScore} />
        <MetricBar icon={FlaskConical} label="Test intensity" value={fingerprint.testIntensity} />
        <MetricBar icon={FileText} label="Documentation" value={fingerprint.documentationRatio} />
        <MetricBar icon={GitBranch} label="Complexity control" value={fingerprint.complexityControl} />
        <MetricBar icon={TextCursorInput} label="Naming consistency" value={fingerprint.namingConsistency} />
      </div>
    </div>
  )
}
