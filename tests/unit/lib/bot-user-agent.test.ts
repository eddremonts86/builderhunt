import { readFile, readdir, access } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every outbound request this product makes to somebody else's site announces itself as
 * `BuilderHuntBot` and carries a `+URL`. That URL is the only way a site owner who sees the bot in
 * their logs can find out who we are and how to ask us to stop, so it has to resolve and it has to
 * be the same everywhere.
 *
 * Three places name it — `env.ENRICHMENT_USER_AGENT`'s default,
 * `ENRICHMENT_DEFAULT_USER_AGENT` in the enrichment network client, and the Devpost worker's
 * browser-shaped variant — and nothing compared them. On 2026-08-13 the Devpost one was found
 * announcing `+https://builderhunt.eduardoinerarte.dk/about`: a hostname retired four days earlier
 * (it answers `503 no available server`) and a path that has never existed on any host. Two of the
 * three copies had been updated; the third was a dead link on both counts, and had been for as long
 * as the connector existed.
 *
 * `env.security.test.ts` already rejects an `ENRICHMENT_USER_AGENT` with no contact URL at all —
 * that is a schema rule about the env var, and it cannot see a hardcoded literal. This is the check
 * that spans the copies.
 */

const CANONICAL_CONTACT_URL = 'https://builderhunt.dev/crawler'

/** The route that has to answer on the other end of that URL. */
const CONTACT_PAGE_ROUTE_FILE = 'src/routes/_landing/crawler.tsx'

/**
 * Matches the `+URL` in either shape the product uses:
 *   `BuilderHuntBot/1.0 (+https://…)`                      — the plain bot UA
 *   `Mozilla/5.0 (compatible; BuilderHuntBot/1.0; +https://…)` — the headless-browser variant
 * Deliberately not anchored to a specific separator, so a fourth shape still gets checked.
 */
const BOT_CONTACT_URL = /BuilderHuntBot\/[\d.]+[^)]*?\+(https?:\/\/[^\s)]+)/g

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return collectSourceFiles(full)
      return /\.tsx?$/.test(entry.name) ? [full] : []
    }),
  )
  return files.flat()
}

describe('BuilderHuntBot contact URL', () => {
  it('is identical in every source file that announces the bot', async () => {
    const sources = await collectSourceFiles('src')

    const declarations: { file: string; url: string }[] = []
    for (const file of sources) {
      const source = await readFile(file, 'utf8')
      for (const match of source.matchAll(BOT_CONTACT_URL)) {
        declarations.push({ file, url: match[1] })
      }
    }

    // Guards against the failure mode where the regex stops matching and the test passes by
    // examining nothing. The three known call sites plus the page that documents the string.
    expect(declarations.length).toBeGreaterThanOrEqual(3)

    const wrong = declarations.filter((d) => d.url !== CANONICAL_CONTACT_URL)
    expect(wrong, `these announce a contact URL that is not ${CANONICAL_CONTACT_URL}`).toEqual([])
  })

  it('names a page that exists in the router', async () => {
    // A `+URL` pointing at a 404 fails the webmaster just as completely as one pointing at a dead
    // host — which is exactly what `/about` was.
    expect(new URL(CANONICAL_CONTACT_URL).pathname).toBe('/crawler')
    await expect(access(CONTACT_PAGE_ROUTE_FILE)).resolves.toBeUndefined()
  })
})
