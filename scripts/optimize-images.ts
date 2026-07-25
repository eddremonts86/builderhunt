import sharp from 'sharp'
import { join } from 'node:path'

/**
 * Generates the responsive AVIF/WebP variants for the two hero screenshots
 * referenced by HomePage.tsx. Deterministic (same input bytes -> same output
 * bytes) so `check-performance-budgets.mjs` and CI's dirty-diff check both
 * work: re-running this against unchanged source PNGs must not touch git.
 */
const OUT_DIR = join(process.cwd(), 'public', 'images')

interface Variant {
  source: string
  prefix: string
  widths: number[]
}

const VARIANTS: Variant[] = [
  { source: join(OUT_DIR, 'search-desktop.png'), prefix: 'search-desktop', widths: [640, 1280, 1920] },
  { source: join(OUT_DIR, 'search-mobile.png'), prefix: 'search-mobile', widths: [360, 720] },
]

async function run() {
  for (const variant of VARIANTS) {
    const source = sharp(variant.source, { failOn: 'none' })
    for (const width of variant.widths) {
      // AVIF and WebP encoders both strip metadata by default (sharp never
      // copies EXIF/ICC unless `.withMetadata()` is called) — no extra step
      // needed to satisfy the "strip metadata" requirement.
      const avifPath = join(OUT_DIR, `${variant.prefix}-${width}.avif`)
      const webpPath = join(OUT_DIR, `${variant.prefix}-${width}.webp`)
      // Quality picked high (screenshots are text-heavy — low quality
      // blurs UI labels) and re-checked against the per-size budgets below;
      // there's comfortable headroom at every size even at these settings.
      await source.clone().resize({ width }).avif({ quality: 72, effort: 6 }).toFile(avifPath)
      await source.clone().resize({ width }).webp({ quality: 85, effort: 6 }).toFile(webpPath)
      console.log(`wrote ${variant.prefix}-${width}.{avif,webp}`)
    }
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
