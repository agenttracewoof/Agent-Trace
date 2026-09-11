import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Міграція накочується на **справжній** Postgres (PGlite — це він, зібраний
 * у wasm), і далі перевіряється не форма SQL, а поведінка бази: що вона
 * приймає і що відхиляє.
 *
 * Різниця з `migration.test.ts` принципова. Той тест читає файл і бачить, що
 * в ньому написано; цей — виконує його і бачить, що з цього виходить.
 * Перша ж hex-перевірка поїхала у файл як `~ $1` і виглядала при цьому цілком
 * правдоподібно, тож «прочитати SQL» виявилось недостатньою мірою впевненості.
 *
 * Чого й цей тест не доводить: Supabase — не PGlite. Версія рушія тут 18.x,
 * а на free tier буде та, яку дасть Supabase; розбіжності можливі в дрібницях
 * планувальника, не в DDL. Перше місце, де це перевіряється по-справжньому, — T060.
 */

const dir = fileURLToPath(new URL('../drizzle/', import.meta.url))
const migration = readdirSync(dir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(dir + name, 'utf8'))
  .join('\n')

const hex = (bytes: number, fill = 'ab') => fill.repeat(bytes)
const PROJECT = '11111111-1111-4111-8111-111111111111'
const AGENT = '22222222-2222-4222-8222-222222222222'
const KEY = '33333333-3333-4333-8333-333333333333'
const DECIDED_AT = 1_760_000_000_000

let db: PGlite

/** Помилка Postgres, а не тексту: повертаємо код, щоб тест не залежав від формулювання. */
async function rejects(sql: string, params: unknown[] = []): Promise<string> {
  try {
    await db.query(sql, params)
  } catch (cause) {
    const code = (cause as { code?: unknown }).code
    return typeof code === 'string' ? code : 'no-code'
  }
  throw new Error(`expected the database to reject: ${sql}`)
}

const insertKey = (id: string, publicKey: string, kind: string, extra: Record<string, unknown>) =>
  db.query(
    `INSERT INTO agent_keys (id, agent_id, public_key, valid_from, valid_to, rotation_kind,
                             prev_key_id, rotation_proof, confirmed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      AGENT,
      publicKey,
      DECIDED_AT,
      extra.validTo ?? null,
      kind,
      extra.prevKeyId ?? null,
      extra.rotationProof ?? null,
      extra.confirmedBy ?? null,
    ],
  )

const insertDecision = (id: string, extra: Record<string, unknown> = {}) =>
  db.query(
    `INSERT INTO decisions (id, project_id, agent_id, agent_key_id, root, signature, decided_at,
                            model_ref, sources, steps, outcome, status,
                            anchor_signature, anchor_slot, anchored_at, archived_at, archive_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12,
             $13, $14, $15, $16, $17)`,
    [
      id,
      PROJECT,
      AGENT,
      KEY,
      extra.root ?? hex(32),
      extra.signature ?? hex(64, 'cd'),
      extra.decidedAt ?? DECIDED_AT,
      'claude-opus-5',
      JSON.stringify(['https://quotes.example/']),
      JSON.stringify([{ type: 'source.read', private: true }]),
      JSON.stringify({ action: 'swap' }),
      extra.status ?? 'pending',
      extra.anchorSignature ?? null,
      extra.anchorSlot ?? null,
      extra.anchoredAt ?? null,
      extra.archivedAt ?? null,
      extra.archiveUrl ?? null,
    ],
  )

beforeAll(async () => {
  db = await PGlite.create()
  await db.exec(migration)
  await db.query(`INSERT INTO projects (id, name, ingest_key_hash) VALUES ($1, 'demo', $2)`, [
    PROJECT,
    hex(32, '0f'),
  ])
  await db.query(
    `INSERT INTO agents (id, project_id, external_id, name) VALUES ($1, $2, 'a', 'A')`,
    [AGENT, PROJECT],
  )
  await insertKey(KEY, hex(32, '1a'), 'initial', {})
}, 60_000)

afterAll(async () => {
  await db?.close()
})

describe('міграція накочується на справжній Postgres', () => {
  it('creates every table the schema declares and takes a valid decision', async () => {
    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    )
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'agent_keys',
      'agents',
      'decisions',
      'projects',
      'usage_daily',
    ])

    await insertDecision('44444444-4444-4444-8444-444444444444')
    const count = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM decisions')
    expect(count.rows[0]?.n).toBe(1)
  })

  it('keeps the partial index the publisher queue depends on', async () => {
    const indexes = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'decisions_pending_idx'`,
    )
    expect(indexes.rows[0]?.indexdef).toContain("WHERE (status = 'pending'::decision_status)")
  })
})

describe('RLS deny-all тримає, а не просто увімкнений', () => {
  it('has row level security on every table and not one policy', async () => {
    const guarded = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY relname`,
    )
    expect(guarded.rows.every((row) => row.relrowsecurity)).toBe(true)

    const policies = await db.query(
      `SELECT policyname FROM pg_policies WHERE schemaname = 'public'`,
    )
    expect(policies.rows).toEqual([])
  })

  it('shows a leaked anon key nothing at all', async () => {
    // Рівно сценарій, від якого RLS тут і стоїть: ключ anon витік, привілеї
    // в нього є (Supabase їх видає), а політик немає. Рядок у базі лежить —
    // і не видно жодного.
    await db.exec(`
      CREATE ROLE anon NOLOGIN;
      GRANT USAGE ON SCHEMA public TO anon;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon;
    `)
    try {
      await db.exec('SET ROLE anon')
      const seen = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM decisions')
      expect(seen.rows[0]?.n).toBe(0)

      const code = await rejects(
        `INSERT INTO projects (name, ingest_key_hash) VALUES ('sneaky', $1)`,
        [hex(32, '0e')],
      )
      expect(code).toBe('42501')
    } finally {
      await db.exec('RESET ROLE')
    }

    // А службова роль бачить усе — інакше застосунок би не працював.
    const asOwner = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM decisions')
    expect(asOwner.rows[0]?.n).toBe(1)
  })
})

describe('CHECK-обмеження відхиляють те, заради чого написані', () => {
  it('refuses hex that is not lowercase hex', async () => {
    expect(await rejects(...uppercaseRoot())).toBe('23514')
  })

  it('refuses a decided_at outside the range the format allows', async () => {
    expect(
      await rejects(
        `INSERT INTO decisions (id, project_id, agent_id, agent_key_id, root, signature,
                                decided_at, model_ref, sources, steps, outcome)
         VALUES ($1, $2, $3, $4, $5, $6, -1, 'm', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)`,
        ['55555555-5555-4555-8555-555555555555', PROJECT, AGENT, KEY, hex(32), hex(64, 'cd')],
      ),
    ).toBe('23514')
  })

  it.each([
    ['initial with a predecessor', 'initial', { prevKeyId: KEY }],
    ['chained without a proof', 'chained', { prevKeyId: KEY }],
    ['chained without a predecessor', 'chained', { rotationProof: hex(64, 'ef') }],
    [
      'administrative without a confirmation',
      'administrative',
      {
        prevKeyId: KEY,
        rotationProof: hex(64, 'ef'),
      },
    ],
  ])('refuses a key row that is %s', async (_name, kind, extra) => {
    // FR-022 / FR-027: спосіб заміни ключа не можна записати наполовину.
    let code = 'accepted'
    try {
      await insertKey('66666666-6666-4666-8666-666666666666', hex(32, '2b'), kind, extra)
    } catch (cause) {
      code = String((cause as { code?: unknown }).code)
    }
    expect(code).toBe('23514')
  })

  it('accepts a properly chained rotation', async () => {
    await insertKey('77777777-7777-4777-8777-777777777777', hex(32, '3c'), 'chained', {
      prevKeyId: KEY,
      rotationProof: hex(64, 'ef'),
    })
    const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM agent_keys')
    expect(rows.rows[0]?.n).toBe(2)
  })

  it('refuses a validity window that ends before it starts', async () => {
    let code = 'accepted'
    try {
      await insertKey('88888888-8888-4888-8888-888888888888', hex(32, '4d'), 'initial', {
        validTo: DECIDED_AT - 1,
      })
    } catch (cause) {
      code = String((cause as { code?: unknown }).code)
    }
    expect(code).toBe('23514')
  })

  it('accepts a pending decision that already carries a sent signature', async () => {
    // Проміжний стан publisher'а: транзакцію підписано і збережено її підпис,
    // підтвердження ще немає. Без нього обрив після відправки дав би другий
    // якір на те саме рішення.
    await insertDecision('99999999-9999-4999-8999-99999999900a', { anchorSignature: 'sig' })

    const rows = await db.query<{ status: string }>(`SELECT status FROM decisions WHERE id = $1`, [
      '99999999-9999-4999-8999-99999999900a',
    ])
    expect(rows.rows[0]?.status).toBe('pending')
  })

  it.each([
    ['anchored without a signature', { status: 'anchored' }],
    ['a signature without a slot', { anchorSignature: 'sig', status: 'anchored' }],
    [
      'anchored on a slot but without a signature',
      { status: 'anchored', anchorSlot: 1, anchoredAt: new Date().toISOString() },
    ],
    ['an archive time without a location', { archivedAt: new Date().toISOString() }],
  ])('refuses a decision that is %s', async (_name, extra) => {
    let code = 'accepted'
    try {
      await insertDecision('99999999-9999-4999-8999-999999999999', extra)
    } catch (cause) {
      code = String((cause as { code?: unknown }).code)
    }
    expect(code).toBe('23514')
  })
})

describe('унікальність і зв’язки', () => {
  it('refuses a second agent with the same external id in one project', async () => {
    expect(
      await rejects(
        `INSERT INTO agents (project_id, external_id, name) VALUES ($1, 'a', 'again')`,
        [PROJECT],
      ),
    ).toBe('23505')
  })

  it('refuses the same Ed25519 key under a second row', async () => {
    let code = 'accepted'
    try {
      await insertKey('aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa', hex(32, '1a'), 'initial', {})
    } catch (cause) {
      code = String((cause as { code?: unknown }).code)
    }
    expect(code).toBe('23505')
  })

  it('refuses to drop the key a decision was signed with', async () => {
    // Каскад тут був би тихою втратою перевірності: рішення лишилось би в базі,
    // а сказати, чим його перевіряти, вже не було б чим.
    // `23001` (restrict_violation), а не `23503` (foreign_key_violation): саме
    // цей код і доводить, що звʼязок оголошений `RESTRICT`, а не лишився
    // дефолтним `NO ACTION`, який відклав би перевірку до кінця транзакції.
    expect(await rejects('DELETE FROM agent_keys WHERE id = $1', [KEY])).toBe('23001')
  })

  it('drops the whole project when the project goes', async () => {
    await db.query('DELETE FROM projects WHERE id = $1', [PROJECT])
    const left = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM decisions')
    expect(left.rows[0]?.n).toBe(0)
  })
})

function uppercaseRoot(): [string, unknown[]] {
  return [
    `INSERT INTO decisions (id, project_id, agent_id, agent_key_id, root, signature,
                            decided_at, model_ref, sources, steps, outcome)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'm', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)`,
    [
      'bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      PROJECT,
      AGENT,
      KEY,
      hex(32).toUpperCase(),
      hex(64, 'cd'),
      DECIDED_AT,
    ],
  ]
}
