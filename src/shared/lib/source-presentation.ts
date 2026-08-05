import type { ComponentType } from 'react'
import { SOURCE_NAMES, type SourceName } from '~/lib/sources/types'
import {
  BlueskyIcon,
  CodebergIcon,
  DevpostIcon,
  DevToIcon,
  GithubIcon,
  GitLabIcon,
  HackerNewsIcon,
  HashnodeIcon,
  HuggingFaceIcon,
  LobstersIcon,
  NpmIcon,
  ProductHuntIcon,
  RedditIcon,
  SourceHutIcon,
  StackOverflowIcon,
} from '~/modules/landing/components/BrandIcons'

/**
 * The one exhaustive presentation table for every `SourceName` (plans/UI/tasks.md Wave 1 "Create
 * an exhaustive source presentation registry"). Before this file, label/icon/badge/URL-building
 * were each hand-duplicated across four-plus components, every copy missing a different subset of
 * devpost/producthunt/bluesky (see the audit that produced this file), and one of them
 * (`RecommendationsSection.tsx`) fell back to a bare `href="#"` for exactly those three. A
 * `Record<SourceName, …>` makes an omission a type error instead of a silent gap.
 */

export interface SourceIconProps {
  className?: string
  title?: string
}

export interface SourcePresentation {
  source: SourceName
  label: string
  Icon: ComponentType<SourceIconProps>
  /** One of the `.badge-<source>` classes in globals.css. */
  badgeClassName: string
  /**
   * Whether `POST /api/builders/track` accepts this source — mirrors that route's own zod enum
   * exactly (`src/routes/api/builders/track.ts`). Kept here as a fact about presentation (whether
   * to render a live vs. disabled Track control), not as the authorization boundary itself; the
   * server enum remains the actual enforcement.
   */
  trackable: boolean
  /** Set only when `trackable` is false — the reason a disabled Track control should show. */
  dormantReason: string | null
  /**
   * Builds a safe, validated external profile URL from a raw username/handle. Returns `null`
   * rather than a guess when the handle can't safely form one (empty, or containing a character
   * that could redirect the built URL somewhere other than this source's own host) — callers must
   * treat `null` as "no external link available", never fall back to `#`.
   */
  buildProfileUrl: (usernameOrHandle: string) => string | null
}

function hostMatches(hostname: string, allowed: string): boolean {
  return hostname === allowed || hostname.endsWith(`.${allowed}`)
}

/**
 * Every `buildProfileUrl` in this table is one of these — a fixed base plus one path/query segment
 * holding the handle. `allowSlash` exists because the code-hosting sources (github/gitlab/codeberg/
 * sourcehut) also produce `kind: 'repo'` results whose "username" is a real `owner/repo` pair — a
 * blanket ban on `/` rejected e.g. `ClickHouse/ClickHouse`, which is both a legitimate handle and a
 * real, safe path under that source's own host. Each segment is still individually percent-encoded
 * and `..` is always rejected, so this never allows path traversal or a segment that reintroduces a
 * `/`, `?`, or `#` of its own.
 */
function profileUrlBuilder(host: string, format: (encodedHandle: string) => string, options: { allowSlash?: boolean } = {}) {
  return (usernameOrHandle: string): string | null => {
    const handle = usernameOrHandle.trim()
    if (!handle || /[?#]/.test(handle)) return null
    if (!options.allowSlash && handle.includes('/')) return null
    const segments = handle.split('/').filter(Boolean)
    if (segments.length === 0 || segments.includes('..') || segments.includes('.')) return null

    const candidate = format(segments.map(encodeURIComponent).join('/'))
    let parsed: URL
    try {
      parsed = new URL(candidate)
    } catch {
      return null
    }
    return hostMatches(parsed.hostname, host) ? candidate : null
  }
}

const TRACKING_UNSUPPORTED = (label: string) => `Tracking ${label} builders isn't supported yet`

export const SOURCE_PRESENTATION: Record<SourceName, SourcePresentation> = {
  github: {
    source: 'github',
    label: 'GitHub',
    Icon: GithubIcon,
    badgeClassName: 'badge-github',
    trackable: true,
    dormantReason: null,
    buildProfileUrl: profileUrlBuilder('github.com', (h) => `https://github.com/${h}`, { allowSlash: true }),
  },
  gitlab: {
    source: 'gitlab',
    label: 'GitLab',
    Icon: GitLabIcon,
    badgeClassName: 'badge-gitlab',
    trackable: true,
    dormantReason: null,
    buildProfileUrl: profileUrlBuilder('gitlab.com', (h) => `https://gitlab.com/${h}`, { allowSlash: true }),
  },
  codeberg: {
    source: 'codeberg',
    label: 'Codeberg',
    Icon: CodebergIcon,
    badgeClassName: 'badge-codeberg',
    trackable: true,
    dormantReason: null,
    buildProfileUrl: profileUrlBuilder('codeberg.org', (h) => `https://codeberg.org/${h}`, { allowSlash: true }),
  },
  sourcehut: {
    source: 'sourcehut',
    label: 'SourceHut',
    Icon: SourceHutIcon,
    badgeClassName: 'badge-sourcehut',
    // Retired 2026-08-04 (drizzle/0143) and removed from `POST /api/builders/track` on 2026-08-05, so a
    // live Track control here would render a button that 400s. `/api/admin/integrations` also derives
    // `retired` from `search_sources` and overrides this — belt and braces, because that projection
    // reads the database and this table is what the search UI renders from.
    trackable: false,
    dormantReason: "Retired — the connector was removed and sr.ht's robots policy excludes this use",
    buildProfileUrl: profileUrlBuilder('sr.ht', (h) => `https://sr.ht/~${h}`, { allowSlash: true }),
  },
  hn: {
    source: 'hn',
    label: 'Hacker News',
    Icon: HackerNewsIcon,
    badgeClassName: 'badge-hn',
    trackable: true,
    dormantReason: null,
    buildProfileUrl: profileUrlBuilder('news.ycombinator.com', (h) => `https://news.ycombinator.com/user?id=${h}`),
  },
  reddit: {
    source: 'reddit',
    label: 'Reddit',
    Icon: RedditIcon,
    badgeClassName: 'badge-reddit',
    trackable: true,
    dormantReason: null,
    buildProfileUrl: profileUrlBuilder('reddit.com', (h) => `https://www.reddit.com/user/${h}`),
  },
  devto: {
    source: 'devto',
    label: 'DEV.to',
    Icon: DevToIcon,
    badgeClassName: 'badge-devto',
    trackable: true,
    dormantReason: null,
    buildProfileUrl: profileUrlBuilder('dev.to', (h) => `https://dev.to/${h}`),
  },
  hashnode: {
    source: 'hashnode',
    label: 'Hashnode',
    Icon: HashnodeIcon,
    badgeClassName: 'badge-hashnode',
    // Retired 2026-08-04 (drizzle/0144) — Hashnode's public GraphQL API moved behind a paid plan. Same
    // reasoning as `sourcehut` above.
    trackable: false,
    dormantReason: 'Retired — the connector was removed and its API moved behind a paid plan',
    buildProfileUrl: profileUrlBuilder('hashnode.com', (h) => `https://hashnode.com/@${h}`),
  },
  stackoverflow: {
    source: 'stackoverflow',
    label: 'Stack Overflow',
    Icon: StackOverflowIcon,
    badgeClassName: 'badge-stackoverflow',
    trackable: true,
    dormantReason: null,
    buildProfileUrl: profileUrlBuilder('stackoverflow.com', (h) => `https://stackoverflow.com/users/${h}`),
  },
  npm: {
    source: 'npm',
    label: 'npm',
    Icon: NpmIcon,
    badgeClassName: 'badge-npm',
    trackable: true,
    dormantReason: null,
    buildProfileUrl: profileUrlBuilder('npmjs.com', (h) => `https://www.npmjs.com/~${h}`),
  },
  huggingface: {
    source: 'huggingface',
    label: 'Hugging Face',
    Icon: HuggingFaceIcon,
    badgeClassName: 'badge-huggingface',
    trackable: true,
    dormantReason: null,
    buildProfileUrl: profileUrlBuilder('huggingface.co', (h) => `https://huggingface.co/${h}`),
  },
  lobsters: {
    source: 'lobsters',
    label: 'Lobsters',
    Icon: LobstersIcon,
    badgeClassName: 'badge-lobsters',
    trackable: true,
    dormantReason: null,
    buildProfileUrl: profileUrlBuilder('lobste.rs', (h) => `https://lobste.rs/u/${h}`),
  },
  devpost: {
    source: 'devpost',
    label: 'Devpost',
    Icon: DevpostIcon,
    badgeClassName: 'badge-devpost',
    trackable: false,
    dormantReason: TRACKING_UNSUPPORTED('Devpost'),
    buildProfileUrl: profileUrlBuilder('devpost.com', (h) => `https://devpost.com/${h}`),
  },
  producthunt: {
    source: 'producthunt',
    label: 'Product Hunt',
    Icon: ProductHuntIcon,
    badgeClassName: 'badge-producthunt',
    trackable: false,
    dormantReason: TRACKING_UNSUPPORTED('Product Hunt'),
    buildProfileUrl: profileUrlBuilder('producthunt.com', (h) => `https://www.producthunt.com/@${h}`),
  },
  bluesky: {
    source: 'bluesky',
    label: 'Bluesky',
    Icon: BlueskyIcon,
    badgeClassName: 'badge-bluesky',
    trackable: false,
    dormantReason: TRACKING_UNSUPPORTED('Bluesky'),
    buildProfileUrl: profileUrlBuilder('bsky.app', (h) => `https://bsky.app/profile/${h}`),
  },
}

/** Every entry, in `SOURCE_NAMES` order — for rendering a filter list or an exhaustive legend. */
export const ALL_SOURCE_PRESENTATIONS: readonly SourcePresentation[] = SOURCE_NAMES.map((source) => SOURCE_PRESENTATION[source])

/** `null` for a source key not in `SOURCE_NAMES` — callers must handle that explicitly rather than guessing a label. */
export function getSourcePresentation(source: string): SourcePresentation | null {
  return Object.prototype.hasOwnProperty.call(SOURCE_PRESENTATION, source)
    ? SOURCE_PRESENTATION[source as SourceName]
    : null
}
