import { agentKeys, decisions } from '@agenttrace/db'
import { hexDigest } from '@agenttrace/manifest'
import type { PublicAgentKeysResponse } from '@agenttrace/shared'
import { zValidator } from '@hono/zod-validator'
import { asc, eq } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { z } from 'zod'
import type { Variables } from '../app.js'
import { asUuid } from '../decision-id.js'
import { decisionViewColumns, presentDecision } from '../decision-view.js'
import { AppError } from '../errors.js'

/**
 * Публічне читання (FR-011, FR-012, FR-013, FR-020) — **перший маршрут без
 * `ingestAuth`**, і це не забудькуватість, а зміст задачі: посилання на рішення
 * має відкриватися у чужому браузері без жодного ключа (SC-009). `ingestAuth`
 * монтує кожен роутер приймання сам (`agents.ts`, `decisions.ts`), тож тут його
 * просто немає; спільний `app.use('*')` зробив би цю різницю невидимою, і помилка
 * в один рядок або закрила б публічну сторінку, або відкрила б приймання.
 *
 * **Наш API не читає ланцюг** і тому ніколи не каже `verified`. Він віддає рівно
 * дві речі: манифест, який сходиться з власним підписом, і адресу транзакції, за
 * якою будь-хто перевірить решту без нас (FR-014). Синтезувати байти якоря з
 * власної бази, щоб отримати `verified`, було б підтвердженням самих себе —
 * рівно тим, чого продукт обіцяє не робити.
 */

type Db<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
> = PgDatabase<TQueryResult, TFullSchema>

const throwOnInvalid = (result: { success: boolean; error?: unknown }): void => {
  // Валідатору не дають відповісти своїм форматом: у API один формат помилки.
  if (!result.success) throw result.error
}

const decisionParams = z.object({ decisionId: hexDigest(16) })
const agentParams = z.object({ agentPubkey: hexDigest(32) })

/**
 * Скільки публічна відповідь може лежати в кеші браузера. Заякорене рішення
 * незмінне, тож хвилина безпечна; ще не заякорене міняється за секунди, і
 * показувати `pending` довше, ніж воно є, означало б показувати стан слабшим,
 * ніж він став. Видалений вміст не кешується взагалі: FR-024 обіцяє, що після
 * видалення його ніде не лишається, і кеш — теж «десь».
 */
const CACHE_ANCHORED = 'public, max-age=60'
const CACHE_PENDING = 'public, max-age=5'
const CACHE_NONE = 'no-store'

export function publicRoutes<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
>(db: Db<TQueryResult, TFullSchema>) {
  const router = new Hono<{ Variables: Variables }>()

  /**
   * CORS дозволяє будь-яке походження, і саме тут це правильно: без нього
   * сторінка з чужого домену не змогла б прочитати відповідь, тобто «публічне»
   * закінчувалося б на нашому власному домені. Дані вже публічні за визначенням,
   * облікових даних запит не несе, а куки й `Authorization` сюди не пускає
   * відсутність `credentials`. На маршрути приймання цей middleware не поширюється:
   * там у заголовку їде ключ проєкту, і браузеру нема чого його возити.
   */
  router.use('/public/*', cors({ origin: '*', allowMethods: ['GET'] }))

  router.get(
    '/public/decisions/:decisionId',
    zValidator('param', decisionParams, throwOnInvalid),
    async (c) => {
      const { decisionId } = c.req.valid('param')

      const [row] = await db
        .select(decisionViewColumns)
        .from(decisions)
        .innerJoin(agentKeys, eq(agentKeys.id, decisions.agentKeyId))
        .where(eq(decisions.id, asUuid(decisionId)))
        .limit(1)

      if (row === undefined) {
        throw new AppError('NOT_FOUND', 'No decision is stored under that id')
      }

      const body = await presentDecision(row, decisionId)

      c.header(
        'Cache-Control',
        body.contentDeletedAt !== null
          ? CACHE_NONE
          : body.anchor === null
            ? CACHE_PENDING
            : CACHE_ANCHORED,
      )
      return c.json(body)
    },
  )

  /**
   * Адреса — публічний ключ, а не наш внутрішній ідентифікатор, і це та сама
   * межа, що й у рішення: у ланцюгу лежить `agentPubkey`, і саме його копіює
   * той, хто прийшов перевіряти. Знайти агента можна за **будь-яким** його
   * ключем, включно з давно заміненим: рішення, підписане старим ключем, іншої
   * адреси не називає (FR-022).
   */
  router.get(
    '/public/agents/:agentPubkey/keys',
    zValidator('param', agentParams, throwOnInvalid),
    async (c) => {
      const { agentPubkey } = c.req.valid('param')

      const [owner] = await db
        .select({ agentId: agentKeys.agentId })
        .from(agentKeys)
        .where(eq(agentKeys.publicKey, agentPubkey))
        .limit(1)

      if (owner === undefined) {
        throw new AppError('NOT_FOUND', 'No agent is registered with that public key')
      }

      const history = await db
        .select({
          id: agentKeys.id,
          publicKey: agentKeys.publicKey,
          validFrom: agentKeys.validFrom,
          validTo: agentKeys.validTo,
          rotationKind: agentKeys.rotationKind,
          prevKeyId: agentKeys.prevKeyId,
          rotationProof: agentKeys.rotationProof,
        })
        .from(agentKeys)
        .where(eq(agentKeys.agentId, owner.agentId))
        .orderBy(asc(agentKeys.validFrom), asc(agentKeys.createdAt))

      // Попередник віддається ключем, а не нашим uuid: інакше читач мусив би
      // ходити по історії ще раз, щоб дізнатися, що саме чим замінили.
      const keyById = new Map(history.map((one) => [one.id, one.publicKey]))

      const body: PublicAgentKeysResponse = {
        agentId: owner.agentId,
        keys: history.map((one) => ({
          publicKey: one.publicKey,
          validFrom: one.validFrom,
          validTo: one.validTo,
          rotationKind: one.rotationKind,
          prevPublicKey: one.prevKeyId === null ? null : (keyById.get(one.prevKeyId) ?? null),
          rotationProof: one.rotationProof,
        })),
      }

      c.header('Cache-Control', CACHE_ANCHORED)
      return c.json(body)
    },
  )

  return router
}
