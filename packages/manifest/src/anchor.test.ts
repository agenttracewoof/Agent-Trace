import { describe, expect, it } from 'vitest'
import {
  ANCHOR_KIND,
  anchorKindOf,
  DECISION_ANCHOR_BYTES,
  DECISION_ANCHOR_LAYOUT,
  type DecisionAnchor,
  decodeDecisionAnchor,
  decodeKeyRotationAnchor,
  encodeDecisionAnchor,
  encodeKeyRotationAnchor,
  KEY_ROTATION_ANCHOR_BYTES,
  KEY_ROTATION_ANCHOR_LAYOUT,
  type KeyRotationAnchor,
  ROTATION_KIND,
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

const rotation: KeyRotationAnchor = {
  version: MANIFEST_VERSION,
  kind: ANCHOR_KIND.keyRotation,
  newPubkey: hex(0x11, 32),
  prevPubkey: hex(0x22, 32),
  rotationKind: ROTATION_KIND.chained,
  effectiveAt: 1_760_000_000_000,
  signature: hex(0xef, 64),
}

describe('encodeKeyRotationAnchor', () => {
  it('is exactly the size the transaction budget was planned around', () => {
    expect(encodeKeyRotationAnchor(rotation).byteLength).toBe(KEY_ROTATION_ANCHOR_BYTES)
  })

  it('puts every field where the layout says', () => {
    const bytes = encodeKeyRotationAnchor(rotation)
    expect(bytes[0]).toBe(MANIFEST_VERSION)
    expect(bytes[1]).toBe(ANCHOR_KIND.keyRotation)
    expect(toHex(bytes.subarray(2, 34))).toBe(rotation.newPubkey)
    expect(toHex(bytes.subarray(34, 66))).toBe(rotation.prevPubkey)
    expect(bytes[66]).toBe(ROTATION_KIND.chained)
    expect(toHex(bytes.subarray(75, 139))).toBe(rotation.signature)
  })

  it('writes the effective time big-endian', () => {
    const bytes = encodeKeyRotationAnchor({ ...rotation, effectiveAt: 0x0102030405 })
    expect(toHex(bytes.subarray(67, 75))).toBe('0000000102030405')
  })

  it('refuses a rotation that replaces a key with itself', () => {
    const same = { ...rotation, prevPubkey: rotation.newPubkey }
    expect(() => encodeKeyRotationAnchor(same)).toThrow(/prevPubkey/)
  })

  it('refuses a decision anchor passed in by mistake', () => {
    expect(() => encodeKeyRotationAnchor(anchor)).toThrow()
  })
})

describe('decodeKeyRotationAnchor', () => {
  it('round-trips both ways a key can be replaced', () => {
    for (const rotationKind of [ROTATION_KIND.chained, ROTATION_KIND.administrative]) {
      const value: KeyRotationAnchor = { ...rotation, rotationKind }
      const bytes = encodeKeyRotationAnchor(value)
      expect(decodeKeyRotationAnchor(bytes)).toEqual(value)
      expect(encodeKeyRotationAnchor(decodeKeyRotationAnchor(bytes))).toEqual(bytes)
    }
  })

  it('rejects a payload of the wrong length', () => {
    expect(() => decodeKeyRotationAnchor(new Uint8Array(KEY_ROTATION_ANCHOR_BYTES - 1))).toThrow(
      /139/,
    )
  })

  it('refuses to read a decision as a rotation', () => {
    const bytes = encodeKeyRotationAnchor(rotation)
    bytes[1] = ANCHOR_KIND.decision
    expect(() => decodeKeyRotationAnchor(bytes)).toThrow(/kind/)
  })

  it('refuses an unknown way of replacing the key, rather than reading it as chained', () => {
    const bytes = encodeKeyRotationAnchor(rotation)
    bytes[66] = 2
    expect(() => decodeKeyRotationAnchor(bytes)).toThrow(/rotationKind/)
  })

  it('refuses an effective time it cannot represent honestly', () => {
    const bytes = encodeKeyRotationAnchor(rotation)
    bytes.set(fromHex('ffffffffffffffff'), 67)
    expect(() => decodeKeyRotationAnchor(bytes)).toThrow(/effectiveAt/)
  })
})

describe('anchorKindOf', () => {
  it('tells the two payloads apart without decoding either', () => {
    expect(anchorKindOf(encodeDecisionAnchor(anchor))).toBe(ANCHOR_KIND.decision)
    expect(anchorKindOf(encodeKeyRotationAnchor(rotation))).toBe(ANCHOR_KIND.keyRotation)
  })

  it('refuses a payload that is not ours', () => {
    expect(() => anchorKindOf(new Uint8Array(1))).toThrow()
    expect(() => anchorKindOf(Uint8Array.of(MANIFEST_VERSION + 1, 0))).toThrow(/version/)
    expect(() => anchorKindOf(Uint8Array.of(MANIFEST_VERSION, 9))).toThrow(/kind/)
  })

  it('reads the kind from the same two bytes in both layouts', () => {
    expect(Object.keys(DECISION_ANCHOR_LAYOUT).slice(0, 2)).toEqual(['version', 'kind'])
    expect(Object.keys(KEY_ROTATION_ANCHOR_LAYOUT).slice(0, 2)).toEqual(['version', 'kind'])
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
