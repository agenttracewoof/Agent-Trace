import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import type { ErrorBody } from '../errors.js'
import { generateIngestKey, hashIngestKey, INGEST_KEY_PREFIX } from '../ingest-key.js'
import { silentLogger } from '../logger.js'
import { ingestAuth, type ProjectContext, type ProjectLookup } from './auth.js'

const PROJECT: ProjectContext = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'demo',
  dailyQuota: 10_000,
  hotWindowDays: 14,
}

function appWith(lookup: ProjectLookup) {
  const app = createApp({ logger: silentLogger() })
  app.use('/v1/*', ingestAuth(lookup))
  app.post('/v1/decisions', (c) => c.json({ projectId: c.get('project').id }))
  return app
}

/** Приймає рівно один ключ, як зробила б база з одним проєктом. */
function lookupFor(key: string) {
  const known = hashIngestKey(key)
  return vi.fn<ProjectLookup>(async (hash) => (hash === (await known) ? PROJECT : undefined))
}

const post = (app: ReturnType<typeof appWith>, headers: Record<string, string> = {}) =>
  app.request('/v1/decisions', { method: 'POST', headers })

const bearer = (key: string) => ({ authorization: `Bearer ${key}` })

describe('ingest-авторизація пропускає', () => {
  it('a request carrying a key the lookup knows', async () => {
    const key = generateIngestKey()
    const response = await post(appWith(lookupFor(key)), bearer(key))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ projectId: PROJECT.id })
  })

  it('a scheme spelled in another case, as the header is defined to be', async () => {
    const key = generateIngestKey()
    const response = await post(appWith(lookupFor(key)), { authorization: `bearer ${key}` })

    expect(response.status).toBe(200)
  })

  it('the hash of the key and never the key itself into the lookup', async () => {
    // Це і є «зберігання хешем» з боку читання: якщо сюди колись поїде сам
    // ключ, він опиниться у запиті до бази, у плані й у логах повільних запитів.
    const key = generateIngestKey()
    const lookup = lookupFor(key)
    await post(appWith(lookup), bearer(key))

    expect(lookup).toHaveBeenCalledWith(await hashIngestKey(key))
    expect(lookup).not.toHaveBeenCalledWith(expect.stringContaining(INGEST_KEY_PREFIX))
  })
})

describe('ingest-авторизація відмовляє', () => {
  const refuses = async (headers: Record<string, string>) => {
    const lookup = vi.fn<ProjectLookup>(async () => PROJECT)
    const response = await post(appWith(lookup), headers)
    const json = (await response.json()) as ErrorBody
    return { status: response.status, json, lookup }
  }

  it.each([
    ['no authorization header at all', {}],
    ['an empty authorization header', { authorization: '' }],
    ['another scheme', { authorization: `Basic ${INGEST_KEY_PREFIX}${'ab'.repeat(32)}` }],
    ['a bare key without the scheme', { authorization: `${INGEST_KEY_PREFIX}${'ab'.repeat(32)}` }],
    ['a key of the wrong shape', { authorization: 'Bearer not-a-key' }],
    [
      'a key of the right length but the wrong alphabet',
      bearer(`${INGEST_KEY_PREFIX}${'zz'.repeat(32)}`),
    ],
  ])('a request with %s, without asking the database', async (_name, headers) => {
    const { status, json, lookup } = await refuses(headers)

    expect(status).toBe(401)
    expect(json.error.code).toBe('UNAUTHORIZED')
    // Ключ неправильної форми не існує в жодному проєкті за побудовою, тож
    // запит до бази на такому вході — це безкоштовний спосіб її навантажити.
    expect(lookup).not.toHaveBeenCalled()
  })

  it('a well-formed key that belongs to no project', async () => {
    const lookup = vi.fn<ProjectLookup>(async () => undefined)
    const response = await post(appWith(lookup), bearer(generateIngestKey()))

    expect(response.status).toBe(401)
    expect(lookup).toHaveBeenCalledOnce()
  })

  it('in the standard error shape, so the SDK reads it like any other failure', async () => {
    const { json } = await refuses({})

    expect(json.error.details).toBeTypeOf('object')
    expect(json.error.message).toBeTypeOf('string')
  })
})

describe('відмова нічого не розповідає', () => {
  it('never echoes the key back, neither in the body nor in a header', async () => {
    // Відповідь 401 читають і логують клієнти — SDK кладе її текст у `onError`.
    // Ключ, який повернувся у ній, опиняється в чужому лозі назавжди.
    const key = generateIngestKey()
    const response = await post(appWith(vi.fn<ProjectLookup>(async () => undefined)), bearer(key))
    const seen = `${JSON.stringify(await response.json())}${JSON.stringify([...response.headers])}`

    expect(seen).not.toContain(key)
    expect(seen).not.toContain(key.slice(INGEST_KEY_PREFIX.length))
  })

  it('answers the same status whether the key is unknown or missing', async () => {
    const unknown = await post(
      appWith(vi.fn<ProjectLookup>(async () => undefined)),
      bearer(generateIngestKey()),
    )
    const missing = await post(appWith(vi.fn<ProjectLookup>(async () => PROJECT)))

    expect(unknown.status).toBe(missing.status)
  })
})
