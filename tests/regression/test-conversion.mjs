#!/usr/bin/env node
/**
 * The conversion funnel's instrumentation, in a real browser (plan 51).
 *
 * ## Why a gate rather than more unit tests
 *
 * The logic behind these events is already covered — 56 unit and integration tests across nine files. What is
 * *not* covered is the wiring: whether the landing page still calls `trackConversionEvent` after a refactor.
 * That is the failure that actually happens, and it is silent in the worst way. A missing event does not break
 * a page or fail a test; it makes a funnel look like a product problem. Weeks later someone concludes the hero
 * does not convert, when in truth the hero was never measured.
 *
 * So this walks the guest path in a browser and counts the requests the page makes.
 *
 * ## The two properties, and why the second one comes first
 *
 * 1. **No consent, no telemetry.** Before asserting that events fire, this asserts they do *not* fire without
 *    analytics consent. That order is deliberate: a broken funnel is a business problem, and telemetry sent
 *    without consent is a legal one. If only one of these can hold, it must be this one.
 * 2. **Each event fires exactly once.** Not "at least once". A duplicate landing view doubles a denominator and
 *    halves every conversion rate computed from it, which is worse than no measurement because it looks
 *    plausible.
 *
 * Usage: `pnpm test:conversion` (honours `APP_URL`, default http://localhost:3000)
 */
import { chromium } from 'playwright'

const BASE_URL = process.env.APP_URL ?? 'http://localhost:3000'
const CONSENT_KEY = 'bh_cookie_consent'
const ENDPOINT = '/api/analytics/conversion'

const failures = []
const notes = []

function check(ok, description, detail = '') {
  if (ok) {
    console.log(`✅ ${description}`)
    return
  }
  console.log(`❌ ${description}${detail ? ` — ${detail}` : ''}`)
  failures.push(`${description}${detail ? `: ${detail}` : ''}`)
}

/** Collects the event names the page posts, so the assertions are about traffic rather than about the DOM. */
function collectEvents(page) {
  const sent = []
  page.on('request', (request) => {
    if (!request.url().includes(ENDPOINT) || request.method() !== 'POST') return
    try {
      const body = JSON.parse(request.postData() ?? '{}')
      sent.push({ name: body.name, surface: body.surface })
    } catch {
      sent.push({ name: '<unparseable>', surface: '<unparseable>' })
    }
  })
  return sent
}

/** `keepalive` sends are fire-and-forget; give the browser a beat to actually emit them. */
const settle = (page) => page.waitForTimeout(600)

async function run() {
  const browser = await chromium.launch()

  try {
    // ── 1. Consent is a precondition, not a formality ────────────────────────────────────────────────
    {
      const context = await browser.newContext()
      const page = await context.newPage()
      const sent = collectEvents(page)

      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => document.documentElement.dataset.hydrated === 'true', { timeout: 20_000 })
        .catch(() => notes.push('hydration flag not observed on the no-consent pass'))
      await settle(page)

      check(
        sent.length === 0,
        'no conversion event is sent without analytics consent',
        sent.length > 0 ? `sent ${sent.map((event) => event.name).join(', ')}` : '',
      )
      await context.close()
    }

    // ── 2. With consent, the funnel is instrumented — and each event exactly once ─────────────────────
    {
      const context = await browser.newContext()
      // Seeded before the first navigation: `trackConversionEvent` reads consent synchronously, and
      // `landing_view` fires on mount, so consent granted after load would miss it.
      await context.addInitScript(
        ([key]) => window.localStorage.setItem(key, JSON.stringify({ analytics: true, necessary: true })),
        [CONSENT_KEY],
      )
      const page = await context.newPage()
      const sent = collectEvents(page)

      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => document.documentElement.dataset.hydrated === 'true', { timeout: 20_000 })
        .catch(() => notes.push('hydration flag not observed on the consented pass'))
      await settle(page)

      const landingViews = sent.filter((event) => event.name === 'landing_view')
      check(landingViews.length === 1, 'landing_view fires exactly once per page load', `fired ${landingViews.length}×`)

      /**
       * The hero CTA, located by its visible label.
       *
       * Not `a[href*="/auth/sign-up"]` — this file's first version used that and matched the *navigation* bar's
       * sign-up link, which is a different, uninstrumented element. It reported "0 events" for a hero that
       * works. Locating by the copy a visitor reads is also what this gate is for: it fails if the button is
       * renamed out from under its instrumentation.
       */
      const heroCta = page.getByRole('link', { name: /start hunting/i }).first()
      if (await heroCta.count() === 0) {
        check(false, 'the hero sign-up call to action is present')
      } else {
        // `noWaitAfter`: the click navigates, and the assertion is about the request the page emitted first.
        await heroCta.click({ noWaitAfter: true }).catch(() => undefined)
        await settle(page)

        const heroClicks = sent.filter((event) => event.name === 'hero_signup_click')
        check(
          heroClicks.length === 1,
          'clicking the hero sign-up CTA fires hero_signup_click exactly once',
          `fired ${heroClicks.length}×`,
        )
      }

      const names = new Set(sent.map((event) => event.name))
      check(
        !names.has('<unparseable>'),
        'every conversion request carries a parseable body',
      )
      notes.push(`events observed: ${[...names].sort().join(', ') || 'none'}`)

      await context.close()
    }
  } finally {
    await browser.close()
  }
}

await run()

console.log('\n=== SUMMARY ===\n')
for (const note of notes) console.log(`· ${note}`)
console.log(`\n${failures.length === 0 ? 'All conversion checks passed.' : `${failures.length} conversion check(s) failed.`}`)

if (failures.length > 0) {
  console.error('\nFailed:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
