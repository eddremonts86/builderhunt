/**
 * Devpost ingestion worker (plan: devpost-integration).
 *
 * Devpost has no API and bot-challenges plain server-side `fetch`, so this is
 * the one source connector backed by a real headless-browser crawl instead
 * of a live per-search HTTP call — per `plans/_meta/app-reality.md`
 * constraint #3, it runs as a cron-triggered worker
 * (src/routes/api/admin/devpost/run-worker.ts) writing into the durable
 * `devpost_profiles` table; `src/lib/sources/devpost.ts` only ever reads
 * that table at search time.
 *
 * One run: launch Chromium once, scrape one page of search results for the
 * cursor's current keyword, visit each project's team page to collect
 * member usernames, then visit each new member's profile — all with a
 * politeness delay between navigations and hard per-run caps
 * (env.DEVPOST_PROJECTS_PER_RUN / DEVPOST_PROFILES_PER_RUN), since every
 * request risks a ban with no published rate limit to target. A single
 * project/profile failing is logged and skipped, never aborts the run (same
 * convention as src/lib/discovery/worker.ts).
 */
import { chromium } from 'playwright'
import { env } from '~/shared/lib/env'
import { log } from '~/shared/lib/log'
import { DEVPOST_KEYWORDS } from './keywords'
import { scrapeProjectTeamUsernames, scrapeProfile, scrapeSearchResultsPage } from './scraper'
import {
  loadDevpostIngestionState,
  saveDevpostIngestionState,
  upsertDevpostProfile,
} from '~/shared/lib/repositories/devpost-profiles'

export interface DevpostWorkerResult {
  disabled: boolean
  keyword: string | null
  page: number | null
  projectsSeen: number
  profilesUpserted: number
  errors: number
  advancedToNextKeyword: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runDevpostWorker(): Promise<DevpostWorkerResult> {
  if (env.DEVPOST_ENABLED !== 'true') {
    return { disabled: true, keyword: null, page: null, projectsSeen: 0, profilesUpserted: 0, errors: 0, advancedToNextKeyword: false }
  }

  const state = await loadDevpostIngestionState()
  const keywordIndex = ((state.keywordIndex % DEVPOST_KEYWORDS.length) + DEVPOST_KEYWORDS.length) % DEVPOST_KEYWORDS.length
  const keyword = DEVPOST_KEYWORDS[keywordIndex]
  const pageNum = Math.max(1, state.page)

  let projectsSeen: number
  let profilesUpserted = 0
  let errors = 0
  const usernames = new Set<string>()

  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (compatible; BuilderHuntBot/1.0; +https://builderhunt.eduardoinerarte.dk/about)' })
    try {
      // A single flaky navigation on the search page (observed live: Devpost
      // occasionally serves an extra client-side redirect that destroys the
      // page's execution context mid-read) must not fail the whole run — same
      // degrade-to-empty philosophy as every per-item catch below.
      let projects: Awaited<ReturnType<typeof scrapeSearchResultsPage>> = []
      try {
        projects = await scrapeSearchResultsPage(page, keyword, pageNum)
      } catch (error) {
        errors += 1
        log.error('devpost_worker_search_error', { keyword, page: pageNum, error: error instanceof Error ? error.message : String(error) })
      }
      const toVisit = projects.slice(0, env.DEVPOST_PROJECTS_PER_RUN)
      projectsSeen = toVisit.length

      for (const project of toVisit) {
        try {
          await sleep(env.DEVPOST_REQUEST_DELAY_MS)
          const members = await scrapeProjectTeamUsernames(page, project.url)
          members.forEach((username) => usernames.add(username))
        } catch (error) {
          errors += 1
          log.error('devpost_worker_project_error', { slug: project.slug, error: error instanceof Error ? error.message : String(error) })
        }
      }

      const usernamesToVisit = [...usernames].slice(0, env.DEVPOST_PROFILES_PER_RUN)
      for (const username of usernamesToVisit) {
        try {
          await sleep(env.DEVPOST_REQUEST_DELAY_MS)
          const profile = await scrapeProfile(page, username)
          await upsertDevpostProfile({
            username: profile.username,
            displayName: profile.displayName,
            avatarUrl: profile.avatarUrl,
            bio: profile.bio,
            profileUrl: `https://devpost.com/${username}`,
            projectsCount: profile.projectsCount,
            topics: [keyword],
          })
          profilesUpserted += 1
        } catch (error) {
          errors += 1
          log.error('devpost_worker_profile_error', { username, error: error instanceof Error ? error.message : String(error) })
        }
      }
    } finally {
      await page.close()
    }
  } finally {
    await browser.close()
  }

  // Fewer projects than the per-run cap means this page is exhausted (or the
  // keyword returned little) — move on to the next keyword rather than
  // re-requesting an empty tail every run.
  const advancedToNextKeyword = projectsSeen < env.DEVPOST_PROJECTS_PER_RUN
  const nextState = advancedToNextKeyword
    ? { ...state, keywordIndex: keywordIndex + 1, page: 1 }
    : { ...state, keywordIndex, page: pageNum + 1 }
  nextState.stats = {
    runs: state.stats.runs + 1,
    projectsSeen: state.stats.projectsSeen + projectsSeen,
    profilesUpserted: state.stats.profilesUpserted + profilesUpserted,
    errors: state.stats.errors + errors,
  }
  await saveDevpostIngestionState(nextState)

  const report: DevpostWorkerResult = { disabled: false, keyword, page: pageNum, projectsSeen, profilesUpserted, errors, advancedToNextKeyword }
  log.info('devpost_worker_run', { ...report })
  return report
}
