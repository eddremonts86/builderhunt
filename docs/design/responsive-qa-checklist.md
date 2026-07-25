# Responsive QA checklist

No automated viewport test suite exists or is planned for layout/responsive regressions (see
`plans/responsive-mobile-design/spec.md` non-goals) — this checklist is the verification method by
design. Run it whenever a PR touches shared shell components (`DashboardLayout`, `Header`,
`Footer`, `OrganizationSwitcher`, `UserMenu`), a page's top-level layout, or any table/flex-row
markup that renders user-generated free text.

## Device matrix

| Label | Width × Height | Why it's in the matrix |
| --- | --- | --- |
| Small phone | 375 × 667 | Tightest realistic size (iPhone SE-class); the true stress test |
| Standard phone | 390 × 844 | Modern iPhone default |
| Large phone | 430 × 932 | iPhone Pro Max-class |
| Small tablet / large phone landscape | 768 × 1024 | The `md` Tailwind breakpoint boundary — nav must flip exactly here |
| Small desktop | 1024 × 768 | Confirms desktop layout is pixel-unchanged from before this plan |

## Tools

- **Browser tool**: `resize_window` (presets `mobile`/`tablet`/`desktop`, or explicit
  `width`/`height`), then `computer { action: "screenshot" }` for a visual check, or
  `javascript_tool` to assert `document.documentElement.scrollWidth === window.innerWidth` (the
  single most useful automated-ish check: any inequality is a page-level horizontal overflow bug).
- **iOS Simulator tool**: `open_url` + `screenshot` for a real WebKit rendering pass, catching any
  Safari-only differences the Chromium-based Browser tool can't.
- Sign in as the seeded local admin (`edd_admin@local.com` / `Passw0rd!234`) to reach authenticated
  pages.

## Page list (walk every one at every matrix size)

- Landing home (`/`), auth (`/auth/sign-in`, `/auth/sign-up`, `/auth/forgot`, `/auth/reset`)
- Dashboard overview (`/dashboard`), search (`/search`, with results loaded), sprints
  (`/sprints`, `/sprints/new` wizard step 1 at minimum), exports (`/exports`), alerts (`/alerts`)
- Settings: team (`/settings/team`), billing (`/settings/billing`), privacy
  (`/settings/privacy`), security (`/settings/security`)
- Admin: metrics, users, plan-requests, incidents, changelog, roadmap, refunds, disputes,
  billing-ops (`/admin/*`)
- Builder profile (`/builder/$builderId`) — **the highest-risk page**: it renders arbitrary
  external bio text that can contain long unbroken tokens (raw URLs). See the gotcha below.
- Onboarding (`/onboarding/welcome`, `/search`, `/save`, `/success`)
- Public content: `/pricing`, `/explore`, `/legal/*`, `/changelog`, `/roadmap`

## Pass criteria

- `document.documentElement.scrollWidth` equals `window.innerWidth` on every page/size — any
  larger value is a real horizontal-overflow bug, not a measurement artifact (verified during this
  plan: a page that visually clips content and reports a wider `scrollWidth`/`innerWidth` than
  requested is a genuine bug, not a testing-tool quirk).
- No control (nav item, button, form field) requires horizontal scrolling to reach by tap.
- The two intentional exceptions — admin billing tables (`DisputeQueue`/`RefundQueue`) and any
  other genuinely wide data table — scroll horizontally via the `.table-scroll` utility class
  (`src/shared/styles/globals.css`), which ships a visible fade-hint on both edges and is
  keyboard-focusable (`tabIndex={0}`, `role="region"`, `aria-label`). No other page should rely on
  horizontal scroll.
- Desktop (≥1024px / `md`+) renders identically to before this plan — screenshot-diff by eye if
  unsure.

## Known gotcha: the flexbox `min-width: auto` overflow trap

Found live during this plan's device-matrix pass on `/builder/$builderId`: a `flex-1` column
sitting next to a fixed-size avatar, containing free-text content (the builder's bio, which can
contain a raw unbroken URL). Even with `break-words` (`overflow-wrap: break-word`) on the text
itself, the **flex item's own default `min-width: auto`** let it grow to the text's intrinsic
(unwrapped) width, expanding the whole card and the page past the viewport — `break-words` only
takes effect once the browser has already committed to an available width, and the unconstrained
flex item never gave it one.

**Fix pattern**: any `flex-1` (or other growable) flex child that can contain free-text/user-
generated content — bios, notes, descriptions — needs `min-w-0` alongside it
(`className="flex-1 min-w-0"`), not just `break-words` on the text. `src/routes/_dashboard/me/
index.tsx` already had this right; `BuilderProfilePage.tsx` didn't (fixed in this plan). Grep for
`className="flex-1"` (without an adjacent `min-w-0`) next to an avatar/icon sibling as a quick way
to spot repeat instances.

## Sprint wizard note

Step 1 (add job descriptions/CVs) reflows correctly at every matrix size. Steps 2-3 require
actually running a sourcing sprint (real AI processing, Chrome on-device or MiniMax server) to
reach — not exercised end-to-end during this plan's pass to avoid triggering real AI cost/latency
in a verification-only check. Give steps 2-3 a live look the next time a PR actually changes sprint
wizard code, using a real (not synthetic) sprint run.
