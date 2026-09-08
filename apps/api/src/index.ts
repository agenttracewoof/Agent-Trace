import { createDb } from '@agenttrace/db'
import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { createLogger } from './logger.js'
import { agentRoutes } from './routes/agents.js'
import { decisionRoutes } from './routes/decisions.js'

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
const app = createApp({ logger })
app.route('/v1', agentRoutes(db))
app.route('/v1', decisionRoutes(db, { publicAppUrl: required('PUBLIC_APP_URL') }))

const port = Number(process.env.API_PORT ?? 8787)

const server = serve({ fetch: app.fetch, port }, (info) =>
  logger.info({ port: info.port }, 'api listening'),
)

/**
 * Railway зупиняє процес `SIGTERM` посеред rolling deploy. Прийняте рішення,
 * яке ще не встигло лягти в базу, при різкому виході зникає — а SDK вважає
 * його відправленим (FR-007 повторює лише те, що не отримало відповіді).
 * Тому чекаємо in-flight запити, і рівно стільки, скільки дозволено:
 * зависле зʼєднання не має тримати деплой вічно.
 */
const SHUTDOWN_GRACE_MS = 10_000

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'shutting down')
  const forced = setTimeout(() => {
    logger.error({ signal }, 'shutdown timed out, exiting anyway')
    process.exit(1)
  }, SHUTDOWN_GRACE_MS)
  forced.unref()

  server.close((error) => {
    if (error) {
      logger.error({ err: error }, 'shutdown failed')
      process.exit(1)
    }
    logger.info('shutdown complete')
    process.exit(0)
  })
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

export { app }
