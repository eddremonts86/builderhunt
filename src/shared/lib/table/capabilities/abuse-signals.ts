import { abuseSignals } from '~/shared/lib/db/schema'

import { defineTableCapability, registerTableCapability } from '../capability'

/**
 * The platform-admin abuse feed.
 *
 * No `organizationColumn`, and that is not an oversight: `abuse_signals` records cross-tenant
 * behaviour — impossible travel, linked accounts, signup velocity — and the console's entire job is
 * to see across organizations. A tenant predicate here would filter the console down to whichever
 * workspace the admin happens to be in, which is the opposite of what it is for. It is reached
 * through `platformTablePageHandler`, which authorizes with `requirePlatformAdminPrincipal`.
 *
 * Signals are append-only, so newest-first is the natural default and there is nothing to select.
 */
export const ABUSE_SIGNALS_TABLE = 'abuse_signals'

export const abuseSignalsCapability = registerTableCapability(defineTableCapability({
  table: ABUSE_SIGNALS_TABLE,
  sortable: {
    // Backed by `abuse_signals_created_id_idx`.
    createdAt: { column: abuseSignals.createdAt },
    // Backed by `abuse_signals_type_created_id_idx`.
    type: { column: abuseSignals.type },
  },
  filterable: {
    type: { column: abuseSignals.type, facet: true },
    severity: { column: abuseSignals.severity, facet: true },
  },
  groupable: ['type'],
  searchable: [abuseSignals.requestId],
  tiebreaker: abuseSignals.id,
  defaultSort: [{ id: 'createdAt', dir: 'desc' }],
}))

export const ABUSE_SIGNAL_FILTER_LABELS: Record<string, string> = {
  type: 'Type',
  severity: 'Severity',
}
