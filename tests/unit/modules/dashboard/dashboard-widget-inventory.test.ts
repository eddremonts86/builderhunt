import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { HOME_WIDGETS } from '~/modules/dashboard/components/DashboardPage'

/**
 * The inventory matches the registry (plan: phase-2/04-dashboard-personalizado, task 1).
 *
 * `docs/architecture/dashboard-widget-inventory.md` is the list a preset author reads before
 * deciding what each segment's dashboard promotes. It is derived from `HOME_WIDGETS`, and a derived
 * document nobody checks is accurate for exactly as long as nobody touches the dashboard — which is
 * to say, until the next deploy.
 *
 * So the table is parsed and compared. What is asserted is identity and the two facts a preset can
 * get wrong: the span it will occupy, and whether it disappears when it has nothing to say. The
 * prose around the table is not asserted; it is judgement, and a test that pinned it would fail on
 * every rewording.
 */

const INVENTORY = 'docs/architecture/dashboard-widget-inventory.md'

interface Row {
  id: string
  title: string
  span: string
  whenEmpty: string
}

async function documentedWidgets(): Promise<Row[]> {
  const markdown = await readFile(INVENTORY, 'utf8')
  const rows: Row[] = []
  for (const line of markdown.split('\n')) {
    // Only the widget table: its first cell is a backticked id, which no other table here has.
    const match = /^\| `([a-z-]+)` \| ([^|]+?) \| ([^|]+?) \| [^|]* \| [^|]* \| ([^|]+?) \|$/.exec(line.trim())
    if (!match) continue
    rows.push({ id: match[1], title: match[2].trim(), span: match[3].trim(), whenEmpty: match[4].trim() })
  }
  return rows
}

describe('the widget inventory', () => {
  it('lists every registered widget exactly once', async () => {
    const documented = await documentedWidgets()
    const registered = HOME_WIDGETS.map((widget) => widget.id)

    expect(documented.length).toBeGreaterThan(0)
    expect(new Set(documented.map((row) => row.id)).size).toBe(documented.length)
    // Sorted, because the document is ordered for reading and the registry for rendering. Comparing
    // sequence would make a reorder of the page a documentation failure, which it is not.
    expect(documented.map((row) => row.id).sort()).toEqual([...registered].sort())
  })

  it('gives each widget the title the Customize dialog will show', async () => {
    const byId = new Map(HOME_WIDGETS.map((widget) => [widget.id, widget]))
    for (const row of await documentedWidgets()) {
      expect(row.title, row.id).toBe(byId.get(row.id)!.title)
    }
  })

  /**
   * The two columns a preset author acts on. A row that says `hide` is a widget that can leave the
   * page entirely, and a route built from four of them can render blank to a new account — which is
   * the failure a segmented dashboard reaches first.
   */
  it('records the span and the empty behaviour correctly', async () => {
    const byId = new Map(HOME_WIDGETS.map((widget) => [widget.id, widget]))
    for (const row of await documentedWidgets()) {
      const widget = byId.get(row.id)!
      expect(row.span, `${row.id} span`).toBe(widget.span)

      const declared = widget.whenEmpty
      if (declared === undefined) {
        // No `whenEmpty` means the widget renders its own copy at full size — the table says so in
        // prose rather than repeating a field that is not there.
        expect(row.whenEmpty, `${row.id} whenEmpty`).toMatch(/own copy|n\/a/)
      } else {
        expect(row.whenEmpty, `${row.id} whenEmpty`).toBe(`\`${declared}\``)
      }
    }
  })

  /**
   * `action-queue` is the only critical widget, and the inventory says a preset may not hide it.
   * If a second one appears, that sentence needs to name it — a rule stated about one widget reads
   * as being about that widget.
   */
  it('still has exactly one critical widget, as the inventory claims', async () => {
    const critical = HOME_WIDGETS.filter((widget) => widget.criticality === 'critical').map((w) => w.id)
    expect(critical).toEqual(['action-queue'])
    expect(await readFile(INVENTORY, 'utf8')).toContain('`action-queue` is the only one today')
  })
})
