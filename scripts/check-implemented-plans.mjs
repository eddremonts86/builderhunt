import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Keeps the archive true, keeps it complete, and enforces the standing rule that a finished plan moves
 * into it.
 *
 * ## Why this is not `check-phase-readiness.mjs`
 *
 * That script asks "is this plan ready to be executed?" — no reserved migration numbers, no
 * placeholders, an exact `spec.md`/`plan.md`/`tasks.md` file set. Every one of those rules is about work
 * that has not happened yet. Run over the archive it produced 52 failures, and 22 of them were task texts
 * naming the migration a plan *actually created*. Satisfying them would mean rewriting the record of what
 * happened to please a forward-looking lint, which is the wrong direction entirely.
 *
 * So this checks the claims the archive itself makes, and nothing else:
 *
 * 1. **Everything in it is done.** No `- [ ]`, no `- [~]`, and `implemented` in every file that carries a
 *    Status header. Both markers count: `- [~]` is the one that hides, because every status report in
 *    this repository greps for `- [ ]` alone and nine real tasks were once invisible for exactly that.
 * 2. **Everything done is in it.** A plan in a live phase with zero open tasks and `implemented`
 *    everywhere belongs in the archive. This is the standing rule — *finish a plan, move it* — enforced
 *    rather than remembered, because an archive that understates what is done is as unusable as one that
 *    overstates it: a reader then has to check both trees anyway.
 * 3. **No checked box contradicts itself.** A `- [x]` whose own text says "not implemented" must name the
 *    plan that owns the work now. This is the rule the others could not see, and the one that caught the
 *    most: four checked tasks said the opposite of their marker while every mechanical condition passed.
 *
 * It also checks the vocabulary everywhere: a Status outside the five values
 * `check-phase-readiness.mjs` accepts is a status no gate can read, and that is how eight of them drifted
 * across phase 1 for weeks while four plans sat at 100% of their tasks still labelled `pending`.
 *
 * ## Why the archive is split by phase
 *
 * Plan numbers are unique only *within* a phase. Phase 3 is numbered 01-13 and twelve of those collide
 * with phase 1's, so a flat archive could hold one phase and no more. `plans/implemented/<phase>/` is what
 * lets both live there, and `check-plan-order.mjs` reads a phase's live directory together with its
 * archive so the build order still reads as one contiguous sequence.
 */
const ROOT = process.cwd()
const ARCHIVE = join(ROOT, 'plans', 'implemented')

/**
 * The phases whose plans are still being worked.
 *
 * Every one of them has rule 2 applied: finish a plan and the gate tells you to move it. Listing all five
 * rather than only the started ones costs nothing today and means the rule is already in force on the day
 * a phase-4 plan first closes — which is exactly the day nobody would remember to add it.
 */
const LIVE_PHASES = ['phase-1', 'phase-2', 'phase-3', 'phase-4', 'phase-5']

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

/** Every plan directory in the repository, tagged with its phase and whether it is archived. */
function allPlans() {
  const out = []
  for (const phase of planDirectories(ARCHIVE)) {
    const root = join(ARCHIVE, phase)
    for (const dir of planDirectories(root)) out.push({ phase, root, dir, archived: true })
  }
  for (const phase of LIVE_PHASES) {
    const root = join(ROOT, 'plans', phase)
    for (const dir of planDirectories(root)) out.push({ phase, root, dir, archived: false })
  }
  return out
}

const plans = allPlans()

// ── 1. Every status, everywhere, is a value a gate can read ──────────────────────────────────────
for (const { root, dir } of plans) {
  const { statuses } = readPlan(root, dir)
  for (const [file, status] of statuses) {
    if (!ALLOWED_STATUSES.has(status)) {
      fail(
        `${relative(ROOT, root)}/${dir}/${file} has Status \`${status}\`, which no gate can read — use one of ` +
          `${[...ALLOWED_STATUSES].join(', ')} and keep the nuance as prose beside it`,
      )
    }
  }
}

// ── 2. Everything in the archive is finished ─────────────────────────────────────────────────────
for (const { phase, root, dir, archived } of plans) {
  if (!archived) continue
  const { files, statuses, open, partial } = readPlan(root, dir)
  if (files.length === 0) {
    fail(`plans/implemented/${phase}/${dir} has no markdown file`)
    continue
  }
  if (open > 0 || partial > 0) {
    fail(
      `plans/implemented/${phase}/${dir} is not finished: ${open} open and ${partial} partial task(s). ` +
        `Move it back to plans/${phase}/ or close them.`,
    )
  }
  if (statuses.size === 0) {
    fail(`plans/implemented/${phase}/${dir} carries no Status header in any file`)
    continue
  }
  for (const [file, status] of statuses) {
    if (status !== 'implemented') {
      fail(
        `plans/implemented/${phase}/${dir}/${file} says \`${status}\`, but everything in the archive is implemented`,
      )
    }
  }
}

/**
 * ── 3. Finish a plan, move it ───────────────────────────────────────────────────────────────────
 *
 * The standing rule, enforced rather than remembered. A plan with no open work whose every file says
 * `implemented` is finished, and a finished plan belongs in the archive.
 *
 * `superseded` and `blocked` plans are untouched by this: they have no open tasks either, and they were
 * never built, so filing them as implemented would be the opposite of the point.
 */
for (const { phase, root, dir, archived } of plans) {
  if (archived) continue
  const { statuses, open, partial } = readPlan(root, dir)
  const values = [...statuses.values()]
  const allImplemented = values.length > 0 && values.every((status) => status === 'implemented')
  if (allImplemented && open === 0 && partial === 0) {
    fail(
      `plans/${phase}/${dir} is finished — no open tasks, \`implemented\` in every file — so it belongs in ` +
        `plans/implemented/${phase}/. Run: git mv plans/${phase}/${dir} plans/implemented/${phase}/${dir}`,
    )
  }
}

/**
 * ── 4. A checked box that admits it was not done ─────────────────────────────────────────────────
 *
 * The archive's whole claim rests on `- [x]`, and on 2026-08-11 four checked tasks carried titles saying
 * the opposite — "not implemented this pass", "NOT done as a dedicated test task", "not done, needs a
 * human", "moved, not done". Every mechanical condition passed. The text said no.
 *
 * Three of those four turned out to be *already built*, with only their titles stale; the fourth had
 * genuinely moved to phase 5. So the rule is not "never admit a gap" — it is **say where the work went**,
 * with a link to the plan that owns it now, because a link is checkable and a promise is not.
 *
 * Any `plans/phase-N/` pointer counts, not only phase 5. It was phase-5-only until 2026-08-11, when two of
 * plan 57's Wave 5 tasks moved to `plans/phase-4/saved-search-health` and
 * `plans/phase-4/hiring-pipeline-kanban` — the plans that build the capabilities those widgets read. Work
 * moves to whoever owns the capability, which is not always the launch phase, and a rule that only
 * recognised phase 5 would have pushed the next such move into a false phase-5 reference to satisfy a lint.
 *
 * Deliberately still narrow: "deferred to a later pass" with no pointer fails, which is the sentence that
 * lets a gap sit unowned for weeks.
 */
const ADMITS_NOT_DONE = /(not implemented|not attempted|not done|not started|skipped|deferred|not built|not wired|not written)/i
const NAMES_A_NEW_OWNER = /plans\/phase-[1-5]\/|phase-[1-5]\/[0-9]{2}-/

for (const { root, dir } of plans) {
  for (const name of markdownFiles(root, dir)) {
    const lines = readFileSync(join(root, dir, name), 'utf8').split('\n')
    for (const [index, line] of lines.entries()) {
      if (!/^\s*[-*]\s*\[x\]/.test(line) || !ADMITS_NOT_DONE.test(line)) continue
      // The pointer may sit on the task's continuation lines rather than its title, which is how plan 43
      // already wrote it. Seven lines is the whole of a task block in this repository's format.
      if (NAMES_A_NEW_OWNER.test(lines.slice(index, index + 7).join(' '))) continue
      fail(
        `${relative(ROOT, root)}/${dir}/${name}:${index + 1} is checked but its own text says it was not done, ` +
          `and names no owner: "${line.trim().slice(0, 96)}". Either close it, or move it to a plans/phase-5/ ` +
          'plan and link that.',
      )
    }
  }
}

// ── 5. A plan has one home ───────────────────────────────────────────────────────────────────────
const homes = new Set()
for (const { phase, dir } of plans) {
  const key = `${phase}/${dir}`
  if (homes.has(key)) fail(`${key} exists both in plans/${phase}/ and in the archive — a plan has one home`)
  homes.add(key)
}

if (failed) {
  console.error('\nplans/implemented/README.md states what the archive means and the steps for moving a plan into it.')
  process.exit(1)
}

const archived = plans.filter((plan) => plan.archived)
const live = plans.filter((plan) => !plan.archived)
const byPhase = [...new Set(archived.map((plan) => plan.phase))]
  .sort()
  .map((phase) => `${phase} ${archived.filter((plan) => plan.phase === phase).length}`)
  .join(', ')
console.log(
  `OK: ${archived.length} archived plans (${byPhase}), none carrying open or partial tasks; ` +
    `${live.length} live plans, none of them finished`,
)
