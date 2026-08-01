/**
 * Brief interpretation (plan 43 Phase 7, "Register brief interpretation").
 *
 * Turns what a user typed into a `SolutionBrief` the deterministic composer can act on. Everything that could
 * change which routes are offerable is checked in code here, not trusted from the completion.
 *
 * ## It cannot charge anything
 *
 * This module imports no billing. That is the mechanism behind the plan's "charge nothing before confirmation":
 * interpretation runs *inside* `withSolutionsCredits`' work callback, so a reservation already exists by the
 * time it is called, and there is no path from here to a settlement. A test asserts the absence of the import,
 * because an accidental one would be invisible in review and would move a charge earlier than the confirmation.
 *
 * ## Four things the model is not trusted with
 *
 * 1. **Constraints without a quote.** Every proposed constraint carries the words that state it, and a
 *    constraint whose quote is not literally in the brief is dropped. A hallucinated `max_budget` can make
 *    every route unavailable; a widened one produces a recommendation the user's real budget cannot buy.
 * 2. **The unknown/absent distinction.** The model reports *which* fields it could not determine, and the
 *    `{status:'unknown'}` markers are constructed from that list. A field it simply omitted stays absent.
 * 3. **Whether to ask a question.** At most one, only with a stated materiality, and never about a field it
 *    also claims to know — a question about a value already extracted is a form field, not a clarification.
 * 4. **Handling its own failure.** Provider off, provider down, oversized brief, restricted data, invalid
 *    output: each produces a deterministic reading, marked as such, rather than a retry or an error page.
 *
 * ## The deterministic fallback is honest, not a stand-in
 *
 * It carries the user's own text as the deliverable, matches capability keys by literal keyword, and leaves
 * every judgement field absent. It is visibly weaker than an interpretation, which is the point: a brief the
 * user can correct beats a confident structure nobody produced.
 */
import { AIDisabledError, AIParseError, AIProviderError } from '~/shared/lib/ai/errors'
import { minimaxChat } from '~/shared/lib/ai/minimax'
import {
  SOLUTIONS_INTERPRET_PROMPT_VERSION,
  getTask,
  isTaskDisabled,
} from '~/shared/lib/ai/tasks'
import { env } from '~/shared/lib/env'
import { log } from '~/shared/lib/log'
import { getSolutionsFeatureFlags } from '~/shared/lib/solutions/config'
import {
  MAX_BRIEF_TEXT_LENGTH,
  buildSolutionsInterpretOutputSchema,
  type ProposedConstraint,
  type SolutionsInterpretOutput,
  type UnknowableBriefField,
} from '~/shared/lib/solutions/ai-contracts'
import {
  SOLUTION_CAPABILITIES,
  SOLUTION_CAPABILITY_KEYS,
  solutionBriefSchema,
  type DataSensitivityLevel,
  type HardConstraint,
  type SolutionBrief,
} from '~/shared/lib/solutions/contracts'

export const INTERPRET_TASK_ID = 'solutions-brief-interpret'

export type InterpretProvenance = 'model' | 'deterministic'

export type InterpretFallbackReason =
  | 'ai_disabled'
  | 'interpretation_flag_off'
  | 'restricted_data'
  | 'brief_too_large'
  | 'provider_failed'
  | 'invalid_output'

export interface InterpretedBrief {
  /**
   * `null` when no capability could be established at all.
   *
   * Only reachable on the deterministic path, and it is a real state rather than an error: the contract
   * requires at least one capability, retrieval matches on capability keys, and a brief carrying an invented
   * key would produce routes with a permanent, unexplainable coverage gap. So a fallback that matched nothing
   * returns no brief, and the surface asks the user which capabilities they need — a question they can answer,
   * unlike a route built on a guess.
   */
  brief: SolutionBrief | null
  provenance: InterpretProvenance
  /** Set only when `provenance` is `deterministic`. Surfaced to the user: they are owed the reason. */
  fallbackReason?: InterpretFallbackReason
  /** At most one, already checked for materiality. */
  clarifyingQuestion?: { question: string; materiality: string }
  /** Fields the interpretation was asked about and could not determine. */
  unknownFields: UnknowableBriefField[]
  /** Constraints the model proposed and this module discarded, with why. Logged and shown in the trace. */
  discardedConstraints: Array<{ type: string; reason: 'quote_not_in_brief' | 'unsupported_type' }>
  promptVersion: string | null
}

export interface InterpretInput {
  briefText: string
  /**
   * What the caller already knows about the data involved, from the UI's own field.
   *
   * `restricted` means the brief itself must not leave for a third-party model. Interpretation is not worth
   * sending restricted material to a provider, and there is no version of "we only sent a summary" that is
   * true — the summary would be of the restricted text.
   */
  declaredSensitivity?: DataSensitivityLevel
  priorClarification?: { question: string; answer: string }
  /** Injected in tests. Defaults to the real provider call. */
  complete?: (args: { system: string; prompt: string; maxOutputTokens: number }) => Promise<unknown>
}

export async function interpretBrief(input: InterpretInput): Promise<InterpretedBrief> {
  const text = input.briefText.trim()
  if (text.length === 0) throw new Error('interpretBrief requires non-empty brief text')

  const refusal = provisionalRefusal(text, input.declaredSensitivity)
  if (refusal) return fallback(text, refusal)

  const task = getTask(INTERPRET_TASK_ID)
  if (!task || isTaskDisabled(INTERPRET_TASK_ID, env)) return fallback(text, 'ai_disabled')

  const schema = buildSolutionsInterpretOutputSchema(SOLUTION_CAPABILITY_KEYS)
  const prompt = task.buildPrompt({
    briefText: text,
    capabilityKeys: SOLUTION_CAPABILITY_KEYS,
    ...(input.priorClarification ? { priorClarification: input.priorClarification } : {}),
  })

  let raw: unknown
  try {
    raw = input.complete
      ? await input.complete({ system: task.system, prompt, maxOutputTokens: task.maxOutputTokens })
      : await minimaxChat({ system: task.system, prompt, schema, maxOutputTokens: task.maxOutputTokens })
  } catch (error) {
    // `AIParseError` means the provider answered and the answer did not validate even after the correction
    // turn, which is a different fact from the provider being unreachable — a user seeing "the model returned
    // something unusable" knows a retry may help, where "AI is switched off" tells them it will not.
    const reason: InterpretFallbackReason = error instanceof AIDisabledError
      ? 'ai_disabled'
      : error instanceof AIParseError
        ? 'invalid_output'
        : error instanceof AIProviderError
          ? 'provider_failed'
          : 'provider_failed'
    log.warn('solutions_interpret_fallback', { reason, error: error instanceof Error ? error.message : 'unknown' })
    return fallback(text, reason)
  }

  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    log.warn('solutions_interpret_invalid_output', { issues: parsed.error.issues.slice(0, 5).map((issue) => issue.message) })
    return fallback(text, 'invalid_output')
  }

  return assemble(text, parsed.data, input.priorClarification !== undefined)
}

/**
 * The refusals that are decided before any provider is contacted.
 *
 * Ordered so the most specific reason wins: an oversized restricted brief is refused for being restricted,
 * because that is the fact that would not change if the user shortened it.
 */
function provisionalRefusal(text: string, sensitivity?: DataSensitivityLevel): InterpretFallbackReason | null {
  if (sensitivity === 'restricted') return 'restricted_data'
  if (!getSolutionsFeatureFlags().interpretationEnabled) return 'interpretation_flag_off'
  // Refused rather than truncated. Users put their constraints at the end — "must be done by Friday, budget
  // €5,000" — so a truncated brief loses exactly the fields that decide which routes are offerable, and loses
  // them invisibly.
  if (text.length > MAX_BRIEF_TEXT_LENGTH) return 'brief_too_large'
  return null
}

/**
 * Builds the brief from a validated interpretation.
 *
 * Every field goes through `solutionBriefSchema` at the end. The model's output already validated against its
 * own schema, but that schema describes what a model may *say*; this one describes what the composer may
 * *receive*, and they are not the same shape — the mapping between them is where the unknown markers are built.
 */
function assemble(
  briefText: string,
  output: SolutionsInterpretOutput,
  hadPriorClarification: boolean,
): InterpretedBrief {
  const unknown = new Set(output.unknownFields)
  const { constraints, discarded } = groundConstraints(briefText, output.constraints)

  const brief = solutionBriefSchema.parse({
    deliverable: output.deliverable,
    capabilities: [...new Set(output.capabilities)],
    inputFormats: output.inputFormats,
    outputFormats: output.outputFormats,
    languages: output.languages,
    integrations: output.integrations,
    // Known-or-unknown-or-absent, in that order, for each field the contract wraps. A value the model gave AND
    // listed as unknown is treated as unknown: the contradiction is resolved towards the weaker claim.
    ...wrap('scale', unknown, output.scaleMagnitude ? { magnitude: output.scaleMagnitude } : undefined),
    ...wrap('quality', unknown, output.quality),
    ...wrap('privacy', unknown, output.privacySensitivity ? { sensitivity: output.privacySensitivity } : undefined),
    ...wrap('supervision', unknown, output.supervision),
    ...wrap('autonomyCeiling', unknown, output.autonomyCeiling),
    // Budget and deadline are only ever constraints here. A model that mentioned a budget in prose but produced
    // no quotable constraint has not established one, and `budget` on the brief is what the composer compares
    // an estimate against.
    ...wrap('budget', unknown, budgetFromConstraints(constraints)),
    ...wrap('deadline', unknown, deadlineFromConstraints(constraints)),
    hardConstraints: constraints,
    softPreferences: [],
    rankingMode: output.rankingMode ?? 'recommended',
  })

  const question = pickQuestion(output, unknown, hadPriorClarification)

  return {
    brief,
    provenance: 'model',
    ...(question ? { clarifyingQuestion: question } : {}),
    unknownFields: [...unknown].sort(),
    discardedConstraints: discarded,
    promptVersion: SOLUTIONS_INTERPRET_PROMPT_VERSION,
  }
}

/** `{status:'unknown'}` when reported unknown, `{status:'known'}` when a value survived, absent otherwise. */
function wrap<T>(field: UnknowableBriefField, unknown: ReadonlySet<string>, value: T | undefined) {
  if (unknown.has(field)) return { [field]: { status: 'unknown' as const } }
  if (value === undefined) return {}
  return { [field]: { status: 'known' as const, value } }
}

/**
 * Keeps only constraints whose quote is really in the brief.
 *
 * Normalised on whitespace and case, because a model reliably re-types "5,000 EUR" with different spacing than
 * the user did and rejecting that would discard true constraints. Nothing else is normalised: a quote that
 * differs in its digits is not the same quote.
 */
export function groundConstraints(
  briefText: string,
  proposed: readonly ProposedConstraint[],
): { constraints: HardConstraint[]; discarded: InterpretedBrief['discardedConstraints'] } {
  const haystack = normalise(briefText)
  const constraints: HardConstraint[] = []
  const discarded: InterpretedBrief['discardedConstraints'] = []

  for (const candidate of proposed) {
    if (!haystack.includes(normalise(candidate.sourceQuote))) {
      discarded.push({ type: candidate.type, reason: 'quote_not_in_brief' })
      continue
    }
    const { sourceQuote: _quote, ...constraint } = candidate
    constraints.push(constraint as HardConstraint)
  }
  return { constraints, discarded }
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

function budgetFromConstraints(constraints: readonly HardConstraint[]) {
  const budget = constraints.find((constraint) => constraint.type === 'max_budget')
  if (!budget || budget.type !== 'max_budget') return undefined
  return { maxCents: budget.maxCents, currency: budget.currency }
}

function deadlineFromConstraints(constraints: readonly HardConstraint[]) {
  const deadline = constraints.find((constraint) => constraint.type === 'deadline_by')
  if (!deadline || deadline.type !== 'deadline_by') return undefined
  return { byDate: deadline.byDate }
}

/**
 * The one-question materiality policy.
 *
 * A question survives only if it has a stated materiality, no question was already asked, and the field it is
 * about is genuinely unresolved. The last check is the one that does the work: a model that extracted a budget
 * and then asked about the budget is asking the user to confirm its own reading, which is what the correction
 * step is for.
 */
export function pickQuestion(
  output: SolutionsInterpretOutput,
  unknown: ReadonlySet<string>,
  hadPriorClarification: boolean,
): { question: string; materiality: string } | null {
  if (!output.clarifyingQuestion || !output.clarifyingQuestionMateriality) return null
  // One round. A second question after the user already answered one turns a clarification into an interview.
  if (hadPriorClarification) return null

  const asksAboutSettledField = UNKNOWN_FIELD_HINTS.some(([field, pattern]) =>
    pattern.test(output.clarifyingQuestion!) && !unknown.has(field))
  if (asksAboutSettledField) return null

  return { question: output.clarifyingQuestion, materiality: output.clarifyingQuestionMateriality }
}

/** Words that identify which brief field a question is about. Only used to reject a question about something
 * already determined, so a miss costs a redundant question rather than a wrong brief. */
const UNKNOWN_FIELD_HINTS: ReadonlyArray<[UnknowableBriefField, RegExp]> = [
  ['budget', /budget|cost|price|spend|afford/i],
  ['deadline', /deadline|by when|due|timeline|how soon/i],
  ['quality', /quality|standard|polish|draft/i],
  ['privacy', /privacy|confidential|sensitive|personal data|gdpr/i],
  ['scale', /how many|volume|scale|how much work/i],
  ['supervision', /supervis|review|oversight|sign off|sign-off/i],
  ['autonomyCeiling', /autonom|act on its own|unattended/i],
]

/**
 * A brief read without a model.
 *
 * The deliverable is the user's own text. Capabilities come from literal keyword matching against
 * `SOLUTION_CAPABILITIES` — deterministic, explainable, and wrong in an obvious way rather than a plausible
 * one. `other` is the domain because guessing a domain from keywords is exactly the kind of confident mistake
 * this path exists to avoid, and it costs the user one correction.
 *
 * Nothing is marked unknown: nothing was asked. That is the distinction the contract keeps, and filling
 * `unknownFields` here would claim an interpretation attempt that never happened.
 */
export function buildFallbackBrief(briefText: string): SolutionBrief | null {
  const matched = matchCapabilityKeys(briefText)
  // No capability, no brief. Substituting a placeholder key here was the first version, and it would have put
  // a capability nothing in the catalog claims into a brief the composer then failed to cover — a coverage gap
  // whose cause was this function rather than the catalog.
  if (matched.length === 0) return null

  return solutionBriefSchema.parse({
    deliverable: {
      description: briefText.slice(0, 2000),
      domain: 'other',
    },
    capabilities: matched,
    inputFormats: [],
    outputFormats: [],
    languages: [],
    integrations: [],
    hardConstraints: [],
    softPreferences: [],
    rankingMode: 'recommended',
  })
}

function fallback(briefText: string, reason: InterpretFallbackReason): InterpretedBrief {
  return {
    brief: buildFallbackBrief(briefText),
    provenance: 'deterministic',
    fallbackReason: reason,
    unknownFields: [],
    discardedConstraints: [],
    promptVersion: null,
  }
}

/**
 * The words that identify each capability in a brief someone actually wrote.
 *
 * Declared rather than derived. The first version matched only the key and the label — the nouns — and missed
 * every brief phrased the way people phrase them: "we need to **translate** 200 pages" does not contain
 * "translation", so a real brief matched nothing and produced no fallback at all. No stemmer, because a stemmer
 * would also make `translation` match "translational research"; these are the inflections that appear in
 * briefs, listed once.
 *
 * A capability with no terms would silently never match, so `CAPABILITY_TERMS` is asserted complete against
 * `SOLUTION_CAPABILITIES` in the tests.
 */
export const CAPABILITY_TERMS: Readonly<Record<string, readonly string[]>> = {
  translation: ['translation', 'translations', 'translate', 'translating', 'translated', 'localise', 'localize', 'localisation', 'localization'],
  summarization: ['summarization', 'summarisation', 'summary', 'summaries', 'summarize', 'summarise', 'summarizing', 'summarising'],
  transcription: ['transcription', 'transcript', 'transcripts', 'transcribe', 'transcribing', 'subtitles', 'captions'],
  text_generation: ['text generation', 'generate text', 'copywriting', 'write copy', 'draft copy', 'ghostwriting'],
  embedding: ['embedding', 'embeddings', 'vector search', 'semantic search', 'similarity search'],
  classification: ['classification', 'classify', 'classifying', 'categorise', 'categorize', 'categorisation', 'categorization', 'tagging', 'labelling', 'labeling'],
  entity_extraction: ['entity extraction', 'extract entities', 'named entities', 'named entity recognition', 'ner'],
  image_understanding: ['image understanding', 'image recognition', 'describe images', 'alt text', 'computer vision'],
  document_understanding: ['document understanding', 'pdf extraction', 'extract from pdf', 'invoice extraction', 'ocr', 'document parsing'],
  web_extraction: ['web extraction', 'scraping', 'scrape', 'scraped', 'crawl', 'crawling', 'web data'],
  data_transformation: ['data transformation', 'transform data', 'etl', 'data pipeline', 'data migration', 'reshape data'],
}

/**
 * Literal keyword matching against the capability vocabulary.
 *
 * Word-boundary anchored: `translation` must not match "translational", and a substring search would make
 * `data_transformation` match any brief containing "data".
 */
export function matchCapabilityKeys(briefText: string): string[] {
  const haystack = normalise(briefText)
  const matched = new Set<string>()

  for (const capability of SOLUTION_CAPABILITIES) {
    const terms = CAPABILITY_TERMS[capability.key] ?? [capability.key.replace(/_/g, ' ')]
    for (const term of terms) {
      if (new RegExp(`\\b${escapeRegExp(term)}\\b`).test(haystack)) {
        matched.add(capability.key)
        break
      }
    }
  }
  return [...matched].sort().slice(0, 20)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
