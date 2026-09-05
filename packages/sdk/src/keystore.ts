import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  type AgentKeyPair,
  fromHex,
  generateAgentKey,
  hexDigest,
  toHex,
} from '@agenttrace/manifest'
import { z } from 'zod'

export const KEYSTORE_VERSION = 1

const ALGORITHM = 'Ed25519'
const OWNER_ONLY = 0o600
const PROBE = new TextEncoder().encode('agenttrace/keystore/v1')

const keystoreSchema = z.strictObject({
  version: z.literal(KEYSTORE_VERSION),
  publicKey: hexDigest(32),
  privateKey: z.string().regex(/^([0-9a-f]{2})+$/, 'expected lowercase hex byte pairs'),
})

function hasCode(cause: unknown, code: string): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === code
}

/**
 * Помилка розбору несе тільки шлях. І `JSON.parse`, і Zod охоче цитують те, що
 * прочитали, а прочитали вони приватний ключ — тобто звичайне повідомлення про
 * помилку віднесло б його в логи, куди він не має потрапляти ніколи.
 */
function parseKeystore(raw: string, path: string): AgentKeyPair {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error(`keystore: ${path} is not valid JSON`)
  }

  const file = keystoreSchema.safeParse(value)
  if (!file.success) throw new Error(`keystore: ${path} does not hold a key of this format`)

  return { publicKey: file.data.publicKey, privateKey: fromHex(file.data.privateKey) }
}

/**
 * Пара звіряється підписом при кожному завантаженні. Розходження публічної і
 * приватної частин інакше спливло б аж на перевірці вже опублікованого рішення:
 * підписи йшли б ключем, якого немає в ідентичності агента, і жодне з тих
 * рішень не перевірилося б — а помітили б це ззовні, не ми.
 */
async function assertPairMatches(key: AgentKeyPair): Promise<AgentKeyPair> {
  const [privateKey, publicKey] = await Promise.all([
    crypto.subtle.importKey('pkcs8', key.privateKey, { name: ALGORITHM }, false, ['sign']),
    crypto.subtle.importKey('raw', fromHex(key.publicKey), { name: ALGORITHM }, false, ['verify']),
  ])
  const signature = await crypto.subtle.sign(ALGORITHM, privateKey, PROBE)

  if (!(await crypto.subtle.verify(ALGORITHM, publicKey, signature, PROBE))) {
    throw new Error('keystore: the stored public key does not belong to the stored private key')
  }
  return key
}

async function read(path: string): Promise<AgentKeyPair | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (cause) {
    if (hasCode(cause, 'ENOENT')) return undefined
    throw cause
  }
  return assertPairMatches(parseKeystore(raw, path))
}

async function create(path: string): Promise<AgentKeyPair> {
  const key = await generateAgentKey()
  const file = {
    version: KEYSTORE_VERSION,
    publicKey: key.publicKey,
    privateKey: toHex(key.privateKey),
  }

  await mkdir(dirname(path), { recursive: true })
  try {
    // `wx` — і виняткове створення, і єдина операція запису: два процеси, що
    // стартували вперше одночасно, не можуть отримати різні ідентичності, а
    // запис через тимчасовий файл із перейменуванням цю властивість якраз і
    // зламав би, бо перейменування мовчки затирає чуже.
    await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: OWNER_ONLY,
    })
  } catch (cause) {
    if (!hasCode(cause, 'EEXIST')) throw cause
    const existing = await read(path)
    if (existing === undefined) throw cause
    return existing
  }

  return key
}

/**
 * Ідентичність агента (FR-005): пара створюється при першому запуску і далі
 * читається з диска. Приватна частина не покидає файл — назовні вона віддається
 * лише тому, хто підписує манифест у цьому ж процесі, і не логується ніде.
 */
export async function loadOrCreateAgentKey(path: string): Promise<AgentKeyPair> {
  return (await read(path)) ?? create(path)
}
