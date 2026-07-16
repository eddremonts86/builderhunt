// e2e test for content-marketing plan
// Run: node test-content-marketing.mjs

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
  // /blog — list
  // ====================================================================
  console.log('\n📋 /blog — list of posts')
  await page.goto(`${BASE}/blog`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="blog-list"]', { timeout: 5000 })
  const h1 = await page.textContent('h1')
  check('blog h1 visible', h1 === 'Blog', `h1: ${h1}`)
  const cards = await page.$$('[data-testid^="blog-post-card-"]')
  check('at least 3 blog posts listed', cards.length >= 3, `count: ${cards.length}`)
  await page.screenshot({ path: '/tmp/builderhunt-blog-list.png', fullPage: true })

  // RSS link
  const rssLink = await page.$('[data-testid="blog-rss-link"]')
  check('RSS link visible', !!rssLink)

  // ====================================================================
  // /blog/why-i-built-builderhunt — post detail
  // ====================================================================
  console.log('\n📄 /blog/why-i-built-builderhunt — post detail')
  await page.goto(`${BASE}/blog/why-i-built-builderhunt`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="blog-post-why-i-built-builderhunt"]', { timeout: 5000 })
  const title = await page.textContent('[data-testid="blog-post-title"]')
  check('post title visible', !!title, `title: ${title}`)
  const body = await page.textContent('[data-testid="blog-post-body"]')
  check('post body has content', (body?.length ?? 0) > 100, `body length: ${body?.length ?? 0}`)
  check('post body has h1 (from markdown)', body?.includes('Why I built BuilderHunt') ?? false)
  const back = await page.$('[data-testid="blog-back"]')
  check('back link visible', !!back)

  // Meta tags
  const ogTitle = await page.getAttribute('meta[property="og:title"]', 'content')
  check('og:title present', !!ogTitle && ogTitle.includes('Why I built'), `og:title: ${ogTitle}`)
  const ogType = await page.getAttribute('meta[property="og:type"]', 'content')
  check('og:type is article', ogType === 'article', `og:type: ${ogType}`)

  // JSON-LD — pick the one with BlogPosting specifically
  const allJsonLd = await page.$$eval('script[type="application/ld+json"]', els => els.map(e => e.textContent ?? ''))
  const blogPostingJsonLd = allJsonLd.find(t => t.includes('BlogPosting'))
  check('JSON-LD present with BlogPosting', !!blogPostingJsonLd, `found ${allJsonLd.length} ld+json scripts`)

  // CTA
  const cta = await page.$('[data-testid="blog-cta-explore"]')
  check('CTA to explore present', !!cta)

  await page.screenshot({ path: '/tmp/builderhunt-blog-post.png', fullPage: true })

  // ====================================================================
  // /blog/atom.xml — RSS feed
  // ====================================================================
  console.log('\n📡 /blog/atom.xml — RSS feed')
  const rssRes = await page.evaluate(async () => {
    const r = await fetch('/blog/atom.xml')
    return { status: r.status, type: r.headers.get('content-type'), body: await r.text() }
  })
  check('RSS feed returns 200', rssRes.status === 200)
  check('RSS returns atom+xml', rssRes.type?.includes('atom') ?? false, `type: ${rssRes.type}`)
  check('RSS has feed element', rssRes.body?.includes('<feed') ?? false)
  check('RSS has at least 3 entries', (rssRes.body?.match(/<entry>/g) ?? []).length >= 3)
  check('RSS has BuilderHunt title', rssRes.body?.includes('BuilderHunt Blog') ?? false)

  // ====================================================================
  // Footer link to /blog
  // ====================================================================
  console.log('\n🔗 Footer has blog link')
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  const blogLink = await page.$('[data-testid="footer-blog"]')
  check('footer has blog link', !!blogLink)
  if (blogLink) {
    await blogLink.click()
    await page.waitForURL(/blog/, { timeout: 5000 })
    check('blog link navigates', page.url().includes('/blog'))
  }

  // ====================================================================
  // 404 for non-existent post
  // ====================================================================
  console.log('\n🧪 Edge cases')
  const notFoundRes = await page.evaluate(async () => {
    const r = await fetch('/blog/non-existent-post-12345')
    return { status: r.status }
  })
  check('non-existent post returns 404', notFoundRes.status === 404, `status: ${notFoundRes.status}`)

  // ====================================================================
  // /blog/12-sources-developer-search
  // ====================================================================
  console.log('\n📄 Other posts load')
  await page.goto(`${BASE}/blog/12-sources-developer-search`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)
  const title2 = await page.textContent('[data-testid="blog-post-title"]')
  check('12-sources post loads', title2?.includes('12 sources') ?? false, `title: ${title2}`)

  await browser.close()

  // Summary
  console.log('\n' + '='.repeat(60))
  console.log(`Total: ${pass + fail} | ✅ ${pass} | ❌ ${fail}`)
  console.log('='.repeat(60))

  writeFileSync('/tmp/builderhunt-content-marketing-results.txt',
    results.join('\n') + `\n\nTotal: ${pass + fail} | ✅ ${pass} | ❌ ${fail}\n`)

  process.exit(fail === 0 ? 0 : 1)
}

run().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
