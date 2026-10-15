import { agentKeys, agents, decisions } from '@agenttrace/db'
import { verifyKeyRotation } from '@agenttrace/manifest'
import {
  type RegisterAgentRequest,
  type RotateAgentKeyRequest,
  type RotateAgentKeyResponse,
  registerAgentRequestSchema,
  rotateAgentKeyRequestSchema,
} from '@agenttrace/shared'
import { zValidator } from '@hono/zod-validator'
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { Hono } from 'hono'
import { z } from 'zod'
import { assertAgentPubkeyUsable } from '../agent-pubkey.js'
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
  // Перед будь-яким запитом до бази: ключ, яким не можна підписати, не варто
  // ані шукати, ані записувати.
  assertAgentPubkeyUsable(request.publicKey)

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

/**
 * The SDK picks `effectiveAt` and signs it, so its clock and ours disagree by
 * whatever they disagree by. A time beyond that is not a rotation that has
 * happened but one being claimed in advance.
 */
const CLOCK_SKEW_MS = 5 * 60 * 1000

const AGENT_NOT_FOUND = 'Agent not found'

interface CurrentKey {
  readonly id: string
  readonly publicKey: string
  readonly validFrom: number
  readonly rotationKind: string
  readonly rotationProof: string | null
}

const isThisRotation = (key: CurrentKey, request: RotateAgentKeyRequest) =>
  key.publicKey === request.newPublicKey &&
  key.rotationKind === 'chained' &&
  key.rotationProof === request.proof &&
  key.validFrom === request.effectiveAt

async function currentKeyOf<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
>(
  db: Db<TQueryResult, TFullSchema>,
  projectId: string,
  agentId: string,
): Promise<CurrentKey | undefined> {
  const [found] = await db
    .select({
      id: agentKeys.id,
      publicKey: agentKeys.publicKey,
      validFrom: agentKeys.validFrom,
      rotationKind: agentKeys.rotationKind,
      rotationProof: agentKeys.rotationProof,
    })
    .from(agentKeys)
    .innerJoin(agents, eq(agents.id, agentKeys.agentId))
    .where(and(eq(agents.id, agentId), eq(agents.projectId, projectId), isNull(agentKeys.validTo)))
    .limit(1)

  return found
}

/**
 * The line `effectiveAt` draws goes to the chain with the rotation anchor and
 * cannot be taken back. A decision this key already signed at or after it
 * would end up outside its own key's window for good, so that line is refused
 * here, while it is still only a request.
 */
async function latestDecisionOf<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
>(db: Db<TQueryResult, TFullSchema>, agentKeyId: string): Promise<number | undefined> {
  const [latest] = await db
    .select({ decidedAt: decisions.decidedAt })
    .from(decisions)
    .where(eq(decisions.agentKeyId, agentKeyId))
    .orderBy(desc(decisions.decidedAt))
    .limit(1)

  return latest?.decidedAt
}

async function rotateAgentKey<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
>(
  db: Db<TQueryResult, TFullSchema>,
  projectId: string,
  agentId: string,
  request: RotateAgentKeyRequest,
): Promise<RotateAgentKeyResponse> {
  const current = await currentKeyOf(db, projectId, agentId)
  if (current === undefined) throw new AppError('NOT_FOUND', AGENT_NOT_FOUND)

  const accepted = { agentId, publicKey: request.newPublicKey, effectiveAt: request.effectiveAt }
  if (isThisRotation(current, request)) return accepted

  assertAgentPubkeyUsable(request.newPublicKey)
  if ((await agentHoldingKey(db, request.newPublicKey)) !== undefined) {
    throw new AppError('INVALID_INPUT', KEY_TAKEN)
  }

  if (request.effectiveAt <= current.validFrom) {
    throw new AppError('INVALID_INPUT', 'effectiveAt must come after the current key took effect')
  }
  if (request.effectiveAt > Date.now() + CLOCK_SKEW_MS) {
    throw new AppError('INVALID_INPUT', 'effectiveAt is in the future')
  }

  const proven = await verifyKeyRotation(
    {
      newPubkey: request.newPublicKey,
      prevPubkey: current.publicKey,
      effectiveAt: request.effectiveAt,
    },
    request.proof,
  )
  if (!proven) {
    throw new AppError(
      'INVALID_INPUT',
      "proof is not the current key's signature over this rotation",
    )
  }

  const latest = await latestDecisionOf(db, current.id)
  if (latest !== undefined && latest >= request.effectiveAt) {
    throw new AppError(
      'INVALID_INPUT',
      'effectiveAt must come after the last decision the current key signed',
      { latestDecidedAt: latest },
    )
  }

  try {
    await db.transaction(async (tx) => {
      // `valid_to IS NULL` in the update is what settles two rotations racing
      // from the same key: only one of them still finds the key open.
      const closed = await tx
        .update(agentKeys)
        .set({ validTo: request.effectiveAt })
        .where(and(eq(agentKeys.id, current.id), isNull(agentKeys.validTo)))
        .returning({ id: agentKeys.id })

      if (closed.length === 0) {
        throw new AppError(
          'INVALID_INPUT',
          "The agent's key changed while this rotation was being made; rotate again from the current key",
        )
      }

      await tx.insert(agentKeys).values({
        agentId,
        publicKey: request.newPublicKey,
        validFrom: request.effectiveAt,
        rotationKind: 'chained',
        prevKeyId: current.id,
        rotationProof: request.proof,
      })
    })
  } catch (cause) {
    // Same reasoning as registration: the answer comes from what is now
    // stored, not from which check or unique index fired. A retry that raced
    // its own first attempt finds that attempt here and gets the same answer.
    const stored = await currentKeyOf(db, projectId, agentId)
    if (stored !== undefined && isThisRotation(stored, request)) return accepted
    if (cause instanceof AppError) throw cause
    if ((await agentHoldingKey(db, request.newPublicKey)) !== undefined) {
      throw new AppError('INVALID_INPUT', KEY_TAKEN)
    }
    throw cause
  }

  return accepted
}

const agentIdParamSchema = z.object({ id: z.uuid() })

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

  router.post(
    '/agents/:id/rotate',
    auth,
    // A malformed id is answered like an unknown one: it names no agent either.
    zValidator('param', agentIdParamSchema, (result) => {
      if (!result.success) throw new AppError('NOT_FOUND', AGENT_NOT_FOUND)
    }),
    zValidator('json', rotateAgentKeyRequestSchema, (result) => {
      if (!result.success) throw result.error
    }),
    async (c) => {
      const rotated = await rotateAgentKey(
        db,
        c.get('project').id,
        c.req.valid('param').id,
        c.req.valid('json'),
      )
      return c.json(rotated)
    },
  )

  return router
}
