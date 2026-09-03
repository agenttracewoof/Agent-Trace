import { HTTPException } from 'hono/http-exception'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createApp } from './app.js'
import { AppError, type ErrorBody } from './errors.js'
import { silentLogger } from './logger.js'

const app = createApp({ logger: silentLogger() })

/** Маршрути, які існують лише щоб подивитись, як каркас поводиться з падінням. */
app.get('/boom/app', () => {
  throw new AppError('RATE_LIMITED', 'Daily quota exhausted', { limit: 10_000 })
})
app.get('/boom/zod', () => {
  z.object({ decisionId: z.string() }).parse({})
  return new Response('unreachable')
})
app.get('/boom/http', () => {
  throw new HTTPException(401, { message: 'Missing ingest key' })
})
app.get('/boom/unknown', () => {
  throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2')
})

const body = async (path: string) => {
  const response = await app.request(path)
  return { response, json: (await response.json()) as ErrorBody }
}

describe('/health', () => {
  it('answers without any dependency of its own', async () => {
    const response = await app.request('/health')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ok', service: 'api' })
  })

  it('claims nothing it has not checked', async () => {
    // `checks` порожній навмисно: база тут не перевіряється, і поки це так,
    // ендпоінт не має права виглядати як готовність до роботи (T061).
    const response = await app.request('/health')
    expect(await response.json()).toMatchObject({ checks: {} })
  })
})

describe('формат помилки — один на всі відповіді', () => {
  it('answers an unknown route in the standard shape', async () => {
    const { response, json } = await body('/nope')
    expect(response.status).toBe(404)
    expect(json.error.code).toBe('NOT_FOUND')
    expect(json.error.details).toBeTypeOf('object')
  })

  it('carries a deliberate error through with its own status and details', async () => {
    const { response, json } = await body('/boom/app')
    expect(response.status).toBe(429)
    expect(json.error.code).toBe('RATE_LIMITED')
    expect(json.error.message).toBe('Daily quota exhausted')
    expect(json.error.details).toMatchObject({ limit: 10_000 })
  })

  it('turns a validation failure into INVALID_INPUT with its issues', async () => {
    const { response, json } = await body('/boom/zod')
    expect(response.status).toBe(400)
    expect(json.error.code).toBe('INVALID_INPUT')
    expect(Array.isArray(json.error.details.issues)).toBe(true)
  })

  it('maps an HTTP exception onto the code that matches its status', async () => {
    const { response, json } = await body('/boom/http')
    expect(response.status).toBe(401)
    expect(json.error.code).toBe('UNAUTHORIZED')
  })

  it('always includes details as an object, never as a missing field', async () => {
    for (const path of ['/nope', '/boom/http', '/boom/unknown']) {
      const { json } = await body(path)
      expect(json.error.details).toBeTypeOf('object')
    }
  })
})

describe('неочікувана помилка нічого не розповідає', () => {
  it('answers INTERNAL without leaking the original message', async () => {
    const { response, json } = await body('/boom/unknown')
    expect(response.status).toBe(500)
    expect(json.error.code).toBe('INTERNAL')
    expect(json.error.message).toBe('Internal error')
  })

  it('leaks neither the host, the port nor the password it was carrying', async () => {
    // Текст неочікуваної помилки — найчастіше місце, де назовні їде фрагмент
    // підключення. Тут він навмисно містить і адресу, і пароль.
    const { json } = await body('/boom/unknown')
    const serialised = JSON.stringify(json)
    expect(serialised).not.toContain('hunter2')
    expect(serialised).not.toContain('10.0.0.5')
    expect(serialised).not.toContain('ECONNREFUSED')
  })

  it('hands back the request id so the event can be found in the log', async () => {
    const { response, json } = await body('/boom/unknown')
    expect(json.error.details.requestId).toBe(response.headers.get('X-Request-Id'))
  })
})

describe('ідентифікатор запиту', () => {
  it('is issued on every response, including the successful ones', async () => {
    const response = await app.request('/health')
    expect(response.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('differs between requests', async () => {
    const [first, second] = await Promise.all([app.request('/health'), app.request('/health')])
    expect(first.headers.get('X-Request-Id')).not.toBe(second.headers.get('X-Request-Id'))
  })

  it('ignores whatever the caller supplied', async () => {
    // Приймати чужий id означало б дозволити клієнту писати в наші логи те,
    // що він захоче, — включно з підробленим id чужого запиту.
    const response = await app.request('/health', {
      headers: { 'X-Request-Id': 'injected-by-caller' },
    })
    expect(response.headers.get('X-Request-Id')).not.toBe('injected-by-caller')
  })
})
