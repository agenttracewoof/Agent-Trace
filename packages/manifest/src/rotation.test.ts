import { describe, expect, it } from 'vitest'
import { sha256 } from './hash.js'
import { fromHex, toHex } from './manifest.js'
import {
  keyRotationDigest,
  parseKeyRotationStatement,
  signKeyRotation,
  verifyKeyRotation,
} from './rotation.js'
import { generateAgentKey, signManifest } from './signature.js'

const previous = await generateAgentKey()
const next = await generateAgentKey()

const statement = (overrides: Record<string, unknown> = {}) => ({
  newPubkey: next.publicKey,
  prevPubkey: previous.publicKey,
  effectiveAt: 1_760_000_000_000,
  ...overrides,
})

describe('keyRotationDigest', () => {
  it('hashes the domain, both keys and effectiveAt as u64be, in that order', async () => {
    // Written out by hand rather than through the implementation: this is the
    // byte layout a verifier in another language has to reproduce.
    const expected = await sha256(
      new Uint8Array([
        ...new TextEncoder().encode('agenttrace/key-rotation/v1'),
        ...fromHex(next.publicKey),
        ...fromHex(previous.publicKey),
        0x00,
        0x00,
        0x01,
        0x99,
        0xc8,
        0x2c,
        0xc0,
        0x00,
      ]),
    )

    expect(toHex(await keyRotationDigest(statement()))).toBe(toHex(expected))
  })

  it('refuses a statement that rotates a key into itself', () => {
    expect(() => parseKeyRotationStatement(statement({ newPubkey: previous.publicKey }))).toThrow()
  })

  it('refuses an effectiveAt that does not fit the anchor', () => {
    expect(() => parseKeyRotationStatement(statement({ effectiveAt: -1 }))).toThrow()
    expect(() => parseKeyRotationStatement(statement({ effectiveAt: 1.5 }))).toThrow()
  })
})

describe('signKeyRotation and verifyKeyRotation', () => {
  it('accepts a rotation signed by the previous key', async () => {
    const proof = await signKeyRotation(statement(), previous)

    expect(proof).toMatch(/^[0-9a-f]{128}$/)
    expect(await verifyKeyRotation(statement(), proof)).toBe(true)
  })

  it.each([
    ['newPubkey', { newPubkey: 'aa'.repeat(32) }],
    ['effectiveAt', { effectiveAt: 1_760_000_000_001 }],
  ])('rejects the proof once %s is changed', async (_field, change) => {
    const proof = await signKeyRotation(statement(), previous)

    expect(await verifyKeyRotation(statement(change), proof)).toBe(false)
  })

  it('rejects a rotation the new key signed for itself', async () => {
    const forged = await signKeyRotation(
      statement({ newPubkey: previous.publicKey, prevPubkey: next.publicKey }),
      next,
    )

    expect(await verifyKeyRotation(statement(), forged)).toBe(false)
  })

  it('rejects a bare signature over the new key, which is what the domain is for', async () => {
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      previous.privateKey,
      { name: 'Ed25519' },
      false,
      ['sign'],
    )
    const bare = await crypto.subtle.sign('Ed25519', privateKey, fromHex(next.publicKey))

    expect(await verifyKeyRotation(statement(), toHex(new Uint8Array(bare)))).toBe(false)
  })

  it('refuses to sign with a key that is not the previous one', async () => {
    await expect(signKeyRotation(statement(), next)).rejects.toThrow(TypeError)
  })

  it('answers false rather than throwing when prevPubkey is not a curve point', async () => {
    const proof = await signKeyRotation(statement(), previous)

    expect(await verifyKeyRotation(statement({ prevPubkey: 'dd'.repeat(32) }), proof)).toBe(false)
  })

  it('does not take a manifest signature as a rotation proof', async () => {
    const envelope = await signManifest(
      {
        version: 1,
        agentPubkey: previous.publicKey,
        decisionId: '0c'.repeat(16),
        model: 'claude-opus-5',
        sources: [],
        root: '11'.repeat(32),
        decidedAt: 1_760_000_000_000,
        outcome: null,
        steps: [
          {
            type: 'model.call',
            private: true,
            inputHash: '01'.repeat(32),
            outputHash: '02'.repeat(32),
          },
        ],
      },
      previous,
    )

    expect(await verifyKeyRotation(statement(), envelope.signature)).toBe(false)
  })
})
