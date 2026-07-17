/**
 * Status page aggregator. Pure functions, testable.
 */

export type ComponentStatus = 'operational' | 'degraded' | 'outage'

export interface ComponentCheck {
  name: string
  status: ComponentStatus
  message?: string
}

export interface SystemStatus {
  status: ComponentStatus
  components: ComponentCheck[]
  lastUpdated: string
}

export function aggregateStatus(components: ComponentCheck[]): SystemStatus {
  const worst = components.reduce<ComponentStatus>((acc, c) => {
    if (c.status === 'outage') return 'outage'
    if (c.status === 'degraded' && acc !== 'outage') return 'degraded'
    return acc
  }, 'operational')
  return {
    status: worst,
    components,
    lastUpdated: new Date().toISOString(),
  }
}

export interface Incident {
  id: string
  title: string
  description: string | null
  status: 'investigating' | 'identified' | 'monitoring' | 'resolved'
  severity: 'minor' | 'major' | 'critical'
  affectedComponents: string[]
  startedAt: string
  resolvedAt: string | null
  durationMinutes: number | null
}

export function computeDuration(startedAt: string, resolvedAt: string | null): number | null {
  if (!resolvedAt) return null
  return Math.round((new Date(resolvedAt).getTime() - new Date(startedAt).getTime()) / 60000)
}

export function formatDuration(minutes: number | null): string {
  if (minutes == null) return '—'
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}
