import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type AgentKeyPair, generateAgentKey, signKeyRotation } from '@agenttrace/manifest'
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

describe('ключ, яким підписати неможливо', () => {
  // `dd…dd` і `02…02` — хекс правильної довжини, який точкою ed25519 не є.
  // Схема їх пропускає (алфавіт і довжина в порядку), тож без перевірки на
  // кривій вони дійшли б до бази, а впали б аж у publisher'і.
  const OFF_CURVE = ['dd'.repeat(32), '02'.repeat(32)]

  it.each(OFF_CURVE)('refuses %s, which is not a point on the curve', async (publicKey) => {
    const response = await register(keyOfFirst, agentBody({ publicKey }))
    const json = (await response.json()) as ErrorBody

    expect(response.status).toBe(400)
    expect(json.error.code).toBe('INVALID_INPUT')
    expect(await rows('SELECT id FROM agents')).toEqual([])
    expect(await rows('SELECT id FROM agent_keys')).toEqual([])
  })

  it('keeps taking the keys an SDK actually generates', async () => {
    // Сторож проти перевірки, яка відхиляє все: ключ від `crypto.subtle`
    // проходить, і саме такі ключі шле SDK.
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
    const publicKey = [...raw].map((byte) => byte.toString(16).padStart(2, '0')).join('')

    expect((await register(keyOfFirst, agentBody({ publicKey }))).status).toBe(200)
  })
})

describe('планова ротація', () => {
  let previous: AgentKeyPair
  let next: AgentKeyPair
  let agentId: string
  const EFFECTIVE_AT = 1_760_000_000_000

  beforeEach(async () => {
    previous = await generateAgentKey()
    next = await generateAgentKey()
    agentId = await agentIdOf(
      await register(keyOfFirst, agentBody({ publicKey: previous.publicKey })),
    )
  })

  const rotate = (ingestKey: string, id: string, body: unknown) =>
    app.request(`/v1/agents/${id}/rotate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ingestKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  const rotationBody = async (
    from: AgentKeyPair,
    to: AgentKeyPair,
    effectiveAt = EFFECTIVE_AT,
  ) => ({
    newPublicKey: to.publicKey,
    effectiveAt,
    proof: await signKeyRotation(
      { newPubkey: to.publicKey, prevPubkey: from.publicKey, effectiveAt },
      from,
    ),
  })

  const keyRows = () =>
    rows(
      `SELECT id, public_key, valid_from, valid_to, rotation_kind, prev_key_id, rotation_proof
         FROM agent_keys ORDER BY valid_from`,
    )

  const expectRefused = async (response: Response) => {
    expect(response.status).toBe(400)
    expect(((await response.json()) as ErrorBody).error.code).toBe('INVALID_INPUT')
    expect(await keyRows()).toHaveLength(1)
  }

  it('closes the current key at effectiveAt and opens the new one, chained to it', async () => {
    const body = await rotationBody(previous, next)
    const response = await rotate(keyOfFirst, agentId, body)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      agentId,
      publicKey: next.publicKey,
      effectiveAt: EFFECTIVE_AT,
    })

    const [old, fresh] = await keyRows()
    expect(old).toMatchObject({ public_key: previous.publicKey, valid_to: EFFECTIVE_AT })
    expect(fresh).toMatchObject({
      public_key: next.publicKey,
      valid_from: EFFECTIVE_AT,
      valid_to: null,
      rotation_kind: 'chained',
      prev_key_id: old?.id,
      rotation_proof: body.proof,
    })
  })

  it('chains the next rotation from the new key, and no longer takes the old one', async () => {
    await rotate(keyOfFirst, agentId, await rotationBody(previous, next))
    const third = await generateAgentKey()
    const later = EFFECTIVE_AT + 10

    const fromOld = await rotate(keyOfFirst, agentId, await rotationBody(previous, third, later))
    expect(fromOld.status).toBe(400)

    const fromNew = await rotate(keyOfFirst, agentId, await rotationBody(next, third, later))
    expect(fromNew.status).toBe(200)
    expect((await keyRows()).map((key) => key.public_key)).toEqual([
      previous.publicKey,
      next.publicKey,
      third.publicKey,
    ])
  })

  it('answers a repeated rotation the same way and writes nothing twice', async () => {
    // The SDK retries after a dropped connection without knowing whether the
    // first attempt landed, and by then the key it would rotate from is closed.
    const body = await rotationBody(previous, next)
    const first = await rotate(keyOfFirst, agentId, body)
    const again = await rotate(keyOfFirst, agentId, body)

    expect(again.status).toBe(200)
    expect(await again.json()).toEqual(await first.json())
    expect(await keyRows()).toHaveLength(2)
  })

  it('lets exactly one of two concurrent rotations from the same key through', async () => {
    const other = await generateAgentKey()
    const [a, b] = await Promise.all([
      rotate(keyOfFirst, agentId, await rotationBody(previous, next)),
      rotate(keyOfFirst, agentId, await rotationBody(previous, other)),
    ])

    expect([a.status, b.status].sort()).toEqual([200, 400])
    expect(await keyRows()).toHaveLength(2)
  })

  it('refuses a proof that the current key did not make', async () => {
    const selfSigned = {
      newPublicKey: next.publicKey,
      effectiveAt: EFFECTIVE_AT,
      proof: (await rotationBody(next, await generateAgentKey())).proof,
    }

    await expectRefused(await rotate(keyOfFirst, agentId, selfSigned))
  })

  it('refuses an effectiveAt other than the one the proof signs', async () => {
    const body = await rotationBody(previous, next)

    await expectRefused(
      await rotate(keyOfFirst, agentId, { ...body, effectiveAt: EFFECTIVE_AT - 1 }),
    )
  })

  it('refuses an effectiveAt in the future', async () => {
    // The real clock, an hour ahead: far past any skew allowance, so the
    // outcome does not depend on how fast the test runs.
    const body = await rotationBody(previous, next, Date.now() + 60 * 60 * 1000)

    await expectRefused(await rotate(keyOfFirst, agentId, body))
  })

  it('takes an effectiveAt from just now', async () => {
    const body = await rotationBody(previous, next, Date.now())

    expect((await rotate(keyOfFirst, agentId, body)).status).toBe(200)
  })

  it('refuses an effectiveAt that does not come after the current key started', async () => {
    await rotate(keyOfFirst, agentId, await rotationBody(previous, next))
    const third = await generateAgentKey()

    const response = await rotate(keyOfFirst, agentId, await rotationBody(next, third))
    expect(response.status).toBe(400)
    expect(await keyRows()).toHaveLength(2)
  })

  it('refuses an effectiveAt that would cut off a decision the current key signed', async () => {
    const [key] = await keyRows()
    const [agent] = await rows('SELECT project_id FROM agents')
    await client.query(
      `INSERT INTO decisions (id, project_id, agent_id, agent_key_id, root, signature, decided_at,
                              model_ref, sources, steps, outcome)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'claude-opus-5', '[]', '[]', 'null')`,
      [
        '44444444-4444-4444-8444-444444444444',
        agent?.project_id,
        agentId,
        key?.id,
        '11'.repeat(32),
        'cd'.repeat(64),
        EFFECTIVE_AT,
      ],
    )

    await expectRefused(await rotate(keyOfFirst, agentId, await rotationBody(previous, next)))
    const justAfter = await rotationBody(previous, next, EFFECTIVE_AT + 1)
    expect((await rotate(keyOfFirst, agentId, justAfter)).status).toBe(200)
  })

  it('refuses a new key that is not a point on the curve', async () => {
    const body = await rotationBody(previous, next)

    await expectRefused(
      await rotate(keyOfFirst, agentId, { ...body, newPublicKey: 'dd'.repeat(32) }),
    )
  })

  it('refuses a new key held by another tenant, in the words registration uses', async () => {
    expect((await register(keyOfSecond, agentBody({ publicKey: next.publicKey }))).status).toBe(200)
    const elsewhere = (await (
      await register(keyOfFirst, agentBody({ externalId: 'other', publicKey: next.publicKey }))
    ).json()) as ErrorBody

    const response = await rotate(keyOfFirst, agentId, await rotationBody(previous, next))
    const json = (await response.json()) as ErrorBody

    expect(response.status).toBe(400)
    expect(json.error.message).toBe(elsewhere.error.message)
    expect(await rows(`SELECT id FROM agent_keys WHERE valid_to IS NOT NULL`)).toEqual([])
  })

  it('refuses a body that is not the contract', async () => {
    const body = await rotationBody(previous, next)

    await expectRefused(await rotate(keyOfFirst, agentId, { ...body, extra: true }))
  })

  it('answers not found for an agent of another project, as for one that does not exist', async () => {
    const theirs = await rotate(keyOfSecond, agentId, await rotationBody(previous, next))
    const nobody = await rotate(
      keyOfFirst,
      '55555555-5555-4555-8555-555555555555',
      await rotationBody(previous, next),
    )

    expect(theirs.status).toBe(404)
    expect(nobody.status).toBe(404)
    expect(await theirs.json()).toEqual(await nobody.json())
    expect(await keyRows()).toHaveLength(1)
  })

  it('refuses a request that carries no ingest key', async () => {
    const response = await app.request(`/v1/agents/${agentId}/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(await rotationBody(previous, next)),
    })

    expect(response.status).toBe(401)
    expect(await keyRows()).toHaveLength(1)
  })
})
