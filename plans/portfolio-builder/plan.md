# Plan: Verified Portfolio Builder

## Goal recap

Develop a public-facing dynamic portfolio engine at `builderhunt.com/@username` displaying a builder's verified repository highlights, timeline, bento summary, and sandbox clone.

## Why this is a valuable addition

1. **Self-Propelling Growth Loop (Virality)**: Developers love showing off verified portfolios. By sharing their profile links, they organically market BuilderHunt to other builders and recruiters.
2. **Attracts the "Passive candidate"**: Developers claim their profiles to get the portfolio page, providing BuilderHunt with active, verified contact information.
3. **SEO Traffic Engine**: Automatically indexes developer profiles on search engines, driving high-intent recruitment search queries directly to our platform.

## Phases

### Phase 1: Database Migration
- Add `portfolioTheme` and `portfolioVisibility` fields to the `builders` table schema.
- Create migrations and update local DB tables.

### Phase 2: Public Route Setup & SEO (`src/routes/portfolio.$username.tsx`)
- Implement the public route using dynamic router segments.
- Bypass authentication checks inside route loader hooks.
- Configure Server-Side Rendering (SSR) meta tags using TanStack Start context loaders to ensure Facebook/Twitter card preview graphics render correctly when links are shared.

### Phase 3: Bento Layout Frontend
- Design a premium bento layout. Use minimal styling tokens.
- Add components:
  - Header: Verified profile badges (e.g. checkmark).
  - Column 1: AI Summary & Seniority indicator.
  - Column 2: Selected Project Cards.
  - Column 3: Recent Activity Timeline.
  - Bottom Widget: Interactive floating AI Chat simulator.

### Phase 4: Share UI Settings
- Build a Settings panel inside the dashboard `/me` view (`src/routes/_dashboard/me/index.tsx`).
- Allow users to toggle sections (timeline visibility, sandbox chat) and select which repositories to show or hide.
- Add the "Copy Link" utility widget.

### Phase 5: Verification & Safety
- Verify that visitors cannot access private pages (like notes or saved searches) by attempting bypasses.
- Verify page load time: since portfolios load without full dashboard layouts, target load speed under 120ms.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Vandalism / Spammer registration** | Low | High | Enforce verification: users must verify their email and link a valid GitHub account before their portfolio becomes public. |
| **Search Engine crawler rate limits** | Medium | Low | Set a strict `robots.txt` configuration to manage crawl frequencies. |

## Rollback plan

- Portfolios are fully independent routes. Disable the route hook in `router.tsx` to turn off public profiles in case of security concerns.
