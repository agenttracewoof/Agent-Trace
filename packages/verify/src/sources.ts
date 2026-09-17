import {
  ANCHOR_KIND,
  anchorKindOf,
  decodeAnchorMemo,
  decodeDecisionAnchor,
  fromHex,
} from '@agenttrace/manifest'
import { PublicKey } from '@solana/web3.js'
import type { DecisionEvidence } from './verify.js'

/**
 * Звідки verifier бере докази (FR-014): **ланцюг і сховище власника**, і більше
 * нізвідки. Адреси AgentTrace в цьому файлі немає жодної, і це не охайність —
 * це і є вимога: перевірка, яка ходить у наш сервіс по докази, доводить рівно
 * стільки, скільки коштує наше слово.
 *
 * Посилання на манифест приходить **аргументом**. Дефолту тут не буде ніколи:
 * дефолт зробив би AgentTrace джерелом істини за замовчуванням, а вимикати це
 * мусив би той, хто здогадався.
 */

/** SPL Memo. Той самий ідентифікатор у devnet і mainnet. */
export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

interface CompiledInstructionLike {
  readonly programIdIndex: number
  readonly data: Uint8Array
}

/** Транзакція у тій формі, у якій її віддає `getTransaction`. */
export interface TransactionLike {
  readonly slot: number
  readonly meta: { readonly err: unknown } | null
  readonly transaction: {
    readonly message: {
      readonly staticAccountKeys: readonly PublicKey[]
      readonly compiledInstructions: readonly CompiledInstructionLike[]
    }
  }
}

/** Рівно те, що шар джерел питає в ланцюга. `Connection` задовольняє це структурно. */
export interface ChainSource {
  getSignaturesForAddress(
    address: PublicKey,
    options?: { readonly limit?: number },
  ): Promise<readonly { readonly signature: string; readonly err: unknown }[]>
  getTransaction(
    signature: string,
    config: { readonly maxSupportedTransactionVersion: 0 },
  ): Promise<TransactionLike | null>
}

export type FetchLike = (url: string) => Promise<Response>

/**
 * Payload читається з **даних інструкції**, а не з логів виконання. Рядок
 * `Program log: Memo (len …)` — це вивід програми для людини, формат якого
 * ніхто не обіцяв тримати незмінним; до того ж перший рядок логів memo взагалі
 * не містить payload'а, тож пошук за підрядком дає не те.
 */
export function anchorPayloadsOf(transaction: TransactionLike): readonly Uint8Array[] {
  const { staticAccountKeys, compiledInstructions } = transaction.transaction.message
  const payloads: Uint8Array[] = []

  for (const instruction of compiledInstructions) {
    if (!staticAccountKeys[instruction.programIdIndex]?.equals(MEMO_PROGRAM_ID)) continue
    // Чуже memo за цією адресою — звичайна річ: тегувати транзакцію будь-якою
    // адресою може будь-хто. Тому «не наш формат» тут не помилка, а пропуск.
    const payload = decodeAnchorMemo(new TextDecoder().decode(instruction.data))
    if (payload !== undefined) payloads.push(payload)
  }

  return payloads
}

export function decisionAnchorIn(
  payloads: readonly Uint8Array[],
  decisionId: string,
): Uint8Array | undefined {
  for (const payload of payloads) {
    if (anchorKindOf(payload) !== ANCHOR_KIND.decision) continue
    try {
      if (decodeDecisionAnchor(payload).decisionId === decisionId) return payload
    } catch {
      // Зіпсований запис за цією адресою не має ховати справний якір, який
      // лежить у наступній транзакції.
    }
  }
  return undefined
}

export async function manifestFromUrl(fetchImpl: FetchLike, url: string): Promise<unknown> {
  try {
    const response = await fetchImpl(url)
    if (!response.ok) return undefined
    return await response.json()
  } catch {
    // Недоступність сховища — це «немає доказу», а не «доказ проти». Виняток
    // тут перетворив би обрив мережі на обвинувачення.
    return undefined
  }
}

export interface EvidenceRequest {
  /** Публічний ключ агента у hex — адреса, за якою читається його історія. */
  readonly agentPubkey: string
  readonly decisionId: string
  /** Посилання на конверт у сховищі власника. Нашого API серед варіантів немає. */
  readonly manifestUrl: string
  readonly limit?: number
  /**
   * Підпис транзакції якоря — **підказка, а не довіра**. Вона економить обхід
   * історії (одна круговерть замість однієї на кожну транзакцію агента), але не
   * розширює того, що вважається якорем: транзакція за підказкою мусить пройти
   * ті самі перевірки, що й знайдена обходом, включно з тим, що вона **називає
   * адресу агента**. Тому підказка, яку підсунули або притримали, може зробити
   * вердикт лише слабшим (`pending`), ніколи сильнішим — а звідки її взяли,
   * значення не має.
   */
  readonly anchorTransaction?: string
}

const HISTORY_LIMIT = 100

/**
 * Якір усередині **однієї названої** транзакції. Перевірка адреси тут не зайва:
 * memo з чужим вмістом може написати будь-хто, і без неї підказка приймала б
 * запис, якого обхід історії агента ніколи не побачив би. Тобто два шляхи мають
 * давати той самий результат, а не «швидкий» і «поблажливий».
 */
async function anchorInTransaction(
  chain: ChainSource,
  signature: string,
  request: { readonly agentPubkey: string; readonly decisionId: string },
): Promise<Uint8Array | undefined> {
  let transaction: TransactionLike | null
  try {
    transaction = await chain.getTransaction(signature, { maxSupportedTransactionVersion: 0 })
  } catch {
    // Підказка, яка не читається, — не привід зупиняти перевірку: далі є обхід.
    return undefined
  }
  if (transaction === null) return undefined
  // Невдала транзакція нічого в ланцюг не записала, тож її memo якорем не є.
  if (transaction.meta !== null && transaction.meta.err !== null) return undefined

  const address = new PublicKey(fromHex(request.agentPubkey))
  const namesAgent = transaction.transaction.message.staticAccountKeys.some((key) =>
    key.equals(address),
  )
  if (!namesAgent) return undefined

  return decisionAnchorIn(anchorPayloadsOf(transaction), request.decisionId)
}

export async function anchorFromChain(
  chain: ChainSource,
  request: EvidenceRequest,
): Promise<Uint8Array | undefined> {
  if (request.anchorTransaction !== undefined) {
    const hinted = await anchorInTransaction(chain, request.anchorTransaction, request)
    if (hinted !== undefined) return hinted
    // Підказка не підтвердилася — далі звичайним шляхом, ніби її не було.
  }

  const address = new PublicKey(fromHex(request.agentPubkey))
  const history = await chain.getSignaturesForAddress(address, {
    limit: request.limit ?? HISTORY_LIMIT,
  })

  for (const entry of history) {
    // Невдала транзакція нічого в ланцюг не записала, тож її memo якорем не є.
    if (entry.err !== null) continue

    const transaction = await chain.getTransaction(entry.signature, {
      maxSupportedTransactionVersion: 0,
    })
    if (transaction === null) continue

    const found = decisionAnchorIn(anchorPayloadsOf(transaction), request.decisionId)
    if (found !== undefined) return found
  }

  return undefined
}

/**
 * Докази для `verifyDecision`, зібрані з двох незалежних місць. Відсутність
 * конверта названа `unavailable` і ніколи не `content-deleted`: сховище власника
 * не повідомляє, **чому** обʼєкта немає, і вигадати цю різницю тут означало б
 * показати стан сильнішим (або слабшим), ніж він насправді відомий.
 */
export async function collectEvidence(
  sources: { readonly chain: ChainSource; readonly fetch: FetchLike },
  request: EvidenceRequest,
): Promise<DecisionEvidence> {
  const [anchor, manifest] = await Promise.all([
    anchorFromChain(sources.chain, request),
    manifestFromUrl(sources.fetch, request.manifestUrl),
  ])

  return {
    ...(manifest === undefined ? { absence: 'unavailable' as const } : { manifest }),
    ...(anchor === undefined ? {} : { anchor }),
  }
}
