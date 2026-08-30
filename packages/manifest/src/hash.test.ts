import { describe, expect, it } from 'vitest'
import { HASH_BYTES, canonicalize, hashStep, hashValue } from './hash.js'

const zeros = new Uint8Array(HASH_BYTES)
const ones = new Uint8Array(HASH_BYTES).fill(1)

const step = {
  type: 'model.call',
  inputHash: zeros,
  outputHash: ones,
  private: false,
} as const

describe('canonicalize', () => {
  it('is independent of object key order', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }))
  })

  it('sorts nested keys too', () => {
    expect(canonicalize({ o: { z: 1, a: 2 } })).toBe('{"o":{"a":2,"z":1}}')
  })

  it('keeps array order, which is meaningful', () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]))
  })

  it('does not conflate a number with its string form', () => {
    expect(canonicalize(1)).not.toBe(canonicalize('1'))
  })

  it('rejects values that cannot round-trip', () => {
    expect(() => canonicalize(undefined)).toThrow(/undefined/)
    expect(() => canonicalize(Number.NaN)).toThrow(/finite/)
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(/finite/)
    expect(() => canonicalize(10n)).toThrow(/bigint/)
    expect(() => canonicalize({ a: undefined })).toThrow(/undefined/)
  })

  it('rejects objects that are not plain, rather than guessing their shape', () => {
    expect(() => canonicalize(new Date(0))).toThrow(/plain/)
    expect(() => canonicalize(() => 1)).toThrow(/function/)
  })
})

describe('hashValue', () => {
  it('returns a 32-byte digest', async () => {
    expect((await hashValue({ a: 1 })).byteLength).toBe(HASH_BYTES)
  })

  it('is stable across calls', async () => {
    expect(await hashValue({ a: 1 })).toEqual(await hashValue({ a: 1 }))
  })

  it('ignores key order but not content', async () => {
    expect(await hashValue({ a: 1, b: 2 })).toEqual(await hashValue({ b: 2, a: 1 }))
    expect(await hashValue({ a: 1 })).not.toEqual(await hashValue({ a: 2 }))
  })
})

describe('hashStep', () => {
  it('returns a 32-byte leaf', async () => {
    expect((await hashStep(step)).byteLength).toBe(HASH_BYTES)
  })

  it('changes when the private flag changes', async () => {
    expect(await hashStep(step)).not.toEqual(await hashStep({ ...step, private: true }))
  })

  it('changes when the type changes', async () => {
    expect(await hashStep(step)).not.toEqual(await hashStep({ ...step, type: 'source.read' }))
  })

  it('does not conflate a longer type with a shorter one', async () => {
    const a = await hashStep({ ...step, type: 'ab' })
    const b = await hashStep({ ...step, type: 'a' })
    expect(a).not.toEqual(b)
  })

  it('rejects a digest of the wrong length', async () => {
    await expect(hashStep({ ...step, inputHash: new Uint8Array(31) })).rejects.toThrow(/inputHash/)
    await expect(hashStep({ ...step, outputHash: new Uint8Array(0) })).rejects.toThrow(/outputHash/)
  })
})
