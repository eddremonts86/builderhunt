import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

const ROOT = process.cwd()
const requested = process.argv.slice(2)
const phases = requested.length > 0 ? requested : ['phase-2', 'phase-3']
const REQUIRED_FILES = ['spec.md', 'plan.md', 'tasks.md']
const REQUIRED_HEADERS = ['Status', 'Depends on', 'Blocks', 'Reality check']
const ALLOWED_STATUSES = new Set(['pending', 'partially-implemented', 'implemented', 'blocked', 'superseded'])

let failed = false
const fail = (message) => {
  console.error(`FAIL: ${message}`)
  failed = true
}

function headerBlock(text, name) {
  const marker = `> **${name}**:`
  const start = text.indexOf(marker)
  if (start === -1) return null
  const tail = text.slice(start + marker.length)
  const end = tail.search(/\n> \*\*[A-Z][^*]+\*\*:/)
  return (end === -1 ? tail : tail.slice(0, end)).trim()
}

function linkedPlanDirs(block) {
  if (!block) return []
  if (/^nothing\b/i.test(block)) return []
  return [...block.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/g)].map((match) => basename(dirname(match[1]))).sort()
}

function localLinks(file, text) {
  return [...text.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/g)]
    .map((match) => match[1])
    .filter((target) => !/^(?:https?:|mailto:)/.test(target))
    .map((target) => ({ target, absolute: resolve(dirname(file), target) }))
}

for (const phase of phases) {
  const phaseRoot = join(ROOT, 'plans', phase)
  if (!existsSync(phaseRoot)) {
    fail(`plans/${phase} does not exist`)
    continue
  }

  const directories = readdirSync(phaseRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  const positions = new Map()
  directories.forEach((directory, index) => {
    const match = /^(\d\d)-[a-z0-9-]+$/.exec(directory)
    if (!match) {
      fail(`plans/${phase}/${directory} is not named NN-slug`)
      return
    }
    const expected = index + 1
    const actual = Number(match[1])
    if (actual !== expected) {
      fail(`plans/${phase}/${directory} is position ${actual}, expected ${expected}`)
    }
    positions.set(directory, actual)
  })

  for (const directory of directories) {
    const planRoot = join(phaseRoot, directory)
    const markdown = readdirSync(planRoot)
      .filter((entry) => entry.endsWith('.md') && statSync(join(planRoot, entry)).isFile())
      .sort()
    if (JSON.stringify(markdown) !== JSON.stringify([...REQUIRED_FILES].sort())) {
      fail(
        `${relative(ROOT, planRoot)} must contain exactly spec.md, plan.md and tasks.md (found ${markdown.join(', ')})`,
      )
      continue
    }

    const contracts = []
    for (const filename of REQUIRED_FILES) {
      const file = join(planRoot, filename)
      const text = readFileSync(file, 'utf8')
      const headers = Object.fromEntries(REQUIRED_HEADERS.map((name) => [name, headerBlock(text, name)]))
      for (const name of REQUIRED_HEADERS) {
        if (!headers[name]) fail(`${relative(ROOT, file)} is missing a non-empty ${name} header`)
      }

      const status = headers.Status?.match(/^`([^`]+)`/)?.[1]
      if (!status || !ALLOWED_STATUSES.has(status)) {
        fail(`${relative(ROOT, file)} has invalid Status ${JSON.stringify(headers.Status)}`)
      }

      for (const { target, absolute } of localLinks(file, text)) {
        if (!existsSync(absolute)) fail(`${relative(ROOT, file)} has broken link ${target}`)
      }

      text.split('\n').forEach((line, index) => {
        if (/^\s*- Files:.*`drizzle\/\d{4}_[^`]+`/.test(line)) {
          fail(
            `${relative(ROOT, file)}:${index + 1} reserves a migration number; use the next-free generated migration`,
          )
        }
        if (/\b(?:TBD|FIXME|XXX|implement later|fill in details|decide later)\b/i.test(line)) {
          fail(`${relative(ROOT, file)}:${index + 1} contains a placeholder: ${line.trim()}`)
        }
      })

      contracts.push({
        file,
        status,
        depends: linkedPlanDirs(headers['Depends on']),
        blocks: linkedPlanDirs(headers.Blocks),
      })
    }

    const reference = contracts[0]
    for (const contract of contracts.slice(1)) {
      if (contract.status !== reference.status) {
        fail(`${relative(ROOT, contract.file)} Status differs from ${relative(ROOT, reference.file)}`)
      }
      if (JSON.stringify(contract.depends) !== JSON.stringify(reference.depends)) {
        fail(`${relative(ROOT, contract.file)} Depends on differs from ${relative(ROOT, reference.file)}`)
      }
      if (JSON.stringify(contract.blocks) !== JSON.stringify(reference.blocks)) {
        fail(`${relative(ROOT, contract.file)} Blocks differs from ${relative(ROOT, reference.file)}`)
      }
    }

    const position = positions.get(directory)
    for (const dependency of reference.depends) {
      const dependencyPosition = positions.get(dependency)
      if (dependencyPosition !== undefined && dependencyPosition >= position) {
        fail(`${relative(ROOT, reference.file)} depends on non-earlier ${dependency}`)
      }
    }
  }
}

if (failed) process.exit(1)
console.log(
  `OK: ${phases.join(', ')} have contiguous order, exact trios, complete aligned headers, valid links, and no reserved migration numbers or placeholders`,
)
