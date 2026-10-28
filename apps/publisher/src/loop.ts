import { agentKeys, decisions } from '@agenttrace/db'
import {
  ADMINISTRATIVE_ROTATION_SIGNATURE,
  ANCHOR_KIND,
  encodeDecisionAnchor,
  encodeKeyRotationAnchor,
  ROTATION_KIND,
} from '@agenttrace/manifest'
import type { Keypair } from '@solana/web3.js'
import { and, asc, eq, lte } from 'drizzle-orm'
import { alias, type PgDatabase, type PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { buildAnchorTransaction } from './memo.js'

/**
 * Цикл публікації (FR-007). Рішення лежить у базі `pending`, звідси воно
 * потрапляє в ланцюг рівно один раз — і «рівно один раз» тут коштує дорожче,
 * ніж здається: підпис транзакції зберігається **до** відправки, бо інакше
 * обрив між `sendRawTransaction` і підтвердженням лишав би рядок без жодного
 * сліду, а наступний прохід ставив би другий якір на те саме рішення (R10).
 *
 * A key rotation goes the same way (T068, FR-022/FR-027): its anchor is what
 * lets a verifier follow the agent's identity from the chain alone, and a
 * second anchor of the same rotation would be as wrong as a second one of a
 * decision.
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
  /**
   * Present only on the caching client (`budget.ts`). A failed send may have
   * failed on the cached blockhash itself, and the next pass has to take a fresh
   * one rather than repeat the same failure until the cache window runs out.
   */
  forgetBlockhash?(): void
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

interface AnchorChange {
  readonly status?: 'pending' | 'anchored' | 'failed'
  readonly attempts?: number
  readonly anchorSignature?: string | null
  readonly anchorSlot?: number
  readonly anchoredAt?: Date
  readonly nextAttemptAt?: Date
}

/** The only place the two tables differ for the loop: where the row lives and what its status is called. */
type ApplyChange = (db: AnyPgDatabase, id: string, change: AnchorChange) => Promise<void>

const decisionChange: ApplyChange = async (db, id, change) => {
  await db.update(decisions).set(change).where(eq(decisions.id, id))
}

const rotationChange: ApplyChange = async (db, id, { status, ...rest }) => {
  await db
    .update(agentKeys)
    .set({ ...rest, ...(status === undefined ? {} : { anchorStatus: status }) })
    .where(eq(agentKeys.id, id))
}

interface PendingRow {
  readonly id: string
  readonly attempts: number
  readonly anchorSignature: string | null
  readonly apply: ApplyChange
  /** Байти якоря і адреси, за якими його знайдуть. Лінивий: невдале кодування — це спроба, що не вдалася. */
  readonly anchor: () => { readonly payload: Uint8Array; readonly indexedBy: readonly string[] }
}

async function markAnchored(
  db: AnyPgDatabase,
  row: PendingRow,
  signature: string,
  slot: number,
): Promise<void> {
  await row.apply(db, row.id, {
    status: 'anchored',
    anchorSignature: signature,
    anchorSlot: slot,
    anchoredAt: new Date(),
  })
}

async function defer(db: AnyPgDatabase, row: PendingRow, ms: number): Promise<void> {
  await row.apply(db, row.id, { nextAttemptAt: new Date(Date.now() + ms) })
}

async function failAttempt(db: AnyPgDatabase, row: PendingRow): Promise<void> {
  const attempts = row.attempts + 1
  await row.apply(db, row.id, {
    attempts,
    anchorSignature: null,
    status: attempts >= ATTEMPT_CEILING ? 'failed' : 'pending',
    nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
  })
}

/**
 * Скільки відправок ідуть одночасно. Стеля існує не заради ланцюга — транзакції
 * незалежні, послідовного nonce у Solana немає, — а заради RPC: пачка з двох
 * сотень одночасних викликів упреться в ліміт провайдера і повернеться до нас
 * помилками, які виглядатимуть як провина рішень.
 */
const SEND_CONCURRENCY = 8

/** Скільки підписів `getSignatureStatuses` бере за раз — межа методу. */
const STATUS_BATCH = 256

async function statusesOf(
  chain: ChainClient,
  signatures: readonly string[],
): Promise<Map<string, SignatureStatusLike | null>> {
  const found = new Map<string, SignatureStatusLike | null>()

  for (let start = 0; start < signatures.length; start += STATUS_BATCH) {
    const chunk = signatures.slice(start, start + STATUS_BATCH)
    const { value } = await chain.getSignatureStatuses([...chunk])
    chunk.forEach((signature, index) => {
      found.set(signature, value[index] ?? null)
    })
  }

  return found
}

/**
 * Рядки, які вже несуть підпис із попереднього проходу. Статуси питаються
 * **однією** відповіддю на всю пачку: метод бере до 256 підписів, і саме так
 * `PLAN.md` рахував бюджет RPC. Запит на кожен рядок окремо давав би стільки ж
 * круговертей, скільки рішень.
 */
async function resolveInFlight(
  db: AnyPgDatabase,
  chain: ChainClient,
  rows: readonly PendingRow[],
): Promise<{ readonly published: number; readonly resend: readonly PendingRow[] }> {
  const carrying = rows.filter((row) => row.anchorSignature !== null)
  if (carrying.length === 0) return { published: 0, resend: [] }

  const statuses = await statusesOf(
    chain,
    carrying.map((row) => row.anchorSignature as string),
  )

  let published = 0
  const resend: PendingRow[] = []

  for (const row of carrying) {
    const status = statuses.get(row.anchorSignature as string) ?? null

    if (status != null && confirmed(status)) {
      await markAnchored(db, row, row.anchorSignature as string, status.slot)
      published += 1
    } else if (status != null && status.err !== null) {
      await failAttempt(db, row)
    } else if (status != null) {
      await defer(db, row, CONFIRM_POLL_MS)
    } else {
      // Підпису в ланцюгу немає, а вікно блокхешу вже минуло (рядок повернувся
      // сюди не раніше, ніж через BLOCKHASH_EXPIRY_MS) — транзакція не долетить.
      resend.push(row)
    }
  }

  return { published, resend }
}

interface SentAnchor {
  readonly row: PendingRow
  readonly anchorSignature: string
}

/**
 * Відправка. Блокхеш і комісії питаються **раз на прохід**, а не на рішення:
 * блокхеш живе ~60–90 с, стеля комісії описує стан мережі, а не окремий запис,
 * і саме ці два запити на кожне рішення й робили публікацію послідовною ціною
 * ~1,4 с за штуку (замір T036).
 *
 * Above the pass sits a 30 s cache as well (`budget.ts`, T076): with sparse
 * arrivals "once per pass" meant "once per decision", and these two requests
 * were two of the five credits each decision cost.
 */
async function sendOne(
  db: AnyPgDatabase,
  chain: ChainClient,
  config: PublisherConfig,
  row: PendingRow,
  blockhash: string,
): Promise<SentAnchor | undefined> {
  try {
    const transaction = buildAnchorTransaction({
      payer: config.payer.publicKey,
      ...row.anchor(),
      recentBlockhash: blockhash,
    })
    transaction.sign(config.payer)

    const signature = transaction.signature
    if (signature === null) throw new Error('sendOne: transaction stayed unsigned')
    const anchorSignature = toBase58(signature)

    // Підпис лягає в базу **до** відправки: інакше обрив між `sendRawTransaction`
    // і підтвердженням лишив би рядок без сліду, а наступний прохід поставив би
    // другий якір на те саме рішення (R10).
    await row.apply(db, row.id, { anchorSignature })
    await chain.sendRawTransaction(transaction.serialize())

    return { row, anchorSignature }
  } catch {
    await failAttempt(db, row)
    return undefined
  }
}

/**
 * Підтвердження всієї пачки одним опитуванням замість очікування кожного рішення
 * по черзі. Раніше кожне рішення блокувало прохід у своєму `confirmSignature`
 * до 15 с — десяте чекало дев'ятьох, і саме звідси бралися 18 с у SC-001.
 */
async function confirmBatch(
  db: AnyPgDatabase,
  chain: ChainClient,
  sent: readonly SentAnchor[],
  sleep: (ms: number) => Promise<void>,
): Promise<number> {
  const waiting = new Map(sent.map((one) => [one.anchorSignature, one.row]))
  let published = 0

  // Sleep **before** polling, not after: a transaction sent a moment ago is
  // never `confirmed` — it needs at least a slot and the votes. The poll at
  // zero seconds cost a credit per decision and found nothing (T076); the
  // remaining polls land at the same moments, so SC-001 does not move.
  for (let poll = 0; poll < CONFIRM_POLLS && waiting.size > 0; poll += 1) {
    await sleep(CONFIRM_POLL_MS)
    const statuses = await statusesOf(chain, [...waiting.keys()])

    for (const [anchorSignature, row] of [...waiting]) {
      const status = statuses.get(anchorSignature) ?? null
      if (status == null) continue

      if (confirmed(status)) {
        await markAnchored(db, row, anchorSignature, status.slot)
        published += 1
        waiting.delete(anchorSignature)
      } else if (status.err !== null) {
        await failAttempt(db, { ...row, anchorSignature })
        waiting.delete(anchorSignature)
      }
    }
  }

  // Те, що не підтвердилося за відведені поли, не втрачене: підпис у базі, і
  // наступний прохід почне саме з нього — після вікна блокхешу, не раніше.
  for (const row of waiting.values()) await defer(db, row, BLOCKHASH_EXPIRY_MS)

  return published
}

async function pendingDecisions(db: AnyPgDatabase, limit: number): Promise<PendingRow[]> {
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
    .limit(limit)

  return rows.map((row) => ({
    id: row.id,
    attempts: row.attempts,
    anchorSignature: row.anchorSignature,
    apply: decisionChange,
    anchor: () => ({
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
    }),
  }))
}

async function pendingRotations(db: AnyPgDatabase, limit: number): Promise<PendingRow[]> {
  const previous = alias(agentKeys, 'previous')
  const rows = await db
    .select({
      id: agentKeys.id,
      newPubkey: agentKeys.publicKey,
      prevPubkey: previous.publicKey,
      rotationKind: agentKeys.rotationKind,
      effectiveAt: agentKeys.validFrom,
      proof: agentKeys.rotationProof,
      attempts: agentKeys.attempts,
      anchorSignature: agentKeys.anchorSignature,
    })
    .from(agentKeys)
    .innerJoin(previous, eq(previous.id, agentKeys.prevKeyId))
    .where(and(eq(agentKeys.anchorStatus, 'pending'), lte(agentKeys.nextAttemptAt, new Date())))
    .orderBy(asc(agentKeys.nextAttemptAt))
    .limit(limit)

  return rows.map((row) => ({
    id: row.id,
    attempts: row.attempts,
    anchorSignature: row.anchorSignature,
    apply: rotationChange,
    anchor: () => ({
      payload: encodeKeyRotationAnchor({
        version: 1,
        kind: ANCHOR_KIND.keyRotation,
        newPubkey: row.newPubkey,
        prevPubkey: row.prevPubkey,
        effectiveAt: row.effectiveAt,
        ...(row.rotationKind === 'administrative'
          ? {
              rotationKind: ROTATION_KIND.administrative,
              signature: ADMINISTRATIVE_ROTATION_SIGNATURE,
            }
          : { rotationKind: ROTATION_KIND.chained, signature: row.proof }),
      }),
      indexedBy: [row.prevPubkey, row.newPubkey],
    }),
  }))
}

/**
 * Один прохід черги. Рішення незалежні одне від одного: падіння на одному не
 * зупиняє решту — інакше єдиний зіпсований рядок тримав би всю чергу.
 *
 * Прохід зроблений **пакетним** (T071): спільні блокхеш і комісії, паралельні
 * відправки, одне опитування статусів на всіх. До цього кожне рішення робило
 * два власні запити й чекало власного підтвердження, тож пачка з десяти йшла
 * ~18 с при бюджеті SC-001 у 10 с — заміряно наскрізним сценарієм, а не оцінено.
 *
 * Блокувань немає навмисно: publisher — один процес (`PLAN.md` → чому окремий
 * сервіс), і `SELECT … FOR UPDATE` тут захищав би від конкурента, якого немає.
 *
 * Rotations go first in the pass but hold nothing back: a decision of the new
 * key is published whether or not its rotation anchor is through yet. The line
 * between the keys is `effectiveAt` inside the anchor, not the order of
 * transactions, and a rotation stuck at `failed` shows up to the verifier as
 * the break it is instead of stopping the agent's whole queue.
 */
export async function publishPending(
  db: AnyPgDatabase,
  chain: ChainClient,
  config: PublisherConfig,
): Promise<number> {
  const sleep = config.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)))

  const rows = [
    ...(await pendingRotations(db, config.batchSize)),
    ...(await pendingDecisions(db, config.batchSize)),
  ]

  if (rows.length === 0) return 0

  const inFlight = await resolveInFlight(db, chain, rows)
  const resend = new Set(inFlight.resend)
  const toSend = rows.filter((row) => row.anchorSignature === null || resend.has(row))
  if (toSend.length === 0) return inFlight.published

  if (exceedsFeeCeiling(await chain.getRecentPrioritizationFees(), config.maxPriorityLamports)) {
    // Затор — не провина рішення, тож лічильник спроб не росте: інакше рішення
    // стало б `failed` за чужу ціну. Відкладається вся пачка: ціна в мережі
    // одна на всіх, і питати її для кожного рядка окремо нема сенсу.
    for (const row of toSend) await defer(db, row, backoffMs(row.attempts + 1))
    return inFlight.published
  }

  const { blockhash } = await chain.getLatestBlockhash()

  const sent: SentAnchor[] = []
  for (let start = 0; start < toSend.length; start += SEND_CONCURRENCY) {
    const chunk = toSend.slice(start, start + SEND_CONCURRENCY)
    const results = await Promise.all(
      chunk.map((row) => sendOne(db, chain, config, row, blockhash)),
    )
    for (const one of results) if (one !== undefined) sent.push(one)
  }
  if (sent.length < toSend.length) chain.forgetBlockhash?.()

  return inFlight.published + (await confirmBatch(db, chain, sent, sleep))
}
