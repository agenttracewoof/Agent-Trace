import { agentKeys, agents, decisions } from '@agenttrace/db'
import type { Manifest, SignedManifest } from '@agenttrace/manifest'
import { submitDecisionRequestSchema } from '@agenttrace/shared'
import { verifyDecision } from '@agenttrace/verify'
import { zValidator } from '@hono/zod-validator'
import { and, eq } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { Variables } from '../app.js'
import { AppError } from '../errors.js'
import { ingestAuth, projectByIngestKeyHash } from '../middleware/auth.js'
import {
  assertStepCountWithinLimit,
  bodyTooLarge,
  chargeDailyQuota,
  createRateLimiter,
  MAX_BODY_BYTES,
  type RateLimit,
} from '../quota.js'

/**
 * Правило приймання одне: **беремо рішення лише тоді, коли verifier, маючи сам
 * тільки манифест, каже `pending`.** Без якоря це і є «все сходиться, лишилось
 * опублікувати».
 *
 * Своя перевірка тут була б другою правдою про те, що таке валідне рішення, і
 * розійшлася б із першою на найдорожчому: підпис покриває дайджест манифесту,
 * а дайджест — корінь, тож підмінити вміст кроку зі збереженням його хешу можна,
 * не зачепивши ані кореня, ані підпису. Прийнявши таке, ми власноруч поклали б
 * у базу запис, який назавжди читається як `tampered` — і виглядало б це як наша
 * помилка, а не як чужа підробка.
 *
 * `verify` імпортувати сюди можна: заборона односпрямована — це verifier не має
 * права знати про API (FR-014, тест T007), а не навпаки.
 */
type Db<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
> = PgDatabase<TQueryResult, TFullSchema>

export interface DecisionRoutesConfig {
  /** Звідки складається публічне посилання у відповіді. */
  readonly publicAppUrl: string
  /**
   * Темп приймання. За замовчуванням — сплеск на 120 запитів із поповненням
   * 10/с: достатньо, щоб SDK злив накопичену за обрив чергу (FR-007), і замало,
   * щоб один проєкт зайняв процес собою.
   */
  readonly rateLimit?: RateLimit
}

const DEFAULT_RATE_LIMIT: RateLimit = { burst: 120, perSecond: 10 }

/**
 * У форматі `decisionId` — 32 hex без дефісів: у якорі це 16 сирих байтів, і
 * саме цю форму копіює той, хто читає ланцюг. У базі колонка `uuid`, тож дефіси
 * ставляться на межі й ніде більше — посилання назовні лишається у формі ланцюга.
 */
const asUuid = (decisionId: string): string =>
  `${decisionId.slice(0, 8)}-${decisionId.slice(8, 12)}-${decisionId.slice(12, 16)}-${decisionId.slice(16, 20)}-${decisionId.slice(20)}`

interface SigningKey {
  readonly agentId: string
  readonly agentKeyId: string
}

/**
 * Ключ шукається разом із проєктом, а не після нього: інакше рішення, підписане
 * ключем чужого орендаря, відрізнялося б у відповіді від рішення невідомого
 * агента, і ендпоінт почав би розповідати, чиї агенти існують.
 */
async function signingKeyOf<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
>(
  db: Db<TQueryResult, TFullSchema>,
  projectId: string,
  agentPubkey: string,
): Promise<SigningKey | undefined> {
  const [found] = await db
    .select({ agentId: agents.id, agentKeyId: agentKeys.id })
    .from(agentKeys)
    .innerJoin(agents, eq(agents.id, agentKeys.agentId))
    .where(and(eq(agentKeys.publicKey, agentPubkey), eq(agents.projectId, projectId)))
    .limit(1)

  return found
}

function rowFor(
  manifest: Manifest,
  signature: string,
  projectId: string,
  key: SigningKey,
): typeof decisions.$inferInsert {
  return {
    id: asUuid(manifest.decisionId),
    projectId,
    agentId: key.agentId,
    agentKeyId: key.agentKeyId,
    manifestVersion: manifest.version,
    root: manifest.root,
    signature,
    decidedAt: manifest.decidedAt,
    modelRef: manifest.model,
    sources: manifest.sources,
    steps: manifest.steps,
    outcome: manifest.outcome,
  }
}

/**
 * `decisionId` генерує SDK, тож повтор після обриву звʼязку приходить із тим
 * самим ідентифікатором (FR-007). `onConflictDoNothing` розводить два випадки
 * без гонки: рядок або зʼявився зараз, або вже був.
 *
 * Запис і списання квоти — одна транзакція, і це не акуратність, а вимога:
 * рішення понад квоту не має лишити по собі рядка, а повтор не має списати
 * квоту вдруге за те саме рішення. Тому квота списується **лише** на гілці,
 * де вставка справді відбулась, і будь-яка відмова після неї відкочує обидві дії.
 */
async function storeDecision<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
>(
  db: Db<TQueryResult, TFullSchema>,
  envelope: SignedManifest,
  projectId: string,
  key: SigningKey,
  dailyQuota: number,
): Promise<string> {
  const row = rowFor(envelope.manifest, envelope.signature, projectId, key)

  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(decisions)
      .values(row)
      .onConflictDoNothing()
      .returning({ status: decisions.status })

    if (inserted !== undefined) {
      await chargeDailyQuota(tx, projectId, dailyQuota)
      return inserted.status
    }

    const [existing] = await tx
      .select({ status: decisions.status, root: decisions.root, signature: decisions.signature })
      .from(decisions)
      .where(eq(decisions.id, row.id))
      .limit(1)

    if (existing === undefined) throw new Error('storeDecision: conflicting row disappeared')

    // Повтор і підміна приходять однаково — з уже відомим ідентифікатором. Мовчазне
    // «ок» другому манифесту означало б, що публічне посилання показує не те
    // рішення, про яке відзвітували відправнику.
    if (existing.root !== row.root || existing.signature !== row.signature) {
      throw new AppError('INVALID_INPUT', 'This decision id already holds a different decision')
    }

    return existing.status
  })
}

export function decisionRoutes<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
>(db: Db<TQueryResult, TFullSchema>, config: DecisionRoutesConfig) {
  const router = new Hono<{ Variables: Variables }>()
  const publicAppUrl = config.publicAppUrl.replace(/\/+$/, '')
  const allow = createRateLimiter(config.rateLimit ?? DEFAULT_RATE_LIMIT)

  router.use('*', ingestAuth(projectByIngestKeyHash(db)))

  router.post(
    '/decisions',
    // Порядок тут і є захистом: розмір відсікається до читання тіла, темп — до
    // будь-якої роботи, кроки — до хешування, і лише потім витрачається квота.
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () => {
        throw bodyTooLarge()
      },
    }),
    zValidator('json', submitDecisionRequestSchema, (result) => {
      if (!result.success) throw result.error
    }),
    async (c) => {
      const envelope = c.req.valid('json')
      const project = c.get('project')
      const projectId = project.id

      if (!allow(projectId)) {
        throw new AppError('RATE_LIMITED', 'This project is sending decisions too quickly')
      }

      assertStepCountWithinLimit(envelope.manifest.steps.length)

      const verdict = await verifyDecision({ manifest: envelope })
      if (verdict.status !== 'pending') {
        throw new AppError('INVALID_INPUT', 'This decision does not verify against its signature', {
          discrepancies: verdict.discrepancies.map((one) => one.code),
        })
      }

      const key = await signingKeyOf(db, projectId, envelope.manifest.agentPubkey)
      if (key === undefined) {
        throw new AppError('INVALID_INPUT', 'No agent of this project is registered with that key')
      }

      const status = await storeDecision(db, envelope, projectId, key, project.dailyQuota)

      return c.json({
        status,
        publicUrl: `${publicAppUrl}/decisions/${envelope.manifest.decisionId}`,
      })
    },
  )

  return router
}
