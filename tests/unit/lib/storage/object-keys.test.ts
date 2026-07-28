import { describe, expect, it } from 'vitest'
import {
  CLEAN_PREFIX,
  ObjectKeyError,
  QUARANTINE_PREFIX,
  cleanKeyFor,
  isCleanKey,
  isQuarantineKey,
  quarantineKeyFor,
} from '~/lib/storage/object-keys'

const ids = { organizationId: 'org-abc', submissionId: 'sub-def', documentId: 'doc-123' }

describe('quarantineKeyFor', () => {
  it('builds a key from the three identifiers and nothing else', () => {
    expect(quarantineKeyFor(ids)).toBe(`${QUARANTINE_PREFIX}org-abc/sub-def/doc-123`)
  })

  it('carries no candidate data', () => {
    // Keys reach access logs, proxy logs, error traces and signed URLs. A filename here would leak
    // a name and a job search to anyone reading operational output, which is why the signature has
    // nowhere to pass one.
    const key = quarantineKeyFor(ids)
    expect(key).not.toMatch(/\.(pdf|docx|txt)$/)
    expect(key.split('/')).toHaveLength(4)
  })

  it.each([
    ['a path separator', 'a/b'],
    ['a traversal segment', '..'],
    ['an empty id', ''],
    ['a leading slash', '/abc'],
    ['a space', 'a b'],
  ])('refuses %s in an identifier', (_label, value) => {
    // Server-generated today, but a `/` slipping in would let one document's key address another
    // document's object — too cheap a check to leave to the caller's discipline.
    expect(() => quarantineKeyFor({ ...ids, documentId: value })).toThrow(ObjectKeyError)
  })
})

describe('cleanKeyFor', () => {
  it('substitutes the prefix rather than rebuilding the key', () => {
    // Rebuilding from the document's fields is the tempting version and the dangerous one: a
    // rebuild that disagreed by one character would move the object to a key the database does not
    // record, leaving the document scanned, intact and permanently unreachable.
    const quarantine = quarantineKeyFor(ids)
    expect(cleanKeyFor(quarantine)).toBe(`${CLEAN_PREFIX}org-abc/sub-def/doc-123`)
    expect(cleanKeyFor(quarantine).slice(CLEAN_PREFIX.length))
      .toBe(quarantine.slice(QUARANTINE_PREFIX.length))
  })

  it('refuses a key that is not quarantined', () => {
    // "Promote this to clean" is only meaningful for something currently quarantined. Answering it
    // for an already-clean key would hide a caller that has lost track of state.
    expect(() => cleanKeyFor(`${CLEAN_PREFIX}org/sub/doc`)).toThrow(ObjectKeyError)
    expect(() => cleanKeyFor('org/sub/doc')).toThrow(ObjectKeyError)
  })
})

describe('prefix predicates', () => {
  it('classifies both prefixes', () => {
    const quarantine = quarantineKeyFor(ids)
    expect(isQuarantineKey(quarantine)).toBe(true)
    expect(isCleanKey(quarantine)).toBe(false)
    expect(isCleanKey(cleanKeyFor(quarantine))).toBe(true)
    expect(isQuarantineKey(cleanKeyFor(quarantine))).toBe(false)
  })
})
