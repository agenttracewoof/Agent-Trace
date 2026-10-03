import {
  type CreateProjectResponse,
  createProjectRequestSchema,
  type ListProjectsResponse,
  type ProjectSummary,
  type ReissueIngestKeyResponse,
} from '@agenttrace/shared'
import { zValidator } from '@hono/zod-validator'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Variables } from '../app.js'
import { AppError } from '../errors.js'
import {
  dashboardCors,
  requireDashboardOrigin,
  type SessionLookup,
  sessionAuth,
} from '../middleware/dashboard.js'
import {
  createSelfServeProject,
  MAX_OWNED_PROJECTS,
  type MemberProject,
  projectsOf,
  reissueIngestKey,
} from '../projects.js'

type Db<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
> = PgDatabase<TQueryResult, TFullSchema>

export interface ProjectRoutesOptions {
  readonly webOrigin: string
  readonly sessionUser: SessionLookup
}

const summary = (project: MemberProject): ProjectSummary => ({
  ...project,
  createdAt: project.createdAt.toISOString(),
})

/** Not a uuid cannot name a project; it is "not found", not a malformed request. */
const projectIdSchema = z.uuid()

/**
 * The operator's side of FR-015: create a project, see one's projects, and
 * replace a lost ingest key. The key is in the clear in exactly two responses
 * — creation and replacement — and nowhere else, ever.
 *
 * The session check sits in each route's own chain, like `ingestAuth` in
 * `agents.ts`: whether a route is open is visible on the line that declares it.
 */
export function projectRoutes<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
>(db: Db<TQueryResult, TFullSchema>, options: ProjectRoutesOptions) {
  const router = new Hono<{ Variables: Variables }>()
  const session = sessionAuth(options.sessionUser)

  // `/projects/*` covers `/projects` itself and nothing beside it.
  router.use('/projects/*', dashboardCors(options.webOrigin))
  router.use('/projects/*', requireDashboardOrigin(options.webOrigin))

  router.get('/projects', session, async (c) => {
    const body: ListProjectsResponse = {
      projects: (await projectsOf(db, c.get('userId'))).map(summary),
      maxOwnedProjects: MAX_OWNED_PROJECTS,
    }
    return c.json(body)
  })

  router.post(
    '/projects',
    session,
    zValidator('json', createProjectRequestSchema, (result) => {
      if (!result.success) throw result.error
    }),
    async (c) => {
      const created = await createSelfServeProject(db, c.get('userId'), c.req.valid('json').name)
      const body: CreateProjectResponse = {
        project: summary(created.project),
        ingestKey: created.ingestKey,
      }
      c.header('Cache-Control', 'no-store')
      return c.json(body, 201)
    },
  )

  router.post('/projects/:id/ingest-key', session, async (c) => {
    const projectId = projectIdSchema.safeParse(c.req.param('id'))
    const ingestKey = projectId.success
      ? await reissueIngestKey(db, c.get('userId'), projectId.data)
      : undefined
    if (ingestKey === undefined) throw new AppError('NOT_FOUND', 'Project not found')

    const body: ReissueIngestKeyResponse = { ingestKey }
    c.header('Cache-Control', 'no-store')
    return c.json(body)
  })

  return router
}
