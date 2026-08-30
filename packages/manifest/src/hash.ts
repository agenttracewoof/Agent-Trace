export const HASH_BYTES = 32

/**
 * `Uint8Array` без параметра означає `ArrayBufferLike`, а WebCrypto приймає лише
 * `ArrayBuffer`. Псевдонім тримає цю різницю в одному місці замість того, щоб
 * вона спливала на кожній межі, де байти йдуть у `crypto.subtle`.
 */
export type Bytes = Uint8Array<ArrayBuffer>

const encoder = new TextEncoder()

/**
 * Розділювач домену: без нього лист кроку і будь-який інший 32-байтовий хеш
 * у форматі могли б збігтися при вдало підібраному вході.
 */
const STEP_DOMAIN = encoder.encode('agenttrace/step/v1')

export interface StepDigestInput {
  readonly type: string
  readonly inputHash: Uint8Array
  readonly outputHash: Uint8Array
  readonly private: boolean
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Канонічна форма значення: та сама структура завжди дає той самий рядок,
 * незалежно від порядку ключів. Усе, що не має однозначної форми, відхиляється
 * замість тихого припущення — інакше два боки порахували б різні корені й
 * рішення виглядало б підробленим.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalize: number must be finite')
      return JSON.stringify(value)
    case 'string':
      return JSON.stringify(value)
    case 'undefined':
      throw new TypeError('canonicalize: undefined has no canonical form')
    case 'bigint':
      throw new TypeError('canonicalize: bigint has no canonical form')
    case 'function':
      throw new TypeError('canonicalize: function has no canonical form')
    case 'symbol':
      throw new TypeError('canonicalize: symbol has no canonical form')
  }

  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`

  if (!isPlainObject(value)) {
    throw new TypeError('canonicalize: only plain objects are supported')
  }

  const entries = Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)

  return `{${entries.join(',')}}`
}

export async function sha256(bytes: Bytes): Promise<Bytes> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return new Uint8Array(digest)
}

export function hashValue(value: unknown): Promise<Bytes> {
  return sha256(encoder.encode(canonicalize(value)))
}

function assertDigest(bytes: Uint8Array, field: string): void {
  if (bytes.byteLength !== HASH_BYTES) {
    throw new TypeError(`hashStep: ${field} must be ${HASH_BYTES} bytes, got ${bytes.byteLength}`)
  }
}

function concat(parts: readonly Uint8Array[]): Bytes {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

export async function hashStep(step: StepDigestInput): Promise<Bytes> {
  assertDigest(step.inputHash, 'inputHash')
  assertDigest(step.outputHash, 'outputHash')

  const type = encoder.encode(step.type)
  if (type.byteLength > 0xffff) throw new RangeError('hashStep: type is too long')

  // Довжина типу йде перед ним, бо це єдине поле змінного розміру: без префікса
  // ('ab', hash) і ('a', зсунутий hash) дали б однаковий вхід хешу.
  const typeLength = new Uint8Array(2)
  new DataView(typeLength.buffer).setUint16(0, type.byteLength, false)

  return sha256(
    concat([
      STEP_DOMAIN,
      typeLength,
      type,
      step.inputHash,
      step.outputHash,
      Uint8Array.of(step.private ? 1 : 0),
    ]),
  )
}
