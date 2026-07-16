import { describe, it, expect } from 'vitest'
import { generateOutreach, type OutreachContext } from './outreach'

const baseContext: OutreachContext = {
  builder: {
    username: 'rustacean42',
    displayName: 'Avery',
    bio: 'Systems engineer working on async runtimes and lock-free data structures.',
    topics: ['Rust', 'Async', 'Lock-free'],
    language: 'Rust',
    followersCount: 1200,
    profileUrl: 'https://github.com/rustacean42',
    source: 'github',
  },
  job: {
    title: 'Senior Rust Engineer',
    company: 'Acme',
    description: 'building a low-latency trading platform',
  },
  tone: 'casual',
}

describe('generateOutreach', () => {
  it('includes builder display name in greeting', () => {
    const draft = generateOutreach(baseContext)
    expect(draft.body).toContain('Avery')
  })

  it('includes job title and company in body', () => {
    const draft = generateOutreach(baseContext)
    expect(draft.body).toContain('Senior Rust Engineer')
    expect(draft.body).toContain('Acme')
  })

  it('anchors on bio when present', () => {
    const draft = generateOutreach(baseContext)
    expect(draft.hookSource).toBe('bio')
    expect(draft.body).toMatch(/bio on github|catch|recent work/i)
  })

  it('falls back to topic when no bio', () => {
    const draft = generateOutreach({ ...baseContext, builder: { ...baseContext.builder, bio: null } })
    expect(draft.hookSource).toBe('topic')
    expect(draft.body).toContain('Rust')
  })

  it('falls back to language when no bio or topic', () => {
    const draft = generateOutreach({
      ...baseContext,
      builder: { ...baseContext.builder, bio: null, topics: [], language: 'Go' },
    })
    expect(draft.hookSource).toBe('language')
    expect(draft.body).toContain('Go')
  })

  it('falls back to followers for hot builder', () => {
    const draft = generateOutreach({
      ...baseContext,
      builder: { ...baseContext.builder, bio: null, topics: [], language: null, followersCount: 5000 },
    })
    expect(draft.hookSource).toBe('followers')
    expect(draft.body).toContain('5,000')
  })

  it('casual tone uses lowercase greeting', () => {
    const draft = generateOutreach({ ...baseContext, tone: 'casual' })
    expect(draft.body.startsWith('hey')).toBe(true)
  })

  it('professional tone uses "Hi" greeting', () => {
    const draft = generateOutreach({ ...baseContext, tone: 'professional' })
    expect(draft.body.startsWith('Hi')).toBe(true)
  })

  it('geek tone uses "Hey" greeting', () => {
    const draft = generateOutreach({ ...baseContext, tone: 'geek' })
    expect(draft.body.startsWith('Hey')).toBe(true)
  })

  it('subject differs by tone', () => {
    const casual = generateOutreach({ ...baseContext, tone: 'casual' })
    const professional = generateOutreach({ ...baseContext, tone: 'professional' })
    const geek = generateOutreach({ ...baseContext, tone: 'geek' })
    expect(casual.subject).not.toBe(professional.subject)
    expect(professional.subject).not.toBe(geek.subject)
  })

  it('subject is short (under 80 chars)', () => {
    const draft = generateOutreach(baseContext)
    expect(draft.subject.length).toBeLessThan(80)
  })

  it('body is under 600 chars (no essay-length outreach)', () => {
    const draft = generateOutreach(baseContext)
    expect(draft.body.length).toBeLessThan(600)
  })

  it('falls back to source when nothing else', () => {
    const draft = generateOutreach({
      ...baseContext,
      builder: {
        ...baseContext.builder,
        bio: null,
        topics: [],
        language: null,
        followersCount: 5,
      },
    })
    expect(draft.hookSource).toBe('fallback')
    expect(draft.body).toContain('github')
  })
})
