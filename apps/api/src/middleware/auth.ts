import { projects } from '@agenttrace/db'
import { eq } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import type { MiddlewareHandler } from 'hono'
import type { Variables } from '../app.js'
import { AppError } from '../errors.js'
import { hashIngestKey, isIngestKeyShaped } from '../ingest-key.js'

/**
 * Те, що приймання знає про проєкт **після** авторизації. Квота і гаряче вікно
 * тут не заради зручності: обидва потрібні на тому ж запиті, і другий похід
 * у базу за ними означав би два запити на кожне прийняте рішення.
 */
export interface ProjectContext {
  readonly id: string
  readonly name: string
  readonly dailyQuota: number
  readonly hotWindowDays: number
}

export type ProjectLookup = (ingestKeyHash: string) => Promise<ProjectContext | undefined>

/**
 * Тип узятий на рівні діалекту, а не як наш `Db`, і параметризований: у
 * `PgDatabase` схема стоїть в інваріантній позиції, тож фіксована перетворила б
 * підпис на «рівно postgres-js рівно з нашою схемою». Так функція проганяється
 * тестом на PGlite — на тій самій міграції, що поїде в Supabase.
 */
export function projectByIngestKeyHash<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
>(db: PgDatabase<TQueryResult, TFullSchema>): ProjectLookup {
  return async (ingestKeyHash) => {
    const [project] = await db
      .select({
        id: projects.id,
        name: projects.name,
        dailyQuota: projects.dailyQuota,
        hotWindowDays: projects.hotWindowDays,
      })
      .from(projects)
      .where(eq(projects.ingestKeyHash, ingestKeyHash))
      .limit(1)

    return project
  }
}

const BEARER = /^Bearer\s+(\S+)$/i

/**
 * Кеша тут немає навмисно: при 10k рішень на добу це 0.12 запиту на секунду за
 * унікальним індексом, а кеш означав би, що відкликаний ключ ще працює — рівно
 * в той проміжок, заради якого його відкликали.
 */
export function ingestAuth(lookup: ProjectLookup): MiddlewareHandler<{ Variables: Variables }> {
  return async (c, next) => {
    const key = BEARER.exec(c.req.header('authorization') ?? '')?.[1]

    if (key === undefined || !isIngestKeyShaped(key)) {
      throw new AppError('UNAUTHORIZED', 'Ingest key missing or malformed')
    }

    const project = await lookup(await hashIngestKey(key))
    if (project === undefined) {
      throw new AppError('UNAUTHORIZED', 'Ingest key not recognised')
    }

    c.set('project', project)
    await next()
  }
}
