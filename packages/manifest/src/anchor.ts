import { z } from 'zod'
import type { Bytes } from './hash.js'
import { fromHex, hexDigest, MANIFEST_VERSION, toHex } from './manifest.js'

export const ANCHOR_KIND = {
  decision: 0,
  keyRotation: 1,
} as const

/**
 * Байтові бюджети якорів. Усі поля фіксованої довжини — саме тому memo не може
 * перерости ліміт транзакції на довгому рішенні: розмір не залежить від кроків.
 */
export const DECISION_ANCHOR_LAYOUT = {
  version: 1,
  kind: 1,
  agentPubkey: 32,
  root: 32,
  decisionId: 16,
  decidedAt: 8,
  signature: 64,
} as const

/**
 * Ротація йде в ланцюг окремим якорем, а не лишається у нашій БД: інакше окреме
 * рішення перевірялося б самодостатньо, а тяглість ключів — ні, і FR-014
 * («достатньо публічних даних») суперечив би FR-022.
 */
export const KEY_ROTATION_ANCHOR_LAYOUT = {
  version: 1,
  kind: 1,
  newPubkey: 32,
  prevPubkey: 32,
  rotationKind: 1,
  effectiveAt: 8,
  signature: 64,
} as const

const sum = (layout: Record<string, number>) => Object.values(layout).reduce((a, b) => a + b, 0)

export const DECISION_ANCHOR_BYTES = sum(DECISION_ANCHOR_LAYOUT)
export const KEY_ROTATION_ANCHOR_BYTES = sum(KEY_ROTATION_ANCHOR_LAYOUT)

/** Ліміт розміру Solana-транзакції. Запас перевіряється тестом, не на око. */
export const SOLANA_TX_LIMIT_BYTES = 1232

/** Зсуви рахуються з layout, щоб він лишався єдиним джерелом істини про формат. */
function offsetsOf<T extends Record<string, number>>(
  layout: T,
): { readonly [K in keyof T]: number } {
  let offset = 0
  const entries = Object.entries(layout).map(([field, size]) => {
    const at = offset
    offset += size
    return [field, at]
  })
  return Object.fromEntries(entries) as { readonly [K in keyof T]: number }
}

const AT = offsetsOf(DECISION_ANCHOR_LAYOUT)

export const decisionAnchorSchema = z.strictObject({
  version: z.literal(MANIFEST_VERSION),
  kind: z.literal(ANCHOR_KIND.decision),
  agentPubkey: hexDigest(DECISION_ANCHOR_LAYOUT.agentPubkey),
  root: hexDigest(DECISION_ANCHOR_LAYOUT.root),
  decisionId: hexDigest(DECISION_ANCHOR_LAYOUT.decisionId),
  decidedAt: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  signature: hexDigest(DECISION_ANCHOR_LAYOUT.signature),
})

export type DecisionAnchor = z.infer<typeof decisionAnchorSchema>

export function encodeDecisionAnchor(value: unknown): Bytes {
  const anchor = decisionAnchorSchema.parse(value)
  const bytes = new Uint8Array(DECISION_ANCHOR_BYTES)
  const view = new DataView(bytes.buffer)

  bytes[AT.version] = anchor.version
  bytes[AT.kind] = anchor.kind
  bytes.set(fromHex(anchor.agentPubkey), AT.agentPubkey)
  bytes.set(fromHex(anchor.root), AT.root)
  bytes.set(fromHex(anchor.decisionId), AT.decisionId)
  view.setBigUint64(AT.decidedAt, BigInt(anchor.decidedAt), false)
  bytes.set(fromHex(anchor.signature), AT.signature)

  return bytes
}

function field(bytes: Uint8Array, at: number, size: number): string {
  return toHex(bytes.subarray(at, at + size))
}

export function decodeDecisionAnchor(bytes: Uint8Array): DecisionAnchor {
  if (bytes.byteLength !== DECISION_ANCHOR_BYTES) {
    throw new RangeError(
      `decodeDecisionAnchor: expected ${DECISION_ANCHOR_BYTES} bytes, got ${bytes.byteLength}`,
    )
  }
  if (bytes[AT.version] !== MANIFEST_VERSION) {
    throw new RangeError(`decodeDecisionAnchor: unknown format version ${bytes[AT.version]}`)
  }
  if (bytes[AT.kind] !== ANCHOR_KIND.decision) {
    throw new RangeError(`decodeDecisionAnchor: anchor kind ${bytes[AT.kind]} is not a decision`)
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decidedAt = view.getBigUint64(AT.decidedAt, false)
  if (decidedAt > BigInt(Number.MAX_SAFE_INTEGER)) {
    // Мовчазне округлення тут зсунуло б час рішення, а він входить у підпис.
    throw new RangeError(`decodeDecisionAnchor: decidedAt ${decidedAt} exceeds a safe integer`)
  }

  return decisionAnchorSchema.parse({
    version: MANIFEST_VERSION,
    kind: ANCHOR_KIND.decision,
    agentPubkey: field(bytes, AT.agentPubkey, DECISION_ANCHOR_LAYOUT.agentPubkey),
    root: field(bytes, AT.root, DECISION_ANCHOR_LAYOUT.root),
    decisionId: field(bytes, AT.decisionId, DECISION_ANCHOR_LAYOUT.decisionId),
    decidedAt: Number(decidedAt),
    signature: field(bytes, AT.signature, DECISION_ANCHOR_LAYOUT.signature),
  })
}
