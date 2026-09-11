import { createDb } from '@agenttrace/db'
import { MANIFEST_VERSION } from '@agenttrace/manifest'
import { Connection, Keypair } from '@solana/web3.js'
import pino from 'pino'
import { publishPending } from './loop.js'

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    logger.error({ variable: name }, 'required environment variable is not set')
    process.exit(1)
  }
  return value
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function fromBase58(value: string): Uint8Array {
  const bytes = [0]
  for (const character of value) {
    let carry = BASE58_ALPHABET.indexOf(character)
    if (carry < 0) {
      logger.error('PUBLISHER_SECRET_KEY is not base58')
      process.exit(1)
    }
    for (let i = 0; i < bytes.length; i += 1) {
      carry += (bytes[i] as number) * 58
      bytes[i] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  for (const character of value) {
    if (character !== BASE58_ALPHABET[0]) break
    bytes.push(0)
  }
  return Uint8Array.from(bytes.reverse())
}

const db = createDb(required('DATABASE_URL'))
const connection = new Connection(required('SOLANA_RPC_URL'), 'confirmed')
const payer = Keypair.fromSecretKey(fromBase58(required('PUBLISHER_SECRET_KEY')))

const config = {
  payer,
  maxPriorityLamports: Number(process.env.PUBLISHER_MAX_PRIORITY_LAMPORTS ?? 10_000),
  batchSize: 25,
}

const TICK_MS = 2_000

logger.info(
  { manifestVersion: MANIFEST_VERSION, payer: payer.publicKey.toBase58() },
  'publisher starting',
)

let running = true
let tick: Promise<void> = Promise.resolve()

async function loop(): Promise<void> {
  while (running) {
    tick = (async () => {
      try {
        const published = await publishPending(db, connection, config)
        if (published > 0) logger.info({ published }, 'anchored')
      } catch (error) {
        // Прохід може впасти лише на спільному ресурсі (база, RPC) — окреме
        // рішення падає всередині. Зупиняти цикл через це означало б, що
        // хвилина недоступної бази коштує зупинки публікації назавжди.
        logger.error({ err: error }, 'publish pass failed')
      }
    })()
    await tick
    await new Promise((done) => setTimeout(done, TICK_MS))
  }
}

void loop()

/**
 * SIGTERM приходить при кожному rolling deploy на Railway. Незавершена відправка
 * — саме той стан, у якому можна або загубити якір, або поставити другий на те
 * саме рішення, тож дочекатися in-flight операцій тут не косметика.
 */
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, 'shutting down')
  running = false
  await tick
  logger.info('shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', (signal) => void shutdown(signal))
process.on('SIGINT', (signal) => void shutdown(signal))
