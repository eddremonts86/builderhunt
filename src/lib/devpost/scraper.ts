/**
 * Devpost has no API, and plain server-side `fetch` gets a 202 bot-challenge
 * page instead of data (verified live — see plans/implemented/19-devpost-integration/
 * spec.md). A real browser session gets through (verified live via the
 * Browser pane during this feature's design: devpost.com renders full
 * project/team/profile data to a JS-executing client). These functions do the
 * actual page interaction with a caller-supplied Playwright `Page`; they are
 * kept separate from worker.ts's orchestration (cursor, caps, upsert) so the
 * DOM-scraping logic can be swapped independently if Devpost's markup changes.
 *
 * Selectors below were read directly off the live site's rendered DOM, not
 * guessed from docs (Devpost publishes none):
 *  - Search results: `a.block-wrapper-link.link-to-software[href]`
 *  - Project team members: `#app-team li.software-team-member a.user-profile-link[href]`
 *  - Profile page: `h1` (contains "DISPLAY NAME\n(username)"), `.software-entry`/`[id^=software_]`
 *    count for project count, `#user-bio`/`.user-bio` for bio (often absent).
 */
import type { Page } from 'playwright'

export interface ScrapedProject {
  slug: string
  url: string
}

export interface ScrapedProfile {
  username: string
  displayName: string | null
  avatarUrl: string | null
  bio: string | null
  projectsCount: number
}

const PROJECT_URL_RE = /^https:\/\/devpost\.com\/software\/[a-z0-9][a-z0-9-]*$/i
const PROFILE_URL_RE = /^https:\/\/devpost\.com\/([a-z0-9_-]+)$/i
// Devpost account/nav paths that match the profile URL shape but aren't people.
const PROFILE_URL_EXCLUDE = new Set(['settings', 'software', 'hackathons', 'users', 'notifications'])

/**
 * Devpost serves an initial 202 bot-challenge response to a headless browser
 * too (not just plain `fetch`) — verified live: the challenge's own JS does a
 * second, client-side reload of the same URL once it decides the session is
 * real, which is what a real user's browser would also experience as a brief
 * "checking your browser"-style delay. `waitUntil: 'load'` alone races that
 * second reload (observed live as Playwright's "Execution context was
 * destroyed, most likely because of a navigation"), so this also waits for
 * network activity to settle and retries the DOM read once if the challenge
 * reload lands mid-read.
 */
async function gotoAndSettle(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'load', timeout: 20000 })
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null)
  await page.waitForTimeout(500)
}

async function withChallengeRetry<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('Execution context was destroyed')) throw error
    await new Promise((resolve) => setTimeout(resolve, 1000))
    return read()
  }
}

export async function scrapeSearchResultsPage(page: Page, keyword: string, pageNum: number): Promise<ScrapedProject[]> {
  const url = `https://devpost.com/software/search?query=${encodeURIComponent(keyword)}&page=${pageNum}`
  await gotoAndSettle(page, url)
  const hrefs = await withChallengeRetry(() =>
    page.$$eval('a.block-wrapper-link.link-to-software', (as) => as.map((a) => (a as HTMLAnchorElement).href)),
  )
  const unique = [...new Set(hrefs)].filter((href) => PROJECT_URL_RE.test(href))
  return unique.map((url) => ({ slug: url.replace('https://devpost.com/software/', ''), url }))
}

export async function scrapeProjectTeamUsernames(page: Page, projectUrl: string): Promise<string[]> {
  await gotoAndSettle(page, projectUrl)
  const hrefs = await withChallengeRetry(() =>
    page.$$eval('#app-team li.software-team-member a.user-profile-link', (as) => as.map((a) => (a as HTMLAnchorElement).href)),
  )
  const usernames = hrefs
    .map((href) => PROFILE_URL_RE.exec(href)?.[1])
    .filter((username): username is string => username !== undefined && !PROFILE_URL_EXCLUDE.has(username))
  return [...new Set(usernames)]
}

export async function scrapeProfile(page: Page, username: string): Promise<ScrapedProfile> {
  await gotoAndSettle(page, `https://devpost.com/${encodeURIComponent(username)}`)
  return withChallengeRetry(() =>
    page.evaluate((username) => {
      const h1 = document.querySelector('h1')
      // Devpost renders "DISPLAY NAME\n                (username)" — strip the trailing "(username)".
      const rawName = h1?.textContent?.trim() ?? null
      const displayName = rawName ? rawName.replace(/\s*\(.*\)\s*$/, '').trim() || null : null
      const bioEl = document.querySelector('#user-bio') || document.querySelector('.user-bio') || document.querySelector('[itemprop="description"]')
      const bio = bioEl?.textContent?.trim() || null
      const avatarEl = document.querySelector('img.user-photo') as HTMLImageElement | null
      const avatarUrl = avatarEl?.src || null
      const projectsCount = document.querySelectorAll('.software-entry, [id^="software_"]').length
      return { username, displayName, avatarUrl, bio, projectsCount }
    }, username),
  )
}
