import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

/**
 * Схема гарячого сховища. **База одноразова**: усе, крім вмісту манифестів
 * усередині гарячого вікна, відновлюється з ланцюга і архіву власника. Тому
 * тут немає жодної колонки, від якої залежала б перевірка рішення — verifier
 * сюди не ходить взагалі (FR-014).
 *
 * Два наскрізні рішення, які пояснюють вибір типів нижче:
 *
 * 1. **Усе двійкове зберігається як hex нижнього регістру**, а не `bytea`.
 *    Формат розмовляє hex'ом (`MANIFEST-FORMAT.md` §1), і рядок `decisions`
 *    уже містить hex усередині `steps` — тримати корінь і підпис у `bytea`
 *    поруч із hex-хешами кроків означало б завести дві правди в одному рядку
 *    і конвертацію на кожній межі. Ціна — ~19 MB на 200 тис. рішень; за неї
 *    купується те, що рядок можна прочитати очима і порівняти з ланцюгом.
 *
 * 2. **Поле, яке входить у підпис, зберігається рівно у тій формі, у якій його
 *    підписали.** Тому `decided_at` і `valid_from` — `bigint` мілісекунд, а не
 *    `timestamptz`: манифест підписує ціле число, і будь-яке перетворення туди-назад
 *    здатне зробити чесне рішення схожим на підроблене. Наші власні позначки часу
 *    (`received_at`, `anchored_at`, `created_at`) у підпис не входять ніколи —
 *    вони `timestamptz`, як і належить.
 */

/**
 * **RLS увімкнено на всіх таблицях, політик немає жодної.** У Postgres це і є
 * deny-all: увімкнений RLS без політики забороняє все всім ролям, які його не
 * обходять. Застосунок ходить service-роллю (`BYPASSRLS`), тож на його роботу
 * це не впливає ніяк — і саме тому це страховка, а не механізм ізоляції.
 * Ізоляцію орендарів робить застосунок за `project_id`, і перевіряє її тест
 * T041; RLS ловить інший сценарій — витік anon-ключа, після якого без нього
 * стало б можливим прочитати чужі рішення прямо з бази.
 */

/** `varchar` фіксованої довжини під hex; довжина в **байтах**, не символах. */
const hex = (name: string, bytes: number) => varchar(name, { length: bytes * 2 })

/**
 * Довжину тримає тип, регістр і алфавіт — ця перевірка. Разом = «це hex».
 *
 * Патерн іде через `sql.raw`, і це не стилістика. Інтерпольований рядок drizzle
 * перетворює на **звʼязаний параметр**, а в DDL параметрів не буває: у міграцію
 * поїхало б літеральне `~ $1`. Перевірка або впала б при накатуванні, або —
 * гірше — створилася б безглуздою. Число підставляє код, не користувач, тож
 * `raw` тут безпечний; загальний запобіжник — тест, який вимагає нуль
 * параметрів у кожному CHECK.
 */
const hexCheck = (name: string, column: AnyPgColumn, bytes: number) =>
  check(name, sql`${column} ~ ${sql.raw(`'^[0-9a-f]{${bytes * 2}}$'`)}`)

export const decisionStatus = pgEnum('decision_status', ['pending', 'anchored', 'failed'])

/**
 * `initial` у ланцюгу не існує: перший ключ агента ніхто не «ротував», тож
 * якоря `kind=1` під ним немає. Два інші значення — рівно ті, що у форматі
 * (`ROTATION_KIND`), і саме вони визначають, наскільки сильною verifier покаже
 * тяглість ідентичності (FR-022 / FR-027).
 */
export const rotationKind = pgEnum('rotation_kind', ['initial', 'chained', 'administrative'])

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 128 }).notNull(),
    /** Сам ingest-ключ не зберігається ніде: показується один раз при створенні. */
    ingestKeyHash: hex('ingest_key_hash', 32).notNull(),
    hotWindowDays: integer('hot_window_days').notNull().default(14),
    dailyQuota: integer('daily_quota').notNull().default(10_000),
    /** Куди вивантажувати перед витісненням (FR-028). Порожньо — витіснення заборонене. */
    archiveBucket: text('archive_bucket'),
    archivePrefix: text('archive_prefix'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('projects_ingest_key_hash_key').on(table.ingestKeyHash),
    hexCheck('projects_ingest_key_hash_hex', table.ingestKeyHash, 32),
  ],
).enableRLS()

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Ідентифікатор агента у системі клієнта — його, не наш. */
    externalId: varchar('external_id', { length: 128 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('agents_project_external_key').on(table.projectId, table.externalId)],
).enableRLS()

/**
 * Історія ключів — впорядкований список, а не поле в `agents`. Інакше рішення,
 * підписані попереднім ключем, після ротації перестали б мати ключ, яким їх
 * перевіряти, і FR-022 («100% попередніх рішень і далі проходять перевірку»)
 * тримався б на нашій акуратності.
 *
 * Ця таблиця — **кеш ланцюга, а не джерело істини**: справжню історію verifier
 * бере через `getSignaturesForAddress` з якорів `kind=1`. Тут вона лежить, щоб
 * дашборд і приймання не ходили в RPC на кожен запит.
 */
export const agentKeys = pgTable(
  'agent_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    publicKey: hex('public_key', 32).notNull(),
    /** `effectiveAt` якоря ротації — мілісекунди, як у підписаних байтах. */
    validFrom: bigint('valid_from', { mode: 'number' }).notNull(),
    validTo: bigint('valid_to', { mode: 'number' }),
    rotationKind: rotationKind('rotation_kind').notNull(),
    prevKeyId: uuid('prev_key_id').references((): AnyPgColumn => agentKeys.id, {
      onDelete: 'restrict',
    }),
    /** Підпис із якоря ротації: попереднім ключем (chained) або платником (administrative). */
    rotationProof: hex('rotation_proof', 64),
    /**
     * Хто підтвердив аварійну заміну у дашборді (FR-027). FK на `users`
     * зʼявиться разом зі схемою auth — це T037, тут поки просто ідентифікатор.
     */
    confirmedBy: uuid('confirmed_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** Один і той самий Ed25519-ключ не може належати двом агентам. */
    uniqueIndex('agent_keys_public_key_key').on(table.publicKey),
    index('agent_keys_agent_valid_from_idx').on(table.agentId, table.validFrom),
    hexCheck('agent_keys_public_key_hex', table.publicKey, 32),
    check(
      'agent_keys_rotation_proof_hex',
      sql`${table.rotationProof} IS NULL OR ${table.rotationProof} ~ '^[0-9a-f]{128}$'`,
    ),
    /**
     * Форма запису мусить відповідати способу заміни, інакше «розрив тяглості
     * приховати неможливо» трималося б на коді, який цей рядок пише. Початковий
     * ключ не має ані попередника, ані доказу; обидва види ротації мають обох;
     * аварійна додатково потребує імені того, хто її підтвердив.
     */
    check(
      'agent_keys_rotation_shape',
      sql`
        (${table.rotationKind} = 'initial'
          AND ${table.prevKeyId} IS NULL
          AND ${table.rotationProof} IS NULL
          AND ${table.confirmedBy} IS NULL)
        OR (${table.rotationKind} = 'chained'
          AND ${table.prevKeyId} IS NOT NULL
          AND ${table.rotationProof} IS NOT NULL)
        OR (${table.rotationKind} = 'administrative'
          AND ${table.prevKeyId} IS NOT NULL
          AND ${table.rotationProof} IS NOT NULL
          AND ${table.confirmedBy} IS NOT NULL)
      `,
    ),
    check(
      'agent_keys_validity_window',
      sql`${table.validTo} IS NULL OR ${table.validTo} > ${table.validFrom}`,
    ),
  ],
).enableRLS()

/**
 * `steps`, `sources` і `outcome` — jsonb, бо кроки завжди читаються разом із
 * рішенням і ніколи не запитуються окремо. Окрема таблиця кроків дала б 1.1 млн
 * рядків на 14-денне вікно замість 140 тис. і подвоїла б складність retention.
 *
 * Колонка називається `outcome`, а не `result` як у прозі `PLAN.md`: так поле
 * зветься у самому форматі, а цей рядок існує рівно для того, щоб зібрати
 * манифест назад. Розбіжність імен між тим, що підписали, і тим, що зберігають,
 * — це майбутній баг у мапері, і коштує він хибним «tampered».
 */
export const decisions = pgTable(
  'decisions',
  {
    /** `decisionId` від SDK, не наш: саме він робить приймання ідемпотентним (FR-007). */
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** Яким саме ключем підписано. `restrict`: втратити це означає втратити перевірність. */
    agentKeyId: uuid('agent_key_id')
      .notNull()
      .references(() => agentKeys.id, { onDelete: 'restrict' }),

    /**
     * Версія формату, під якою рішення **підписали**. Два байти страховки:
     * гаряче вікно — 14 діб, тож у момент переходу на v2 у базі лежатимуть
     * рядки обох версій, і зібрати старий манифест із новою версією у полі
     * означало б зламати його підпис. Дефолт тут не «поточна версія коду»,
     * а конкретна одиниця — саме тому, що код колись стане іншим.
     */
    manifestVersion: smallint('manifest_version').notNull().default(1),
    root: hex('root', 32).notNull(),
    signature: hex('signature', 64).notNull(),
    /** Мілісекунди, як у підписаному манифесті й у якорі. Не `timestamptz`. */
    decidedAt: bigint('decided_at', { mode: 'number' }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),

    modelRef: varchar('model_ref', { length: 128 }).notNull(),
    sources: jsonb('sources').$type<string[]>().notNull(),
    steps: jsonb('steps').notNull(),
    outcome: jsonb('outcome').notNull(),

    status: decisionStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),

    /** Підпис memo-транзакції у base58 — посилання на ланцюг, не Ed25519-підпис рішення. */
    anchorSignature: varchar('anchor_signature', { length: 88 }),
    anchorSlot: bigint('anchor_slot', { mode: 'number' }),
    anchoredAt: timestamp('anchored_at', { withTimezone: true }),

    archivedAt: timestamp('archived_at', { withTimezone: true }),
    archiveUrl: text('archive_url'),
    /** FR-024: вміст пішов, рядок і корінь лишились — доказ існування не видаляється. */
    contentDeletedAt: timestamp('content_deleted_at', { withTimezone: true }),
  },
  (table) => [
    /**
     * Черга publisher'а. Частковий індекс, бо `pending` — це хвилини життя рядка
     * з місяців: повний індекс по `next_attempt_at` платив би пам'яттю за 99%
     * рядків, які вже заякорені.
     */
    index('decisions_pending_idx').on(table.nextAttemptAt).where(sql`${table.status} = 'pending'`),
    /**
     * Keyset-пагінація журналу (SC-007: перша сторінка з фільтром <2 с на 10 тис.).
     * Порядок спадний, бо журнал завжди читається від найновішого; `id` другим
     * ключем, бо `decided_at` не унікальний і без нього сторінка може загубити рядок.
     */
    index('decisions_journal_idx').on(table.projectId, table.decidedAt.desc(), table.id.desc()),
    index('decisions_journal_agent_idx').on(
      table.projectId,
      table.agentId,
      table.decidedAt.desc(),
      table.id.desc(),
    ),
    hexCheck('decisions_root_hex', table.root, 32),
    hexCheck('decisions_signature_hex', table.signature, 64),
    check('decisions_decided_at_range', sql`${table.decidedAt} BETWEEN 0 AND 9007199254740991`),
    /**
     * Заякорене рішення мусить нести всі три сліди ланцюга або жодного:
     * половина заповнених колонок — це стан, у якому неможливо сказати,
     * опублікували ми якір чи ні.
     */
    check(
      'decisions_anchor_shape',
      sql`
        (${table.status} = 'anchored') = (${table.anchorSignature} IS NOT NULL)
        AND (${table.anchorSignature} IS NULL) = (${table.anchorSlot} IS NULL)
        AND (${table.anchorSignature} IS NULL) = (${table.anchoredAt} IS NULL)
      `,
    ),
    /** FR-028: місце звільняється лише після підтвердженого вивантаження. */
    check(
      'decisions_archive_shape',
      sql`(${table.archivedAt} IS NULL) = (${table.archiveUrl} IS NULL)`,
    ),
  ],
).enableRLS()
