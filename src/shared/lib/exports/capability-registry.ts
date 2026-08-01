/**
 * The single source of truth for what the Export Center actually does (plans/UI/tasks.md Wave 6
 * "Build a scoped Export Center and reconcile public claims"). Marketing copy (Home, FAQ, the
 * `SoftwareApplication` JSON-LD in `__root.tsx`) must never name a scope or format that isn't listed
 * here — a copy-contract test asserts that directly, so a future edit that adds a promise without
 * adding the capability (or removes a capability without touching the copy) fails CI instead of
 * shipping a false claim.
 */

export const EXPORT_SCOPES = ['all', 'list', 'saved-search', 'notes'] as const
export type ExportScope = (typeof EXPORT_SCOPES)[number]

export const EXPORT_FORMATS = ['csv', 'json'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

export interface ExportScopeDefinition {
  scope: ExportScope
  /** How this scope is described in product copy — the exact noun phrase the copy-contract test
   * looks for (e.g. "shortlist", "saved search", "note collection"). */
  label: string
  /** Whether this scope needs an id (a specific list or saved query) beyond the caller's own org. */
  requiresId: boolean
}

export const EXPORT_SCOPE_DEFINITIONS: Readonly<Record<ExportScope, ExportScopeDefinition>> = {
  all: { scope: 'all', label: 'all tracked builders', requiresId: false },
  list: { scope: 'list', label: 'shortlist', requiresId: true },
  'saved-search': { scope: 'saved-search', label: 'saved search', requiresId: true },
  notes: { scope: 'notes', label: 'note collection', requiresId: false },
}

/** Every `${scope}:${format}` pair the API + UI actually support today. */
export const IMPLEMENTED_EXPORT_PAIRS: ReadonlySet<string> = new Set(
  EXPORT_SCOPES.flatMap((scope) => EXPORT_FORMATS.map((format) => `${scope}:${format}`)),
)

export function isExportPairImplemented(scope: string, format: string): boolean {
  return IMPLEMENTED_EXPORT_PAIRS.has(`${scope}:${format}`)
}

export function isExportScope(value: string): value is ExportScope {
  return (EXPORT_SCOPES as readonly string[]).includes(value)
}

export function isExportFormat(value: string): value is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(value)
}

/** Rows are truncated (never rejected) past this bound — "bounded generation" per the task's own
 * wording, not an unbounded per-org dump. */
export const MAX_EXPORT_ROWS = 2000
