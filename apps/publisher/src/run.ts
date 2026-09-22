import { Connection, Keypair } from '@solana/web3.js'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { type ChainClient, type PublisherConfig, publishPending } from './loop.js'

/**
 * Цикл публікації як **керований процес**, а не як тіло `index.ts`.
 *
 * Причина суто розгортальна: на безкоштовному плані Render існує лише web-сервіс,
 * background worker коштує грошей. Тож publisher має вміти жити всередині
 * процесу API — і вміти зупинятися першим, бо незавершена відправка це саме той
 * стан, у якому можна або загубити якір, або поставити другий на те саме
 * рішення (R10). Двопроцесний запуск нікуди не дівся: `index.ts` лишається
 * тонкою обгорткою навколо цього ж коду.
 */

type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>

/** Рівно те, що цикл пише в лог. `pino` задовольняє це структурно. */
export interface PublisherLogger {
  info(object: object, message: string): void
  error(object: object, message: string): void
}

export interface StartPublisherOptions {
  readonly db: AnyPgDatabase
  readonly chain: ChainClient
  readonly config: PublisherConfig
  readonly logger: PublisherLogger
  /** Пауза між проходами. Чекати менше немає сенсу: слот довший. */
  readonly tickMs?: number
}

export interface RunningPublisher {
  /** Повертається, коли поточний прохід завершився, а наступний уже не почнеться. */
  stop(): Promise<void>
}

export const DEFAULT_TICK_MS = 2_000

export function startPublisher(options: StartPublisherOptions): RunningPublisher {
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS
  let running = true
  let wake: (() => void) | undefined

  /**
   * Сон переривний: без цього `stop()` чекав би до двох секунд ні на чому, і
   * вимкнення процесу впиралося б у таймер, а не в роботу.
   */
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      wake = () => {
        clearTimeout(timer)
        resolve()
      }
    })

  const finished = (async () => {
    while (running) {
      try {
        const published = await publishPending(options.db, options.chain, options.config)
        if (published > 0) options.logger.info({ published }, 'anchored')
      } catch (error) {
        // Прохід може впасти лише на спільному ресурсі (база, RPC) — окреме
        // рішення падає всередині. Зупиняти цикл через це означало б, що
        // хвилина недоступної бази коштує зупинки публікації назавжди.
        options.logger.error({ err: error }, 'publish pass failed')
      }
      if (!running) break
      await sleep(tickMs)
    }
  })()

  return {
    stop: async () => {
      running = false
      wake?.()
      await finished
    },
  }
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Дзеркало `toBase58` із `loop.ts`; тест звіряє пару на згенерованих ключах. */
export function fromBase58(value: string): Uint8Array {
  const bytes = [0]
  for (const character of value) {
    let carry = BASE58_ALPHABET.indexOf(character)
    if (carry < 0) throw new Error('secret key is not base58')
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

export type Env = Record<string, string | undefined>

export function requiredEnv(env: Env, name: string): string {
  const value = env[name]
  if (value === undefined || value === '') {
    throw new Error(`required environment variable is not set: ${name}`)
  }
  return value
}

/**
 * Читання оточення тримається тут, а не в кожному вході: тепер входів два, і
 * розійшовшись вони дали б процес, який в одному режимі бере стелю комісії,
 * а в іншому мовчки платить дефолтну.
 */
export function chainFromEnv(env: Env): Connection {
  return new Connection(requiredEnv(env, 'SOLANA_RPC_URL'), 'confirmed')
}

export function publisherConfigFromEnv(env: Env): PublisherConfig {
  return {
    payer: Keypair.fromSecretKey(fromBase58(requiredEnv(env, 'PUBLISHER_SECRET_KEY'))),
    maxPriorityLamports: Number(env.PUBLISHER_MAX_PRIORITY_LAMPORTS ?? 10_000),
    batchSize: 25,
  }
}
