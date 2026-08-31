import { z } from 'zod'
import { type Bytes, canonicalize, hashStep, sha256 } from './hash.js'
import { merkleRoot } from './tree.js'

export const MANIFEST_VERSION = 1

const encoder = new TextEncoder()

/** Домен манифесту, щоб його дайджест не збігся з хешем кроку чи вузла дерева. */
const MANIFEST_DOMAIN = encoder.encode('agenttrace/manifest/v1')

/**
 * Усі двійкові поля — рядок нижнього регістру в hex. Base58 читабельніший у
 * Solana-контексті, але тягне залежність у пакет, який мусить лишатися чистим,
 * а рішення «одне кодування на весь формат» коштує дешевше, ніж два.
 * `decisionId` — це UUID без дефісів, тобто ті самі 16 байтів, що йдуть у якір.
 */
const hexDigest = (bytes: number) =>
  z
    .string()
    .regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`), `expected ${bytes} bytes as lowercase hex`)

const publicStepSchema = z.strictObject({
  type: z.string().min(1).max(64),
  private: z.literal(false),
  input: z.json(),
  output: z.json(),
  inputHash: hexDigest(32),
  outputHash: hexDigest(32),
})

/**
 * Приватний крок не має полів вмісту взагалі — не порожні, а відсутні. Крок,
 * позначений приватним, але з вмістом, відхиляється замість тихого вирізання:
 * FR-020 обіцяє, що публічно лишається тільки хеш і тип.
 */
const privateStepSchema = z.strictObject({
  type: z.string().min(1).max(64),
  private: z.literal(true),
  inputHash: hexDigest(32),
  outputHash: hexDigest(32),
})

export const manifestStepSchema = z.discriminatedUnion('private', [
  publicStepSchema,
  privateStepSchema,
])

export const manifestSchema = z.strictObject({
  version: z.literal(MANIFEST_VERSION),
  agentPubkey: hexDigest(32),
  decisionId: hexDigest(16),
  model: z.string().min(1).max(128),
  sources: z.array(z.string().min(1).max(512)),
  root: hexDigest(32),
  decidedAt: z.int().min(0),
  outcome: z.json(),
  steps: z.array(manifestStepSchema).min(1),
})

export type ManifestStep = z.infer<typeof manifestStepSchema>
export type Manifest = z.infer<typeof manifestSchema>

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function fromHex(hex: string): Bytes {
  if (!/^([0-9a-f]{2})*$/.test(hex)) {
    throw new TypeError(`fromHex: expected lowercase hex byte pairs, got ${JSON.stringify(hex)}`)
  }
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

export function parseManifest(value: unknown): Manifest {
  return manifestSchema.parse(value)
}

/**
 * Канонічна форма будується тільки з розібраного манифесту: підпис має покривати
 * рівно те, що формат визнає манифестом, інакше підписане й перевірене — різні
 * документи. Порядок ключів задає `canonicalize`, тож JSON з іншим порядком полів
 * дає той самий рядок.
 */
export function canonicalManifest(value: unknown): string {
  return canonicalize(parseManifest(value))
}

export async function manifestDigest(value: unknown): Promise<Bytes> {
  const canonical = encoder.encode(canonicalManifest(value))
  const input = new Uint8Array(MANIFEST_DOMAIN.byteLength + canonical.byteLength)
  input.set(MANIFEST_DOMAIN, 0)
  input.set(canonical, MANIFEST_DOMAIN.byteLength)
  return sha256(input)
}

export async function stepsRoot(steps: readonly ManifestStep[]): Promise<Bytes> {
  const leaves = await Promise.all(
    steps.map((step) =>
      hashStep({
        type: step.type,
        inputHash: fromHex(step.inputHash),
        outputHash: fromHex(step.outputHash),
        private: step.private,
      }),
    ),
  )
  return merkleRoot(leaves)
}
