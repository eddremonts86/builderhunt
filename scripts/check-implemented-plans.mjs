import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Keeps `plans/implemented/` true, and keeps it complete.
 *
 * ## Why this is not `check-phase-readiness.mjs`
 *
 * That script asks "is this plan ready to be executed?" — no reserved migration numbers, no
 * placeholders, an exact `spec.md`/`plan.md`/`tasks.md` file set. Every one of those rules is about work
 * that has not happened yet. Run over 48 finished plans it produced 52 failures, and 22 of them were
 * task texts naming the migration a plan *actually created*. Satisfying them would mean rewriting the
 * record of what happened to please a forward-looking lint, which is the wrong direction entirely.
 *
 * So this checks the two claims the folder itself makes, and nothing else:
 *
 * 1. **Everything in it is done.** No `- [ ]`, no `- [~]`, and `implemented` in every file that carries a
 *    Status header. Both markers count: `- [~]` is the one that hides, because every status report in
 *    this repository greps for `- [ ]` alone and nine real tasks were once invisible for exactly that.
 * 2. **Nothing outside it is done.** A plan with zero open tasks and `implemented` everywhere belongs in
 *    the folder, and leaving it out makes the folder an understatement — which erodes trust in it just as
 *    fast as an overstatement, because a reader then has to check both directories anyway.
 *
 * It also checks the vocabulary, everywhere: a Status outside the five values
 * `check-phase-readiness.mjs` accepts is a status no gate can read, and that is how eight of them drifted
 * across phase-1 for weeks while four plans sat at 100% of their tasks still labelled `pending`.
 */
const ROOT = process.cwd()
const IMPLEMENTED = join(ROOT, 'plans', 'implemented')
const LIVE = join(ROOT, 'plans', 'phase-1')
const ALLOWED_STATUSES = new Set(['pending', 'partially-implemented', 'implemented', 'blocked', 'superseded'])

let failed = false
function fail(message) {
  console.error(`FAIL: ${message}`)
  failed = true
}

function planDirectories(root) {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

/** Any markdown file in the plan, because 42 uses `task.md` and 53 has only `tasks.md`. */
function markdownFiles(root, dir) {
  return readdirSync(join(root, dir)).filter((name) => name.endsWith('.md')).sort()
}

function statusOf(text) {
  return /\*\*Status:?\*\*:?\s*`([^`]+)`/.exec(text)?.[1] ?? null
}

/**
 * Counts unchecked and partial task markers.
 *
 * `[-*]` because both bullet styles appear, and the two markers are counted separately so a message can
 * say which kind is blocking — "1 partial" and "1 open" call for different conversations.
 */
function taskCounts(text) {
  return {
    open: (text.match(/^\s*[-*]\s*\[ \]/gm) ?? []).length,
    partial: (text.match(/^\s*[-*]\s*\[~\]/gm) ?? []).length,
  }
}

function readPlan(root, dir) {
  const files = markdownFiles(root, dir)
  const statuses = new Map()
  let open = 0
  let partial = 0
  for (const name of files) {
    const text = readFileSync(join(root, dir, name), 'utf8')
    const status = statusOf(text)
    if (status !== null) statuses.set(name, status)
    // Tasks live in tasks.md/task.md, but counting every file is harmless and catches a stray checklist.
    const counts = taskCounts(text)
    open += counts.open
    partial += counts.partial
  }
  return { files, statuses, open, partial }
}

// ── 1. Every status, in both directories, is a value a gate can read ─────────────────────────────
for (const root of [IMPLEMENTED, LIVE]) {
  for (const dir of planDirectories(root)) {
    const { statuses } = readPlan(root, dir)
    for (const [file, status] of statuses) {
      if (!ALLOWED_STATUSES.has(status)) {
        fail(
          `${dir}/${file} has Status \`${status}\`, which no gate can read — use one of ` +
            `${[...ALLOWED_STATUSES].join(', ')} and keep the nuance as prose beside it`,
        )
      }
    }
  }
}

// ── 2. Everything in plans/implemented/ is finished ──────────────────────────────────────────────
const implemented = planDirectories(IMPLEMENTED)
for (const dir of implemented) {
  const { files, statuses, open, partial } = readPlan(IMPLEMENTED, dir)
  if (files.length === 0) {
    fail(`plans/implemented/${dir} has no markdown file`)
    continue
  }
  if (open > 0 || partial > 0) {
    fail(
      `plans/implemented/${dir} is not finished: ${open} open and ${partial} partial task(s). ` +
        'Move it back to plans/phase-1/ or close them.',
    )
  }
  if (statuses.size === 0) {
    fail(`plans/implemented/${dir} carries no Status header in any file`)
    continue
  }
  for (const [file, status] of statuses) {
    if (status !== 'implemented') {
      fail(`plans/implemented/${dir}/${file} says \`${status}\`, but everything in this folder is implemented`)
    }
  }
}

// ── 3. Nothing outside it is finished ────────────────────────────────────────────────────────────
for (const dir of planDirectories(LIVE)) {
  const { statuses, open, partial } = readPlan(LIVE, dir)
  const values = [...statuses.values()]
  const allImplemented = values.length > 0 && values.every((status) => status === 'implemented')
  if (allImplemented && open === 0 && partial === 0) {
    fail(
      `plans/phase-1/${dir} has no open tasks and says \`implemented\` everywhere — ` +
        'it belongs in plans/implemented/. A folder that understates what is done is as unusable as one that overstates it.',
    )
  }
}

// ── 4. A plan has one home ───────────────────────────────────────────────────────────────────────
const live = new Set(planDirectories(LIVE))
for (const dir of implemented) {
  if (live.has(dir)) fail(`${dir} exists under both plans/implemented and plans/phase-1 — a plan has one home`)
}

if (failed) {
  console.error(
    '\nplans/implemented/README.md states what this folder means and the four steps for moving a plan into it.',
  )
  process.exit(1)
}

console.log(
  `OK: ${implemented.length} implemented plans have no open or partial tasks and say so in every file; ` +
    `${live.size} live plans in plans/phase-1; every Status is a readable value`,
)
