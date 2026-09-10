import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  type AgentKeyPair,
  generateAgentKey,
  hashValue,
  MANIFEST_VERSION,
  type Manifest,
  signManifest,
  stepsRoot,
  toHex,
} from '@agenttrace/manifest'
import {
  type PublicAgentKeysResponse,
  type PublicDecisionResponse,
  verificationStatusSchema,
} from '@agenttrace/shared'
import type { Caveat, KeyContinuity, VerificationStatus } from '@agenttrace/verify'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { asUuid } from '../decision-id.js'
import type { ErrorBody } from '../errors.js'
import { silentLogger } from '../logger.js'
import { createProject } from '../projects.js'
import { agentRoutes } from './agents.js'
import { decisionRoutes } from './decisions.js'
import { publicRoutes } from './public.js'

/**
 * Публічне читання перевіряється на справжній базі й справжньому підписі, бо
 * доводити тут треба не «хендлер повернув обʼєкт», а дві речі, які видно лише
 * наскрізь: що посилання відкривається **без ключа** (SC-009) і що вмісту
 * приватного кроку у відповіді немає **ніколи** (FR-020) — навіть тоді, коли
 * він якимось чином опинився у сховищі.
 */
const migrationDir = fileURLToPath(new URL('../drizzle/', import.meta.resolve('@agenttrace/db')))
const migration = readdirSync(migrationDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(migrationDir + name, 'utf8'))
  .join('\n')

const PUBLIC_APP_URL = 'https://trace.example'
const PRIVATE_CONTENT = 'client-position-size-4200'
const AGENT_NAME = 'Portfolio rebalancer'
const AGENT_EXTERNAL_ID = 'rebalancer-7'

let client: PGlite
let db: ReturnType<typeof drizzle>
let app: ReturnType<typeof createApp>
let ingestKey: string
let agentKey: AgentKeyPair
let rotatedKey: AgentKeyPair

beforeAll(async () => {
  client = await PGlite.create()
  await client.exec(migration)
  db = drizzle(client)

  app = createApp({ logger: silentLogger() })
  app.route('/v1', agentRoutes(db))
  app.route('/v1', decisionRoutes(db, { publicAppUrl: PUBLIC_APP_URL }))
  app.route('/v1', publicRoutes(db))

  agentKey = await generateAgentKey()
  rotatedKey = await generateAgentKey()
}, 60_000)

beforeEach(async () => {
  await client.query('DELETE FROM projects')
  ingestKey = (await createProject(db, 'demo')).ingestKey

  const registered = await app.request('/v1/agents', {
    method: 'POST',
    headers: { authorization: `Bearer ${ingestKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      externalId: AGENT_EXTERNAL_ID,
      name: AGENT_NAME,
      publicKey: agentKey.publicKey,
    }),
  })
  if (registered.status !== 200) throw new Error('fixture: agent registration failed')
})

const rows = (sql: string, params: unknown[] = []) =>
  client.query<Record<string, unknown>>(sql, params).then((result) => result.rows)

/**
 * Рішення з одним публічним і одним приватним кроком. Вміст приватного кроку в
 * API не їде взагалі — його хеш пораховано тут, як це робить SDK. Саме тому
 * `PRIVATE_CONTENT` не має зустрітися у публічній відповіді за жодних умов.
 */
async function honestManifest(overrides: Partial<Manifest> = {}): Promise<Manifest> {
  const input = { question: 'rebalance?' }
  const output = { answer: 'yes' }
  const privateInput = { holdings: PRIVATE_CONTENT }
  const privateOutput = { size: PRIVATE_CONTENT }

  const steps: Manifest['steps'] = [
    {
      type: 'source.read',
      private: false,
      input,
      output,
      inputHash: toHex(await hashValue(input)),
      outputHash: toHex(await hashValue(output)),
    },
    {
      type: 'portfolio.size',
      private: true,
      inputHash: toHex(await hashValue(privateInput)),
      outputHash: toHex(await hashValue(privateOutput)),
    },
  ]

  return {
    version: MANIFEST_VERSION,
    agentPubkey: agentKey.publicKey,
    decisionId: crypto.randomUUID().replaceAll('-', ''),
    model: 'claude-opus-5',
    sources: ['https://quotes.example/'],
    root: toHex(await stepsRoot(steps)),
    decidedAt: 1_760_000_000_000,
    outcome: { action: 'hold' },
    steps,
    ...overrides,
  }
}

/** Приймає рішення тим самим шляхом, яким його прийме продакшн, і віддає конверт. */
async function accepted(overrides: Partial<Manifest> = {}) {
  const envelope = await signManifest(await honestManifest(overrides), agentKey)
  const response = await app.request('/v1/decisions', {
    method: 'POST',
    headers: { authorization: `Bearer ${ingestKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  })
  if (response.status !== 200) throw new Error(`fixture: submit returned ${response.status}`)
  return envelope
}

/** Публічний запит — навмисно без жодного заголовка авторизації. */
const readDecision = (decisionId: string) => app.request(`/v1/public/decisions/${decisionId}`)
const readKeys = (publicKey: string) => app.request(`/v1/public/agents/${publicKey}/keys`)

const bodyOf = async <T>(response: Response) => (await response.json()) as T

const anchorRow = (decisionId: string, signature = 'sigFromDevnet') =>
  rows(
    `UPDATE decisions
        SET status = 'anchored', anchor_signature = $2, anchor_slot = 312, anchored_at = now()
      WHERE id = $1`,
    [asUuid(decisionId), signature],
  )

describe('читання рішення без жодного ключа (FR-011, FR-012, SC-009)', () => {
  it('hands the signed envelope to a caller who presents nothing at all', async () => {
    const envelope = await accepted()

    const response = await readDecision(envelope.manifest.decisionId)
    const body = await bodyOf<PublicDecisionResponse>(response)

    expect(response.status).toBe(200)
    // Той самий конверт, що підписали: рішення перевіряють, перерахувавши його
    // дайджест, тож будь-яка вільність тут зробила б чесний запис підробленим.
    expect(body.signedManifest).toEqual(envelope)
    expect(body.decisionId).toBe(envelope.manifest.decisionId)
  })

  it('is open while ingest right next to it stays closed', async () => {
    // Обидва напрямки цієї помилки коштують однаково дорого, і обидва — один
    // рядок. Спершу так і сталося: `router.use('*', ingestAuth(…))` у роутері
    // приймання накрив увесь `/v1/*`, і публічне посилання почало вимагати
    // ingest-ключ. Дзеркальна помилка — забрати авторизацію з приймання —
    // відкрила б запис усьому світу. Тест тримає обидва боки одночасно.
    const envelope = await accepted()

    const open = await readDecision(envelope.manifest.decisionId)
    const closed = await app.request('/v1/decisions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(await signManifest(await honestManifest(), agentKey)),
    })

    expect(open.status).toBe(200)
    expect(closed.status).toBe(401)
  })

  it('lets any origin read it, because a link only our domain can open is not public', async () => {
    const envelope = await accepted()

    const response = await app.request(`/v1/public/decisions/${envelope.manifest.decisionId}`, {
      headers: { origin: 'https://someone-else.example' },
    })

    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('does not put that permission on ingest, where the header carries a project key', async () => {
    const response = await app.request('/v1/decisions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ingestKey}`,
        'content-type': 'application/json',
        origin: 'https://someone-else.example',
      },
      body: JSON.stringify(await signManifest(await honestManifest(), agentKey)),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('says not found for an id nobody stored', async () => {
    const response = await readDecision('ab'.repeat(16))
    const json = await bodyOf<ErrorBody>(response)

    expect(response.status).toBe(404)
    expect(json.error.code).toBe('NOT_FOUND')
  })

  it('refuses an address that is not the form the chain uses, instead of failing on it', async () => {
    // Дефіси, верхній регістр, обрізана довжина і відверте сміття — чотири
    // способи, якими адреса приїжджає зіпсованою. Жоден не має доходити до бази:
    // колонка `uuid` відповіла б на них помилкою типу, тобто 500 замість відмови.
    const malformed = [crypto.randomUUID(), 'AB'.repeat(16), 'ab'.repeat(8), "'; DROP TABLE x; --"]

    for (const address of malformed) {
      const response = await readDecision(encodeURIComponent(address))
      expect(response.status).toBe(400)
    }

    // Таблиця на місці, і рішення в ній теж — остання адреса не була виконана.
    expect(await rows('SELECT 1 FROM decisions')).toEqual([])
  })
})

describe('приватні кроки лишаються хешем і типом (FR-020)', () => {
  it('publishes a private step as nothing but its type and its two hashes', async () => {
    const envelope = await accepted()

    const body = await bodyOf<PublicDecisionResponse>(
      await readDecision(envelope.manifest.decisionId),
    )
    const step = body.signedManifest?.manifest.steps[1]

    expect(step?.private).toBe(true)
    expect(Object.keys(step ?? {}).sort()).toEqual(['inputHash', 'outputHash', 'private', 'type'])
  })

  it('leaks nothing of the private content into the response text', async () => {
    const envelope = await accepted()

    const text = await (await readDecision(envelope.manifest.decisionId)).text()

    expect(text).not.toContain(PRIVATE_CONTENT)
    // Без цього тест доводив би лише те, що відповідь порожня.
    expect(text).toContain(envelope.signature)
  })

  it('serves no manifest at all when storage holds a private step with content in it', async () => {
    // Найтонший спосіб зламати FR-020 — не «забути вирізати поле», а покласти у
    // сховище крок, у якому воно є. Тому конверт віддається лише таким, яким його
    // пропустила строга схема формату: приватний крок у ній полів вмісту не має
    // взагалі, тож такий рядок публічним не стане ніколи.
    const envelope = await accepted()
    const [step] = envelope.manifest.steps
    if (step === undefined || step.private) throw new Error('fixture expects a public step first')

    await rows('UPDATE decisions SET steps = $2::jsonb WHERE id = $1', [
      asUuid(envelope.manifest.decisionId),
      JSON.stringify([
        step,
        {
          type: 'portfolio.size',
          private: true,
          input: { holdings: PRIVATE_CONTENT },
          output: { size: PRIVATE_CONTENT },
          inputHash: 'ab'.repeat(32),
          outputHash: 'cd'.repeat(32),
        },
      ]),
    ])

    const response = await readDecision(envelope.manifest.decisionId)
    const text = await response.text()
    const body = JSON.parse(text) as PublicDecisionResponse

    expect(text).not.toContain(PRIVATE_CONTENT)
    expect(body.signedManifest).toBeNull()
    expect(body.verification.status).toBe('tampered')
  })
})

describe('стан ніколи не сильніший, ніж він є (FR-013)', () => {
  it('calls an unanchored decision pending, not verified', async () => {
    const envelope = await accepted()

    const body = await bodyOf<PublicDecisionResponse>(
      await readDecision(envelope.manifest.decisionId),
    )

    expect(body.verification.status).toBe('pending')
    expect(body.verification.discrepancies).toEqual([])
    expect(body.anchor).toBeNull()
  })

  it('still refuses to say verified once the decision is anchored, and says why', async () => {
    // Тут і живе головна обіцянка цього маршруту: `verified` означає «ланцюг
    // підтверджує», а наш API ланцюга не читає. Зібрати байти якоря з власної
    // бази й видати це за підтвердження було б підтвердженням самих себе.
    const envelope = await accepted()
    await anchorRow(envelope.manifest.decisionId)

    const body = await bodyOf<PublicDecisionResponse>(
      await readDecision(envelope.manifest.decisionId),
    )

    expect(body.verification.status).toBe('pending')
    expect(body.verification.includesChain).toBe(false)
    // Натомість віддається адреса, за якою будь-хто перевірить це без нас.
    expect(body.anchor).toMatchObject({ transactionSignature: 'sigFromDevnet', slot: 312 })
  })

  it('reports storage that disagrees with the signature as tampered', async () => {
    // Наш API не довіряє власному сховищу більше, ніж чужий verifier: підмінений
    // рядок читається як tampered, а не мовчки віддається як рішення агента.
    const envelope = await accepted()

    await rows('UPDATE decisions SET outcome = $2::jsonb WHERE id = $1', [
      asUuid(envelope.manifest.decisionId),
      JSON.stringify({ action: 'sell everything' }),
    ])

    const body = await bodyOf<PublicDecisionResponse>(
      await readDecision(envelope.manifest.decisionId),
    )

    expect(body.verification.status).toBe('tampered')
    expect(body.verification.discrepancies.map((one) => one.code)).toContain('signature-invalid')
  })

  it('keeps the proof that a decision existed after its content was deleted (FR-024)', async () => {
    const envelope = await accepted()
    await anchorRow(envelope.manifest.decisionId)
    await rows('UPDATE decisions SET content_deleted_at = now() WHERE id = $1', [
      asUuid(envelope.manifest.decisionId),
    ])

    const response = await readDecision(envelope.manifest.decisionId)
    const body = await bodyOf<PublicDecisionResponse>(response)

    expect(body.verification.status).toBe('content-deleted')
    expect(body.signedManifest).toBeNull()
    expect(body.contentDeletedAt).not.toBeNull()
    // Запис існував — цього видалення не забирає (FR-024).
    expect(body.anchor).not.toBeNull()
    // І видалений вміст не має лишитися ще й у кеші браузера.
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('names the same states the independent verifier names', async () => {
    // Присвоєння в обидва боки — компіляторна частина звірки; перелік нижче
    // ловить те саме видимо, а не лише на typecheck. Потрібні обидва напрямки:
    // зайвий стан у `shared` бреше про можливості, зайвий у `verify` мовчки
    // випав би з публічної відповіді.
    const fromShared: readonly VerificationStatus[] = verificationStatusSchema.options
    const toShared: PublicDecisionResponse['verification']['status'][] = [] as VerificationStatus[]
    const toSharedCaveats: PublicDecisionResponse['verification']['caveats'] = [] as Caveat[]
    const toSharedContinuity: PublicDecisionResponse['verification']['keyContinuity'][] =
      [] as KeyContinuity[]

    expect(fromShared).toEqual([
      'verified',
      'pending',
      'tampered',
      'unavailable',
      'content-deleted',
    ])
    expect([toShared, toSharedCaveats, toSharedContinuity].every(Array.isArray)).toBe(true)
  })
})

describe('історія ключів агента (FR-022)', () => {
  it('gives the initial key with no predecessor and no proof', async () => {
    const response = await readKeys(agentKey.publicKey)
    const body = await bodyOf<PublicAgentKeysResponse>(response)

    expect(response.status).toBe(200)
    expect(body.keys).toEqual([
      {
        publicKey: agentKey.publicKey,
        validFrom: 0,
        validTo: null,
        rotationKind: 'initial',
        prevPublicKey: null,
        rotationProof: null,
      },
    ])
  })

  it('tells nothing about how the client names its own systems', async () => {
    const text = await (await readKeys(agentKey.publicKey)).text()

    expect(text).not.toContain(AGENT_NAME)
    expect(text).not.toContain(AGENT_EXTERNAL_ID)
  })

  it('answers to a replaced key too, because old decisions name no other address', async () => {
    const [initial] = await rows('SELECT id, agent_id FROM agent_keys')
    await rows(
      `INSERT INTO agent_keys (agent_id, public_key, valid_from, rotation_kind, prev_key_id, rotation_proof)
       VALUES ($1, $2, 1760000000000, 'chained', $3, $4)`,
      [initial?.agent_id, rotatedKey.publicKey, initial?.id, 'ab'.repeat(64)],
    )
    await rows('UPDATE agent_keys SET valid_to = 1760000000000 WHERE id = $1', [initial?.id])

    const body = await bodyOf<PublicAgentKeysResponse>(await readKeys(agentKey.publicKey))

    expect(body.keys.map((one) => one.publicKey)).toEqual([
      agentKey.publicKey,
      rotatedKey.publicKey,
    ])
    // Попередник названий ключем, а не нашим uuid: ланцюг має читатися без нас.
    expect(body.keys[1]).toMatchObject({
      rotationKind: 'chained',
      prevPublicKey: agentKey.publicKey,
    })
    expect(body.keys[0]?.validTo).toBe(1_760_000_000_000)
  })

  it('says not found for a key nobody registered', async () => {
    const response = await readKeys('ff'.repeat(32))

    expect(response.status).toBe(404)
  })
})
