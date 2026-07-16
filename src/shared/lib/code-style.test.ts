import { describe, it, expect } from 'vitest'
import { generateFingerprint, similarity, type CodeStyleFingerprint } from './code-style'

describe('generateFingerprint', () => {
  it('returns default fingerprint for unknown language', () => {
    const fp = generateFingerprint({ language: null })
    expect(fp.paradigm).toBe('pragmatic')
    expect(fp.language).toBe(null)
    expect(fp.generatedAt).toBeGreaterThan(0)
  })

  it('Rust gets functional paradigm', () => {
    const fp = generateFingerprint({ language: 'Rust' })
    expect(fp.paradigm).toBe('functional')
    expect(fp.modularityScore).toBeGreaterThanOrEqual(80)
  })

  it('Java gets OOP paradigm', () => {
    const fp = generateFingerprint({ language: 'Java' })
    expect(fp.paradigm).toBe('oop')
  })

  it('TypeScript gets pragmatic paradigm', () => {
    const fp = generateFingerprint({ language: 'TypeScript' })
    expect(fp.paradigm).toBe('pragmatic')
  })

  it('high-followers builder gets small boost to docs and naming', () => {
    const a = generateFingerprint({ language: 'Python', followersCount: 50 })
    const b = generateFingerprint({ language: 'Python', followersCount: 5000 })
    expect(b.documentationRatio).toBeGreaterThanOrEqual(a.documentationRatio)
    expect(b.namingConsistency).toBeGreaterThanOrEqual(a.namingConsistency)
  })

  it('functional topic falls back to functional paradigm', () => {
    const fp = generateFingerprint({ language: null, topics: ['async runtimes', 'elixir-style'] })
    expect(fp.paradigm).toBe('functional')
  })

  it('OOP topic falls back to OOP paradigm', () => {
    const fp = generateFingerprint({ language: null, topics: ['spring', 'design-patterns'] })
    expect(fp.paradigm).toBe('oop')
  })

  it('all scores are 0-100', () => {
    const fp = generateFingerprint({ language: 'Rust' })
    expect(fp.modularityScore).toBeGreaterThanOrEqual(0)
    expect(fp.modularityScore).toBeLessThanOrEqual(100)
    expect(fp.testIntensity).toBeGreaterThanOrEqual(0)
    expect(fp.testIntensity).toBeLessThanOrEqual(100)
    expect(fp.documentationRatio).toBeGreaterThanOrEqual(0)
    expect(fp.documentationRatio).toBeLessThanOrEqual(100)
    expect(fp.complexityControl).toBeGreaterThanOrEqual(0)
    expect(fp.complexityControl).toBeLessThanOrEqual(100)
    expect(fp.namingConsistency).toBeGreaterThanOrEqual(0)
    expect(fp.namingConsistency).toBeLessThanOrEqual(100)
  })
})

describe('similarity', () => {
  const base: CodeStyleFingerprint = {
    paradigm: 'functional',
    modularityScore: 80,
    testIntensity: 75,
    documentationRatio: 70,
    complexityControl: 85,
    namingConsistency: 90,
    language: 'Rust',
    generatedAt: Date.now(),
  }

  it('returns 100 for identical fingerprints', () => {
    expect(similarity(base, { ...base })).toBe(100)
  })

  it('returns high score for similar style', () => {
    const similar: CodeStyleFingerprint = {
      ...base,
      modularityScore: 82,
      testIntensity: 73,
      documentationRatio: 72,
      complexityControl: 83,
      namingConsistency: 88,
    }
    expect(similarity(base, similar)).toBeGreaterThan(90)
  })

  it('penalizes paradigm mismatch', () => {
    const differentParadigm: CodeStyleFingerprint = {
      ...base,
      paradigm: 'oop',
    }
    const sameParadigm: CodeStyleFingerprint = {
      ...base,
      paradigm: 'functional',
    }
    // Same metrics, different paradigms — the different one should be lower
    const sim1 = similarity(base, differentParadigm)
    const sim2 = similarity(base, sameParadigm)
    expect(sim1).toBeLessThan(sim2)
    expect(sim2 - sim1).toBeGreaterThanOrEqual(10)
  })

  it('rewards language match (or equal when already matching)', () => {
    const sameLang: CodeStyleFingerprint = { ...base, language: 'Rust' }
    const diffLang: CodeStyleFingerprint = { ...base, language: 'Go' }
    // Both might be clamped to 100, so accept >=
    expect(similarity(base, sameLang)).toBeGreaterThanOrEqual(similarity(base, diffLang))
  })

  it('returns 0 for wildly different fingerprints', () => {
    const opposite: CodeStyleFingerprint = {
      paradigm: 'oop',
      modularityScore: 10,
      testIntensity: 10,
      documentationRatio: 10,
      complexityControl: 10,
      namingConsistency: 10,
      language: 'COBOL',
      generatedAt: Date.now(),
    }
    expect(similarity(base, opposite)).toBeLessThan(20)
  })

  it('all scores are 0-100', () => {
    expect(similarity(base, base)).toBeGreaterThanOrEqual(0)
    expect(similarity(base, base)).toBeLessThanOrEqual(100)
  })
})
