import { agentKeys, decisions } from '@agenttrace/db'
import { hexDigest, signedManifestSchema } from '@agenttrace/manifest'
import type { PublicAgentKeysResponse, PublicDecisionResponse } from '@agenttrace/shared'
import { type DecisionEvidence, verifyDecision } from '@agenttrace/verify'
import { zValidator } from '@hono/zod-validator'
import { asc, eq } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { z } from 'zod'
import type { Variables } from '../app.js'
import { asUuid } from '../decision-id.js'
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

interface DecisionRow {
  readonly manifestVersion: number
  readonly agentPubkey: string
  readonly modelRef: string
  readonly sources: string[]
  readonly root: string
  readonly decidedAt: number
  readonly outcome: unknown
  readonly steps: unknown
  readonly signature: string
  readonly anchorSignature: string | null
  readonly anchorSlot: number | null
  readonly anchoredAt: Date | null
  readonly archiveUrl: string | null
  readonly archivedAt: Date | null
  readonly contentDeletedAt: Date | null
}

/**
 * Рядок бази — це розібраний манифест, а не сам манифест. Складаємо його назад
 * рівно у тій формі, у якій його підписали: будь-яка вільність тут зробила б
 * чесне рішення схожим на підроблене, і побачив би це не власник, а стороння
 * людина за посиланням.
 */
function envelopeOf(row: DecisionRow, decisionId: string): unknown {
  return {
    manifest: {
      version: row.manifestVersion,
      agentPubkey: row.agentPubkey,
      decisionId,
      model: row.modelRef,
      sources: row.sources,
      root: row.root,
      decidedAt: row.decidedAt,
      outcome: row.outcome,
      steps: row.steps,
    },
    signature: row.signature,
  }
}

const anchorOf = (row: DecisionRow): PublicDecisionResponse['anchor'] =>
  row.anchorSignature === null || row.anchorSlot === null || row.anchoredAt === null
    ? null
    : {
        transactionSignature: row.anchorSignature,
        slot: row.anchorSlot,
        anchoredAt: row.anchoredAt.toISOString(),
      }

const archiveOf = (row: DecisionRow): PublicDecisionResponse['archive'] =>
  row.archiveUrl === null || row.archivedAt === null
    ? null
    : { url: row.archiveUrl, archivedAt: row.archivedAt.toISOString() }

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
        .select({
          manifestVersion: decisions.manifestVersion,
          agentPubkey: agentKeys.publicKey,
          modelRef: decisions.modelRef,
          sources: decisions.sources,
          root: decisions.root,
          decidedAt: decisions.decidedAt,
          outcome: decisions.outcome,
          steps: decisions.steps,
          signature: decisions.signature,
          anchorSignature: decisions.anchorSignature,
          anchorSlot: decisions.anchorSlot,
          anchoredAt: decisions.anchoredAt,
          archiveUrl: decisions.archiveUrl,
          archivedAt: decisions.archivedAt,
          contentDeletedAt: decisions.contentDeletedAt,
        })
        .from(decisions)
        .innerJoin(agentKeys, eq(agentKeys.id, decisions.agentKeyId))
        .where(eq(decisions.id, asUuid(decisionId)))
        .limit(1)

      if (row === undefined) {
        throw new AppError('NOT_FOUND', 'No decision is stored under that id')
      }

      const deleted = row.contentDeletedAt !== null
      const envelope = envelopeOf(row, decisionId)

      /**
       * Стан рахує **та сама функція**, що й незалежний verifier, і на тих самих
       * даних. Своя перевірка тут була б другою правдою: сторінка казала б одне,
       * а `agenttrace-verify` на тому ж рішенні — інше, і жодного способу
       * дізнатися, хто з них має рацію, у людини немає.
       */
      const evidence: DecisionEvidence = deleted
        ? { absence: 'content-deleted' }
        : { manifest: envelope }
      const verdict = await verifyDecision(evidence)

      /**
       * Конверт віддається лише таким, яким його пропустила строга схема формату.
       * У ній приватний крок не має полів вмісту **взагалі** (FR-020), тож
       * опублікувати вміст приватного кроку неможливо навіть тоді, коли він
       * якимось чином опинився у сховищі: такий рядок схему не пройде, конверт
       * стане `null`, а стан — `tampered`. Вирізання полів на виході дало б
       * слабшу обіцянку, бо трималося б на тому, чи не забули ми поле.
       */
      const parsed = deleted ? undefined : signedManifestSchema.safeParse(envelope)

      const body: PublicDecisionResponse = {
        decisionId,
        signedManifest: parsed?.success === true ? parsed.data : null,
        anchor: anchorOf(row),
        archive: archiveOf(row),
        contentDeletedAt: row.contentDeletedAt?.toISOString() ?? null,
        verification: {
          // Присвоєння нижче і є звіркою двох переліків станів: щойно verifier
          // заведе новий стан або застереження, цей рядок перестане типчекатися.
          status: verdict.status,
          discrepancies: verdict.discrepancies.map((one) => ({
            code: one.code,
            detail: one.detail,
          })),
          caveats: [...verdict.caveats],
          keyContinuity: verdict.keyContinuity,
          ...(verdict.origin === undefined ? {} : { origin: verdict.origin }),
          /**
           * Завжди `false`, і поле існує саме заради цього слова: воно каже
           * читачеві, що ланцюг ніхто не читав, тож найсильніше, що тут може
           * стояти, — `pending`. Прочитати ланцюг і сказати `verified` має право
           * лише той, хто зробив це сам.
           */
          includesChain: false,
        },
      }

      c.header(
        'Cache-Control',
        deleted ? CACHE_NONE : body.anchor === null ? CACHE_PENDING : CACHE_ANCHORED,
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
