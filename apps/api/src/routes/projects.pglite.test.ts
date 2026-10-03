import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import {
  createProjectResponseSchema,
  listProjectsResponseSchema,
  reissueIngestKeyResponseSchema,
} from '@agenttrace/shared'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { authRoutes, createAuth, sessionUserOf } from '../auth.js'
import { createSendCodeGuard, DEFAULT_SEND_CODE_LIMITS } from '../auth-limits.js'
import { hashIngestKey, isIngestKeyShaped } from '../ingest-key.js'
import { silentLogger } from '../logger.js'
import { projectByIngestKeyHash } from '../middleware/auth.js'
import {
  createProject,
  MAX_OWNED_PROJECTS,
  SELF_SERVE_DAILY_QUOTA,
  SELF_SERVE_QUOTA_BUDGET,
} from '../projects.js'
import { projectRoutes } from './projects.js'

/**
 * Against the real migration and a real sign-in: the session these routes
 * trust is the one better-auth opens, not a stub that says "user 1".
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
let db: ReturnType<typeof drizzle>
let app: ReturnType<typeof createApp>
const outbox: { to: string; code: string }[] = []

beforeAll(async () => {
  client = await PGlite.create()
  await client.exec(migration)
  db = drizzle(client)

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
      // Every operator here signs in from one address; the limits have their own tests.
      guard: createSendCodeGuard({
        ...DEFAULT_SEND_CODE_LIMITS,
        addressBurst: 1_000,
        emailCooldownMs: 0,
        perDay: 1_000,
      }),
    }),
  )
  app.route('/v1', projectRoutes(db, { webOrigin: WEB, sessionUser: sessionUserOf(auth) }))
}, 60_000)

afterAll(async () => {
  await client?.close()
})

const call = (
  method: 'GET' | 'POST' | 'OPTIONS',
  path: string,
  options: {
    cookie?: string
    origin?: string
    body?: unknown
    headers?: Record<string, string>
  } = {},
) =>
  app.request(`${API}/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      origin: options.origin ?? WEB,
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })

interface Operator {
  readonly cookie: string
  readonly userId: string
}

async function signIn(email: string): Promise<Operator> {
  const sent = await call('POST', '/auth/email-otp/send-verification-otp', {
    body: { email, type: 'sign-in' },
  })
  expect(sent.status).toBe(200)
  const code = outbox.at(-1)?.code

  const signedIn = await call('POST', '/auth/sign-in/email-otp', { body: { email, otp: code } })
  expect(signedIn.status).toBe(200)
  const cookie =
    signedIn.headers
      .getSetCookie()
      .find((value) => value.includes('session_token='))
      ?.split(';')[0] ?? ''

  const { rows } = await client.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
    email,
  ])
  const userId = rows[0]?.id
  if (userId === undefined) throw new Error(`no user for ${email}`)
  return { cookie, userId }
}

async function create(operator: Operator, name: string) {
  return call('POST', '/projects', { cookie: operator.cookie, body: { name } })
}

async function createOk(operator: Operator, name: string) {
  const response = await create(operator, name)
  expect(response.status).toBe(201)
  return createProjectResponseSchema.parse(await response.json())
}

async function list(operator: Operator) {
  const response = await call('GET', '/projects', { cookie: operator.cookie })
  expect(response.status).toBe(200)
  return listProjectsResponseSchema.parse(await response.json())
}

const lookup = async (key: string) => projectByIngestKeyHash(db)(await hashIngestKey(key))

describe('creating a project from the dashboard', () => {
  it('refuses without a session', async () => {
    expect((await call('GET', '/projects')).status).toBe(401)
    expect((await call('POST', '/projects', { body: { name: 'x' } })).status).toBe(401)
  })

  it('hands the key over once, and the key authorises ingest for that project', async () => {
    const operator = await signIn('creator@example.com')
    const response = await create(operator, '  Support agent  ')

    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const { project, ingestKey } = createProjectResponseSchema.parse(await response.json())

    expect(isIngestKeyShaped(ingestKey)).toBe(true)
    expect(project).toMatchObject({
      name: 'Support agent',
      role: 'owner',
      dailyQuota: SELF_SERVE_DAILY_QUOTA,
    })
    expect(await lookup(ingestKey)).toEqual({
      id: project.id,
      name: 'Support agent',
      dailyQuota: SELF_SERVE_DAILY_QUOTA,
      hotWindowDays: 14,
    })

    const stored = await client.query<{ self_serve: boolean; role: string; user_id: string }>(
      `SELECT p.self_serve, m.role, m.user_id
         FROM projects p JOIN members m ON m.project_id = p.id
        WHERE p.id = $1`,
      [project.id],
    )
    expect(stored.rows).toEqual([{ self_serve: true, role: 'owner', user_id: operator.userId }])
  })

  it('never shows the key again: the list carries no key', async () => {
    const operator = await signIn('lister@example.com')
    const { project, ingestKey } = await createOk(operator, 'listed')

    const listed = await call('GET', '/projects', { cookie: operator.cookie })
    const text = await listed.text()

    expect(text).not.toContain(ingestKey)
    expect(listProjectsResponseSchema.parse(JSON.parse(text))).toEqual({
      projects: [project],
      maxOwnedProjects: MAX_OWNED_PROJECTS,
    })
  })

  it('lists only the projects the caller is a member of', async () => {
    const alice = await signIn('alice@example.com')
    const bob = await signIn('bob@example.com')
    const own = await createOk(alice, 'alice one')
    await createOk(bob, 'bob one')

    expect((await list(alice)).projects.map((project) => project.id)).toEqual([own.project.id])
  })

  it('refuses a blank name and a field it does not know', async () => {
    const operator = await signIn('names@example.com')

    expect((await create(operator, '   ')).status).toBe(400)
    const extra = await call('POST', '/projects', {
      cookie: operator.cookie,
      body: { name: 'ok', dailyQuota: 10_000 },
    })
    expect(extra.status).toBe(400)
    expect((await list(operator)).projects).toEqual([])
  })

  it('refuses a POST from another origin even with a valid session', async () => {
    const operator = await signIn('csrf@example.com')
    const forged = await call('POST', '/projects', {
      cookie: operator.cookie,
      origin: 'https://evil.example',
      body: { name: 'forged' },
    })

    expect(forged.status).toBe(401)
    expect((await list(operator)).projects).toEqual([])
  })

  it('answers the dashboard preflight and nobody else', async () => {
    const preflight = await call('OPTIONS', '/projects', {
      headers: { 'access-control-request-method': 'POST' },
    })
    expect(preflight.headers.get('access-control-allow-origin')).toBe(WEB)
    expect(preflight.headers.get('access-control-allow-credentials')).toBe('true')

    const foreign = await call('GET', '/projects', { origin: 'https://evil.example' })
    expect(foreign.headers.get('access-control-allow-origin')).not.toBe('https://evil.example')
  })

  it('stops working once the operator signs out', async () => {
    const operator = await signIn('leaver@example.com')
    const out = await call('POST', '/auth/sign-out', { cookie: operator.cookie, body: {} })
    expect(out.status).toBe(200)

    expect((await call('GET', '/projects', { cookie: operator.cookie })).status).toBe(401)
  })
})

describe('the ceilings that keep self-service inside the budget', () => {
  it(`stops one account at ${MAX_OWNED_PROJECTS} projects, with the reason`, async () => {
    const operator = await signIn('many@example.com')
    for (const n of [1, 2, 3]) await createOk(operator, `many ${n}`)

    const fourth = await create(operator, 'many 4')
    expect(fourth.status).toBe(400)
    expect(await fourth.json()).toMatchObject({
      error: { code: 'INVALID_INPUT', details: { reason: 'projects-per-account', limit: 3 } },
    })
    expect((await list(operator)).projects).toHaveLength(MAX_OWNED_PROJECTS)
  })

  /**
   * PGlite has one connection and runs transactions one after another, so this
   * holds with or without the advisory lock — it pins the outcome, not the
   * lock. That the lock serialises two real connections through the Supavisor
   * pooler was checked against Supabase by hand on 2026-10-03 (SCRATCHPAD).
   */
  it('holds the per-account ceiling when the requests arrive at once', async () => {
    const operator = await signIn('burst@example.com')
    const answers = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => create(operator, `burst ${n}`).then((r) => r.status)),
    )

    expect(answers.filter((status) => status === 201)).toHaveLength(MAX_OWNED_PROJECTS)
    expect(answers.filter((status) => status === 400)).toHaveLength(2)
    expect((await list(operator)).projects).toHaveLength(MAX_OWNED_PROJECTS)
  })

  it('does not count a project we seeded, even one attached to an account', async () => {
    const operator = await signIn('demo-owner@example.com')
    const demo = await createProject(db, 'demo')
    await client.query(`INSERT INTO members (project_id, user_id, role) VALUES ($1, $2, 'owner')`, [
      demo.projectId,
      operator.userId,
    ])

    for (const n of [1, 2, 3]) await createOk(operator, `own ${n}`)
    expect((await list(operator)).projects).toHaveLength(MAX_OWNED_PROJECTS + 1)
  })

  it('pauses creation for everyone once the reserved quotas reach the budget', async () => {
    const operator = await signIn('late@example.com')
    const { rows } = await client.query<{ total: number }>(
      'SELECT coalesce(sum(daily_quota), 0)::int AS total FROM projects WHERE self_serve',
    )
    const room = SELF_SERVE_QUOTA_BUDGET - (rows[0]?.total ?? 0)
    // One project short of the budget: the next one fits, the one after does not.
    const filler = await createOk(operator, 'filler')
    await client.query('UPDATE projects SET daily_quota = daily_quota + $1 WHERE id = $2', [
      room - 2 * SELF_SERVE_DAILY_QUOTA,
      filler.project.id,
    ])

    try {
      await createOk(operator, 'last one in')
      const refused = await create(operator, 'one too many')
      expect(refused.status).toBe(429)
      expect(await refused.json()).toMatchObject({
        error: { code: 'RATE_LIMITED', details: { reason: 'capacity' } },
      })
      // A project we seed at full quota is not self-service and never is refused.
      await createProject(db, 'ours, at 10 000')
    } finally {
      await client.query('UPDATE projects SET daily_quota = $1 WHERE id = $2', [
        SELF_SERVE_DAILY_QUOTA,
        filler.project.id,
      ])
    }
  })
})

describe('replacing a lost ingest key', () => {
  it('gives the owner a new key and kills the old one on the next request', async () => {
    const owner = await signIn('rotate@example.com')
    const { project, ingestKey: old } = await createOk(owner, 'rotating')

    const response = await call('POST', `/projects/${project.id}/ingest-key`, {
      cookie: owner.cookie,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const { ingestKey } = reissueIngestKeyResponseSchema.parse(await response.json())

    expect(ingestKey).not.toBe(old)
    expect(await lookup(old)).toBeUndefined()
    expect((await lookup(ingestKey))?.id).toBe(project.id)
  })

  it('answers 404 for a project of someone else, and leaves its key alone', async () => {
    const owner = await signIn('victim@example.com')
    const stranger = await signIn('stranger@example.com')
    const { project, ingestKey } = await createOk(owner, 'not yours')

    const attempt = await call('POST', `/projects/${project.id}/ingest-key`, {
      cookie: stranger.cookie,
    })
    expect(attempt.status).toBe(404)
    expect((await lookup(ingestKey))?.id).toBe(project.id)
  })

  it('answers 404 to an operator: replacing the key is the owner’s call', async () => {
    const owner = await signIn('lead@example.com')
    const operator = await signIn('member@example.com')
    const { project, ingestKey } = await createOk(owner, 'shared')
    await client.query(
      `INSERT INTO members (project_id, user_id, role) VALUES ($1, $2, 'operator')`,
      [project.id, operator.userId],
    )

    expect((await list(operator)).projects).toEqual([{ ...project, role: 'operator' }])
    const attempt = await call('POST', `/projects/${project.id}/ingest-key`, {
      cookie: operator.cookie,
    })
    expect(attempt.status).toBe(404)
    expect((await lookup(ingestKey))?.id).toBe(project.id)
  })

  it('answers 404 to an id that is absent or not an id at all', async () => {
    const owner = await signIn('typo@example.com')

    for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      const attempt = await call('POST', `/projects/${id}/ingest-key`, { cookie: owner.cookie })
      expect(attempt.status).toBe(404)
    }
  })

  it('refuses without a session and from another origin', async () => {
    const owner = await signIn('guarded@example.com')
    const { project } = await createOk(owner, 'guarded')

    expect((await call('POST', `/projects/${project.id}/ingest-key`)).status).toBe(401)
    const forged = await call('POST', `/projects/${project.id}/ingest-key`, {
      cookie: owner.cookie,
      origin: 'https://evil.example',
    })
    expect(forged.status).toBe(401)
  })
})
