import { describe, expect, it } from 'vitest'
import { fromHex, MANIFEST_VERSION, type Manifest, toHex } from './manifest.js'
import {
  type AgentKeyPair,
  generateAgentKey,
  parseSignedManifest,
  signManifest,
  verifySignedManifest,
} from './signature.js'

const hex = (fill: number, bytes = 32) => fill.toString(16).padStart(2, '0').repeat(bytes)

const key = await generateAgentKey()
const otherKey = await generateAgentKey()

function manifestOf(pubkey: string): Manifest {
  return {
    version: MANIFEST_VERSION,
    agentPubkey: pubkey,
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
    ],
  }
}

function flipFirstByte(signature: string): string {
  const bytes = fromHex(signature)
  const [first] = bytes
  if (first === undefined) throw new Error('unreachable')
  bytes[0] = first ^ 0xff
  return toHex(bytes)
}

describe('generateAgentKey', () => {
  it('returns a 32-byte public key and a private key that never leaves as raw bytes', async () => {
    const fresh = await generateAgentKey()
    expect(fresh.publicKey).toMatch(/^[0-9a-f]{64}$/)
    expect(fresh.privateKey.byteLength).toBeGreaterThan(0)
  })

  it('returns a different key every time', async () => {
    const [a, b] = await Promise.all([generateAgentKey(), generateAgentKey()])
    expect(a.publicKey).not.toBe(b.publicKey)
  })
})

describe('signManifest', () => {
  it('produces an envelope that verifies', async () => {
    const signed = await signManifest(manifestOf(key.publicKey), key)
    expect(signed.signature).toMatch(/^[0-9a-f]{128}$/)
    expect(await verifySignedManifest(signed)).toBe(true)
  })

  it('refuses to sign a manifest that names another agent', async () => {
    await expect(signManifest(manifestOf(otherKey.publicKey), key)).rejects.toThrow(/agentPubkey/)
  })

  it('refuses to sign what the format would reject', async () => {
    const broken = { ...manifestOf(key.publicKey), root: 'nope' }
    await expect(signManifest(broken, key)).rejects.toThrow()
  })
})

describe('verifySignedManifest', () => {
  it('fails when any field of the decision changed after signing', async () => {
    const signed = await signManifest(manifestOf(key.publicKey), key)
    const tampered = {
      ...signed,
      manifest: { ...signed.manifest, outcome: { action: 'hold', pair: 'SOL/USDC' } },
    }
    expect(await verifySignedManifest(tampered)).toBe(false)
  })

  it('fails when the signature itself is altered', async () => {
    const signed = await signManifest(manifestOf(key.publicKey), key)
    expect(
      await verifySignedManifest({ ...signed, signature: flipFirstByte(signed.signature) }),
    ).toBe(false)
  })

  it('fails when the manifest is re-attributed to another agent', async () => {
    const signed = await signManifest(manifestOf(key.publicKey), key)
    const reattributed = {
      ...signed,
      manifest: { ...signed.manifest, agentPubkey: otherKey.publicKey },
    }
    expect(await verifySignedManifest(reattributed)).toBe(false)
  })

  it('does not depend on the order the manifest fields were written in', async () => {
    const signed = await signManifest(manifestOf(key.publicKey), key)
    const reordered = {
      signature: signed.signature,
      manifest: {
        steps: signed.manifest.steps,
        outcome: signed.manifest.outcome,
        decidedAt: signed.manifest.decidedAt,
        root: signed.manifest.root,
        sources: signed.manifest.sources,
        model: signed.manifest.model,
        decisionId: signed.manifest.decisionId,
        agentPubkey: signed.manifest.agentPubkey,
        version: signed.manifest.version,
      },
    }
    expect(await verifySignedManifest(reordered)).toBe(true)
  })

  it('proves only that the manifest matches the key inside it, not whose key that is', async () => {
    const stranger: AgentKeyPair = await generateAgentKey()
    const signed = await signManifest(manifestOf(stranger.publicKey), stranger)
    expect(await verifySignedManifest(signed)).toBe(true)
  })
})

describe('parseSignedManifest', () => {
  it('rejects a signature of the wrong length', async () => {
    const signed = await signManifest(manifestOf(key.publicKey), key)
    expect(() => parseSignedManifest({ ...signed, signature: hex(0x01) })).toThrow()
  })

  it('rejects an unknown field on the envelope', async () => {
    const signed = await signManifest(manifestOf(key.publicKey), key)
    expect(() => parseSignedManifest({ ...signed, anchoredAt: 1 })).toThrow()
  })
})
