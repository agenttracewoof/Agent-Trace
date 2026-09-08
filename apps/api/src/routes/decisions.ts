import { agentKeys, agents, decisions } from '@agenttrace/db'
import type { Manifest, SignedManifest } from '@agenttrace/manifest'
import { submitDecisionRequestSchema } from '@agenttrace/shared'
import { verifyDecision } from '@agenttrace/verify'
import { zValidator } from '@hono/zod-validator'
import { and, eq } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { Hono } from 'hono'
import type { Variables } from '../app.js'
import { AppError } from '../errors.js'
import { ingestAuth, projectByIngestKeyHash } from '../middleware/auth.js'

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
}

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
 * без транзакції й без гонки: рядок або зʼявився зараз, або вже був.
 */
async function storeDecision<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
>(
  db: Db<TQueryResult, TFullSchema>,
  envelope: SignedManifest,
  projectId: string,
  key: SigningKey,
): Promise<string> {
  const row = rowFor(envelope.manifest, envelope.signature, projectId, key)

  const [inserted] = await db
    .insert(decisions)
    .values(row)
    .onConflictDoNothing()
    .returning({ status: decisions.status })

  if (inserted !== undefined) return inserted.status

  const [existing] = await db
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
}

export function decisionRoutes<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
>(db: Db<TQueryResult, TFullSchema>, config: DecisionRoutesConfig) {
  const router = new Hono<{ Variables: Variables }>()
  const publicAppUrl = config.publicAppUrl.replace(/\/+$/, '')

  router.use('*', ingestAuth(projectByIngestKeyHash(db)))

  router.post(
    '/decisions',
    zValidator('json', submitDecisionRequestSchema, (result) => {
      if (!result.success) throw result.error
    }),
    async (c) => {
      const envelope = c.req.valid('json')
      const projectId = c.get('project').id

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

      const status = await storeDecision(db, envelope, projectId, key)

      return c.json({
        status,
        publicUrl: `${publicAppUrl}/decisions/${envelope.manifest.decisionId}`,
      })
    },
  )

  return router
}
