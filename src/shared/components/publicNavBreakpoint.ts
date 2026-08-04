/**
 * The single place the public header's desktop/mobile boundary is decided.
 *
 * These three classes are one decision expressed three ways, and they **must** name the same breakpoint:
 * above it the inline nav shows and the hamburger hides; below it the reverse, and the drawer is what
 * carries navigation. Get them out of step and there is a range of widths with *neither* — a page a visitor
 * cannot navigate at all, which no screenshot test flags as an error because nothing looks broken.
 *
 * That is not hypothetical. Before this module existed the breakpoint was six separate `md:` literals across
 * two files — four in `Header.tsx`, two in `PublicNavDrawer.tsx` — and raising only the Header's four left
 * 768px–1279px with the inline nav hidden by `xl` and the drawer hidden by `md:hidden`. The e2e guard in
 * `tests/e2e/public-nav-responsive.spec.ts` is what caught it.
 *
 * ## Why `xl` (1280px), measured rather than chosen
 *
 * `.topbar-shell` is capped at `--page-max` minus gutters — about **1158px at every viewport**, deliberately,
 * so the floating pill lines up with the landing's content column. The nav's natural width is what has to fit
 * inside that cap, and no viewport can help:
 *
 * - with the theme toggle's "Light"/"Dark" text: **1176px** — wider than the 1158px cap, so it overflowed at
 *   *every* width, which is the bug a user reported at 1200px (labels wrapped onto three lines, the
 *   Dashboard button clipped);
 * - with `<ThemeToggle compact />` (icons only; each button keeps its `aria-label`): **~1088px**, leaving
 *   ~70px of headroom.
 *
 * At 1280 the shell is 1158px wide, so 1088px fits. Below 1280 the shell is narrower than the content, hence
 * the drawer. **If items are added to `NAV_LINKS` or `NAV_GROUPS`, re-measure — the guard fails on overflow
 * at every breakpoint, so the cost of guessing is a red test rather than a broken page nobody reports.**
 */

/** Numeric form, for tests and any measurement that needs the threshold rather than the class. */
export const PUBLIC_NAV_BREAKPOINT_PX = 1280

/** The inline nav and the signed-in/out action pair: hidden below the breakpoint. */
export const DESKTOP_NAV_VISIBLE = 'hidden xl:flex'

/** The hamburger that opens the drawer: shown only below the breakpoint. */
export const MOBILE_TRIGGER_VISIBLE = 'grid xl:hidden'

/** The drawer's own overlay and panel: they must disappear exactly where the inline nav appears. */
export const MOBILE_DRAWER_VISIBLE = 'xl:hidden'
