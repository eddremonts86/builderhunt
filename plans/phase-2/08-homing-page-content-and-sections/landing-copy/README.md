# Copy drafts — Homing Page

This directory contains the source-of-truth copy for the home page rewrite
(plan `phase-2/08-homing-page-content-and-sections`). Every line is grounded in
`plans/_meta/app-reality.md` and the matching plan's `Status` header.

Files:

- `00-inventory.md` — every claim allowed on the home page, mapped to evidence.
- `01-hero.md` — hero section copy + persona variants.
- `02-features-refresh.md` — copy refresh on the existing six bento cards + Sources strip.
- `03-pipeline.md` — `Pipeline` section copy (alerts, sprints, shortlists).
- `04-ai-helpers.md` — `AI helpers` section copy.
- `05-roadmap.md` — `Roadmap` section copy.

These files are the source for the `*.tsx` components in
`src/modules/landing/components/`. The components read these files via a typed
loader (`src/modules/landing/lib/landing-copy.ts`) so a content refresh is a markdown edit,
not a React edit.

## Style guide (carry-over from existing landing)

- **Sentence length**: 6-18 words. Long sentences break the scanning rhythm.
- **No em-dashes** (—). Period, comma, colon, or parenthetical instead.
- **No AI tells**: "leverage", "seamless", "robust", "delight", "empower". Concrete verbs only.
- **Numbers come with units**: "12 sources", "140 credits/month", "5 concurrent sprints". Never
  bare numerals.
- **Person voice**: first person plural ("we") for product; second person ("you") for the
  visitor. Never "users" or "customers".
- **CTA verbs**: Start, Browse, Sign up, Claim, Compare, Track. Never "Discover" alone
  (the persona panel already says "Start hunting").
