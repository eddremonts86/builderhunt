import { describe, expect, it } from 'vitest'
import {
  SPAN_CLASS,
  resolveBentoLayout,
  xlColumnsUsed,
  type BentoWidget,
} from '~/modules/dashboard/ui/bento/layout'

interface Ctx {
  builders: number
  searches: number
  isAdmin: boolean
}

const ctx: Ctx = { builders: 4, searches: 2, isAdmin: false }

function widget(overrides: Partial<BentoWidget<Ctx>> & { id: string }): BentoWidget<Ctx> {
  return { span: 'third', render: () => null, ...overrides }
}

describe('resolveBentoLayout', () => {
  it('keeps declared spans in bento density', () => {
    const layout = resolveBentoLayout(
      [widget({ id: 'a', span: 'twoThirds' }), widget({ id: 'b', span: 'quarter' })],
      ctx,
    )
    expect(layout.map((r) => [r.members[0].widget.id, r.span])).toEqual([
      ['a', 'twoThirds'],
      ['b', 'quarter'],
    ])
  })

  it('forces every widget full-width in sections density', () => {
    const layout = resolveBentoLayout(
      [widget({ id: 'a', span: 'twoThirds' }), widget({ id: 'b', span: 'quarter' })],
      ctx,
      'sections',
    )
    expect(layout.every((r) => r.span === 'full')).toBe(true)
  })

  it('drops widgets whose isVisible is false', () => {
    const layout = resolveBentoLayout(
      [
        widget({ id: 'tenant' }),
        widget({ id: 'admin-only', isVisible: (c) => c.isAdmin }),
      ],
      ctx,
    )
    expect(layout.map((r) => r.members[0].widget.id)).toEqual(['tenant'])
  })

  it('shrinks an empty widget to its whenEmpty span', () => {
    const layout = resolveBentoLayout(
      [widget({ id: 'searches', span: 'half', isEmpty: () => true, whenEmpty: 'quarter' })],
      ctx,
    )
    expect(layout[0]).toMatchObject({ span: 'quarter' })
    expect(layout[0].members[0].isEmpty).toBe(true)
  })

  it('removes an empty widget that asked to be hidden', () => {
    const layout = resolveBentoLayout(
      [widget({ id: 'gone', isEmpty: () => true, whenEmpty: 'hide' })],
      ctx,
    )
    expect(layout).toEqual([])
  })

  it('keeps an empty widget at full size when it declares no whenEmpty', () => {
    const layout = resolveBentoLayout(
      [widget({ id: 'stays', span: 'twoThirds', isEmpty: () => true })],
      ctx,
    )
    expect(layout[0]).toMatchObject({ span: 'twoThirds' })
    expect(layout[0].members[0].isEmpty).toBe(true)
  })

  it('treats a widget without isEmpty as non-empty', () => {
    const layout = resolveBentoLayout([widget({ id: 'always', whenEmpty: 'hide' })], ctx)
    expect(layout).toHaveLength(1)
    expect(layout[0].members[0].isEmpty).toBe(false)
  })

  // The reason `whenEmpty: 'hide'` exists: a hidden widget must not be
  // resolved *and then* skipped at render time, or the grid keeps its column.
  it('does not reserve columns for hidden or collapsed widgets', () => {
    const widgets = [
      widget({ id: 'twoThirds', span: 'twoThirds' }),
      widget({ id: 'a', span: 'quarter' }),
      widget({ id: 'b', span: 'quarter' }),
      widget({ id: 'ghost', span: 'twoThirds', isEmpty: () => true, whenEmpty: 'hide' }),
    ]
    // twoThirds 8 + quarter 3 + quarter 3 = 14, and the hidden one adds nothing.
    expect(xlColumnsUsed(resolveBentoLayout(widgets, ctx))).toBe(14)
  })
})

describe('SPAN_CLASS', () => {
  it('emits literal Tailwind classes for every span', () => {
    // Interpolated class names are invisible to Tailwind's scanner, so these
    // must stay literal strings — this guards against someone "simplifying"
    // the map into a template literal.
    for (const cls of Object.values(SPAN_CLASS)) {
      expect(cls).toMatch(/^md:col-span-\d+ xl:col-span-\d+$/)
    }
  })

  it('never exceeds the grid width at either breakpoint', () => {
    for (const cls of Object.values(SPAN_CLASS)) {
      const [md, xl] = cls.split(' ').map((c) => Number(c.replace(/\D+/g, '')))
      expect(md).toBeLessThanOrEqual(6)
      expect(xl).toBeLessThanOrEqual(12)
    }
  })
})

describe('minSpan clamp', () => {
  it('refuses to render a widget below its declared minimum', () => {
    const layout = resolveBentoLayout(
      [widget({ id: 'grid', span: 'quarter', minSpan: 'twoThirds' })],
      ctx,
    )
    expect(layout[0].span).toBe('twoThirds')
  })

  it('clamps a whenEmpty collapse to the minimum', () => {
    // The failure this prevents: a card grid shrinking to a quarter when empty
    // and truncating every name in it.
    const layout = resolveBentoLayout(
      [widget({ id: 'grid', span: 'full', minSpan: 'half', isEmpty: () => true, whenEmpty: 'quarter' })],
      ctx,
    )
    expect(layout[0].span).toBe('half')
  })

  it('leaves a span alone when it already exceeds the minimum', () => {
    const layout = resolveBentoLayout(
      [widget({ id: 'wide', span: 'full', minSpan: 'third' })],
      ctx,
    )
    expect(layout[0].span).toBe('full')
  })
})

describe('sectionGroup merging', () => {
  const metrics = ['a', 'b', 'c'].map((id) =>
    widget({ id, span: 'quarter', sectionGroup: 'metrics' }),
  )

  it('leaves grouped widgets as separate tiles in bento density', () => {
    const layout = resolveBentoLayout(metrics, ctx)
    expect(layout).toHaveLength(3)
    expect(layout.every((tile) => tile.members.length === 1)).toBe(true)
  })

  it('merges a consecutive run into one full-width tile in sections density', () => {
    const layout = resolveBentoLayout(metrics, ctx, 'sections')
    expect(layout).toHaveLength(1)
    expect(layout[0]).toMatchObject({ key: 'group:metrics', span: 'full' })
    expect(layout[0].members.map((m) => m.widget.id)).toEqual(['a', 'b', 'c'])
  })

  it('breaks the run when an ungrouped widget sits between members', () => {
    const layout = resolveBentoLayout(
      [metrics[0], widget({ id: 'chart', span: 'twoThirds' }), metrics[1]],
      ctx,
      'sections',
    )
    expect(layout.map((t) => t.key)).toEqual(['group:metrics', 'chart', 'group:metrics'])
  })

  it('keeps separate groups in separate tiles', () => {
    const layout = resolveBentoLayout(
      [metrics[0], widget({ id: 'x', sectionGroup: 'money' })],
      ctx,
      'sections',
    )
    expect(layout.map((t) => t.key)).toEqual(['group:metrics', 'group:money'])
  })

  it('does not merge a hidden widget into a group', () => {
    const layout = resolveBentoLayout(
      [metrics[0], widget({ id: 'gone', sectionGroup: 'metrics', isEmpty: () => true, whenEmpty: 'hide' })],
      ctx,
      'sections',
    )
    expect(layout[0].members.map((m) => m.widget.id)).toEqual(['a'])
  })
})
