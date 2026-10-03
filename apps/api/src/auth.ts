import { AsyncLocalStorage } from 'node:async_hooks'
import { accounts, sessions, users, verifications } from '@agenttrace/db'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { emailOTP } from 'better-auth/plugins'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Variables } from './app.js'
import { clientAddress, createSendCodeGuard } from './auth-limits.js'
import { AppError } from './errors.js'
import { CODE_TTL_MINUTES, type SendSignInCode } from './mailer.js'
import {
  dashboardCors,
  requireDashboardOrigin,
  type SessionLookup,
} from './middleware/dashboard.js'

export const AUTH_BASE_PATH = '/v1/auth'

export interface AuthConfig {
  /** Signs session cookies; at least 32 characters, better-auth refuses less. */
  readonly secret: string
  /** Public URL of this API, the origin cookies are issued for. */
  readonly baseUrl: string
  /** Origin of the dashboard — the only page allowed to call these routes with credentials. */
  readonly webOrigin: string
  readonly sendCode: SendSignInCode
}

/**
 * The dashboard is served from GitHub Pages and the API from Render: two
 * different sites. A `SameSite=Lax` cookie is not sent on a cross-site fetch,
 * so sign-in would work on localhost (one site) and silently fail in
 * production. Across sites the cookie is `SameSite=None; Partitioned` (CHIPS):
 * it still never leaves our API, and it is keyed to the dashboard as the
 * top-level site, so no other page that embeds or calls us can use it.
 *
 * Hosts are compared, not registrable domains: two subdomains of one domain
 * also get the partitioned cookie, which works there too — only `Lax` would
 * be the stricter choice, and it can wait until such a domain exists.
 */
export function isCrossSite(baseUrl: string, webOrigin: string): boolean {
  return new URL(baseUrl).hostname !== new URL(webOrigin).hostname
}

/**
 * better-auth awaits the mailer but catches what it throws, logs it and still
 * answers `200 {"success":true}` — so an address our provider refuses (any
 * stranger's, until the domain is verified in Resend) would be told a code is
 * on its way. This side channel carries the failure from inside the library
 * back to `authRoutes`, scoped to the one request that sent the code.
 */
const sendAttempt = new AsyncLocalStorage<{ failed: boolean }>()

/** Whatever drizzle database the adapter accepts: postgres-js in production, PGlite in tests. */
type AuthDatabase = Parameters<typeof drizzleAdapter>[0]

export function createAuth(db: AuthDatabase, config: AuthConfig) {
  const crossSite = isCrossSite(config.baseUrl, config.webOrigin)

  return betterAuth({
    appName: 'AgentTrace',
    secret: config.secret,
    baseURL: config.baseUrl,
    basePath: AUTH_BASE_PATH,
    trustedOrigins: [config.webOrigin],
    database: drizzleAdapter(db, {
      provider: 'pg',
      usePlural: true,
      schema: { users, sessions, accounts, verifications },
    }),
    // Its limiter keys on the first `x-forwarded-for` entry, which the caller
    // writes; ours (`auth-limits.ts`) counts from the edge instead.
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
    advanced: {
      // Its default turns the origin check off whenever it detects a test
      // runner, so the tests would pass against a server production never runs.
      disableOriginCheck: false,
      database: { generateId: 'uuid' },
      // Nothing reads it, and an address kept is personal data kept.
      ipAddress: { disableIpTracking: true },
      ...(crossSite
        ? { defaultCookieAttributes: { sameSite: 'none', secure: true, partitioned: true } }
        : {}),
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: CODE_TTL_MINUTES * 60,
        allowedAttempts: 3,
        // A database read must not hand out working codes.
        storeOTP: 'hashed',
        sendVerificationOTP: async ({ email, otp }) => {
          try {
            await config.sendCode(email, otp)
          } catch (cause) {
            const attempt = sendAttempt.getStore()
            if (attempt !== undefined) attempt.failed = true
            throw cause
          }
        },
      }),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>

/** The session behind a request's cookie, as `sessionAuth` asks for it. */
export const sessionUserOf =
  (auth: Auth): SessionLookup =>
  async (headers) =>
    (await auth.api.getSession({ headers }))?.user.id

/**
 * Only `sign-in`: the other code types belong to password and email-change
 * flows we do not offer, and each of them would be one more way to make us
 * send mail.
 */
const sendCodeRequestSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  type: z.literal('sign-in'),
})

export interface AuthRoutesOptions {
  readonly webOrigin: string
  readonly guard?: ReturnType<typeof createSendCodeGuard>
  /** Overridden in tests only. */
  readonly socketAddress?: (request: Request) => string | undefined
}

/**
 * An allow-list of better-auth's endpoints, not a catch-all. The library
 * serves dozens — password sign-up, password reset, email change — and every
 * one we do not route is one that cannot be abused or forgotten about.
 */
export function authRoutes(auth: Auth, options: AuthRoutesOptions) {
  const router = new Hono<{ Variables: Variables }>()
  const guard = options.guard ?? createSendCodeGuard()
  const handle = (request: Request) => auth.handler(request)

  // Mounted on `/auth/*`, not `*`: a star here would cover every `/v1` route
  // of every router (see `agents.ts`).
  router.use('/auth/*', dashboardCors(options.webOrigin))

  /**
   * better-auth has an origin check of its own, but applies it only to
   * requests that already carry a cookie; the sign-in routes are called before
   * there is one, and a foreign page must not be able to spend our email quota
   * either.
   */
  router.use('/auth/*', requireDashboardOrigin(options.webOrigin))

  router.post('/auth/email-otp/send-verification-otp', async (c) => {
    // A clone: better-auth reads the body itself, and a consumed one is gone.
    const body = sendCodeRequestSchema.parse(
      await c.req.raw
        .clone()
        .json()
        .catch(() => null),
    )
    const address = clientAddress(
      c.req.header('x-forwarded-for'),
      options.socketAddress?.(c.req.raw),
    )

    const verdict = guard(address, body.email)
    if (!verdict.allowed) {
      c.header('Retry-After', String(verdict.retryAfterSeconds))
      throw new AppError('RATE_LIMITED', REFUSALS[verdict.reason], {
        retryAfterSeconds: verdict.retryAfterSeconds,
      })
    }

    const attempt = { failed: false }
    const response = await sendAttempt.run(attempt, () => handle(c.req.raw))
    if (attempt.failed) {
      throw new AppError('INTERNAL', 'A sign-in code could not be sent to this address')
    }
    return response
  })
  router.post('/auth/sign-in/email-otp', (c) => handle(c.req.raw))
  router.get('/auth/get-session', (c) => handle(c.req.raw))
  router.post('/auth/sign-out', (c) => handle(c.req.raw))

  return router
}

const REFUSALS = {
  address: 'Too many sign-in codes requested from this address',
  email: 'A code was just sent to this address; wait before asking for another',
  day: 'Sign-in codes are paused until 00:00 UTC',
} as const
