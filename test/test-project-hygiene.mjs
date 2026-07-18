// e2e test for project-hygiene component
// Note: full builder profile integration requires a claimed builder in the DB
// (the /builders/:id page only renders for builders in the `builders` table).
// We test the unit logic via vitest (18 tests) and verify the component is
// exported and importable. The component is then visually verified in
// BuilderProfilePage.tsx for any future claimed builder.

import { writeFileSync } from 'fs'

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
  // Verify the component file exists and is well-formed
  const fs = await import('fs/promises')
  const componentPath = '/Users/edd/Projects/eddremonts86/builderhunt/src/shared/components/HygieneCard.tsx'
  const exists = await fs.stat(componentPath).then(() => true).catch(() => false)
  check('HygieneCard.tsx exists', exists)

  if (exists) {
    const content = await fs.readFile(componentPath, 'utf-8')
    check('exports HygieneCard', content.includes('export function HygieneCard'))
    check('uses computeHygiene', content.includes('computeHygiene'))
    check('uses estimateRepoSignalsFromBuilder', content.includes('estimateRepoSignalsFromBuilder'))
    check('uses hygieneGrade', content.includes('hygieneGrade'))
    check('has data-testid hygiene-card', content.includes('data-testid="hygiene-card"'))
    check('has data-testid hygiene-score-ring', content.includes('data-testid="hygiene-score-ring"'))
  }

  // Verify BuilderProfilePage imports and uses it
  const profilePath = '/Users/edd/Projects/eddremonts86/builderhunt/src/modules/builder-profile/components/BuilderProfilePage.tsx'
  const profileContent = await fs.readFile(profilePath, 'utf-8')
  check('BuilderProfilePage imports HygieneCard', profileContent.includes("from '~/shared/components/HygieneCard'"))
  check('BuilderProfilePage renders <HygieneCard', profileContent.includes('<HygieneCard'))

  // Sample computation via Node to verify behavior
  const { computeHygiene, estimateRepoSignalsFromBuilder, hygieneGrade } = await import(
    '../src/shared/lib/hygiene.ts'
  )

  const hotRepos = estimateRepoSignalsFromBuilder({ followersCount: 5000, topics: ['rust', 'wasm', 'async'] })
  check('hot builder gets up to 5 repos', hotRepos.length >= 3 && hotRepos.length <= 5, `got: ${hotRepos.length}`)
  const hotHygiene = computeHygiene(hotRepos)
  check('hot builder score is high', hotHygiene.globalScore >= 70, `score: ${hotHygiene.globalScore}`)

  const coldRepos = estimateRepoSignalsFromBuilder({ followersCount: 10, topics: [] })
  const coldHygiene = computeHygiene(coldRepos)
  check('cold builder has lower score than hot', coldHygiene.globalScore < hotHygiene.globalScore,
    `cold: ${coldHygiene.globalScore}, hot: ${hotHygiene.globalScore}`)

  const gradeLabel = hygieneGrade(92).label
  check('grade "Excellent" for 92', gradeLabel === 'Excellent', `got: ${gradeLabel}`)

  console.log('\n' + '='.repeat(60))
  console.log(`Total: ${pass + fail} | ✅ ${pass} | ❌ ${fail}`)
  console.log('='.repeat(60))

  writeFileSync('/tmp/builderhunt-hygiene-results.txt',
    results.join('\n') + `\n\nTotal: ${pass + fail} | ✅ ${pass} | ❌ ${fail}\n`)

  process.exit(fail === 0 ? 0 : 1)
}

run().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
