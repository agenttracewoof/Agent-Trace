import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { ZodError } from 'zod'
import { AppError, ERROR_STATUS, type ErrorCode, errorBody } from './errors.js'
import { createLogger, type Logger } from './logger.js'
import type { ProjectContext } from './middleware/auth.js'

/**
 * Експортується не для зручності: без цього тип `createApp` посилався б на
 * неіменований тип із чужого модуля, і `index.ts` не зміг би реекспортувати `app`.
 *
 * `project` існує лише на маршрутах за `ingestAuth` — на `/health` і на
 * публічному читанні його немає, і Hono про це не знає.
 */
export interface Variables {
  requestId: string
  logger: Logger
  project: ProjectContext
}

export interface AppOptions {
  readonly logger?: Logger
}

/** Статуси, які Hono кидає сам, у наші коди. Усе інше — `INTERNAL`. */
const CODE_BY_STATUS = new Map<number, ErrorCode>(
  Object.entries(ERROR_STATUS).map(([code, status]) => [status, code as ErrorCode]),
)

export function createApp(options: AppOptions = {}) {
  const logger = options.logger ?? createLogger()
  const app = new Hono<{ Variables: Variables }>()

  /**
   * Ідентифікатор запиту генерується **завжди наш**, а вхідний `X-Request-Id`
   * не приймається: інакше клієнт диктував би, що зʼявиться в наших логах,
   * і зіпсувати їх можна було б одним заголовком.
   */
  app.use('*', async (c, next) => {
    const requestId = crypto.randomUUID()
    c.set('requestId', requestId)
    c.set('logger', logger.child({ requestId }))
    c.header('X-Request-Id', requestId)

    const started = performance.now()
    await next()

    // Поля перелічені поіменно, а не розгорнуті з запиту: тіло рішення сюди
    // не потрапляє ніколи, і заголовки теж.
    logger.info(
      {
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - started),
      },
      'request',
    )
  })

  /**
   * Поки що відповідає лише за себе: живий процес і нічого більше. **Це не
   * готовність до роботи** — база тут не перевіряється, тож зелений `/health`
   * при недоступній базі цілком можливий. Саме цю неправду замінює T061,
   * додаючи відставання publisher'а від тіпа ланцюга; до того моменту не
   * варто вішати на цей ендпоінт healthcheck деплою.
   */
  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      service: 'api',
      uptimeSeconds: Math.round(process.uptime()),
      checks: {},
    }),
  )

  app.notFound((c) =>
    c.json(errorBody('NOT_FOUND', 'Resource not found', { requestId: c.get('requestId') }), 404),
  )

  app.onError((cause, c) => {
    const requestId = c.get('requestId')
    const log = c.get('logger') ?? logger

    if (cause instanceof AppError) {
      log.warn({ code: cause.code, details: cause.details }, cause.message)
      return c.json(cause.toBody(), cause.status)
    }

    if (cause instanceof ZodError) {
      // Валідація межі (`@hono/zod-validator`) — єдина помилка, чиї подробиці
      // безпечно віддавати: вони описують вхід клієнта, а не наш стан.
      log.warn({ issues: cause.issues.length }, 'invalid input')
      return c.json(
        errorBody('INVALID_INPUT', 'Request failed validation', {
          requestId,
          issues: cause.issues,
        }),
        400,
      )
    }

    if (cause instanceof HTTPException) {
      const code = CODE_BY_STATUS.get(cause.status) ?? 'INTERNAL'
      log.warn({ code, status: cause.status }, cause.message)
      return c.json(errorBody(code, cause.message, { requestId }), cause.status)
    }

    /**
     * Неочікуване назовні не пояснюється: текст помилки видає внутрішній стан,
     * і саме він найчастіше містить фрагмент SQL, шлях або URL із ключем.
     * Клієнт отримує `requestId` — цього досить, щоб знайти подію в логах.
     */
    log.error({ err: cause }, 'unhandled error')
    return c.json(errorBody('INTERNAL', 'Internal error', { requestId }), 500)
  })

  return app
}

export type App = ReturnType<typeof createApp>
