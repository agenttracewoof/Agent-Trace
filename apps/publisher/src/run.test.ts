import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { Keypair } from '@solana/web3.js'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type ChainClient, type PublisherConfig, toBase58 } from './loop.js'
import {
  chainFromEnv,
  fromBase58,
  publisherConfigFromEnv,
  requiredEnv,
  startPublisher,
} from './run.js'

/**
 * Перевіряється властивість **циклу**, а не проходу: коли він зупиняється, чи
 * переживає падіння і чи справді публікує. База тут справжня (та сама міграція,
 * що й у `loop.test.ts`) — мок навколо запиту drizzle довів би лише те, що мок
 * повторює форму запиту. Керованим місцем лишається ланцюг: `ChainClient` для
 * того й існує.
 */
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

let client: PGlite
let db: ReturnType<typeof drizzle>

const config: PublisherConfig = {
  payer: Keypair.generate(),
  maxPriorityLamports: 10_000,
  batchSize: 10,
  sleep: async () => {},
}

const silent = { info: () => {}, error: () => {} }

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

const seedPending = (id = DECISION) =>
  client.query(
    `INSERT INTO decisions (id, project_id, agent_id, agent_key_id, root, signature, decided_at,
                            model_ref, sources, steps, outcome, status, attempts, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'claude-opus-5', $8::jsonb, $9::jsonb, $10::jsonb,
             'pending', 0, $11)`,
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
      new Date(Date.now() - 1000).toISOString(),
    ],
  )

const statusOf = async (id = DECISION): Promise<string> => {
  const rows = await client.query<{ status: string }>(
    'SELECT status FROM decisions WHERE id = $1',
    [id],
  )
  return rows.rows[0]?.status ?? 'gone'
}

const settle = (ms: number) => new Promise((done) => setTimeout(done, ms))

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

describe('цикл publisher як керований процес', () => {
  it('anchors what is pending and stops on request', async () => {
    await seedPending()
    const publisher = startPublisher({ db, chain: fakeChain(), config, logger: silent, tickMs: 5 })

    await settle(150)
    await publisher.stop()

    expect(await statusOf()).toBe('anchored')
  })

  it('finishes the pass it is inside before stop() returns', async () => {
    // Незавершена відправка — той стан, у якому можна або загубити якір, або
    // поставити другий на те саме рішення. Зупинка не має його створювати.
    await seedPending()
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })

    const publisher = startPublisher({
      db,
      chain: fakeChain({
        sendRawTransaction: async () => {
          release()
          await settle(60)
          return 'sent'
        },
      }),
      config,
      logger: silent,
      tickMs: 5,
    })

    await held
    await publisher.stop()

    // Рядок уже не `pending`: прохід дорахував, а не обірвався на середині.
    expect(await statusOf()).toBe('anchored')
  })

  it('returns from stop() without waiting out the tick', async () => {
    // Сон між проходами переривний: інакше вимкнення впиралося б у таймер,
    // і Render убивав би процес посеред наступного проходу.
    const publisher = startPublisher({
      db,
      chain: fakeChain(),
      config,
      logger: silent,
      tickMs: 60_000,
    })

    await settle(20)
    const started = performance.now()
    await publisher.stop()

    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it('keeps going after a pass fails on the chain', async () => {
    // Хвилина недоступного RPC не має коштувати зупинки публікації назавжди.
    await seedPending()
    let calls = 0
    const publisher = startPublisher({
      db,
      chain: fakeChain({
        getLatestBlockhash: async () => {
          calls += 1
          if (calls === 1) throw new Error('rpc is away')
          return { blockhash: '11111111111111111111111111111111' }
        },
      }),
      config,
      logger: silent,
      tickMs: 5,
    })

    await settle(200)
    await publisher.stop()

    expect(calls).toBeGreaterThan(1)
    expect(await statusOf()).toBe('anchored')
  })

  it('does not touch the database after stop() returned', async () => {
    const publisher = startPublisher({ db, chain: fakeChain(), config, logger: silent, tickMs: 5 })
    await settle(30)
    await publisher.stop()

    // Рішення зʼявляється вже після зупинки — і має лишитись недоторканим.
    await seedPending()
    await settle(60)

    expect(await statusOf()).toBe('pending')
  })
})

describe('оточення читається одним місцем', () => {
  it('round-trips a generated key through base58', () => {
    const key = Keypair.generate()
    const read = publisherConfigFromEnv({
      PUBLISHER_SECRET_KEY: toBase58(key.secretKey),
      PUBLISHER_MAX_PRIORITY_LAMPORTS: '777',
    })

    expect(read.payer.publicKey.toBase58()).toBe(key.publicKey.toBase58())
    expect(read.maxPriorityLamports).toBe(777)
  })

  it('decodes what toBase58 encodes, leading zeros and all', () => {
    const bytes = Uint8Array.from([0, 0, 7, 255, 16])
    expect([...fromBase58(toBase58(bytes))]).toEqual([...bytes])
  })

  it('names the variable it is missing instead of starting half configured', () => {
    expect(() => requiredEnv({}, 'DATABASE_URL')).toThrow(/DATABASE_URL/)
    expect(() => requiredEnv({ DATABASE_URL: '' }, 'DATABASE_URL')).toThrow(/DATABASE_URL/)
    expect(() => chainFromEnv({})).toThrow(/SOLANA_RPC_URL/)
    expect(() => publisherConfigFromEnv({ PUBLISHER_SECRET_KEY: 'not base58 at all!' })).toThrow()
  })
})
