# Visual System Normalization and Regression Gate

> **Status**: `implemented`
> **Depends on**: [`audit-performance-qa`](../49-audit-performance-qa/spec.md), [`audit-accessibility`](../48-audit-accessibility/spec.md)
> **Blocks**: nothing
> **Reality check**: Tailwind v4 is loaded from `src/shared/styles/globals.css`; there is no
> `tailwind.config.*`. Semantic colors, `.card`, `.btn-*`, `.input-field`, spacing helpers, and
> `src/components/ui/button.tsx` already exist. However `.card` forces a 24 px radius and shadow
> with `!important`, overriding route-level `rounded-xl/2xl/3xl`; the light UI still advertises a
> dark color scheme/theme color in `src/routes/__root.tsx`, and no visual-regression suite exists.

## Problem

The app has a recognizable light visual language, but it is encoded twice: semantic CSS classes
and scattered utility strings. Overrides such as `.card { ... !important }` make local radius and
border utilities misleading. Buttons can be rendered through `Button`/`LinkButton` or raw
`.btn-*` classes, while shell, landing, search, pricing, and builder-profile surfaces use different
container and responsive rules. This makes visual changes hard to reason about and easy to regress.

The old audit assumed a dark zinc theme, a nonexistent `src/shared/components/Button.tsx`, and a
Tailwind config file. It also proposed arbitrary universal radii rather than documenting current
component roles.

## Outcome

Normalize a small semantic visual system for the highest-traffic surfaces, migrate shared
primitives before pages, and enforce responsive screenshots plus structural assertions in CI.
Normalization must preserve meaning, keyboard focus, reduced-motion behavior, and density; it is
not a wholesale redesign.

## Scope and non-goals

In scope: global tokens/primitives, `Button`/`LinkButton`/`Input`/`Dialog`, landing/header/footer,
pricing, dashboard shell, search/results, builder profile, and the viewports defined below.

Out of scope: changing the brand palette, rewriting content, certifying WCAG (owned by
`audit-accessibility`), normalizing source-brand colors, forcing equal heights across unrelated
content, or mass search-and-replace of every `rounded-*` utility. Visual baselines never contain
real user data.

## Token and component contract

Keep tokens in `src/shared/styles/globals.css` under Tailwind v4 `@theme` and CSS custom properties.
Define and document these semantic roles:

- spacing: 4 px base; page gutters 16/24/40 px at `<768`/`768–1023`/`≥1024`; sections 48/80 px
  mobile/desktop; component gaps 8/12/16/24/32 px;
- radii: control 8 px, panel 16 px, feature/hero 24 px, pill full;
- elevation: none, raised, overlay; each is a named shadow token, never an ad hoc page shadow;
- control heights: small 36 px, default 40 px, large 48 px; icon-only minimum 36 px while
  accessibility may require a larger target;
- motion: fast 150 ms and normal 200 ms; transform only for deliberate hover/press feedback and
  disabled under `prefers-reduced-motion`;
- layout: content max width 1200 px and narrow max width 800 px, using one responsive gutter rule.

Semantic `.card`, `.btn-*`, and `.input-field` classes may remain compatibility APIs, but they must
resolve to tokens without `!important`. `src/components/ui/button.tsx`, `link.tsx`, `input.tsx`, and
`dialog.tsx` are the canonical React primitives. Variants define state, size, focus, disabled, and
loading behavior; page code may add layout classes but not restyle a variant.

Equal-height behavior applies only to cards in the same comparison row. Grid containers use
`items-stretch`; card roots use `h-full flex flex-col`; actions use `mt-auto`. Copy is not clamped
unless truncation is part of the product contract and the full value remains accessible.

## Audited surfaces and invariants

- Landing (`HomePage.tsx`, `FAQSection.tsx`, `Header.tsx`, `Footer.tsx`): no overflow at 390, 768,
  or 1440 px; hero remains above feature content; comparison cards align within 1 px per row.
- Pricing (`_landing/pricing.tsx`): plan cards use one panel role, CTA controls share height, and
  the comparison grid scrolls or stacks without page-level overflow.
- Dashboard (`DashboardLayout.tsx`): fixed navigation remains reachable at 390 px without hiding
  account/sign-out actions; main content uses the shared gutter/max-width contract.
- Search (`SearchPage.tsx`, `PersonResultCard.tsx`): filters/actions wrap without collision; cards
  do not clip usernames, badges, or action buttons at 320–390 px.
- Builder profile (`BuilderProfilePage.tsx`): main panels use consistent panel radius/elevation;
  action and claim states do not shift surrounding layout unexpectedly.
- Root metadata (`__root.tsx`): `color-scheme` and theme color match the rendered light system.

## Regression harness and budgets

Use the Playwright config from `audit-performance-qa`. Add deterministic fixtures and screenshot
specs for public landing/pricing and authenticated dashboard/search/builder profile at 390×844,
768×1024, and 1440×1000, Chromium only. Disable animation/caret, freeze time, mock external data,
wait for local fonts, and use committed snapshots per platform-independent Docker CI.

Gates:

- zero page-level horizontal overflow (`scrollWidth <= clientWidth`) at 320, 390, 768, and 1440 px;
- screenshot diff ratio ≤1% with `maxDiffPixelRatio: 0.01` (the implemented value; 0.2% proved too
  tight in practice — antialiasing alone varies more than that between runs on the same platform,
  so the suite would fail on non-design noise. 1% still fails on a shifted control or changed
  token, which is what this gate is for). Intentional baseline updates require a reviewed
  before/after artifact;
- same-row comparison-card bottom edges differ by ≤1 CSS px;
- controls meet the declared heights within ±1 px and retain visible focus/disabled states;
- no new raw hex color, arbitrary pixel radius/shadow, or `!important` in audited component files,
  enforced by `scripts/check-visual-contract.mjs` with a small documented source-brand allowlist.

## Security, privacy, and AI isolation

Snapshots use synthetic names, avatars, emails, notes, and source payloads from `tests/e2e/fixtures/`.
CI traces/screenshots must not include production sessions or personal data. No AI is needed; run
with `AI_DISABLED=true`, and never generate visual “evidence” or testimonials with a model. If a
future AI surface is captured, its output must be a fixed synthetic fixture, not a live provider
response.

## Acceptance criteria

- The token/component contract is documented in code and demonstrated in a `/admin`-independent
  development route or isolated test fixture; all canonical primitives cover state and size.
- The five audited surfaces use canonical primitives/tokens and satisfy every viewport invariant.
- Removing `!important` does not produce accidental radius/shadow drift; intentional role changes
  are captured in approved snapshots.
- Static, unit, responsive structural, accessibility interaction, and visual diff checks run in CI.
- A production smoke at 390 and 1440 px shows no overflow, missing local font, unstyled content,
  or metadata/theme mismatch.

## Success measures

- Zero unexplained visual snapshot changes on merge.
- Zero horizontal-overflow failures on the audited surfaces for four consecutive releases.
- 100% of primary CTA/control instances on audited surfaces use canonical primitives or a documented
  exception.
- No `!important` or arbitrary radius/shadow declarations remain in audited component styles.
