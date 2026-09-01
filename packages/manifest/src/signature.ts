import { z } from 'zod'
import type { Bytes } from './hash.js'
import { fromHex, manifestDigest, manifestSchema, parseManifest, toHex } from './manifest.js'

const ALGORITHM = 'Ed25519'

export interface AgentKeyPair {
  /** Публічна частина у тому ж hex, що й `agentPubkey` манифесту. */
  readonly publicKey: string
  /** Приватна частина у PKCS#8 — єдина форма, у якій WebCrypto її віддає. */
  readonly privateKey: Bytes
}

export const signedManifestSchema = z.strictObject({
  manifest: manifestSchema,
  signature: z.string().regex(/^[0-9a-f]{128}$/, 'expected 64 bytes as lowercase hex'),
})

export type SignedManifest = z.infer<typeof signedManifestSchema>

export function parseSignedManifest(value: unknown): SignedManifest {
  return signedManifestSchema.parse(value)
}

export async function generateAgentKey(): Promise<AgentKeyPair> {
  const pair = await crypto.subtle.generateKey({ name: ALGORITHM }, true, ['sign', 'verify'])
  const [publicKey, privateKey] = await Promise.all([
    crypto.subtle.exportKey('raw', pair.publicKey),
    crypto.subtle.exportKey('pkcs8', pair.privateKey),
  ])
  return { publicKey: toHex(new Uint8Array(publicKey)), privateKey: new Uint8Array(privateKey) }
}

export async function signManifest(value: unknown, key: AgentKeyPair): Promise<SignedManifest> {
  const manifest = parseManifest(value)
  if (manifest.agentPubkey !== key.publicKey) {
    // Інакше з'явився б конверт, який не перевіряється ніколи й ні в кого, а
    // помітили б це вже після публікації якоря — тобто з незмінного запису.
    throw new TypeError('signManifest: agentPubkey does not belong to the signing key')
  }

  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    key.privateKey,
    { name: ALGORITHM },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(ALGORITHM, privateKey, await manifestDigest(manifest))

  return { manifest, signature: toHex(new Uint8Array(signature)) }
}

/**
 * Доводить рівно одне: манифест не змінювався після підпису **тим ключем, який
 * у ньому вказаний**. Чи належить цей ключ агенту — питання історії ключів
 * з ланцюга (FR-022), і відповідає на нього verifier, не ця функція.
 */
export async function verifySignedManifest(value: unknown): Promise<boolean> {
  const { manifest, signature } = parseSignedManifest(value)
  const publicKey = await crypto.subtle.importKey(
    'raw',
    fromHex(manifest.agentPubkey),
    { name: ALGORITHM },
    false,
    ['verify'],
  )
  return crypto.subtle.verify(
    ALGORITHM,
    publicKey,
    fromHex(signature),
    await manifestDigest(manifest),
  )
}
