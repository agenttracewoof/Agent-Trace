import {
  type PublicAgentKeysResponse,
  type PublicDecisionResponse,
  publicAgentKeysResponseSchema,
  publicDecisionResponseSchema,
} from '@agenttrace/shared'
import type { z } from 'zod'

/**
 * Клієнт публічного читання (FR-011, FR-012) — єдиний код сторінки, який
 * розмовляє з нашим API. Він навмисно не вміє нічого, крім двох маршрутів без
 * авторизації: усе решта на цій сторінці або приходить з ланцюга (T034/T035),
 * або не показується взагалі.
 *
 * **Наш API ніколи не каже `verified`** — він ланцюг не читає і сам це визнає
 * полем `includesChain: false`. Клієнт цього не «покращує»: те, що прийшло,
 * доходить до компонента незміненим, а найсильніше, що звідси буває, — `pending`.
 */

/** Скільки чекати відповіді, перш ніж вважати наш сервіс недоступним. */
const REQUEST_TIMEOUT_MS = 10_000

/**
 * Відповідь розділена на чотири випадки, а не на «дані або помилка». Різниця не
 * косметична: «такого рішення немає», «наш сервіс не відповів» і «сервіс відповів
 * не за контрактом» — три різні речі, і жодна з них не є станом перевірки.
 * Показати будь-яку з них як стан рішення означало б сказати щось про запис,
 * не подивившись на нього.
 */
export type ApiOutcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'malformed'; readonly detail: string }

/**
 * Кидається лише на тимчасовій недоступності — саме тому це виняток, а не
 * варіант `ApiOutcome`: react-query повторить запит сам, а «немає такого
 * рішення» повторювати нема сенсу.
 */
export class ApiUnreachable extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'ApiUnreachable'
  }
}

export class ApiNotConfigured extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApiNotConfigured'
  }
}

/**
 * Адреса API приходить складанням (`VITE_API_URL`) і дефолту не має. Дефолт на
 * власне походження сторінки виглядав би працюючим на локальній машині й тихо
 * ламався б там, де сторінка й API стоять на різних доменах, — тобто скрізь,
 * де це насправді використовують.
 */
export function resolveApiBaseUrl(env: Readonly<Record<string, unknown>>): string {
  const value = env.VITE_API_URL
  if (typeof value !== 'string' || value === '') {
    throw new ApiNotConfigured('VITE_API_URL is not set: the page has no API to read from')
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new ApiNotConfigured(`VITE_API_URL is not a url: ${value}`)
  }
  /**
   * Схема перевіряється окремо, бо `new URL` її не рятує: `localhost:8787` —
   * цілком валідний URL зі схемою `localhost:`, і саме так виглядає найчастіша
   * помилка в цьому полі. Без цієї перевірки вона доїхала б до людини у вигляді
   * «сервіс недоступний».
   */
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ApiNotConfigured(`VITE_API_URL must be an http(s) url: ${value}`)
  }
  return value.replace(/\/+$/, '')
}

export const isDecisionId = (value: string): boolean => /^[0-9a-f]{32}$/.test(value)
export const isAgentPubkey = (value: string): boolean => /^[0-9a-f]{64}$/.test(value)

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface PublicApiConfig {
  readonly baseUrl: string
  readonly fetch?: FetchLike
}

async function read<T>(
  config: PublicApiConfig,
  path: string,
  schema: z.ZodType<T>,
): Promise<ApiOutcome<T>> {
  const fetchImpl = config.fetch ?? ((url, init) => fetch(url, init))

  let response: Response
  try {
    response = await fetchImpl(`${config.baseUrl}${path}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    })
  } catch (cause) {
    throw new ApiUnreachable(cause instanceof Error ? cause.message : String(cause))
  }

  if (response.status === 404) return { kind: 'not-found' }
  // 5xx і 429 — це «спробуй ще», а не відповідь про рішення.
  if (!response.ok) throw new ApiUnreachable(`the api answered ${response.status}`)

  let body: unknown
  try {
    body = await response.json()
  } catch (cause) {
    return { kind: 'malformed', detail: cause instanceof Error ? cause.message : String(cause) }
  }

  /**
   * Зод на межі — і саме тут він вартий найбільше: сторінку читає той, хто нам
   * не довіряє, тож поле, яке приїхало не таким, як обіцяє контракт, не має
   * права дійти до екрана під виглядом рішення. Розбіжність із контрактом — це
   * стан **нашого API**, а не стан запису.
   */
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return { kind: 'malformed', detail: parsed.error.issues.map(issueLine).join('; ') }
  }
  return { kind: 'ok', value: parsed.data }
}

const issueLine = (issue: { path: PropertyKey[]; message: string }): string =>
  `${issue.path.join('.') || '(root)'}: ${issue.message}`

export interface PublicApi {
  decision(decisionId: string): Promise<ApiOutcome<PublicDecisionResponse>>
  agentKeys(agentPubkey: string): Promise<ApiOutcome<PublicAgentKeysResponse>>
}

export function createPublicApi(config: PublicApiConfig): PublicApi {
  return {
    decision: (decisionId) =>
      isDecisionId(decisionId)
        ? read(config, `/v1/public/decisions/${decisionId}`, publicDecisionResponseSchema)
        : // Зіпсована адреса не варта запиту: формат ідентифікатора публічний,
          // і питати про нього наш сервіс означало б показувати 400 як стан.
          Promise.resolve({ kind: 'not-found' as const }),
    agentKeys: (agentPubkey) =>
      isAgentPubkey(agentPubkey)
        ? read(config, `/v1/public/agents/${agentPubkey}/keys`, publicAgentKeysResponseSchema)
        : Promise.resolve({ kind: 'not-found' as const }),
  }
}

/**
 * Ключі запитів named так, щоб їх було видно у devtools і щоб рішення різних
 * агентів не ділили кеш. Окремі функції, а не рядки на місці виклику: ключ,
 * зібраний у двох місцях по-різному, дає два кеші на ту саму адресу.
 */
export const decisionQuery = (api: PublicApi, decisionId: string) => ({
  queryKey: ['public-decision', decisionId] as const,
  queryFn: () => api.decision(decisionId),
})

export const agentKeysQuery = (api: PublicApi, agentPubkey: string) => ({
  queryKey: ['public-agent-keys', agentPubkey] as const,
  queryFn: () => api.agentKeys(agentPubkey),
})
