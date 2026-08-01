/**
 * The two provider-facing shapes in Solutions: what an interpretation may return, and what an explanation may
 * return (plan 43 Phase 7).
 *
 * Pure zod, no I/O — `ai/tasks.ts` is imported client-side and this module has to stay importable from there.
 *
 * ## Why these are not the domain contracts
 *
 * A `SolutionBrief` distinguishes "unknown" from "absent" through a discriminated union
 * (`{status:'known',value}` / `{status:'unknown'}`), and a `SolutionRoute` carries statuses, estimates, and
 * evidence ids. None of that should be a model's decision. So the model is asked for a *flat* shape plus an
 * explicit `unknownFields` list, and the mapping into the domain contract happens in code
 * (`src/lib/solutions/ai/interpret.ts`). "Deterministic unknown handling" means exactly that: the model reports
 * what it could not determine, and the union is constructed from that report rather than emitted by the model.
 *
 * ## Why every extracted constraint carries a quote
 *
 * A hard constraint changes which routes are offerable at all — `max_budget` can make every route unavailable.
 * A model that invented one would silently narrow a user's options, and a model that widened one ("they said
 * €5,000, that probably means up to €8,000") would produce a recommendation the user's actual budget cannot
 * buy. `sourceQuote` makes the claim checkable: `interpret.ts` drops any constraint whose quote is not literally
 * present in the brief the user typed. The model cannot fake groundedness it does not have, because the check
 * is a substring test against the input, not a judgement.
 */
import { z } from 'zod'
import {
  AUTONOMY_CEILINGS,
  BRIEF_DOMAINS,
  DATA_SENSITIVITY_LEVELS,
  QUALITY_BARS,
  RANKING_MODES,
  SUPERVISION_LEVELS,
} from './contracts'

/** Long enough for a real brief, short enough to bound the prompt. Beyond this, interpretation is refused
 * rather than truncated: dropping the tail of a brief silently discards the constraints users put at the end. */
export const MAX_BRIEF_TEXT_LENGTH = 6000

/** A quote must be long enough to be checkable. A three-character "EUR" appears in half of all briefs. */
const sourceQuoteSchema = z.string().min(8).max(300)

/**
 * The constraint kinds an interpretation may propose.
 *
 * Deliberately a subset of `HARD_CONSTRAINT_TYPES`: `excluded_component` names an internal component id a user
 * never typed and a model must never guess, and `disallowed_regulated_domain` is a legal determination that
 * belongs to the register, not to a completion.
 */
export const proposedConstraintSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('max_budget'),
    maxCents: z.number().int().nonnegative(),
    currency: z.string().length(3),
    sourceQuote: sourceQuoteSchema,
  }).strict(),
  z.object({ type: z.literal('deadline_by'), byDate: z.string().date(), sourceQuote: sourceQuoteSchema }).strict(),
  z.object({
    type: z.literal('max_data_sensitivity'),
    level: z.enum(DATA_SENSITIVITY_LEVELS),
    sourceQuote: sourceQuoteSchema,
  }).strict(),
  z.object({
    type: z.literal('required_capability'),
    capabilityKey: z.string().min(1).max(80),
    sourceQuote: sourceQuoteSchema,
  }).strict(),
  z.object({
    type: z.literal('required_integration'),
    integrationKey: z.string().min(1).max(80),
    sourceQuote: sourceQuoteSchema,
  }).strict(),
])
export type ProposedConstraint = z.infer<typeof proposedConstraintSchema>

export interface SolutionsInterpretTaskInput {
  /** The brief exactly as the user typed it. Never summarised before sending: a summary would decide what
   * matters, which is the interpretation's job and has to be checkable against the original. */
  briefText: string
  /** The closed capability vocabulary. A key outside it cannot be matched against the catalog. */
  capabilityKeys: readonly string[]
  /** One prior clarification round, if the user answered a question. The policy allows exactly one. */
  priorClarification?: { question: string; answer: string }
}

export const solutionsInterpretInputSchema: z.ZodType<SolutionsInterpretTaskInput> = z.object({
  briefText: z.string().min(1).max(MAX_BRIEF_TEXT_LENGTH),
  capabilityKeys: z.array(z.string().min(1).max(80)).min(1),
  priorClarification: z.object({
    question: z.string().min(1).max(300),
    answer: z.string().min(1).max(1000),
  }).strict().optional(),
}).strict() as z.ZodType<SolutionsInterpretTaskInput>

/**
 * Field names an interpretation may report as unknown.
 *
 * A closed list, because each name becomes a `{status:'unknown'}` marker on a specific brief field, and a name
 * the mapping does not recognise would be silently dropped — turning "we asked and could not tell" back into
 * "never asked", which is the exact distinction the domain contract exists to preserve.
 */
export const UNKNOWABLE_BRIEF_FIELDS = [
  'scale',
  'budget',
  'deadline',
  'quality',
  'privacy',
  'supervision',
  'autonomyCeiling',
] as const
export type UnknowableBriefField = (typeof UNKNOWABLE_BRIEF_FIELDS)[number]

export interface SolutionsInterpretOutput {
  deliverable: { description: string; domain: (typeof BRIEF_DOMAINS)[number] }
  capabilities: string[]
  inputFormats: string[]
  outputFormats: string[]
  languages: string[]
  integrations: string[]
  scaleMagnitude?: 'one_off' | 'small' | 'medium' | 'large'
  quality?: (typeof QUALITY_BARS)[number]
  privacySensitivity?: (typeof DATA_SENSITIVITY_LEVELS)[number]
  supervision?: (typeof SUPERVISION_LEVELS)[number]
  autonomyCeiling?: (typeof AUTONOMY_CEILINGS)[number]
  rankingMode?: (typeof RANKING_MODES)[number]
  constraints: ProposedConstraint[]
  /** Fields the brief was silent or contradictory about. Becomes `{status:'unknown'}`, never a guess. */
  unknownFields: UnknowableBriefField[]
  /** At most one, and only when the answer would change which routes are offerable. */
  clarifyingQuestion?: string
  /** Which routes or fields the answer would change. Required for the question to survive. */
  clarifyingQuestionMateriality?: string
}

/**
 * Builds the output schema for a given capability vocabulary.
 *
 * Parameterised rather than fixed so `capabilities` and `required_capability` constraints are validated against
 * the keys that actually exist — an invented capability key would retrieve nothing and produce a route with a
 * permanent, unexplainable coverage gap.
 */
export function buildSolutionsInterpretOutputSchema(
  capabilityKeys: readonly string[],
): z.ZodType<SolutionsInterpretOutput> {
  const known = new Set(capabilityKeys)
  return z.object({
    deliverable: z.object({
      description: z.string().min(1).max(2000),
      domain: z.enum(BRIEF_DOMAINS),
    }).strict(),
    capabilities: z.array(z.string().min(1).max(80)).min(1).max(20),
    inputFormats: z.array(z.string().min(1).max(40)).max(20).default([]),
    outputFormats: z.array(z.string().min(1).max(40)).max(20).default([]),
    languages: z.array(z.string().min(2).max(40)).max(20).default([]),
    integrations: z.array(z.string().min(1).max(80)).max(20).default([]),
    scaleMagnitude: z.enum(['one_off', 'small', 'medium', 'large']).optional(),
    quality: z.enum(QUALITY_BARS).optional(),
    privacySensitivity: z.enum(DATA_SENSITIVITY_LEVELS).optional(),
    supervision: z.enum(SUPERVISION_LEVELS).optional(),
    autonomyCeiling: z.enum(AUTONOMY_CEILINGS).optional(),
    rankingMode: z.enum(RANKING_MODES).optional(),
    constraints: z.array(proposedConstraintSchema).max(20).default([]),
    unknownFields: z.array(z.enum(UNKNOWABLE_BRIEF_FIELDS)).max(UNKNOWABLE_BRIEF_FIELDS.length).default([]),
    clarifyingQuestion: z.string().min(1).max(300).optional(),
    clarifyingQuestionMateriality: z.string().min(1).max(300).optional(),
  }).strict().superRefine((output, context) => {
    for (const key of output.capabilities) {
      if (!known.has(key)) {
        context.addIssue({ code: 'custom', path: ['capabilities'], message: `unknown capability key '${key}'` })
      }
    }
    for (const constraint of output.constraints) {
      if (constraint.type === 'required_capability' && !known.has(constraint.capabilityKey)) {
        context.addIssue({
          code: 'custom',
          path: ['constraints'],
          message: `requires unknown capability key '${constraint.capabilityKey}'`,
        })
      }
    }
    // A question with no stated materiality is refused at the schema, not filtered later: the policy is one
    // question *that matters*, and "what is your budget?" asked of every brief is how a clarification step
    // becomes a form nobody reads.
    if (output.clarifyingQuestion && !output.clarifyingQuestionMateriality) {
      context.addIssue({
        code: 'custom',
        path: ['clarifyingQuestionMateriality'],
        message: 'a clarifying question must state what its answer would change',
      })
    }
  }) as unknown as z.ZodType<SolutionsInterpretOutput>
}

// --- Grounded route explanation -----------------------------------------------------------------

export interface RouteEvidenceSnippet {
  /** The evidence id the route already cites — `componentId@version`. */
  evidenceId: string
  displayName: string
  /** What the catalog records, verbatim. Never a paraphrase: the explanation is checked against this text. */
  claim: string
  evidenceLevel: string
}

export interface SolutionsExplainTaskInput {
  routeType: string
  status: string
  /** The deterministic summary the composer already produced, so the model rewrites rather than invents. */
  deterministicSummary: string
  components: ReadonlyArray<{ evidenceId: string; displayName: string; role: string; coveredCapabilityKeys: readonly string[] }>
  coverageGapCapabilityKeys: readonly string[]
  limitations: readonly string[]
  risks: readonly string[]
  humanReviewPoints: readonly string[]
  /** Formatted by the caller. Passed as text so the model has no numbers to recompute. */
  estimateText: string
  evidence: readonly RouteEvidenceSnippet[]
}

export const solutionsExplainInputSchema: z.ZodType<SolutionsExplainTaskInput> = z.object({
  routeType: z.string().min(1).max(20),
  status: z.string().min(1).max(20),
  deterministicSummary: z.string().min(1).max(600),
  components: z.array(z.object({
    evidenceId: z.string().min(1),
    displayName: z.string().min(1).max(200),
    role: z.string().min(1).max(200),
    coveredCapabilityKeys: z.array(z.string().min(1).max(80)),
  }).strict()).min(1).max(10),
  coverageGapCapabilityKeys: z.array(z.string().min(1).max(80)).max(20),
  limitations: z.array(z.string().min(1).max(300)).max(20),
  risks: z.array(z.string().min(1).max(300)).max(20),
  humanReviewPoints: z.array(z.string().min(1).max(300)).max(20),
  estimateText: z.string().max(300),
  evidence: z.array(z.object({
    evidenceId: z.string().min(1),
    displayName: z.string().min(1).max(200),
    claim: z.string().min(1).max(600),
    evidenceLevel: z.string().min(1).max(40),
  }).strict()).max(40),
}).strict() as z.ZodType<SolutionsExplainTaskInput>

export interface SolutionsExplainOutput {
  summary: string
  fitExplanation: string
  /** Every evidence id the explanation relies on. Checked against the supplied set. */
  citedEvidenceIds: string[]
}

/**
 * Builds the explanation schema for one route's evidence set.
 *
 * The citation check is the schema's job because an unresolvable citation is not a style problem: the whole
 * value of a grounded explanation is that a reader can pull the cited evidence and see what the source said.
 * An id nobody can resolve is indistinguishable from an invention.
 */
export function buildSolutionsExplainOutputSchema(
  evidenceIds: readonly string[],
): z.ZodType<SolutionsExplainOutput> {
  const known = new Set(evidenceIds)
  return z.object({
    summary: z.string().min(1).max(600),
    fitExplanation: z.string().min(1).max(2000),
    citedEvidenceIds: z.array(z.string().min(1)).min(1).max(40),
  }).strict().superRefine((output, context) => {
    for (const id of output.citedEvidenceIds) {
      if (!known.has(id)) {
        context.addIssue({ code: 'custom', path: ['citedEvidenceIds'], message: `cites unknown evidence '${id}'` })
      }
    }
  }) as unknown as z.ZodType<SolutionsExplainOutput>
}
