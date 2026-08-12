import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative, normalize, dirname } from 'node:path'

/**
 * Every relative markdown link under `plans/` resolves to a file that exists.
 *
 * ## Why this script exists
 *
 * `CLAUDE.md` has told anyone moving a plan to "verify with the resolver rather than by eye" since
 * 2026-08-11, and there was no resolver. The instruction described a one-off script used during the move
 * that created `plans/implemented/`, which touched 411 references and broke 54 of them — 54 breaks that were
 * found by hand, after the fact.
 *
 * The breakage is systematic rather than careless, which is what makes it worth a gate. Everything under
 * `plans/` navigates by relative path, and the archive roots sit one level deeper than a phase directory, so
 * a move silently shifts every `../../x` in the plan to `../../../x` *and* invalidates every reference
 * pointing at it from elsewhere. Neither is visible in a diff: the link text is unchanged and the path still
 * looks plausible. Moving the five rejected plans broke 41 links across 20 files.
 *
 * That matters because these links are the navigation. `_meta/phase-1-order.md` and every plan's
 * `Depends on` header are how a reader gets from one plan to its dependencies, and a plan nobody can follow
 * from its dependencies is a plan nobody reads.
 *
 * ## What counts as a link
 *
 * Markdown inline links whose target is relative — `./x`, `../x`. Absolute URLs are somebody else's problem,
 * and root-relative paths are not used here.
 *
 * Fenced code blocks are skipped, and that is not a nicety: `_meta/conventions.md` documents the mandatory
 * plan header inside a ```markdown fence, and the header template links `[`other-plan`](../other-plan/spec.md)`
 * — a deliberate placeholder. Reporting it would give this gate two permanent failures on day one, which is
 * how a gate gets ignored.
 *
 * A trailing `#anchor` is stripped before resolving. Whether the anchor exists is a different question and a
 * much noisier one; the file existing is the part that breaks navigation completely.
 */

const ROOT = process.cwd()
const SCAN = join(ROOT, 'plans')

/** `[text](target)` — target captured up to `)`, `#` or whitespace. */
const LINK = /\[[^\]]*\]\((\.\.?\/[^)#\s]+)/g
const FENCE = /^\s*```/

let failed = false
const findings = []

function markdownFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...markdownFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

let checked = 0
const files = markdownFiles(SCAN)

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const from = dirname(file)
  let inFence = false

  for (const [index, line] of lines.entries()) {
    if (FENCE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    for (const match of line.matchAll(LINK)) {
      const target = match[1]
      checked += 1
      const resolved = normalize(join(from, target))
      /*
       * A directory target is fine. `plans/README.md` links `./phase-1/` and `./_meta/` deliberately, and
       * every host that serves this repository renders a directory link as a listing.
       *
       * Worth recording because the first version of this check required `isFile()` on the theory that a
       * directory link is broken everywhere. It is not, and the three "failures" it reported on its first
       * run were all correct links — which would have made the gate's first act be to demand three edits
       * that made the documentation worse.
       */
      if (!existsSync(resolved)) {
        failed = true
        findings.push(`${relative(ROOT, file)}:${index + 1} -> ${target}`)
      }
    }
  }
}

if (failed) {
  console.error(`FAIL: ${findings.length} unresolvable relative link(s) under plans/:\n`)
  for (const finding of findings.sort()) console.error(`  ${finding}`)
  console.error(
    '\nA plan move shifts relative depth: plans/<phase>/NN/ is one level shallower than\n' +
      'plans/implemented/<phase>/NN/ and plans/rejected/<phase>/NN/, so `../../x` becomes `../../../x`.\n' +
      'Repoint references *to* the moved plan as well — see plans/rejected/README.md.',
  )
  process.exit(1)
}

console.log(`OK: ${checked} relative links across ${files.length} markdown files under plans/, all resolve`)
