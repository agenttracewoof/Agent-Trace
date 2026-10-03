import { randomBytes, randomUUID } from 'node:crypto'
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
import {
  createProjectResponseSchema,
  decisionDetailsResponseSchema,
  type JournalResponse,
  journalResponseSchema,
  publicDecisionResponseSchema,
} from '@agenttrace/shared'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { authRoutes, createAuth, sessionUserOf } from '../auth.js'
import { createSendCodeGuard, DEFAULT_SEND_CODE_LIMITS } from '../auth-limits.js'
import { asDecisionId, asUuid } from '../decision-id.js'
import { silentLogger } from '../logger.js'
import { agentRoutes } from './agents.js'
import { decisionRoutes } from './decisions.js'
import { projectRoutes } from './projects.js'
import { publicRoutes } from './public.js'

/**
 * The journal against the real migration and a real sign-in, mounted the way
 * `index.ts` mounts it — through `projectRoutes`, whose guards it relies on.
 * Rows go in by SQL: the journal reads rows and checks no signature, and what
 * is under test is which rows come back, in what order, to whom.
 */
const migrationDir = fileURLToPath(new URL('../drizzle/', import.meta.resolve('@agenttrace/db')))
const migration = readdirSync(migrationDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(migrationDir + name, 'utf8'))
  .join('\n')

const API = 'https://api.agenttrace.example'
const WEB = 'https://agenttracewoof.example'
const SECRET = 'test-secret-that-is-long-enough-for-better-auth'

let client: PGlite
let app: ReturnType<typeof createApp>
const outbox: { to: string; code: string }[] = []

beforeAll(async () => {
  client = await PGlite.create()
  await client.exec(migration)
  const db = drizzle(client)

  const auth = createAuth(db, {
    secret: SECRET,
    baseUrl: API,
    webOrigin: WEB,
    sendCode: async (to, code) => {
      outbox.push({ to, code })
    },
  })
  app = createApp({ logger: silentLogger() })
  app.route(
    '/v1',
    authRoutes(auth, {
      webOrigin: WEB,
      guard: createSendCodeGuard({
        ...DEFAULT_SEND_CODE_LIMITS,
        addressBurst: 1_000,
        emailCooldownMs: 0,
        perDay: 1_000,
      }),
    }),
  )
  app.route('/v1', projectRoutes(db, { webOrigin: WEB, sessionUser: sessionUserOf(auth) }))
  // Ingest and the public read beside them, as in `index.ts`: details are checked
  // on decisions that came in signed, and against what the public read says.
  app.route('/v1', agentRoutes(db))
  app.route('/v1', decisionRoutes(db, { publicAppUrl: 'https://trace.example' }))
  app.route('/v1', publicRoutes(db))
}, 60_000)

afterAll(async () => {
  await client?.close()
})

const call = (
  method: 'GET' | 'POST' | 'OPTIONS',
  path: string,
  options: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
) =>
  app.request(`${API}/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      origin: WEB,
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })

async function signIn(email: string): Promise<string> {
  await call('POST', '/auth/email-otp/send-verification-otp', { body: { email, type: 'sign-in' } })
  const code = outbox.at(-1)?.code
  const signedIn = await call('POST', '/auth/sign-in/email-otp', { body: { email, otp: code } })
  expect(signedIn.status).toBe(200)
  return (
    signedIn.headers
      .getSetCookie()
      .find((value) => value.includes('session_token='))
      ?.split(';')[0] ?? ''
  )
}

async function createProjectWithKey(cookie: string, name: string) {
  const response = await call('POST', '/projects', { cookie, body: { name } })
  expect(response.status).toBe(201)
  const created = createProjectResponseSchema.parse(await response.json())
  return { projectId: created.project.id, ingestKey: created.ingestKey }
}

const createProject = async (cookie: string, name: string): Promise<string> =>
  (await createProjectWithKey(cookie, name)).projectId

const hex = (bytes: number) => randomBytes(bytes).toString('hex')

async function addAgent(projectId: string, externalId: string) {
  const agent = await client.query<{ id: string }>(
    'INSERT INTO agents (project_id, external_id, name) VALUES ($1, $2, $3) RETURNING id',
    [projectId, externalId, `Agent ${externalId}`],
  )
  const agentId = agent.rows[0]?.id ?? ''
  const key = await client.query<{ id: string }>(
    `INSERT INTO agent_keys (agent_id, public_key, valid_from, rotation_kind)
     VALUES ($1, $2, 0, 'initial') RETURNING id`,
    [agentId, hex(32)],
  )
  return { agentId, keyId: key.rows[0]?.id ?? '' }
}

type Agent = Awaited<ReturnType<typeof addAgent>>

async function addDecision(
  projectId: string,
  agent: Agent,
  decidedAt: number,
  status: 'pending' | 'anchored' | 'failed' = 'pending',
): Promise<string> {
  const id = randomUUID()
  const anchored = status === 'anchored'
  await client.query(
    `INSERT INTO decisions (id, project_id, agent_id, agent_key_id, root, signature, decided_at,
       model_ref, sources, steps, outcome, status, anchor_signature, anchor_slot, anchored_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'gpt-test', '[]', '[]', '{}', $8, $9, $10, $11)`,
    [
      id,
      projectId,
      agent.agentId,
      agent.keyId,
      hex(32),
      hex(64),
      decidedAt,
      status,
      anchored ? 'tx'.padEnd(88, '1') : null,
      anchored ? 1_000 : null,
      anchored ? new Date(decidedAt + 3_000) : null,
    ],
  )
  return asDecisionId(id)
}

const journal = async (cookie: string, projectId: string, query = '') => {
  const response = await call('GET', `/projects/${projectId}/decisions${query}`, { cookie })
  return { response, body: (await response.json()) as unknown }
}

const page = async (cookie: string, projectId: string, query = ''): Promise<JournalResponse> => {
  const { response, body } = await journal(cookie, projectId, query)
  expect(response.status).toBe(200)
  return journalResponseSchema.parse(body)
}

/** Every page, following `nextCursor` until it runs out. */
async function allPages(cookie: string, projectId: string, query: string): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | null = null
  for (let pages = 0; pages < 100; pages += 1) {
    const separator = query === '' ? '?' : '&'
    const next = cursor === null ? '' : `${separator}cursor=${encodeURIComponent(cursor)}`
    const body = await page(cookie, projectId, `${query}${next}`)
    ids.push(...body.decisions.map((one) => one.decisionId))
    cursor = body.nextCursor
    if (cursor === null) return ids
  }
  throw new Error('the journal never ran out of pages')
}

const T0 = Date.UTC(2026, 9, 1)

describe('GET /v1/projects/:projectId/decisions — the journal (T039, FR-016)', () => {
  let cookie: string
  let projectId: string
  let alpha: Agent
  let beta: Agent

  beforeEach(async () => {
    await client.query('DELETE FROM projects')
    cookie = await signIn(`journal-${randomUUID()}@example.com`)
    projectId = await createProject(cookie, 'Journal')
    alpha = await addAgent(projectId, 'alpha')
    beta = await addAgent(projectId, 'beta')
  })

  it('lists newest first, with the agent, both times and the anchoring state', async () => {
    const older = await addDecision(projectId, alpha, T0, 'anchored')
    const newer = await addDecision(projectId, beta, T0 + 60_000)

    const body = await page(cookie, projectId)

    expect(body.decisions.map((one) => one.decisionId)).toEqual([newer, older])
    expect(body.nextCursor).toBeNull()
    const [first, second] = body.decisions
    expect(first).toMatchObject({
      agent: { id: beta.agentId, externalId: 'beta', name: 'Agent beta' },
      model: 'gpt-test',
      decidedAt: T0 + 60_000,
      status: 'pending',
      anchor: null,
      contentDeletedAt: null,
    })
    expect(Number.isNaN(Date.parse(first?.receivedAt ?? ''))).toBe(false)
    expect(second?.anchor).toEqual({
      transactionSignature: 'tx'.padEnd(88, '1'),
      slot: 1_000,
      anchoredAt: new Date(T0 + 3_000).toISOString(),
    })
  })

  it('pages by keyset without losing or repeating a row, ties on decidedAt included', async () => {
    const expected: { id: string; at: number }[] = []
    // Three decisions share each millisecond: only the `id` half of the key orders them.
    for (let index = 0; index < 11; index += 1) {
      const at = T0 + Math.floor(index / 3) * 1_000
      expected.push({ id: await addDecision(projectId, alpha, at), at })
    }
    const order = expected
      .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1))
      .map((one) => one.id)

    expect(await allPages(cookie, projectId, '?limit=3')).toEqual(order)
    expect(await allPages(cookie, projectId, '?limit=1')).toEqual(order)
    expect(await allPages(cookie, projectId, '?limit=11')).toEqual(order)
  })

  it('a decision written after the first page shows up at the top, never shifts the pages', async () => {
    for (let index = 0; index < 4; index += 1) await addDecision(projectId, alpha, T0 + index)
    const first = await page(cookie, projectId, '?limit=2')

    // An offset would now repeat a row on page two; a keyset does not.
    await addDecision(projectId, alpha, T0 + 10)
    const second = await page(
      cookie,
      projectId,
      `?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
    )

    const firstIds = first.decisions.map((one) => one.decisionId)
    expect(second.decisions.map((one) => one.decisionId).some((id) => firstIds.includes(id))).toBe(
      false,
    )
    expect(second.decisions.map((one) => one.decidedAt)).toEqual([T0 + 1, T0])
  })

  it('filters by agent, by period [from, to) and by status — and pages within the filter', async () => {
    const atStart = await addDecision(projectId, alpha, T0, 'anchored')
    await addDecision(projectId, alpha, T0 + 1_000)
    const anchoredInside = await addDecision(projectId, alpha, T0 + 2_000, 'anchored')
    await addDecision(projectId, alpha, T0 + 3_000, 'anchored') // `to` is exclusive
    const failed = await addDecision(projectId, beta, T0 + 1_500, 'failed')

    const ids = (body: JournalResponse) => body.decisions.map((one) => one.decisionId)

    expect(ids(await page(cookie, projectId, `?agentId=${beta.agentId}`))).toEqual([failed])
    expect(ids(await page(cookie, projectId, '?status=failed'))).toEqual([failed])
    expect(
      await allPages(
        cookie,
        projectId,
        `?agentId=${alpha.agentId}&from=${T0}&to=${T0 + 3_000}&status=anchored&limit=1`,
      ),
    ).toEqual([anchoredInside, atStart])
    expect(ids(await page(cookie, projectId, `?from=${T0 + 5_000}`))).toEqual([])
    expect(ids(await page(cookie, projectId, `?from=${T0}&to=${T0}`))).toEqual([])
  })

  it('an agent of another project filters to nothing rather than reaching across', async () => {
    await addDecision(projectId, alpha, T0)
    const other = await createProject(cookie, 'Other')
    const stranger = await addAgent(other, 'stranger')
    await addDecision(other, stranger, T0)

    const body = await page(cookie, projectId, `?agentId=${stranger.agentId}`)
    expect(body.decisions).toEqual([])
  })

  it('a decidedAt past what a Date can hold is listed as signed, not turned into a 500', async () => {
    const far = Number.MAX_SAFE_INTEGER
    const id = await addDecision(projectId, alpha, far)

    const body = await page(cookie, projectId)
    expect(body.decisions[0]).toMatchObject({ decisionId: id, decidedAt: far })
    expect(body.nextCursor).toBeNull()

    await addDecision(projectId, alpha, T0)
    expect(await allPages(cookie, projectId, '?limit=1')).toHaveLength(2)
  })

  it.each([
    ['an unknown parameter', '?sort=asc'],
    ['a status the store does not have', '?status=verified'],
    ['a period that ends before it starts', `?from=${T0 + 1}&to=${T0}`],
    ['a negative time', '?from=-1'],
    ['a fractional time', '?from=1.5'],
    ['a page of zero', '?limit=0'],
    ['a page past the maximum', '?limit=101'],
    ['an agent id that is not a uuid', '?agentId=alpha'],
    ['a cursor the journal did not issue', '?cursor=not-a-cursor'],
    ['a cursor of the right encoding with a wrong id', `?cursor=${btoa('1:xyz')}`],
  ])('answers 400 to %s', async (_, query) => {
    const { response, body } = await journal(cookie, projectId, query)
    expect(response.status).toBe(400)
    expect(body).toMatchObject({ error: { code: 'INVALID_INPUT' } })
  })

  it('answers 401 without a session and is not cached', async () => {
    await addDecision(projectId, alpha, T0)
    const anonymous = await call('GET', `/projects/${projectId}/decisions`)
    expect(anonymous.status).toBe(401)

    const { response } = await journal(cookie, projectId)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('carries the dashboard CORS of `/projects/*`: one origin, with credentials', async () => {
    const preflight = await call('OPTIONS', `/projects/${projectId}/decisions`, {
      headers: { 'access-control-request-method': 'GET' },
    })
    expect(preflight.headers.get('access-control-allow-origin')).toBe(WEB)
    expect(preflight.headers.get('access-control-allow-credentials')).toBe('true')

    const { response } = await journal(cookie, projectId)
    expect(response.headers.get('access-control-allow-origin')).toBe(WEB)
  })
})

const PRIVATE_CONTENT = 'client-position-size-4200'

/** As the SDK sends it: no `Origin`, no cookie, the ingest key in the header. */
const ingest = (ingestKey: string, path: string, body: unknown) =>
  app.request(`${API}/v1${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ingestKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** One public and one private step; the private one's content never leaves this function. */
async function signedDecision(key: AgentKeyPair): Promise<SignedManifest> {
  const input = { question: 'rebalance?' }
  const output = { answer: 'yes' }
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
      inputHash: toHex(await hashValue({ holdings: PRIVATE_CONTENT })),
      outputHash: toHex(await hashValue({ size: PRIVATE_CONTENT })),
    },
  ]
  return signManifest(
    {
      version: MANIFEST_VERSION,
      agentPubkey: key.publicKey,
      decisionId: randomUUID().replaceAll('-', ''),
      model: 'claude-opus-5',
      sources: ['https://quotes.example/'],
      root: toHex(await stepsRoot(steps)),
      decidedAt: T0,
      outcome: { action: 'hold' },
      steps,
    },
    key,
  )
}

describe('GET /v1/projects/:projectId/decisions/:decisionId — details (T040, FR-017)', () => {
  let cookie: string
  let projectId: string
  let envelope: SignedManifest
  let decisionId: string
  let agentId: string

  beforeAll(async () => {
    const key = await generateAgentKey()
    await client.query('DELETE FROM projects')
    cookie = await signIn(`details-${randomUUID()}@example.com`)
    const project = await createProjectWithKey(cookie, 'Details')
    projectId = project.projectId

    const registered = await ingest(project.ingestKey, '/agents', {
      externalId: 'rebalancer-7',
      name: 'Portfolio rebalancer',
      publicKey: key.publicKey,
    })
    expect(registered.status).toBe(200)
    agentId = ((await registered.json()) as { agentId: string }).agentId

    envelope = await signedDecision(key)
    decisionId = envelope.manifest.decisionId
    expect((await ingest(project.ingestKey, '/decisions', envelope)).status).toBe(200)
  })

  const details = (id = decisionId, session = cookie) =>
    call('GET', `/projects/${projectId}/decisions/${id}`, { cookie: session })

  const detailsOk = async () => {
    const response = await details()
    expect(response.status).toBe(200)
    return decisionDetailsResponseSchema.parse(await response.json())
  }

  /** What anyone gets for the same decision, with no session at all. */
  const publicRead = async () =>
    publicDecisionResponseSchema.parse(
      await (await app.request(`${API}/v1/public/decisions/${decisionId}`)).json(),
    )

  it('gives the envelope as signed, the agent, and where anchoring stands', async () => {
    const body = await detailsOk()

    expect(body.signedManifest).toEqual(envelope)
    expect(body.decisionId).toBe(decisionId)
    expect(body.agent).toEqual({
      id: agentId,
      externalId: 'rebalancer-7',
      name: 'Portfolio rebalancer',
    })
    expect(body.status).toBe('pending')
    expect(body.anchor).toBeNull()
    expect(Number.isNaN(Date.parse(body.receivedAt))).toBe(false)
  })

  it('shows a private step by its hashes and type only — its content is stored nowhere', async () => {
    const response = await details()
    const text = await response.text()

    expect(text).not.toContain(PRIVATE_CONTENT)
    const body = decisionDetailsResponseSchema.parse(JSON.parse(text))
    expect(body.signedManifest?.manifest.steps[1]).toEqual(envelope.manifest.steps[1])
    expect(Object.keys(body.signedManifest?.manifest.steps[1] ?? {}).sort()).toEqual([
      'inputHash',
      'outputHash',
      'private',
      'type',
    ])
  })

  it('reaches the same verdict as the public read, whatever the stored row says', async () => {
    const honest = await detailsOk()
    expect(honest.verification).toEqual((await publicRead()).verification)
    expect(honest.verification).toMatchObject({ status: 'pending', includesChain: false })

    await client.query(
      `UPDATE decisions SET status = 'anchored', anchor_signature = 'sigFromDevnet',
         anchor_slot = 312, anchored_at = now() WHERE id = $1`,
      [asUuid(decisionId)],
    )
    const anchored = await detailsOk()
    expect(anchored.status).toBe('anchored')
    expect(anchored.anchor).toEqual((await publicRead()).anchor)
    expect(anchored.anchor?.transactionSignature).toBe('sigFromDevnet')

    // Someone with database access rewrites the outcome after the fact.
    await client.query(`UPDATE decisions SET outcome = '{"action":"sell"}' WHERE id = $1`, [
      asUuid(decisionId),
    ])
    const tampered = await detailsOk()
    expect(tampered.verification.status).toBe('tampered')
    expect(tampered.verification).toEqual((await publicRead()).verification)

    await client.query('UPDATE decisions SET content_deleted_at = now() WHERE id = $1', [
      asUuid(decisionId),
    ])
    const deleted = await detailsOk()
    expect(deleted.verification.status).toBe('content-deleted')
    expect(deleted.signedManifest).toBeNull()
    expect(deleted.contentDeletedAt).not.toBeNull()
  })

  it.each([
    ['an id of no decision', 'f'.repeat(32)],
    ['an id that is not 32 hex', 'not-a-decision'],
    ['the uuid form of the id', '00000000-0000-4000-8000-000000000000'],
  ])('answers 404 to %s', async (_, id) => {
    const response = await details(id)
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
  })

  it('answers 401 without a session and is not cached', async () => {
    const anonymous = await call('GET', `/projects/${projectId}/decisions/${decisionId}`)
    expect(anonymous.status).toBe(401)
    expect((await details()).headers.get('cache-control')).toBe('no-store')
  })
})
