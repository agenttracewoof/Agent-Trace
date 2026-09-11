import { agentKeys, decisions } from '@agenttrace/db'
import { ANCHOR_KIND, encodeDecisionAnchor } from '@agenttrace/manifest'
import type { Keypair } from '@solana/web3.js'
import { and, asc, eq, lte } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { buildAnchorTransaction } from './memo.js'

/**
 * Цикл публікації (FR-007). Рішення лежить у базі `pending`, звідси воно
 * потрапляє в ланцюг рівно один раз — і «рівно один раз» тут коштує дорожче,
 * ніж здається: підпис транзакції зберігається **до** відправки, бо інакше
 * обрив між `sendRawTransaction` і підтвердженням лишав би рядок без жодного
 * сліду, а наступний прохід ставив би другий якір на те саме рішення (R10).
 */

/** Після стількох невдалих спроб рішення стає `failed` і цикл його більше не бере. */
export const ATTEMPT_CEILING = 10

const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 5 * 60_000

/**
 * Скільки чекати, перш ніж вважати відправлену транзакцію такою, що не долетить.
 * Це не оцінка «на око»: транзакція живе рівно доти, доки чинний її блокхеш
 * (~150 слотів). Поки вікно не минуло, відсутність підпису в ланцюгу означає
 * «ще не видно», а не «загубилась», і повторна відправка була б другим якорем.
 */
const BLOCKHASH_EXPIRY_MS = 90_000

const CONFIRM_POLLS = 15
const CONFIRM_POLL_MS = 1_000

export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS)
}

/**
 * Стеля комісії — не «скільки платимо», а «за якої ціни взагалі не публікуємо»
 * (R4). Транзакція якоря не несе інструкції пріоритету: публікація не в
 * реальному часі, тож дочекатися дешевого слоту завжди краще, ніж перебивати
 * ціну. Медіана, а не максимум: один дорогий слот у вибірці — це не затор.
 */
export function exceedsFeeCeiling(
  fees: readonly { readonly prioritizationFee: number }[],
  ceilingLamports: number,
): boolean {
  if (fees.length === 0) return false

  const sorted = [...fees].map((one) => one.prioritizationFee).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0

  return median > ceilingLamports
}

interface SignatureStatusLike {
  readonly slot: number
  readonly err: unknown
  readonly confirmationStatus?: string | null
}

/** Рівно те, що цикл питає в ланцюга. `Connection` задовольняє це структурно. */
export interface ChainClient {
  getLatestBlockhash(): Promise<{ readonly blockhash: string }>
  sendRawTransaction(raw: Uint8Array): Promise<string>
  getSignatureStatuses(
    signatures: string[],
  ): Promise<{ readonly value: readonly (SignatureStatusLike | null)[] }>
  getRecentPrioritizationFees(): Promise<readonly { readonly prioritizationFee: number }[]>
}

export interface PublisherConfig {
  readonly payer: Keypair
  readonly maxPriorityLamports: number
  readonly batchSize: number
  readonly sleep?: (ms: number) => Promise<void>
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/**
 * Підпис транзакції рахується локально, бо він потрібен **раніше**, ніж RPC
 * встигне його повернути. `@solana/web3.js` свого кодувальника назовні не дає,
 * а залежність заради тридцяти рядків не купує нічого; тест звіряє цю функцію
 * з `PublicKey.toBase58()`, тобто з реалізацією самої бібліотеки.
 */
export function toBase58(bytes: Uint8Array): string {
  const digits: number[] = []
  for (const byte of bytes) {
    let carry = byte
    for (let i = 0; i < digits.length; i += 1) {
      carry += (digits[i] as number) << 8
      digits[i] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }

  let leading = ''
  for (const byte of bytes) {
    if (byte !== 0) break
    leading += BASE58_ALPHABET[0]
  }

  return (
    leading +
    digits
      .reverse()
      .map((digit) => BASE58_ALPHABET[digit])
      .join('')
  )
}

const confirmed = (status: SignatureStatusLike): boolean =>
  status.err === null &&
  (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')

/**
 * Тип узятий на рівні діалекту й параметризований, як і в прийманні: у
 * `PgDatabase` схема стоїть в інваріантній позиції, тож фіксована перетворила б
 * підпис на «рівно postgres-js рівно з нашою схемою» — і цикл не проганявся б
 * тестом на PGlite, на тій самій міграції, що поїде в Supabase.
 */
type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>

interface PendingRow {
  readonly id: string
  readonly agentPubkey: string
  readonly root: string
  readonly signature: string
  readonly decidedAt: number
  readonly attempts: number
  readonly anchorSignature: string | null
}

async function markAnchored(
  db: AnyPgDatabase,
  id: string,
  signature: string,
  slot: number,
): Promise<void> {
  await db
    .update(decisions)
    .set({
      status: 'anchored',
      anchorSignature: signature,
      anchorSlot: slot,
      anchoredAt: new Date(),
    })
    .where(eq(decisions.id, id))
}

async function defer(db: AnyPgDatabase, id: string, ms: number): Promise<void> {
  await db
    .update(decisions)
    .set({ nextAttemptAt: new Date(Date.now() + ms) })
    .where(eq(decisions.id, id))
}

async function failAttempt(db: AnyPgDatabase, row: PendingRow): Promise<void> {
  const attempts = row.attempts + 1
  await db
    .update(decisions)
    .set({
      attempts,
      anchorSignature: null,
      status: attempts >= ATTEMPT_CEILING ? 'failed' : 'pending',
      nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
    })
    .where(eq(decisions.id, row.id))
}

async function confirmSignature(
  chain: ChainClient,
  signature: string,
  sleep: (ms: number) => Promise<void>,
): Promise<SignatureStatusLike | null> {
  for (let poll = 0; poll < CONFIRM_POLLS; poll += 1) {
    const [status] = (await chain.getSignatureStatuses([signature])).value
    if (status != null && (confirmed(status) || status.err !== null)) return status
    await sleep(CONFIRM_POLL_MS)
  }
  return null
}

async function publishOne(
  db: AnyPgDatabase,
  chain: ChainClient,
  config: PublisherConfig,
  row: PendingRow,
): Promise<boolean> {
  const sleep = config.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)))

  if (row.anchorSignature !== null) {
    const [status] = (await chain.getSignatureStatuses([row.anchorSignature])).value

    if (status != null && confirmed(status)) {
      await markAnchored(db, row.id, row.anchorSignature, status.slot)
      return true
    }
    if (status != null && status.err !== null) {
      await failAttempt(db, row)
      return false
    }
    if (status != null) {
      await defer(db, row.id, CONFIRM_POLL_MS)
      return false
    }
    // Підпису в ланцюгу немає, а вікно блокхешу вже минуло (рядок повернувся
    // сюди не раніше, ніж через BLOCKHASH_EXPIRY_MS) — транзакція не долетить.
  }

  if (exceedsFeeCeiling(await chain.getRecentPrioritizationFees(), config.maxPriorityLamports)) {
    // Затор — не провина рішення, тож лічильник спроб не росте: інакше рішення
    // стало б `failed` за чужу ціну.
    await defer(db, row.id, backoffMs(row.attempts + 1))
    return false
  }

  try {
    const transaction = buildAnchorTransaction({
      payer: config.payer.publicKey,
      payload: encodeDecisionAnchor({
        version: 1,
        kind: ANCHOR_KIND.decision,
        agentPubkey: row.agentPubkey,
        root: row.root,
        decisionId: row.id.replaceAll('-', ''),
        decidedAt: row.decidedAt,
        signature: row.signature,
      }),
      indexedBy: [row.agentPubkey],
      recentBlockhash: (await chain.getLatestBlockhash()).blockhash,
    })
    transaction.sign(config.payer)

    const signature = transaction.signature
    if (signature === null) throw new Error('publishOne: transaction stayed unsigned')
    const anchorSignature = toBase58(signature)

    await db.update(decisions).set({ anchorSignature }).where(eq(decisions.id, row.id))

    await chain.sendRawTransaction(transaction.serialize())

    const status = await confirmSignature(chain, anchorSignature, sleep)
    if (status != null && confirmed(status)) {
      await markAnchored(db, row.id, anchorSignature, status.slot)
      return true
    }
    if (status != null) {
      await failAttempt(db, { ...row, anchorSignature })
      return false
    }

    await defer(db, row.id, BLOCKHASH_EXPIRY_MS)
    return false
  } catch {
    await failAttempt(db, row)
    return false
  }
}

/**
 * Один прохід черги. Рішення беруться по одному й незалежно: падіння на одному
 * не має зупиняти решту — інакше єдиний зіпсований рядок тримав би всю чергу.
 *
 * Блокувань немає навмисно: publisher — один процес (`PLAN.md` → чому окремий
 * сервіс), і `SELECT … FOR UPDATE` тут захищав би від конкурента, якого немає.
 */
export async function publishPending(
  db: AnyPgDatabase,
  chain: ChainClient,
  config: PublisherConfig,
): Promise<number> {
  const rows = await db
    .select({
      id: decisions.id,
      agentPubkey: agentKeys.publicKey,
      root: decisions.root,
      signature: decisions.signature,
      decidedAt: decisions.decidedAt,
      attempts: decisions.attempts,
      anchorSignature: decisions.anchorSignature,
    })
    .from(decisions)
    .innerJoin(agentKeys, eq(agentKeys.id, decisions.agentKeyId))
    .where(and(eq(decisions.status, 'pending'), lte(decisions.nextAttemptAt, new Date())))
    .orderBy(asc(decisions.nextAttemptAt))
    .limit(config.batchSize)

  let published = 0
  for (const row of rows) {
    if (await publishOne(db, chain, config, row)) published += 1
  }

  return published
}
