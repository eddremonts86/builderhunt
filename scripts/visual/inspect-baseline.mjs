#!/usr/bin/env node
/**
 * Reads a `-linux.png` visual baseline without trusting an image viewer, so a regenerated one can be
 * reviewed before it is committed.
 *
 * ## Why this exists
 *
 * On 2026-08-12 the `Refresh Linux visual baselines` workflow produced an `empty-dashboard` baseline that
 * looked committable and was not: it held a 751px band of `rgb(10, 10, 13)` — `--color-bh-bg`, one colour,
 * not a single card border — exactly where the action queue, the three headline tiles, builder recency,
 * sourcing sprints, For you and Alerts belong. The page was the same height as a correct render to within
 * 2px, and the refresh's own stability check passed it twice, because a page missing half its widgets
 * renders identically every time. Committing it would have made a required gate defend a dashboard with no
 * numbers on it, and every later fix would have failed that gate.
 *
 * Nothing else could have caught it. `toHaveScreenshot` reports a diff ratio, which names neither the
 * widget nor the reason; a height comparison cannot see it, because tiles hold their height while painting
 * nothing; and a downscaled screenshot in a review cannot distinguish "absent" from "dark on dark".
 *
 * `macOS sips` is not a substitute: `sips -c H W` crops **centred** and silently ignores a preceding
 * `--cropOffset`, so a "top band" it produces is really a middle band — which is its own way of inventing a
 * hole that is not there.
 *
 * ## Usage
 *
 *   pnpm visual:inspect voids <file.png>              regions containing nothing but page background
 *   pnpm visual:inspect crop  <src> <dst> <top> <rows>  a genuinely top-anchored band, to look at
 *   pnpm visual:inspect diff  <a> <b> <dst>            where two same-size baselines disagree
 *
 * `voids` flags legitimate whitespace too — a 232px run at the bottom of a mobile empty state is just the
 * page below the content. It is not a pass/fail gate and deliberately does not exit non-zero: what it is for
 * is answering "is there a band here where content should be", which a human decides by looking at the crop.
 *
 * Supports what Playwright writes: 8-bit, non-interlaced, colour type 6 (RGBA) or 2 (RGB).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { deflateSync, inflateSync, crc32 } from 'node:zlib'

/** Dark-theme `--color-bh-bg` is #0a0a0d and `--color-bh-surface` is #16161c, so 24 separates page from card. */
const INK_FLOOR = 24
/** Shorter runs than this are gaps between sections on every long page, and reporting them is noise. */
const MIN_VOID_ROWS = 80

function readPng(path) {
  const blob = readFileSync(path)
  if (blob.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`${path} is not a PNG`)

  const idat = []
  let width, height, channels
  for (let offset = 8; offset < blob.length; ) {
    const length = blob.readUInt32BE(offset)
    const kind = blob.subarray(offset + 4, offset + 8).toString('ascii')
    const data = blob.subarray(offset + 8, offset + 8 + length)
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const depth = data[8]
      const colour = data[9]
      const interlace = data[12]
      if (depth !== 8) throw new Error(`${path}: bit depth ${depth} unsupported`)
      if (interlace !== 0) throw new Error(`${path}: interlaced PNGs unsupported`)
      if (colour !== 6 && colour !== 2) throw new Error(`${path}: colour type ${colour} unsupported`)
      channels = colour === 6 ? 4 : 3
    } else if (kind === 'IDAT') {
      idat.push(data)
    } else if (kind === 'IEND') {
      break
    }
    offset += 12 + length
  }

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  let previous = Buffer.alloc(stride)
  let cursor = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor]
    cursor += 1
    const line = Buffer.from(raw.subarray(cursor, cursor + stride))
    cursor += stride
    // Per-scanline filters, PNG spec §9.2. `line[i - channels]` is the pixel to the left.
    if (filter === 1) {
      for (let i = channels; i < stride; i += 1) line[i] = (line[i] + line[i - channels]) & 0xff
    } else if (filter === 2) {
      for (let i = 0; i < stride; i += 1) line[i] = (line[i] + previous[i]) & 0xff
    } else if (filter === 3) {
      for (let i = 0; i < stride; i += 1) {
        const left = i >= channels ? line[i - channels] : 0
        line[i] = (line[i] + ((left + previous[i]) >> 1)) & 0xff
      }
    } else if (filter === 4) {
      for (let i = 0; i < stride; i += 1) {
        const a = i >= channels ? line[i - channels] : 0
        const b = previous[i]
        const c = i >= channels ? previous[i - channels] : 0
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      }
    } else if (filter !== 0) {
      throw new Error(`${path}: unknown filter ${filter} on row ${y}`)
    }
    line.copy(out, y * stride)
    previous = line
  }
  return { width, height, channels, data: out }
}

function writePng(path, image) {
  const { width, height, channels, data } = image
  const stride = width * channels
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const chunk = (kind, payload) => {
    const name = Buffer.from(kind, 'ascii')
    const length = Buffer.alloc(4)
    length.writeUInt32BE(payload.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([name, payload])) >>> 0)
    return Buffer.concat([length, name, payload, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = channels === 4 ? 6 : 2
  writeFileSync(path, Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]))
}

function litPixelsPerRow(image) {
  const stride = image.width * image.channels
  const counts = []
  for (let y = 0; y < image.height; y += 1) {
    let lit = 0
    for (let x = y * stride; x < (y + 1) * stride; x += image.channels) {
      if (image.data[x] > INK_FLOOR || image.data[x + 1] > INK_FLOOR || image.data[x + 2] > INK_FLOOR) lit += 1
    }
    counts.push(lit)
  }
  return counts
}

function voids(path) {
  const image = readPng(path)
  const counts = litPixelsPerRow(image)
  console.log(`${path}  ${image.width}x${image.height}`)
  let run = 0
  let start = 0
  // A sentinel past the end so a void running to the last row still gets reported.
  for (let y = 0; y <= counts.length; y += 1) {
    // Two pixels of tolerance: a single stray antialiased pixel is not content.
    const bare = y < counts.length && counts[y] <= 2
    if (bare) {
      if (run === 0) start = y
      run += 1
    } else {
      if (run >= MIN_VOID_ROWS) console.log(`  void rows ${start}..${start + run - 1}  (${run}px)`)
      run = 0
    }
  }
  const lit = counts.filter((count) => count > 2).length
  console.log(`  rows with any content: ${lit}/${image.height}`)
}

function crop(source, destination, top, rows) {
  const image = readPng(source)
  const height = Math.min(rows, image.height - top)
  if (height <= 0) throw new Error(`top ${top} is past the end of a ${image.height}px image`)
  const stride = image.width * image.channels
  writePng(destination, {
    width: image.width,
    height,
    channels: image.channels,
    data: Buffer.from(image.data.subarray(top * stride, (top + height) * stride)),
  })
  console.log(`${destination}  rows ${top}..${top + height} of ${source}`)
}

/**
 * Where two baselines disagree, as an image: unchanged pixels dimmed, changed ones in accent orange.
 *
 * The point is *where*, not how much. A percentage cannot tell font-rendering noise spread over every glyph
 * from a real layout change in one corner, and those two want opposite decisions.
 */
function diff(pathA, pathB, destination) {
  const a = readPng(pathA)
  const b = readPng(pathB)
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`different sizes: ${a.width}x${a.height} vs ${b.width}x${b.height} — that is the finding`)
  }
  const stride = a.width * a.channels
  const out = Buffer.alloc(a.height * a.width * 4)
  let moved = 0
  const rowsMoved = new Set()
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      const src = y * stride + x * a.channels
      const dst = (y * a.width + x) * 4
      const delta = Math.max(
        Math.abs(a.data[src] - b.data[src]),
        Math.abs(a.data[src + 1] - b.data[src + 1]),
        Math.abs(a.data[src + 2] - b.data[src + 2]),
      )
      if (delta > 3) {
        moved += 1
        rowsMoved.add(y)
        out[dst] = 0xe0
        out[dst + 1] = 0x73
        out[dst + 2] = 0x38
      } else {
        // The unchanged render at a third brightness, so the changes have somewhere to sit.
        out[dst] = a.data[src] / 3
        out[dst + 1] = a.data[src + 1] / 3
        out[dst + 2] = a.data[src + 2] / 3
      }
      out[dst + 3] = 0xff
    }
  }
  writePng(destination, { width: a.width, height: a.height, channels: 4, data: out })
  const ratio = moved / (a.width * a.height)
  console.log(`${destination}`)
  console.log(`  strict drift: ${ratio.toFixed(5)} (${moved} px, any channel moving more than 3/255)`)
  const rows = [...rowsMoved].sort((x, y) => x - y)
  console.log(`  rows touched: ${rows.length}/${a.height}${rows.length ? `, first ${rows[0]}, last ${rows[rows.length - 1]}` : ''}`)
}

const [verb, ...rest] = process.argv.slice(2)
try {
  if (verb === 'voids') voids(rest[0])
  else if (verb === 'crop') crop(rest[0], rest[1], Number(rest[2]), Number(rest[3]))
  else if (verb === 'diff') diff(rest[0], rest[1], rest[2])
  else {
    console.error('usage: voids <file> | crop <src> <dst> <top> <rows> | diff <a> <b> <dst>')
    process.exit(2)
  }
} catch (error) {
  console.error(`${error.message}`)
  process.exit(1)
}
