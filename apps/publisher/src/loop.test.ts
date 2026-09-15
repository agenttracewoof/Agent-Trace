import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { decodeAnchorMemo, decodeDecisionAnchor } from '@agenttrace/manifest'
import { PGlite } from '@electric-sql/pglite'
import { Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ATTEMPT_CEILING,
  backoffMs,
  type ChainClient,
  exceedsFeeCeiling,
  type PublisherConfig,
  publishPending,
  toBase58,
} from './loop.js'

const migrationDir = fileURLToPath(new URL('../drizzle/', import.meta.resolve('@agenttrace/db')))
const migration = readdirSync(migrationDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(migrationDir + name, 'utf8'))
  .join('\n')

const PROJECT = '11111111-1111-4111-8111-111111111111'
const AGENT = '22222222-2222-4222-8222-222222222222'
const KEY = '33333333-3333-4333-8333-333333333333'
const DECISION = '44444444-4444-4444-8444-444444444444'
const DECIDED_AT = 1_760_000_000_000

const agentKeypair = Keypair.generate()
const agentPubkey = Buffer.from(agentKeypair.publicKey.toBytes()).toString('hex')
const payer = Keypair.generate()

let client: PGlite
let db: ReturnType<typeof drizzle>

const config: PublisherConfig = {
  payer,
  maxPriorityLamports: 10_000,
  batchSize: 10,
  sleep: async () => {},
}

/** Підпис, який насправді поїхав у ланцюг — саме він мусить опинитися в базі. */
const signatureOf = (raw: Uint8Array): string =>
  toBase58(Transaction.from(raw).signature ?? new Uint8Array())

/**
 * Мінімальний клієнт ланцюга з керованою поведінкою. Мережі в тестах немає
 * навмисно: перевіряється логіка станів, а не те, чи відповідає devnet — це
 * доводить окремий прогін на кластері.
 */
function fakeChain(overrides: Partial<ChainClient> = {}): ChainClient {
  return {
    getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111' }),
    sendRawTransaction: async () => 'sent',
    getSignatureStatuses: async (signatures) => ({
      value: signatures.map(() => ({ slot: 500, confirmationStatus: 'confirmed', err: null })),
    }),
    getRecentPrioritizationFees: async () => [{ prioritizationFee: 0 }],
    ...overrides,
  }
}

async function seedDecision(id = DECISION, extra: Record<string, unknown> = {}): Promise<void> {
  await client.query(
    `INSERT INTO decisions (id, project_id, agent_id, agent_key_id, root, signature, decided_at,
                            model_ref, sources, steps, outcome, status, attempts,
                            next_attempt_at, anchor_signature)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'claude-opus-5', $8::jsonb, $9::jsonb, $10::jsonb,
             'pending', $11, $12, $13)`,
    [
      id,
      PROJECT,
      AGENT,
      KEY,
      'ab'.repeat(32),
      'cd'.repeat(64),
      DECIDED_AT,
      JSON.stringify(['https://quotes.example/']),
      JSON.stringify([{ type: 'source.read', private: false }]),
      JSON.stringify({ action: 'swap' }),
      extra.attempts ?? 0,
      extra.nextAttemptAt ?? new Date(Date.now() - 1000).toISOString(),
      extra.anchorSignature ?? null,
    ],
  )
}

type Row = {
  status: string
  attempts: number
  anchor_signature: string | null
  anchor_slot: number | null
  next_attempt_at: string
}

const readDecision = async (id = DECISION): Promise<Row> => {
  const rows = await client.query<Row>(
    `SELECT status, attempts, anchor_signature, anchor_slot::int, next_attempt_at
     FROM decisions WHERE id = $1`,
    [id],
  )
  const row = rows.rows[0]
  if (row === undefined) throw new Error('decision disappeared')
  return row
}

beforeAll(async () => {
  client = await PGlite.create()
  await client.exec(migration)
  db = drizzle(client)

  await client.query(`INSERT INTO projects (id, name, ingest_key_hash) VALUES ($1, 'demo', $2)`, [
    PROJECT,
    '0f'.repeat(32),
  ])
  await client.query(
    `INSERT INTO agents (id, project_id, external_id, name) VALUES ($1, $2, 'bot', 'Bot')`,
    [AGENT, PROJECT],
  )
  await client.query(
    `INSERT INTO agent_keys (id, agent_id, public_key, valid_from, rotation_kind)
     VALUES ($1, $2, $3, $4, 'initial')`,
    [KEY, AGENT, agentPubkey, DECIDED_AT],
  )
}, 60_000)

afterAll(async () => {
  await client?.close()
})

beforeEach(async () => {
  await client.query('DELETE FROM decisions')
})

describe('backoffMs', () => {
  it('grows with each attempt', () => {
    expect(backoffMs(1)).toBeLessThan(backoffMs(2))
    expect(backoffMs(2)).toBeLessThan(backoffMs(3))
  })

  it('never exceeds the ceiling, however many attempts', () => {
    expect(backoffMs(ATTEMPT_CEILING)).toBe(backoffMs(1000))
  })

  it('waits before the very first retry', () => {
    expect(backoffMs(1)).toBeGreaterThan(0)
  })
})

describe('exceedsFeeCeiling', () => {
  it('publishes when the network is cheap', () => {
    expect(exceedsFeeCeiling([{ prioritizationFee: 0 }, { prioritizationFee: 10 }], 10_000)).toBe(
      false,
    )
  })

  it('defers when the median slot costs more than the ceiling', () => {
    expect(
      exceedsFeeCeiling(
        [{ prioritizationFee: 50_000 }, { prioritizationFee: 60_000 }, { prioritizationFee: 1 }],
        10_000,
      ),
    ).toBe(true)
  })

  it('publishes when the RPC reports no recent fees at all', () => {
    // Порожня відповідь означає «невідомо», а не «дорого». Відкладати на ній
    // означало б зупинити публікацію через мовчання RPC.
    expect(exceedsFeeCeiling([], 10_000)).toBe(false)
  })
})

describe('toBase58', () => {
  it('agrees with the library on 32 bytes', () => {
    // Звірка з реалізацією @solana/web3.js: власний кодувальник, який розійдеться
    // з нею, дав би підпис, за яким у ланцюгу нічого не знайдеться.
    const bytes = Keypair.generate().publicKey.toBytes()
    expect(toBase58(bytes)).toBe(new PublicKey(bytes).toBase58())
  })

  it('keeps leading zero bytes', () => {
    const bytes = new Uint8Array(32)
    expect(toBase58(bytes)).toBe(new PublicKey(bytes).toBase58())
  })
})

describe('publishPending', () => {
  it('anchors a pending decision and records signature, slot and time', async () => {
    await seedDecision()
    let sent: Uint8Array = new Uint8Array()

    const published = await publishPending(
      db,
      fakeChain({
        sendRawTransaction: async (raw) => {
          sent = raw
          return 'ignored'
        },
      }),
      config,
    )
    const row = await readDecision()

    expect(published).toBe(1)
    expect(row.status).toBe('anchored')
    // Підпис у базі — той, що в транзакції, а не той, що повернув RPC: рахуємо
    // його локально, бо зберегти його треба до відправки.
    expect(row.anchor_signature).toBe(signatureOf(sent))
    expect(row.anchor_slot).toBe(500)
  })

  it('puts the anchor of that very decision into the memo', async () => {
    await seedDecision()
    let raw: Uint8Array = new Uint8Array()

    await publishPending(
      db,
      fakeChain({
        sendRawTransaction: async (transaction) => {
          raw = transaction
          return 'sent'
        },
      }),
      config,
    )

    const memo = Transaction.from(raw).instructions.at(-1)
    const decoded = decodeAnchorMemo(Buffer.from(memo?.data ?? []).toString('utf8'))
    const anchor = decodeDecisionAnchor(decoded ?? new Uint8Array())

    expect(anchor.agentPubkey).toBe(agentPubkey)
    expect(anchor.root).toBe('ab'.repeat(32))
    expect(anchor.decisionId).toBe(DECISION.replaceAll('-', ''))
    expect(anchor.decidedAt).toBe(DECIDED_AT)
  })

  it('names the agent among the transaction accounts', async () => {
    await seedDecision()
    let raw: Uint8Array = new Uint8Array()

    await publishPending(
      db,
      fakeChain({
        sendRawTransaction: async (transaction) => {
          raw = transaction
          return 'sent'
        },
      }),
      config,
    )

    const keys = Transaction.from(raw)
      .compileMessage()
      .accountKeys.map((one) => one.toBase58())
    expect(keys).toContain(new PublicKey(Buffer.from(agentPubkey, 'hex')).toBase58())
  })

  it('stores the signature before the transaction is sent', async () => {
    // Найдорожчий інваріант задачі: якщо процес помре рівно тут, наступний
    // прохід мусить знайти підпис у базі, інакше він поставить другий якір.
    await seedDecision()
    let seenDuringSend: string | null = null

    await publishPending(
      db,
      fakeChain({
        sendRawTransaction: async () => {
          seenDuringSend = (await readDecision()).anchor_signature
          return 'sent'
        },
      }),
      config,
    )

    expect(seenDuringSend).not.toBeNull()
  })

  it('confirms an already sent signature instead of sending a second one', async () => {
    await seedDecision(DECISION, { anchorSignature: 'sent-before-the-crash' })
    let sends = 0

    const published = await publishPending(
      db,
      fakeChain({
        sendRawTransaction: async () => {
          sends += 1
          return 'sent'
        },
      }),
      config,
    )
    const row = await readDecision()

    expect(sends).toBe(0)
    expect(published).toBe(1)
    expect(row.status).toBe('anchored')
    expect(row.anchor_signature).toBe('sent-before-the-crash')
  })

  it('resends when the chain has never heard of the stored signature', async () => {
    await seedDecision(DECISION, { anchorSignature: 'dropped' })
    let asked = 0
    let sent: Uint8Array = new Uint8Array()

    await publishPending(
      db,
      fakeChain({
        // Перше опитування — про збережений підпис, і його в ланцюгу немає:
        // рядок повернувся в цикл уже після вікна блокхешу, тож транзакція
        // не долетить ніколи. Наступні — про щойно відправлену.
        getSignatureStatuses: async () => {
          asked += 1
          return {
            value: [asked === 1 ? null : { slot: 501, confirmationStatus: 'confirmed', err: null }],
          }
        },
        sendRawTransaction: async (raw) => {
          sent = raw
          return 'ignored'
        },
      }),
      config,
    )
    const row = await readDecision()

    expect(row.status).toBe('anchored')
    expect(row.anchor_signature).toBe(signatureOf(sent))
    expect(row.anchor_signature).not.toBe('dropped')
  })

  it('retries a decision whose transaction the chain rejected', async () => {
    await seedDecision(DECISION, { anchorSignature: 'failed-on-chain' })

    const published = await publishPending(
      db,
      fakeChain({
        getSignatureStatuses: async () => ({
          value: [{ slot: 7, confirmationStatus: 'confirmed', err: { InstructionError: [0, {}] } }],
        }),
      }),
      config,
    )
    const row = await readDecision()

    expect(published).toBe(0)
    expect(row.status).toBe('pending')
    expect(row.anchor_signature).toBeNull()
    expect(row.attempts).toBe(1)
  })

  it('keeps an unconfirmed signature and waits out the blockhash window', async () => {
    // Ядро R10: підтвердження не прийшло, але транзакція ще може долетіти.
    // Стерти підпис тут означало б відправити другу — тобто другий якір.
    await seedDecision()
    let sent: Uint8Array = new Uint8Array()

    const published = await publishPending(
      db,
      fakeChain({
        getSignatureStatuses: async () => ({ value: [null] }),
        sendRawTransaction: async (raw) => {
          sent = raw
          return 'ignored'
        },
      }),
      config,
    )
    const row = await readDecision()

    expect(published).toBe(0)
    expect(row.status).toBe('pending')
    expect(row.anchor_signature).toBe(signatureOf(sent))
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 60_000)
  })

  it('defers instead of outbidding when the network costs more than the ceiling', async () => {
    await seedDecision()
    let sends = 0

    const published = await publishPending(
      db,
      fakeChain({
        getRecentPrioritizationFees: async () => [{ prioritizationFee: 999_999 }],
        sendRawTransaction: async () => {
          sends += 1
          return 'sent'
        },
      }),
      config,
    )
    const row = await readDecision()

    expect(sends).toBe(0)
    expect(published).toBe(0)
    expect(row.status).toBe('pending')
    // Дорога мережа не є провиною рішення: лічильник спроб не росте, інакше
    // рішення врешті стало б `failed` за чужий затор.
    expect(row.attempts).toBe(0)
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now())
  })

  it('backs off after a failed send and comes back later', async () => {
    await seedDecision()

    await publishPending(
      db,
      fakeChain({
        sendRawTransaction: async () => {
          throw new Error('rpc down')
        },
      }),
      config,
    )
    const row = await readDecision()

    expect(row.status).toBe('pending')
    expect(row.attempts).toBe(1)
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now())
  })

  it('gives up after the attempt ceiling instead of retrying forever', async () => {
    await seedDecision(DECISION, { attempts: ATTEMPT_CEILING - 1 })

    await publishPending(
      db,
      fakeChain({
        sendRawTransaction: async () => {
          throw new Error('rpc down')
        },
      }),
      config,
    )

    expect((await readDecision()).status).toBe('failed')
  })

  it('leaves decisions whose backoff has not elapsed alone', async () => {
    await seedDecision(DECISION, {
      nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
    })

    expect(await publishPending(db, fakeChain(), config)).toBe(0)
    expect((await readDecision()).status).toBe('pending')
  })

  it('publishes a whole batch and stops at the configured size', async () => {
    await seedDecision('44444444-4444-4444-8444-44444444444a')
    await seedDecision('44444444-4444-4444-8444-44444444444b')
    await seedDecision('44444444-4444-4444-8444-44444444444c')

    expect(await publishPending(db, fakeChain(), { ...config, batchSize: 2 })).toBe(2)
  })

  it('keeps going when one decision in the batch fails', async () => {
    await seedDecision('44444444-4444-4444-8444-44444444444a')
    await seedDecision('44444444-4444-4444-8444-44444444444b')
    let first = true

    const published = await publishPending(
      db,
      fakeChain({
        sendRawTransaction: async () => {
          if (first) {
            first = false
            throw new Error('one bad send')
          }
          return 'sent'
        },
      }),
      config,
    )

    expect(published).toBe(1)
  })
})

/**
 * T071 — те, заради чого прохід став пакетним. Ці тести перевіряють не швидкість
 * (її міряє наскрізний сценарій на живому кластері), а **кількість круговертей**:
 * саме вона робила публікацію послідовною ціною ~1,4 с за рішення.
 */
describe('one pass, one round trip', () => {
  const idOf = (index: number) =>
    `44444444-4444-4444-8444-4444444444${index.toString().padStart(2, '0')}`

  async function seedMany(count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) await seedDecision(idOf(index))
  }

  it('asks for one blockhash and one fee sample, however many decisions there are', async () => {
    await seedMany(10)
    let blockhashCalls = 0
    let feeCalls = 0

    const published = await publishPending(
      db,
      fakeChain({
        getLatestBlockhash: async () => {
          blockhashCalls += 1
          return { blockhash: '11111111111111111111111111111111' }
        },
        getRecentPrioritizationFees: async () => {
          feeCalls += 1
          return [{ prioritizationFee: 0 }]
        },
      }),
      config,
    )

    expect(published).toBe(10)
    // Блокхеш живе ~60–90 с, а ціна в мережі одна на всіх: питати їх на кожне
    // рішення означало б двадцять круговертей там, де досить двох.
    expect(blockhashCalls).toBe(1)
    expect(feeCalls).toBe(1)
  })

  it('confirms the whole batch in one status call per poll', async () => {
    await seedMany(10)
    const asked: number[] = []

    const published = await publishPending(
      db,
      fakeChain({
        getSignatureStatuses: async (signatures) => {
          asked.push(signatures.length)
          return {
            value: signatures.map(() => ({
              slot: 500,
              confirmationStatus: 'confirmed',
              err: null,
            })),
          }
        },
      }),
      config,
    )

    expect(published).toBe(10)
    // Один запит на всі десять підписів — метод бере до 256 за раз.
    expect(asked).toEqual([10])
  })

  it('still isolates a failure inside the batch', async () => {
    // Пакетність не має купуватися ціною «одне зіпсоване рішення топить прохід».
    await seedMany(3)
    let sends = 0

    const published = await publishPending(
      db,
      fakeChain({
        sendRawTransaction: async () => {
          sends += 1
          if (sends === 2) throw new Error('one bad send')
          return 'sent'
        },
      }),
      config,
    )

    expect(published).toBe(2)
  })

  it('defers the whole batch when the network price is above the ceiling', async () => {
    await seedMany(4)

    const published = await publishPending(
      db,
      fakeChain({ getRecentPrioritizationFees: async () => [{ prioritizationFee: 50_000 }] }),
      config,
    )

    expect(published).toBe(0)
    // Затор не є провиною рішення: спроби не ростуть, рядок лишається pending.
    const row = await readDecision(idOf(0))
    expect(row.status).toBe('pending')
    expect(row.attempts).toBe(0)
  })
})
