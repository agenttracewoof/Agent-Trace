import { createDb } from '@agenttrace/db'
import { MANIFEST_VERSION } from '@agenttrace/manifest'
import pino from 'pino'
import { chainFromEnv, publisherConfigFromEnv, requiredEnv, startPublisher } from './run.js'

/**
 * Вхід для **двопроцесного** запуску: publisher окремим сервісом, як його
 * задумано (`PLAN.md` → чому окремий сервіс). Уся логіка — в `run.ts`, бо той
 * самий цикл піднімається ще й усередині API, коли хостинг дає рівно один
 * процес (`render.yaml`, `RUN_PUBLISHER`).
 */
const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })

function orExit<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    logger.error({ err: error }, 'publisher cannot start')
    process.exit(1)
  }
}

const db = createDb(orExit(() => requiredEnv(process.env, 'DATABASE_URL')))
const chain = orExit(() => chainFromEnv(process.env))
const config = orExit(() => publisherConfigFromEnv(process.env))

logger.info(
  { manifestVersion: MANIFEST_VERSION, payer: config.payer.publicKey.toBase58() },
  'publisher starting',
)

const publisher = startPublisher({ db, chain, config, logger })

/**
 * SIGTERM приходить при кожному rolling deploy. Незавершена відправка — саме
 * той стан, у якому можна або загубити якір, або поставити другий на те саме
 * рішення, тож дочекатися проходу тут не косметика.
 */
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, 'shutting down')
  await publisher.stop()
  logger.info('shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', (signal) => void shutdown(signal))
process.on('SIGINT', (signal) => void shutdown(signal))
