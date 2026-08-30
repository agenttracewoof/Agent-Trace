import { MANIFEST_VERSION } from '@agenttrace/manifest'
import pino from 'pino'

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })

logger.info({ manifestVersion: MANIFEST_VERSION }, 'publisher starting')

/**
 * SIGTERM приходить при кожному rolling deploy на Railway. Незавершена відправка
 * — саме той стан, у якому можна або загубити якір, або поставити другий на те
 * саме рішення, тож дочекатися in-flight операцій тут не косметика.
 */
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down')
  process.exit(0)
})
