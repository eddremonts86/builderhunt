# Verified Portfolio Builder — Specification

> **Status**: `pending`
> **Depends on**: [`claimable-profiles`](../claimable-profiles/spec.md) (canonical, source-verified claims)
> **Blocks**: nothing
> **Reality check**: No portfolio route, component, settings, or schema exists. Public builder profiles already render at `src/routes/builders/$builderId.tsx`; builder data is a per-user cache in `src/shared/lib/db/schema.ts`, so username lookup is not globally unique. Optional inputs are planned by [`ai-profile-enrichment`](../ai-profile-enrichment/spec.md) in `builders.metadata.aiEnrichment` and [`unified-timeline`](../unified-timeline/spec.md); neither is required to publish a portfolio.

## Problem

Builders can share a public profile, but they cannot curate a focused, explicitly published
portfolio. The old proposal assumed a globally unique username, exposed every section by
default, and embedded an “AI clone”. Those assumptions conflict with the per-user builder
cache, privacy expectations, and the shared AI policy.

## Goal

Let a source-verified builder opt in to a fast public portfolio at
`/portfolio/$claimId`. The page presents an allowlisted profile summary, explicitly
selected public projects, and only the optional sections the owner enabled. Publishing and
every privacy-sensitive section are off by default.

The canonical claim ID is the route key because `(source, sourceId)` is global while
`username` and individual builder row IDs are not. A future vanity-slug table may redirect
to this stable URL without changing the portfolio document.

## Non-goals

- No custom domains, vanity handles, drag-and-drop builder, contact-form lead storage, or
  public notes.
- No unverified or merely legacy-email-verified portfolio publishing.
- No automatic repository publication; the owner must select each item.
- No AI persona generation, timeline ingestion, or provider calls owned by this plan.
- No “chat with my clone” or claims that generated text speaks for the builder.

## User stories

1. As a verified builder, I can preview a private draft before publishing.
2. As a verified builder, I explicitly choose projects and optional sections, publish,
   copy a stable URL, and unpublish immediately.
3. As a visitor, I can view a published portfolio without authentication and distinguish
   source-verified facts, builder-curated text, and AI-generated content.
4. As a builder, I can publish a useful core portfolio even when enrichment and timeline
   plans are absent or disabled.

## Ownership and metadata namespace

`claimable-profiles` creates canonical `builder_claims` with a namespaced JSONB `metadata`
column. This plan exclusively owns `builder_claims.metadata.portfolio`:

```ts
const portfolioSettingsSchema = z.object({
  schemaVersion: z.literal(1),
  isPublished: z.boolean().default(false),
  publishedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
  theme: z.enum(["system", "light", "dark"]).default("system"),
  headline: z.string().trim().min(1).max(120).nullable(),
  introduction: z.string().trim().max(600).nullable(),
  featuredProjects: z
    .array(
      z.object({
        source: z.string().min(1).max(30),
        stableId: z.string().min(1).max(200),
      }),
    )
    .max(12),
  sections: z.object({
    activityTimeline: z.boolean().default(false),
    aiPersona: z.boolean().default(false),
  }),
});
```

Writes use `jsonb_set(metadata, '{portfolio}', ...)`, never replace the full metadata
column. The API supplies `updatedAt` and `publishedAt`; clients cannot forge them. Missing
or invalid metadata means an unpublished default.

## Publication and privacy rules

- Draft read/write requires the active verified claim owner. Admins may inspect for abuse
  but cannot publish on the owner's behalf.
- First publish requires a current, non-revoked, source-verified claim and explicit
  confirmation. Revocation immediately makes the portfolio return 404 without deleting
  the draft.
- Public response is a zod allowlist assembled server-side. It excludes user IDs, claim
  owner ID, emails, notes, raw `builders.metadata`, analytics, claim evidence, and hidden
  project records.
- Repository/project candidates are extracted from public source metadata, but only stable
  IDs selected by the owner are serialized. Missing/deleted selections disappear safely.
- Search engines receive `noindex` for preview/unpublished responses. Published pages get
  canonical/OG metadata and enter the sitemap only after opt-in.
- Unpublish is immediate and recoverable; settings remain as a private draft.

## Architecture

### Domain library

`src/shared/lib/portfolio.ts` owns schemas and pure functions:

- `parsePortfolioSettings(metadata)` returns safe unpublished defaults.
- `mergePortfolioSettings(existingMetadata, input, now)` preserves other namespaces.
- `extractProjectCandidates(builder)` normalizes public repository/project signals into
  stable IDs and allowlisted cards.
- `buildPublicPortfolio({ claim, builder, settings, enrichment?, timeline? })` rejects
  unpublished/revoked/unverified state and returns `PublicPortfolioSchema`.

For duplicate per-user rows, select the freshest row for the canonical `(source, sourceId)`
using `updatedAt DESC, id ASC`. Publishing never mutates or merges hunter-owned rows.

### Routes

- `GET /api/portfolio/$claimId`: public published DTO; 404 for absent, unpublished,
  revoked, or invalid claims. Cache public responses with a short TTL and purge on writes.
- `GET /api/me/builder-claims/$claimId/portfolio`: verified owner draft plus selectable
  project candidates and optional-integration availability.
- `PATCH /api/me/builder-claims/$claimId/portfolio`: verified owner only; zod-validates
  settings and writes only `metadata.portfolio`.
- `POST .../publish` and `POST .../unpublish`: explicit state transitions, CSRF/session
  protected, idempotent, and audited.
- `src/routes/portfolio/$claimId.tsx`: public SSR page with dynamic head metadata.

### UI

`PublicPortfolio.tsx` renders semantic, responsive sections using existing tokens:

- identity header, source-verification explanation, builder-curated headline/introduction;
- selected public project cards with source links and measured metrics only;
- optional persona and timeline slots with independent unavailable/empty states;
- source profile link and BuilderHunt verification link; no stored visitor-contact form.

`PortfolioSettings.tsx`, embedded in the existing `/me` page, provides draft preview,
theme, text limits, explicit project selection, optional-section toggles, publish/unpublish,
and copy-link feedback. It never silently publishes after a save.

## Optional integrations and AI policy

The core page has no AI dependency and makes no model call.

- **AI persona**: if [`ai-profile-enrichment`](../ai-profile-enrichment/spec.md) is shipped,
  the owner explicitly enables the section, and a schema-valid
  `builders.metadata.aiEnrichment` artifact already exists, the public DTO may include its
  allowlisted fields plus “AI-generated” provenance. That artifact is persisted/shared and
  therefore generated server-side by MiniMax M3 under the `profile-enrich` server-only task.
  A public portfolio view never triggers generation.
- **Timeline**: if [`unified-timeline`](../unified-timeline/spec.md) is shipped and enabled by
  the owner, the page may render its public-event component. Its optional
  `timeline-summary` remains interactive and ephemeral: Chrome built-in AI is the default;
  authenticated `/api/ai/complete` MiniMax fallback applies when Chrome is unavailable;
  otherwise the summary control hides while the non-AI timeline remains.
- This plan registers no AI task. Any future interactive portfolio assistant must be
  `local-first` (Chrome default, MiniMax proxy fallback), zod-constrained, public-data-only,
  and must never impersonate the builder. Persisted output would instead be server-only.

## Success metrics and release gates

- ≥ 25% of verified owners who open settings publish a portfolio; track share clicks only
  with consent.
- Published page warm p95 < 200 ms and Lighthouse accessibility/SEO ≥ 95.
- 100% of published portfolios have an explicit publish audit event and active verified
  claim; 0 hidden projects/private fields in DTO snapshots.
- Core publish/view/unpublish works with both optional plans absent.
- Runtime smoke proves anonymous published access, private draft 404, immediate unpublish,
  claim-revocation 404, and optional-section degradation.

## Resolved edge cases

- Duplicate builder rows: deterministic freshest representative; canonical claim owns
  settings and URL.
- Username/source rename: claim ID URL remains stable; current public username is rendered.
- Deleted featured project: omitted; settings keep its stable ID so it can reappear.
- Invalid metadata or unknown schema version: fail closed as unpublished and alert logs.
- Optional artifact stale/invalid/disabled: omit its section; never block the portfolio.
- Unpublish or claim revocation: purge cache and return 404 immediately.
