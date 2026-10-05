import { agentKeys, agents, decisions } from '@agenttrace/db'
import { hexDigest } from '@agenttrace/manifest'
import {
  type DecisionDetailsResponse,
  JOURNAL_PAGE_DEFAULT,
  type JournalEntry,
  type JournalResponse,
  journalQuerySchema,
  PROJECT_AGENTS_MAX,
  type ProjectAgentsResponse,
} from '@agenttrace/shared'
import { zValidator } from '@hono/zod-validator'
import { and, asc, desc, eq, gte, lt, type SQL, sql } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Variables } from '../app.js'
import { asDecisionId, asUuid } from '../decision-id.js'
import { anchorOf, decisionViewColumns, presentDecision } from '../decision-view.js'
import { AppError } from '../errors.js'
import { decodeJournalCursor, encodeJournalCursor } from '../journal-cursor.js'
import { type SessionLookup, sessionAuth } from '../middleware/dashboard.js'
import { isMemberOf } from '../projects.js'

type Db<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
> = PgDatabase<TQueryResult, TFullSchema>

export interface DashboardRoutesOptions {
  readonly sessionUser: SessionLookup
}

const throwOnInvalid = (result: { success: boolean; error?: unknown }): void => {
  // One error format across the API; the validator does not get to answer in its own.
  if (!result.success) throw result.error
}

const projectIdSchema = z.uuid()
const decisionIdSchema = hexDigest(16)

/**
 * The operator's reading of a project: its agents (T042), its decisions
 * (FR-016, T039) and each one in full (FR-017, T040). Every
 * route sits under `/projects/:projectId`, so the one question that decides
 * access — is this user a member of that project — is asked in one place, and
 * a foreign project answers exactly what an absent one does: 404 (T041).
 *
 * Mounted by `projectRoutes`, which owns CORS and the Origin check for
 * `/projects/*`; mounting this router anywhere else would leave it without
 * them. Not under `/decisions`: `POST /v1/decisions` is the SDK's ingest, and
 * a cookie guard on that prefix would sit in front of it.
 */
export function dashboardRoutes<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
>(db: Db<TQueryResult, TFullSchema>, options: DashboardRoutesOptions) {
  const router = new Hono<{ Variables: Variables }>()
  const session = sessionAuth(options.sessionUser)

  /** The project id of the path, once the user is known to be its member. */
  const memberProject = async (userId: string, raw: string): Promise<string> => {
    const projectId = projectIdSchema.safeParse(raw)
    if (projectId.success && (await isMemberOf(db, userId, projectId.data))) {
      return projectId.data
    }
    throw new AppError('NOT_FOUND', 'Project not found')
  }

  // Under the project, not `GET /agents`: `POST /v1/agents` is the SDK's
  // registration behind an ingest key, and this is a member's read behind a cookie.
  router.get('/projects/:projectId/agents', session, async (c) => {
    const projectId = await memberProject(c.get('userId'), c.req.param('projectId'))

    const rows = await db
      .select({
        id: agents.id,
        externalId: agents.externalId,
        name: agents.name,
        createdAt: agents.createdAt,
      })
      .from(agents)
      .where(eq(agents.projectId, projectId))
      .orderBy(asc(agents.name), asc(agents.id))
      .limit(PROJECT_AGENTS_MAX + 1)

    const body: ProjectAgentsResponse = {
      agents: rows.slice(0, PROJECT_AGENTS_MAX).map((row) => ({
        id: row.id,
        externalId: row.externalId,
        name: row.name,
        createdAt: row.createdAt.toISOString(),
      })),
      truncated: rows.length > PROJECT_AGENTS_MAX,
    }
    // An agent registers the moment its SDK starts; a cached list would hide it.
    c.header('Cache-Control', 'no-store')
    return c.json(body)
  })

  router.get(
    '/projects/:projectId/decisions',
    session,
    zValidator('query', journalQuerySchema, throwOnInvalid),
    async (c) => {
      const projectId = await memberProject(c.get('userId'), c.req.param('projectId'))
      const query = c.req.valid('query')
      const limit = query.limit ?? JOURNAL_PAGE_DEFAULT

      if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
        throw new AppError('INVALID_INPUT', 'The period ends before it starts')
      }
      const cursor = query.cursor === undefined ? undefined : decodeJournalCursor(query.cursor)
      if (query.cursor !== undefined && cursor === undefined) {
        throw new AppError('INVALID_INPUT', 'The page cursor is not one this journal issued')
      }

      const where: SQL[] = [eq(decisions.projectId, projectId)]
      if (query.agentId !== undefined) where.push(eq(decisions.agentId, query.agentId))
      if (query.from !== undefined) where.push(gte(decisions.decidedAt, query.from))
      if (query.to !== undefined) where.push(lt(decisions.decidedAt, query.to))
      if (query.status !== undefined) where.push(eq(decisions.status, query.status))
      if (cursor !== undefined) {
        // A row comparison, so the index on `(project_id, decided_at DESC, id DESC)`
        // serves it as one range rather than an OR of two.
        where.push(
          sql`(${decisions.decidedAt}, ${decisions.id}) < (${cursor.decidedAt}::bigint, ${asUuid(cursor.decisionId)}::uuid)`,
        )
      }

      // One row past the page says whether there is a next one, without a count.
      const rows = await db
        .select({
          id: decisions.id,
          agentId: agents.id,
          agentExternalId: agents.externalId,
          agentName: agents.name,
          model: decisions.modelRef,
          decidedAt: decisions.decidedAt,
          receivedAt: decisions.receivedAt,
          status: decisions.status,
          anchorSignature: decisions.anchorSignature,
          anchorSlot: decisions.anchorSlot,
          anchoredAt: decisions.anchoredAt,
          contentDeletedAt: decisions.contentDeletedAt,
        })
        .from(decisions)
        .innerJoin(agents, eq(agents.id, decisions.agentId))
        .where(and(...where))
        .orderBy(desc(decisions.decidedAt), desc(decisions.id))
        .limit(limit + 1)

      const page = rows.slice(0, limit)
      const last = page.at(-1)
      const entries = page.map(
        (row): JournalEntry => ({
          decisionId: asDecisionId(row.id),
          agent: { id: row.agentId, externalId: row.agentExternalId, name: row.agentName },
          model: row.model,
          decidedAt: row.decidedAt,
          receivedAt: row.receivedAt.toISOString(),
          status: row.status,
          anchor: anchorOf(row),
          contentDeletedAt: row.contentDeletedAt?.toISOString() ?? null,
        }),
      )

      const body: JournalResponse = {
        decisions: entries,
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeJournalCursor({
                decidedAt: last.decidedAt,
                decisionId: asDecisionId(last.id),
              })
            : null,
      }
      // A member's view behind a cookie, and pending rows change within seconds.
      c.header('Cache-Control', 'no-store')
      return c.json(body)
    },
  )

  router.get('/projects/:projectId/decisions/:decisionId', session, async (c) => {
    const projectId = await memberProject(c.get('userId'), c.req.param('projectId'))
    // The public 32-hex form, the one the journal and the link give. A malformed
    // id names no decision: 404, as for a project id that is not a uuid.
    const decisionId = decisionIdSchema.safeParse(c.req.param('decisionId'))
    if (!decisionId.success) throw new AppError('NOT_FOUND', 'Decision not found')

    const [row] = await db
      .select({
        ...decisionViewColumns,
        agentId: agents.id,
        agentExternalId: agents.externalId,
        agentName: agents.name,
        status: decisions.status,
        receivedAt: decisions.receivedAt,
      })
      .from(decisions)
      .innerJoin(agentKeys, eq(agentKeys.id, decisions.agentKeyId))
      .innerJoin(agents, eq(agents.id, decisions.agentId))
      // The project in the condition, not only in the membership check: a member
      // of project A asking for B's decision under A's path must find nothing.
      .where(and(eq(decisions.id, asUuid(decisionId.data)), eq(decisions.projectId, projectId)))
      .limit(1)
    if (row === undefined) throw new AppError('NOT_FOUND', 'Decision not found')

    const body: DecisionDetailsResponse = {
      ...(await presentDecision(row, decisionId.data)),
      agent: { id: row.agentId, externalId: row.agentExternalId, name: row.agentName },
      status: row.status,
      receivedAt: row.receivedAt.toISOString(),
    }
    c.header('Cache-Control', 'no-store')
    return c.json(body)
  })

  return router
}
