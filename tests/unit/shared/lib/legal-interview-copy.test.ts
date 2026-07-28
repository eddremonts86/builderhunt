/**
 * A notice is only evidence if the version a reader saw is the version the receipt records. These tests are
 * about that chain, and about the specific claims the copy makes — a privacy policy that says audio is never
 * stored has to be checkable against the thing that stores nothing.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CURRENT_CONSENT_VERSIONS } from '~/shared/lib/legal-versions'
import { CANDIDATE_NOTICE_VERSION, PRIVACY_POLICY_VERSION } from '~/shared/lib/consent-notice'
import { CONSENT_PURPOSES } from '~/shared/lib/scheduling'

const privacyPage = () => readFile(join(process.cwd(), 'src/routes/_landing/legal/privacy.tsx'), 'utf8')
const termsPage = () => readFile(join(process.cwd(), 'src/routes/_landing/legal/terms.tsx'), 'utf8')

describe('one version, one place', () => {
  it('derives the candidate-facing privacy version from the policy constant', () => {
    // These were two independent literals. Bumping one and forgetting the other would leave every consent
    // receipt pointing at text that was never rendered, and nothing would have failed.
    expect(PRIVACY_POLICY_VERSION).toBe(CURRENT_CONSENT_VERSIONS.privacy)
  })

  it('renders the version rather than a hand-typed string', async () => {
    const source = await privacyPage()
    // The line a reader sees must come from the constant. It was `Version v1.1` in JSX until 2026-07-28.
    expect(source).toMatch(/Version \{CURRENT_CONSENT_VERSIONS\.privacy\}/)
    expect(source).not.toMatch(/Version v\d/)
  })

  it('went to a new major, so a v1.x acceptance cannot carry', () => {
    // `isMaterialVersionChange` compares only the major part. A v1.2 would have let every existing acceptance
    // stand, holding people to text about their CV and their recorded words that they never saw.
    expect(CURRENT_CONSENT_VERSIONS.privacy.startsWith('v2')).toBe(true)
  })

  it('bumped the candidate notice, because its text materially changed', () => {
    // Changing this invalidates existing candidate consent by design — which is the correct outcome when the
    // notice gains transcription and AI processing.
    expect(CANDIDATE_NOTICE_VERSION).not.toBe('2026-07-01')
  })
})

describe('the privacy policy says what the system actually does', () => {
  const required: Array<[string, RegExp]> = [
    ['names the controller as the interviewing company', /interviewing you decides why your data is processed and is the <strong>controller<\/strong>/],
    ['names BuilderHunt as processor', /BuilderHunt is their <strong>processor<\/strong>/],
    ['covers uploaded documents', /Documents you upload/],
    ['covers approved public-web import', /Public links you submit/],
    ['states robots.txt is honoured', /robots\.txt/],
    ['names the platforms that stay link-only', /LinkedIn, X, Facebook, Instagram/],
    ['states audio is never stored', /audio itself is never stored/],
    ['states the transcript is stored', /The <em>text<\/em> is stored/],
    ['covers AI assistance', /AI assistance/],
    ['names consent as the legal basis', /Your <strong>consent<\/strong>, for each of the four purposes/],
    ['says boxes are never pre-ticked', /never pre-ticked/],
    ['says booking is not agreement', /Booking a time is not agreement/],
    ['names the ten-second withdrawal stop', /within ten seconds/],
    ['says withdrawal is not retroactive', /not\s+retroactive/],
    ['names Deepgram and its EU endpoint', /Deepgram.*api\.eu\.deepgram\.com/s],
    ['names Mistral and its region', /Mistral, EU/],
    ['names the storage provider', /Cloudflare R2/],
    ['states no training', /trains anyone&apos;s model/],
    ['states document retention', /180 days/],
    ['states transcript retention', /90 days/],
    ['states consent-receipt retention', /24 months/],
    ['states there is no automated decision', /not subject to a decision based solely on automated processing/],
    ['admits the AI can be wrong', /AI output can be wrong/],
    ['offers a correction and human-review path', /ask for a human to review/],
    ['lists the data-subject rights', /Access, correction, deletion, restriction, objection, and portability/],
    ['names a contact address', /privacy@builderhunt\.dev/],
    ['explains credit billing', /1 credit per minute/],
  ]

  it.each(required)('%s', async (_label, pattern) => {
    expect(await privacyPage()).toMatch(pattern)
  })

  it('does not describe booking consent as covering future processing', async () => {
    const source = await privacyPage()
    // The one sentence a consent notice must never contain. spec.md: booking consent is not permission for
    // unrelated later processing.
    expect(source).not.toMatch(/by booking[^.]*you (also )?(agree|consent)/i)
    // And the page says so explicitly, rather than merely omitting the claim.
    expect(source).toMatch(/no single &quot;accept all&quot;/)
  })

  it('has a section for every consent purpose the portal can record', async () => {
    const source = await privacyPage()
    // A purpose the code can record but the notice never describes is consent to nothing.
    const described: Record<string, RegExp> = {
      terms_and_privacy: /Privacy Policy|these terms/i,
      candidate_document_processing: /Documents you upload/,
      public_web_import: /Public links you submit/,
      ai_interview_assistance: /AI assistance/,
      live_audio_transcription: /Live transcription/,
    }
    for (const purpose of CONSENT_PURPOSES) {
      expect(described[purpose], `no notice text for the "${purpose}" purpose`).toBeDefined()
      expect(source, `the notice does not describe "${purpose}"`).toMatch(described[purpose])
    }
  })
})

describe('no accept-all exists anywhere in the consent API', () => {
  it('has no such field in any request schema', async () => {
    // The prose promise is only worth what the API enforces: a single field that grants every purpose at once
    // would make each separate, unticked box decorative. Asserted across the schemas rather than one route,
    // because the next route to be added is the one that would carry it.
    const sources = await Promise.all([
      readFile(join(process.cwd(), 'src/shared/lib/interview-api.ts'), 'utf8'),
      readFile(join(process.cwd(), 'src/shared/lib/scheduling.ts'), 'utf8'),
    ])
    for (const source of sources) {
      expect(source).not.toMatch(/acceptAll|accept_all|allPurposes|consentToAll/i)
    }
  })
})

describe('the terms cover the operator’s obligations', () => {
  const required: Array<[string, RegExp]> = [
    ['names the customer as controller', /You are the controller of any candidate data/],
    ['requires a lawful basis', /responsible for having a lawful basis/],
    ['forbids transcription without consent', /must not use transcription without the candidate having agreed/],
    ['forbids sourcing against a platform’s terms', /whose terms forbid it/],
    ['states AI output is a draft', /AI output is a draft/],
    ['forbids deciding solely on AI output', /make a decision solely on it/],
    ['states audio is never stored', /audio is never stored/],
  ]

  it.each(required)('%s', async (_label, pattern) => {
    expect(await termsPage()).toMatch(pattern)
  })

  it('numbers its sections without a gap or a repeat', async () => {
    const source = await termsPage()
    const numbers = [...source.matchAll(/heading: '(\d+)\./g)].map((match) => Number(match[1]))
    // Adding a section by hand is exactly how a document ends up with two section 11s.
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_unused, index) => index + 1))
  })
})
