import { z } from 'zod'
import type { Bytes } from './hash.js'
import { fromHex, hexDigest, MANIFEST_VERSION, toHex } from './manifest.js'

export const ANCHOR_KIND = {
  decision: 0,
  keyRotation: 1,
} as const

/**
 * Планова ротація підписана попереднім ключем, аварійна — лише підтвердженням
 * власника у дашборді. Різниця живе в самому якорі, а не в нашій БД: інакше
 * розрив тяглості ідентичності був би видимий тільки нам, а FR-027 обіцяє
 * протилежне — що приховати його неможливо.
 */
export const ROTATION_KIND = {
  chained: 0,
  administrative: 1,
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
const ROTATION_AT = offsetsOf(KEY_ROTATION_ANCHOR_LAYOUT)

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

function readTime(bytes: Uint8Array, at: number, name: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const value = view.getBigUint64(at, false)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    // Мовчазне округлення тут зсунуло б час, а він входить у підпис.
    throw new RangeError(`${name} ${value} exceeds a safe integer`)
  }
  return Number(value)
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

  return decisionAnchorSchema.parse({
    version: MANIFEST_VERSION,
    kind: ANCHOR_KIND.decision,
    agentPubkey: field(bytes, AT.agentPubkey, DECISION_ANCHOR_LAYOUT.agentPubkey),
    root: field(bytes, AT.root, DECISION_ANCHOR_LAYOUT.root),
    decisionId: field(bytes, AT.decisionId, DECISION_ANCHOR_LAYOUT.decisionId),
    decidedAt: readTime(bytes, AT.decidedAt, 'decodeDecisionAnchor: decidedAt'),
    signature: field(bytes, AT.signature, DECISION_ANCHOR_LAYOUT.signature),
  })
}

export const keyRotationAnchorSchema = z
  .strictObject({
    version: z.literal(MANIFEST_VERSION),
    kind: z.literal(ANCHOR_KIND.keyRotation),
    newPubkey: hexDigest(KEY_ROTATION_ANCHOR_LAYOUT.newPubkey),
    prevPubkey: hexDigest(KEY_ROTATION_ANCHOR_LAYOUT.prevPubkey),
    rotationKind: z.literal([ROTATION_KIND.chained, ROTATION_KIND.administrative]),
    effectiveAt: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
    signature: hexDigest(KEY_ROTATION_ANCHOR_LAYOUT.signature),
  })
  .refine((value) => value.newPubkey !== value.prevPubkey, {
    error: 'prevPubkey must differ from newPubkey',
  })

export type KeyRotationAnchor = z.infer<typeof keyRotationAnchorSchema>

export function encodeKeyRotationAnchor(value: unknown): Bytes {
  const rotation = keyRotationAnchorSchema.parse(value)
  const bytes = new Uint8Array(KEY_ROTATION_ANCHOR_BYTES)
  const view = new DataView(bytes.buffer)

  bytes[ROTATION_AT.version] = rotation.version
  bytes[ROTATION_AT.kind] = rotation.kind
  bytes.set(fromHex(rotation.newPubkey), ROTATION_AT.newPubkey)
  bytes.set(fromHex(rotation.prevPubkey), ROTATION_AT.prevPubkey)
  bytes[ROTATION_AT.rotationKind] = rotation.rotationKind
  view.setBigUint64(ROTATION_AT.effectiveAt, BigInt(rotation.effectiveAt), false)
  bytes.set(fromHex(rotation.signature), ROTATION_AT.signature)

  return bytes
}

export function decodeKeyRotationAnchor(bytes: Uint8Array): KeyRotationAnchor {
  if (bytes.byteLength !== KEY_ROTATION_ANCHOR_BYTES) {
    throw new RangeError(
      `decodeKeyRotationAnchor: expected ${KEY_ROTATION_ANCHOR_BYTES} bytes, got ${bytes.byteLength}`,
    )
  }
  if (bytes[ROTATION_AT.version] !== MANIFEST_VERSION) {
    throw new RangeError(
      `decodeKeyRotationAnchor: unknown format version ${bytes[ROTATION_AT.version]}`,
    )
  }
  if (bytes[ROTATION_AT.kind] !== ANCHOR_KIND.keyRotation) {
    throw new RangeError(
      `decodeKeyRotationAnchor: anchor kind ${bytes[ROTATION_AT.kind]} is not a key rotation`,
    )
  }

  return keyRotationAnchorSchema.parse({
    version: MANIFEST_VERSION,
    kind: ANCHOR_KIND.keyRotation,
    newPubkey: field(bytes, ROTATION_AT.newPubkey, KEY_ROTATION_ANCHOR_LAYOUT.newPubkey),
    prevPubkey: field(bytes, ROTATION_AT.prevPubkey, KEY_ROTATION_ANCHOR_LAYOUT.prevPubkey),
    rotationKind: bytes[ROTATION_AT.rotationKind],
    effectiveAt: readTime(bytes, ROTATION_AT.effectiveAt, 'decodeKeyRotationAnchor: effectiveAt'),
    signature: field(bytes, ROTATION_AT.signature, KEY_ROTATION_ANCHOR_LAYOUT.signature),
  })
}

/**
 * Обидва якорі читаються з одного потоку memo за адресою агента, тож першим
 * питанням завжди є «що це». Тримати відповідь тут, а не в кожного споживача,
 * — єдиний спосіб не розмножити знання про перші два байти формату.
 */
export function anchorKindOf(bytes: Uint8Array): number {
  const version = bytes[0]
  const kind = bytes[1]
  if (version === undefined || kind === undefined) {
    throw new RangeError('anchorKindOf: payload is too short to be an anchor')
  }
  if (version !== MANIFEST_VERSION) {
    throw new RangeError(`anchorKindOf: unknown format version ${version}`)
  }
  if (kind !== ANCHOR_KIND.decision && kind !== ANCHOR_KIND.keyRotation) {
    throw new RangeError(`anchorKindOf: unknown anchor kind ${kind}`)
  }
  return kind
}
