import { describe, expect, it } from 'vitest'
import { HASH_BYTES, hashStep } from './hash.js'
import { merkleRoot } from './tree.js'

const leaf = (fill: number) => new Uint8Array(HASH_BYTES).fill(fill)
const leaves = (count: number) => Array.from({ length: count }, (_, index) => leaf(index + 1))

const step = {
  type: 'model.call',
  inputHash: leaf(7),
  outputHash: leaf(8),
  private: false,
} as const

describe('merkleRoot', () => {
  it('returns a 32-byte root for any number of steps', async () => {
    for (let count = 1; count <= 9; count += 1) {
      expect((await merkleRoot(leaves(count))).byteLength).toBe(HASH_BYTES)
    }
  })

  it('is stable across calls', async () => {
    expect(await merkleRoot(leaves(5))).toEqual(await merkleRoot(leaves(5)))
  })

  it('is the step itself when the decision has one step', async () => {
    expect(await merkleRoot([leaf(1)])).toEqual(leaf(1))
  })

  it('changes when any single step changes', async () => {
    const base = await merkleRoot(leaves(5))
    for (let index = 0; index < 5; index += 1) {
      const changed = leaves(5)
      changed[index] = leaf(99)
      expect(await merkleRoot(changed)).not.toEqual(base)
    }
  })

  it('changes when two steps swap places', async () => {
    const swapped = leaves(5)
    const [first, second] = [swapped[1], swapped[0]]
    if (first === undefined || second === undefined) throw new Error('unreachable')
    swapped[0] = first
    swapped[1] = second
    expect(await merkleRoot(swapped)).not.toEqual(await merkleRoot(leaves(5)))
  })

  it('does not conflate decisions of different length', async () => {
    const roots = await Promise.all(
      Array.from({ length: 8 }, (_, index) => merkleRoot(leaves(index + 1))),
    )
    const distinct = new Set(roots.map((root) => root.join(',')))
    expect(distinct.size).toBe(roots.length)
  })

  it('does not hash an internal node the way a step is hashed', async () => {
    const pair = new Uint8Array(HASH_BYTES * 2)
    pair.set(leaf(1), 0)
    pair.set(leaf(2), HASH_BYTES)
    const undomained = new Uint8Array(await crypto.subtle.digest('SHA-256', pair))

    expect(await merkleRoot([leaf(1), leaf(2)])).not.toEqual(undomained)
  })

  it('rejects a decision without steps instead of inventing a root', async () => {
    await expect(merkleRoot([])).rejects.toThrow(/at least one/)
  })

  it('rejects a leaf of the wrong length', async () => {
    await expect(merkleRoot([leaf(1), new Uint8Array(31)])).rejects.toThrow(/32 bytes/)
  })

  it('follows a real step through to the root', async () => {
    const first = await hashStep(step)
    const second = await hashStep({ ...step, type: 'source.read' })
    const root = await merkleRoot([first, second])

    const madePrivate = await hashStep({ ...step, private: true })
    expect(await merkleRoot([madePrivate, second])).not.toEqual(root)
  })
})
