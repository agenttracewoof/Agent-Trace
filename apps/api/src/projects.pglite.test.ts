import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashIngestKey, INGEST_KEY_PREFIX, isIngestKeyShaped } from './ingest-key.js'
import { projectByIngestKeyHash } from './middleware/auth.js'
import { createProject } from './projects.js'

/**
 * Запит авторизації виконується на **справжньому** Postgres із тією самою
 * міграцією, що поїде в Supabase. Прочитати `select … where eq(…)` і повірити
 * тут недостатньо: колонка, за якою шукають, — єдине, що відділяє чужий проєкт
 * від свого, і помилка в ній виглядала б як робочий код.
 *
 * Шлях до міграції береться через резолв пакета, а не відліком `../`: інакше
 * тест ламався б від переїзду каталогу, до якого не має стосунку.
 */
const migrationDir = fileURLToPath(new URL('../drizzle/', import.meta.resolve('@agenttrace/db')))
const migration = readdirSync(migrationDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(migrationDir + name, 'utf8'))
  .join('\n')

let client: PGlite
let db: ReturnType<typeof drizzle>

beforeAll(async () => {
  client = await PGlite.create()
  await client.exec(migration)
  db = drizzle(client)
}, 60_000)

afterAll(async () => {
  await client?.close()
})

describe('створення проєкту віддає ключ, яким можна авторизуватися', () => {
  it('mints a key the database accepts and the lookup resolves', async () => {
    const { projectId, ingestKey } = await createProject(db, 'demo')

    expect(isIngestKeyShaped(ingestKey)).toBe(true)
    expect(await projectByIngestKeyHash(db)(await hashIngestKey(ingestKey))).toEqual({
      id: projectId,
      name: 'demo',
      dailyQuota: 10_000,
      hotWindowDays: 14,
    })
  })

  it('stores the hash and not the key', async () => {
    // Форма «зберігання хешем» із боку запису: рядок у базі не має містити
    // нічого, чим можна авторизуватися, навіть якщо базу прочитають цілком.
    const { projectId, ingestKey } = await createProject(db, 'hash only')
    const stored = await client.query<{ ingest_key_hash: string }>(
      'SELECT ingest_key_hash FROM projects WHERE id = $1',
      [projectId],
    )

    expect(stored.rows[0]?.ingest_key_hash).toBe(await hashIngestKey(ingestKey))
    expect(stored.rows[0]?.ingest_key_hash).not.toContain(ingestKey)
  })

  it('keeps two projects apart, each behind its own key', async () => {
    const first = await createProject(db, 'first')
    const second = await createProject(db, 'second')
    const lookup = projectByIngestKeyHash(db)

    expect(first.ingestKey).not.toBe(second.ingestKey)
    expect((await lookup(await hashIngestKey(first.ingestKey)))?.id).toBe(first.projectId)
    expect((await lookup(await hashIngestKey(second.ingestKey)))?.id).toBe(second.projectId)
  })

  it('resolves nothing for a hash no project carries', async () => {
    const stranger = await hashIngestKey(`${INGEST_KEY_PREFIX}${'ff'.repeat(32)}`)

    expect(await projectByIngestKeyHash(db)(stranger)).toBeUndefined()
  })
})
