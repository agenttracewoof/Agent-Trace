import { createClient } from '@agenttrace/sdk'
import { type ChainSource, collectEvidence, verifyDecision } from '@agenttrace/verify'
import { DEMO_REDACTION_POLICY, generateDecision } from './generator.js'

/**
 * Наскрізний сценарій M1 (T036): рішення агента → приймання → якір у ланцюгу →
 * `verified` у незалежній перевірці, із замірами SC-001, SC-003 і SC-009.
 *
 * Сценарій **нічого не імітує в середині ланцюжка**: підпис справжній, якір
 * лягає у справжній devnet, а вердикт рахує та сама `verifyDecision`, що й
 * `agenttrace-verify`. Мокові тут лише самі рішення (T070) — і це та річ, яку
 * при показі треба називати вголос.
 *
 * ⚠️ **Конверт манифесту приходить з нашого публічного читання**, бо у сховище
 * власника його ще ніхто не кладе (T055, аж у M4). Отже незалежним у цьому
 * сценарії є **ланцюг**, а не джерело конверта. Звіт друкує це рядком, щоб
 * число SC-001 не читалося як доказ більшого, ніж воно є.
 */

/** Пороги зі SPEC. Числа тут, а не в коментарі: інакше звіт нічого не перевіряє. */
export const SC001_MAX_MS = 10_000
export const SC003_MAX_MS = 50

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  // Найближчий ранг: для 10 зразків p95 — це найгірший, і саме так його треба
  // читати. Інтерполяція на такій вибірці малювала б точність, якої немає.
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] as number
}

export type HttpFetch = (url: string, init?: RequestInit) => Promise<Response>

export interface ScenarioDeps {
  /** Адреса приймання і публічного читання — той самий застосунок. */
  readonly endpoint: string
  readonly ingestKey: string
  readonly stateDir: string
  /** Скільки рішень прогнати. p95 на 10 зразках — це найгірший із десяти. */
  readonly count: number
  /** Один прохід публікації; сценарій кличе його, доки черга не спорожніє. */
  readonly publishOnce: () => Promise<number>
  /** Джерело ланцюга для **перевірки** — те саме, що бере CLI. */
  readonly chain: ChainSource
  readonly fetch?: HttpFetch
  readonly log?: (line: string) => void
}

export interface DecisionSample {
  readonly decisionId: string
  /** Скільки SDK віддав рішенню часу — SC-003. */
  readonly sdkMs: number
  /** Від завершення рішення до `verified` у verifier'і — SC-001. */
  readonly verifiableMs: number
  /**
   * Від завершення рішення до моменту, коли якір видно у публічному читанні.
   * Різниця з `verifiableMs` — це вже ціна самої перевірки, і без цього поділу
   * невиконаний SC-001 не каже, що саме прискорювати.
   */
  readonly anchorSeenMs: number
}

export interface ScenarioReport {
  readonly samples: readonly DecisionSample[]
  readonly sdkP95Ms: number
  readonly verifiableP95Ms: number
  readonly sc001: boolean
  readonly sc003: boolean
  /** Публічне посилання читається без авторизації — SC-009. */
  readonly sc009: boolean
  /** Нічого не втрачено, поки приймання лежало — друга половина SC-003. */
  readonly survivesOutage: boolean
  readonly anchored: number
}

/**
 * Кеш HTTP тут збрехав би на нашу користь: публічна відповідь на ще не
 * заякореному рішенні живе 5 с, тобто «pending» міг би показуватися свіжішим,
 * ніж він є, і SC-001 вийшов би меншим за правду. `undici` кешу не має, але
 * покладатися на це — те саме, що не сказати, чим міряли.
 */
const NO_STORE: RequestInit = { cache: 'no-store' }

async function publicRead(
  fetchImpl: HttpFetch,
  endpoint: string,
  decisionId: string,
): Promise<{ readonly status: number; readonly body: unknown; readonly cors: string | null }> {
  // Жодного заголовка авторизації — у цьому й полягає SC-009.
  const response = await fetchImpl(`${endpoint}/v1/public/decisions/${decisionId}`, NO_STORE)
  return {
    status: response.status,
    body: response.ok ? await response.json() : undefined,
    cors: response.headers.get('access-control-allow-origin'),
  }
}

/**
 * Перевірка **тими самими джерелами, що й CLI**: якір із ланцюга, конверт із
 * посилання. Своєї логіки станів тут немає жодного рядка — інакше сценарій
 * доводив би сам себе.
 */
async function verifiedNow(
  deps: ScenarioDeps,
  fetchImpl: HttpFetch,
  decisionId: string,
  agentPubkey: string,
): Promise<boolean> {
  const read = await publicRead(fetchImpl, deps.endpoint, decisionId)
  const envelope = (read.body as { signedManifest?: unknown } | undefined)?.signedManifest
  if (envelope === null || envelope === undefined) return false

  const evidence = await collectEvidence(
    { chain: deps.chain, fetch: async () => new Response(JSON.stringify(envelope)) },
    { agentPubkey, decisionId, manifestUrl: 'inline:envelope-from-public-read' },
  )
  return (await verifyDecision(evidence)).status === 'verified'
}

/**
 * Тік publisher'а — той самий, що в `apps/publisher/src/index.ts`. Число тут не
 * косметичне: SC-001 міряє шлях **робочої системи**, у якій publisher крутиться
 * весь час, а не запускається після того, як агент закінчив працювати.
 */
const PUBLISHER_TICK_MS = 2_000
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

export async function runScenario(deps: ScenarioDeps): Promise<ScenarioReport> {
  const fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init))
  const log = deps.log ?? (() => {})

  const client = await createClient({
    endpoint: deps.endpoint,
    ingestKey: deps.ingestKey,
    agent: { externalId: 'e2e-demo-agent', name: 'Demo agent' },
    policy: DEMO_REDACTION_POLICY,
    stateDir: deps.stateDir,
    fetch: (url, init) => fetchImpl(url, init),
  })

  /**
   * Publisher стартує **до** першого рішення і тікає весь прогін. У попередній
   * редакції сценарію він запускався після всіх відправок — і SC-001 виходив
   * 37 с при бюджеті 10 с. Це був артефакт стенда, а не властивість продукту:
   * у робочій системі жодне рішення не чекає, поки агент закінчить працювати.
   * Урок того ж класу, що з base58 і base64 — стенд міряв себе, а не предмет.
   */
  let anchored = 0
  let ticking = true
  const publisher = (async () => {
    while (ticking) {
      try {
        anchored += await deps.publishOnce()
      } catch (error) {
        log(`publish pass failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      await sleep(PUBLISHER_TICK_MS)
    }
  })()

  /**
   * SC-003, перша половина: скільки часу SDK забирає в самого рішення. Міряється
   * `submit`, який повертається після запису на диск — відправка йде поза цим
   * шляхом навмисно, і саме тому зупинка нашого API нічого не сповільнює.
   */
  const submitted: { decisionId: string; sdkMs: number; at: number }[] = []
  for (let index = 0; index < deps.count; index += 1) {
    const draft = generateDecision({
      seed: index + 1,
      agentPubkey: client.agentPubkey,
      decidedAt: Date.now(),
    })
    const started = performance.now()
    await client.submit(draft)
    submitted.push({
      decisionId: draft.decisionId,
      sdkMs: performance.now() - started,
      at: performance.now(),
    })
  }

  await client.flush()
  log(`submitted ${submitted.length} decisions`)

  /**
   * Кожне рішення міряється **своїм** чекальником, паралельно: послідовний
   * обхід приписав би десятому рішенню очікування дев'яти попередніх.
   * Спершу опитується публічне читання (дешеве, без RPC) — щойно там з'явиться
   * якір, вердикт підтверджується ланцюгом. Так само поводиться й людина:
   * спочатку сторінка, потім перевірка.
   */
  const samples: DecisionSample[] = await Promise.all(
    submitted.map(async (one): Promise<DecisionSample> => {
      let anchorSeenMs = Number.NaN
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const read = await publicRead(fetchImpl, deps.endpoint, one.decisionId)
        const anchor = (read.body as { anchor?: unknown } | undefined)?.anchor
        if (anchor !== null && anchor !== undefined) {
          if (!Number.isFinite(anchorSeenMs)) anchorSeenMs = performance.now() - one.at
          if (await verifiedNow(deps, fetchImpl, one.decisionId, client.agentPubkey)) {
            return {
              decisionId: one.decisionId,
              sdkMs: one.sdkMs,
              anchorSeenMs,
              verifiableMs: performance.now() - one.at,
            }
          }
        }
        await sleep(250)
      }
      return {
        decisionId: one.decisionId,
        sdkMs: one.sdkMs,
        anchorSeenMs,
        verifiableMs: Number.NaN,
      }
    }),
  )
  log(`verified ${samples.filter((one) => Number.isFinite(one.verifiableMs)).length} decisions`)

  /**
   * SC-003, друга половина: приймання лежить, рішення нікуди не діваються.
   * Перевіряється не «клієнт не впав», а те, що після повернення сервісу
   * манифест доїжджає — черга на диску для того й існує.
   */
  const outageDraft = generateDecision({
    seed: 9_000,
    agentPubkey: client.agentPubkey,
    decidedAt: Date.now(),
  })
  const brokenClient = await createClient({
    endpoint: deps.endpoint,
    ingestKey: deps.ingestKey,
    agent: { externalId: 'e2e-demo-agent', name: 'Demo agent' },
    policy: DEMO_REDACTION_POLICY,
    stateDir: deps.stateDir,
    fetch: async () => {
      throw new Error('connect ECONNREFUSED')
    },
    onError: () => {},
  })
  const outageStarted = performance.now()
  await brokenClient.submit(outageDraft)
  const outageMs = performance.now() - outageStarted
  const kept = await brokenClient.pending()
  // Той самий каталог стану, живе приймання: черга розбирається як є.
  const recovered = await client.flush()
  const survivesOutage = kept > 0 && recovered.sent > 0 && outageMs <= SC003_MAX_MS
  log(`outage: kept ${kept} on disk, sent ${recovered.sent} after recovery`)

  ticking = false
  await publisher
  log(`anchored ${anchored} decisions`)

  const first = submitted[0]
  const anonymous =
    first === undefined ? undefined : await publicRead(fetchImpl, deps.endpoint, first.decisionId)
  const sc009 = anonymous?.status === 200 && anonymous.cors === '*'

  const sdkP95Ms = percentile(
    samples.map((one) => one.sdkMs),
    95,
  )
  const verifiableP95Ms = percentile(
    samples.map((one) => one.verifiableMs),
    95,
  )

  return {
    samples,
    sdkP95Ms,
    verifiableP95Ms,
    sc001:
      samples.every((one) => Number.isFinite(one.verifiableMs)) && verifiableP95Ms <= SC001_MAX_MS,
    sc003: sdkP95Ms <= SC003_MAX_MS && survivesOutage,
    sc009,
    survivesOutage,
    anchored,
  }
}

export function formatReport(report: ScenarioReport): string {
  const verdict = (ok: boolean) => (ok ? 'pass' : 'FAIL')
  const ms = (value: number) => `${Math.round(value)} ms`
  const anchorSeen = report.samples.map((one) => one.anchorSeenMs)
  const verifiable = report.samples.map((one) => one.verifiableMs)
  return [
    `decisions            ${report.samples.length} submitted, ${report.anchored} anchored`,
    `SC-001 p95           ${Math.round(report.verifiableP95Ms)} ms of ${SC001_MAX_MS} ms · ${verdict(report.sc001)}`,
    `  anchor visible     best ${ms(percentile(anchorSeen, 1))} · p50 ${ms(percentile(anchorSeen, 50))} · p95 ${ms(percentile(anchorSeen, 95))}`,
    `  then verified      best ${ms(percentile(verifiable, 1) - percentile(anchorSeen, 1))} · p95 ${ms(percentile(verifiable, 95) - percentile(anchorSeen, 95))}`,
    `SC-003 p95 (sdk)     ${report.sdkP95Ms.toFixed(1)} ms of ${SC003_MAX_MS} ms · ${verdict(report.sc003)}`,
    `SC-003 outage        nothing lost while ingest was down · ${verdict(report.survivesOutage)}`,
    `SC-009 public read   no authorization, cors * · ${verdict(report.sc009)}`,
    '',
    'measured with cache: no-store, so a 5 s public cache cannot flatter SC-001.',
    'the anchor half is independent; the envelope came from our own public read,',
    'because nobody writes it to owner storage yet (T055). say that out loud.',
  ].join('\n')
}
