import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import type { ErrorBody } from '../errors.js'
import { generateIngestKey } from '../ingest-key.js'
import { silentLogger } from '../logger.js'
import { createProject } from '../projects.js'
import { agentRoutes } from './agents.js'

/**
 * Маршрут проганяється наскрізь: справжня міграція, справжня авторизація з T024,
 * справжній `INSERT`. Ідемпотентність — властивість **бази**, а не хендлера:
 * довести її на моці означало б перевірити власну заглушку.
 */
const migrationDir = fileURLToPath(new URL('../drizzle/', import.meta.resolve('@agenttrace/db')))
const migration = readdirSync(migrationDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(migrationDir + name, 'utf8'))
  .join('\n')

const PUBKEY_A = 'aa'.repeat(32)
const PUBKEY_B = 'bb'.repeat(32)

let client: PGlite
let db: ReturnType<typeof drizzle>
let app: ReturnType<typeof createApp>
let keyOfFirst: string
let keyOfSecond: string

beforeAll(async () => {
  client = await PGlite.create()
  await client.exec(migration)
  db = drizzle(client)

  app = createApp({ logger: silentLogger() })
  app.route('/v1', agentRoutes(db))
}, 60_000)

beforeEach(async () => {
  // Проєкти перестворюються на кожен тест: `agents` і `agent_keys` каскадом
  // ідуть за ними, тож тести не бачать чужих реєстрацій.
  await client.query('DELETE FROM projects')
  keyOfFirst = (await createProject(db, 'first')).ingestKey
  keyOfSecond = (await createProject(db, 'second')).ingestKey
})

const register = (ingestKey: string, body: unknown) =>
  app.request('/v1/agents', {
    method: 'POST',
    headers: { authorization: `Bearer ${ingestKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const agentBody = (overrides: Record<string, unknown> = {}) => ({
  externalId: 'trader-1',
  name: 'Trader',
  publicKey: PUBKEY_A,
  ...overrides,
})

const agentIdOf = async (response: Response) =>
  ((await response.json()) as { agentId: string }).agentId

const rows = async (sql: string) => (await client.query<Record<string, unknown>>(sql)).rows

describe('реєстрація агента', () => {
  it('creates the agent and the initial key it will sign with', async () => {
    const response = await register(keyOfFirst, agentBody())

    expect(response.status).toBe(200)
    expect(await agentIdOf(response)).toMatch(/^[0-9a-f-]{36}$/)

    const keys = await rows(
      'SELECT public_key, valid_from, valid_to, rotation_kind FROM agent_keys',
    )
    expect(keys).toEqual([
      { public_key: PUBKEY_A, valid_from: 0, valid_to: null, rotation_kind: 'initial' },
    ])
  })

  it('starts the initial key at zero, not at the moment of registration', async () => {
    // SDK тримає рішення на диску при обриві мережі (T022), тож перше рішення
    // цілком може бути старшим за реєстрацію. Ключ, «дійсний з тепер», лишив би
    // власне рішення агента поза вікном чинності єдиного ключа, який його підписав.
    await register(keyOfFirst, agentBody())

    const [key] = await rows('SELECT valid_from FROM agent_keys')
    expect(key?.valid_from).toBe(0)
  })

  it('refuses a body that is not the contract', async () => {
    const response = await register(keyOfFirst, agentBody({ publicKey: 'not-a-key' }))
    const json = (await response.json()) as ErrorBody

    // Формат помилки — наш, а не власний формат валідатора: SDK читає одну схему.
    expect(response.status).toBe(400)
    expect(json.error.code).toBe('INVALID_INPUT')
    expect(Array.isArray(json.error.details.issues)).toBe(true)
  })

  it('refuses a request that carries no ingest key', async () => {
    const response = await app.request('/v1/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(agentBody()),
    })

    expect(response.status).toBe(401)
    expect(await rows('SELECT id FROM agents')).toEqual([])
  })
})

describe('ідемпотентність за публічним ключем', () => {
  it('answers the same agent id to a repeated registration', async () => {
    const first = await register(keyOfFirst, agentBody())
    const second = await register(keyOfFirst, agentBody())

    expect(await agentIdOf(first)).toBe(await agentIdOf(second))
    expect(await rows('SELECT id FROM agents')).toHaveLength(1)
    expect(await rows('SELECT id FROM agent_keys')).toHaveLength(1)
  })

  it('holds when both registrations arrive at once', async () => {
    // SDK кличе реєстрацію перед кожним проходом відправки, і два процеси
    // зі спільним каталогом стану дають рівно цей збіг.
    const [first, second] = await Promise.all([
      register(keyOfFirst, agentBody()),
      register(keyOfFirst, agentBody()),
    ])

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(await agentIdOf(first)).toBe(await agentIdOf(second))
    expect(await rows('SELECT id FROM agents')).toHaveLength(1)
  })

  it('does not rename the agent behind an already registered key', async () => {
    // Повтор — не оновлення: інакше «ідемпотентно» означало б «щоразу пише».
    const first = await register(keyOfFirst, agentBody())
    const again = await register(keyOfFirst, agentBody({ name: 'Renamed' }))

    expect(await agentIdOf(again)).toBe(await agentIdOf(first))
    const [agent] = await rows('SELECT name FROM agents')
    expect(agent?.name).toBe('Trader')
  })
})

describe('реєстрація відхиляє те, що реєстрацією не є', () => {
  it('refuses a second key under an agent that already has one', async () => {
    // Заміна ключа — ротація (T044), і робити її мовчки на цьому ендпоінті
    // означало б загубити доказ тяглості, який вимагає FR-022.
    await register(keyOfFirst, agentBody())
    const response = await register(keyOfFirst, agentBody({ publicKey: PUBKEY_B }))

    expect(response.status).toBe(400)
    expect(await rows('SELECT id FROM agent_keys')).toHaveLength(1)
  })

  it('refuses the same key under a second agent of the same project', async () => {
    await register(keyOfFirst, agentBody())
    const response = await register(keyOfFirst, agentBody({ externalId: 'trader-2' }))

    expect(response.status).toBe(400)
    expect(await rows('SELECT id FROM agents')).toHaveLength(1)
  })
})

describe('ізоляція орендарів', () => {
  it('refuses a key that belongs to another project, telling it apart from nothing', async () => {
    await register(keyOfFirst, agentBody())
    const response = await register(keyOfSecond, agentBody())

    expect(response.status).toBe(400)
    expect(await rows('SELECT id FROM agents')).toHaveLength(1)
  })

  it('says the same thing whether the key is taken here or in a project one cannot see', async () => {
    // Різні формулювання перетворили б ендпоінт на оракул: «цей публічний ключ
    // уже зареєстрований десь у AgentTrace» — це відповідь про чужого орендаря.
    await register(keyOfFirst, agentBody())

    const mine = (await (
      await register(keyOfFirst, agentBody({ externalId: 'other' }))
    ).json()) as ErrorBody
    const theirs = (await (await register(keyOfSecond, agentBody())).json()) as ErrorBody

    expect(theirs.error.code).toBe(mine.error.code)
    expect(theirs.error.message).toBe(mine.error.message)
    expect(theirs.error.details).toEqual(mine.error.details)
  })

  it('keeps each project registering its own agent under its own key', async () => {
    const first = await register(keyOfFirst, agentBody())
    const second = await register(keyOfSecond, agentBody({ publicKey: PUBKEY_B }))

    expect(await agentIdOf(first)).not.toBe(await agentIdOf(second))
    expect(await rows('SELECT id FROM agents')).toHaveLength(2)
  })
})

describe('невідомий ingest-ключ', () => {
  it('registers nothing at all', async () => {
    const response = await register(generateIngestKey(), agentBody())

    expect(response.status).toBe(401)
    expect(await rows('SELECT id FROM agents')).toEqual([])
  })
})
