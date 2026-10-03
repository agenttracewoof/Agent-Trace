import { members, projects } from '@agenttrace/db'
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { AppError } from './errors.js'
import { generateIngestKey, hashIngestKey } from './ingest-key.js'

type Db<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
> = PgDatabase<TQueryResult, TFullSchema>

export interface CreatedProject {
  readonly projectId: string
  /**
   * Єдиний момент, коли ключ існує у відкритому вигляді. Він не повертається
   * більше нізвідки й не відновлюється: втрачений ключ можна тільки замінити.
   */
  readonly ingestKey: string
  readonly createdAt: Date
}

export interface CreateProjectOptions {
  /** Omitted, the column default applies: the console seeds projects at full capacity. */
  readonly dailyQuota?: number
  readonly selfServe?: boolean
}

export async function createProject<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
>(
  db: Db<TQueryResult, TFullSchema>,
  name: string,
  options: CreateProjectOptions = {},
): Promise<CreatedProject> {
  const ingestKey = generateIngestKey()
  const [created] = await db
    .insert(projects)
    .values({
      name,
      ingestKeyHash: await hashIngestKey(ingestKey),
      selfServe: options.selfServe ?? false,
      ...(options.dailyQuota === undefined ? {} : { dailyQuota: options.dailyQuota }),
    })
    .returning({ id: projects.id, createdAt: projects.createdAt })

  if (created === undefined) throw new Error('createProject: insert returned no row')

  return { projectId: created.id, ingestKey, createdAt: created.createdAt }
}

/**
 * Self-service spends our money: every decision is a fee from the payer
 * wallet, RPC credits and database rows, and `PLAN.md` → "Free tier capacity"
 * budgets all of it at 10 000 decisions a day for the whole system (SC-008).
 * Before T078 every project came from the console at the column default of
 * 10 000 — one stranger's project at that quota could take the entire budget
 * and stop our own demo anchoring, as running out of Helius credits did on
 * 2026-09-28.
 *
 * So a quota is treated as a promise, and the promises add up: self-served
 * projects together may reserve at most half the budget, and the other half
 * stays with the owner. What is reserved, not what is used, is counted —
 * counting usage would let one project's busy day refuse another project
 * decisions it was promised. A project the owner moves to a larger quota by
 * hand still counts until its `self_serve` flag is cleared.
 */
export const SELF_SERVE_DAILY_QUOTA = 100
export const SELF_SERVE_QUOTA_BUDGET = 5_000
export const MAX_OWNED_PROJECTS = 3

/**
 * Both ceilings are read-then-insert, and two requests reading at once would
 * both see room for one more. A transaction-scoped advisory lock serialises
 * self-service creation — a rare act, so the queue is never long — and is
 * released with the transaction, pooler or not.
 */
const SELF_SERVE_LOCK = 'agenttrace:self-serve-projects'

export interface MemberProject {
  readonly id: string
  readonly name: string
  readonly role: 'owner' | 'operator'
  readonly dailyQuota: number
  readonly createdAt: Date
}

export async function createSelfServeProject<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
>(
  db: Db<TQueryResult, TFullSchema>,
  userId: string,
  name: string,
): Promise<{ project: MemberProject; ingestKey: string }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${SELF_SERVE_LOCK}))`)

    const [owned] = await tx
      .select({ count: count() })
      .from(members)
      .innerJoin(projects, eq(projects.id, members.projectId))
      .where(
        and(eq(members.userId, userId), eq(members.role, 'owner'), eq(projects.selfServe, true)),
      )
    if ((owned?.count ?? 0) >= MAX_OWNED_PROJECTS) {
      // Final, not "later": no amount of waiting frees a slot (`quota.ts`).
      throw new AppError('INVALID_INPUT', 'This account already owns as many projects as it may', {
        reason: 'projects-per-account',
        limit: MAX_OWNED_PROJECTS,
      })
    }

    const [reserved] = await tx
      .select({ total: sql<number>`coalesce(sum(${projects.dailyQuota}), 0)::int` })
      .from(projects)
      .where(eq(projects.selfServe, true))
    if ((reserved?.total ?? 0) + SELF_SERVE_DAILY_QUOTA > SELF_SERVE_QUOTA_BUDGET) {
      throw new AppError('RATE_LIMITED', 'New projects are paused: shared capacity is taken', {
        reason: 'capacity',
      })
    }

    const { projectId, ingestKey, createdAt } = await createProject(tx, name, {
      dailyQuota: SELF_SERVE_DAILY_QUOTA,
      selfServe: true,
    })
    await tx.insert(members).values({ projectId, userId, role: 'owner' })

    return {
      project: {
        id: projectId,
        name,
        role: 'owner',
        dailyQuota: SELF_SERVE_DAILY_QUOTA,
        createdAt,
      },
      ingestKey,
    }
  })
}

/** Every project the user is a member of, oldest first, whoever created it. */
export async function projectsOf<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
>(db: Db<TQueryResult, TFullSchema>, userId: string): Promise<MemberProject[]> {
  return db
    .select({
      id: projects.id,
      name: projects.name,
      role: members.role,
      dailyQuota: projects.dailyQuota,
      createdAt: projects.createdAt,
    })
    .from(members)
    .innerJoin(projects, eq(projects.id, members.projectId))
    .where(eq(members.userId, userId))
    .orderBy(asc(projects.createdAt), asc(projects.id))
}

/**
 * Replaces the key of a project the user owns; `undefined` for any other
 * project, so the caller answers 404 whether it is foreign or absent (`errors.ts`).
 *
 * The old key stops working on the next request: `ingestAuth` looks the hash
 * up on every call and caches nothing. Decisions already accepted under it are
 * untouched — the key authorises ingest, it signs nothing (FR-015).
 *
 * The ownership test is a plain `IN` over `members`, not a correlated
 * `EXISTS`: drizzle drops the table qualifier inside a correlated subquery,
 * and `project_id = id` would silently compare the column with itself.
 */
export async function reissueIngestKey<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
>(
  db: Db<TQueryResult, TFullSchema>,
  userId: string,
  projectId: string,
): Promise<string | undefined> {
  const ingestKey = generateIngestKey()
  const owned = db
    .select({ projectId: members.projectId })
    .from(members)
    .where(
      and(eq(members.projectId, projectId), eq(members.userId, userId), eq(members.role, 'owner')),
    )

  const [updated] = await db
    .update(projects)
    .set({ ingestKeyHash: await hashIngestKey(ingestKey) })
    .where(and(eq(projects.id, projectId), inArray(projects.id, owned)))
    .returning({ id: projects.id })

  return updated === undefined ? undefined : ingestKey
}
