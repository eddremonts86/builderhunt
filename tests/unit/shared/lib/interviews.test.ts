import { describe, expect, it } from 'vitest'
import {
  assertBriefEvidenceIntegrity,
  assertNoDanglingSegmentEvidence,
  assertNoDanglingSourceReference,
  assertNoDuplicateSegments,
  assertNoProhibitedInterviewContent,
  assertReportContentIsClean,
  assertValidDocumentStatusTransition,
  assertValidInterviewSessionTransition,
  buildFallbackBriefTemplate,
  buildFallbackReportTemplate,
  candidateDocumentSchema,
  DOCUMENT_STATUSES,
  findProhibitedInterviewContent,
  INTERVIEW_SESSION_STATES,
  InterviewDomainError,
  interviewBriefContentSchema,
  interviewFollowupSuggestOutputSchema,
  interviewReportSchema,
  sourceManifestEntrySchema,
  transcriptSegmentSchema,
  type DocumentStatus,
  type InterviewSessionState,
} from '~/shared/lib/interviews'

describe('document status transitions', () => {
  const VALID: [DocumentStatus, DocumentStatus][] = [
    ['pending_upload', 'uploaded'],
    ['pending_upload', 'failed'],
    ['uploaded', 'scanning'],
    ['uploaded', 'rejected'],
    ['uploaded', 'failed'],
    ['scanning', 'extracting'],
    ['scanning', 'rejected'],
    ['scanning', 'failed'],
    ['extracting', 'ready'],
    ['extracting', 'rejected'],
    ['extracting', 'failed'],
  ]

  it.each(VALID)('allows %s -> %s', (from, to) => {
    expect(() => assertValidDocumentStatusTransition(from, to)).not.toThrow()
  })

  const allPairs: [DocumentStatus, DocumentStatus][] = DOCUMENT_STATUSES.flatMap((from) =>
    DOCUMENT_STATUSES.map((to) => [from, to] as [DocumentStatus, DocumentStatus]),
  )
  const invalidPairs = allPairs.filter(([from, to]) => !VALID.some(([vf, vt]) => vf === from && vt === to))

  it.each(invalidPairs)('rejects %s -> %s', (from, to) => {
    expect(() => assertValidDocumentStatusTransition(from, to)).toThrow(InterviewDomainError)
  })

  it('every terminal status rejects all transitions', () => {
    for (const terminal of ['ready', 'rejected', 'failed'] as const) {
      for (const to of DOCUMENT_STATUSES) {
        expect(() => assertValidDocumentStatusTransition(terminal, to)).toThrow()
      }
    }
  })
})

describe('candidateDocumentSchema', () => {
  const BASE = {
    id: '11111111-1111-4111-8111-111111111111',
    submissionId: '22222222-2222-4222-8222-222222222222',
    originalName: 'cv.pdf',
    declaredMediaType: 'application/pdf',
    detectedMediaType: 'application/pdf',
    sha256: 'a'.repeat(64),
    bytes: 1024,
    status: 'ready' as const,
    rejectionCode: null,
    retentionExpiresAt: '2026-12-31T00:00:00.000Z',
  }

  it('accepts a ready document with no rejectionCode', () => {
    expect(() => candidateDocumentSchema.parse(BASE)).not.toThrow()
  })

  it('requires a rejectionCode when status is rejected', () => {
    expect(() => candidateDocumentSchema.parse({ ...BASE, status: 'rejected', rejectionCode: null })).toThrow()
    expect(() => candidateDocumentSchema.parse({ ...BASE, status: 'rejected', rejectionCode: 'corrupt_file' })).not.toThrow()
  })
})

describe('interview session state transitions', () => {
  const VALID: [InterviewSessionState, InterviewSessionState][] = [
    ['not_started', 'consent_pending'],
    ['not_started', 'abandoned'],
    ['consent_pending', 'ready'],
    ['consent_pending', 'abandoned'],
    ['ready', 'live'],
    ['ready', 'abandoned'],
    ['live', 'processing'],
    ['live', 'paused'],
    ['live', 'failed'],
    ['live', 'abandoned'],
    ['processing', 'review'],
    ['processing', 'failed'],
    ['processing', 'abandoned'],
    ['review', 'finalized'],
    ['review', 'failed'],
    ['review', 'abandoned'],
    ['paused', 'live'],
    ['paused', 'abandoned'],
    ['paused', 'failed'],
  ]

  it.each(VALID)('allows %s -> %s', (from, to) => {
    expect(() => assertValidInterviewSessionTransition(from, to)).not.toThrow()
  })

  it('manual notes keep working through capture/provider failure — live can transition to failed without losing the session', () => {
    expect(() => assertValidInterviewSessionTransition('live', 'failed')).not.toThrow()
  })

  const allPairs: [InterviewSessionState, InterviewSessionState][] = INTERVIEW_SESSION_STATES.flatMap((from) =>
    INTERVIEW_SESSION_STATES.map((to) => [from, to] as [InterviewSessionState, InterviewSessionState]),
  )
  const invalidPairs = allPairs.filter(([from, to]) => !VALID.some(([vf, vt]) => vf === from && vt === to))

  it.each(invalidPairs)('rejects %s -> %s', (from, to) => {
    expect(() => assertValidInterviewSessionTransition(from, to)).toThrow(InterviewDomainError)
  })

  it('every terminal state rejects all transitions', () => {
    for (const terminal of ['finalized', 'failed', 'abandoned'] as const) {
      for (const to of INTERVIEW_SESSION_STATES) {
        expect(() => assertValidInterviewSessionTransition(terminal, to)).toThrow()
      }
    }
  })
})

describe('transcript segments', () => {
  const BASE = {
    id: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    providerSegmentId: 'seg-1',
    sequence: 0,
    speakerEstimate: 'speaker_a' as const,
    speakerMapping: null,
    text: 'Hello',
    startsMs: 0,
    endsMs: 1000,
    confidence: 0.9,
    correctedByUserId: null,
    correctedAt: null,
    retentionExpiresAt: '2026-12-31T00:00:00.000Z',
  }

  it('accepts a valid segment', () => {
    expect(() => transcriptSegmentSchema.parse(BASE)).not.toThrow()
  })

  it('rejects endsMs not after startsMs', () => {
    expect(() => transcriptSegmentSchema.parse({ ...BASE, endsMs: 0 })).toThrow()
  })

  it('correction audit: correctedByUserId and correctedAt must be set together', () => {
    expect(() => transcriptSegmentSchema.parse({ ...BASE, correctedByUserId: 'user-1', correctedAt: null })).toThrow()
    expect(() => transcriptSegmentSchema.parse({ ...BASE, correctedByUserId: null, correctedAt: '2026-08-01T00:00:00.000Z' })).toThrow()
    expect(() =>
      transcriptSegmentSchema.parse({ ...BASE, correctedByUserId: 'user-1', correctedAt: '2026-08-01T00:00:00.000Z' }),
    ).not.toThrow()
  })

  it('diarization labels are estimates only, never biometric identity (speaker_a/speaker_b/unknown)', () => {
    expect(() => transcriptSegmentSchema.parse({ ...BASE, speakerEstimate: 'speaker_b' })).not.toThrow()
    expect(() => transcriptSegmentSchema.parse({ ...BASE, speakerEstimate: 'unknown' })).not.toThrow()
    expect(() => transcriptSegmentSchema.parse({ ...BASE, speakerEstimate: 'jane_doe' })).toThrow()
  })

  describe('assertNoDuplicateSegments', () => {
    it('accepts a batch with unique provider IDs and sequences', () => {
      expect(() =>
        assertNoDuplicateSegments([
          { sessionId: 's1', providerSegmentId: 'seg-1', sequence: 0 },
          { sessionId: 's1', providerSegmentId: 'seg-2', sequence: 1 },
        ]),
      ).not.toThrow()
    })

    it('rejects a duplicate provider segment ID within the same session', () => {
      expect(() =>
        assertNoDuplicateSegments([
          { sessionId: 's1', providerSegmentId: 'seg-1', sequence: 0 },
          { sessionId: 's1', providerSegmentId: 'seg-1', sequence: 1 },
        ]),
      ).toThrow(InterviewDomainError)
    })

    it('rejects a duplicate sequence within the same session', () => {
      expect(() =>
        assertNoDuplicateSegments([
          { sessionId: 's1', providerSegmentId: 'seg-1', sequence: 0 },
          { sessionId: 's1', providerSegmentId: 'seg-2', sequence: 0 },
        ]),
      ).toThrow(InterviewDomainError)
    })

    it('allows the same provider segment ID or sequence across different sessions', () => {
      expect(() =>
        assertNoDuplicateSegments([
          { sessionId: 's1', providerSegmentId: 'seg-1', sequence: 0 },
          { sessionId: 's2', providerSegmentId: 'seg-1', sequence: 0 },
        ]),
      ).not.toThrow()
    })
  })
})

describe('dangling evidence integrity', () => {
  it('assertNoDanglingSegmentEvidence accepts known IDs and rejects an unknown one', () => {
    const known = new Set(['seg-1', 'seg-2'])
    expect(() => assertNoDanglingSegmentEvidence(['seg-1'], known)).not.toThrow()
    expect(() => assertNoDanglingSegmentEvidence(['seg-1', 'seg-99'], known)).toThrow(InterviewDomainError)
  })

  it('assertNoDanglingSourceReference accepts known source IDs and rejects an unknown one', () => {
    const manifest = [sourceManifestEntrySchema.parse({ id: 'src-1', kind: 'document', label: 'CV' })]
    expect(() => assertNoDanglingSourceReference(['src-1'], manifest)).not.toThrow()
    expect(() => assertNoDanglingSourceReference(['src-99'], manifest)).toThrow(InterviewDomainError)
  })

  it('assertBriefEvidenceIntegrity walks every claim/contradiction/question sourceId', () => {
    const manifest = [sourceManifestEntrySchema.parse({ id: 'src-1', kind: 'document', label: 'CV' })]
    const validContent = interviewBriefContentSchema.parse({
      candidateSummary: 'Summary',
      relevantEvidence: [{ claim: 'Built X', sourceIds: ['src-1'], confidence: 'high' }],
      informationGaps: [],
      contradictions: [],
      questionGroups: [],
    })
    expect(() => assertBriefEvidenceIntegrity({ content: validContent, evidenceManifest: manifest })).not.toThrow()

    const danglingContent = interviewBriefContentSchema.parse({
      candidateSummary: 'Summary',
      relevantEvidence: [{ claim: 'Built X', sourceIds: ['src-does-not-exist'], confidence: 'high' }],
      informationGaps: [],
      contradictions: [],
      questionGroups: [],
    })
    expect(() => assertBriefEvidenceIntegrity({ content: danglingContent, evidenceManifest: manifest })).toThrow(InterviewDomainError)
  })
})

describe('source manifest', () => {
  it('rejects a submitted_link source that carries factual text (restricted to URL/label only)', () => {
    expect(() => sourceManifestEntrySchema.parse({ id: 'src-1', kind: 'submitted_link', label: 'Portfolio', text: 'Some fact' })).toThrow()
    expect(() => sourceManifestEntrySchema.parse({ id: 'src-1', kind: 'submitted_link', label: 'Portfolio' })).not.toThrow()
  })

  it('allows document/approved_web/public_profile sources to carry factual text', () => {
    for (const kind of ['document', 'approved_web', 'public_profile'] as const) {
      expect(() => sourceManifestEntrySchema.parse({ id: 'src-1', kind, label: 'Source', text: 'Some fact' })).not.toThrow()
    }
  })
})

describe('prohibited-output validation', () => {
  it.each([
    'The candidate scored 8/10 overall.',
    'This candidate ranks second among applicants.',
    'The candidate has an outgoing personality.',
    'The candidate showed genuine emotion during the interview.',
    'Strong culture fit with the team.',
    'We recommend to hire this candidate.',
    'The panel voted to reject the application.',
  ])('flags prohibited content: %s', (text) => {
    expect(findProhibitedInterviewContent(text).length).toBeGreaterThan(0)
    expect(() => assertNoProhibitedInterviewContent(text)).toThrow(InterviewDomainError)
  })

  it('allows clean, evidence-linked content', () => {
    const clean = 'The candidate described a project using React and Node.js, referencing prior experience at a startup.'
    expect(findProhibitedInterviewContent(clean)).toEqual([])
    expect(() => assertNoProhibitedInterviewContent(clean)).not.toThrow()
  })

  it('assertReportContentIsClean scans every free-text field of a report', () => {
    const dirtyReport = {
      summary: [{ statement: 'Candidate scored well.', segmentIds: [] }],
      answersByTopic: [],
      openQuestions: [],
      followUps: [],
    }
    expect(() => assertReportContentIsClean(dirtyReport)).toThrow(InterviewDomainError)

    const cleanReport = {
      summary: [{ statement: 'Candidate described their experience with distributed systems.', segmentIds: [] }],
      answersByTopic: [],
      openQuestions: [],
      followUps: [],
    }
    expect(() => assertReportContentIsClean(cleanReport)).not.toThrow()
  })
})

describe('interviewFollowupSuggestOutputSchema', () => {
  it('accepts up to 3 questions', () => {
    const three = Array.from({ length: 3 }, (_, i) => ({ id: `q${i}`, topicId: 't1', question: 'Q?', rationale: 'R', segmentIds: [] }))
    expect(() => interviewFollowupSuggestOutputSchema.parse({ questions: three })).not.toThrow()
  })

  it('rejects more than 3 questions', () => {
    const four = Array.from({ length: 4 }, (_, i) => ({ id: `q${i}`, topicId: 't1', question: 'Q?', rationale: 'R', segmentIds: [] }))
    expect(() => interviewFollowupSuggestOutputSchema.parse({ questions: four })).toThrow()
  })
})

describe('interviewReportSchema', () => {
  const cleanContent = {
    summary: [{ statement: 'Discussed distributed systems experience.', segmentIds: [] }],
    answersByTopic: [],
    openQuestions: [],
    followUps: [],
  }

  it('requires finalizedAt exactly when status is final', () => {
    expect(() =>
      interviewReportSchema.parse({
        id: '11111111-1111-4111-8111-111111111111',
        eventId: '22222222-2222-4222-8222-222222222222',
        version: 1,
        status: 'final',
        content: cleanContent,
        evidenceSegmentIds: [],
        provider: null,
        model: null,
        promptVersion: null,
        editedByUserId: null,
        finalizedAt: null,
        retentionExpiresAt: '2026-12-31T00:00:00.000Z',
      }),
    ).toThrow()

    expect(() =>
      interviewReportSchema.parse({
        id: '11111111-1111-4111-8111-111111111111',
        eventId: '22222222-2222-4222-8222-222222222222',
        version: 1,
        status: 'final',
        content: cleanContent,
        evidenceSegmentIds: [],
        provider: null,
        model: null,
        promptVersion: null,
        editedByUserId: null,
        finalizedAt: '2026-08-01T00:00:00.000Z',
        retentionExpiresAt: '2026-12-31T00:00:00.000Z',
      }),
    ).not.toThrow()
  })
})

describe('deterministic fallback templates', () => {
  it('buildFallbackReportTemplate is deterministic for the same topic list', () => {
    const topics = [{ id: 't1' }, { id: 't2' }]
    expect(buildFallbackReportTemplate(topics)).toEqual(buildFallbackReportTemplate(topics))
    expect(buildFallbackReportTemplate(topics).answersByTopic.map((a) => a.topicId)).toEqual(['t1', 't2'])
  })

  it('buildFallbackReportTemplate produces content that passes the clean-content and schema checks', () => {
    const template = buildFallbackReportTemplate([{ id: 't1' }])
    expect(() => assertReportContentIsClean(template)).not.toThrow()
  })

  it('buildFallbackBriefTemplate is deterministic and schema-valid', () => {
    expect(buildFallbackBriefTemplate()).toEqual(buildFallbackBriefTemplate())
    expect(() => interviewBriefContentSchema.parse(buildFallbackBriefTemplate())).not.toThrow()
  })
})
