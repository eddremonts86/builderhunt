# Feature: Verified Portfolio Builder

## Problem

Developers waste hours building and maintaining static portfolios that quickly go out of date. Furthermore, recruiters are skeptical of self-reported claims on resumes, preferring verifiable indicators (like real repositories and continuous activities).

Builders need an effortless, auto-updating, premium portfolio page that proves their skills and is easy to share on Twitter/LinkedIn.

## Goal

Provide a public, auto-generating portfolio page ("Verified Portfolio") for builders who claim their profile. The profile will:
- Be accessible via a public URL: `builderhunt.com/@username` or `/portfolio/:username`.
- Require no login for external visitors (recruiters, managers).
- Aggregate the builder's verified repositories, blog posts, unified timeline, AI Persona bento card, and a public-facing sandbox widget.
- Support SEO optimizations to rank the developer's name on search engines.

## Non-goals

- **No custom domain hosting.** We do not host domains (e.g. `user.com`) in this iteration; we only offer the subpath route.
- **No drag-and-drop page builder editing.** The layout structure remains standardized to maintain quality design taste.

## User stories

1. **As a builder**, when I claim my profile, I want a "Public Portfolio" link that I can copy to my resume or social bios.
2. **As a visitor (recruiter)**, when I visit a builder's public portfolio URL, I want to review their verified achievements, read their timeline, and chat with their AI Sandbox clone.
3. **As a builder**, I want to toggle the visibility of specific repositories or sections of my public portfolio to curate what visitors see.

## Technical architecture

### 1. Route Configuration
- Create a public route `src/routes/portfolio.$username.tsx` (using TanStack Router's dynamic routing parameters).
- Bypass the dashboard session authentication check for this specific route.
- Implement SEO Head tags using TanStack Start's meta utilities:
  ```ts
  export const meta = ({ data }) => {
    return [
      { title: `${data.displayName} (@${data.username}) - Verified Developer Portfolio | BuilderHunt` },
      { name: 'description', content: data.aiEnrichment?.summary || data.bio },
      { property: 'og:image', content: data.avatarUrl }
    ]
  }
  ```

### 2. Customization Schema
Add portfolio customization columns to the `builders` table:

```ts
// Table additions:
export const builders = pgTable('builders', {
  // ... existing fields ...
  portfolioTheme: text('portfolio_theme').default('dark'), // dark | light | minimal
  portfolioVisibility: jsonb('portfolio_visibility').$type<{
    timeline: boolean
    sandbox: boolean
    repositories: string[] // list of repo names allowed to display
  }>().default({ timeline: true, sandbox: true, repositories: [] }),
})
```

## UX integration

- **Layout Grid**: Sleek, single-page editorial design. Warm monochrome backgrounds, high typographic contrast, and bento-box layouts.
- **Featured Projects Section**: Showcase selected repositories with metrics (stars, forks) and a tag list of technologies used.
- **Timeline Tab**: Embed the vertical Unified Timeline.
- **Interactive Sandbox Drawer**: Floating widget at the bottom right allowing visitors to "Chat with [Name]'s Code Clone".
- **Visitor Contact Form**: Allows recruiters to drop their email and a short message, which gets forwarded to the developer's registered account.

## Success metrics

- **Viral Acquisition Loop**: 15% of builders who claim their profile share their `/portfolio/...` link publicly, driving organic recruiter traffic to the platform.
- **SEO Authority**: 40% of claimed developers rank BuilderHunt in the top 3 Google results for their full name search within 60 days.
