import type { TenantTransaction } from '~/shared/lib/db/client'
import {
  getTrackedBuilderIds as getOrganizationTrackedBuilderIds,
  getTrackedKeySet as getOrganizationTrackedKeySet,
  trackedKey,
} from '~/shared/lib/repositories/organization-builders'

export { trackedKey }

export function getTrackedKeySet(transaction: TenantTransaction, organizationId: string) {
  return getOrganizationTrackedKeySet(transaction, organizationId)
}

export function getTrackedBuilderIds(transaction: TenantTransaction, organizationId: string) {
  return getOrganizationTrackedBuilderIds(transaction, organizationId)
}
