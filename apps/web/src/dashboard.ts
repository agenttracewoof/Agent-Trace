import {
  type CreateProjectResponse,
  createProjectResponseSchema,
  type DecisionDetailsResponse,
  decisionDetailsResponseSchema,
  type JournalQuery,
  type JournalResponse,
  journalResponseSchema,
  type ListProjectsResponse,
  listProjectsResponseSchema,
  type ProjectAgentsResponse,
  projectAgentsResponseSchema,
  type ReissueIngestKeyResponse,
  reissueIngestKeyResponseSchema,
} from '@agenttrace/shared'
import { z } from 'zod'
import type { FetchLike } from './api'

/**
 * The dashboard's client (T079): sign-in by email code, and the projects of
 * T078. Unlike `api.ts` it sends a cookie — the session better-auth issues as
 * `SameSite=None; Partitioned`, because the page (GitHub Pages) and the API
 * (Render) are two sites. `credentials: 'include'` is what makes the browser
 * send it; the API answers only the dashboard's origin (CORS in `auth.ts`).
 *
 * Every failure is a `DashboardError` with a sentence a person can act on:
 * this client is read by an operator at a form, not by a retry loop.
 */

const REQUEST_TIMEOUT_MS = 15_000

export class DashboardError extends Error {
  /** `undefined` when the API was never reached. */
  readonly status: number | undefined

  constructor(message: string, status: number | undefined) {
    super(message)
    this.name = 'DashboardError'
    this.status = status
  }
}

/**
 * Two shapes of refusal reach this page: ours (`errors.ts`) from every route
 * we wrote, and better-auth's `{ message, code }` from the sign-in routes it
 * answers itself — a wrong code, for one.
 */
const ourError = z.object({ error: z.object({ code: z.string(), message: z.string() }) })
const libraryError = z.object({ message: z.string(), code: z.string().optional() })

/** better-auth's codes, in words that tell the operator what to do next. */
const LIBRARY_MESSAGES: Readonly<Record<string, string>> = {
  INVALID_OTP: 'That code is not right. Check the email and try again.',
  OTP_EXPIRED: 'That code has expired. Ask for a new one.',
  TOO_MANY_ATTEMPTS: 'Too many wrong codes. Ask for a new one.',
}

export function refusalMessage(status: number, body: unknown): string {
  const ours = ourError.safeParse(body)
  if (ours.success) {
    // A 500 we did not mean to send says "Internal error"; that is not advice.
    return ours.data.error.code === 'INTERNAL' && ours.data.error.message === 'Internal error'
      ? 'Something failed on our side. Try again in a minute.'
      : ours.data.error.message
  }
  const library = libraryError.safeParse(body)
  if (library.success) {
    return LIBRARY_MESSAGES[library.data.code ?? ''] ?? library.data.message
  }
  return `The service answered ${status}. Try again in a minute.`
}

export interface DashboardConfig {
  readonly baseUrl: string
  readonly fetch?: FetchLike
}

async function call(
  config: DashboardConfig,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<unknown> {
  const fetchImpl = config.fetch ?? ((url, init) => fetch(url, init))

  let response: Response
  try {
    response = await fetchImpl(`${config.baseUrl}${path}`, {
      method,
      credentials: 'include',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch {
    throw new DashboardError(
      'The service did not answer. Check the connection and retry.',
      undefined,
    )
  }

  const parsed: unknown = await response.json().catch(() => null)
  if (!response.ok)
    throw new DashboardError(refusalMessage(response.status, parsed), response.status)
  return parsed
}

function parseAs<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new DashboardError('The service answered in a shape this page does not know.', 200)
  }
  return parsed.data
}

/** Just what the page shows; better-auth's session carries more. */
const sessionSchema = z.object({ user: z.object({ email: z.string() }) }).nullable()

export type Session = z.infer<typeof sessionSchema>

export interface DashboardApi {
  sendCode(email: string): Promise<void>
  signIn(email: string, code: string): Promise<void>
  /** `null` when signed out — an answer, not a failure. */
  session(): Promise<Session>
  signOut(): Promise<void>
  projects(): Promise<ListProjectsResponse>
  createProject(name: string): Promise<CreateProjectResponse>
  reissueKey(projectId: string): Promise<ReissueIngestKeyResponse>
  agents(projectId: string): Promise<ProjectAgentsResponse>
  journal(projectId: string, query: JournalQuery): Promise<JournalResponse>
  decision(projectId: string, decisionId: string): Promise<DecisionDetailsResponse>
}

/** The journal's query string; a filter left unset is left out, not sent empty. */
export function journalSearch(query: JournalQuery): string {
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) params.set(name, String(value))
  }
  const search = params.toString()
  return search === '' ? '' : `?${search}`
}

export function createDashboardApi(config: DashboardConfig): DashboardApi {
  return {
    sendCode: async (email) => {
      await call(config, 'POST', '/v1/auth/email-otp/send-verification-otp', {
        email,
        type: 'sign-in',
      })
    },
    signIn: async (email, code) => {
      await call(config, 'POST', '/v1/auth/sign-in/email-otp', { email, otp: code })
    },
    session: async () => parseAs(sessionSchema, await call(config, 'GET', '/v1/auth/get-session')),
    signOut: async () => {
      await call(config, 'POST', '/v1/auth/sign-out', {})
    },
    projects: async () =>
      parseAs(listProjectsResponseSchema, await call(config, 'GET', '/v1/projects')),
    createProject: async (name) =>
      parseAs(createProjectResponseSchema, await call(config, 'POST', '/v1/projects', { name })),
    reissueKey: async (projectId) =>
      parseAs(
        reissueIngestKeyResponseSchema,
        await call(config, 'POST', `/v1/projects/${encodeURIComponent(projectId)}/ingest-key`),
      ),
    agents: async (projectId) =>
      parseAs(
        projectAgentsResponseSchema,
        await call(config, 'GET', `/v1/projects/${encodeURIComponent(projectId)}/agents`),
      ),
    decision: async (projectId, decisionId) =>
      parseAs(
        decisionDetailsResponseSchema,
        await call(
          config,
          'GET',
          `/v1/projects/${encodeURIComponent(projectId)}/decisions/${encodeURIComponent(decisionId)}`,
        ),
      ),
    journal: async (projectId, query) =>
      parseAs(
        journalResponseSchema,
        await call(
          config,
          'GET',
          `/v1/projects/${encodeURIComponent(projectId)}/decisions${journalSearch(query)}`,
        ),
      ),
  }
}

/** The lines an operator pastes into the agent's environment (`packages/sdk/README.md`). */
export const envLine = (ingestKey: string): string => `AGENTTRACE_INGEST_KEY=${ingestKey}`

/**
 * Retry what never reached the API, twice; never an answer. A 401 retried is
 * the same 401 two round trips later, and a refused form is not a network blip.
 */
export const retryUnreachable = (failures: number, cause: Error): boolean =>
  failures < 2 && cause instanceof DashboardError && cause.status === undefined

export const isSignedOut = (cause: unknown): boolean =>
  cause instanceof DashboardError && cause.status === 401

export const sessionQueryKey = ['dashboard-session'] as const
export const projectsQueryKey = ['dashboard-projects'] as const
export const agentsQueryKey = (projectId: string) => ['dashboard-agents', projectId] as const
export const decisionDetailsQueryKey = (projectId: string, decisionId: string) =>
  ['dashboard-decision', projectId, decisionId] as const
export const journalQueryKey = (projectId: string, query: JournalQuery) =>
  ['dashboard-journal', projectId, query] as const
