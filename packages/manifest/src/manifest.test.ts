import { describe, expect, it } from 'vitest'
import { hashStep } from './hash.js'
import {
  type Manifest,
  MANIFEST_VERSION,
  canonicalManifest,
  fromHex,
  manifestDigest,
  parseManifest,
  stepsRoot,
  toHex,
} from './manifest.js'
import { merkleRoot } from './tree.js'

const hex = (fill: number, bytes = 32) => fill.toString(16).padStart(2, '0').repeat(bytes)

const manifest: Manifest = {
  version: MANIFEST_VERSION,
  agentPubkey: hex(0xab),
  decisionId: hex(0x0c, 16),
  model: 'claude-opus-5',
  sources: ['https://quotes.example/sol-usdc'],
  root: hex(0x11),
  decidedAt: 1_760_000_000_000,
  outcome: { action: 'swap', pair: 'SOL/USDC' },
  steps: [
    {
      type: 'source.read',
      private: false,
      input: { url: 'https://quotes.example/sol-usdc' },
      output: { price: 187.4 },
      inputHash: hex(0x01),
      outputHash: hex(0x02),
    },
    {
      type: 'model.call',
      private: true,
      inputHash: hex(0x03),
      outputHash: hex(0x04),
    },
  ],
}

describe('parseManifest', () => {
  it('accepts a manifest carrying everything FR-004 requires', () => {
    expect(parseManifest(manifest)).toEqual(manifest)
  })

  it('rejects an unknown field instead of dropping it', () => {
    expect(() => parseManifest({ ...manifest, note: 'hello' })).toThrow()
  })

  it('rejects a digest that is not lowercase hex of the right length', () => {
    expect(() => parseManifest({ ...manifest, root: hex(0xab).toUpperCase() })).toThrow()
    expect(() => parseManifest({ ...manifest, root: hex(0x11, 31) })).toThrow()
    expect(() => parseManifest({ ...manifest, agentPubkey: 'zz'.repeat(32) })).toThrow()
  })

  it('rejects a private step that carries its content anyway', () => {
    const leaked = { ...manifest.steps[1], input: { prompt: 'secret' } }
    expect(() => parseManifest({ ...manifest, steps: [manifest.steps[0], leaked] })).toThrow()
  })

  it('rejects a decision without steps', () => {
    expect(() => parseManifest({ ...manifest, steps: [] })).toThrow()
  })

  it('rejects a decision time that is not whole milliseconds', () => {
    expect(() => parseManifest({ ...manifest, decidedAt: 1.5 })).toThrow()
    expect(() => parseManifest({ ...manifest, decidedAt: -1 })).toThrow()
  })

  it('rejects a manifest of an unknown format version', () => {
    expect(() => parseManifest({ ...manifest, version: 2 })).toThrow()
  })
})

describe('canonicalManifest', () => {
  it('does not depend on the order the fields were written in', () => {
    const shuffled = {
      steps: manifest.steps,
      outcome: manifest.outcome,
      decidedAt: manifest.decidedAt,
      root: manifest.root,
      sources: manifest.sources,
      model: manifest.model,
      decisionId: manifest.decisionId,
      agentPubkey: manifest.agentPubkey,
      version: manifest.version,
    }
    expect(canonicalManifest(shuffled)).toBe(canonicalManifest(manifest))
  })

  it('is stable across calls', () => {
    expect(canonicalManifest(manifest)).toBe(canonicalManifest(manifest))
  })

  it('carries no content for a private step', () => {
    const canonical = canonicalManifest(manifest)
    expect(canonical).toContain('"price"')
    expect(canonical.match(/"input"/g)).toHaveLength(1)
  })

  it('refuses to canonicalize what it would refuse to parse', () => {
    expect(() => canonicalManifest({ ...manifest, root: 'nope' })).toThrow()
  })
})

describe('manifestDigest', () => {
  it('returns a 32-byte digest', async () => {
    expect((await manifestDigest(manifest)).byteLength).toBe(32)
  })

  it('changes when any field of the decision changes', async () => {
    const base = await manifestDigest(manifest)
    const variants: Manifest[] = [
      { ...manifest, model: 'claude-sonnet-5' },
      { ...manifest, decidedAt: manifest.decidedAt + 1 },
      { ...manifest, outcome: { action: 'hold', pair: 'SOL/USDC' } },
      { ...manifest, root: hex(0x12) },
      { ...manifest, agentPubkey: hex(0xac) },
      { ...manifest, sources: [...manifest.sources, 'https://other.example'] },
    ]

    for (const variant of variants) {
      expect(await manifestDigest(variant)).not.toEqual(base)
    }
  })

  it('changes when steps swap places', async () => {
    const [first, second] = manifest.steps
    if (first === undefined || second === undefined) throw new Error('unreachable')
    const swapped: Manifest = { ...manifest, steps: [second, first] }
    expect(await manifestDigest(swapped)).not.toEqual(await manifestDigest(manifest))
  })
})

describe('stepsRoot', () => {
  it('is the tree root over the step digests, not a second definition of it', async () => {
    const leaves = await Promise.all(
      manifest.steps.map((step) =>
        hashStep({
          type: step.type,
          inputHash: fromHex(step.inputHash),
          outputHash: fromHex(step.outputHash),
          private: step.private,
        }),
      ),
    )
    expect(await stepsRoot(manifest.steps)).toEqual(await merkleRoot(leaves))
  })

  it('changes when a step becomes private', async () => {
    const [first, second] = manifest.steps
    if (first === undefined || second === undefined) throw new Error('unreachable')
    const hidden = await stepsRoot([
      {
        type: first.type,
        private: true,
        inputHash: first.inputHash,
        outputHash: first.outputHash,
      },
      second,
    ])
    expect(hidden).not.toEqual(await stepsRoot(manifest.steps))
  })
})

describe('hex', () => {
  it('round-trips bytes', () => {
    const bytes = Uint8Array.of(0, 1, 15, 16, 255)
    expect(fromHex(toHex(bytes))).toEqual(bytes)
  })

  it('rejects a string that is not whole lowercase bytes', () => {
    expect(() => fromHex('abc')).toThrow(/hex/)
    expect(() => fromHex('AB')).toThrow(/hex/)
    expect(() => fromHex('zz')).toThrow(/hex/)
  })
})
