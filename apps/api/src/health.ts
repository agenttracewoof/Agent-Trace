import { decisions } from '@agenttrace/db'
import type { PublisherSnapshot } from '@agenttrace/publisher/run'
import { sql } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'

/**
 * `/health` як **готовність**, а не як «процес живий» (T061).
 *
 * Це не покращення логування. Перший деплой на Render поїхав `Live` із зеленим
 * `/health` і неправильним паролем до бази: ендпоінт відповідав лише за себе,
 * драйвер `postgres` зʼєднується ліниво, тож старт проходив успішно й падав
 * перший справжній запит. Сервіс показували б як робочий.
 *
 * Два правила, з яких складене все нижче:
 *
 * 1. **HTTP-статус адресований хостингу, тіло — людині.** 503 для Render
 *    означає «не пускай цей деплой / перезапусти», тож 503 віддається рівно на
 *    недоступній базі — той випадок, що вже стався і перезапуском лікується.
 *    Відставання publisher'а, мовчазний RPC і `failed`-рішення дають 200 із
 *    `status: "degraded"`: рестарт процесу їх не лікує, а рестарт-цикл проти
 *    Supabase — це вже вдруге `ECIRCUITBREAKER`.
 * 2. **Назовні не їде жоден текст помилки.** Ендпоінт публічний і без ключа, а
 *    текст помилки postgres — найкоротший шлях винести рядок підключення разом
 *    із паролем. Причина відмови кодується фіксованим словом (`Reason`).
 */

type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>

/** `unknown` — «не перевіряли», і воно ніколи не погіршує підсумок. */
export type CheckStatus = 'ok' | 'degraded' | 'fail' | 'unknown'

/** Дозволений словник причин. Не повідомлення помилки — саме словник. */
export type Reason = 'timeout' | 'unreachable' | 'not-in-this-process'

export interface DatabaseCheck {
  readonly status: 'ok' | 'fail'
  readonly latencyMs: number
  readonly reason: Reason | null
}

export interface QueueCheck {
  readonly status: CheckStatus
  /** Усе, що чекає якоря, разом із відкладеним на потім. */
  readonly pending: number | null
  /** Із них ті, чий `next_attempt_at` уже минув: саме вони мали б уже їхати. */
  readonly due: number | null
  /** Вік найстаршого з них за годинником **бази**, не процесу. */
  readonly oldestDueSeconds: number | null
  /** Після 10 невдалих спроб рядок стає `failed`, і цикл його більше не бере. */
  readonly failed: number | null
}

export interface PublisherCheck {
  readonly status: CheckStatus
  readonly mode: 'in-process' | 'external'
  readonly passes: number | null
  readonly lastPassAgoSeconds: number | null
  readonly consecutiveFailures: number | null
  readonly sleepSeconds: number | null
  readonly reason: Reason | null
}

export interface ChainCheck {
  readonly status: CheckStatus
  readonly tipSlot: number | null
  readonly lastAnchorSlot: number | null
  /**
   * Відставання **у слотах**, а не в секундах. Перемноження на 0,4 с дало б
   * число, схоже на вимір, яким воно не є: слот тут годинник, а не секундомір.
   * Скільки часу минуло насправді — `lastAnchorAgoSeconds`, і це наша власна
   * позначка `anchored_at`.
   */
  readonly behindSlots: number | null
  readonly lastAnchorAgoSeconds: number | null
  readonly reason: Reason | null
}

export interface HealthReport {
  readonly status: CheckStatus
  /** Скільки секунд звіту. Кеш на 10 с — свідомий, тож вік треба показувати. */
  readonly ageSeconds: number
  readonly checks: {
    readonly database: DatabaseCheck
    readonly queue: QueueCheck
    readonly publisher: PublisherCheck
    readonly chain: ChainCheck
  }
}

export type HealthReporter = () => Promise<HealthReport>

export interface HealthDeps {
  readonly db: AnyPgDatabase
  /** Тіп ланцюга. `null` у двопроцесному запуску: там клієнта RPC у API немає. */
  readonly chainTip: (() => Promise<number>) | null
  /** Знімок циклу публікації, коли він у цьому ж процесі (`RUN_PUBLISHER`). */
  readonly publisher: () => PublisherSnapshot | null
  readonly ttlMs?: number
  readonly now?: () => number
}

/** Черга, яка стоїть довше за це, — вже не «зараз поїде». */
export const QUEUE_DEGRADED_SECONDS = 60

/** Прохід, який не закінчився за цей час, зачепився, а не працює. */
export const PUBLISHER_STALE_SECONDS = 120

/**
 * Ціле опитування має вкластися в таймаут healthcheck'а хостингу. Зависла база
 * без цього тримала б `/health` до власного таймауту Render — тобто мовчання
 * замість відповіді «погано», а це різні речі для того, хто читає статус.
 */
const PROBE_TIMEOUT_MS = 3_000
const CHAIN_TIMEOUT_MS = 2_000

/**
 * Ендпоінт публічний і без ключа, а запит по `decisions` не безкоштовний. Кеш
 * робить темп опитування незалежним від темпу запитів: скільки б їх не було,
 * у базу йде один на 10 секунд.
 */
const DEFAULT_TTL_MS = 10_000

interface QueueFacts {
  readonly pending: number
  readonly due: number
  readonly oldestDueSeconds: number | null
  readonly failed: number
  readonly lastAnchorSlot: number | null
  readonly lastAnchorAgoSeconds: number | null
}

const toNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value)

const seconds = (value: unknown): number | null => {
  const parsed = toNumber(value)
  return parsed === null ? null : Math.round(parsed)
}

/**
 * Таймаут **не скасовує** запит — скасувати його нічим: ані `postgres`, ані
 * `Connection` не беруть сигнал. Він припиняє лише очікування, і саме це тут
 * потрібно: відповісти «не знаю» вчасно краще, ніж відповісти точно й пізно.
 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([
    work,
    new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), ms).unref()
    }),
  ])
}

/**
 * Один запит на всі факти бази. Вік черги рахується годинником **бази**
 * (`now()`), а не процесу: розбіжність годинників між Render і Supabase
 * домальовувала б секунди відставання, яких немає.
 *
 * ⚠️ Це агрегат по всій таблиці, тобто послідовний перегляд: часткового
 * індексу вистачає на `pending`, але `max(anchor_slot)` і лічильник `failed`
 * його не використовують. На теперішніх обсягах це дешевше за окремі запити;
 * коли `decisions` виросте — або індекс, або прибрати `lastAnchorSlot`.
 */
export async function queueFacts(db: AnyPgDatabase): Promise<QueueFacts> {
  const due = sql`${decisions.status} = 'pending' AND ${decisions.nextAttemptAt} <= now()`

  const rows = await db
    .select({
      pending: sql<string>`count(*) FILTER (WHERE ${decisions.status} = 'pending')`,
      due: sql<string>`count(*) FILTER (WHERE ${due})`,
      oldestDueSeconds: sql<
        string | null
      >`extract(epoch FROM now() - min(${decisions.receivedAt}) FILTER (WHERE ${due}))`,
      failed: sql<string>`count(*) FILTER (WHERE ${decisions.status} = 'failed')`,
      lastAnchorSlot: sql<string | null>`max(${decisions.anchorSlot})`,
      lastAnchorAgoSeconds: sql<
        string | null
      >`extract(epoch FROM now() - max(${decisions.anchoredAt}))`,
    })
    .from(decisions)

  const row = rows[0]

  return {
    pending: toNumber(row?.pending) ?? 0,
    due: toNumber(row?.due) ?? 0,
    oldestDueSeconds: seconds(row?.oldestDueSeconds),
    failed: toNumber(row?.failed) ?? 0,
    lastAnchorSlot: toNumber(row?.lastAnchorSlot),
    lastAnchorAgoSeconds: seconds(row?.lastAnchorAgoSeconds),
  }
}

const UNKNOWN_QUEUE: QueueCheck = {
  status: 'unknown',
  pending: null,
  due: null,
  oldestDueSeconds: null,
  failed: null,
}

function queueCheck(facts: QueueFacts): QueueCheck {
  const stale = facts.oldestDueSeconds !== null && facts.oldestDueSeconds > QUEUE_DEGRADED_SECONDS
  return {
    // `failed` у підсумку не випадково: ці рішення не заякорить уже ніхто, і
    // досі вони були видимі лише тому, хто відкриє базу.
    status: stale || facts.failed > 0 ? 'degraded' : 'ok',
    pending: facts.pending,
    due: facts.due,
    oldestDueSeconds: facts.oldestDueSeconds,
    failed: facts.failed,
  }
}

export function publisherCheck(snapshot: PublisherSnapshot | null, now: number): PublisherCheck {
  if (snapshot === null) {
    // Двопроцесний запуск: publisher живий десь інде, і вигадувати про нього
    // «ok» означало б повторити ту саму неправду в новому полі. Його стан у
    // цьому режимі видно через `queue`.
    return {
      status: 'unknown',
      mode: 'external',
      passes: null,
      lastPassAgoSeconds: null,
      consecutiveFailures: null,
      sleepSeconds: null,
      reason: 'not-in-this-process',
    }
  }

  const lastPassAgoSeconds =
    snapshot.lastPassEndedAt === null
      ? null
      : Math.max(0, Math.round((now - snapshot.lastPassEndedAt) / 1000))

  /**
   * Зачеплений прохід шукається окремо від невдалого: невдалий рахується в
   * `consecutiveFailures` і сам себе відсуває відступом, а зачеплений не
   * повертається взагалі — і без цієї гілки виглядав би як тиша.
   */
  const wedged =
    snapshot.consecutiveFailures === 0 &&
    lastPassAgoSeconds !== null &&
    lastPassAgoSeconds > PUBLISHER_STALE_SECONDS

  const failing = snapshot.consecutiveFailures > 0

  return {
    status: !snapshot.running ? 'fail' : failing || wedged ? 'degraded' : 'ok',
    mode: 'in-process',
    passes: snapshot.passes,
    lastPassAgoSeconds,
    consecutiveFailures: snapshot.consecutiveFailures,
    sleepSeconds: Math.round(snapshot.sleepMs / 1000),
    reason: null,
  }
}

function chainCheck(
  facts: QueueFacts | null,
  tip: number | null,
  reason: Reason | null,
): ChainCheck {
  const lastAnchorSlot = facts?.lastAnchorSlot ?? null
  return {
    status: tip === null ? 'unknown' : 'ok',
    tipSlot: tip,
    lastAnchorSlot,
    behindSlots: tip === null || lastAnchorSlot === null ? null : tip - lastAnchorSlot,
    lastAnchorAgoSeconds: facts?.lastAnchorAgoSeconds ?? null,
    reason,
  }
}

const WORST: Record<CheckStatus, number> = { ok: 0, unknown: 0, degraded: 1, fail: 2 }

async function collect(deps: HealthDeps, clock: () => number): Promise<HealthReport> {
  const started = clock()

  const [factsOrTimeout, tipOrTimeout] = await Promise.all([
    withTimeout(
      queueFacts(deps.db).catch(() => 'unreachable' as const),
      PROBE_TIMEOUT_MS,
    ),
    deps.chainTip === null
      ? Promise.resolve('absent' as const)
      : withTimeout(
          deps.chainTip().catch(() => 'unreachable' as const),
          CHAIN_TIMEOUT_MS,
        ),
  ])

  const facts = typeof factsOrTimeout === 'string' ? null : factsOrTimeout
  const database: DatabaseCheck = {
    status: facts === null ? 'fail' : 'ok',
    latencyMs: Math.round(clock() - started),
    reason: typeof factsOrTimeout === 'string' ? factsOrTimeout : null,
  }

  const tip = typeof tipOrTimeout === 'string' ? null : tipOrTimeout
  const chainReason: Reason | null =
    tipOrTimeout === 'absent'
      ? 'not-in-this-process'
      : typeof tipOrTimeout === 'string'
        ? tipOrTimeout
        : null

  const checks = {
    database,
    queue: facts === null ? UNKNOWN_QUEUE : queueCheck(facts),
    publisher: publisherCheck(deps.publisher(), clock()),
    chain: chainCheck(facts, tip, chainReason),
  }

  const status = (Object.values(checks) as { readonly status: CheckStatus }[]).reduce<CheckStatus>(
    (worst, check) => (WORST[check.status] > WORST[worst] ? check.status : worst),
    'ok',
  )

  return { status, ageSeconds: 0, checks }
}

/**
 * Кеш із single-flight: пачка одночасних запитів дає **один** прохід по базі, а
 * не стільки, скільки запитів. Без цього публічний `/health` був би підсилювачем
 * проти пулу з'єднань, у якому на безкоштовному тарифі їх лічені штуки.
 */
export function createHealthReporter(deps: HealthDeps): HealthReporter {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS
  const clock = deps.now ?? (() => Date.now())

  let cached: { readonly at: number; readonly report: HealthReport } | null = null
  let inFlight: Promise<HealthReport> | null = null

  const refresh = async (): Promise<HealthReport> => {
    const report = await collect(deps, clock)
    cached = { at: clock(), report }
    return report
  }

  return async () => {
    const now = clock()
    if (cached !== null && now - cached.at < ttlMs) {
      return { ...cached.report, ageSeconds: Math.round((now - cached.at) / 1000) }
    }

    inFlight ??= refresh().finally(() => {
      inFlight = null
    })

    return await inFlight
  }
}
