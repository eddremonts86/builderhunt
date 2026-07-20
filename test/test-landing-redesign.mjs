// E2E verification test for the landing page redesign & static pages overhaul
import { chromium } from 'playwright'

const PORTS = [3001, 3000]

async function verifyPageLayout(page, urlPath, pageName) {
  console.log(`\n🔍 Verifying page: ${pageName} (${urlPath})`)
  
  // Assert header exists
  const header = await page.$('header[aria-label="Primary"]')
  if (header) {
    console.log(`  ✅ [${pageName}] Header navigation bar is present.`)
  } else {
    throw new Error(`❌ [${pageName}] Header navigation bar not found!`)
  }

  // Assert footer exists
  const footer = await page.$('[data-testid="site-footer"]')
  if (footer) {
    console.log(`  ✅ [${pageName}] Premium footer is present.`)
  } else {
    throw new Error(`❌ [${pageName}] Premium footer not found!`)
  }
}

async function testPort(port) {
  const BASE = `http://localhost:${port}`
  console.log(`Probing ${BASE}...`)
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()

  try {
    // 1. Visit homepage
    await page.goto(BASE, { waitUntil: 'load', timeout: 5000 })
    await page.waitForTimeout(2500)
    const title = await page.title()
    console.log(`Successfully connected to ${BASE}. Title: ${title}`)
    
    // Check if it's our landing page
    const marquee = await page.$('.marquee-container')
    if (!marquee) {
      console.log(`Marquee container not found on port ${port}. Trying next port...`)
      await browser.close()
      return false
    }

    console.log('✅ Marquee container is present.')

    // 2. Check Timeline elements are present
    const steps = await page.$$('li.card-premium-glow')
    if (steps.length >= 3) {
      console.log(`✅ Steps timeline contains cards. Count: ${steps.length}`)
    } else {
      throw new Error(`❌ Timeline step card count mismatch! Found: ${steps.length}`)
    }

    // 3. Check Bento grid feature cards
    const bentoScoring = await page.$('text=Recency-weighted scoring')
    if (bentoScoring) {
      console.log('✅ Bento feature card: Recency-weighted scoring is present.')
    }

    // 4. Check Persona selection interactive tabs
    const tabButton = await page.$('button:has-text("Founders sourcing hires")')
    if (tabButton) {
      console.log('✅ Persona tabs found. Clicking second tab...')
      await tabButton.click()
      await page.waitForTimeout(1000)

      let bodyText = await page.innerText('body')
      if (!bodyText.includes('Saved Candidate Hunt')) {
        console.log('⚠️ Tab click missed hydration. Retrying click...')
        await tabButton.click()
        await page.waitForTimeout(1000)
        bodyText = await page.innerText('body')
      }
      
      const updatedPane = page.locator('text=Saved Candidate Hunt')
      const count = await updatedPane.count()
      if (count > 0) {
        console.log('✅ Persona interactive pane updated successfully on tab click!')
      } else {
        throw new Error(`❌ Interactive showcase did not update correctly! Found count: ${count}`)
      }
    } else {
      throw new Error('❌ Persona tabs not found!')
    }

    // Verify main landing page layout
    await verifyPageLayout(page, '/', 'Home')

    // 5. Verify Pricing page layout
    await page.goto(`${BASE}/pricing`, { waitUntil: 'load', timeout: 5000 })
    await page.waitForTimeout(500)
    await verifyPageLayout(page, '/pricing', 'Pricing')
    
    // 6. Verify Roadmap page layout
    await page.goto(`${BASE}/roadmap`, { waitUntil: 'load', timeout: 5000 })
    await page.waitForTimeout(500)
    await verifyPageLayout(page, '/roadmap', 'Roadmap')

    // 7. Verify Status page layout
    await page.goto(`${BASE}/status`, { waitUntil: 'load', timeout: 5000 })
    await page.waitForTimeout(500)
    await verifyPageLayout(page, '/status', 'Status')

    // 8. Verify Blog list layout
    await page.goto(`${BASE}/blog`, { waitUntil: 'load', timeout: 5000 })
    await page.waitForTimeout(500)
    await verifyPageLayout(page, '/blog', 'Blog Index')

    // 9. Verify Legal cookies policy page layout
    await page.goto(`${BASE}/legal/cookies`, { waitUntil: 'load', timeout: 5000 })
    await page.waitForTimeout(500)
    await verifyPageLayout(page, '/legal/cookies', 'Cookies Policy')

    // 10. Verify Legal imprint page layout
    await page.goto(`${BASE}/legal/imprint`, { waitUntil: 'load', timeout: 5000 })
    await page.waitForTimeout(500)
    await verifyPageLayout(page, '/legal/imprint', 'Imprint')

    // 11. Verify Legal privacy policy page layout
    await page.goto(`${BASE}/legal/privacy`, { waitUntil: 'load', timeout: 5000 })
    await page.waitForTimeout(500)
    await verifyPageLayout(page, '/legal/privacy', 'Privacy Policy')

    // 12. Verify Legal terms of service page layout
    await page.goto(`${BASE}/legal/terms`, { waitUntil: 'load', timeout: 5000 })
    await page.waitForTimeout(500)
    await verifyPageLayout(page, '/legal/terms', 'Terms of Service')

    // 13. Verify Explore page layout
    await page.goto(`${BASE}/explore`, { waitUntil: 'load', timeout: 5000 })
    await page.waitForTimeout(500)
    await verifyPageLayout(page, '/explore', 'Explore Explorer')

    await browser.close()
    console.log(`\n🎉 All E2E landing page & static pages layout verification tests passed on port ${port}!`)
    return true
  } catch (err) {
    console.log(`Failed to verify on port ${port}:`, err.message)
    await browser.close()
    return false
  }
}

async function run() {
  console.log('🚀 Running E2E verification for Landing Page & Static Pages Layouts...')
  for (const port of PORTS) {
    const success = await testPort(port)
    if (success) {
      process.exit(0)
    }
  }
  console.error('❌ E2E Verification failed on all ports!')
  process.exit(1)
}

run().catch((e) => {
  console.error('❌ Fatal error in E2E execution:', e)
  process.exit(1)
})
