/**
 * Work-Sample Analysis — schemas shared between `db/schema.ts` (the stored
 * envelope's type) and `ai/tasks.ts` (the AI task registration). Mirrors
 * `synergy.ts`'s split between schema module and task registration.
 */
import { z } from 'zod'

export const workSampleContentSchema = z.object({
  readme: z.string().max(10_000).nullish(),
  files: z.array(z.object({
    path: z.string(),
    content: z.string().max(20_000),
  })).max(6),
  diff: z.string().max(60_000).nullish(),
  prTitle: z.string().max(300).nullish(),
  prBody: z.string().max(5_000).nullish(),
  stats: z.object({
    totalFiles: z.number().int().nullish(),
    analyzedFiles: z.number().int(),
    truncated: z.boolean(),
  }),
})
export type WorkSampleContent = z.infer<typeof workSampleContentSchema>

export const workSampleAnalyzeInputSchema = z.object({
  sampleType: z.enum(['repo', 'pr', 'file']),
  sampleUrl: z.string().url(),
  builderUsername: z.string().nullish(),
  content: workSampleContentSchema,
})
export type WorkSampleAnalyzeInput = z.infer<typeof workSampleAnalyzeInputSchema>

const NO_URL_MESSAGE = 'output must not contain any http(s):// URL'

function containsUrl(value: string): boolean {
  return /https?:\/\//i.test(value)
}

// `superRefine` is applied separately below (to two different derived
// schemas) since `ZodEffects` — what `.superRefine()` returns — has no
// `.extend()`; the base object schema is what gets extended for the
// stored envelope.
const workSampleReviewModelBaseSchema = z.object({
  whatItDemonstrates: z.string().min(40).max(600),
  technologies: z.array(z.string().min(1).max(40)).max(12),
  levelSignals: z.array(z.object({
    signal: z.string().min(3).max(120),
    evidence: z.string().min(3).max(200),
    direction: z.enum(['senior', 'junior', 'neutral']),
  })).min(1).max(8),
  strengths: z.array(z.string().min(3).max(160)).max(6),
  concerns: z.array(z.string().min(3).max(160)).max(6),
  redFlags: z.array(z.string().min(3).max(160)).max(4),
  suggestedInterviewQuestions: z.array(z.string().min(10).max(200)).max(5),
  confidence: z.enum(['low', 'medium', 'high']),
})

// Prompt-injection defense (ai-policy rule 5): reject any URL in the output
// so a link planted in a poisoned README/PR body can never reach the
// recruiter. Rejection is treated as a parse failure by the platform
// (single retry, then 502) — see this schema's usage in tasks.ts.
function rejectUrls(value: z.infer<typeof workSampleReviewModelBaseSchema>, ctx: z.RefinementCtx): void {
  const stringFields: Array<[string, string[]]> = [
    ['whatItDemonstrates', [value.whatItDemonstrates]],
    ['technologies', value.technologies],
    ['levelSignals', value.levelSignals.flatMap((s) => [s.signal, s.evidence])],
    ['strengths', value.strengths],
    ['concerns', value.concerns],
    ['redFlags', value.redFlags],
    ['suggestedInterviewQuestions', value.suggestedInterviewQuestions],
  ]
  for (const [field, strings] of stringFields) {
    if (strings.some(containsUrl)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: NO_URL_MESSAGE })
    }
  }
}

export const workSampleReviewModelSchema = workSampleReviewModelBaseSchema.superRefine(rejectUrls)
export type WorkSampleReviewModel = z.infer<typeof workSampleReviewModelBaseSchema>

export const workSampleAnalysisSchema = workSampleReviewModelBaseSchema.extend({
  analyzedAt: z.string().datetime(),
  model: z.string(),
  contentHash: z.string(),
  version: z.literal(1),
}).superRefine(rejectUrls)
export type WorkSampleAnalysis = z.infer<typeof workSampleReviewModelBaseSchema> & {
  analyzedAt: string
  model: string
  contentHash: string
  version: 1
}
