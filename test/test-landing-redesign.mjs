// E2E verification test for the landing page redesign
import { chromium } from 'playwright'

// Try port 3001 first (since dev server started on 3001), fallback to 3000
const PORTS = [3001, 3000]

async function testPort(port) {
  const BASE = `http://localhost:${port}`
  console.log(`Probing ${BASE}...`)
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()

  try {
    await page.goto(BASE, { waitUntil: 'load', timeout: 5000 })
    // Wait longer for hydration to complete on slower dev environments
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

    // 3. Check Timeline elements are present
    const steps = await page.$$('li.card-premium-glow')
    if (steps.length >= 3) {
      console.log(`✅ Steps timeline contains cards. Count: ${steps.length}`)
    } else {
      throw new Error(`❌ Timeline step card count mismatch! Found: ${steps.length}`)
    }

    // 4. Check Bento grid feature cards
    const bentoScoring = await page.$('text=Recency-weighted scoring')
    if (bentoScoring) {
      console.log('✅ Bento feature card: Recency-weighted scoring is present.')
    }

    // 5. Check Persona selection interactive tabs
    const tabButton = await page.$('button:has-text("Founders sourcing hires")')
    if (tabButton) {
      console.log('✅ Persona tabs found. Clicking second tab...')
      await tabButton.click()
      await page.waitForTimeout(1000)

      // Retry click once if it didn't register due to hydration lag
      let bodyText = await page.innerText('body')
      if (!bodyText.includes('Saved Candidate Hunt')) {
        console.log('⚠️ Tab click might have missed hydration. Retrying click...')
        await tabButton.click()
        await page.waitForTimeout(1000)
        bodyText = await page.innerText('body')
      }
      
      console.log(`Is 'Saved Candidate Hunt' in body? ${bodyText.includes('Saved Candidate Hunt')}`)
      
      // Let's use page.locator with exact text match
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

    // 6. Check newsletter form and footer
    const signupInput = await page.$('input[aria-label="Newsletter email input"]')
    if (signupInput) {
      console.log('✅ Newsletter email signup is present.')
    } else {
      throw new Error('❌ Newsletter input not found!')
    }

    const footer = await page.$('[data-testid="site-footer"]')
    if (footer) {
      console.log('✅ Redesigned footer is present.')
    } else {
      throw new Error('❌ Site footer not found!')
    }

    await browser.close()
    console.log(`🎉 All E2E landing page verification tests passed on port ${port}!`)
    return true
  } catch (err) {
    console.log(`Failed to verify on port ${port}:`, err.message)
    await browser.close()
    return false
  }
}

async function run() {
  console.log('🚀 Running E2E verification for Landing Page Redesign...')
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
