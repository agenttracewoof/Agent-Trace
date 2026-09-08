import { createDb } from '@agenttrace/db'
import { z } from 'zod'
import { createProject } from '../projects.js'

/**
 * Створює проєкт і показує його ingest-ключ **один раз**.
 *
 * Це не «оператор реєструє проект» із FR-015 — та половина вимоги живе у
 * дашборді й нездійсненна до появи акаунтів (T038). Доти авторитет тут —
 * доступ до `DATABASE_URL`, тобто рівно той самий, що й у міграції: хто може
 * накотити схему, той може завести проєкт. Ендпоінт замість скрипта означав
 * би другий механізм авторизації, який довелося б прибирати на T038.
 *
 *   pnpm --filter @agenttrace/api seed:project -- --name "Demo"
 */

const nameSchema = z.string().min(1).max(128)

function parseName(argv: readonly string[]): string {
  const at = argv.indexOf('--name')
  const parsed = nameSchema.safeParse(at === -1 ? undefined : argv[at + 1])

  if (!parsed.success) {
    throw new Error('usage: seed:project -- --name "<project name>"')
  }
  return parsed.data
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is not set')
  }

  const name = parseName(process.argv.slice(2))
  const db = createDb(databaseUrl)

  try {
    const { projectId, ingestKey } = await createProject(db, name)

    // Навмисно повз логер: ключ призначений очам оператора, а все, що поїхало
    // в логер, живе стільки ж, скільки лог, і їде туди ж, куди його відвантажують.
    console.log(`project    ${projectId}  ${name}`)
    console.log('ingest key (shown once, never stored, cannot be recovered):')
    console.log(`  ${ingestKey}`)
  } finally {
    await db.$client.end()
  }
}

main().catch((cause: unknown) => {
  // `message` у drizzle — це дамп запиту, а причина відмови (недоступна база,
  // ненакочена міграція) лежить у `cause`. Без другого рядка оператор бачить
  // SQL і не бачить, чому він не виконався.
  console.error(cause instanceof Error ? cause.message : String(cause))
  if (cause instanceof Error && cause.cause !== undefined) console.error(cause.cause)
  process.exit(1)
})
