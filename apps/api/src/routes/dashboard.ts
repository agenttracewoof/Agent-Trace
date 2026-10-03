import { agents, decisions } from '@agenttrace/db'
import {
  JOURNAL_PAGE_DEFAULT,
  type JournalEntry,
  type JournalResponse,
  journalQuerySchema,
} from '@agenttrace/shared'
import { zValidator } from '@hono/zod-validator'
import { and, desc, eq, gte, lt, type SQL, sql } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Variables } from '../app.js'
import { asDecisionId, asUuid } from '../decision-id.js'
import { anchorOf } from '../decision-view.js'
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

/**
 * The operator's reading of a project: its decisions (FR-016, T039). Every
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

  return router
}
