import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from './errors.js'
import { createProject } from './projects.js'
import {
  assertStepCountWithinLimit,
  bodyTooLarge,
  chargeDailyQuota,
  createRateLimiter,
  MAX_BODY_BYTES,
  MAX_STEPS,
} from './quota.js'

const migrationDir = fileURLToPath(new URL('../drizzle/', import.meta.resolve('@agenttrace/db')))
const migration = readdirSync(migrationDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(migrationDir + name, 'utf8'))
  .join('\n')

let client: PGlite
let db: ReturnType<typeof drizzle>
let projectId: string

beforeAll(async () => {
  client = await PGlite.create()
  await client.exec(migration)
  db = drizzle(client)
}, 60_000)

beforeEach(async () => {
  await client.query('DELETE FROM projects')
  projectId = (await createProject(db, 'demo')).projectId
})

const setQuota = (limit: number) =>
  client.query('UPDATE projects SET daily_quota = $1 WHERE id = $2', [limit, projectId])

/**
 * `day` нормалізується до рядка: драйвер віддає його обʼєктом `Date`, і тест,
 * написаний під конкретне представлення дати, ламався б від зміни драйвера,
 * нічого не кажучи про поведінку квоти.
 */
const usage = async () => {
  const result = await client.query<{ project_id: string; day: unknown; decisions_count: number }>(
    'SELECT * FROM usage_daily',
  )
  return result.rows.map((row) => ({
    ...row,
    day: new Date(String(row.day)).toISOString().slice(0, 10),
  }))
}

/**
 * Списання завжди йде у транзакції — саме так його кличе приймання, і саме
 * транзакція відкочує інкремент при перевищенні. Викликати його «голим» означало б
 * перевіряти те, чого в застосунку не буває.
 */
const charge = (quota: number, id = projectId) =>
  db.transaction((tx) => chargeDailyQuota(tx, id, quota))

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run()
  } catch (cause) {
    return cause instanceof AppError ? cause.code : `unexpected: ${String(cause)}`
  }
  return 'no error'
}

describe('стеля кроків', () => {
  it('takes a decision of ordinary shape', () => {
    expect(() => assertStepCountWithinLimit(8)).not.toThrow()
  })

  it('takes a decision sitting exactly on the ceiling', () => {
    // Стеля — це «не більше», а не «менше»: зсув на одиницю відкидав би рішення,
    // яке за документом дозволене.
    expect(() => assertStepCountWithinLimit(MAX_STEPS)).not.toThrow()
  })

  it('refuses one step past it, finally rather than temporarily', async () => {
    // `INVALID_INPUT`, бо повтор того самого рішення нічого не змінить.
    expect(await codeOf(async () => assertStepCountWithinLimit(MAX_STEPS + 1))).toBe(
      'INVALID_INPUT',
    )
  })

  it('says what the ceiling is and what arrived', () => {
    // FR-030: причина відмови явна. «Занадто велике» без числа не дає авторові
    // агента жодного способу полагодити це, крім вгадування.
    try {
      assertStepCountWithinLimit(MAX_STEPS + 1)
      expect.unreachable('the ceiling should have been enforced')
    } catch (cause) {
      expect(cause).toBeInstanceOf(AppError)
      expect((cause as AppError).details).toMatchObject({
        limit: MAX_STEPS,
        actual: MAX_STEPS + 1,
      })
    }
  })
})

describe('стеля розміру', () => {
  it('names the limit it refused against', () => {
    expect(bodyTooLarge().details).toMatchObject({ limit: MAX_BODY_BYTES })
  })

  it('is final, not temporary — a bigger body will not shrink on retry', () => {
    expect(bodyTooLarge().code).toBe('INVALID_INPUT')
  })
})

describe('добова квота', () => {
  it('counts an accepted decision against the day', async () => {
    await charge(10_000)

    expect(await usage()).toEqual([
      { project_id: projectId, day: new Date().toISOString().slice(0, 10), decisions_count: 1 },
    ])
  })

  it('adds up across decisions of the same day', async () => {
    for (let i = 0; i < 3; i += 1) await charge(10_000)

    expect((await usage())[0]?.decisions_count).toBe(3)
  })

  it('lets the project reach its limit exactly', async () => {
    await setQuota(2)

    await charge(2)
    await charge(2)

    expect((await usage())[0]?.decisions_count).toBe(2)
  })

  it('refuses the one past the limit as RATE_LIMITED, not as bad input', async () => {
    // SDK повторює 429 і остаточно відкидає 4xx. Вичерпана квота минає з добою,
    // тож підписане рішення не має через неї загинути.
    await setQuota(1)
    await charge(1)

    expect(await codeOf(() => charge(1))).toBe('RATE_LIMITED')
  })

  it('does not spend the quota it refused', async () => {
    await setQuota(1)
    await charge(1)
    await codeOf(() => charge(1))

    // Лічильник мусить лишитись на межі, а не поповзти вгору від невдалих спроб:
    // інакше відмовлений трафік з'їдав би завтрашню квоту так само, як прийнятий.
    expect((await usage())[0]?.decisions_count).toBe(1)
  })

  it('tells the sender the limit it hit and what it has spent', async () => {
    await setQuota(1)
    await charge(1)

    try {
      await charge(1)
      expect.unreachable('the quota should have been enforced')
    } catch (cause) {
      expect((cause as AppError).details).toMatchObject({ limit: 1, used: 1 })
    }
  })

  it('keeps each project on its own count', async () => {
    const other = (await createProject(db, 'other')).projectId

    await charge(10_000)
    await charge(10_000, other)
    await charge(10_000, other)

    const counts = Object.fromEntries(
      (await usage()).map((row) => [row.project_id, row.decisions_count]),
    )
    expect(counts).toEqual({ [projectId]: 1, [other]: 2 })
  })
})

describe('rate limit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('lets a burst through up to the size of the bucket', () => {
    const allow = createRateLimiter({ burst: 3, perSecond: 1 })

    expect([allow('p'), allow('p'), allow('p')]).toEqual([true, true, true])
  })

  it('refuses once the burst is spent', () => {
    const allow = createRateLimiter({ burst: 2, perSecond: 1 })
    allow('p')
    allow('p')

    expect(allow('p')).toBe(false)
  })

  it('refills over time rather than resetting on a clock edge', () => {
    // Вікно з різким скиданням дає подвійний сплеск на межі: усе відро наприкінці
    // одного вікна і повне відро одразу на початку наступного.
    const allow = createRateLimiter({ burst: 2, perSecond: 2 })
    allow('p')
    allow('p')
    expect(allow('p')).toBe(false)

    vi.advanceTimersByTime(500)
    expect(allow('p')).toBe(true)
    expect(allow('p')).toBe(false)
  })

  it('never refills past the burst it was given', () => {
    const allow = createRateLimiter({ burst: 2, perSecond: 10 })
    allow('p')
    vi.advanceTimersByTime(60_000)

    expect([allow('p'), allow('p'), allow('p')]).toEqual([true, true, false])
  })

  it('keeps one project from spending another project’s allowance', () => {
    const allow = createRateLimiter({ burst: 1, perSecond: 1 })

    expect(allow('first')).toBe(true)
    expect(allow('second')).toBe(true)
    expect(allow('first')).toBe(false)
  })
})
