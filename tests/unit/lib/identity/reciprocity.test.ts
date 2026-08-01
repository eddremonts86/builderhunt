/**
 * Reciprocity verification and unification.
 *
 * The safety property here is the one that matters most in the whole product: a wrong link merges two real
 * people, attributes one person's work to the other, and makes the loser unfindable. So the test that earns
 * its place is the negative one — `rustdesk.com`, declared by 25 unrelated GitHub accounts in this
 * repository's own first real run, must unify none of them.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'

const mocks = vi.hoisted(() => ({ safeFetch: vi.fn(), isPathAllowedByRobots: vi.fn(), resolveTxt: vi.fn() }))

vi.mock('~/lib/enrichment/network', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/enrichment/network')>()
  return { ...actual, safeFetch: mocks.safeFetch }
})
vi.mock('~/lib/enrichment/robots', () => ({ isPathAllowedByRobots: mocks.isPathAllowedByRobots }))
/**
 * Partial mock, not a replacement. `url-policy.ts` — reached through `safeFetch` — imports the module's
 * default export for its SSRF lookup, so a bare `{ resolveTxt }` breaks the import chain rather than the
 * function under test.
 */
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>()
  return { ...actual, default: actual, resolveTxt: mocks.resolveTxt }
})

const { extractLinks, extractRelMeLinks, linksToProfile, verifyReciprocity } = await import('~/lib/identity/reciprocity')
const { unifyControllerGroups } = await import('~/lib/identity/unify')

let db: PostgresJsDatabase
let drop: () => Promise<void>

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('identity_reciprocity')
  db = disposable.db
  drop = disposable.drop
}, 180_000)

afterAll(async () => { await drop() })

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.isPathAllowedByRobots.mockResolvedValue('no_robots_file')
  mocks.resolveTxt.mockRejectedValue(new Error('NXDOMAIN'))
  await db.execute(sql`
    truncate human_merge_events, human_source_links, canonical_humans, identity_declared_links,
             builder_source_snapshots, builder_identities cascade
  `)
})

async function identity(id: string, source: string, username: string, kind = 'person'): Promise<void> {
  await db.execute(sql`
    insert into builder_identities (id, source, source_id, username, kind, profile_url)
    values (${id}, ${source}, ${id}, ${username}, ${kind}, ${`https://${source === 'github' ? 'github.com' : `${source}.test`}/${username}`})
  `)
}

async function declare(id: string, identityId: string, kind: string, value: string): Promise<void> {
  await db.execute(sql`
    insert into identity_declared_links (id, builder_identity_id, link_kind, raw_value, normalized_value)
    values (${id}, ${identityId}, ${kind}, ${value}, ${value})
  `)
}

function pageLinking(...urls: string[]) {
  mocks.safeFetch.mockResolvedValue({
    status: 200,
    contentType: 'text/html',
    body: `<html><body>${urls.map((url) => `<a href="${url}">x</a>`).join('')}</body></html>`,
    finalUrl: 'https://site.test/',
  })
}

const run = () => verifyReciprocity({ readDb: db, writeDb: db })

describe('a shared domain is not a shared identity', () => {
  it('unifies none of 25 accounts that all declared the same site', async () => {
    /**
     * This happened. `rustdesk.com` was declared by 25 GitHub accounts on the first real run — names like
     * `joyjoyiwvm` and `talexa723w2`, which is what a spam campaign looks like. A "same declared domain means
     * same person" heuristic would have merged 25 unrelated people into one canonical human, and reciprocity
     * is precisely what stops it: the site links back to none of them.
     */
    for (let index = 0; index < 25; index += 1) {
      await identity(`spam-${index}`, 'github', `spammer${index}`)
      await declare(`link-${index}`, `spam-${index}`, 'website', 'rustdesk.com')
    }
    pageLinking('https://rustdesk.com/download', 'https://twitter.com/rustdesk')

    const result = await run()
    expect(result.reciprocal).toBe(0)
    expect(result.contradicted).toBe(25)
    expect(result.controllerGroups).toEqual([])

    const unified = await unifyControllerGroups(result.controllerGroups, { readDb: db, writeDb: db })
    expect(unified.unified).toEqual([])
    const [{ count }] = await db.execute<{ count: number }>(sql`select count(*)::int from canonical_humans`)
    expect(count).toBe(0)
  })

  it('unifies exactly the accounts the site links back to, and no others', async () => {
    await identity('a', 'github', 'alice')
    await identity('b', 'devto', 'alice')
    await identity('c', 'github', 'impostor')
    await declare('la', 'a', 'website', 'alice.dev')
    await declare('lb', 'b', 'website', 'alice.dev')
    await declare('lc', 'c', 'website', 'alice.dev')
    // The site names two of the three. The third declared the domain and the domain did not answer.
    pageLinking('https://github.com/alice', 'https://devto.test/alice')

    const result = await run()
    expect(result.reciprocal).toBe(2)
    expect(result.contradicted).toBe(1)
    expect(result.controllerGroups[0].builderIdentityIds.sort()).toEqual(['a', 'b'])

    const unified = await unifyControllerGroups(result.controllerGroups, { readDb: db, writeDb: db })
    expect(unified.unified).toHaveLength(1)
    expect(unified.unified[0].accountCount).toBe(2)
  })
})

describe('what counts as linking back', () => {
  it('does not accept a link to a repository as a link to its owner', () => {
    // A person's site linking to one of their repositories is not the site's owner claiming the account, and
    // accepting it would make every project's linked site "reciprocal" with whoever owns the repo.
    expect(linksToProfile(['https://github.com/alice/some-repo'], 'https://github.com/alice')).toBe(false)
    expect(linksToProfile(['https://github.com/alice'], 'https://github.com/alice')).toBe(true)
  })

  it('accepts the same profile written differently', () => {
    for (const written of [
      'https://github.com/alice/', 'http://github.com/alice', 'https://www.github.com/alice',
      'https://github.com/alice?tab=repositories', '//github.com/alice',
    ]) {
      expect(linksToProfile([written], 'https://github.com/alice'), written).toBe(true)
    }
  })

  it('does not accept a different account on the same host', () => {
    expect(linksToProfile(['https://github.com/alicia'], 'https://github.com/alice')).toBe(false)
  })

  it('reads rel="me" as the stronger form of the same statement, without requiring it', () => {
    // Measured against 20 real developer sites: `rel="me"` appeared on zero of them. Required, it would find
    // nothing; recorded when present, it is a genuine intent signal.
    const html = '<a rel="me" href="https://github.com/alice">gh</a><a href="https://devto.test/alice">dev</a>'
    expect(extractRelMeLinks(html)).toEqual(['https://github.com/alice'])
    expect(extractLinks(html)).toHaveLength(2)
  })
})

describe('could not check is not the same as checked and failed', () => {
  it('reports unreachable, not contradicted, when the site cannot be fetched', async () => {
    await identity('a', 'github', 'alice')
    await declare('la', 'a', 'website', 'gone.dev')
    const { SafeFetchError } = await import('~/lib/enrichment/network')
    mocks.safeFetch.mockRejectedValue(new SafeFetchError('upstream_error', 'dead', 503))

    const result = await run()
    // `contradicted` would be a claim that the domain's owner declined to confirm the account. Nobody
    // declined anything; the site did not answer.
    expect(result.unreachable).toBe(1)
    expect(result.contradicted).toBe(0)
    const [row] = await db.execute<{ verification_state: string; verified_at: Date | null }>(sql`
      select verification_state, verified_at from identity_declared_links where id = 'la'
    `)
    expect(row.verification_state).toBe('unreachable')
    expect(row.verified_at).toBeNull()
  })

  it('treats a missing robots.txt as permission and a disallow as refusal', async () => {
    await identity('a', 'github', 'alice')
    await declare('la', 'a', 'website', 'alice.dev')
    pageLinking('https://github.com/alice')

    // RFC 9309 §2.3.1.3: a 4xx on /robots.txt permits every resource. Most personal sites have none at all,
    // so refusing here would make the verifier useless.
    mocks.isPathAllowedByRobots.mockResolvedValue('no_robots_file')
    expect((await run()).reciprocal).toBe(1)

    await db.execute(sql`update identity_declared_links set verification_state = 'declared', verified_at = null`)
    mocks.isPathAllowedByRobots.mockResolvedValue('disallowed')
    const refused = await run()
    expect(refused.reciprocal).toBe(0)
    expect(refused.unreachable).toBe(1)
  })
})

describe('two accounts naming each other need no network at all', () => {
  it('finds a bidirectional pair with a query and unifies it', async () => {
    /**
     * The real case this was built from: GitHub's `benhalpern` publishes `blog: https://dev.to/ben`, and
     * dev.to's `ben` publishes `github_username: benhalpern`. Each names the other. The first version of the
     * extractor discarded it, because `dev.to` is not a website anchor — and it is in fact the cheapest and
     * strongest signal available.
     */
    await identity('gh', 'github', 'benhalpern')
    await identity('dt', 'devto', 'ben')
    await declare('l1', 'gh', 'devto', 'ben')
    await declare('l2', 'dt', 'github', 'benhalpern')

    const result = await run()
    // No page was fetched to establish this.
    expect(mocks.safeFetch).not.toHaveBeenCalled()
    expect(result.reciprocal).toBe(2)
    expect(result.controllerGroups[0].builderIdentityIds.sort()).toEqual(['dt', 'gh'])

    const unified = await unifyControllerGroups(result.controllerGroups, { readDb: db, writeDb: db })
    expect(unified.unified).toHaveLength(1)

    const [link] = await db.execute<{ link_method: string; review_state: string; confidence_bps: number }>(sql`
      select link_method, review_state, confidence_bps from human_source_links limit 1
    `)
    expect(link.link_method).toBe('explicit_cross_link')
    expect(link.review_state).toBe('auto_approved')
    // The bidirectional rate from `decideLink`, not the one-way one.
    expect(link.confidence_bps).toBe(9500)
  })

  it('leaves a one-directional declaration alone', async () => {
    // Anyone can name any account. One direction is a claim, and `decideLink` sends claims to review.
    await identity('gh', 'github', 'benhalpern')
    await identity('dt', 'devto', 'ben')
    await declare('l1', 'dt', 'github', 'benhalpern')

    const result = await run()
    expect(result.reciprocal).toBe(0)
    const [row] = await db.execute<{ verification_state: string }>(sql`
      select verification_state from identity_declared_links where id = 'l1'
    `)
    expect(row.verification_state).toBe('declared')
  })
})

describe('a Bluesky domain handle is proven by DNS', () => {
  it('accepts a matching _atproto record', async () => {
    await identity('bs', 'bluesky', 'jacob.gold')
    await declare('lh', 'bs', 'bluesky_handle', 'jacob.gold')
    await declare('ld', 'bs', 'bluesky_did', 'did:plc:tpg43qhh4lw4ksiffs4nbda3')
    mocks.resolveTxt.mockResolvedValue([['did=did:plc:tpg43qhh4lw4ksiffs4nbda3']])

    expect((await run()).dnsVerified).toBe(1)
    const [row] = await db.execute<{ verification_state: string; verified_at: Date | null }>(sql`
      select verification_state, verified_at from identity_declared_links where id = 'lh'
    `)
    expect(row.verification_state).toBe('dns_verified')
    expect(row.verified_at).not.toBeNull()
  })

  it('contradicts a record that designates a different account', async () => {
    await identity('bs', 'bluesky', 'jacob.gold')
    await declare('lh', 'bs', 'bluesky_handle', 'jacob.gold')
    await declare('ld', 'bs', 'bluesky_did', 'did:plc:mine')
    mocks.resolveTxt.mockResolvedValue([['did=did:plc:someoneelse']])

    await run()
    const [row] = await db.execute<{ verification_state: string }>(sql`
      select verification_state from identity_declared_links where id = 'lh'
    `)
    expect(row.verification_state).toBe('contradicted')
  })

  it('does not spend a lookup on a platform-assigned handle', async () => {
    // A `.bsky.social` handle asserts nothing about a domain. The first run filed 17 of them `unreachable`,
    // which reads as "we tried and failed" about something that was never a claim.
    await identity('bs', 'bluesky', 'someone.bsky.social')
    await declare('lh', 'bs', 'bluesky_handle', 'someone.bsky.social')
    await declare('ld', 'bs', 'bluesky_did', 'did:plc:abc')

    await run()
    expect(mocks.resolveTxt).not.toHaveBeenCalled()
    const [row] = await db.execute<{ verification_state: string }>(sql`
      select verification_state from identity_declared_links where id = 'lh'
    `)
    expect(row.verification_state).toBe('declared')
  })
})

describe('unification refuses decisions that are not its to make', () => {
  it('reports a group spanning two existing humans instead of merging them', async () => {
    // Two people the product already treats as separate, now evidenced as one. That is a merge, it affects
    // tenant data pointing at either, and `mergeCanonicalHumans` captures a restore snapshot first — so an
    // operator invokes it, not a verification run.
    await identity('a', 'github', 'alice')
    await identity('b', 'devto', 'alice')
    await db.execute(sql`
      insert into canonical_humans (id) values ('human-1'), ('human-2');
      insert into human_source_links (id, canonical_human_id, builder_identity_id, link_method, review_state, confidence_bps, evidence, valid_from)
      values ('h1', 'human-1', 'a', 'verified_claim', 'auto_approved', 10000, '{}', now()),
             ('h2', 'human-2', 'b', 'verified_claim', 'auto_approved', 10000, '{}', now());
    `)

    const unified = await unifyControllerGroups(
      [{ domain: 'alice.dev', builderIdentityIds: ['a', 'b'] }],
      { readDb: db, writeDb: db },
    )
    expect(unified.unified).toEqual([])
    expect(unified.needsMergeReview).toEqual([{ domain: 'alice.dev', canonicalHumanIds: ['human-1', 'human-2'] }])
  })

  it('joins an existing human rather than minting a second one', async () => {
    await identity('a', 'github', 'alice')
    await identity('b', 'devto', 'alice')
    await db.execute(sql`
      insert into canonical_humans (id) values ('human-1');
      insert into human_source_links (id, canonical_human_id, builder_identity_id, link_method, review_state, confidence_bps, evidence, valid_from)
      values ('h1', 'human-1', 'a', 'verified_claim', 'auto_approved', 10000, '{}', now());
    `)

    const unified = await unifyControllerGroups(
      [{ domain: 'alice.dev', builderIdentityIds: ['a', 'b'] }],
      { readDb: db, writeDb: db },
    )
    // Creating a second and merging later would work, but it mints a canonical human per run and fills the
    // merge history with entries recording nothing but this function's ignorance.
    expect(unified.unified[0].canonicalHumanId).toBe('human-1')
    const [{ count }] = await db.execute<{ count: number }>(sql`select count(*)::int from canonical_humans`)
    expect(count).toBe(1)
  })

  it('does not create a human for a single verified account', async () => {
    // A verified site with one account is a real fact worth recording on the declaration, but there is no
    // second account to unify it with. It becomes worth doing the moment one appears.
    const unified = await unifyControllerGroups(
      [{ domain: 'solo.dev', builderIdentityIds: ['a'] }],
      { readDb: db, writeDb: db },
    )
    expect(unified.singletons).toBe(1)
    expect(unified.unified).toEqual([])
  })
})

describe('repositories are not identity anchors', () => {
  it('ignores a declaration made by a repository', async () => {
    // A repository declaring a homepage describes a project. Treating that as an anchor would make every
    // contributor look like one controller.
    await identity('r', 'github', 'org/project', 'repo')
    await declare('lr', 'r', 'website', 'project.dev')
    pageLinking('https://github.com/org/project')

    const result = await run()
    expect(result.domainsChecked).toBe(0)
    expect(mocks.safeFetch).not.toHaveBeenCalled()
  })
})
