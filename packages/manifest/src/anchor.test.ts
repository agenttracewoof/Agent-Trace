import { describe, expect, it } from 'vitest'
import {
  ANCHOR_KIND,
  DECISION_ANCHOR_BYTES,
  type DecisionAnchor,
  decodeDecisionAnchor,
  encodeDecisionAnchor,
  KEY_ROTATION_ANCHOR_BYTES,
  SOLANA_TX_LIMIT_BYTES,
} from './anchor.js'
import { fromHex, MANIFEST_VERSION, toHex } from './manifest.js'

const hex = (fill: number, bytes: number) => fill.toString(16).padStart(2, '0').repeat(bytes)

const anchor: DecisionAnchor = {
  version: MANIFEST_VERSION,
  kind: ANCHOR_KIND.decision,
  agentPubkey: hex(0xab, 32),
  root: hex(0xcd, 32),
  decisionId: hex(0x0c, 16),
  decidedAt: 1_760_000_000_000,
  signature: hex(0xef, 64),
}

describe('encodeDecisionAnchor', () => {
  it('is exactly the size the transaction budget was planned around', () => {
    expect(encodeDecisionAnchor(anchor).byteLength).toBe(DECISION_ANCHOR_BYTES)
  })

  it('puts every field where the layout says', () => {
    const bytes = encodeDecisionAnchor(anchor)
    expect(bytes[0]).toBe(MANIFEST_VERSION)
    expect(bytes[1]).toBe(ANCHOR_KIND.decision)
    expect(toHex(bytes.subarray(2, 34))).toBe(anchor.agentPubkey)
    expect(toHex(bytes.subarray(34, 66))).toBe(anchor.root)
    expect(toHex(bytes.subarray(66, 82))).toBe(anchor.decisionId)
    expect(toHex(bytes.subarray(90, 154))).toBe(anchor.signature)
  })

  it('writes the decision time big-endian, so byte order never depends on the host', () => {
    const bytes = encodeDecisionAnchor({ ...anchor, decidedAt: 0x0102030405 })
    expect(toHex(bytes.subarray(82, 90))).toBe('0000000102030405')
  })

  it('refuses a field that is not what the format says it is', () => {
    expect(() => encodeDecisionAnchor({ ...anchor, root: hex(0xcd, 31) })).toThrow()
    expect(() => encodeDecisionAnchor({ ...anchor, decidedAt: -1 })).toThrow()
    expect(() => encodeDecisionAnchor({ ...anchor, kind: ANCHOR_KIND.keyRotation })).toThrow()
  })
})

describe('decodeDecisionAnchor', () => {
  it('round-trips byte for byte', () => {
    const bytes = encodeDecisionAnchor(anchor)
    expect(decodeDecisionAnchor(bytes)).toEqual(anchor)
    expect(encodeDecisionAnchor(decodeDecisionAnchor(bytes))).toEqual(bytes)
  })

  it('round-trips the extremes of the fields', () => {
    const edge: DecisionAnchor = {
      ...anchor,
      agentPubkey: hex(0x00, 32),
      root: hex(0xff, 32),
      decisionId: hex(0x00, 16),
      decidedAt: 0,
    }
    expect(decodeDecisionAnchor(encodeDecisionAnchor(edge))).toEqual(edge)
  })

  it('rejects a payload of the wrong length instead of reading past it', () => {
    expect(() => decodeDecisionAnchor(new Uint8Array(DECISION_ANCHOR_BYTES - 1))).toThrow(/154/)
    expect(() => decodeDecisionAnchor(new Uint8Array(DECISION_ANCHOR_BYTES + 1))).toThrow(/154/)
  })

  it('refuses to read a rotation anchor as a decision', () => {
    const bytes = encodeDecisionAnchor(anchor)
    bytes[1] = ANCHOR_KIND.keyRotation
    expect(() => decodeDecisionAnchor(bytes)).toThrow(/kind/)
  })

  it('refuses a payload of an unknown format version', () => {
    const bytes = encodeDecisionAnchor(anchor)
    bytes[0] = MANIFEST_VERSION + 1
    expect(() => decodeDecisionAnchor(bytes)).toThrow(/version/)
  })

  it('refuses a decision time it cannot represent honestly', () => {
    const bytes = encodeDecisionAnchor(anchor)
    bytes.set(fromHex('ffffffffffffffff'), 82)
    expect(() => decodeDecisionAnchor(bytes)).toThrow(/decidedAt/)
  })
})

const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4

describe('anchor payload budget', () => {
  it('matches the layouts documented in PLAN.md', () => {
    expect(DECISION_ANCHOR_BYTES).toBe(154)
    expect(KEY_ROTATION_ANCHOR_BYTES).toBe(139)
  })

  it('leaves room inside a Solana transaction once base64-encoded', () => {
    for (const bytes of [DECISION_ANCHOR_BYTES, KEY_ROTATION_ANCHOR_BYTES]) {
      expect(base64Length(bytes)).toBeLessThan(SOLANA_TX_LIMIT_BYTES / 2)
    }
  })
})
