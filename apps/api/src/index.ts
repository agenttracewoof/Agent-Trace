import { createDb } from '@agenttrace/db'
import {
  chainFromEnv,
  publisherConfigFromEnv,
  type RunningPublisher,
  startPublisher,
} from '@agenttrace/publisher/run'
import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { createLogger } from './logger.js'
import { agentRoutes } from './routes/agents.js'
import { decisionRoutes } from './routes/decisions.js'
import { publicRoutes } from './routes/public.js'

const logger = createLogger()

/**
 * Падаємо на старті, а не на першому рішенні: приймання без бази прийняти нічого
 * не може, а без публічної адреси віддає посилання, яке нікуди не веде. Живий
 * процес, який відповідає помилками, гірший за мертвий — деплой його не помітить.
 */
function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    logger.error({ variable: name }, 'required environment variable is not set')
    process.exit(1)
  }
  return value
}

const db = createDb(required('DATABASE_URL'))

/**
 * Окремого CORS тут немає навмисно. Єдине, куди ходить браузер, — `/v1/public/*`,
 * і той відкритий усім у самому маршруті: публічне посилання має читатися
 * з чужої сторінки без нашої участі (FR-012, SC-009). Решта маршрутів ходить
 * із ingest-ключем із серверного процесу, якому CORS не заважає й не помагає.
 * Перший справжній випадок — дашборд за сесією (Фаза 3), і origin туди
 * прийде тоді ж, коли й сам дашборд.
 */
const app = createApp({ logger })
app.route('/v1', agentRoutes(db))
app.route('/v1', decisionRoutes(db, { publicAppUrl: required('PUBLIC_APP_URL') }))
// Без `ingestAuth` навмисно: посилання на рішення відкривається без ключа (FR-012).
app.route('/v1', publicRoutes(db))

/**
 * Publisher усередині цього процесу — поступка хостингу, не зміна задуму
 * (`PLAN.md` → чому окремий сервіс). На безкоштовному плані Render існує лише
 * web-сервіс; background worker коштує грошей, а без publisher'а рішення
 * лишаються `pending` назавжди, тобто продукт не працює взагалі. Прапорець
 * лишає двопроцесний запуск дефолтом: локально й там, де за worker'а платять,
 * `apps/publisher` піднімається сам і `RUN_PUBLISHER` не ставиться.
 */
let publisher: RunningPublisher | undefined

if (process.env.RUN_PUBLISHER === 'true') {
  try {
    const config = publisherConfigFromEnv(process.env)
    publisher = startPublisher({
      db,
      chain: chainFromEnv(process.env),
      config,
      logger: logger.child({ service: 'publisher' }),
    })
    logger.info({ payer: config.payer.publicKey.toBase58() }, 'publisher running in this process')
  } catch (error) {
    // Не «працюємо без publisher'а»: приймати рішення, які ніколи не буде
    // кому заякорити, гірше, ніж не прийняти жодного.
    logger.error({ err: error }, 'RUN_PUBLISHER is set but the publisher cannot start')
    process.exit(1)
  }
}

/**
 * `PORT` віддає Render, `API_PORT` — наш `.env`. Наше значення сильніше, бо
 * локально обидві змінні можуть бути в оточенні, і виграти має та, яку людина
 * поставила свідомо.
 */
const port = Number(process.env.API_PORT ?? process.env.PORT ?? 8787)

const server = serve({ fetch: app.fetch, port }, (info) =>
  logger.info({ port: info.port }, 'api listening'),
)

/**
 * Хостинг зупиняє процес `SIGTERM` посеред деплою. Прийняте рішення, яке ще не
 * встигло лягти в базу, при різкому виході зникає — а SDK вважає його
 * відправленим (FR-007 повторює лише те, що не отримало відповіді). Тому
 * чекаємо in-flight запити, і рівно стільки, скільки дозволено: зависле
 * зʼєднання не має тримати деплой вічно.
 */
const SHUTDOWN_GRACE_MS = 10_000

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, 'shutting down')
  const forced = setTimeout(() => {
    logger.error({ signal }, 'shutdown timed out, exiting anyway')
    process.exit(1)
  }, SHUTDOWN_GRACE_MS)
  forced.unref()

  // Publisher зупиняється **першим**: він у середині відправки, і саме там
  // обрив коштує або загубленого якоря, або другого на те саме рішення.
  await publisher?.stop()

  server.close((error) => {
    if (error) {
      logger.error({ err: error }, 'shutdown failed')
      process.exit(1)
    }
    logger.info('shutdown complete')
    process.exit(0)
  })
}

process.on('SIGTERM', (signal) => void shutdown(signal))
process.on('SIGINT', (signal) => void shutdown(signal))

export { app }
