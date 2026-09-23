import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { PublisherSnapshot } from '@agenttrace/publisher/run'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import {
  createHealthReporter,
  type HealthDeps,
  PUBLISHER_STALE_SECONDS,
  publisherCheck,
  QUEUE_DEGRADED_SECONDS,
  queueFacts,
} from './health.js'
import { silentLogger } from './logger.js'

/**
 * Факти черги питаються у **справжнього** Postgres із тією самою міграцією, що
 * поїде в Supabase: `count(*) FILTER`, `extract(epoch …)` і типи, у яких
 * драйвер віддає `bigint` рядком, — рівно те місце, де мок показав би зелене на
 * запиті, який у продакшені рахує інше.
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
const DECIDED_AT = 1_760_000_000_000

let client: PGlite
let db: ReturnType<typeof drizzle>

interface SeedRow {
  readonly id: string
  readonly status: 'pending' | 'anchored' | 'failed'
  /** Зсув `next_attempt_at` від «зараз», секунди. Відʼємний — рішення вже час брати. */
  readonly dueSeconds?: number
  readonly receivedSecondsAgo?: number
  readonly anchorSlot?: number
}

const seed = async (row: SeedRow) => {
  const anchored = row.status === 'anchored'
  await client.query(
    `INSERT INTO decisions (id, project_id, agent_id, agent_key_id, root, signature, decided_at,
                            model_ref, sources, steps, outcome, status, attempts, next_attempt_at,
                            received_at, anchor_signature, anchor_slot, anchored_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'claude-opus-5', $8::jsonb, $9::jsonb, $10::jsonb,
             $11, 0, now() + make_interval(secs => $12::float8),
             now() - make_interval(secs => $13::float8), $14, $15, $16)`,
    [
      row.id,
      PROJECT,
      AGENT,
      KEY,
      'ab'.repeat(32),
      'cd'.repeat(64),
      DECIDED_AT,
      JSON.stringify(['https://quotes.example/']),
      JSON.stringify([{ type: 'source.read', private: false }]),
      JSON.stringify({ action: 'swap' }),
      row.status,
      row.dueSeconds ?? -1,
      row.receivedSecondsAgo ?? 0,
      anchored ? 'z'.repeat(64) : null,
      anchored ? (row.anchorSlot ?? 500) : null,
      anchored ? new Date().toISOString() : null,
    ],
  )
}

beforeAll(async () => {
  client = await PGlite.create()
  await client.exec(migration)
  db = drizzle(client)

  await client.query(`INSERT INTO projects (id, name, ingest_key_hash) VALUES ($1, 'health', $2)`, [
    PROJECT,
    '11'.repeat(32),
  ])
  await client.query(
    `INSERT INTO agents (id, project_id, external_id, name) VALUES ($1, $2, 'a', 'agent')`,
    [AGENT, PROJECT],
  )
  await client.query(
    `INSERT INTO agent_keys (id, agent_id, public_key, valid_from, rotation_kind)
     VALUES ($1, $2, $3, $4, 'initial')`,
    [KEY, AGENT, 'ef'.repeat(32), DECIDED_AT],
  )
}, 60_000)

afterAll(async () => {
  await client?.close()
})

beforeEach(async () => {
  await client.exec('DELETE FROM decisions')
})

const snapshot = (overrides: Partial<PublisherSnapshot> = {}): PublisherSnapshot => ({
  running: true,
  passes: 12,
  lastPassEndedAt: Date.now(),
  lastOkAt: Date.now(),
  lastFailureAt: null,
  consecutiveFailures: 0,
  sleepMs: 2_000,
  ...overrides,
})

const deps = (overrides: Partial<HealthDeps> = {}): HealthDeps => ({
  db,
  chainTip: async () => 1_000,
  publisher: () => snapshot(),
  ttlMs: 0,
  ...overrides,
})

describe('факти черги рахуються на справжньому Postgres', () => {
  it('counts what waits, what is due and how old the oldest due one is', async () => {
    await seed({
      id: '44444444-4444-4444-8444-444444444441',
      status: 'pending',
      receivedSecondsAgo: 90,
    })
    await seed({
      id: '44444444-4444-4444-8444-444444444442',
      status: 'pending',
      dueSeconds: 300,
      receivedSecondsAgo: 600,
    })

    const facts = await queueFacts(db)

    expect(facts.pending).toBe(2)
    // Відкладене рішення в чергу не рахується: воно чекає свого відступу, а не нас.
    expect(facts.due).toBe(1)
    expect(facts.oldestDueSeconds).toBeGreaterThanOrEqual(89)
    expect(facts.oldestDueSeconds).toBeLessThan(120)
  })

  it('returns numbers, not the strings the driver hands back for bigint', async () => {
    await seed({ id: '44444444-4444-4444-8444-444444444443', status: 'anchored', anchorSlot: 987 })

    const facts = await queueFacts(db)

    expect(facts.lastAnchorSlot).toBe(987)
    expect(typeof facts.lastAnchorSlot).toBe('number')
    expect(typeof facts.pending).toBe('number')
  })

  it('says nothing is waiting on an empty table instead of returning null', async () => {
    const facts = await queueFacts(db)

    expect(facts).toMatchObject({ pending: 0, due: 0, failed: 0 })
    expect(facts.oldestDueSeconds).toBeNull()
    expect(facts.lastAnchorSlot).toBeNull()
  })
})

describe('звіт про готовність', () => {
  it('is green when the queue is empty and the publisher is passing', async () => {
    const report = await createHealthReporter(deps())()

    expect(report.status).toBe('ok')
    expect(report.checks.database.status).toBe('ok')
    expect(report.checks.chain).toMatchObject({ tipSlot: 1_000, status: 'ok' })
  })

  it('goes degraded when a decision has been due longer than the threshold', async () => {
    await seed({
      id: '44444444-4444-4444-8444-444444444444',
      status: 'pending',
      receivedSecondsAgo: QUEUE_DEGRADED_SECONDS + 30,
    })

    const report = await createHealthReporter(deps())()

    expect(report.status).toBe('degraded')
    expect(report.checks.queue.status).toBe('degraded')
  })

  it('surfaces failed decisions — nobody else ever looks at them', async () => {
    await seed({ id: '44444444-4444-4444-8444-444444444445', status: 'failed' })

    const report = await createHealthReporter(deps())()

    expect(report.checks.queue).toMatchObject({ status: 'degraded', failed: 1 })
  })

  it('reports how far the last anchor is behind the tip, in slots', async () => {
    await seed({ id: '44444444-4444-4444-8444-444444444446', status: 'anchored', anchorSlot: 940 })

    const report = await createHealthReporter(deps())()

    expect(report.checks.chain).toMatchObject({
      tipSlot: 1_000,
      lastAnchorSlot: 940,
      behindSlots: 60,
    })
  })

  it('claims nothing about the chain when this process has no rpc client', async () => {
    const report = await createHealthReporter(deps({ chainTip: null }))()

    expect(report.checks.chain).toMatchObject({
      status: 'unknown',
      tipSlot: null,
      reason: 'not-in-this-process',
    })
    // `unknown` — не «погано»: двопроцесний запуск інакше був би вічно жовтим.
    expect(report.status).toBe('ok')
  })

  it('degrades but does not fail when the chain endpoint is silent', async () => {
    const report = await createHealthReporter(
      deps({ chainTip: async () => Promise.reject(new Error('429 Too Many Requests')) }),
    )()

    expect(report.checks.chain.reason).toBe('unreachable')
    // Перезапуск процесу не лікує чужий RPC, тож це не привід віддавати 503.
    expect(report.status).toBe('ok')
  })
})

describe('база, якої немає', () => {
  const broken = (): HealthDeps => ({
    ...deps(),
    db: {
      select: () => ({
        from: () => Promise.reject(new Error('password authentication failed for user "postgres"')),
      }),
    } as unknown as HealthDeps['db'],
  })

  it('fails the whole report instead of reporting ok for itself', async () => {
    const report = await createHealthReporter(broken())()

    expect(report.status).toBe('fail')
    expect(report.checks.database).toMatchObject({ status: 'fail', reason: 'unreachable' })
    expect(report.checks.queue.status).toBe('unknown')
  })

  it('answers 503 so the host refuses the deploy — the case that actually happened', async () => {
    const app = createApp({ logger: silentLogger(), health: createHealthReporter(broken()) })

    const response = await app.request('/health')

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ status: 'fail', service: 'api' })
  })

  it('leaks neither the driver message nor the credentials it carried', async () => {
    const app = createApp({ logger: silentLogger(), health: createHealthReporter(broken()) })

    const serialised = JSON.stringify(await (await app.request('/health')).json())

    expect(serialised).not.toContain('password')
    expect(serialised).not.toContain('postgres')
  })
})

describe('стан publisher’а', () => {
  const now = 1_800_000_000_000

  it('is degraded while passes keep failing, so the backoff is visible', () => {
    const check = publisherCheck(snapshot({ consecutiveFailures: 4, sleepMs: 32_000 }), now)

    expect(check).toMatchObject({ status: 'degraded', consecutiveFailures: 4, sleepSeconds: 32 })
  })

  it('notices a pass that never came back, which no failure counter would show', () => {
    const wedged = snapshot({
      lastPassEndedAt: now - (PUBLISHER_STALE_SECONDS + 60) * 1000,
      consecutiveFailures: 0,
    })

    expect(publisherCheck(wedged, now).status).toBe('degraded')
  })

  it('fails once the loop has stopped: pending decisions are then nobody’s', () => {
    expect(publisherCheck(snapshot({ running: false }), now).status).toBe('fail')
  })

  it('says external rather than ok when the publisher is another process', () => {
    expect(publisherCheck(null, now)).toMatchObject({
      status: 'unknown',
      mode: 'external',
      reason: 'not-in-this-process',
    })
  })

  it('never carries an error text out of the process', () => {
    // Знімок не має поля з повідомленням — і це перевіряється, а не мається на
    // увазі: `/health` публічний, а помилки драйвера несуть рядок підключення.
    expect(Object.keys(publisherCheck(snapshot(), now))).not.toContain('error')
  })
})

describe('кеш перевірок', () => {
  it('hits the database once for a burst of requests', async () => {
    let queries = 0
    const counting = deps({
      ttlMs: 10_000,
      publisher: () => {
        queries += 1
        return snapshot()
      },
    })
    const reporter = createHealthReporter(counting)

    await Promise.all([reporter(), reporter(), reporter()])
    await reporter()

    expect(queries).toBe(1)
  })

  it('says how stale the answer it just handed back is', async () => {
    let clock = 1_000_000
    const reporter = createHealthReporter(deps({ ttlMs: 10_000, now: () => clock }))

    await reporter()
    clock += 4_000

    expect((await reporter()).ageSeconds).toBe(4)
  })

  it('re-reads once the window is over', async () => {
    let clock = 1_000_000
    let tips = 0
    const reporter = createHealthReporter(
      deps({
        ttlMs: 10_000,
        now: () => clock,
        chainTip: async () => {
          tips += 1
          return 1_000
        },
      }),
    )

    await reporter()
    clock += 11_000
    await reporter()

    expect(tips).toBe(2)
  })
})
