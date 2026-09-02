import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { agentKeys, agents, decisionStatus, decisions, projects, rotationKind } from './core.js'

/**
 * Схема перевіряється без бази: тут стережуться не запити, а **інваріанти
 * форми**, кожен з яких, зламавшись, дає не помилку, а тихо неправильні дані.
 * Справжні запити перевіряються на міграції (T017) і вище по стеку.
 */

const config = {
  projects: getTableConfig(projects),
  agents: getTableConfig(agents),
  agentKeys: getTableConfig(agentKeys),
  decisions: getTableConfig(decisions),
}

type TableName = keyof typeof config

const columnsOf = (table: TableName) =>
  Object.fromEntries(config[table].columns.map((column) => [column.name, column]))

const sqlTypeOf = (table: TableName, name: string) => {
  const column = columnsOf(table)[name]
  if (column === undefined) throw new Error(`${table} has no column ${name}`)
  return column.getSQLType()
}

const indexNames = (table: TableName) => config[table].indexes.map((entry) => entry.config.name)
const checkNames = (table: TableName) => config[table].checks.map((entry) => entry.name)

/**
 * Індекс може стояти і на виразі, тож drizzle типізує його колонки як
 * «щось із можливим `name`». Порядок колонок тут — те, заради чого ці тести
 * і написані (keyset у SC-007), тож розбираємо обережно, а не через каст.
 */
const indexColumns = (table: TableName, name: string): string[] => {
  const entry = config[table].indexes.find((candidate) => candidate.config.name === name)
  if (entry === undefined) throw new Error(`${table} has no index ${name}`)
  return entry.config.columns.map((column) =>
    'name' in column && typeof column.name === 'string' ? column.name : '<expression>',
  )
}

describe('форма рядка рішення відповідає підписаному манифесту', () => {
  /**
   * Кожне поле манифесту має мати домівку, інакше зібрати його назад з бази
   * неможливо, а зібраний неправильно він дасть не помилку, а «tampered» —
   * тобто система звинуватить чесного клієнта в підробці.
   * `agentPubkey` навмисно не тут: він живе в `agent_keys.public_key`, і саме
   * тому нижче стоїть окремий тест на досяжність.
   */
  const HOMES: Record<string, string> = {
    version: 'manifest_version',
    decisionId: 'id',
    model: 'model_ref',
    sources: 'sources',
    root: 'root',
    decidedAt: 'decided_at',
    outcome: 'outcome',
    steps: 'steps',
    signature: 'signature',
  }

  it.each(Object.entries(HOMES))('%s → decisions.%s', (_field, column) => {
    expect(columnsOf('decisions')[column]).toBeDefined()
  })

  it('reaches agentPubkey through the key that signed the decision', () => {
    expect(columnsOf('decisions').agent_key_id?.notNull).toBe(true)
    expect(sqlTypeOf('agentKeys', 'public_key')).toBe('varchar(64)')
  })

  it('takes decisionId from the client instead of generating it', () => {
    // Ідемпотентність приймання (FR-007) тримається саме на цьому: якби id
    // генерувала база, повтор після обриву створив би друге рішення.
    expect(columnsOf('decisions').id?.hasDefault).toBe(false)
    expect(columnsOf('decisions').id?.primary).toBe(true)
  })
})

describe('поля, що входять у підпис, не конвертуються', () => {
  it('keeps decidedAt an integer of milliseconds, not a timestamp', () => {
    expect(sqlTypeOf('decisions', 'decided_at')).toBe('bigint')
  })

  it('keeps the key validity window in the same milliseconds the anchor signed', () => {
    expect(sqlTypeOf('agentKeys', 'valid_from')).toBe('bigint')
    expect(sqlTypeOf('agentKeys', 'valid_to')).toBe('bigint')
  })

  it('leaves our own bookkeeping as timestamptz', () => {
    for (const name of ['received_at', 'next_attempt_at', 'anchored_at']) {
      expect(sqlTypeOf('decisions', name)).toBe('timestamp with time zone')
    }
  })
})

describe('двійкові поля — hex фіксованої довжини, і це закріплено', () => {
  it.each([
    ['projects', 'ingest_key_hash', 32],
    ['agentKeys', 'public_key', 32],
    ['agentKeys', 'rotation_proof', 64],
    ['decisions', 'root', 32],
    ['decisions', 'signature', 64],
  ] as const)('%s.%s holds %d bytes as hex', (table, column, bytes) => {
    expect(sqlTypeOf(table, column)).toBe(`varchar(${bytes * 2})`)
  })

  it('backs the length with a lowercase-hex check, not just a width', () => {
    // varchar(64) приймає 64 пробіли. Формат — ні (MANIFEST-FORMAT.md §1).
    expect(checkNames('decisions')).toContain('decisions_root_hex')
    expect(checkNames('decisions')).toContain('decisions_signature_hex')
    expect(checkNames('agentKeys')).toContain('agent_keys_public_key_hex')
    expect(checkNames('agentKeys')).toContain('agent_keys_rotation_proof_hex')
    expect(checkNames('projects')).toContain('projects_ingest_key_hash_hex')
  })
})

describe('історія ключів', () => {
  it('names exactly the three rotation kinds, initial included', () => {
    // `initial` немає у форматі: перший ключ ніхто не ротував, якоря під ним
    // не існує. У базі він потрібен, щоб історія починалася з рядка, а не з дірки.
    expect(rotationKind.enumValues).toEqual(['initial', 'chained', 'administrative'])
  })

  it('refuses to let one Ed25519 key belong to two agents', () => {
    const unique = config.agentKeys.indexes.filter((entry) => entry.config.unique)
    expect(unique.map((entry) => entry.config.name)).toContain('agent_keys_public_key_key')
  })

  it('ties the shape of the row to how the key was replaced', () => {
    // Без цієї перевірки «розрив тяглості приховати неможливо» трималося б на
    // коді, який рядок пише, а не на базі, яка його приймає (FR-022 / FR-027).
    expect(checkNames('agentKeys')).toContain('agent_keys_rotation_shape')
    expect(checkNames('agentKeys')).toContain('agent_keys_validity_window')
  })

  it('will not drop the key a decision was signed with', () => {
    const toKeys = config.decisions.foreignKeys.find(
      (fk) => fk.reference().foreignTable === agentKeys,
    )
    // Решта звʼязків каскадні — проєкт можна видалити цілком. Ключ ні: без нього
    // рішення лишається в базі, але сказати, чим його перевіряти, вже нічим.
    expect(toKeys?.onDelete).toBe('restrict')
  })
})

describe('ізоляція орендарів і черга', () => {
  it('makes an agent unique inside its project, not globally', () => {
    const unique = config.agents.indexes.filter((entry) => entry.config.unique)
    expect(unique.map((entry) => entry.config.name)).toEqual(['agents_project_external_key'])
    expect(indexColumns('agents', 'agents_project_external_key')).toEqual([
      'project_id',
      'external_id',
    ])
  })

  it('indexes the publisher queue partially, on pending rows only', () => {
    const queue = config.decisions.indexes.find(
      (entry) => entry.config.name === 'decisions_pending_idx',
    )
    // Повний індекс платив би пам'яттю за 99% рядків, які вже заякорені.
    expect(queue?.config.where).toBeDefined()
    expect(indexColumns('decisions', 'decisions_pending_idx')).toEqual(['next_attempt_at'])
  })

  it('indexes the journal by the keyset SC-007 will page through', () => {
    expect(indexColumns('decisions', 'decisions_journal_idx')).toEqual([
      'project_id',
      'decided_at',
      'id',
    ])
  })

  it('scopes every decision to a project and an agent', () => {
    expect(columnsOf('decisions').project_id?.notNull).toBe(true)
    expect(columnsOf('decisions').agent_id?.notNull).toBe(true)
  })
})

describe('стани рішення', () => {
  it('names exactly the three the publisher can produce', () => {
    expect(decisionStatus.enumValues).toEqual(['pending', 'anchored', 'failed'])
  })

  it('refuses a half-written anchor', () => {
    expect(checkNames('decisions')).toContain('decisions_anchor_shape')
  })

  it('refuses an archive record without a location, and the reverse', () => {
    // FR-028: місце звільняється лише після підтвердженого вивантаження.
    expect(checkNames('decisions')).toContain('decisions_archive_shape')
  })

  it('keeps the row when the owner deletes the content', () => {
    // FR-024: доказ існування переживає видалення вмісту.
    const column = columnsOf('decisions').content_deleted_at
    expect(column).toBeDefined()
    expect(column?.notNull).toBe(false)
  })
})

describe('усі чотири таблиці на місці', () => {
  it('names them as PLAN says', () => {
    expect(
      Object.values(config)
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(['agent_keys', 'agents', 'decisions', 'projects'])
  })

  it('indexes nothing twice', () => {
    const names = (Object.keys(config) as TableName[]).flatMap(indexNames)
    expect(new Set(names).size).toBe(names.length)
  })
})
