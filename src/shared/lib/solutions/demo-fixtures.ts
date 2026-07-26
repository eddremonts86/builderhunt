/**
 * Deterministic, non-provider demo data for the Solutions product shell (plan:
 * solutions-intelligence, tasks.md "Build the non-provider product shell"). Nothing here calls
 * an LLM, a retrieval index, or the billing platform — it exists so Free users can see an
 * accurate example of the result contract, and so Pro/Pro Max/Team users see a labeled example
 * while `SOLUTIONS_PAID_GENERATION_ENABLED` stays off (Phase 8 wires the real end-to-end flow).
 * Every shape here validates against `contracts.ts` — a broken fixture would fail its own schema
 * test, which is what keeps this demo honest as the contracts evolve.
 */
import { solutionRunSchema, type SolutionRun } from './contracts'

export const DEMO_SOLUTION_RUN: SolutionRun = solutionRunSchema.parse({
  briefId: 'demo-brief',
  rankingMode: 'recommended',
  retrievalQueryHash: 'demo-hash',
  componentVersionIds: ['demo-human-1', 'demo-agent-1'],
  evidenceIds: ['demo-ev-1', 'demo-ev-2'],
  modelVersion: 'demo',
  promptVersion: 'demo',
  sourceStatuses: [
    { sourceKey: 'builderhunt_catalog', status: 'ok', checkedAt: '2026-01-01T00:00:00Z' },
  ],
  warnings: ['This is an example result — live generation is not yet enabled for your organization.'],
  routes: [
    {
      routeType: 'human',
      status: 'recommended',
      summary: 'A translator handles the full manual end to end',
      fitExplanation: 'Matches the requested language pair, deadline, and quality bar with direct evidence of prior translation work in this domain.',
      steps: [
        'Assign a verified translator with domain evidence',
        'First-pass translation delivered as a draft',
        'Terminology review against your glossary',
        'Final delivery in the requested format',
      ],
      components: [
        { componentId: 'demo-human-1', componentVersion: 1, role: 'translator', coveredCapabilityKeys: ['translation'] },
      ],
      mandatoryCapabilitiesCovered: true,
      estimate: { costMinCents: 18000, costMaxCents: 32000, currency: 'usd', timeMinHours: 8, timeMaxHours: 16, assumptions: ['Standard 20-page technical manual', 'No specialized legal or medical terminology'] },
      risks: ['Turnaround depends on translator availability'],
      humanReviewPoints: ['Review terminology consistency before final delivery'],
      evidenceIds: ['demo-ev-1'],
    },
    {
      routeType: 'ai',
      status: 'available',
      summary: 'An AI translation model with a human QA pass',
      fitExplanation: 'Covers the language pair at a lower cost, but does not independently meet the requested quality bar without human review — shown as available, not recommended.',
      steps: [
        'Run the manual through a translation model',
        'Human QA pass on terminology and tone',
        'Deliver in the requested format',
      ],
      components: [
        { componentId: 'demo-agent-1', componentVersion: 1, role: 'translation_model', coveredCapabilityKeys: ['translation'] },
      ],
      mandatoryCapabilitiesCovered: false,
      coverageGapCapabilityKeys: ['quality_assurance'],
      limitations: ['Requires a human QA pass for the requested quality bar'],
      estimate: { costMinCents: 4000, costMaxCents: 9000, currency: 'usd', timeMinHours: 1, timeMaxHours: 3, assumptions: ['Human QA pass billed separately'] },
      risks: ['Model output may miss domain-specific terminology without review'],
      humanReviewPoints: ['A human must review the output before delivery — not yet assigned in this example'],
      evidenceIds: ['demo-ev-2'],
    },
    {
      routeType: 'hybrid',
      status: 'unavailable',
      unavailableReason: 'No compatible hybrid workflow currently has evidence for this language pair at the requested quality bar.',
      summary: 'Not available for this brief',
      fitExplanation: 'No compatible hybrid workflow currently has evidence for this language pair at the requested quality bar.',
      steps: ['Not applicable'],
      components: [
        { componentId: 'demo-human-1', componentVersion: 1, role: 'reviewer', coveredCapabilityKeys: ['translation'] },
      ],
      mandatoryCapabilitiesCovered: false,
      evidenceIds: ['demo-ev-1'],
    },
  ],
})
