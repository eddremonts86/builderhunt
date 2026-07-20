import type { ShadowMismatchMetric } from './shadow-read'

export function recordMigrationMismatch(metric: ShadowMismatchMetric) {
  console.warn(JSON.stringify({ event: 'tenant_shadow_mismatch', ...metric }))
}
