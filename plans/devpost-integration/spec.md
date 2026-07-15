# Feature: Devpost Integration

## Problem

BuilderHunt searches developers on standard professional (GitHub, GitLab) or social (HN, Reddit) networks. While these sites show code activity or opinions, they don't capture **practical builder intensity** — the builders who build functional applications in compressed timelines (hackathons) and win competitions.

Without Devpost, we miss:
1. Hackathon winners and active participants who create functional MVPs under time limits.
2. Portfolios of multi-disciplinary builders (who code, design, and pitch projects).
3. Highly detailed, project-based case studies (Devpost projects explain "What it does", "How we built it", and "Challenges we ran into").

## Goal

Search and index builders from Devpost. Since Devpost lacks an official public API, this is achieved by:
- Scraping or querying the internal search endpoints of Devpost for projects matching keywords.
- Resolving the builders ("team members") associated with those projects.
- Extracting user details (bio, hackathons won, linked social accounts) from their Devpost profiles.

## Non-goals

- **No full HTML parsing of every hackathon catalog.** We only query search pages matching keywords.
- **No hackathon registration mechanisms.** BuilderHunt is purely for profile discovery and evaluation.

## User stories

1. **As a user**, when I search for "ai agent", I want to see developers on Devpost who have built AI agents in recent hackathons, alongside GitHub builders.
2. **As a user**, I want to toggle a "Devpost" filter pill in the source checklist.
3. **As a user**, on the builder sheet, I want to see their "Hackathon Portfolio", showing projects built, hackathons attended, and awards won.

## API summary

- **Base Endpoint (Unofficial/Scraping target)**: `https://devpost.com/`
- **Key Routes**:
  - Search software matching keywords: `GET https://devpost.com/software/search?query={keywords}`
    - Returns HTML containing cards with project details. We parse the project title, description, and the member avatars/usernames.
  - User profile resolution: `GET https://devpost.com/{username}`
    - Returns the developer's profile HTML. We parse:
      - Display Name, Bio / Tagline.
      - Linked accounts (GitHub, LinkedIn, Twitter, Personal Website).
      - "Likes" count and followers proxy.
      - List of projects (`/software/{project-slug}`) and badges/awards ("Winner").
- **Rate Limit & Scraping Policy**: Since this relies on scraping public pages, we must include a clean User-Agent, respect robots.txt, and cache responses aggressively to prevent IP bans.

## Data shape

Reuses the `RawBuilder` structure with `source: 'devpost'`:

```ts
export interface RawBuilder {
  id: string              // `dp-${username}`
  kind: 'person'
  source: 'devpost'
  sourceId: string        // Devpost username
  username: string        // username
  displayName?: string    // full name
  avatarUrl?: string      // profile avatar CDN link
  bio?: string            // professional tagline / bio
  profileUrl: string      // `https://devpost.com/${username}`
  followersCount?: number // mapped to the number of projects completed
  language?: string
  country?: string
  topics: string[]        // parsed from technologies used in projects
  metadata: {
    projectsCount: number
    hackathonsWon: number
    projects: Array<{
      name: string
      tagline: string
      url: string
      technologies: string[]
      isWinner: boolean
    }>
    gitHubUsername?: string
    linkedInUsername?: string
  }
}
```

## UX integration

- Add `devpost` to the `Source` type.
- Add Devpost SVG Icon (custom letter "d" emblem) to assets.
- Color theme: Dark Cyan (`#1f2421` / `rgb(31, 36, 33)` with teal highlights).
- Pill badge style: `.badge-devpost`.

## Success metrics

- **Hackathon Sourcing**: Users identify builders who have successfully shipped working applications under tight time constraints (e.g. 48-hour sprints), validating production capability.

## Open questions

- **Scraping Fragility**: HTML changes on Devpost could break our parser.
  - *Recommendation*: Use highly robust selectors (e.g., matching target class structures or searching JSON payloads embedded in scripts) and fall back to skipping the source gracefully if parse errors occur.
- **De-duplication**: Since Devpost profiles frequently link GitHub accounts, we can automatically match and merge them with GitHub profiles.
