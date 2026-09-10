import { usageDaily } from '@agenttrace/db'
import { sql } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { AppError } from './errors.js'

/**
 * Три різні обмеження, і вони навмисно різні за наслідком (FR-030).
 *
 * **Форма рішення** — кроки й байти — це властивість одного запиту: повтор його
 * не полагодить, тож відмова остаточна (`INVALID_INPUT`, і SDK відкладає рішення
 * в `rejected/`). **Квота і темп** — це властивість часу: завтра або за секунду
 * той самий запит пройде, тож відмова тимчасова (`RATE_LIMITED`, SDK повторює).
 * Сплутати ці два наслідки означало б або втратити підписане рішення через
 * вичерпану квоту, або назавжди зациклити повтор занадто великого манифесту.
 *
 * Стелі нижче — запобіжник проти одного зловмисного запиту, а не план місткості.
 * Сукупний обсяг тримають добова квота і витіснення (FR-028); скільки саме
 * проєкт спожив проти ліміту, показує FR-025.
 */
export const MAX_STEPS = 256
export const MAX_BODY_BYTES = 64 * 1024

/**
 * Розмір відсікає `bodyLimit` **до** розбору тіла, а не ця функція після нього:
 * `/v1/decisions` відкритий усьому світу, і розібрати стомегабайтний JSON, щоб
 * потім його відхилити, — це вже витрачена пам'ять. Кроки, навпаки, видно лише
 * після розбору, зате до перевірки підпису, яка хешує кожен крок.
 */
export function assertStepCountWithinLimit(steps: number): void {
  if (steps > MAX_STEPS) {
    throw new AppError('INVALID_INPUT', 'This decision has more steps than a decision may have', {
      limit: MAX_STEPS,
      actual: steps,
    })
  }
}

export function bodyTooLarge(): AppError {
  return new AppError('INVALID_INPUT', 'This decision is larger than a decision may be', {
    limit: MAX_BODY_BYTES,
  })
}

type Db<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
> = PgDatabase<TQueryResult, TFullSchema>

/** Доба — UTC, як і колонка. Локальна пересувала б межу квоти разом із сервером. */
const utcDay = (): string => new Date().toISOString().slice(0, 10)

/**
 * Списання і перевірка — **один запит**. Прочитати лічильник, вирішити й потім
 * збільшити означало б, що два одночасні рішення обидва бачать «ще можна» і
 * обидва проходять: квота у 10 000 віддавала б 10 001 рівно тоді, коли навантаження
 * найбільше. Тут рішення ухвалюється за значенням **після** інкремента, тобто
 * над рядком, який уже заблокований цим же `UPDATE`.
 *
 * **Кликати тільки всередині транзакції, яка записує саме рішення.** Інкремент
 * при перевищенні не відкочується тут навмисно — його відкочує та сама транзакція,
 * і саме це робить квоту й запис нероздільними: не буває ані прийнятого рішення,
 * яке не списали, ані списаної квоти без рішення. Окремий «повернути назад»
 * створив би вікно, у якому одне з двох уже сталося, а друге ще ні.
 */
export async function chargeDailyQuota<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
>(db: Db<TQueryResult, TFullSchema>, projectId: string, dailyQuota: number): Promise<number> {
  const [charged] = await db
    .insert(usageDaily)
    .values({ projectId, day: utcDay(), decisionsCount: 1 })
    .onConflictDoUpdate({
      target: [usageDaily.projectId, usageDaily.day],
      set: { decisionsCount: sql`${usageDaily.decisionsCount} + 1` },
    })
    .returning({ used: usageDaily.decisionsCount })

  if (charged === undefined) throw new Error('chargeDailyQuota: upsert returned no row')

  if (charged.used > dailyQuota) {
    throw new AppError('RATE_LIMITED', 'This project has used its decisions for today', {
      limit: dailyQuota,
      used: dailyQuota,
    })
  }

  return charged.used
}

export interface RateLimit {
  /** Скільки запитів поспіль дозволено після простою. */
  readonly burst: number
  /** З якою швидкістю відро наповнюється назад. */
  readonly perSecond: number
}

interface Bucket {
  tokens: number
  updatedAt: number
}

/**
 * Відро з токенами, а не лічильник у вікні: вікно, що скидається за розкладом,
 * пропускає подвійний сплеск на своїй межі — повне відро наприкінці одного
 * вікна і повне ж одразу на початку наступного.
 *
 * **Ліміт живе в пам'яті процесу, тобто він на інстанс, а не на проєкт.** З двома
 * інстансами API фактичний темп удвічі вищий за названий. Для M1 це прийнятно
 * (інстанс один), і саме тому справжню межу обсягу тримає добова квота в базі,
 * спільна для всіх інстансів, а це відро захищає лише процес від миттєвого напливу.
 *
 * Мапа росте по одному запису на проєкт і не чиститься: проєкт заводиться лише
 * сід-скриптом, тож її розмір обмежений кількістю справжніх проєктів, а не входом.
 */
export function createRateLimiter(limit: RateLimit): (projectId: string) => boolean {
  const buckets = new Map<string, Bucket>()

  return (projectId) => {
    const now = Date.now()
    const bucket = buckets.get(projectId) ?? { tokens: limit.burst, updatedAt: now }

    const refilled = ((now - bucket.updatedAt) / 1000) * limit.perSecond
    bucket.tokens = Math.min(limit.burst, bucket.tokens + refilled)
    bucket.updatedAt = now

    const allowed = bucket.tokens >= 1
    if (allowed) bucket.tokens -= 1
    buckets.set(projectId, bucket)

    return allowed
  }
}
