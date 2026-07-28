/**
 * The first case below is the one that matters, and it is here because the first implementation got
 * it wrong.
 *
 * Every hard-blocked connector in `policies.ts` has `allowedHosts: []` — correct, since nothing may
 * be fetched from them — so resolving a host against the source registry finds nothing for
 * `linkedin.com`. That version let a LinkedIn URL fall through to the personal-site branch, where an
 * ownership attestation promoted it to `authorized_crawl`: the single rule the module exists to
 * enforce, inverted by an empty array. A test asserting only "a personal site with an attestation is
 * importable" would have passed.
 */
import { describe, expect, it } from 'vitest'
import { HARD_BLOCKED_CONNECTOR_IDS } from '~/lib/enrichment/policies'
import {
  LINK_AUTHORIZATION_NOTICE_VERSION,
  decisionPermitsFetch,
  resolveLinkImportPolicy,
} from '~/lib/scheduling/link-import-policy'

const attested = { attested: true, attestedNoticeVersion: LINK_AUTHORIZATION_NOTICE_VERSION }

describe('a candidate cannot waive a platform’s terms', () => {
  it.each([
    ['https://www.linkedin.com/in/someone', 'linkedin'],
    ['https://linkedin.com/in/someone', 'linkedin'],
    ['https://lnkd.in/abc123', 'linkedin'],
    ['https://x.com/someone', 'x'],
    ['https://twitter.com/someone', 'x'],
    ['https://www.facebook.com/someone', 'facebook'],
    ['https://m.facebook.com/someone', 'facebook'],
    ['https://www.instagram.com/someone', 'instagram'],
  ])('refuses to fetch %s even with a valid ownership attestation', (normalizedUrl, connectorId) => {
    const result = resolveLinkImportPolicy({ normalizedUrl, ...attested })

    expect(result.decision).toBe('user_submitted')
    expect(result.connectorId).toBe(connectorId)
    expect(result.reason).toBe('platform_terms_forbid_import')
    // The assertion that actually protects anything: no fetch, whatever the candidate consented to.
    expect(decisionPermitsFetch(result.decision)).toBe(false)
  })

  it('keeps the link as evidence rather than discarding it', () => {
    // `user_submitted`, not `not_importable`: a reviewer can still open the URL by hand, which is a
    // different thing from us crawling it.
    const result = resolveLinkImportPolicy({ normalizedUrl: 'https://linkedin.com/in/x', attested: false })
    expect(result.decision).toBe('user_submitted')
  })
})

describe('every hard-blocked platform is actually reachable by host', () => {
  it.each(HARD_BLOCKED_CONNECTOR_IDS.map((id) => [id]))(
    'resolves at least one url to the %s block',
    (connectorId) => {
      // The invariant the module asserts at load time, restated as a test so a fifth platform added
      // to HARD_BLOCKED_CONNECTOR_IDS without hosts fails here too — not only in whichever process
      // happens to import the module first.
      const probes: Record<string, string> = {
        linkedin: 'https://linkedin.com/in/x',
        x: 'https://x.com/x',
        facebook: 'https://facebook.com/x',
        instagram: 'https://instagram.com/x',
      }
      const url = probes[connectorId]
      expect(url, `no probe url for hard-blocked connector '${connectorId}'`).toBeDefined()
      const result = resolveLinkImportPolicy({ normalizedUrl: url, ...attested })
      expect(result.connectorId).toBe(connectorId)
      expect(decisionPermitsFetch(result.decision)).toBe(false)
    },
  )
})

describe('a registry source decides its own mode', () => {
  it('permits an official API source without any attestation', () => {
    const result = resolveLinkImportPolicy({ normalizedUrl: 'https://github.com/someone', attested: false })
    expect(result.decision).toBe('official_api')
    expect(result.connectorId).toBe('github')
    expect(decisionPermitsFetch(result.decision)).toBe(true)
  })

  it('matches a subdomain of a registered host', () => {
    const result = resolveLinkImportPolicy({ normalizedUrl: 'https://api.github.com/users/someone', attested: false })
    expect(result.connectorId).toBe('github')
  })
})

describe('a candidate’s own site needs a current attestation', () => {
  const url = 'https://someone.dev/projects'

  it('is url-only until they attest', () => {
    const result = resolveLinkImportPolicy({ normalizedUrl: url, attested: false })
    expect(result.decision).toBe('user_submitted')
    expect(result.reason).toBe('attestation_required')
    expect(decisionPermitsFetch(result.decision)).toBe(false)
  })

  it('becomes crawlable once they do', () => {
    const result = resolveLinkImportPolicy({ normalizedUrl: url, ...attested })
    expect(result.decision).toBe('authorized_crawl')
    expect(result.connectorId).toBeNull()
    expect(decisionPermitsFetch(result.decision)).toBe(true)
  })

  it('does not accept an attestation made against superseded text', () => {
    // Consent to words nobody showed is not consent. Re-asking is the honest handling.
    const result = resolveLinkImportPolicy({
      normalizedUrl: url,
      attested: true,
      attestedNoticeVersion: '2020-01-01.1',
    })
    expect(result.decision).toBe('user_submitted')
    expect(result.reason).toBe('attestation_notice_outdated')
  })

  it('does not accept an attestation with no version at all', () => {
    const result = resolveLinkImportPolicy({ normalizedUrl: url, attested: true, attestedNoticeVersion: null })
    expect(result.reason).toBe('attestation_notice_outdated')
  })
})

describe('anything unrecognised fails closed', () => {
  it.each([
    ['http, not https', 'http://someone.dev/'],
    ['a bare scheme', 'ftp://someone.dev/'],
    ['not a url at all', 'someone.dev'],
    ['a hostname with no dot', 'https://intranet/'],
  ])('refuses %s', (_label, normalizedUrl) => {
    const result = resolveLinkImportPolicy({ normalizedUrl, ...attested })
    expect(result.decision).toBe('not_importable')
    expect(decisionPermitsFetch(result.decision)).toBe(false)
  })

  it('only ever permits a fetch for the two authorized modes', () => {
    expect(decisionPermitsFetch('official_api')).toBe(true)
    expect(decisionPermitsFetch('authorized_crawl')).toBe(true)
    expect(decisionPermitsFetch('user_submitted')).toBe(false)
    expect(decisionPermitsFetch('not_importable')).toBe(false)
  })
})
