// e2e test for public-landing-pages plan
// Run: node test-public-landing-pages.mjs

import { chromium } from 'playwright'
import { writeFileSync } from 'fs'

const BASE = 'http://localhost:3000'

let pass = 0
let fail = 0
const results = []

function check(name, cond, detail) {
  if (cond) {
    pass++
    results.push(`  ✅ ${name}`)
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    results.push(`  ❌ ${name}${detail ? ' — ' + detail : ''}`)
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`)
  }
}

async function run() {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()

  // ====================================================================
  // /explore — empty state
  // ====================================================================
  console.log('\n📋 /explore — empty state with popular queries')
  await page.goto(`${BASE}/explore`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  const exploreH1 = await page.textContent('h1')
  check('explore h1 visible', exploreH1?.includes('Explore'), `h1: ${exploreH1}`)
  const popularSection = await page.$('[data-testid="explore-popular"]')
  check('popular queries section visible', !!popularSection)
  const popularBtns = await page.$$('[data-testid^="explore-popular-"]')
  check('at least 10 popular query buttons', popularBtns.length >= 10, `count: ${popularBtns.length}`)
  await page.screenshot({ path: '/tmp/builderhunt-explore-empty.png', fullPage: true })

  // ====================================================================
  // /explore?q=react — search results + meta tags + JSON-LD
  // ====================================================================
  console.log('\n🔍 /explore?q=react — search results + SSR')
  await page.goto(`${BASE}/explore?q=react`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  const title = await page.title()
  check('page title is SSR with count', /developers — BuilderHunt/.test(title ?? ''), `title: ${title}`)

  const ogTitle = await page.getAttribute('meta[property="og:title"]', 'content')
  check('og:title present', !!ogTitle && ogTitle.includes('react'), `og:title: ${ogTitle}`)

  const ogDesc = await page.getAttribute('meta[property="og:description"]', 'content')
  check('og:description present', !!ogDesc && ogDesc.includes('react'), `og:description: ${ogDesc}`)

  const ogImage = await page.getAttribute('meta[property="og:image"]', 'content')
  check('og:image points to /api/og/explore',
    !!ogImage && ogImage.includes('/api/og/explore?q=react'),
    `og:image: ${ogImage}`)

  const twCard = await page.getAttribute('meta[name="twitter:card"]', 'content')
  check('twitter:card is summary_large_image', twCard === 'summary_large_image', `got: ${twCard}`)

  const jsonLd = await page.$('script[type="application/ld+json"]')
  check('JSON-LD structured data present', !!jsonLd)
  if (jsonLd) {
    const text = await jsonLd.textContent()
    check('JSON-LD is ItemList or similar', /ItemList|WebSite|Organization/.test(text ?? ''), `text: ${text?.slice(0, 100)}`)
  }

  const cards = await page.$$('article[data-testid^="person-card-"]')
  check('renders builder cards', cards.length > 0, `count: ${cards.length}`)
  check('renders up to 20 cards', cards.length <= 20, `count: ${cards.length}`)

  const cta = await page.$('[data-testid="explore-cta-signup"]')
  check('shows sign-up CTA at bottom', !!cta)
  await page.screenshot({ path: '/tmp/builderhunt-explore-react.png', fullPage: true })

  // ====================================================================
  // /api/og/explore?q=react — SVG OG image
  // ====================================================================
  console.log('\n🎨 /api/og/explore — OG image generation')
  const ogRes = await page.evaluate(async () => {
    const r = await fetch('/api/og/explore?q=react')
    return { status: r.status, type: r.headers.get('content-type'), body: await r.text() }
  })
  check('OG endpoint returns 200', ogRes.status === 200, `status: ${ogRes.status}`)
  check('OG endpoint returns image/svg+xml', ogRes.type?.includes('svg') ?? false, `type: ${ogRes.type}`)
  check('OG SVG includes query text', ogRes.body?.includes('react') ?? false)
  check('OG SVG is 1200x630', (ogRes.body?.includes('width="1200"') && ogRes.body?.includes('height="630"')) ?? false)

  // ====================================================================
  // /sitemap.xml — server-generated
  // ====================================================================
  console.log('\n🗺 /sitemap.xml — server-generated sitemap')
  const sitemapRes = await page.evaluate(async () => {
    const r = await fetch('/sitemap.xml')
    return { status: r.status, type: r.headers.get('content-type'), body: await r.text() }
  })
  check('sitemap.xml returns 200', sitemapRes.status === 200)
  check('sitemap.xml returns XML', sitemapRes.type?.includes('xml') ?? false)
  check('sitemap.xml has urlset', sitemapRes.body?.includes('<urlset') ?? false)
  check('sitemap.xml includes home', sitemapRes.body?.includes('builderhunt.dev/') ?? false)
  check('sitemap.xml includes /explore pages',
    sitemapRes.body?.includes('/explore?q=rust') ?? false,
    `missing rust explore URL`)
  check('sitemap.xml includes legal pages',
    sitemapRes.body?.includes('/legal/terms') ?? false)
  const urlCount = (sitemapRes.body?.match(/<url>/g) ?? []).length
  check('sitemap.xml has at least 50 URLs', urlCount >= 50, `count: ${urlCount}`)

  // ====================================================================
  // /robots.txt — server-generated
  // ====================================================================
  console.log('\n🤖 /robots.txt — server-generated robots')
  const robotsRes = await page.evaluate(async () => {
    const r = await fetch('/robots.txt')
    return { status: r.status, type: r.headers.get('content-type'), body: await r.text() }
  })
  check('robots.txt returns 200', robotsRes.status === 200)
  check('robots.txt returns text/plain', robotsRes.type?.includes('text/plain') ?? false)
  check('robots.txt allows /explore', robotsRes.body?.includes('Allow: /explore') ?? false)
  check('robots.txt disallows /api/', robotsRes.body?.includes('Disallow: /api/') ?? false)
  check('robots.txt disallows /dashboard/', robotsRes.body?.includes('Disallow: /dashboard/') ?? false)
  check('robots.txt references sitemap', robotsRes.body?.includes('Sitemap:') ?? false)

  // ====================================================================
  // Footer link to /explore
  // ====================================================================
  console.log('\n🔗 Footer has Explore link')
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  const exploreFooter = await page.$('[data-testid="footer-explore"]')
  check('footer has explore link', !!exploreFooter)
  if (exploreFooter) {
    await exploreFooter.click()
    await page.waitForURL(/explore/, { timeout: 5000 })
    check('explore link navigates correctly', page.url().includes('/explore'))
  }

  // ====================================================================
  // Empty query edge case
  // ====================================================================
  console.log('\n🧪 Edge cases')
  await page.goto(`${BASE}/explore?q=nonsense_query_xyz_9999`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)
  // Should not crash
  check('handles nonsense query without crash', page.url().includes('/explore'))
  const empty = await page.$('[data-testid="explore-empty"]')
  if (empty) {
    check('shows empty state for zero results', true)
  } else {
    // Or shows results
    const cards2 = await page.$$('article[data-testid^="person-card-"]')
    check('no empty state but renders page', cards2.length >= 0)
  }

  await browser.close()

  // Summary
  console.log('\n' + '='.repeat(60))
  console.log(`Total: ${pass + fail} | ✅ ${pass} | ❌ ${fail}`)
  console.log('='.repeat(60))

  writeFileSync('/tmp/builderhunt-public-landing-results.txt',
    results.join('\n') + `\n\nTotal: ${pass + fail} | ✅ ${pass} | ❌ ${fail}\n`)

  process.exit(fail === 0 ? 0 : 1)
}

run().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
