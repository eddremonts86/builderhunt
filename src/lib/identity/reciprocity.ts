/**
 * Turning declared cross-links into deterministic ones (plan 43 Phase 3, "Implement reversible identity
 * linking" — the producer that was missing).
 *
 * ## The test
 *
 * A GitHub profile saying "my site is example.com" proves nothing: anyone can type any URL into a profile
 * field. What makes it evidence is **reciprocity** — if example.com links back to that exact GitHub profile,
 * then whoever controls the domain has asserted the account is theirs. Two independent statements, each from
 * a party that can only speak for itself, and together they establish one controller.
 *
 * The domain is the anchor, which is what makes this compose. Fetch example.com once, and *every* account it
 * links back to is proven to share a controller with the domain — and therefore with each other. One request
 * can unify a GitHub, a dev.to and a Codeberg account.
 *
 * ## What it will not do
 *
 * A one-directional declaration stays `probabilistic` and goes to the review queue. `decideLink` is
 * unchanged and remains the only thing that decides; this module only produces signals for it. The
 * `human_source_links_probabilistic_needs_review_check` constraint is still there as the backstop.
 *
 * Nothing here infers. There is no similarity, no scoring, no threshold. A page either contains a link to a
 * profile URL or it does not.
 *
 * ## Measured expectations
 *
 * Probed against 20 real GitHub profiles: 75% declare a site or a social handle, and 46% of the reachable
 * sites link back — so roughly 30% of accounts anchor on the first hop. `rel="me"`, the IndieAuth
 * microformat this was expected to use, matched **zero** of them, so it is accepted as a stronger variant
 * where present and never required.
 */
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm'
import { resolveTxt } from 'node:dns/promises'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { publicDb } from '~/shared/lib/db/client'
import { ENTITY_DETAIL_LIMIT } from '~/shared/lib/db/read-bounds'
import { workerDb } from '~/shared/lib/db/worker-db'
import { builderIdentities, identityDeclaredLinks } from '~/shared/lib/db/schema'
import { ENRICHMENT_DEFAULT_USER_AGENT, SafeFetchError, safeFetch } from '~/lib/enrichment/network'
import { isPathAllowedByRobots } from '~/lib/enrichment/robots'
import { isDomainBackedBlueskyHandle } from './declared-links'
import { log } from '~/shared/lib/log'

/** Domains checked per run. Bounded so one invocation cannot become a crawl. */
const DEFAULT_DOMAIN_LIMIT = 25
/** Links extracted from one page. A page with ten thousand links is not a personal site. */
const MAX_PAGE_LINKS = 2000

export interface VerifyReciprocityOptions {
  domainLimit?: number
  /** Reads through the app role, writes through the worker role — verification is a worker's job. */
  readDb?: PostgresJsDatabase
  writeDb?: PostgresJsDatabase
  now?: Date
}

export interface ReciprocityResult {
  domainsChecked: number
  /** Accounts whose declaration the target confirmed. These are the auto-linkable ones. */
  reciprocal: number
  /** Accounts whose declared domain was fetched and did not link back. Not a lie, just not proof. */
  contradicted: number
  /** Domains that could not be fetched or that robots refused. Deliberately not `contradicted`. */
  unreachable: number
  /** Bluesky domain handles confirmed by a `_atproto` DNS record. */
  dnsVerified: number
  /** Groups of two or more accounts proven to share one controller by the same domain. */
  controllerGroups: Array<{ domain: string; builderIdentityIds: string[] }>
}

/**
 * Verifies pending website declarations.
 *
 * Grouped by domain rather than iterated per declaration, because the expensive part is the fetch and two
 * accounts declaring the same site must not fetch it twice.
 */
export async function verifyReciprocity(options: VerifyReciprocityOptions = {}): Promise<ReciprocityResult> {
  const readDb = options.readDb ?? publicDb
  const writeDb = options.writeDb ?? workerDb
  const now = options.now ?? new Date()

  const result: ReciprocityResult = {
    domainsChecked: 0, reciprocal: 0, contradicted: 0, unreachable: 0, dnsVerified: 0, controllerGroups: [],
  }

  const pending = await loadPendingWebsiteDeclarations(readDb, options.domainLimit ?? DEFAULT_DOMAIN_LIMIT)
  for (const [domain, claimants] of pending) {
    result.domainsChecked += 1
    const outcome = await checkDomain(domain, claimants)

    if (outcome.kind === 'unreachable') {
      result.unreachable += claimants.length
      await markDeclarations(writeDb, claimants.map((c) => c.declaredLinkId), 'unreachable', outcome.detail, null)
      continue
    }

    const reciprocalIds = outcome.reciprocal.map((entry) => entry.declaredLinkId)
    const contradictedIds = claimants
      .filter((c) => !reciprocalIds.includes(c.declaredLinkId))
      .map((c) => c.declaredLinkId)

    if (reciprocalIds.length > 0) {
      await markDeclarations(writeDb, reciprocalIds, 'reciprocal', outcome.detail, now)
      result.reciprocal += reciprocalIds.length
      result.controllerGroups.push({
        domain,
        builderIdentityIds: outcome.reciprocal.map((entry) => entry.builderIdentityId),
      })
    }
    if (contradictedIds.length > 0) {
      await markDeclarations(writeDb, contradictedIds, 'contradicted', 'Site did not link back to this profile', null)
      result.contradicted += contradictedIds.length
    }
  }

  // Direct account-to-account pairs, found before anything is fetched. See `verifyDirectCrossLinks`: this is
  // the cheapest and strongest signal in the whole design and it costs one query.
  const direct = await verifyDirectCrossLinks(readDb, writeDb, now)
  result.reciprocal += direct.reciprocal
  result.controllerGroups.push(...direct.groups)

  result.dnsVerified = await verifyBlueskyDomainHandles(readDb, writeDb, now)

  log.info('identity_reciprocity_run', {
    domainsChecked: result.domainsChecked,
    reciprocal: result.reciprocal,
    contradicted: result.contradicted,
    unreachable: result.unreachable,
    dnsVerified: result.dnsVerified,
    controllerGroups: result.controllerGroups.length,
  })
  return result
}

interface Claimant {
  declaredLinkId: string
  builderIdentityId: string
  source: string
  username: string
  profileUrl: string
}

/**
 * Website declarations still awaiting a check, grouped by domain.
 *
 * Only `person` identities. A repository declaring a homepage describes a project, and treating that as an
 * identity anchor would make every contributor look like one controller.
 *
 * Only `declared`: a `contradicted` or `reciprocal` row has already been answered, and re-fetching every
 * domain on every run would be a crawl rather than a verification.
 */
async function loadPendingWebsiteDeclarations(
  db: PostgresJsDatabase,
  domainLimit: number,
): Promise<Map<string, Claimant[]>> {
  const pending = and(
    eq(identityDeclaredLinks.linkKind, 'website'),
    eq(identityDeclaredLinks.verificationState, 'declared'),
    eq(builderIdentities.kind, 'person'),
  )

  // Choose the domains first, in SQL.
  //
  // `domainLimit` was always the real bound — the run only ever checks that many domains — but it was
  // applied to a JavaScript array *after* every pending declaration in the table had been loaded,
  // grouped into a Map and sorted. So the read grew with the whole verification backlog while the work
  // stayed constant, and the ranking rule ("domains claimed by more than one account first") is one
  // `count(*) DESC` away from being the database's job.
  //
  // `normalizedValue` breaks ties so the choice is deterministic across runs — with `count(*)` alone,
  // two domains claimed once each swap places between runs and the cursor-less worker re-checks one it
  // already did while never reaching the other.
  const domains = await db
    .select({ normalizedValue: identityDeclaredLinks.normalizedValue, claimants: count() })
    .from(identityDeclaredLinks)
    .innerJoin(builderIdentities, eq(builderIdentities.id, identityDeclaredLinks.builderIdentityId))
    .where(pending)
    .groupBy(identityDeclaredLinks.normalizedValue)
    .orderBy(desc(count()), asc(identityDeclaredLinks.normalizedValue))
    .limit(domainLimit)

  if (domains.length === 0) return new Map()
  const chosen = domains.map((row) => row.normalizedValue)

  // Then the claimants, for those domains only.
  const rows = await db
    .select({
      declaredLinkId: identityDeclaredLinks.id,
      normalizedValue: identityDeclaredLinks.normalizedValue,
      builderIdentityId: builderIdentities.id,
      source: builderIdentities.source,
      username: builderIdentities.username,
      profileUrl: builderIdentities.profileUrl,
    })
    .from(identityDeclaredLinks)
    .innerJoin(builderIdentities, eq(builderIdentities.id, identityDeclaredLinks.builderIdentityId))
    .where(and(pending, inArray(identityDeclaredLinks.normalizedValue, chosen)))
    .orderBy(identityDeclaredLinks.normalizedValue, identityDeclaredLinks.firstSeenAt)
    // The claimants of `domainLimit` domains. `ENTITY_DETAIL_LIMIT` per domain is the same ceiling a
    // per-entity list gets everywhere else: a domain claimed by more accounts than that is evidence to
    // investigate, not a set to page through.
    .limit(domainLimit * ENTITY_DETAIL_LIMIT)

  // Insertion order follows `chosen`, so the caller still sees the most-claimed domains first.
  const byDomain = new Map<string, Claimant[]>(chosen.map((domain) => [domain, []]))
  for (const row of rows) {
    byDomain.get(row.normalizedValue)?.push({
      declaredLinkId: row.declaredLinkId,
      builderIdentityId: row.builderIdentityId,
      source: row.source,
      username: row.username,
      profileUrl: row.profileUrl,
    })
  }
  return byDomain
}

type DomainOutcome =
  | { kind: 'checked'; reciprocal: Claimant[]; detail: string }
  | { kind: 'unreachable'; detail: string }

/**
 * Fetches one domain and works out which claimants it links back to.
 *
 * `www.` is tried as a fallback because a bare apex that does not serve HTTP is common, and a person whose
 * site only answers on `www` has not failed to declare anything.
 */
async function checkDomain(domain: string, claimants: readonly Claimant[]): Promise<DomainOutcome> {
  const hosts = [domain, `www.${domain}`]
  for (const host of hosts) {
    const origin = `https://${host}`

    const robots = await isPathAllowedByRobots(origin, '/', ENRICHMENT_DEFAULT_USER_AGENT)
    // `no_robots_file` is permission — RFC 9309 §2.3.1.3 says a 4xx on /robots.txt allows every resource, and
    // most personal sites have no robots.txt at all. `unavailable` now means only "we asked and got no
    // answer", which is not permission.
    if (robots === 'disallowed') return { kind: 'unreachable', detail: 'robots.txt disallows the homepage' }
    if (robots === 'unavailable') continue

    let response
    try {
      response = await safeFetch(origin, {
        // Both spellings: a redirect from apex to www (or the reverse) is revalidated against this list, so
        // omitting one kills the request on its first hop.
        allowedHosts: [domain, `www.${domain}`],
        userAgent: ENRICHMENT_DEFAULT_USER_AGENT,
      })
    } catch (error) {
      if (error instanceof SafeFetchError && host === hosts[hosts.length - 1]) {
        return { kind: 'unreachable', detail: `fetch refused: ${error.code}` }
      }
      continue
    }
    if (response.status !== 200) continue

    const links = extractLinks(response.body)
    const reciprocal = claimants.filter((claimant) => linksToProfile(links, claimant.profileUrl))
    // `rel="me"` is recorded when present because it is the stronger, intentional form of the same statement
    // — but it is not required: it matched zero of twenty real developer sites.
    const relMe = extractRelMeLinks(response.body)
    const viaRelMe = reciprocal.filter((claimant) => linksToProfile(relMe, claimant.profileUrl)).length
    return {
      kind: 'checked',
      reciprocal,
      detail: `Site at ${origin} links back to ${reciprocal.length}/${claimants.length} declaring accounts`
        + (viaRelMe > 0 ? `, ${viaRelMe} via rel="me"` : ''),
    }
  }
  return { kind: 'unreachable', detail: 'no reachable host' }
}

/** Every `href` on the page, bounded. A regex rather than a DOM parse: the question is only "does this
 * string appear as a link target", and a parser would be a larger surface for no extra answer. */
export function extractLinks(html: string): string[] {
  const links: string[] = []
  const pattern = /href\s*=\s*["']([^"']{1,500})["']/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null && links.length < MAX_PAGE_LINKS) {
    links.push(match[1])
  }
  return links
}

/** Links carrying `rel="me"` — the IndieAuth/Mastodon verification microformat. */
export function extractRelMeLinks(html: string): string[] {
  const links: string[] = []
  const patterns = [
    /<a[^>]+rel=["'][^"']*\bme\b[^"']*["'][^>]*href=["']([^"']{1,500})["']/gi,
    /<a[^>]+href=["']([^"']{1,500})["'][^>]*rel=["'][^"']*\bme\b/gi,
    /<link[^>]+rel=["'][^"']*\bme\b[^"']*["'][^>]*href=["']([^"']{1,500})["']/gi,
  ]
  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(html)) !== null && links.length < MAX_PAGE_LINKS) links.push(match[1])
  }
  return links
}

/**
 * Whether any link on the page points at exactly this profile.
 *
 * Exact path match after normalizing, and the exactness matters: `github.com/alice/some-repo` must **not**
 * count as a link to `github.com/alice`. A person's site linking to one of their repositories is not the
 * site's owner claiming the account — and accepting it would make every project's README-linked site
 * "reciprocal" with whoever owns the repo.
 */
export function linksToProfile(links: readonly string[], profileUrl: string): boolean {
  const target = normalizeForComparison(profileUrl)
  if (!target) return false
  return links.some((link) => normalizeForComparison(link) === target)
}

/** Host plus path, lowercased, no scheme, no `www.`, no query, no trailing slash. */
function normalizeForComparison(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) return ''
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed.replace(/^\/\//, '')}`
  try {
    const url = new URL(candidate)
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    const path = url.pathname.replace(/\/+$/, '')
    return `${host}${path}`
  } catch {
    return ''
  }
}

async function markDeclarations(
  db: PostgresJsDatabase,
  ids: readonly string[],
  state: 'reciprocal' | 'contradicted' | 'unreachable' | 'dns_verified',
  detail: string,
  verifiedAt: Date | null,
): Promise<void> {
  if (ids.length === 0) return
  await db
    .update(identityDeclaredLinks)
    .set({
      verificationState: state,
      // The constraint requires a stamp for a verified state, and it is load-bearing rather than bookkeeping:
      // an unstamped `reciprocal` cannot be aged out, and a reciprocity that was true two years ago is not
      // evidence today.
      verifiedAt,
      verificationDetail: detail.slice(0, 500),
      lastSeenAt: new Date(),
    })
    .where(inArray(identityDeclaredLinks.id, [...ids]))
}

/**
 * Finds pairs of accounts that each name the other, using only a SQL join.
 *
 * The purest form of the reciprocity test and the cheapest: GitHub's `benhalpern` publishes
 * `blog: https://dev.to/ben`, dev.to's `ben` publishes `github_username: benhalpern`. Neither statement is
 * evidence alone — anyone can name any account — but each is published by a party that can only speak for
 * itself, so together they establish one controller. No page is fetched, no domain is involved, and no
 * heuristic is applied: either both rows exist or they do not.
 *
 * A declaration matching an identity in only one direction is left `declared`, which is correct. It is a
 * claim, `decideLink` routes claims to review, and the review queue is where a human decides.
 *
 * The join is on `(source, lower(username))` because a declaration stores the handle, not our internal id —
 * a profile says "my GitHub is benhalpern", and resolving that to a row is this query's job.
 */
async function verifyDirectCrossLinks(
  readDb: PostgresJsDatabase,
  writeDb: PostgresJsDatabase,
  now: Date,
): Promise<{ reciprocal: number; groups: Array<{ domain: string; builderIdentityIds: string[] }> }> {
  const rows = await readDb.execute<{
    a_link_id: string
    b_link_id: string
    a_identity: string
    b_identity: string
    a_label: string
    b_label: string
  }>(sql`
    select
      la.id            as a_link_id,
      lb.id            as b_link_id,
      ia.id            as a_identity,
      ib.id            as b_identity,
      ia.source || ':' || ia.username as a_label,
      ib.source || ':' || ib.username as b_label
    from identity_declared_links la
    join builder_identities ia on ia.id = la.builder_identity_id and ia.kind = 'person'
    -- The account that declaration names: same platform as its kind, same handle.
    join builder_identities ib on ib.source = la.link_kind and lower(ib.username) = la.normalized_value
                              and ib.kind = 'person'
    -- ...and that account naming the first one back.
    join identity_declared_links lb on lb.builder_identity_id = ib.id
                                   and lb.link_kind = ia.source
                                   and lb.normalized_value = lower(ia.username)
    where la.link_kind <> 'website'
      and (la.verification_state = 'declared' or lb.verification_state = 'declared')
      -- One row per unordered pair. Without this the same pair appears twice with the sides swapped.
      and ia.id < ib.id
  `)

  const linkIds: string[] = []
  const groups: Array<{ domain: string; builderIdentityIds: string[] }> = []
  for (const row of rows) {
    linkIds.push(row.a_link_id, row.b_link_id)
    // `domain` names what proved the link, and here it is the pair itself rather than a site. Recorded in the
    // same shape so the unifier needs no second code path.
    groups.push({ domain: `${row.a_label} <-> ${row.b_label}`, builderIdentityIds: [row.a_identity, row.b_identity] })
  }
  if (linkIds.length > 0) {
    await markDeclarations(writeDb, linkIds, 'reciprocal', 'Both accounts publicly name each other', now)
  }
  return { reciprocal: linkIds.length, groups }
}

/**
 * Confirms Bluesky domain handles against DNS.
 *
 * The strongest signal available without a fetch. To hold the handle `pfrazee.com` the account must publish
 * `_atproto.pfrazee.com TXT "did=did:plc:..."` — verified against the live network — so a matching record is
 * proof that whoever controls the domain controls the account. No page needs to be read and no link needs to
 * be found.
 *
 * The DID must match the one the account declared. A domain with an `_atproto` record pointing at a
 * *different* DID is evidence of the opposite: the domain's owner has designated another account.
 */
async function verifyBlueskyDomainHandles(
  readDb: PostgresJsDatabase,
  writeDb: PostgresJsDatabase,
  now: Date,
): Promise<number> {
  const rows = await readDb
    .select({
      declaredLinkId: identityDeclaredLinks.id,
      domain: identityDeclaredLinks.normalizedValue,
      builderIdentityId: builderIdentities.id,
      declaredDid: sql<string | null>`(
        select l2.normalized_value from identity_declared_links l2
        where l2.builder_identity_id = ${builderIdentities.id} and l2.link_kind = 'bluesky_did' limit 1
      )`,
    })
    .from(identityDeclaredLinks)
    .innerJoin(builderIdentities, eq(builderIdentities.id, identityDeclaredLinks.builderIdentityId))
    .where(and(
      eq(identityDeclaredLinks.linkKind, 'bluesky_handle'),
      eq(identityDeclaredLinks.verificationState, 'declared'),
      eq(builderIdentities.source, 'bluesky'),
    ))
    .limit(50)

  let verified = 0
  for (const row of rows) {
    if (!row.declaredDid) continue
    /**
     * Only handles that are actually domain claims.
     *
     * A `.bsky.social` handle is a name the platform assigned, not an assertion about a domain — there is
     * nothing to verify and no DNS record could exist. The first run spent 17 lookups on them and then filed
     * them `unreachable`, which reads as "we tried and failed" about something that was never a claim. Left
     * `declared`, which is what they are: the account's name, recorded.
     */
    if (!isDomainBackedBlueskyHandle(row.domain)) continue
    let records: string[][]
    try {
      records = await resolveTxt(`_atproto.${row.domain}`)
    } catch {
      // NXDOMAIN or no record. The handle may still be verified through `/.well-known/atproto-did`, which is
      // the other method ATProto permits — so this is `unreachable`, not `contradicted`. Claiming the domain
      // contradicted the handle would be a stronger statement than the evidence supports.
      await markDeclarations(writeDb, [row.declaredLinkId], 'unreachable', 'no _atproto TXT record', null)
      continue
    }
    const declared = records.flat().map((value) => value.trim().replace(/^did=/, '').toLowerCase())
    if (declared.includes(row.declaredDid.toLowerCase())) {
      await markDeclarations(writeDb, [row.declaredLinkId], 'dns_verified', `_atproto TXT matches ${row.declaredDid}`, now)
      verified += 1
    } else {
      await markDeclarations(writeDb, [row.declaredLinkId], 'contradicted', '_atproto TXT designates a different account', null)
    }
  }
  return verified
}
