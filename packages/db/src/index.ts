import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

/**
 * pgbouncer (порт 6543) не підтримує prepared statements, а на free tier він
 * обовʼязковий: прямих підключень лише два, а сервісів у нас теж два.
 */
export function createDb(databaseUrl: string) {
  const client = postgres(databaseUrl, { prepare: !databaseUrl.includes(':6543') })
  return drizzle(client)
}

export type Db = ReturnType<typeof createDb>
