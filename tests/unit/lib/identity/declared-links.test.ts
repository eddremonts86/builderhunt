/**
 * Extraction and normalization of self-declared cross-links.
 *
 * This is the file that decides whether two accounts can ever be recognised as one person, so every case
 * here comes from a real profile or a real API response observed on 2026-08-01 — not from imagining how
 * someone might write a URL.
 */
import { describe, expect, it } from 'vitest'
import {
  DECLARED_LINK_SOURCES,
  extractDeclaredLinks,
  isDomainBackedBlueskyHandle,
  normalizeHandle,
  normalizeWebsite,
} from '~/lib/identity/declared-links'

describe('a website normalizes to a bare host', () => {
  it('collapses the ways one site is actually written', () => {
    // Reciprocity is found by joining on this value. If these do not collapse to one string the join finds
    // nothing and the whole mechanism reports that nobody declares anything.
    for (const written of [
      'https://steveklabnik.com', 'http://steveklabnik.com', 'steveklabnik.com',
      'https://www.steveklabnik.com/', 'https://steveklabnik.com/about#bio',
      '  https://STEVEKLABNIK.com  ',
    ]) {
      expect(normalizeWebsite(written), written).toBe('steveklabnik.com')
    }
  })

  it('keeps a subdomain, because it is a different site', () => {
    expect(normalizeWebsite('https://rusty1s.github.io')).toBe('rusty1s.github.io')
  })

  it('rejects a platform profile passed off as a website', () => {
    // A GitHub profile whose `blog` is a Twitter URL is declaring a social account, not a site it controls.
    // Treating it as a website anchor would make everyone who links to that platform share a controller.
    for (const platform of [
      'https://twitter.com/someone', 'https://github.com/someone',
      'https://linkedin.com/in/someone', 'https://linktr.ee/someone', 'https://bit.ly/abc',
    ]) {
      expect(normalizeWebsite(platform), platform).toBe('')
    }
  })

  it('rejects what cannot be an anchor', () => {
    expect(normalizeWebsite('')).toBe('')
    // An empty `blog` field is what GitHub returns for a user who set nothing, and it appeared in a real
    // search of this repository's own connector.
    expect(normalizeWebsite('   ')).toBe('')
    expect(normalizeWebsite('not-a-domain')).toBe('')
    expect(normalizeWebsite('https://192.168.1.10')).toBe('')
    expect(normalizeWebsite('ftp://example.com')).toBe('')
    expect(normalizeWebsite(`https://${'a'.repeat(400)}.com`)).toBe('')
  })
})

describe('a handle normalizes to a bare handle', () => {
  it('collapses the ways one handle is written', () => {
    for (const written of ['rusty1s', '@rusty1s', 'https://twitter.com/rusty1s', 'twitter.com/rusty1s/', 'RUSTY1S']) {
      expect(normalizeHandle(written), written).toBe('rusty1s')
    }
  })

  it('keeps the instance on a Mastodon handle, because it is part of the identity', () => {
    // `@alice@fosstodon.org` and `@alice@mastodon.social` are two different people.
    expect(normalizeHandle('@alice@fosstodon.org')).toBe('alice@fosstodon.org')
  })

  it('rejects junk rather than storing an unmatchable value', () => {
    expect(normalizeHandle('')).toBe('')
    expect(normalizeHandle('a name with spaces')).toBe('')
    expect(normalizeHandle('<script>')).toBe('')
  })
})

describe('a Bluesky domain handle is the one signal DNS can prove', () => {
  it('recognises a domain handle', () => {
    // Holding `pfrazee.com` requires publishing `_atproto.pfrazee.com TXT "did=..."`, verified against the
    // live network — so the handle itself is evidence of domain control.
    expect(isDomainBackedBlueskyHandle('pfrazee.com')).toBe(true)
    expect(isDomainBackedBlueskyHandle('jacob.gold')).toBe(true)
  })

  it('rejects a platform-assigned handle', () => {
    expect(isDomainBackedBlueskyHandle('someone.bsky.social')).toBe(false)
    expect(isDomainBackedBlueskyHandle('nodots')).toBe(false)
  })

  it('rejects handle.invalid, which is the marker of a FAILED verification', () => {
    /**
     * ATProto serves `handle.invalid` for an account whose handle could not be resolved — confirmed live:
     * `resolveHandle?handle=handle.invalid` answers "Unable to resolve handle" and no `_atproto` record
     * exists. It turned up in a real Bluesky search from this repository's own connector.
     *
     * Accepting it would be exactly backwards, and the failure mode is the worst one available: every
     * account with a broken handle shares this one string, so it would become a single anchor merging an
     * unbounded number of unrelated people into one canonical human.
     */
    expect(isDomainBackedBlueskyHandle('handle.invalid')).toBe(false)
    const links = extractDeclaredLinks('bluesky', { handle: 'handle.invalid', did: 'did:plc:abc' })
    expect(links.map((link) => link.linkKind)).toEqual(['bluesky_did'])
  })
})

describe('extraction reads each source on its own terms', () => {
  it('reads GitHub blog and twitter', () => {
    // Both come from `/users/{login}` — the search endpoint sends neither, which is why hydration exists.
    const links = extractDeclaredLinks('github', {
      blog: 'https://steveklabnik.com', twitterUsername: 'steveklabnik', publicRepos: 300,
    })
    expect(links).toEqual([
      { linkKind: 'website', rawValue: 'https://steveklabnik.com', normalizedValue: 'steveklabnik.com' },
      { linkKind: 'twitter', rawValue: 'steveklabnik', normalizedValue: 'steveklabnik' },
    ])
  })

  it('reads the connector field names, not only the API ones', () => {
    // dev.to's `github_username` is stored as `github` by this repository's connector. Both spellings are
    // accepted so a connector rewrite cannot silently stop producing declarations.
    expect(extractDeclaredLinks('devto', { github: 'benhalpern' })[0]?.normalizedValue).toBe('benhalpern')
    expect(extractDeclaredLinks('devto', { github_username: 'benhalpern' })[0]?.normalizedValue).toBe('benhalpern')
  })

  it('reads the strongest thing dev.to publishes', () => {
    const links = extractDeclaredLinks('devto', {
      websiteUrl: 'http://benhalpern.com', twitter: 'bendhalpern', github: 'benhalpern',
    })
    expect(links.map((link) => link.linkKind).sort()).toEqual(['github', 'twitter', 'website'])
  })

  it('reads a Stack Exchange account id, which needs no reciprocity at all', () => {
    // The platform itself asserts these accounts are one person, so it is first-party and authoritative
    // rather than a claim the account makes about itself.
    const links = extractDeclaredLinks('stackoverflow', { accountId: 22656, websiteUrl: 'example.com' })
    expect(links).toContainEqual({ linkKind: 'stackexchange_account', rawValue: '22656', normalizedValue: '22656' })
  })

  it('turns a Bluesky domain handle into a website declaration as well as a handle', () => {
    const links = extractDeclaredLinks('bluesky', { handle: 'jacob.gold', did: 'did:plc:tpg43qhh4lw4ksiffs4nbda3' })
    expect(links.map((link) => link.linkKind).sort()).toEqual(['bluesky_did', 'bluesky_handle', 'website'])
  })

  it('does not turn a platform-assigned Bluesky handle into a website', () => {
    const links = extractDeclaredLinks('bluesky', { handle: 'someone.bsky.social', did: 'did:plc:abc' })
    expect(links.map((link) => link.linkKind).sort()).toEqual(['bluesky_did', 'bluesky_handle'])
  })

  it('returns nothing for a source that declares nothing usable', () => {
    // Measured, not assumed: GitLab and Hugging Face expose no website or social field on their public user
    // object, and Hacker News offers only free prose.
    for (const source of ['gitlab', 'huggingface', 'hn', 'reddit', 'npm']) {
      expect(extractDeclaredLinks(source, { website: 'example.com', blog: 'example.com' }), source).toEqual([])
    }
  })

  it('drops a declaration that normalizes to nothing', () => {
    // An empty `blog` is what GitHub returns for a user who set none, and it appeared in real results.
    expect(extractDeclaredLinks('github', { blog: '', twitterUsername: null })).toEqual([])
  })

  it('does not emit the same declaration twice', () => {
    const links = extractDeclaredLinks('devto', { websiteUrl: 'https://x.dev', website_url: 'http://www.x.dev/' })
    expect(links.filter((link) => link.linkKind === 'website')).toHaveLength(1)
  })
})

describe('the coverage table matches the extractor', () => {
  it('lists a kind for every source the extractor handles, and no others', () => {
    // Kept as data so a coverage report can state what the mechanism reaches, rather than leaving that to be
    // inferred from a switch statement.
    for (const [source, kinds] of Object.entries(DECLARED_LINK_SOURCES)) {
      expect(kinds.length, source).toBeGreaterThan(0)
    }
    // A source in the table must actually produce something for at least one plausible payload.
    const probe: Record<string, Record<string, unknown>> = {
      github: { blog: 'a.dev' },
      devto: { github: 'x' },
      lobsters: { githubUsername: 'x' },
      codeberg: { website: 'a.dev' },
      bluesky: { did: 'did:plc:x' },
      stackoverflow: { accountId: 1 },
    }
    for (const source of Object.keys(DECLARED_LINK_SOURCES)) {
      expect(extractDeclaredLinks(source, probe[source] ?? {}).length, source).toBeGreaterThan(0)
    }
  })
})
