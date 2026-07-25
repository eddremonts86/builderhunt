import { statSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'

const IMAGES_DIR = join(process.cwd(), 'public', 'images')

// KiB budgets from plans/phase-1/audit-performance-qa/spec.md — desktop
// retains its verified 2774:2110 ratio, mobile crop is 1212:2380.
const DESKTOP_RATIO = 2774 / 2110
const MOBILE_RATIO = 1212 / 2380

const BUDGETS = [
  { prefix: 'search-desktop', width: 640, ratio: DESKTOP_RATIO, avifKiB: 90, webpKiB: 130 },
  { prefix: 'search-desktop', width: 1280, ratio: DESKTOP_RATIO, avifKiB: 180, webpKiB: 250 },
  { prefix: 'search-desktop', width: 1920, ratio: DESKTOP_RATIO, avifKiB: 300, webpKiB: 420 },
  { prefix: 'search-mobile', width: 360, ratio: MOBILE_RATIO, avifKiB: 55, webpKiB: 80 },
  { prefix: 'search-mobile', width: 720, ratio: MOBILE_RATIO, avifKiB: 100, webpKiB: 150 },
]

// 390px viewport loads desktop-640 (art-directed to whichever <picture>
// source matches) + no mobile crop (hidden below lg); 1440px loads
// desktop-1920 (nearest source ≥ viewport in a min-width srcset) + the
// mobile-360 corner crop, which is visible at lg+.
const TRANSFER_BUDGETS = [
  { viewportPx: 390, files: ['search-desktop-640.avif'], maxKiB: 150 },
  { viewportPx: 1440, files: ['search-desktop-1920.avif', 'search-mobile-360.avif'], maxKiB: 300 },
]

let failed = false

function fail(message) {
  console.error(`FAIL: ${message}`)
  failed = true
}

function kib(bytes) {
  return bytes / 1024
}

for (const budget of BUDGETS) {
  for (const [ext, maxKiB] of [['avif', budget.avifKiB], ['webp', budget.webpKiB]]) {
    const path = join(IMAGES_DIR, `${budget.prefix}-${budget.width}.${ext}`)
    let stat
    try {
      stat = statSync(path)
    } catch {
      fail(`missing generated file: ${path}`)
      continue
    }
    const sizeKiB = kib(stat.size)
    if (sizeKiB > maxKiB) {
      fail(`${budget.prefix}-${budget.width}.${ext} is ${sizeKiB.toFixed(1)} KiB, budget is ${maxKiB} KiB`)
    }

    const meta = await sharp(path).metadata()
    if (meta.width !== budget.width) {
      fail(`${budget.prefix}-${budget.width}.${ext} width is ${meta.width}, expected ${budget.width}`)
      continue
    }
    const actualRatio = meta.width / meta.height
    if (Math.abs(actualRatio - budget.ratio) > 0.01) {
      fail(`${budget.prefix}-${budget.width}.${ext} aspect ratio drifted: ${actualRatio.toFixed(3)} vs expected ${budget.ratio.toFixed(3)}`)
    }
  }
}

for (const budget of TRANSFER_BUDGETS) {
  let total = 0
  for (const file of budget.files) {
    try {
      total += statSync(join(IMAGES_DIR, file)).size
    } catch {
      fail(`missing file for ${budget.viewportPx}px transfer budget: ${file}`)
    }
  }
  const totalKiB = kib(total)
  if (totalKiB > budget.maxKiB) {
    fail(`${budget.viewportPx}px initial image transfer is ${totalKiB.toFixed(1)} KiB, budget is ${budget.maxKiB} KiB`)
  }
}

if (failed) {
  process.exit(1)
}
console.log('All image budgets and dimensions pass.')
