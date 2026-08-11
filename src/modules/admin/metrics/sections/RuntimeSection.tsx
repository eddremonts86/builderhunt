import * as React from 'react'
import { Cpu } from 'lucide-react'
import { MetricSectionView } from '../MetricSectionView'
import type { SectionWidgetProps } from '../MetricSectionView'

/**
 * Runtime, demoted (plan 57, Admin track — "Demote Runtime diagnostics and add Data Freshness").
 *
 * ## What "demoted" means here, concretely
 *
 * Node version, platform and heap sizes answer "is this process unhealthy" — a real question, but not the one
 * an operator opens a metrics page to ask. They used to sit on the front of the page holding two values the
 * counters above them depended on (uptime and pid), so a reader had to scroll past three sections to find out
 * whether "API requests: 0" meant a quiet hour or a restart four minutes ago.
 *
 * Now: the counters carry their own process identity inline (the contract requires it), this whole section is
 * one tab an operator has to choose, and the diagnostics are behind a disclosure inside it. Nothing was
 * deleted — the numbers are still exactly one click away for the case where they matter.
 *
 * ## Why Data Freshness is a variant of this section and not its own
 *
 * Both answer questions about the *instrumentation* rather than the product: "is this process healthy" and "is
 * what I am reading current". They belong side by side, and making freshness a ninth section would have meant
 * a contract change for a panel with four values.
 */
export function RuntimeSection({ state, variant }: SectionWidgetProps) {
  const title = variant === 'freshness' ? 'Data freshness' : 'This process, since it started'
  return (
    <MetricSectionView state={state} title={title}>
      {variant === 'freshness' ? <FreshnessNote /> : <RuntimeDiagnostics />}
    </MetricSectionView>
  )
}

function FreshnessNote() {
  return (
    <p className="text-xs text-bh-text-dim mt-4" data-testid="metrics-freshness-note">
      Metric lag is how far behind the newest stored minute is. The flush runs every 30 seconds and deliberately
      holds the minute in progress back, so roughly 90 seconds is normal; sustained minutes mean the flush has
      stopped and every other number on this page is older than it looks. Zero instances reporting is the state
      that otherwise looks exactly like no traffic.
    </p>
  )
}

interface ServerDiagnostics {
  nodeVersion: string
  platform: string
  pid: number
  memoryUsage: { rss: number; heapTotal: number; heapUsed: number; external: number }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * The diagnostics, behind a disclosure.
 *
 * Collapsed by default rather than removed: heap growth across refreshes is the only signal for a leak, and an
 * operator who needs it needs it badly. Putting it behind one click is the demotion — the numbers above are
 * what the page is for.
 */
function RuntimeDiagnostics() {
  const [server, setServer] = React.useState<ServerDiagnostics | null>(null)

  React.useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch('/api/admin/metrics', { credentials: 'include', signal: controller.signal })
        if (!response.ok) return
        setServer((await response.json()).server ?? null)
      } catch {
        // Left null: the disclosure simply says the diagnostics could not be read, rather than showing zeroes
        // for a heap that was never measured.
      }
    })()
    return () => controller.abort()
  }, [])

  return (
    <details className="mt-4" data-testid="metrics-server-diagnostics">
      <summary className="text-sm text-bh-text-muted cursor-pointer flex items-center gap-2">
        <Cpu className="w-4 h-4 text-bh-accent" aria-hidden="true" />
        Process diagnostics
      </summary>
      {server ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm mt-3">
          <div>
            <p className="text-bh-text-dim text-xs">Node</p>
            <p className="font-mono text-xs">{server.nodeVersion}</p>
          </div>
          <div>
            <p className="text-bh-text-dim text-xs">Platform</p>
            <p className="font-mono text-xs">{server.platform}</p>
          </div>
          <div>
            <p className="text-bh-text-dim text-xs">RSS</p>
            <p className="font-mono text-xs">{formatBytes(server.memoryUsage.rss)}</p>
          </div>
          <div>
            <p className="text-bh-text-dim text-xs">Heap total</p>
            <p className="font-mono text-xs">{formatBytes(server.memoryUsage.heapTotal)}</p>
          </div>
          <div>
            <p className="text-bh-text-dim text-xs">Heap used</p>
            <p className="font-mono text-xs">{formatBytes(server.memoryUsage.heapUsed)}</p>
          </div>
          <div>
            <p className="text-bh-text-dim text-xs">External</p>
            <p className="font-mono text-xs">{formatBytes(server.memoryUsage.external)}</p>
          </div>
        </div>
      ) : (
        <p className="text-sm text-bh-text-muted mt-3">Diagnostics could not be read.</p>
      )}
    </details>
  )
}

export default RuntimeSection
