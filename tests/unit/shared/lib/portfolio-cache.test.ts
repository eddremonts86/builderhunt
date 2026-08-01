import { afterEach, describe, expect, it } from 'vitest'
import { getCachedPortfolio, purgePortfolioCache, setCachedPortfolio } from '~/shared/lib/portfolio-cache'
import type { PublicPortfolio } from '~/shared/lib/portfolio'

const SAMPLE: PublicPortfolio = {
  claimId: 'claim_1',
  source: 'github',
  username: 'octocat',
  displayName: 'The Octocat',
  avatarUrl: null,
  profileUrl: 'https://github.com/octocat',
  theme: 'default',
  headline: 'Ships Rust CLIs',
  introduction: '',
  projects: [],
  publishedAt: '2026-07-26T00:00:00.000Z',
  aiPersona: null,
}

describe('portfolio cache (in-memory fallback — no REDIS_URL in test env)', () => {
  afterEach(async () => {
    await purgePortfolioCache('claim_1')
  })

  it('returns null before anything is cached', async () => {
    expect(await getCachedPortfolio('claim_1')).toBeNull()
  })

  it('round-trips a set value', async () => {
    await setCachedPortfolio('claim_1', SAMPLE)
    expect(await getCachedPortfolio('claim_1')).toEqual(SAMPLE)
  })

  it('purge removes the cached value', async () => {
    await setCachedPortfolio('claim_1', SAMPLE)
    await purgePortfolioCache('claim_1')
    expect(await getCachedPortfolio('claim_1')).toBeNull()
  })

  it('keys are per-claim — purging one does not affect another', async () => {
    await setCachedPortfolio('claim_1', SAMPLE)
    await setCachedPortfolio('claim_2', { ...SAMPLE, claimId: 'claim_2' })
    await purgePortfolioCache('claim_1')
    expect(await getCachedPortfolio('claim_1')).toBeNull()
    expect(await getCachedPortfolio('claim_2')).not.toBeNull()
    await purgePortfolioCache('claim_2')
  })
})
