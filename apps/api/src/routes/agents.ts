import { agentKeys, agents } from '@agenttrace/db'
import { type RegisterAgentRequest, registerAgentRequestSchema } from '@agenttrace/shared'
import { zValidator } from '@hono/zod-validator'
import { and, eq } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { Hono } from 'hono'
import type { Variables } from '../app.js'
import { AppError } from '../errors.js'
import { ingestAuth, projectByIngestKeyHash } from '../middleware/auth.js'

/**
 * Початковий ключ дійсний **з нуля**, а не з моменту реєстрації. Попередника
 * в нього немає, тож ранішого періоду, який належав би комусь іншому, не існує;
 * а «дійсний з тепер» створив би вікно, у яке не потрапляє власне рішення агента:
 * SDK тримає рішення на диску при обриві мережі (FR-007), і перше з них цілком
 * може бути старшим за першу вдалу реєстрацію. `valid_to` цьому рядку проставить
 * перша ротація (T044).
 */
const INITIAL_KEY_VALID_FROM = 0

/**
 * Одна відповідь на два різні випадки — ключ зайнятий у цьому проєкті і ключ
 * зайнятий у чужому. Різні формулювання зробили б ендпоінт оракулом: «цей
 * публічний ключ уже десь зареєстрований» — це відповідь про іншого орендаря,
 * а `agent_keys.public_key` унікальний глобально.
 */
const KEY_TAKEN = 'This public key is already registered to another agent'

type Db<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
> = PgDatabase<TQueryResult, TFullSchema>

interface AgentByKey {
  readonly agentId: string
  readonly projectId: string
  readonly externalId: string
}

async function agentHoldingKey<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
>(db: Db<TQueryResult, TFullSchema>, publicKey: string): Promise<AgentByKey | undefined> {
  const [found] = await db
    .select({
      agentId: agents.id,
      projectId: agents.projectId,
      externalId: agents.externalId,
    })
    .from(agentKeys)
    .innerJoin(agents, eq(agents.id, agentKeys.agentId))
    .where(eq(agentKeys.publicKey, publicKey))
    .limit(1)

  return found
}

/**
 * Ідемпотентність тут — властивість бази, а не пам'яті процесу: повторний виклик
 * впізнає **вже записаний** ключ. Тому SDK може кликати реєстрацію перед кожним
 * проходом відправки, і два агенти зі спільним каталогом стану не створять
 * другого запису.
 */
async function registerAgent<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
>(
  db: Db<TQueryResult, TFullSchema>,
  projectId: string,
  request: RegisterAgentRequest,
): Promise<string> {
  const holder = await agentHoldingKey(db, request.publicKey)
  if (holder !== undefined) {
    if (holder.projectId !== projectId || holder.externalId !== request.externalId) {
      throw new AppError('INVALID_INPUT', KEY_TAKEN)
    }
    return holder.agentId
  }

  const [taken] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.projectId, projectId), eq(agents.externalId, request.externalId)))
    .limit(1)

  if (taken !== undefined) {
    throw new AppError(
      'INVALID_INPUT',
      'This agent is already registered with a different key; replacing a key is a rotation',
    )
  }

  try {
    return await db.transaction(async (tx) => {
      const [agent] = await tx
        .insert(agents)
        .values({ projectId, externalId: request.externalId, name: request.name })
        .returning({ id: agents.id })

      if (agent === undefined) throw new Error('registerAgent: insert returned no row')

      await tx.insert(agentKeys).values({
        agentId: agent.id,
        publicKey: request.publicKey,
        validFrom: INITIAL_KEY_VALID_FROM,
        rotationKind: 'initial',
      })

      return agent.id
    })
  } catch (cause) {
    // Дві одночасні реєстрації того самого ключа: одна вставка виграє, друга
    // впаде на унікальному індексі. Сходимося на тому, що вже записано, замість
    // читати код помилки драйвера — так відповідь однакова незалежно від того,
    // який саме індекс спрацював, і від того, чим ця база є.
    const raced = await agentHoldingKey(db, request.publicKey)
    if (raced?.projectId === projectId && raced.externalId === request.externalId) {
      return raced.agentId
    }
    throw cause
  }
}

export function agentRoutes<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
>(db: Db<TQueryResult, TFullSchema>) {
  const router = new Hono<{ Variables: Variables }>()

  /**
   * Авторизація стоїть **у самому маршруті**, а не `router.use('*', …)`.
   * Роутери зводяться в один застосунок через `app.route('/v1', …)`, і
   * зірочка в такому роутері накриває весь `/v1/*` — включно з чужими
   * маршрутами, яких цей файл не бачить. Саме так публічне читання (T028)
   * одного разу поїхало під ingest-ключ. Тут же ланцюжок хендлерів робить
   * «цей маршрут за ключем» властивістю маршруту: додати новий і не помітити,
   * що він відкритий, неможливо — його видно в тому самому рядку.
   */
  const auth = ingestAuth(projectByIngestKeyHash(db))

  router.post(
    '/agents',
    auth,
    // Хук кидає помилку замість того, щоб дати валідатору відповісти своїм
    // форматом: у API один формат помилки, і SDK розбирає рівно його.
    zValidator('json', registerAgentRequestSchema, (result) => {
      if (!result.success) throw result.error
    }),
    async (c) => {
      const agentId = await registerAgent(db, c.get('project').id, c.req.valid('json'))
      // 200, а не 201 на створення: різні коди розповідали б, чи існував агент
      // раніше, а для ідемпотентного виклику це різниця без значення.
      return c.json({ agentId })
    },
  )

  return router
}
