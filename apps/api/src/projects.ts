import { projects } from '@agenttrace/db'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { generateIngestKey, hashIngestKey } from './ingest-key.js'

export interface CreatedProject {
  readonly projectId: string
  /**
   * Єдиний момент, коли ключ існує у відкритому вигляді. Він не повертається
   * більше нізвідки й не відновлюється: втрачений ключ можна тільки замінити.
   */
  readonly ingestKey: string
}

export async function createProject<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
>(db: PgDatabase<TQueryResult, TFullSchema>, name: string): Promise<CreatedProject> {
  const ingestKey = generateIngestKey()
  const [created] = await db
    .insert(projects)
    .values({ name, ingestKeyHash: await hashIngestKey(ingestKey) })
    .returning({ id: projects.id })

  if (created === undefined) throw new Error('createProject: insert returned no row')

  return { projectId: created.id, ingestKey }
}
