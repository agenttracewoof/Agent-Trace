import { getAuthTables } from 'better-auth/db'
import { getTableColumns, getTableName } from 'drizzle-orm'
import { getTableConfig, type PgColumn, type PgTable } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { schema } from '../index.js'
import { accounts, memberRole, members, sessions, users, verifications } from './auth.js'
import { agentKeys } from './core.js'

/**
 * better-auth never looks at the database schema: its drizzle adapter looks
 * up `schema[model + 's']` and writes the fields it knows by property name.
 * A missing property surfaces as a failed sign-in, not as a type error, so
 * the check is against better-auth's own list of tables.
 */

const ours: Record<string, PgTable> = {
  user: users,
  session: sessions,
  account: accounts,
  verification: verifications,
}
const expected = getAuthTables({})

const uniqueColumns = (table: PgTable) =>
  getTableConfig(table)
    .indexes.filter((entry) => entry.config.unique)
    .flatMap((entry) =>
      entry.config.columns.map((column) => ('name' in column ? String(column.name) : '')),
    )

const foreignKey = (table: PgTable, column: string) =>
  getTableConfig(table).foreignKeys.find((fk) =>
    fk.reference().columns.some((candidate) => candidate.name === column),
  )

describe('better-auth tables', () => {
  it('covers exactly the models better-auth asks for', () => {
    expect(Object.keys(expected).sort()).toEqual(Object.keys(ours).sort())
  })

  it.each(Object.keys(ours))('exposes %s to the adapter under its plural name', (model) => {
    expect(schema[`${model}s` as keyof typeof schema]).toBe(ours[model])
  })

  const fields = Object.entries(expected).flatMap(([model, definition]) =>
    Object.entries(definition.fields).map(([field, attributes]) => ({ model, field, attributes })),
  )

  it.each(fields.map((entry) => [`${entry.model}.${entry.field}`, entry] as const))(
    'has %s with the same nullability',
    (_name, { model, field, attributes }) => {
      const table = ours[model]
      if (table === undefined) throw new Error(`no table for ${model}`)
      const column: PgColumn | undefined = getTableColumns(table)[field]
      expect(column).toBeDefined()
      expect(column?.notNull).toBe(attributes.required !== false)
    },
  )

  it.each(
    fields
      .filter((entry) => entry.attributes.unique)
      .map((entry) => [`${entry.model}.${entry.field}`, entry] as const),
  )('keeps %s unique', (_name, { model, field }) => {
    const table = ours[model]
    if (table === undefined) throw new Error(`no table for ${model}`)
    const column = getTableColumns(table)[field]
    expect(uniqueColumns(table)).toContain(column?.name)
  })

  it.each([sessions, accounts].map((table) => [getTableName(table), table] as const))(
    'drops %s with the user they belong to',
    (_name, table) => {
      const fk = foreignKey(table, 'user_id')
      expect(fk && getTableName(fk.reference().foreignTable)).toBe('users')
      expect(fk?.onDelete).toBe('cascade')
    },
  )

  it.each(Object.values(ours).map((table) => [getTableName(table), table] as const))(
    'gives %s a uuid id',
    (_name, table) => {
      expect(getTableColumns(table).id?.getSQLType()).toBe('uuid')
    },
  )
})

describe('membership', () => {
  it('admits one row per user and project', () => {
    const [primaryKey] = getTableConfig(members).primaryKeys
    expect(primaryKey?.columns.map((column) => column.name)).toEqual(['project_id', 'user_id'])
  })

  it('knows only the owner and the operator', () => {
    expect(memberRole.enumValues).toEqual(['owner', 'operator'])
  })

  it.each(['project_id', 'user_id'])('goes away with its %s', (column) => {
    expect(foreignKey(members, column)?.onDelete).toBe('cascade')
  })
})

describe('emergency key replacement', () => {
  it('names a user that exists and cannot be deleted from under it', () => {
    const fk = foreignKey(agentKeys, 'confirmed_by')
    expect(fk && getTableName(fk.reference().foreignTable)).toBe('users')
    expect(fk?.onDelete).toBe('restrict')
  })
})
