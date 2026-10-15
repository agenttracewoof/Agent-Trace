import { z } from 'zod'
import { KEY_ROTATION_ANCHOR_LAYOUT } from './anchor.js'
import { type Bytes, sha256 } from './hash.js'
import { fromHex, hexDigest, toHex } from './manifest.js'
import type { AgentKeyPair } from './signature.js'

const ALGORITHM = 'Ed25519'

/**
 * Without a domain of its own, a rotation proof and a manifest signature would
 * be signatures by the same key over 32-byte digests, told apart only by luck.
 */
const ROTATION_DOMAIN = new TextEncoder().encode('agenttrace/key-rotation/v1')

/**
 * What the previous key signs for a chained rotation. `effectiveAt` is inside
 * the signature, so the line between the two keys' decisions is drawn by the
 * key holder and cannot be moved by AgentTrace afterwards.
 */
export const keyRotationStatementSchema = z
  .strictObject({
    newPubkey: hexDigest(KEY_ROTATION_ANCHOR_LAYOUT.newPubkey),
    prevPubkey: hexDigest(KEY_ROTATION_ANCHOR_LAYOUT.prevPubkey),
    effectiveAt: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .refine((value) => value.newPubkey !== value.prevPubkey, {
    error: 'prevPubkey must differ from newPubkey',
  })

export type KeyRotationStatement = z.infer<typeof keyRotationStatementSchema>

export function parseKeyRotationStatement(value: unknown): KeyRotationStatement {
  return keyRotationStatementSchema.parse(value)
}

export async function keyRotationDigest(value: unknown): Promise<Bytes> {
  const statement = parseKeyRotationStatement(value)
  const input = new Uint8Array(
    ROTATION_DOMAIN.byteLength +
      KEY_ROTATION_ANCHOR_LAYOUT.newPubkey +
      KEY_ROTATION_ANCHOR_LAYOUT.prevPubkey +
      KEY_ROTATION_ANCHOR_LAYOUT.effectiveAt,
  )
  let at = 0
  input.set(ROTATION_DOMAIN, at)
  at += ROTATION_DOMAIN.byteLength
  input.set(fromHex(statement.newPubkey), at)
  at += KEY_ROTATION_ANCHOR_LAYOUT.newPubkey
  input.set(fromHex(statement.prevPubkey), at)
  at += KEY_ROTATION_ANCHOR_LAYOUT.prevPubkey
  new DataView(input.buffer).setBigUint64(at, BigInt(statement.effectiveAt), false)

  return sha256(input)
}

export async function signKeyRotation(value: unknown, key: AgentKeyPair): Promise<string> {
  const statement = parseKeyRotationStatement(value)
  if (statement.prevPubkey !== key.publicKey) {
    throw new TypeError('signKeyRotation: prevPubkey does not belong to the signing key')
  }

  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    key.privateKey,
    { name: ALGORITHM },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    ALGORITHM,
    privateKey,
    await keyRotationDigest(statement),
  )
  return toHex(new Uint8Array(signature))
}

export async function verifyKeyRotation(value: unknown, proof: string): Promise<boolean> {
  const statement = parseKeyRotationStatement(value)
  const digest = await keyRotationDigest(statement)
  try {
    const publicKey = await crypto.subtle.importKey(
      'raw',
      fromHex(statement.prevPubkey),
      { name: ALGORITHM },
      false,
      ['verify'],
    )
    return await crypto.subtle.verify(ALGORITHM, publicKey, fromHex(proof), digest)
  } catch {
    // A key that is not a curve point fails the same way a wrong signature does
    // (format §12.2, step 4): neither proves the rotation.
    return false
  }
}
