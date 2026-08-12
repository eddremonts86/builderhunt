/**
 * Wave 1 Task 3 — strict browser behavior harness.
 *
 * Replaces fixed hydration delays (`networkidle` + `waitForTimeout`) with a
 * semantic signal, and gives specs collectors that fail loud on browser
 * misbehavior instead of silently swallowing it.
 *
 * Hydration: `src/shared/components/HydrationSignal.tsx` (mounted in
 * `src/routes/-root-components.tsx`) sets `data-hydrated="true"` on `<html>`
 * from a `useEffect`, which React flushes only after the hydration commit.
 * Waiting for that attribute waits for React to actually be live — the exact
 * condition the old 400ms buffer was guessing at.
 */
import { expect, type Browser, type BrowserContext, type Download, type Page } from 'playwright/test'

/** Keep in sync with HYDRATED_ATTRIBUTE in src/shared/components/HydrationSignal.tsx. */
const HYDRATED_SELECTOR = 'html[data-hydrated="true"]'

/**
 * Waits for the HydrationSignal marker — no fixed delays. Safe to call
 * after `page.goto`/`page.reload` (both resolve only once the new
 * document is committed, so the attribute check runs against the fresh
 * document, never a stale one).
 */
export async function waitForHydration(page: Page): Promise<void> {
  await page.locator(HYDRATED_SELECTOR).waitFor({ state: 'attached' })
}

/** Navigate and wait for React hydration to complete. */
export async function gotoHydrated(page: Page, url: string): Promise<void> {
  await page.goto(url)
  await waitForHydration(page)
}

/**
 * Dismisses the first-visit ToS modal and cookie banner if either is
 * showing — both are one-time-per-session UI unrelated to what most specs
 * check, and both otherwise intercept pointer events on everything behind
 * them.
 *
 * The ToS modal (`src/shared/components/TosModal.tsx`) decides whether to
 * render only after the document's own `GET /api/consent` settles — a
 * modal that is not visible *yet* may still be coming. Resource Timing
 * records that fetch, so wait for it semantically (never a fixed delay),
 * let React commit whatever the response triggered, then act on the
 * final overlay state.
 *
 * This used to claim the cookie banner's visibility was already final by
 * the time the hydration marker was set, on the grounds that it decides
 * from localStorage in a mount effect. That was wrong: `HydrationSignal`
 * sets the attribute from its own effect, and nothing orders the banner's
 * effect ahead of that one. Both overlays are now waited for before being
 * dismissed, and waited on until they are actually gone.
 */
export async function dismissOverlays(page: Page): Promise<void> {
  // Ask the same endpoint the modal itself consults. If this session
  // needs ToS acceptance, the modal WILL render on any document that
  // loaded while signed in (the only situation this harness supports —
  // call dismissOverlays after a full-page navigation, not after a
  // client-side one), so let the click auto-wait for it. A plain
  // isVisible() probe here would race the modal's own consent fetch.
  type ConsentStatus = { userId: string | null; needsAcceptance: string[] }
  const status = await page
    .evaluate(async () => {
      const response = await fetch('/api/consent', { credentials: 'include' })
      return (await response.json()) as ConsentStatus
    })
    .catch((): ConsentStatus | null => null)
  if (status?.userId && status.needsAcceptance.includes('tos')) {
    const accept = page.getByTestId('tos-modal-accept')
    await accept.click()
    // Gone, not merely clicked — see the cookie banner below for what returning early costs.
    await expect(accept).toBeHidden()
  }

  /**
   * The cookie banner starts `visible = false` and turns itself on from a mount effect that reads
   * `bh_cookie_consent` (`src/shared/components/CookieBanner.tsx`). A single `isVisible()` probe
   * answers "not yet" exactly as it answers "never" — and this returned before the banner arrived.
   *
   * What that cost: the banner mounted after the spec had already typed, and that commit returned
   * the page's controlled inputs to their empty state. Two specs then failed as product bugs. The
   * invite journey submitted an empty field and the browser's own `required` tooltip blocked it —
   * no request, no error, and a twenty-second timeout on a list that was never going to change. The
   * onboarding journey watched its submit button stay `disabled` through thirty-three polls. Both
   * passed on every isolated re-run, and the screenshots of both failures show this banner still up.
   *
   * So read the same key the component reads: no stored decision means the banner is coming, which
   * makes waiting for it correct rather than hopeful. The wait is bounded because a surface without
   * the root layout never renders one, and that must not hang.
   */
  const decided = await page
    .evaluate(() => {
      try {
        const raw = window.localStorage.getItem('bh_cookie_consent')
        if (!raw) return false
        return typeof (JSON.parse(raw) as { decidedAt?: unknown })?.decidedAt === 'string'
      } catch {
        return false
      }
    })
    .catch(() => false)
  if (decided) return
  const cookies = page.getByTestId('cookie-banner-essential')
  const appeared = await cookies
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false)
  if (!appeared) return
  await cookies.click()
  await expect(cookies).toBeHidden()
}

/**
 * Waits until every bento tile is actually visible and in its final position.
 *
 * ## Why a settle signal beyond `data-dashboard-state="ready"`
 *
 * The dashboard's grid is a Framer Motion stagger: `BentoGrid` mounts with
 * `initial='hidden'` and `BentoTile` carries `fadeInUpVariants`, whose hidden
 * keyframe is `{ opacity: 0, y: 24 }`. A tile mid-entrance therefore occupies its
 * full height and paints nothing — it is invisible without being absent, which is
 * the one failure mode a screenshot cannot describe and a height comparison cannot
 * detect.
 *
 * That is not hypothetical. The Linux visual gate captured `/dashboard` with a
 * 751px band of pure `--color-bh-bg` (measured: one colour, `rgb(10,10,13)`, no
 * card borders) where macOS captured the action queue, the three headline tiles,
 * builder recency, sourcing sprints, For you and Alerts. Both pages were the same
 * height to within 2px, both attempts produced byte-identical output, and the
 * region *below* the band rendered perfectly. `data-dashboard-state="ready"` was
 * already set: it reports the core overview query, and since Wave 1 split the page
 * into core and lazy sections it says nothing about whether the grid has finished
 * arriving.
 *
 * ## Why effective opacity rather than "did Motion finish"
 *
 * Asking the animation library would tie this to the library. What a screenshot
 * needs to know is whether the pixels are there, so this multiplies opacity up the
 * ancestor chain and requires an identity transform — mechanism-agnostic, and true
 * of a tile hidden by a parent as much as one hidden by itself.
 *
 * On timeout it names each unsettled widget with its measured opacity and
 * transform, because "the screenshot did not match" is the least useful sentence
 * available about a page that renders one way on one platform.
 */
export async function waitForTilesSettled(page: Page, timeoutMs = 20_000): Promise<void> {
  const unsettled = () =>
    page.evaluate(() => {
      /**
       * Opacity is multiplied up the whole ancestor chain, because any ancestor can hide a tile and a
       * tile hidden by its parent is exactly as invisible as one hiding itself.
       *
       * The offset check is deliberately narrower: only the nearest ancestor carrying an *inline*
       * transform, which is the one the animation library wrote. Walking the chain for any
       * non-identity transform flagged `action-queue` at `translateY(-2px)` — a static optical nudge
       * from a stylesheet, permanent, correct, and nothing to do with whether the tile arrived. A
       * settle check that reports the design as unsettled is a check nobody will keep.
       */
      return Array.from(document.querySelectorAll('[data-widget]')).flatMap((tile) => {
        let opacity = 1
        for (let node: Element | null = tile; node && node !== document.body; node = node.parentElement) {
          opacity *= Number.parseFloat(getComputedStyle(node).opacity)
        }

        let animated: HTMLElement | null = tile.parentElement as HTMLElement | null
        while (animated && animated !== document.body && !animated.style.transform) {
          animated = animated.parentElement
        }
        // `matrix(a, b, c, d, tx, ty)` — the sixth component is the vertical offset.
        const matrix = animated && animated !== document.body ? getComputedStyle(animated).transform : 'none'
        const offsetY = matrix.startsWith('matrix(')
          ? Number.parseFloat(matrix.slice(7, -1).split(',')[5] ?? '0')
          : 0

        if (opacity >= 1 && offsetY === 0) return []
        const id = tile.getAttribute('data-widget') ?? '(unnamed)'
        return [`${id} effective-opacity=${opacity.toFixed(3)} animated-offsetY=${offsetY}`]
      })
    })

  const deadline = Date.now() + timeoutMs
  let pending = await unsettled()
  while (pending.length > 0) {
    if (Date.now() >= deadline) {
      throw new Error(
        `the bento tiles never finished arriving after ${timeoutMs}ms — `
          + `${pending.length} still hidden or offset: ${pending.join('; ')}`,
      )
    }
    await page.waitForTimeout(100)
    pending = await unsettled()
  }
}

export interface StrictBrowserGuard {
  /** Violations recorded so far, in arrival order. */
  readonly violations: string[]
  /**
   * One-shot opt-out: the next single violation matching `matcher` is
   * consumed instead of recorded. Register once per expected occurrence.
   */
  allowExpectedFailure(matcher: RegExp | string): void
  /** Fails the test if any unexpected violation was recorded. */
  assertClean(): void
  /** Detach all listeners (e.g. before intentionally noisy teardown). */
  dispose(): void
}

/**
 * Installs strict collectors on `page` that treat the following as
 * violations:
 *   - any `console.error` emitted by the page
 *   - any uncaught page error (`pageerror`)
 *   - any failed same-origin request (network-level failure; deliberate
 *     `net::ERR_ABORTED` cancellations from client-side navigation are
 *     exempt — aborting in-flight requests on navigation is normal
 *     browser behavior, not app misbehavior)
 *   - any third-party egress: a request whose origin differs from the
 *     app's own origin (recorded when the request is *attempted* — it
 *     does not need to succeed to count)
 *
 * Call `assertClean()` at the end of the test (or wherever strictness
 * should be enforced); use `allowExpectedFailure` for a known,
 * intentional error line.
 */
export function expectStrictBrowser(page: Page): StrictBrowserGuard {
  const violations: string[] = []
  const allowedOnce: (RegExp | string)[] = []

  function matches(matcher: RegExp | string, text: string): boolean {
    return typeof matcher === 'string' ? text.includes(matcher) : matcher.test(text)
  }

  function record(violation: string): void {
    const index = allowedOnce.findIndex((matcher) => matches(matcher, violation))
    if (index !== -1) {
      allowedOnce.splice(index, 1) // consume — one-shot
      return
    }
    violations.push(violation)
  }

  // The app origin is established by the first top-level navigation, NOT
  // read from `page.url()` at event time: the initial navigation request
  // fires while the page is still `about:blank` (origin "null"), which
  // would misclassify the app's own first request as egress.
  let knownOrigin: string | null = null

  function appOrigin(): string | null {
    try {
      const origin = new URL(page.url()).origin
      if (origin !== 'null') return origin
    } catch {
      // fall through to the origin captured from the first navigation
    }
    return knownOrigin
  }

  function isSameOrigin(url: string): boolean {
    const origin = appOrigin()
    if (!origin) return false
    try {
      return new URL(url).origin === origin
    } catch {
      return false
    }
  }

  /**
   * Chromium network-stack errors the *host* causes, which no application code can produce.
   *
   * `ERR_ABORTED` was already exempt — a navigation cancelling its own in-flight requests is normal.
   * The rest are the same category one level down: the machine's network interface changed, the link
   * went away, or the OS suspended the stack. A laptop joining a VPN mid-run fails whatever request
   * happened to be open, and the failing endpoint is whichever one was unlucky — this run it was
   * `/api/alerts/triggers/unread-count` on an organization-switching test that has nothing to do with
   * alerts.
   *
   * Deliberately a short, exact list rather than a pattern. "Ignore transport errors" would swallow
   * `ERR_CONNECTION_REFUSED`, which is the server being down and is exactly the kind of failure this
   * collector exists to catch. Each entry here has to be a condition the product cannot cause.
   */
  const HOST_NETWORK_ERRORS = [
    'ERR_ABORTED',
    // The OS switched interface (Wi-Fi to Ethernet, VPN up or down) and Chromium tore down its
    // sockets.
    'ERR_NETWORK_CHANGED',
    // The machine has no route at all — airplane mode, cable pulled.
    'ERR_INTERNET_DISCONNECTED',
    // The OS suspended networking, typically a laptop sleeping mid-run.
    'ERR_NETWORK_IO_SUSPENDED',
  ] as const
  const isHostNetworkError = (text: string): boolean =>
    HOST_NETWORK_ERRORS.some((code) => text.includes(code))

  const onConsole = (msg: { type(): string; text(): string; location?(): { url?: string } }): void => {
    // The console message Chromium logs *alongside* a failed subresource carries the same net error
    // token ("Failed to load resource: net::ERR_NETWORK_CHANGED"). Exempting the request without
    // exempting its console twin leaves the test failing on the other half of one event.
    if (msg.type() !== 'error' || isHostNetworkError(msg.text())) return
    // Append the location, because Chromium's own text does not carry it. "Failed to load resource:
    // the server responded with a status of 503" names neither the resource nor the route, and a CI
    // log is all there is when it only reproduces there — that message cost an hour of guessing at
    // which of a page's seven endpoints had answered.
    const url = msg.location?.()?.url
    record(`console.error: ${msg.text()}${url ? ` [${url}]` : ''}`)
  }
  const onPageError = (error: Error): void => {
    record(`pageerror: ${error.message}`)
  }
  const onRequestFailed = (request: { url(): string; failure(): { errorText: string } | null }): void => {
    const failure = request.failure()?.errorText ?? 'unknown failure'
    if (isHostNetworkError(failure)) return
    if (isSameOrigin(request.url())) {
      record(`request failed (same-origin): ${request.url()} — ${failure}`)
    }
  }
  const onRequest = (request: {
    url(): string
    isNavigationRequest(): boolean
    frame(): unknown
  }): void => {
    const url = request.url()
    // Non-network schemes carry no egress.
    if (!/^https?:/i.test(url)) return
    const requestOrigin = new URL(url).origin
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      if (knownOrigin === null) {
        knownOrigin = requestOrigin // first navigation defines the app origin
        return
      }
      if (requestOrigin === knownOrigin) return
      // A top-level navigation *away* from the app origin is still egress.
    }
    const origin = appOrigin()
    if (origin && requestOrigin !== origin) {
      record(`third-party egress: ${url}`)
    }
  }

  page.on('console', onConsole)
  page.on('pageerror', onPageError)
  page.on('requestfailed', onRequestFailed)
  page.on('request', onRequest)

  return {
    violations,
    allowExpectedFailure(matcher: RegExp | string): void {
      allowedOnce.push(matcher)
    },
    assertClean(): void {
      expect(violations, 'strict browser collectors recorded unexpected violations').toEqual([])
    },
    dispose(): void {
      page.off('console', onConsole)
      page.off('pageerror', onPageError)
      page.off('requestfailed', onRequestFailed)
      page.off('request', onRequest)
    },
  }
}

export interface TwoContexts {
  contextA: BrowserContext
  contextB: BrowserContext
  pageA: Page
  pageB: Page
  /** Closes both contexts (and their pages). */
  close(): Promise<void>
}

/**
 * Two fully isolated browser contexts (separate cookie jars and storage) —
 * the standard stand-in for two tenants/users in one spec.
 */
export async function twoContexts(browser: Browser): Promise<TwoContexts> {
  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()
  return {
    contextA,
    contextB,
    pageA,
    pageB,
    async close() {
      await contextA.close()
      await contextB.close()
    },
  }
}

/**
 * Runs `trigger` (a click or keyboard action expected to start a download)
 * and resolves with the resulting Download. No fixed delays — the listener
 * is armed before the trigger runs, so the race is safe.
 */
export async function waitForDownload(page: Page, trigger: () => Promise<void>): Promise<Download> {
  const [download] = await Promise.all([page.waitForEvent('download'), trigger()])
  return download
}

/**
 * Like `waitForDownload`, but also saves the file to `saveAs` (or a
 * Playwright-managed temp path when omitted) and returns the absolute
 * path on disk, failing if the download errored.
 */
export async function downloadToFile(
  page: Page,
  trigger: () => Promise<void>,
  saveAs?: string,
): Promise<string> {
  const download = await waitForDownload(page, trigger)
  const failure = await download.failure()
  if (failure) throw new Error(`download of ${download.suggestedFilename()} failed: ${failure}`)
  if (saveAs) {
    await download.saveAs(saveAs)
    return saveAs
  }
  return download.path()
}
