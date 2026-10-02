import { accounts, sessions, users, verifications } from '@agenttrace/db'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { emailOTP } from 'better-auth/plugins'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { z } from 'zod'
import type { Variables } from './app.js'
import { clientAddress, createSendCodeGuard } from './auth-limits.js'
import { AppError } from './errors.js'
import { CODE_TTL_MINUTES, type SendSignInCode } from './mailer.js'

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
        sendVerificationOTP: ({ email, otp }) => config.sendCode(email, otp),
      }),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>

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
  router.use(
    '/auth/*',
    cors({
      origin: options.webOrigin,
      credentials: true,
      allowMethods: ['GET', 'POST'],
      allowHeaders: ['Content-Type'],
    }),
  )

  /**
   * The CSRF check `PLAN.md` asks for on cookie sessions. better-auth has its
   * own, but applies it only to requests that already carry a cookie; the
   * sign-in routes are called before there is one, and a foreign page must not
   * be able to spend our email quota either. Every caller of these routes is
   * the dashboard, and a browser always sends `Origin` on a POST.
   */
  router.post('/auth/*', async (c, next) => {
    if (c.req.header('origin') !== options.webOrigin) {
      throw new AppError('UNAUTHORIZED', 'Request origin is not allowed')
    }
    await next()
  })

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

    return handle(c.req.raw)
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
