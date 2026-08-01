/**
 * Extracting and normalizing the cross-source links an account declares about itself.
 *
 * Pure and synchronous: what counts as a declaration, and when two declarations are the same declaration,
 * is the decision that determines whether two accounts can ever be recognised as one person. It belongs in
 * a function you can read and test, not spread across fifteen connectors.
 *
 * ## The point of normalizing
 *
 * Reciprocity is found by joining declarations on their value. So `https://Example.com/`, `example.com` and
 * `http://www.example.com/#about` have to become one string, or the join finds nothing and the whole
 * mechanism reports that nobody declares anything. Every normalization here exists because a real profile
 * in this repository's own database is written that way.
 *
 * ## What a declaration is not
 *
 * It is not evidence. Anyone can put any URL in a GitHub profile, so a declaration alone is a *claim* by
 * that account. It becomes deterministic only when the target links back — see
 * `src/lib/identity/reciprocity.ts`. Nothing here decides anything about identity; `decideLink` still does,
 * and it still refuses to auto-link anything probabilistic.
 */
import type { DeclaredLinkKind } from '~/shared/lib/db/schema'

export interface DeclaredLink {
  linkKind: DeclaredLinkKind
  /** Exactly what the source published. */
  rawValue: string
  /** The comparable form. Empty means the raw value was not usable and the link is dropped. */
  normalizedValue: string
}

/**
 * Hosts that are never an identity anchor, even when a profile declares one.
 *
 * A GitHub profile whose `blog` is `https://twitter.com/someone` is declaring a social account, not a site
 * it controls — and treating a platform profile as a "website" would make every account that links to the
 * same platform look like it shares a controller with every other. Link shorteners are excluded for the
 * opposite reason: the value tells us nothing until resolved, and resolving it is a redirect chain we would
 * be following on a third party's behalf.
 *
 * Platform links are still captured, just under their own `linkKind` where the handle is what matters.
 */
const NON_ANCHOR_HOSTS = new Set([
  'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'linkedin.com',
  'github.com', 'gitlab.com', 'bsky.app', 'mastodon.social', 'medium.com',
  'dev.to', 'hashnode.com', 'youtube.com', 'tiktok.com', 'discord.gg',
  'bit.ly', 't.co', 'tinyurl.com', 'lnkd.in', 'linktr.ee',
])

/**
 * Platform hosts a declared URL can be resolved *into an account reference* on.
 *
 * The counterpart to `NON_ANCHOR_HOSTS`, and the reason rejecting those hosts is not the end of the story.
 * GitHub's `benhalpern` publishes `blog: https://dev.to/ben` while dev.to's `ben` publishes
 * `github_username: benhalpern` — each account naming the other. That is reciprocity in its purest form, it
 * needs no domain and no HTTP request, and the first version of this file discarded it because `dev.to` is
 * not a website anchor.
 *
 * A platform URL is not a weak website claim. It is a precise statement about one account, so it becomes a
 * declaration of that platform's own kind carrying the handle — which a SQL join can then match against a
 * real identity.
 *
 * `linkedin`, `facebook` and the other hard-blocked platforms are deliberately absent: this product holds no
 * identities from them, so such a declaration could never be resolved and would only be an unmatched row
 * about a person on a service we do not read.
 */
const PLATFORM_PROFILE_HOSTS: Readonly<Record<string, DeclaredLinkKind>> = Object.freeze({
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'codeberg.org': 'codeberg',
  'dev.to': 'devto',
  'lobste.rs': 'lobsters',
  'hashnode.com': 'hashnode',
  'stackoverflow.com': 'stackoverflow',
  'twitter.com': 'twitter',
  'x.com': 'twitter',
  'bsky.app': 'bluesky_handle',
})

/**
 * Reads a declared URL as a reference to one platform account.
 *
 * Returns null unless the URL is a *profile* — a single path segment on a known host. `github.com/alice/repo`
 * is a repository, not a person, and `dev.to/ben/some-article` is an article. Accepting either would attach a
 * project or a blog post to whoever happened to link it.
 *
 * `bsky.app/profile/<handle>` is the one host with a prefix segment, handled explicitly rather than by a rule
 * that would loosen the single-segment requirement for every other host.
 */
export function resolvePlatformProfile(value: string): { linkKind: DeclaredLinkKind; handle: string } | null {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 300) return null
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const linkKind = PLATFORM_PROFILE_HOSTS[host]
  if (!linkKind) return null

  const segments = url.pathname.split('/').filter(Boolean)
  const raw = host === 'bsky.app'
    ? (segments[0] === 'profile' && segments.length === 2 ? segments[1] : null)
    : (segments.length === 1 ? segments[0] : null)
  if (!raw) return null

  const handle = normalizeHandle(raw)
  return handle.length > 0 ? { linkKind, handle } : null
}

/**
 * Normalizes a declared website to a bare registrable-ish host.
 *
 * Host only — no path, no scheme, no query. A person's site is the anchor; which page they linked to is
 * not part of their identity, and keeping the path would make `example.com/about` and `example.com` two
 * different anchors. `www.` is stripped for the same reason.
 *
 * Returns the empty string for anything that cannot be an anchor: a non-HTTP scheme, a bare word with no
 * dot, an IP address, or a platform host from the list above.
 */
export function normalizeWebsite(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 300) return ''
  // Profiles routinely omit the scheme ("sindresorhus.com"), and `new URL` refuses that.
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`

  let host: string
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
    host = url.hostname.toLowerCase()
  } catch {
    return ''
  }

  if (host.startsWith('www.')) host = host.slice(4)
  // A host with no dot is not a domain, and an IP literal is not an identity anchor anyone controls in the
  // sense that matters here.
  if (!host.includes('.') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return ''
  if (NON_ANCHOR_HOSTS.has(host)) return ''
  return host
}

/**
 * Normalizes a platform handle.
 *
 * Profiles write these every way imaginable: `@name`, `name`, `https://twitter.com/name`,
 * `twitter.com/name/`. All of them mean one handle, so all of them have to normalize to it — otherwise two
 * accounts declaring the same person's Twitter would not join.
 */
export function normalizeHandle(value: string): string {
  let handle = value.trim().toLowerCase()
  if (handle.length === 0 || handle.length > 120) return ''
  // A full URL: take the first path segment, which is the handle on every platform this is used for.
  if (/^https?:\/\//.test(handle) || handle.includes('/')) {
    const withoutScheme = handle.replace(/^https?:\/\//, '')
    const segments = withoutScheme.split('/').filter(Boolean)
    handle = segments.length > 1 ? segments[1] : segments[0] ?? ''
  }
  handle = handle.replace(/^@+/, '').replace(/[?#].*$/, '')
  // Mastodon handles arrive as `@user@instance.tld`; the instance is part of the identity, so it stays.
  if (!/^[a-z0-9._@-]{1,120}$/.test(handle)) return ''
  return handle
}

/**
 * Handles the network serves that look like domains but are not.
 *
 * `handle.invalid` is ATProto's sentinel for an account whose handle **failed** verification — confirmed
 * against the live network: `resolveHandle?handle=handle.invalid` answers "Unable to resolve handle" and no
 * `_atproto` TXT record exists for it. It appeared in a real search of this repository's own connector.
 *
 * Treating it as a domain anchor would be exactly backwards, and the failure mode is the worst one available:
 * every account with a broken handle shares this same string, so it would become a single anchor that merges
 * an unbounded number of unrelated people into one canonical human.
 */
const BLUESKY_NON_HANDLES = new Set(['handle.invalid', 'invalid.handle'])

/**
 * A Bluesky handle that is a domain is a special case worth its own kind.
 *
 * To hold the handle `pfrazee.com` on Bluesky you must publish `_atproto.pfrazee.com TXT "did=..."` or serve
 * `/.well-known/atproto-did` — verified against the live network. That makes it the only handle in this file
 * whose control is provable without fetching a page, which is why the resolver can mark it `dns_verified`
 * rather than merely `declared`.
 *
 * A handle ending in `.bsky.social` is a platform-assigned name and carries no such proof.
 */
export function isDomainBackedBlueskyHandle(handle: string): boolean {
  const normalized = handle.trim().toLowerCase()
  if (BLUESKY_NON_HANDLES.has(normalized)) return false
  if (!normalized.includes('.') || normalized.endsWith('.bsky.social')) return false
  return normalizeWebsite(normalized) === normalized
}

/**
 * Records a declared website, or — when the value is a platform profile — the account it names instead.
 *
 * Falling through rather than dropping is what keeps GitHub's `blog: https://dev.to/ben` usable. The website
 * kind rejects it because a platform host is not a domain anchor; the platform resolver turns it into exactly
 * what it is.
 */
function pushWebsiteOrProfile(links: DeclaredLink[], raw: unknown): void {
  if (typeof raw !== 'string' || raw.trim().length === 0) return
  const asWebsite = normalizeWebsite(raw)
  if (asWebsite.length > 0) {
    pushValue(links, 'website', raw.trim(), asWebsite)
    return
  }
  const profile = resolvePlatformProfile(raw)
  if (profile) pushValue(links, profile.linkKind, raw.trim(), profile.handle)
}

function pushValue(links: DeclaredLink[], linkKind: DeclaredLinkKind, rawValue: string, normalizedValue: string): void {
  if (links.some((link) => link.linkKind === linkKind && link.normalizedValue === normalizedValue)) return
  links.push({ linkKind, rawValue, normalizedValue })
}

function push(links: DeclaredLink[], linkKind: DeclaredLinkKind, raw: unknown, normalize: (value: string) => string): void {
  // Numbers are accepted because Stack Exchange's `account_id` is one, and stringifying at the call site
  // would mean every caller remembering to handle null and undefined first.
  if (typeof raw === 'number' && Number.isFinite(raw)) raw = String(raw)
  if (typeof raw !== 'string') return
  const rawValue = raw.trim()
  if (rawValue.length === 0) return
  const normalizedValue = normalize(rawValue)
  if (normalizedValue.length === 0) return
  // A source can publish the same value in two fields; the caller upserts on
  // (identity, kind, normalized), so a duplicate here is harmless but pointless.
  if (links.some((link) => link.linkKind === linkKind && link.normalizedValue === normalizedValue)) return
  links.push({ linkKind, rawValue, normalizedValue })
}

/**
 * Pulls declared links out of one connector's `RawBuilder.metadata`.
 *
 * Reads *our* metadata rather than a raw upstream body, which is why each case lists two spellings where the
 * connector renamed a field: dev.to's `github_username` is stored as `github`, and a future connector rewrite
 * should not silently stop producing declarations. `payload.x ?? payload.y` covers both without guessing
 * across sources — `blog` on GitHub is `website_url` on dev.to and `website` on Codeberg, and a shared
 * field-name guess would pick up whatever a future API happens to name similarly.
 *
 * Sources absent from this switch declare nothing usable, measured against each live API on 2026-08-01
 * rather than assumed: GitLab and Hugging Face expose no website or social field on their public user object,
 * SourceHut and Product Hunt require a bearer token, Reddit refused the request, and Hacker News offers only
 * free prose in `about`.
 */
export function extractDeclaredLinks(source: string, payload: Record<string, unknown>): DeclaredLink[] {
  const links: DeclaredLink[] = []

  switch (source) {
    case 'github':
      pushWebsiteOrProfile(links, payload.blog)
      push(links, 'twitter', payload.twitterUsername ?? payload.twitter_username, normalizeHandle)
      break

    case 'devto':
      pushWebsiteOrProfile(links, payload.websiteUrl ?? payload.website_url)
      push(links, 'twitter', payload.twitter ?? payload.twitter_username, normalizeHandle)
      // The strongest thing dev.to publishes: a direct statement of which GitHub account is theirs.
      push(links, 'github', payload.github ?? payload.github_username, normalizeHandle)
      break

    case 'lobsters':
      push(links, 'github', payload.githubUsername ?? payload.github_username, normalizeHandle)
      push(links, 'mastodon', payload.mastodonUsername ?? payload.mastodon_username, normalizeHandle)
      break

    case 'codeberg':
      pushWebsiteOrProfile(links, payload.website)
      break

    case 'bluesky': {
      const handle = typeof payload.handle === 'string' ? payload.handle.trim().toLowerCase() : ''
      if (handle.length > 0 && !BLUESKY_NON_HANDLES.has(handle)) {
        push(links, 'bluesky_handle', handle, normalizeHandle)
        // A domain handle is also a website declaration, and the one whose control DNS can prove.
        if (isDomainBackedBlueskyHandle(handle)) push(links, 'website', handle, normalizeWebsite)
      }
      // The DID is the account's stable identifier — it survives a handle change, so it is the right key for
      // recognising the same Bluesky account after a rename.
      push(links, 'bluesky_did', payload.did, (value) => (value.startsWith('did:') ? value.toLowerCase() : ''))
      break
    }

    case 'stackoverflow':
      pushWebsiteOrProfile(links, payload.websiteUrl ?? payload.website_url)
      // Stack Exchange's own account id, shared across every site in its network. First-party and
      // authoritative: the platform itself asserts these accounts are one person, which makes this the only
      // signal here that needs no reciprocity check at all.
      push(links, 'stackexchange_account', payload.accountId === undefined ? payload.account_id : payload.accountId,
        (value) => (/^\d{1,15}$/.test(value) ? value : ''))
      break
  }

  return links
}

/**
 * Sources that publish a usable declaration, measured against each live API on 2026-08-01.
 *
 * Kept as data so a coverage report can state what the mechanism can and cannot reach, rather than leaving
 * that to be inferred from the switch above.
 */
export const DECLARED_LINK_SOURCES: Readonly<Record<string, readonly DeclaredLinkKind[]>> = Object.freeze({
  github: ['website', 'twitter'],
  devto: ['website', 'twitter', 'github'],
  lobsters: ['github', 'mastodon'],
  codeberg: ['website'],
  bluesky: ['bluesky_handle', 'bluesky_did', 'website'],
  stackoverflow: ['website', 'stackexchange_account'],
})
