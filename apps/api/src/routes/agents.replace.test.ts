import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { generateAgentKey, signKeyRotation } from '@agenttrace/manifest'
import { createProjectResponseSchema, rotateAgentKeyResponseSchema } from '@agenttrace/shared'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { authRoutes, createAuth, sessionUserOf } from '../auth.js'
import { createSendCodeGuard, DEFAULT_SEND_CODE_LIMITS } from '../auth-limits.js'
import type { ErrorBody } from '../errors.js'
import { silentLogger } from '../logger.js'
import { agentRoutes } from './agents.js'
import { projectRoutes } from './projects.js'

/**
 * Against a real sign-in: what this route trusts is the owner's role and the
 * age of the session better-auth opened, and a stub would only prove itself.
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
  app.route('/v1', agentRoutes(db))
}, 60_000)

const call = (
  method: 'POST',
  path: string,
  options: { cookie?: string; origin?: string; body?: unknown; ingestKey?: string } = {},
) =>
  app.request(`${API}/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      origin: options.origin ?? WEB,
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...(options.ingestKey === undefined ? {} : { authorization: `Bearer ${options.ingestKey}` }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })

interface Person {
  readonly cookie: string
  readonly userId: string
}

let emails = 0

async function signIn(): Promise<Person> {
  emails += 1
  const email = `person${emails}@example.com`
  await call('POST', '/auth/email-otp/send-verification-otp', { body: { email, type: 'sign-in' } })
  const signedIn = await call('POST', '/auth/sign-in/email-otp', {
    body: { email, otp: outbox.at(-1)?.code },
  })
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

interface Fixture {
  readonly owner: Person
  readonly projectId: string
  readonly ingestKey: string
  readonly agentId: string
  readonly initialKey: Awaited<ReturnType<typeof generateAgentKey>>
}

let fixture: Fixture

async function projectWithAgent(owner: Person, externalId = 'trader-1'): Promise<Fixture> {
  const created = await call('POST', '/projects', {
    cookie: owner.cookie,
    body: { name: `p${emails}` },
  })
  const { project, ingestKey } = createProjectResponseSchema.parse(await created.json())
  const initialKey = await generateAgentKey()
  const registered = await call('POST', '/agents', {
    ingestKey,
    body: { externalId, name: 'Trader', publicKey: initialKey.publicKey },
  })
  const { agentId } = (await registered.json()) as { agentId: string }
  return { owner, projectId: project.id, ingestKey, agentId, initialKey }
}

beforeEach(async () => {
  fixture = await projectWithAgent(await signIn())
})

const replace = (
  newPublicKey: string,
  options: { cookie?: string; origin?: string; projectId?: string; agentId?: string } = {},
) =>
  call(
    'POST',
    `/projects/${options.projectId ?? fixture.projectId}/agents/${options.agentId ?? fixture.agentId}/rotate-admin`,
    {
      cookie: options.cookie ?? fixture.owner.cookie,
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      body: { newPublicKey },
    },
  )

const keysOf = async (agentId: string) =>
  (
    await client.query<Record<string, unknown>>(
      `SELECT public_key, valid_from, valid_to, rotation_kind, prev_key_id IS NOT NULL AS chained_to,
              rotation_proof, confirmed_by
         FROM agent_keys WHERE agent_id = $1 ORDER BY valid_from`,
      [agentId],
    )
  ).rows

const errorOf = async (response: Response) => ((await response.json()) as ErrorBody).error

const ageSessionsOf = (userId: string, minutes: number) =>
  client.query(
    `UPDATE sessions SET created_at = now() - make_interval(mins => $2) WHERE user_id = $1`,
    [userId, minutes],
  )

describe('emergency key replacement', () => {
  it('replaces the key at the moment of confirmation, with nobody but the owner vouching', async () => {
    const next = await generateAgentKey()
    const before = Date.now()
    const response = await replace(next.publicKey)
    const after = Date.now()

    expect(response.status).toBe(200)
    const body = rotateAgentKeyResponseSchema.parse(await response.json())
    expect(body).toMatchObject({ agentId: fixture.agentId, publicKey: next.publicKey })
    expect(body.effectiveAt).toBeGreaterThanOrEqual(before)
    expect(body.effectiveAt).toBeLessThanOrEqual(after)

    expect(await keysOf(fixture.agentId)).toEqual([
      {
        public_key: fixture.initialKey.publicKey,
        valid_from: 0,
        valid_to: body.effectiveAt,
        rotation_kind: 'initial',
        chained_to: false,
        rotation_proof: null,
        confirmed_by: null,
      },
      {
        public_key: next.publicKey,
        valid_from: body.effectiveAt,
        valid_to: null,
        rotation_kind: 'administrative',
        chained_to: true,
        // The payer signs when it publishes the anchor; nobody has yet.
        rotation_proof: null,
        confirmed_by: fixture.owner.userId,
      },
    ])
  })

  it('answers a repeated confirmation with the replacement already made', async () => {
    const next = await generateAgentKey()
    const first = rotateAgentKeyResponseSchema.parse(await (await replace(next.publicKey)).json())
    const again = await replace(next.publicKey)

    expect(again.status).toBe(200)
    expect(rotateAgentKeyResponseSchema.parse(await again.json())).toEqual(first)
    expect(await keysOf(fixture.agentId)).toHaveLength(2)
  })

  it('leaves one unbroken history after two racing replacements', async () => {
    // PGlite runs them one after the other, so the second may replace the
    // first; on Postgres the loser finds the key already closed. Either way:
    // one open key, and every window starts where the previous one ended.
    const [a, b] = await Promise.all([generateAgentKey(), generateAgentKey()])
    const responses = await Promise.all([replace(a.publicKey), replace(b.publicKey)])
    const keys = await keysOf(fixture.agentId)

    expect(responses.filter((response) => response.status === 200)).toHaveLength(keys.length - 1)
    expect(keys.filter((key) => key.valid_to === null)).toHaveLength(1)
    for (let i = 1; i < keys.length; i += 1) {
      expect(keys[i]?.valid_from).toBe(keys[i - 1]?.valid_to)
    }
  })

  it('replaces a key that was itself put in by a chained rotation', async () => {
    const chained = await generateAgentKey()
    const effectiveAt = Date.now() - 60_000
    const rotated = await call('POST', `/agents/${fixture.agentId}/rotate`, {
      ingestKey: fixture.ingestKey,
      body: {
        newPublicKey: chained.publicKey,
        effectiveAt,
        proof: await signKeyRotation(
          { newPubkey: chained.publicKey, prevPubkey: fixture.initialKey.publicKey, effectiveAt },
          fixture.initialKey,
        ),
      },
    })
    expect(rotated.status).toBe(200)

    const next = await generateAgentKey()
    expect((await replace(next.publicKey)).status).toBe(200)
    expect((await keysOf(fixture.agentId)).map((key) => key.rotation_kind)).toEqual([
      'initial',
      'chained',
      'administrative',
    ])
  })
})

describe('who may confirm', () => {
  it('asks a session older than ten minutes to sign in again', async () => {
    // A stolen long-lived cookie must not be enough to hand the agent's
    // identity to someone else for good; a fresh sign-in is a code by mail.
    await ageSessionsOf(fixture.owner.userId, 11)
    const response = await replace((await generateAgentKey()).publicKey)

    expect(response.status).toBe(401)
    expect((await errorOf(response)).details).toEqual({ reason: 'STALE_SIGN_IN' })
    expect(await keysOf(fixture.agentId)).toHaveLength(1)
  })

  it('takes a code entered on top of the stale session, as the keys screen asks for one', async () => {
    // The screen signs in again without signing out first, so the browser still
    // sends the old cookie; what must reach the replacement is the new session.
    await ageSessionsOf(fixture.owner.userId, 11)
    const { rows } = await client.query<{ email: string }>(
      'SELECT email FROM users WHERE id = $1',
      [fixture.owner.userId],
    )
    const email = rows[0]?.email
    const old = { cookie: fixture.owner.cookie }
    await call('POST', '/auth/email-otp/send-verification-otp', {
      ...old,
      body: { email, type: 'sign-in' },
    })
    const signedIn = await call('POST', '/auth/sign-in/email-otp', {
      ...old,
      body: { email, otp: outbox.at(-1)?.code },
    })
    expect(signedIn.status).toBe(200)
    const fresh = signedIn.headers
      .getSetCookie()
      .find((value) => value.includes('session_token='))
      ?.split(';')[0]
    if (fresh === undefined) throw new Error('the second sign-in set no session cookie')

    expect(fresh).not.toBe(fixture.owner.cookie)
    expect((await replace((await generateAgentKey()).publicKey, { cookie: fresh })).status).toBe(
      200,
    )
  })

  it('accepts a session just inside ten minutes', async () => {
    await ageSessionsOf(fixture.owner.userId, 9)
    expect((await replace((await generateAgentKey()).publicKey)).status).toBe(200)
  })

  it('refuses an operator of the project as if the agent were not there', async () => {
    const operator = await signIn()
    await client.query(
      `INSERT INTO members (project_id, user_id, role) VALUES ($1, $2, 'operator')`,
      [fixture.projectId, operator.userId],
    )
    const response = await replace((await generateAgentKey()).publicKey, {
      cookie: operator.cookie,
    })

    expect(response.status).toBe(404)
    expect(await keysOf(fixture.agentId)).toHaveLength(1)
  })

  it("refuses the owner of another project, even naming that project's own id", async () => {
    const stranger = await projectWithAgent(await signIn(), 'trader-2')
    const key = (await generateAgentKey()).publicKey

    const viaOwnProject = await replace(key, {
      cookie: stranger.owner.cookie,
      projectId: stranger.projectId,
    })
    const viaForeignProject = await replace(key, { cookie: stranger.owner.cookie })

    expect(viaOwnProject.status).toBe(404)
    expect(viaForeignProject.status).toBe(404)
    expect(await keysOf(fixture.agentId)).toHaveLength(1)
  })

  it.each([
    ['an agent id that is not a uuid', { agentId: 'nope' }],
    ['an agent that does not exist', { agentId: '00000000-0000-4000-8000-000000000000' }],
    ['a project id that is not a uuid', { projectId: 'nope' }],
  ])('answers %s with 404', async (_name, path) => {
    expect((await replace((await generateAgentKey()).publicKey, path)).status).toBe(404)
  })

  it('refuses without a session', async () => {
    const response = await call(
      'POST',
      `/projects/${fixture.projectId}/agents/${fixture.agentId}/rotate-admin`,
      { body: { newPublicKey: (await generateAgentKey()).publicKey } },
    )
    expect(response.status).toBe(401)
  })

  it('refuses a request from a page that is not the dashboard', async () => {
    const response = await replace((await generateAgentKey()).publicKey, {
      origin: 'https://evil.example',
    })
    expect(response.status).toBe(401)
    expect(await keysOf(fixture.agentId)).toHaveLength(1)
  })
})

describe('what the new key must be', () => {
  it('refuses a key that belongs to another agent', async () => {
    const other = await projectWithAgent(fixture.owner, 'trader-3')
    const response = await replace(other.initialKey.publicKey)

    expect(response.status).toBe(400)
    expect((await errorOf(response)).message).toBe(
      'This public key is already registered to another agent',
    )
  })

  it('refuses the key it is replacing', async () => {
    const response = await replace(fixture.initialKey.publicKey)
    expect(response.status).toBe(400)
    expect(await keysOf(fixture.agentId)).toHaveLength(1)
  })

  it('refuses a key that is not a point on the curve', async () => {
    expect((await replace('dd'.repeat(32))).status).toBe(400)
  })

  it('refuses a body that is not the contract', async () => {
    const response = await call(
      'POST',
      `/projects/${fixture.projectId}/agents/${fixture.agentId}/rotate-admin`,
      {
        cookie: fixture.owner.cookie,
        body: { newPublicKey: (await generateAgentKey()).publicKey, effectiveAt: 0 },
      },
    )
    expect(response.status).toBe(400)
  })
})

describe('where the line falls', () => {
  it('refuses while the current key already signed a decision dated after now', async () => {
    // The line goes to the chain and stays; drawing it before a decision the
    // key has already signed would put that decision outside its key for good.
    const later = Date.now() + 60_000
    await client.query(
      `INSERT INTO decisions (id, project_id, agent_id, agent_key_id, root, signature, decided_at,
                              model_ref, sources, steps, outcome)
       SELECT $1, $2, $3, id, $4, $5, $6, 'm', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb
         FROM agent_keys WHERE agent_id = $3`,
      [
        'ab'.repeat(16),
        fixture.projectId,
        fixture.agentId,
        'cd'.repeat(32),
        'ef'.repeat(64),
        later,
      ],
    )
    const response = await replace((await generateAgentKey()).publicKey)

    expect(response.status).toBe(400)
    expect((await errorOf(response)).details).toEqual({ latestDecidedAt: later })
    expect(await keysOf(fixture.agentId)).toHaveLength(1)
  })

  it('refuses while the current key has not taken effect yet', async () => {
    // A chained rotation may be dated a few minutes ahead (clock skew); the
    // replacement cannot come before the key it replaces even starts.
    const chained = await generateAgentKey()
    const effectiveAt = Date.now() + 60_000
    await call('POST', `/agents/${fixture.agentId}/rotate`, {
      ingestKey: fixture.ingestKey,
      body: {
        newPublicKey: chained.publicKey,
        effectiveAt,
        proof: await signKeyRotation(
          { newPubkey: chained.publicKey, prevPubkey: fixture.initialKey.publicKey, effectiveAt },
          fixture.initialKey,
        ),
      },
    })
    const response = await replace((await generateAgentKey()).publicKey)

    expect(response.status).toBe(400)
    expect(await keysOf(fixture.agentId)).toHaveLength(2)
  })
})
