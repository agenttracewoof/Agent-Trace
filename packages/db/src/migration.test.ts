import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { agentKeys, agents, decisions, projects } from './schema/core.js'

/**
 * Міграція — це артефакт, а не код: її пише генератор, а накочують один раз
 * і назавжди. Тому перевіряється тут сам **файл**, а не наміри схеми. Усе, що
 * нижче, — це помилки, які видно лише у згенерованому SQL і які коштують або
 * впалого деплою, або мовчки вимкненого захисту.
 *
 * Чого ці тести **не** доводять: що міграція накочується на справжній Postgres.
 * Без бази це недоказуване, і так і має бути записано (T060 — перше місце,
 * де база зʼявиться).
 */

const dir = fileURLToPath(new URL('../drizzle/', import.meta.url))

const migrations = readdirSync(dir)
  .filter((name) => name.endsWith('.sql'))
  .sort()

const sql = migrations.map((name) => readFileSync(dir + name, 'utf8')).join('\n')

const tableNames = [projects, agents, agentKeys, decisions].map(
  (table) => getTableConfig(table).name,
)

describe('перша міграція', () => {
  it('exists as a single file — the schema has never been changed yet', () => {
    expect(migrations).toEqual(['0000_init.sql'])
  })

  it('creates every table the schema declares', () => {
    for (const name of tableNames) {
      expect(sql).toContain(`CREATE TABLE "${name}"`)
    }
  })
})

describe('RLS deny-all', () => {
  it.each(['projects', 'agents', 'agent_keys', 'decisions'])(
    'turns row level security on for %s',
    (name) => {
      expect(sql).toContain(`ALTER TABLE "${name}" ENABLE ROW LEVEL SECURITY;`)
    },
  )

  it('creates no policy at all — that is what makes it deny-all', () => {
    // Увімкнений RLS без жодної політики забороняє все всім ролям, які його не
    // обходять. Перша ж політика, додана «щоб зручніше», тихо перетворює
    // страховку на дозвіл, і помітити це можна буде лише витоком.
    expect(sql).not.toMatch(/CREATE\s+POLICY/i)
  })

  it('leaves nobody out — every created table gets it', () => {
    const created = [...sql.matchAll(/CREATE TABLE "([^"]+)"/g)].map((match) => match[1])
    const guarded = [...sql.matchAll(/ALTER TABLE "([^"]+)" ENABLE ROW LEVEL SECURITY/g)].map(
      (match) => match[1],
    )
    expect(created.sort()).toEqual(guarded.sort())
  })
})

describe('DDL придатний до накатування', () => {
  it('carries no bound parameter placeholders', () => {
    // Інтерпольований у `sql` рядок стає `$1`, і в DDL це або падіння при
    // накатуванні, або — гірше — CHECK, який ні з чим не порівнює. Так поїхав
    // перший варіант hex-перевірок, і побачити це можна було тільки у файлі.
    const placeholders = sql.match(/\$\d+/g) ?? []
    expect(placeholders).toEqual([])
  })

  it('spells the hex constraints out in full', () => {
    const patterns = sql.match(/\^\[0-9a-f\]\{\d+\}\$/g) ?? []
    expect(patterns).toHaveLength(5)
    expect(new Set(patterns)).toEqual(new Set(['^[0-9a-f]{64}$', '^[0-9a-f]{128}$']))
  })

  it('keeps the partial index on the publisher queue', () => {
    expect(sql).toMatch(/CREATE INDEX "decisions_pending_idx".+WHERE .*'pending'/s)
  })
})
