/**
 * The Article 6(3) preparatory-task position rests on the AI not deciding anything, and a prompt cannot be the
 * evidence for that — a prompt is advice. These tests read the schema and the source, because the only
 * defensible form of "it cannot make a decision" is that there is nowhere for a decision to be written and no
 * code path that writes one.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { interviewReportContentSchema } from '~/shared/lib/interviews'
import { getTask } from '~/shared/lib/ai/tasks'

const read = (relative: string) => readFile(join(process.cwd(), relative), 'utf8')

const AI_MODULES = [
  'src/lib/interviews/brief-service.ts',
  'src/lib/interviews/suggestion-service.ts',
  'src/lib/interviews/report-service.ts',
]

describe('there is nowhere to record a decision', () => {
  it('the schema has no candidate-status column of any kind', async () => {
    const schema = await read('src/shared/lib/db/schema.ts')
    // Scoped to the interview and candidate tables. `policyDecision` exists elsewhere for web-import policy
    // and billing refunds, which are not decisions about a person.
    const interviewTables = schema.slice(schema.indexOf('candidateSubmissions = pgTable'))
    // Matched as a *column declaration*, not as a substring: a prose comment in this region contains the
    // word "rating", and a substring check flagged it. The thing that matters is whether a column exists.
    for (const forbidden of [
      'candidateStatus', 'candidate_status', 'hiringStatus', 'hiring_status',
      'recommendation', 'overallScore', 'overall_score', 'rating',
      'advanceToNextRound', 'shortlisted', 'rejected',
    ]) {
      const declaration = new RegExp(`\\b${forbidden}\\s*:\\s*(text|integer|boolean|jsonb|numeric)\\(`)
      expect(interviewTables, `the schema declares a "${forbidden}" column`).not.toMatch(declaration)
    }
  })

  it('the report content schema refuses an added score or recommendation key', () => {
    const valid = { summary: [], answersByTopic: [], openQuestions: [], followUps: [] }
    // `.strict()`, so this is structural rather than a matter of what a caller remembers to strip.
    expect(interviewReportContentSchema.safeParse({ ...valid, overallScore: 8 }).success).toBe(false)
    expect(interviewReportContentSchema.safeParse({ ...valid, recommendation: 'hire' }).success).toBe(false)
    expect(interviewReportContentSchema.safeParse({ ...valid, rating: 4 }).success).toBe(false)
    expect(interviewReportContentSchema.safeParse(valid).success).toBe(true)
  })
})

describe('no AI path writes anything but its own artifact', () => {
  it.each(AI_MODULES)('%s writes only interview artifacts', async (module) => {
    const source = await read(module)
    // The tables an AI service is allowed to write. Anything else — a candidate row, an event status, a
    // builder record — would be the model changing a fact about a person rather than drafting text about one.
    // The *receiver* has to be a transaction, not any object with a `.delete`. Two earlier versions of this
    // regex blamed this module for `throttleBySession.delete(sessionId)` — an in-memory Map — and for an
    // object property named `sessionId`. A drizzle write is always `transaction.insert(table)` or
    // `tx.update(table)`, so requiring that receiver is what makes the check about the database.
    const writes = [...source.matchAll(/\b(?:transaction|tx|db)\s*\.\s*(?:insert|update|delete)\s*\(\s*([A-Za-z]+)/g)]
      .map((match) => match[1])
    const allowed = new Set(['interviewBriefs', 'interviewReports', 'interviewSuggestions'])
    for (const target of writes) {
      expect(allowed.has(target), `${module} writes to ${target}`).toBe(true)
    }
  })

  it.each(AI_MODULES)('%s imports no repository that could change a candidate', async (module) => {
    const source = await read(module)
    for (const forbidden of ['repositories/scheduling', 'repositories/calendar', 'repositories/builders']) {
      expect(source, `${module} imports ${forbidden}`).not.toContain(forbidden)
    }
  })
})

describe('every AI task is server-only, sensitive, and uncached', () => {
  const ids = ['interview-brief-generate', 'interview-followup-suggest', 'interview-report-generate']

  it.each(ids)('%s', (id) => {
    const task = getTask(id)!
    // Sensitive keeps it on the EU provider and out of `/api/ai/complete`; server-only keeps it off a
    // browser-side model with no reservation, no audit row and no residency guarantee; no cache stops one
    // organization's candidate material reaching another.
    expect(task.sensitive).toBe(true)
    expect(task.tier).toBe('server-only')
    expect(task.cacheTtlSeconds).toBeNull()
    expect(task.allowances.free).toBe(0)
  })

  it.each(ids)('%s tells the model what it must not do', (id) => {
    const task = getTask(id)!
    // Not the enforcement — the schema is. But a system message that omitted it would be an odd thing to hand
    // a reviewer alongside a claim that the system is preparatory.
    expect(task.system).toMatch(/[Nn]ever|not/)
    // The brief is a preparation document and its prohibition is about protected traits; the two
    // transcript-reading tasks are the ones that could state a conclusion, so they name scoring explicitly.
    const forbids = id === 'interview-brief-generate'
      ? /age, gender, ethnicity|protected characteristic|culture.?fit/i
      : /score|rank|recommend/i
    expect(task.system).toMatch(forbids)
  })
})

describe('protected-trait proxies are refused in output, not just discouraged', () => {
  const segments = [{ id: 'seg-1', speaker: 'Candidate', startsMs: 0, text: 'I took two years out.' }]
  const topics = [{ id: 'topic:1', question: 'Tell me about the gap.' }]

  const proxies: Array<[string, string]> = [
    ['maternity as a gap explanation', 'The gap was maternity leave, which suggests family commitments.'],
    ['age via graduation year', 'Graduated in 1998, so likely too old for the team.'],
    ['nationality via language', 'Not a native speaker, which limits the role.'],
    ['health', 'Mentioned a disability, which may affect availability.'],
    ['a culture-fit judgement', 'Not a culture fit for this team.'],
    ['a personality claim', 'Personality seems abrasive under pressure.'],
  ]

  it.each(proxies)('refuses %s in a report', async (_label, statement) => {
    const { buildInterviewReportOutputSchema } = await import('~/shared/lib/ai/tasks')
    const schema = buildInterviewReportOutputSchema({ segments, topics })
    const result = schema.safeParse({
      summary: [{ statement, segmentIds: ['seg-1'] }],
      answersByTopic: [], openQuestions: [], followUps: [],
    })
    expect(result.success, `"${statement}" was accepted`).toBe(false)
  })

  it('accepts a statement about the work itself', async () => {
    const { buildInterviewReportOutputSchema } = await import('~/shared/lib/ai/tasks')
    const schema = buildInterviewReportOutputSchema({ segments, topics })
    // The check has to leave the legitimate case alone, or it would make the feature useless rather than safe.
    expect(schema.safeParse({
      summary: [{ statement: 'Described two years spent on an open-source compiler.', segmentIds: ['seg-1'] }],
      answersByTopic: [], openQuestions: [], followUps: [],
    }).success).toBe(true)
  })
})

describe('the same refusals hold for Spanish input', () => {
  // spec.md supports Spanish and English. A guard that only reads English would pass every test here and fail
  // the first real interview conducted in Spanish.
  const segments = [{ id: 'seg-1', speaker: 'Candidate', startsMs: 0, text: 'Reescribí la capa de caché.' }]
  const topics = [{ id: 'topic:1', question: '¿Cómo midió la latencia?' }]

  it('accepts a Spanish statement about the work', async () => {
    const { buildInterviewReportOutputSchema } = await import('~/shared/lib/ai/tasks')
    const schema = buildInterviewReportOutputSchema({ segments, topics })
    expect(schema.safeParse({
      summary: [{ statement: 'Describió la reescritura de la caché y su efecto en la latencia.', segmentIds: ['seg-1'] }],
      answersByTopic: [], openQuestions: [], followUps: [],
    }).success).toBe(true)
  })

  it('refuses an English scoring word inside otherwise Spanish text', async () => {
    const { buildInterviewReportOutputSchema } = await import('~/shared/lib/ai/tasks')
    const schema = buildInterviewReportOutputSchema({ segments, topics })
    expect(schema.safeParse({
      summary: [{ statement: 'Le doy un score alto en Rust.', segmentIds: ['seg-1'] }],
      answersByTopic: [], openQuestions: [], followUps: [],
    }).success).toBe(false)
  })

  it('documents the gap: Spanish-only scoring vocabulary is NOT caught', async () => {
    const { buildInterviewReportOutputSchema } = await import('~/shared/lib/ai/tasks')
    const schema = buildInterviewReportOutputSchema({ segments, topics })
    // Deliberately asserting the *current* behaviour, not the desired one. `PROHIBITED_OUTPUT_PATTERNS` is
    // English-only, so "recomiendo contratarlo" passes the filter. The schema still has nowhere to put a
    // score and a human still reads every draft, so this is a weakened layer rather than an open door — but
    // it is a real gap, it is recorded in
    // `docs/compliance/interview-ai-act-classification.md`, and this test will fail the day someone adds
    // Spanish patterns, which is the reminder to update the document.
    const result = schema.safeParse({
      summary: [{ statement: 'Recomiendo contratarlo de inmediato.', segmentIds: ['seg-1'] }],
      answersByTopic: [], openQuestions: [], followUps: [],
    })
    expect(result.success).toBe(true)
  })
})
