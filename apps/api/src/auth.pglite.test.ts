import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { authRoutes, createAuth, isCrossSite } from './auth.js'
import { createSendCodeGuard, DEFAULT_SEND_CODE_LIMITS } from './auth-limits.js'
import { silentLogger } from './logger.js'
import { EmailNotSent } from './mailer.js'

/**
 * The whole sign-in runs against the real migration: better-auth writes
 * through its drizzle adapter into the tables of T037, and a field the two
 * disagree on fails here, not at an operator's first sign-in.
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
const outbox: { to: string; code: string }[] = []

beforeAll(async () => {
  client = await PGlite.create()
  await client.exec(migration)
  db = drizzle(client)
}, 60_000)

afterAll(async () => {
  await client?.close()
})

function build(
  options: { baseUrl?: string; webOrigin?: string; perDay?: number; mailFails?: boolean } = {},
) {
  const baseUrl = options.baseUrl ?? API
  const webOrigin = options.webOrigin ?? WEB
  const auth = createAuth(db, {
    secret: SECRET,
    baseUrl,
    webOrigin,
    sendCode: async (to, code) => {
      if (options.mailFails === true) throw new EmailNotSent('validation_error')
      outbox.push({ to, code })
    },
  })
  const app = createApp({ logger: silentLogger() })
  app.route(
    '/v1',
    authRoutes(auth, {
      webOrigin,
      guard: createSendCodeGuard({
        ...DEFAULT_SEND_CODE_LIMITS,
        emailCooldownMs: 0,
        perDay: options.perDay ?? 1_000,
      }),
    }),
  )
  return { app, baseUrl, webOrigin }
}

type Built = ReturnType<typeof build>

const post = (built: Built, path: string, body: unknown, headers: Record<string, string> = {}) =>
  built.app.request(`${built.baseUrl}/v1/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: built.webOrigin, ...headers },
    body: JSON.stringify(body),
  })

async function requestCode(built: Built, email: string) {
  const response = await post(built, '/email-otp/send-verification-otp', { email, type: 'sign-in' })
  expect(response.status).toBe(200)
  const sent = outbox.at(-1)
  if (sent === undefined) throw new Error('no code was sent')
  return sent.code
}

const sessionCookie = (response: Response) =>
  response.headers.getSetCookie().find((cookie) => cookie.includes('session_token=')) ?? ''

describe('sign-in by email code', () => {
  it('sends a six-digit code to the lowercased address', async () => {
    const code = await requestCode(build(), 'Operator@Example.com')

    expect(code).toMatch(/^\d{6}$/)
    expect(outbox.at(-1)?.to).toBe('operator@example.com')
  })

  it('stores the code hashed, so reading the database signs nobody in', async () => {
    const code = await requestCode(build(), 'hashed@example.com')
    const stored = await client.query<{ value: string }>(
      `SELECT value FROM verifications WHERE identifier LIKE '%hashed@example.com'`,
    )

    expect(stored.rows).toHaveLength(1)
    expect(stored.rows[0]?.value).not.toContain(code)
  })

  it('signs a new operator in, creates the user and opens a session', async () => {
    const built = build()
    const code = await requestCode(built, 'new@example.com')

    const signIn = await post(built, '/sign-in/email-otp', { email: 'new@example.com', otp: code })
    expect(signIn.status).toBe(200)

    const users = await client.query<{ email: string; email_verified: boolean }>(
      `SELECT email, email_verified FROM users WHERE email = 'new@example.com'`,
    )
    expect(users.rows).toEqual([{ email: 'new@example.com', email_verified: true }])

    const cookie = sessionCookie(signIn).split(';')[0] ?? ''
    const session = await built.app.request(`${API}/v1/auth/get-session`, {
      headers: { cookie, origin: WEB },
    })
    const body = (await session.json()) as { user?: { email?: string } } | null
    expect(body?.user?.email).toBe('new@example.com')
  })

  it('says so when the provider refuses to send, instead of "a code is on its way"', async () => {
    const response = await post(build({ mailFails: true }), '/email-otp/send-verification-otp', {
      email: 'refused@example.com',
      type: 'sign-in',
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      error: { code: 'INTERNAL', message: 'A sign-in code could not be sent to this address' },
    })
  })

  it('refuses a wrong code and burns the real one after three tries', async () => {
    const built = build()
    const code = await requestCode(built, 'guess@example.com')
    const wrong = code === '000000' ? '111111' : '000000'

    for (const _ of [1, 2, 3]) {
      const attempt = await post(built, '/sign-in/email-otp', {
        email: 'guess@example.com',
        otp: wrong,
      })
      expect(attempt.status).toBeGreaterThanOrEqual(400)
    }

    const late = await post(built, '/sign-in/email-otp', { email: 'guess@example.com', otp: code })
    expect(late.status).toBeGreaterThanOrEqual(400)
    expect(sessionCookie(late)).toBe('')
  })

  it.each([
    ['a foreign page', { origin: 'https://evil.example' }],
    ['no origin at all', { origin: '' }],
  ])('refuses a sign-in from %s', async (_name, headers) => {
    // The CSRF half of `PLAN.md` → Security: with a cookie session, a foreign
    // page must not be able to act on the operator's behalf.
    const built = build()
    const code = await requestCode(built, 'csrf@example.com')
    const forged = await post(
      built,
      '/sign-in/email-otp',
      { email: 'csrf@example.com', otp: code },
      headers,
    )

    expect(forged.status).toBe(401)
    expect(sessionCookie(forged)).toBe('')
  })

  it('refuses a foreign page that asks for a code, and sends nothing', async () => {
    const built = build()
    const before = outbox.length
    const forged = await post(
      built,
      '/email-otp/send-verification-otp',
      { email: 'victim@example.com', type: 'sign-in' },
      { origin: 'https://evil.example' },
    )

    expect(forged.status).toBe(401)
    expect(outbox.length).toBe(before)
  })

  it('refuses sign-out from a foreign page that carries the session cookie', async () => {
    const built = build()
    const code = await requestCode(built, 'out@example.com')
    const cookie =
      sessionCookie(
        await post(built, '/sign-in/email-otp', { email: 'out@example.com', otp: code }),
      ).split(';')[0] ?? ''

    const forged = await post(built, '/sign-out', {}, { origin: 'https://evil.example', cookie })
    expect(forged.status).toBe(401)

    const still = await built.app.request(`${API}/v1/auth/get-session`, { headers: { cookie } })
    const body = (await still.json()) as { user?: { email?: string } } | null
    expect(body?.user?.email).toBe('out@example.com')
  })
})

describe('the session cookie', () => {
  async function cookieFor(built: Built, email: string) {
    const code = await requestCode(built, email)
    return sessionCookie(await post(built, '/sign-in/email-otp', { email, otp: code }))
  }

  it('crosses from Pages to Render: partitioned, SameSite=None, Secure, HttpOnly', async () => {
    const cookie = await cookieFor(build(), 'cross@example.com')

    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/Secure/i)
    expect(cookie).toMatch(/SameSite=None/i)
    expect(cookie).toMatch(/Partitioned/i)
  })

  it('stays Lax and unpartitioned when the dashboard is on the same host', async () => {
    const cookie = await cookieFor(
      build({ baseUrl: 'http://localhost:8787', webOrigin: 'http://localhost:5173' }),
      'local@example.com',
    )

    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Lax/i)
    expect(cookie).not.toMatch(/Partitioned/i)
  })

  it('decides cross-site by host, ignoring the port', () => {
    expect(isCrossSite('http://localhost:8787', 'http://localhost:5173')).toBe(false)
    expect(
      isCrossSite('https://agenttrace-api.onrender.com', 'https://agenttracewoof.github.io'),
    ).toBe(true)
  })
})

describe('what the routes let through', () => {
  it('answers the dashboard preflight with credentials, and nobody else', async () => {
    const built = build()
    const preflight = (origin: string) =>
      built.app.request(`${API}/v1/auth/sign-in/email-otp`, {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST' },
      })

    const ours = await preflight(WEB)
    expect(ours.headers.get('access-control-allow-origin')).toBe(WEB)
    expect(ours.headers.get('access-control-allow-credentials')).toBe('true')

    const theirs = await preflight('https://evil.example')
    expect(theirs.headers.get('access-control-allow-origin')).toBeNull()
  })

  it.each([
    ['password sign-up', '/sign-up/email'],
    ['password sign-in', '/sign-in/email'],
    ['password reset by code', '/forget-password/email-otp'],
    ['email change', '/email-otp/request-email-change'],
  ])('does not serve %s', async (_name, path) => {
    const response = await post(build(), path, { email: 'x@example.com', password: 'p' })
    expect(response.status).toBe(404)
  })

  it('sends codes for signing in only', async () => {
    const before = outbox.length
    const response = await post(build(), '/email-otp/send-verification-otp', {
      email: 'type@example.com',
      type: 'forget-password',
    })

    expect(response.status).toBe(400)
    expect(outbox.length).toBe(before)
  })

  it('refuses a malformed address before anything is sent', async () => {
    const before = outbox.length
    const response = await post(build(), '/email-otp/send-verification-otp', {
      email: 'not-an-address',
      type: 'sign-in',
    })

    expect(response.status).toBe(400)
    expect(outbox.length).toBe(before)
  })

  it('refuses past the daily cap in our error format, with Retry-After, and sends nothing', async () => {
    const built = build({ perDay: 1 })
    await requestCode(built, 'first@example.com')
    const before = outbox.length

    const refused = await post(built, '/email-otp/send-verification-otp', {
      email: 'second@example.com',
      type: 'sign-in',
    })

    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
    const body = (await refused.json()) as { error: { code: string } }
    expect(body.error.code).toBe('RATE_LIMITED')
    expect(outbox.length).toBe(before)
  })
})
