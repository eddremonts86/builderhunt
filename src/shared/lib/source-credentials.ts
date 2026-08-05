import type { SourceName } from '~/lib/sources/types'
import type { env } from '~/shared/lib/env'

/**
 * Which environment variable(s) a source's API refuses to work without.
 *
 * One table, two readers: `/api/admin/integrations` renders `credentialPresent` from it, and
 * `~/lib/search` uses it to report a source `unconfigured` instead of contacting an upstream that is
 * certain to refuse. It was born in the admin route and is here because a second copy would go stale
 * — the same reason `search_sources` is joined into that projection rather than hand-mirrored.
 *
 * **Absent from this map means the API answers without authentication**, which is a claim about the
 * upstream and not an oversight. Verified live 2026-08-05: `hn`, `devto`, `lobsters`, `npm` and
 * `bluesky` answer anonymously; `devpost` reads the local `devpost_profiles` store its cron worker
 * fills and makes no live request at all.
 *
 * Two entries here are *hard* requirements and the rest are not, and the difference is worth
 * knowing before removing one:
 *
 * - `reddit` and `producthunt` return nothing whatsoever without their credentials. Reddit answers
 *   **403 on both** `oauth.reddit.com` and the `www.reddit.com/*.json` fallback the connector still
 *   tries (an HTML block page, not JSON), and Product Hunt's GraphQL answers 401.
 * - `github`, `gitlab`, `codeberg`, `stackoverflow` and `huggingface` all answer anonymously; their
 *   tokens buy quota and, for GitLab, endpoints that are 401 without one. Removing an entry here
 *   would make the admin page claim a source needs nothing, which is false for quota purposes and
 *   is why they stay listed.
 *
 * Confirm a change with `pnpm sources:probe`, which asks each upstream rather than trusting this file.
 */
export const CREDENTIAL_ENV_VARS: Partial<Record<SourceName, Array<keyof typeof env>>> = {
  github: ['GITHUB_TOKEN'],
  gitlab: ['GITLAB_TOKEN'],
  codeberg: ['CODEBERG_TOKEN'],
  reddit: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'],
  stackoverflow: ['STACKOVERFLOW_API_KEY'],
  huggingface: ['HUGGINGFACE_TOKEN'],
  producthunt: ['PRODUCTHUNT_TOKEN'],
}

/**
 * The subset whose upstream returns **nothing at all** unauthenticated, so contacting it without a
 * credential is a guaranteed wasted request reported as an honest-looking empty result.
 *
 * Deliberately narrower than `CREDENTIAL_ENV_VARS`: GitHub, GitLab, Codeberg, Stack Overflow and
 * Hugging Face degrade to a smaller quota without their tokens, and a degraded source still belongs
 * in a search. Only these two degrade to zero.
 */
export const CREDENTIAL_MANDATORY_SOURCES: readonly SourceName[] = ['reddit', 'producthunt']
