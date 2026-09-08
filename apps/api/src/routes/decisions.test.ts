import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  type AgentKeyPair,
  generateAgentKey,
  hashValue,
  MANIFEST_VERSION,
  type Manifest,
  type SignedManifest,
  signManifest,
  stepsRoot,
  toHex,
} from '@agenttrace/manifest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { pino } from 'pino'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import type { ErrorBody } from '../errors.js'
import { silentLogger } from '../logger.js'
import { createProject } from '../projects.js'
import { agentRoutes } from './agents.js'
import { decisionRoutes } from './decisions.js'

/**
 * Приймання рішень проганяється на справжній базі й справжньому підписі: тут
 * перевіряється не «хендлер викликав функцію», а те, що в базу не потрапляє
 * запис, який verifier згодом назве підробленим.
 */
const migrationDir = fileURLToPath(new URL('../drizzle/', import.meta.resolve('@agenttrace/db')))
const migration = readdirSync(migrationDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(migrationDir + name, 'utf8'))
  .join('\n')

const PUBLIC_APP_URL = 'https://trace.example'
const SECRET_IN_CONTENT = 'salmon-tuesday-9134'

let client: PGlite
let db: ReturnType<typeof drizzle>
let app: ReturnType<typeof createApp>
let keyOfFirst: string
let keyOfSecond: string
let agentKey: AgentKeyPair
let strangerKey: AgentKeyPair

beforeAll(async () => {
  client = await PGlite.create()
  await client.exec(migration)
  db = drizzle(client)

  app = createApp({ logger: silentLogger() })
  app.route('/v1', agentRoutes(db))
  app.route('/v1', decisionRoutes(db, { publicAppUrl: PUBLIC_APP_URL }))

  agentKey = await generateAgentKey()
  strangerKey = await generateAgentKey()
}, 60_000)

beforeEach(async () => {
  await client.query('DELETE FROM projects')
  keyOfFirst = (await createProject(db, 'first')).ingestKey
  keyOfSecond = (await createProject(db, 'second')).ingestKey
  await registerAgent(keyOfFirst, agentKey)
})

function registerAgent(ingestKey: string, key: AgentKeyPair) {
  return app.request('/v1/agents', {
    method: 'POST',
    headers: { authorization: `Bearer ${ingestKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ externalId: 'trader-1', name: 'Trader', publicKey: key.publicKey }),
  })
}

const submit = (ingestKey: string, body: unknown) =>
  app.request('/v1/decisions', {
    method: 'POST',
    headers: { authorization: `Bearer ${ingestKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** Чесний манифест: хеші кроків і корінь пораховані з того самого вмісту. */
async function honestManifest(key: AgentKeyPair, overrides: Partial<Manifest> = {}) {
  const input = { question: `where is ${SECRET_IN_CONTENT}` }
  const output = { answer: 'north' }
  const steps: Manifest['steps'] = [
    {
      type: 'source.read',
      private: false,
      input,
      output,
      inputHash: toHex(await hashValue(input)),
      outputHash: toHex(await hashValue(output)),
    },
  ]

  const manifest: Manifest = {
    version: MANIFEST_VERSION,
    agentPubkey: key.publicKey,
    decisionId: crypto.randomUUID().replaceAll('-', ''),
    model: 'claude-opus-5',
    sources: ['https://quotes.example/'],
    root: toHex(await stepsRoot(steps)),
    decidedAt: 1_760_000_000_000,
    outcome: { action: 'hold' },
    steps,
    ...overrides,
  }

  return manifest
}

const sign = (manifest: Manifest, key: AgentKeyPair) => signManifest(manifest, key)

const honestEnvelope = async (key: AgentKeyPair = agentKey) => sign(await honestManifest(key), key)

const rows = async (sql: string) => (await client.query<Record<string, unknown>>(sql)).rows
const storedDecisions = () => rows('SELECT id, root, signature, status FROM decisions')

const bodyOf = async <T>(response: Response) => (await response.json()) as T

describe('приймання чесного рішення', () => {
  it('stores it as pending and hands back a public link', async () => {
    const envelope = await honestEnvelope()
    const response = await submit(keyOfFirst, envelope)

    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toEqual({
      status: 'pending',
      publicUrl: `${PUBLIC_APP_URL}/decisions/${envelope.manifest.decisionId}`,
    })
    expect(await storedDecisions()).toHaveLength(1)
  })

  it('links the row to the key that signed it, not merely to the agent', async () => {
    // Без цього після ротації неможливо сказати, чим перевіряти старе рішення.
    await submit(keyOfFirst, await honestEnvelope())

    const [row] = await rows(
      `SELECT k.public_key FROM decisions d JOIN agent_keys k ON k.id = d.agent_key_id`,
    )
    expect(row?.public_key).toBe(agentKey.publicKey)
  })

  it('keeps the signature and root exactly as they were signed', async () => {
    const envelope = await honestEnvelope()
    await submit(keyOfFirst, envelope)

    const [row] = await storedDecisions()
    expect(row?.root).toBe(envelope.manifest.root)
    expect(row?.signature).toBe(envelope.signature)
  })

  it('addresses the decision the way the chain does — no dashes', async () => {
    // У якорі лежать 16 байтів, тобто 32 hex. Хто читає ланцюг, копіює саме це.
    const envelope = await honestEnvelope()
    const { publicUrl } = await bodyOf<{ publicUrl: string }>(await submit(keyOfFirst, envelope))

    expect(publicUrl).toMatch(/\/decisions\/[0-9a-f]{32}$/)
  })
})

describe('рішення без валідного підпису не зберігається взагалі', () => {
  it('refuses a manifest changed after it was signed', async () => {
    const envelope = await honestEnvelope()
    const tampered: SignedManifest = {
      ...envelope,
      manifest: { ...envelope.manifest, model: 'someone-elses-model' },
    }

    const response = await submit(keyOfFirst, tampered)

    expect(response.status).toBe(400)
    expect(await storedDecisions()).toEqual([])
  })

  it('refuses a manifest signed by a key that is not the one it names', async () => {
    const manifest = await honestManifest(agentKey)
    const envelope = await sign({ ...manifest, agentPubkey: strangerKey.publicKey }, strangerKey)

    const response = await submit(keyOfFirst, envelope)

    expect(response.status).toBe(400)
    expect(await storedDecisions()).toEqual([])
  })

  it('refuses a step whose content does not hash to the hash it carries', async () => {
    // Найдешевша підробка: вміст підмінили, хеш лишили. Підпис при цьому цілий,
    // бо покриває корінь, а корінь порахований зі старих хешів. Пропустити це
    // означало б своїми руками покласти в базу вічний «tampered».
    const manifest = await honestManifest(agentKey)
    const [step] = manifest.steps
    if (step === undefined || step.private) throw new Error('fixture expects a public step')

    const envelope = await sign(
      { ...manifest, steps: [{ ...step, input: { question: 'a different question' } }] },
      agentKey,
    )

    const response = await submit(keyOfFirst, envelope)

    expect(response.status).toBe(400)
    expect(await storedDecisions()).toEqual([])
  })

  it('refuses a root that the steps do not add up to', async () => {
    const manifest = await honestManifest(agentKey)
    const envelope = await sign({ ...manifest, root: 'ff'.repeat(32) }, agentKey)

    const response = await submit(keyOfFirst, envelope)

    expect(response.status).toBe(400)
    expect(await storedDecisions()).toEqual([])
  })

  it('says what disagreed, so the sender can tell a bug from a rejection', async () => {
    const manifest = await honestManifest(agentKey)
    const envelope = await sign({ ...manifest, root: 'ff'.repeat(32) }, agentKey)

    const json = await bodyOf<ErrorBody>(await submit(keyOfFirst, envelope))

    expect(json.error.code).toBe('INVALID_INPUT')
    expect(json.error.details.discrepancies).toContain('steps-root-mismatch')
  })

  it('refuses a body that is not the contract at all', async () => {
    const json = await bodyOf<ErrorBody>(await submit(keyOfFirst, { manifest: {}, signature: 'x' }))

    expect(json.error.code).toBe('INVALID_INPUT')
    expect(Array.isArray(json.error.details.issues)).toBe(true)
  })
})

describe('рішення чужого агента', () => {
  it('refuses a decision signed by a key no project registered', async () => {
    const response = await submit(keyOfFirst, await honestEnvelope(strangerKey))

    expect(response.status).toBe(400)
    expect(await storedDecisions()).toEqual([])
  })

  it('refuses a decision whose key belongs to another project', async () => {
    const response = await submit(keyOfSecond, await honestEnvelope(agentKey))

    expect(response.status).toBe(400)
    expect(await storedDecisions()).toEqual([])
  })

  it('refuses without an ingest key and stores nothing', async () => {
    const response = await app.request('/v1/decisions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(await honestEnvelope()),
    })

    expect(response.status).toBe(401)
    expect(await storedDecisions()).toEqual([])
  })
})

describe('ідемпотентність за decisionId', () => {
  it('takes the same envelope twice and keeps one row', async () => {
    const envelope = await honestEnvelope()

    const first = await submit(keyOfFirst, envelope)
    const second = await submit(keyOfFirst, envelope)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(await bodyOf(second)).toEqual(await bodyOf(first))
    expect(await storedDecisions()).toHaveLength(1)
  })

  it('refuses a different decision wearing an id that is already taken', async () => {
    // Повтор і підміна виглядають однаково доти, доки не звірити вміст. Мовчазне
    // «ок» на другий манифест означало б, що посилання показує не те рішення,
    // за яке відзвітували.
    const first = await honestEnvelope()
    // Інший результат рішення під тим самим ідентифікатором — саме те, чого
    // повтор ніколи не робить, а підміна робить завжди.
    const other = await honestManifest(agentKey, { outcome: { action: 'sell' } })
    const collided = await sign({ ...other, decisionId: first.manifest.decisionId }, agentKey)

    await submit(keyOfFirst, first)
    const response = await submit(keyOfFirst, collided)

    expect(response.status).toBe(400)
    expect(await storedDecisions()).toHaveLength(1)
  })
})

describe('вміст рішення не тече в лог (FR-006)', () => {
  it('logs the request without a trace of what the decision contained', async () => {
    const written: string[] = []
    const capturing = pino({ level: 'debug' }, { write: (line: string) => void written.push(line) })
    const loud = createApp({ logger: capturing })
    loud.route('/v1', agentRoutes(db))
    loud.route('/v1', decisionRoutes(db, { publicAppUrl: PUBLIC_APP_URL }))

    const response = await loud.request('/v1/decisions', {
      method: 'POST',
      headers: { authorization: `Bearer ${keyOfFirst}`, 'content-type': 'application/json' },
      body: JSON.stringify(await honestEnvelope()),
    })

    // Без цього тест доводив би лише те, що нічого не сталося.
    expect(response.status).toBe(200)

    const log = written.join('')
    expect(log).not.toContain(SECRET_IN_CONTENT)
    expect(log).not.toContain(keyOfFirst)
    expect(log.length).toBeGreaterThan(0)
  })
})
