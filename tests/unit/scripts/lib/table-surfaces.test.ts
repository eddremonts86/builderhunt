import { describe, expect, it } from 'vitest'
// @ts-expect-error — a plain .mjs analysis module with no type declarations; the CLI runs it under
// bare node, so it cannot be a .ts file.
import { analyzeSource, stripComments, summarize, tableCallSiteClassNames } from '../../../../scripts/lib/table-surfaces.mjs'

/**
 * The adoption ledger, tested against source text rather than against the repository.
 *
 * The plan's validation task asks for "deliberate unmarked scratch instances fail and pass again
 * after removal", which is a check somebody performs once and then deletes the evidence of. These
 * are the same cases as permanent tests — including the three the *predecessor* got wrong, which
 * is the whole reason the gate was rewritten:
 *
 *   - three files render two `<DataTable>`s each, and a per-file count reported 17 for 20;
 *   - two files matched `<table>` because the word appears in a prose comment about tables;
 *   - "a file has a table" could not tell an interactive grid from an email's inline markup.
 */

const analyze = (text: string, path = 'src/fixture.tsx', capabilities = new Set(['sprintsCapability'])) =>
  analyzeSource({ path, text, capabilities })

const rules = (result: { problems: Array<{ rule: string }> } | null) =>
  (result?.problems ?? []).map((problem) => problem.rule)

describe('counting instances rather than files', () => {
  /** `TeamSettingsPage`, `IntegrationsPage` and `OperationsPage` each render two. */
  it('counts every <DataTable> in a file, not the file', () => {
    const result = analyze(`
      // table-surface: sprintsCapability
      export function Page() {
        return <><DataTable label="Members" /><DataTable label="Invitations" /></>
      }
    `)
    expect(result.counts.interactive).toBe(2)
  })

  /**
   * The failure that made two prose comments into "table-bearing files". `DataTable.tsx` explains
   * why it is a div tree "and not a `<table>`"; `OperationsPage.tsx` repeats the reasoning.
   */
  it('does not count the word <table> inside a comment', () => {
    const result = analyze(`
      // table-surface-ok: the shell itself
      /** Why a div tree and not a <table>: virtualized rows inside a <tbody> need spacer rows. */
      // See the <table> discussion above.
      export function Shell() { return <div role="grid" /> }
    `)
    expect(result).toBeNull()
  })

  it('blanks comments without moving any line', () => {
    const stripped = stripComments('const a = 1 // <table>\n/* <table> */\nconst b = 2')
    expect(stripped.split('\n')).toHaveLength(3)
    expect(stripped).not.toContain('<table>')
    expect(stripped).toContain('const b = 2')
  })

  /** A URL's `//` is not a comment, and blanking from it would eat the rest of the line. */
  it('leaves a protocol-relative URL alone', () => {
    expect(stripComments('const url = "https://example.com/x" // trailing')).toContain('https://example.com/x')
  })

  it('ignores a file with no table at all', () => {
    expect(analyze('export function Page() { return <div /> }')).toBeNull()
  })
})

describe('declaration', () => {
  it('fails an undeclared table', () => {
    const result = analyze('export function Page() { return <DataTable label="X" /> }')
    expect(rules(result)).toContain('undeclared')
    expect(result.problems[0].message).toContain('1 table instance')
  })

  it('reports how many instances an undeclared file has', () => {
    const result = analyze('const a = <DataTable /> ; const b = <DataTable />')
    expect(result.problems[0].message).toContain('2 table instances')
  })

  /** A surface is one of the six, not two — otherwise "which reason applies" has no answer. */
  it('fails a file carrying two markers', () => {
    const result = analyze(`
      // table-surface: sprintsCapability
      // table-surface-bounded: also bounded, somehow
      const a = <DataTable />
    `)
    expect(rules(result)).toContain('multiple-markers')
  })

  it('fails a capability that is not in the registry', () => {
    const result = analyze(`
      // table-surface: inventedCapability
      const a = <DataTable />
    `)
    expect(rules(result)).toContain('unregistered-capability')
  })

  it('accepts a registered capability', () => {
    const result = analyze(`
      // table-surface: sprintsCapability
      const a = <DataTable />
    `)
    expect(result.problems).toEqual([])
    expect(result.kind).toBe('capability')
  })

  it.each([
    ['table-surface-bounded', 'bounded'],
    ['table-surface-semantic', 'semantic'],
    ['table-surface-sr-only', 'sr-only'],
    ['table-surface-email', 'email'],
    ['table-surface-ok', 'shell'],
  ])('reads %s as the %s kind', (marker, kind) => {
    const body = kind === 'semantic' ? '<SemanticTable />' : '<DataTable />'
    expect(analyze(`// ${marker}: a reason\nconst a = ${body}`).kind).toBe(kind)
  })
})

describe('no ungoverned table primitive', () => {
  /**
   * The rule the five migrated raw tables existed to break. Each of cookies, pricing (twice), the
   * conversion funnel and the hygiene signals had grown its own header ink, borders and padding.
   */
  it('fails a visible raw <table> written outside SemanticTable', () => {
    const result = analyze(`
      // table-surface-semantic: a comparison
      const a = <table className="w-full text-sm"><tbody /></table>
    `)
    expect(rules(result)).toContain('ungoverned-table')
  })

  it('allows the primitive itself to write one', () => {
    const result = analyze(
      '// table-surface-ok: the primitive\nconst a = <table className="tbl-semantic" />',
      'src/shared/components/table/SemanticTable.tsx',
    )
    expect(rules(result)).not.toContain('ungoverned-table')
  })

  /** Nobody can see it, so the visual system has nothing to say about it. */
  it('allows a screen-reader-only table that declares itself', () => {
    const result = analyze(`
      // table-surface-sr-only: the chart's accessible equivalent
      const a = <table className="sr-only"><caption>Signups per day</caption></table>
    `)
    expect(rules(result)).not.toContain('ungoverned-table')
  })

  /** The marker is not enough on its own: the table has to actually be invisible. */
  it('still fails a visible table wearing the sr-only marker', () => {
    const result = analyze(`
      // table-surface-sr-only: claims to be invisible
      const a = <table className="w-full"><tbody /></table>
    `)
    expect(rules(result)).toContain('ungoverned-table')
  })

  it('allows email markup, which supports none of the contract', () => {
    const result = analyze(
      '// table-surface-email: inline styles for email clients\nconst html = `<table style="width:100%"></table>`',
      'src/shared/lib/email.ts',
    )
    expect(rules(result)).not.toContain('ungoverned-table')
  })

  it('fails a semantic marker on a file that renders no SemanticTable', () => {
    const result = analyze('// table-surface-semantic: claims to\nconst a = <DataTable />')
    expect(rules(result)).toContain('semantic-without-primitive')
  })
})

describe('no local visual literals', () => {
  it.each([
    'const style = { color: "#e8703a" }',
    'const shade = "rgba(0,0,0,0.5)"',
    '<div className="text-bh-text-muted" />',
    '<div className="border-bh-border" />',
  ])('fails %s inside the table shell', (line) => {
    const result = analyze(
      `// table-surface-ok: shell\nconst a = <DataTable />\n${line}`,
      'src/shared/components/table/GridRow.tsx',
    )
    expect(rules(result)).toContain('shell-colour-literal')
  })

  it('accepts the shell drawing entirely from tokens', () => {
    const result = analyze(
      '// table-surface-ok: shell\nconst a = <DataTable className="tbl-row" style={{ color: "var(--tbl-text-primary)" }} />',
      'src/shared/components/table/GridRow.tsx',
    )
    expect(rules(result)).not.toContain('shell-colour-literal')
  })

  /** The same colour outside the shell is somebody else's business — this rule is scoped on purpose. */
  it('says nothing about a colour in a surface that is not the shell', () => {
    const result = analyze(`
      // table-surface: sprintsCapability
      const badge = <span className="text-bh-accent">New</span>
      const a = <DataTable />
    `)
    expect(rules(result)).not.toContain('shell-colour-literal')
  })
})

describe('no call site restyles the table', () => {
  it.each(['bg-bh-surface', 'rounded-3xl', 'p-6', 'shadow-lg', 'border-bh-border'])(
    'fails a className of "%s"',
    (className) => {
      const result = analyze(`// table-surface: sprintsCapability\nconst a = <DataTable className="${className}" />`)
      expect(rules(result)).toContain('restyling-classname')
    },
  )

  /** Placing the table is the surface's business; painting it is the contract's. */
  it.each(['mb-8', 'flex-1', 'max-w-3xl', 'w-full', 'mt-4 flex-1'])('allows a className of "%s"', (className) => {
    const result = analyze(`// table-surface: sprintsCapability\nconst a = <DataTable className="${className}" />`)
    expect(rules(result)).not.toContain('restyling-classname')
  })

  it('finds the className wherever it sits in a multi-line call', () => {
    expect(tableCallSiteClassNames(`
      <DataTable
        label="Sprints"
        rowTestId={(row) => row.id}
        className="mb-8"
      />
    `)).toEqual(['mb-8'])
  })

  /**
   * A `cn(...)` expression cannot be judged from source, and guessing would either wave through the
   * real cases or fail honest ones. The rule targets the accidental override, always a string.
   */
  it('says nothing about a computed className', () => {
    expect(tableCallSiteClassNames('<DataTable className={cn("bg-bh-surface", extra)} />')).toEqual([])
  })

  /**
   * The failure that flagged sixteen honest surfaces at once. An `emptyState` is padded, centred
   * content the *surface* composes; it is not a restyling of the table, and reading a className out
   * of a prop expression cannot tell the two apart.
   */
  it('ignores a className inside another prop\'s JSX', () => {
    expect(tableCallSiteClassNames(`
      <DataTable
        rowTestId={(row) => row.id}
        emptyState={<div className="px-4 py-12 text-center text-sm text-bh-text-muted">Nothing yet</div>}
        className="mb-8"
      />
    `)).toEqual(['mb-8'])
  })

  /** And the arrow in a prop must not end the tag early, or the real className is never seen. */
  it('does not stop at the > in an arrow function', () => {
    expect(tableCallSiteClassNames('<DataTable rowId={(row) => row.id} className="bg-bh-surface" />'))
      .toEqual(['bg-bh-surface'])
  })

  it('ignores a className on something that is not a table', () => {
    expect(tableCallSiteClassNames('<Card className="p-6" /><DataTable className="mb-8" />')).toEqual(['mb-8'])
  })
})

describe('the ledger', () => {
  /** The unit is the rendered table, so three files rendering two each count as six. */
  it('totals instances rather than files', () => {
    const summary = summarize([
      { kind: 'capability', counts: { interactive: 2, semantic: 0, raw: 0 } },
      { kind: 'capability', counts: { interactive: 1, semantic: 0, raw: 0 } },
      { kind: 'semantic', counts: { interactive: 0, semantic: 1, raw: 0 } },
      { kind: 'sr-only', counts: { interactive: 0, semantic: 0, raw: 1 } },
      { kind: 'email', counts: { interactive: 0, semantic: 0, raw: 1 } },
    ])
    expect(summary).toMatchObject({
      files: 5,
      instances: 6,
      interactive: 3,
      semantic: 1,
      screenReaderOnly: 1,
      email: 1,
      capabilities: 2,
    })
  })
})
