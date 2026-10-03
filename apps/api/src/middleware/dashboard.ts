import type { MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'
import type { Variables } from '../app.js'
import { AppError } from '../errors.js'

/**
 * What every route the dashboard calls with its session cookie shares: the
 * sign-in routes of `auth.ts` and the project routes of T078. Each is mounted
 * on its own path, never `*` — a star in a router mounted on `/v1` covers every
 * route of every router (see `agents.ts`).
 */

/** The dashboard is the one origin allowed to send the cookie and read the answer. */
export const dashboardCors = (webOrigin: string): MiddlewareHandler =>
  cors({
    origin: webOrigin,
    credentials: true,
    allowMethods: ['GET', 'POST'],
    allowHeaders: ['Content-Type'],
  })

/**
 * The CSRF check `PLAN.md` asks for on cookie sessions. The cookie is
 * `SameSite=None` across our two sites (`auth.ts`), so the browser attaches it
 * to a POST from any page; `Origin`, which a browser always sends on a POST and
 * a page cannot forge, is what tells the dashboard apart. GETs change nothing
 * and CORS keeps their answers from a foreign page.
 */
export const requireDashboardOrigin =
  (webOrigin: string): MiddlewareHandler =>
  async (c, next) => {
    if (c.req.method === 'POST' && c.req.header('origin') !== webOrigin) {
      throw new AppError('UNAUTHORIZED', 'Request origin is not allowed')
    }
    await next()
  }

/** Resolves the session cookie in these headers to a user id, if it opens one. */
export type SessionLookup = (headers: Headers) => Promise<string | undefined>

/**
 * A route behind this has `userId` set. No cache, for the reason `ingestAuth`
 * has none: a signed-out session must stop working on the next request.
 */
export const sessionAuth =
  (lookup: SessionLookup): MiddlewareHandler<{ Variables: Variables }> =>
  async (c, next) => {
    const userId = await lookup(c.req.raw.headers)
    if (userId === undefined) {
      throw new AppError('UNAUTHORIZED', 'Sign in to continue')
    }
    c.set('userId', userId)
    await next()
  }
