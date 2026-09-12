import type { PublicDecisionResponse } from '@agenttrace/shared'
import { describe, expect, it } from 'vitest'
import {
  ApiNotConfigured,
  ApiUnreachable,
  createPublicApi,
  decisionQuery,
  type FetchLike,
  resolveApiBaseUrl,
} from './api'

const BASE = 'https://api.example'
const DECISION_ID = '0123456789abcdeffedcba9876543210'
const AGENT_PUBKEY = 'ab'.repeat(32)

const decisionBody: PublicDecisionResponse = {
  decisionId: DECISION_ID,
  signedManifest: null,
  anchor: {
    transactionSignature: '3VyCHjmM',
    slot: 483_807_397,
    anchoredAt: '2026-08-14T13:26:01.168Z',
  },
  archive: null,
  contentDeletedAt: null,
  verification: {
    status: 'pending',
    discrepancies: [],
    caveats: [],
    keyContinuity: 'self',
    includesChain: false,
  },
}

function serving(body: unknown, status = 200): { fetch: FetchLike; asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    fetch: async (url) => {
      asked.push(url)
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    },
  }
}

describe('resolveApiBaseUrl', () => {
  it('refuses to guess an api address', () => {
    // Дефолт на власне походження працював би локально й ламався б там, де
    // сторінка і API стоять на різних доменах.
    expect(() => resolveApiBaseUrl({})).toThrow(ApiNotConfigured)
    expect(() => resolveApiBaseUrl({ VITE_API_URL: '' })).toThrow(ApiNotConfigured)
  })

  it('refuses something that is not a url', () => {
    expect(() => resolveApiBaseUrl({ VITE_API_URL: 'localhost:8787' })).toThrow(ApiNotConfigured)
  })

  it('trims the trailing slash so paths do not double it', () => {
    expect(resolveApiBaseUrl({ VITE_API_URL: 'https://api.example/' })).toBe('https://api.example')
  })
})

describe('reading a decision', () => {
  it('asks the public route and returns what the contract promises', async () => {
    const { fetch, asked } = serving(decisionBody)
    const outcome = await createPublicApi({ baseUrl: BASE, fetch }).decision(DECISION_ID)

    expect(asked).toEqual([`${BASE}/v1/public/decisions/${DECISION_ID}`])
    expect(outcome).toEqual({ kind: 'ok', value: decisionBody })
  })

  it('passes the verdict through without strengthening it', async () => {
    /**
     * Наш API ланцюг не читає і каже це полем `includesChain`. Клієнт, який
     * «покращив» би тут стан, зробив би сторінку свідченням про саму себе.
     */
    const { fetch } = serving(decisionBody)
    const outcome = await createPublicApi({ baseUrl: BASE, fetch }).decision(DECISION_ID)

    expect(outcome.kind === 'ok' && outcome.value.verification.status).toBe('pending')
    expect(outcome.kind === 'ok' && outcome.value.verification.includesChain).toBe(false)
  })

  it('reports a decision nobody stored as not-found, not as an error', async () => {
    const { fetch } = serving({ error: { code: 'NOT_FOUND', message: 'no', details: {} } }, 404)

    expect(await createPublicApi({ baseUrl: BASE, fetch }).decision(DECISION_ID)).toEqual({
      kind: 'not-found',
    })
  })

  it('does not spend a request on an id that cannot exist', async () => {
    const { fetch, asked } = serving(decisionBody)
    const outcome = await createPublicApi({ baseUrl: BASE, fetch }).decision('not-an-id')

    expect(asked).toEqual([])
    expect(outcome).toEqual({ kind: 'not-found' })
  })

  it('treats a 5xx as "ask again", not as an answer about the decision', async () => {
    const { fetch } = serving({ error: {} }, 503)

    await expect(createPublicApi({ baseUrl: BASE, fetch }).decision(DECISION_ID)).rejects.toThrow(
      ApiUnreachable,
    )
  })

  it('treats a dead network the same way', async () => {
    const fetch: FetchLike = async () => {
      throw new TypeError('Failed to fetch')
    }

    await expect(createPublicApi({ baseUrl: BASE, fetch }).decision(DECISION_ID)).rejects.toThrow(
      ApiUnreachable,
    )
  })

  it('calls a body that breaks the contract malformed, and never a verification state', async () => {
    /**
     * Найдорожчий випадок: відповідь, яка виглядає як рішення, але не є ним.
     * Вона мусить лишитися станом **нашого API**, а не станом запису — інакше
     * помилка на нашому боці читалася б як вердикт про чужу цілісність.
     */
    const { fetch } = serving({
      ...decisionBody,
      verification: { ...decisionBody.verification, status: 'looks-fine' },
    })
    const outcome = await createPublicApi({ baseUrl: BASE, fetch }).decision(DECISION_ID)

    expect(outcome.kind).toBe('malformed')
    expect(outcome.kind === 'malformed' && outcome.detail).toContain('verification.status')
  })

  it('calls a response that is not json malformed as well', async () => {
    const { fetch } = serving('<html>gateway</html>')

    expect((await createPublicApi({ baseUrl: BASE, fetch }).decision(DECISION_ID)).kind).toBe(
      'malformed',
    )
  })
})

describe('reading the key history', () => {
  it('asks about the agent by public key', async () => {
    const body = { agentId: '00000000-0000-4000-8000-000000000000', keys: [] }
    const { fetch, asked } = serving(body)
    const outcome = await createPublicApi({ baseUrl: BASE, fetch }).agentKeys(AGENT_PUBKEY)

    expect(asked).toEqual([`${BASE}/v1/public/agents/${AGENT_PUBKEY}/keys`])
    expect(outcome).toEqual({ kind: 'ok', value: body })
  })

  it('does not spend a request on something that is not a public key', async () => {
    const { fetch, asked } = serving({})
    expect(await createPublicApi({ baseUrl: BASE, fetch }).agentKeys('nope')).toEqual({
      kind: 'not-found',
    })
    expect(asked).toEqual([])
  })
})

describe('query keys', () => {
  it('keeps decisions of different ids in different cache entries', () => {
    const api = createPublicApi({ baseUrl: BASE })

    expect(decisionQuery(api, DECISION_ID).queryKey).not.toEqual(
      decisionQuery(api, 'ff'.repeat(16)).queryKey,
    )
  })
})
