/**
 * Closed domain contracts for Solutions Intelligence (plan: solutions-intelligence, spec.md
 * "Domain contracts" + docs/superpowers/specs/2026-07-23-solutions-intelligence-design.md
 * "Architecture"). Every persisted or provider-facing shape in this module is a strict Zod
 * schema — `.strict()` everywhere, so an unexpected field (a prompt-injected key, a client
 * trying to widen a constraint) is rejected at the boundary instead of silently passed through.
 *
 * "Unknown is distinct from absent" (spec.md, Brief): a field that was never asked about is
 * `undefined` (optional); a field that WAS asked about but the interpreter/user could not
 * determine is `{ status: 'unknown' }`. Collapsing those two into one `null`/`undefined` would
 * let a composer silently treat "we don't know the budget" the same as "budget wasn't part of
 * this request" — the former should block a `recommended` route on hard-constraint fields, the
 * latter should not.
 */
import { z } from 'zod'

/** Wraps `schema` so a field can be `{status:'known', value}`, `{status:'unknown'}`, or omitted
 * entirely (absent) — see module comment. */
function unknownable<T extends z.ZodTypeAny>(schema: T) {
  return z.discriminatedUnion('status', [
    z.object({ status: z.literal('known'), value: schema }).strict(),
    z.object({ status: z.literal('unknown') }).strict(),
  ])
}

export const RANKING_MODES = ['recommended', 'maximum_quality', 'lower_cost_time'] as const
export type RankingMode = (typeof RANKING_MODES)[number]

export const BRIEF_DOMAINS = [
  'software_and_ai',
  'translation_and_transcription',
  'research_and_data',
  'content_and_design',
  'automation',
  'other',
] as const
export type BriefDomain = (typeof BRIEF_DOMAINS)[number]

export const QUALITY_BARS = ['draft', 'standard', 'high', 'expert'] as const
export type QualityBar = (typeof QUALITY_BARS)[number]

export const DATA_SENSITIVITY_LEVELS = ['public', 'internal', 'confidential', 'restricted'] as const
export type DataSensitivityLevel = (typeof DATA_SENSITIVITY_LEVELS)[number]

export const SUPERVISION_LEVELS = ['autonomous', 'human_reviewed', 'human_in_loop', 'human_only'] as const
export type SupervisionLevel = (typeof SUPERVISION_LEVELS)[number]

/** Spec.md scope explicitly excludes "autonomous action on external systems" in v1 — the
 * composer must never emit a route whose autonomy ceiling exceeds `execute_with_review`, but the
 * brief can still express what the USER would accept, which the composer checks against. */
export const AUTONOMY_CEILINGS = ['read_only', 'draft_only', 'execute_with_review', 'execute_autonomous'] as const
export type AutonomyCeiling = (typeof AUTONOMY_CEILINGS)[number]

const scaleShape = z.object({
  magnitude: z.enum(['one_off', 'small', 'medium', 'large']),
  details: z.string().max(200).optional(),
}).strict()

const budgetShape = z.object({
  minCents: z.number().int().nonnegative().optional(),
  maxCents: z.number().int().nonnegative(),
  currency: z.string().length(3),
}).strict()

const deadlineShape = z.object({
  byDate: z.string().date().optional(),
  relativeDays: z.number().int().positive().optional(),
}).strict()

const privacyShape = z.object({
  sensitivity: z.enum(DATA_SENSITIVITY_LEVELS),
  residencyRegions: z.array(z.string().min(2).max(40)).max(10).optional(),
}).strict()

export const HARD_CONSTRAINT_TYPES = [
  'max_budget',
  'deadline_by',
  'max_data_sensitivity',
  'required_capability',
  'required_integration',
  'excluded_component',
  'disallowed_regulated_domain',
] as const

/** A discriminated union, not `{type: string; value: unknown}` — every constraint kind the
 * composer must be able to mechanically check has its own strict, typed payload. */
export const hardConstraintSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('max_budget'), maxCents: z.number().int().nonnegative(), currency: z.string().length(3) }).strict(),
  z.object({ type: z.literal('deadline_by'), byDate: z.string().date() }).strict(),
  z.object({ type: z.literal('max_data_sensitivity'), level: z.enum(DATA_SENSITIVITY_LEVELS) }).strict(),
  z.object({ type: z.literal('required_capability'), capabilityKey: z.string().min(1).max(80) }).strict(),
  z.object({ type: z.literal('required_integration'), integrationKey: z.string().min(1).max(80) }).strict(),
  z.object({ type: z.literal('excluded_component'), componentId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('disallowed_regulated_domain'), domain: z.string().min(1).max(80) }).strict(),
])
export type HardConstraint = z.infer<typeof hardConstraintSchema>
export type HardConstraintType = (typeof HARD_CONSTRAINT_TYPES)[number]

export const softPreferenceSchema = z.object({
  type: z.enum(['prefer_human', 'prefer_ai', 'prefer_low_cost', 'prefer_fast', 'prefer_high_quality']),
  weight: z.number().min(0).max(1).default(0.5),
}).strict()
export type SoftPreference = z.infer<typeof softPreferenceSchema>

/**
 * `SolutionBrief` — spec.md "Brief": deliverable, capabilities, formats, scale, languages,
 * budget, deadline, quality, privacy/residency, integrations, supervision, autonomy ceiling,
 * hard constraints, soft preferences, and ranking mode.
 */
export const solutionBriefSchema = z.object({
  deliverable: z.object({
    description: z.string().min(1).max(2000),
    domain: z.enum(BRIEF_DOMAINS),
  }).strict(),
  capabilities: z.array(z.string().min(1).max(80)).min(1).max(20),
  inputFormats: z.array(z.string().min(1).max(40)).max(20).default([]),
  outputFormats: z.array(z.string().min(1).max(40)).max(20).default([]),
  scale: unknownable(scaleShape).optional(),
  languages: z.array(z.string().min(2).max(40)).max(20).default([]),
  budget: unknownable(budgetShape).optional(),
  deadline: unknownable(deadlineShape).optional(),
  quality: unknownable(z.enum(QUALITY_BARS)).optional(),
  privacy: unknownable(privacyShape).optional(),
  integrations: z.array(z.string().min(1).max(80)).max(20).default([]),
  supervision: unknownable(z.enum(SUPERVISION_LEVELS)).optional(),
  autonomyCeiling: unknownable(z.enum(AUTONOMY_CEILINGS)).optional(),
  hardConstraints: z.array(hardConstraintSchema).max(30).default([]),
  softPreferences: z.array(softPreferenceSchema).max(10).default([]),
  rankingMode: z.enum(RANKING_MODES).default('recommended'),
}).strict()
export type SolutionBrief = z.infer<typeof solutionBriefSchema>

// --- Catalog (spec.md "Catalog") ---------------------------------------------------------

export const COMPONENT_KINDS = [
  'human_profile',
  'human_role',
  'agent',
  'model',
  'model_endpoint',
  'mcp_server',
  'tool',
  'service',
] as const
export type ComponentKind = (typeof COMPONENT_KINDS)[number]

export const CAPABILITY_EVIDENCE_LEVELS = ['claimed', 'observed', 'verified', 'production_evidence'] as const
export type CapabilityEvidenceLevel = (typeof CAPABILITY_EVIDENCE_LEVELS)[number]

/**
 * The capability vocabulary a brief's requirements and a component's claims are both keyed by.
 *
 * It exists as a typed constant, and not only as rows in `solution_capabilities`, because every adapter
 * maps a vendor's own task label into this vocabulary — and a typo in one of those maps was previously
 * a runtime foreign-key violation on the first ingestion run rather than a compile error. Typing the
 * maps as `Record<string, SolutionCapabilityKey>` moves that mistake to `tsc`.
 *
 * Kept small and deliberately coarse. A vocabulary with a hundred near-synonyms cannot be matched
 * against a brief: two components claiming `translation` and `machine_translation` would look unrelated
 * to the composer, so splitting a capability is a decision that has to be made once, here, rather than
 * by whoever writes the next adapter.
 *
 * Migration 0129 seeds these rows, and a parity test asserts the two never drift.
 */
export const SOLUTION_CAPABILITIES = [
  { key: 'translation', label: 'Translation', description: 'Converts text from one natural language to another.' },
  { key: 'summarization', label: 'Summarization', description: 'Produces a shorter version of a longer text.' },
  { key: 'transcription', label: 'Transcription', description: 'Converts speech audio to text.' },
  { key: 'text_generation', label: 'Text generation', description: 'Produces free-form text from a prompt.' },
  { key: 'embedding', label: 'Embedding', description: 'Maps text or other content to vectors for similarity search.' },
  { key: 'classification', label: 'Classification', description: 'Assigns content to one of a set of labels.' },
  { key: 'entity_extraction', label: 'Entity extraction', description: 'Identifies named entities and spans within text.' },
  { key: 'image_understanding', label: 'Image understanding', description: 'Derives text or structure from an image.' },
  { key: 'document_understanding', label: 'Document understanding', description: 'Extracts structure and answers from documents such as PDFs.' },
  { key: 'web_extraction', label: 'Web extraction', description: 'Retrieves and structures content from web pages.' },
  { key: 'data_transformation', label: 'Data transformation', description: 'Moves and reshapes data between formats or systems.' },
] as const

export type SolutionCapabilityKey = (typeof SOLUTION_CAPABILITIES)[number]['key']

export const SOLUTION_CAPABILITY_KEYS: readonly SolutionCapabilityKey[] =
  SOLUTION_CAPABILITIES.map((capability) => capability.key)

export const componentCapabilityClaimSchema = z.object({
  capabilityKey: z.string().min(1).max(80),
  evidenceLevel: z.enum(CAPABILITY_EVIDENCE_LEVELS),
  evidenceIds: z.array(z.string().min(1)).min(1),
}).strict()
export type ComponentCapabilityClaim = z.infer<typeof componentCapabilityClaimSchema>

// --- Compatibility graph (spec.md "Compatibility") ---------------------------------------

export const COMPATIBILITY_EDGE_TYPES = [
  'can_perform',
  'requires',
  'accepts_output_from',
  'integrates_with',
  'hosted_by',
  'reviewed_by',
  'incompatible_with',
  'substitutes_for',
] as const
export type CompatibilityEdgeType = (typeof COMPATIBILITY_EDGE_TYPES)[number]

export const compatibilityEdgeSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  type: z.enum(COMPATIBILITY_EDGE_TYPES),
  fromComponentId: z.string().min(1),
  toComponentId: z.string().min(1),
  constraints: z.record(z.string(), z.unknown()).optional(),
  evidenceIds: z.array(z.string().min(1)).min(1),
  confidence: z.number().min(0).max(1),
  discoveryMethod: z.enum(['manual_review', 'official_metadata', 'semantic_similarity_reviewed']),
  validFrom: z.string().datetime({ offset: true }),
  validUntil: z.string().datetime({ offset: true }).optional(),
  lastVerifiedAt: z.string().datetime({ offset: true }),
  // Semantic similarity can only ever PROPOSE an edge (spec.md: "Semantic similarity can propose
  // an edge for review but cannot activate it") — an edge discovered this way is never `active`.
  status: z.enum(['proposed', 'active', 'rejected', 'expired']),
}).strict().refine(
  (edge) => !(edge.discoveryMethod === 'semantic_similarity_reviewed' && edge.status === 'active' && edge.confidence >= 1),
  { message: 'A semantic-similarity-discovered edge cannot be auto-activated at full confidence without human review' },
).refine(
  // An invalid graph edge: no compatibility relationship type is meaningful pointing at itself.
  (edge) => edge.fromComponentId !== edge.toComponentId,
  { message: 'A compatibility edge cannot connect a component to itself' },
).refine(
  (edge) => !edge.validUntil || edge.validUntil > edge.validFrom,
  { message: 'validUntil must be after validFrom' },
)
export type CompatibilityEdge = z.infer<typeof compatibilityEdgeSchema>

// --- Solution run (spec.md "Solution run") ------------------------------------------------

export const ROUTE_TYPES = ['human', 'ai', 'hybrid'] as const
export type RouteType = (typeof ROUTE_TYPES)[number]

export const sourceStatusSchema = z.object({
  sourceKey: z.string().min(1).max(80),
  status: z.enum(['ok', 'degraded', 'unavailable']),
  checkedAt: z.string().datetime({ offset: true }),
  detail: z.string().max(300).optional(),
}).strict()
export type SourceStatus = z.infer<typeof sourceStatusSchema>

export const estimateSchema = z.object({
  costMinCents: z.number().int().nonnegative(),
  costMaxCents: z.number().int().nonnegative(),
  currency: z.string().length(3),
  timeMinHours: z.number().nonnegative(),
  timeMaxHours: z.number().nonnegative(),
  assumptions: z.array(z.string().min(1).max(300)).max(10).default([]),
}).strict().refine((e) => e.costMinCents <= e.costMaxCents && e.timeMinHours <= e.timeMaxHours, {
  message: 'Estimate min must not exceed max',
})
export type Estimate = z.infer<typeof estimateSchema>

/**
 * Synchronous, shape-only safety check for a link surfaced to the user ("links to inspect or
 * contact the recommended components" — design doc). This is NOT the full SSRF-safe check —
 * that requires an async DNS lookup and belongs in the actual fetcher
 * (`security/url-policy.ts`'s `validateExternalHttpUrl`, reused when Phase 4/5 code fetches a
 * component's page). This schema-level check only rejects shapes that could never be safe
 * regardless of DNS resolution: non-https, embedded credentials, or a literal
 * localhost/private-looking hostname.
 */
const safeOutboundUrlSchema = z.string().url().superRefine((value, ctx) => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid URL' })
    return
  }
  if (url.protocol !== 'https:') {
    ctx.addIssue({ code: 'custom', message: 'Outbound link must use HTTPS' })
  }
  if (url.username || url.password) {
    ctx.addIssue({ code: 'custom', message: 'Outbound link cannot embed credentials' })
  }
  const hostname = url.hostname.toLowerCase()
  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname === '0.0.0.0'
    || /^(127\.|10\.|192\.168\.|169\.254\.)/.test(hostname)
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
  ) {
    ctx.addIssue({ code: 'custom', message: 'Outbound link cannot target a private network' })
  }
})

/** One assigned component within a route graph, with the role it plays and which brief
 * capabilities it's covering evidence for. */
export const routeComponentAssignmentSchema = z.object({
  componentId: z.string().min(1),
  componentVersion: z.number().int().positive(),
  role: z.string().min(1).max(120),
  coveredCapabilityKeys: z.array(z.string().min(1).max(80)).min(1),
  link: safeOutboundUrlSchema.optional(),
}).strict()
export type RouteComponentAssignment = z.infer<typeof routeComponentAssignmentSchema>

/** A route cannot be `recommended` unless `mandatoryCapabilitiesCovered` is true for every
 * capability in the brief, OR the gap is explicitly delegated to a named `humanReviewPoints`
 * entry (spec.md: "A route cannot be `recommended` unless every mandatory requirement is
 * covered or explicitly delegated to an identified human review step"). */
export const solutionRouteSchema = z.object({
  routeType: z.enum(ROUTE_TYPES),
  status: z.enum(['recommended', 'available', 'unavailable']),
  unavailableReason: z.string().max(300).optional(),
  summary: z.string().min(1).max(600),
  fitExplanation: z.string().min(1).max(2000),
  steps: z.array(z.string().min(1).max(300)).min(1).max(30),
  components: z.array(routeComponentAssignmentSchema).min(1),
  mandatoryCapabilitiesCovered: z.boolean(),
  coverageGapCapabilityKeys: z.array(z.string().min(1).max(80)).default([]),
  limitations: z.array(z.string().min(1).max(300)).default([]),
  // Optional only for an `unavailable` route — a route that isn't offered has no meaningful
  // cost/time to estimate. Enforced below: required for `recommended`/`available`.
  estimate: estimateSchema.optional(),
  risks: z.array(z.string().min(1).max(300)).default([]),
  humanReviewPoints: z.array(z.string().min(1).max(300)).default([]),
  evidenceIds: z.array(z.string().min(1)).min(1),
}).strict().refine(
  (route) => route.status !== 'unavailable' || Boolean(route.unavailableReason),
  { message: 'An unavailable route must state a reason' },
).refine(
  (route) => route.status !== 'recommended' || route.mandatoryCapabilitiesCovered || route.humanReviewPoints.length > 0,
  { message: 'A recommended route must cover every mandatory capability or delegate the gap to a human review point' },
).refine(
  (route) => route.status === 'unavailable' || Boolean(route.estimate),
  { message: 'A recommended or available route must include a cost/time estimate' },
)
export type SolutionRoute = z.infer<typeof solutionRouteSchema>

export const solutionRunSchema = z.object({
  briefId: z.string().min(1),
  rankingMode: z.enum(RANKING_MODES),
  retrievalQueryHash: z.string().min(1),
  componentVersionIds: z.array(z.string().min(1)).default([]),
  evidenceIds: z.array(z.string().min(1)).default([]),
  routes: z.array(solutionRouteSchema).max(3),
  modelVersion: z.string().min(1),
  promptVersion: z.string().min(1),
  sourceStatuses: z.array(sourceStatusSchema).default([]),
  creditReservationId: z.string().min(1).optional(),
  creditSettlementId: z.string().min(1).optional(),
  warnings: z.array(z.string().min(1).max(300)).default([]),
}).strict()
export type SolutionRun = z.infer<typeof solutionRunSchema>

export const solutionFeedbackSchema = z.object({
  runId: z.string().min(1),
  routeType: z.enum(ROUTE_TYPES),
  chosen: z.boolean(),
  reason: z.string().max(500).optional(),
}).strict()
export type SolutionFeedback = z.infer<typeof solutionFeedbackSchema>
