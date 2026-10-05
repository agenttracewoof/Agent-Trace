import { describe, expect, it } from 'vitest'
import {
  createDashboardApi,
  DashboardError,
  envLine,
  isSignedOut,
  journalSearch,
  refusalMessage,
  retryUnreachable,
} from './dashboard'

const BASE = 'https://api.agenttrace.example'
const PROJECT = {
  id: '6f1c1d9e-3b0a-4c39-9a51-0d3c2b7e8f10',
  name: 'Support agent',
  role: 'owner',
  dailyQuota: 100,
  createdAt: '2026-10-03T12:00:00.000Z',
}
const KEY = `atk_${'ab'.repeat(32)}`

interface Seen {
  url: string
  init: RequestInit
}

function fakeFetch(status: number, body: unknown) {
  const seen: Seen[] = []
  const fetch = async (url: string, init: RequestInit) => {
    seen.push({ url, init })
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { seen, fetch }
}

async function refusal(promise: Promise<unknown>): Promise<DashboardError> {
  try {
    await promise
  } catch (cause) {
    if (cause instanceof DashboardError) return cause
    throw cause
  }
  throw new Error('expected a refusal')
}

describe('the dashboard client', () => {
  it('sends the session cookie on every call — the API is another site', async () => {
    const { seen, fetch } = fakeFetch(200, { projects: [PROJECT], maxOwnedProjects: 3 })
    await createDashboardApi({ baseUrl: BASE, fetch }).projects()

    expect(seen[0]?.url).toBe(`${BASE}/v1/projects`)
    expect(seen[0]?.init.credentials).toBe('include')
  })

  it('asks for a sign-in code, never any other kind', async () => {
    const { seen, fetch } = fakeFetch(200, { success: true })
    await createDashboardApi({ baseUrl: BASE, fetch }).sendCode('op@example.com')

    expect(seen[0]?.url).toBe(`${BASE}/v1/auth/email-otp/send-verification-otp`)
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({
      email: 'op@example.com',
      type: 'sign-in',
    })
  })

  it('reads a signed-out session as null, not as a failure', async () => {
    const { fetch } = fakeFetch(200, null)
    expect(await createDashboardApi({ baseUrl: BASE, fetch }).session()).toBeNull()
  })

  it('returns the key from creation and from replacement', async () => {
    const created = fakeFetch(201, { project: PROJECT, ingestKey: KEY })
    const api = createDashboardApi({ baseUrl: BASE, fetch: created.fetch })
    expect((await api.createProject('Support agent')).ingestKey).toBe(KEY)

    const replaced = fakeFetch(200, { ingestKey: KEY })
    const again = createDashboardApi({ baseUrl: BASE, fetch: replaced.fetch })
    await again.reissueKey(PROJECT.id)
    expect(replaced.seen[0]?.url).toBe(`${BASE}/v1/projects/${PROJECT.id}/ingest-key`)
    expect(replaced.seen[0]?.init.method).toBe('POST')
  })

  it('refuses an answer that is not the contract, rather than showing it', async () => {
    const { fetch } = fakeFetch(201, { project: PROJECT })
    const error = await refusal(createDashboardApi({ baseUrl: BASE, fetch }).createProject('x'))
    expect(error.message).toMatch(/shape/)
  })

  it('carries our refusal sentence through to the form', async () => {
    const { fetch } = fakeFetch(400, {
      error: {
        code: 'INVALID_INPUT',
        message: 'This account already owns as many projects as it may',
        details: { reason: 'projects-per-account', limit: 3 },
      },
    })
    const error = await refusal(createDashboardApi({ baseUrl: BASE, fetch }).createProject('x'))
    expect(error).toMatchObject({ status: 400, message: expect.stringMatching(/already owns/) })
  })

  it('tells an unreachable API apart from an answer', async () => {
    const api = createDashboardApi({
      baseUrl: BASE,
      fetch: async () => {
        throw new TypeError('Failed to fetch')
      },
    })
    const error = await refusal(api.projects())
    expect(error.status).toBeUndefined()
    expect(retryUnreachable(0, error)).toBe(true)
    expect(retryUnreachable(2, error)).toBe(false)
  })
})

describe('refusalMessage', () => {
  it('words better-auth’s codes as advice', () => {
    expect(refusalMessage(400, { message: 'Invalid OTP', code: 'INVALID_OTP' })).toMatch(
      /not right/,
    )
    expect(refusalMessage(400, { message: 'Something new', code: 'NEW_CODE' })).toBe(
      'Something new',
    )
  })

  it('says the mail failed when it did, and does not echo "Internal error"', () => {
    const notSent = {
      error: {
        code: 'INTERNAL',
        message: 'A sign-in code could not be sent to this address',
        details: {},
      },
    }
    expect(refusalMessage(500, notSent)).toBe('A sign-in code could not be sent to this address')
    expect(
      refusalMessage(500, { error: { code: 'INTERNAL', message: 'Internal error', details: {} } }),
    ).toMatch(/on our side/)
  })

  it('falls back to the status for a body it cannot read', () => {
    expect(refusalMessage(502, null)).toMatch(/502/)
  })
})

describe('retry and session helpers', () => {
  it('never retries an answer, and recognises a session that ended', () => {
    const unauthorised = new DashboardError('Sign in to continue', 401)
    expect(retryUnreachable(0, unauthorised)).toBe(false)
    expect(isSignedOut(unauthorised)).toBe(true)
    expect(isSignedOut(new DashboardError('x', 400))).toBe(false)
  })

  it('puts the key under the name the SDK reads', () => {
    expect(envLine(KEY)).toBe(`AGENTTRACE_INGEST_KEY=${KEY}`)
  })
})

describe("the journal's calls (T042)", () => {
  it("asks for the project's agents under the project", async () => {
    const agent = {
      id: '0b8e7f2a-5d1c-4e3b-9a6f-1c2d3e4f5a6b',
      externalId: 'support-bot',
      name: 'Support bot',
      createdAt: '2026-10-03T12:00:00.000Z',
    }
    const { seen, fetch } = fakeFetch(200, { agents: [agent], truncated: false })
    const body = await createDashboardApi({ baseUrl: BASE, fetch }).agents(PROJECT.id)

    expect(seen[0]?.url).toBe(`${BASE}/v1/projects/${PROJECT.id}/agents`)
    expect(seen[0]?.init.credentials).toBe('include')
    expect(body.agents).toEqual([agent])
  })

  it('sends only the filters that are set, the cursor as given', async () => {
    const { seen, fetch } = fakeFetch(200, { decisions: [], nextCursor: null })
    await createDashboardApi({ baseUrl: BASE, fetch }).journal(PROJECT.id, {
      status: 'failed',
      from: 0,
      cursor: 'MTc1OTY2:ab+/=',
    })

    const url = new URL(seen[0]?.url ?? '')
    expect(url.pathname).toBe(`/v1/projects/${PROJECT.id}/decisions`)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      status: 'failed',
      from: '0',
      cursor: 'MTc1OTY2:ab+/=',
    })
  })

  it('asks for one decision under its project and refuses an answer it does not know', async () => {
    const { seen, fetch } = fakeFetch(200, { decisionId: 'ab'.repeat(16) })
    const error = await refusal(
      createDashboardApi({ baseUrl: BASE, fetch }).decision(PROJECT.id, 'ab'.repeat(16)),
    )
    expect(seen[0]?.url).toBe(`${BASE}/v1/projects/${PROJECT.id}/decisions/${'ab'.repeat(16)}`)
    expect(error.message).toBe('The service answered in a shape this page does not know.')
  })

  it('carries a 404 for a decision the project does not have', async () => {
    const { fetch } = fakeFetch(404, {
      error: { code: 'NOT_FOUND', message: 'Decision not found' },
    })
    const error = await refusal(
      createDashboardApi({ baseUrl: BASE, fetch }).decision(PROJECT.id, 'ab'.repeat(16)),
    )
    expect(error.status).toBe(404)
  })

  it('has no query string when nothing filters', () => {
    expect(journalSearch({})).toBe('')
  })

  it('refuses a journal answer it does not know', async () => {
    const { fetch } = fakeFetch(200, { decisions: 'none' })
    const error = await refusal(
      createDashboardApi({ baseUrl: BASE, fetch }).journal(PROJECT.id, {}),
    )
    expect(error.message).toBe('The service answered in a shape this page does not know.')
  })
})
