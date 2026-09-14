import { type DecisionDraft, decisionDraftSchema, type RedactionPolicy } from '@agenttrace/sdk'

/**
 * Дані демо (T070). Власник уточнив 2026-08-14: рішення в демо **мокові** —
 * справжнього продакшн-агента там немає. Цей генератор і є їх джерелом, і тому
 * він названий інструментом демо, а не частиною продукту: підпис, якір і
 * перевірка навколо нього справжні, а от рішення — ні, і плутати ці дві речі
 * при показі не можна.
 *
 * **Детермінований за seed.** Один і той самий seed дає байт-у-байт ту саму
 * чернетку — інакше сценарій, який упав на тисячному рішенні, неможливо
 * відтворити, і замір, який показав викид, неможливо перевірити вдруге.
 */

/**
 * mulberry32 — тридцять рядків замість залежності, і, головне, **свій**:
 * генератор із бібліотеки міг би змінити послідовність між версіями, і тоді
 * «той самий seed» перестав би означати ті самі дані.
 */
export function randomFrom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const pick = <T>(random: () => number, values: readonly T[]): T =>
  values[Math.floor(random() * values.length)] as T

const between = (random: () => number, low: number, high: number): number =>
  low + Math.floor(random() * (high - low + 1))

const hex = (random: () => number, bytes: number): string =>
  Array.from({ length: bytes }, () =>
    Math.floor(random() * 256)
      .toString(16)
      .padStart(2, '0'),
  ).join('')

/**
 * Форми рішень. Демо, у якому всі рішення однакові, показує, що працює один
 * випадок; ці п'ять покривають те, через що ламаються різні шари: довжину
 * (корінь дерева), розмір (стелі T027), приватність (FR-020) і секрети (FR-006).
 */
export const SHAPES = ['minimal', 'typical', 'wide', 'bulky', 'secretive'] as const
export type Shape = (typeof SHAPES)[number]

/**
 * Тип значення береться з самої чернетки, а не пишеться `unknown`: формат
 * приймає JSON і нічого крім, і генератор, який зібрав би тут щось інше,
 * дізнався б про це від Zod у рантаймі замість типчека.
 */
type Json = DecisionDraft['steps'][number]['input']

export interface DecisionOptions {
  readonly seed: number
  readonly agentPubkey: string
  /** Форма; за замовчуванням обирається з seed, щоб набір був різнорідним. */
  readonly shape?: Shape
  /** Мілісекунди рішення. Дефолт фіксований — «зараз» зламало б детермінізм. */
  readonly decidedAt?: number
  readonly model?: string
}

/** Довільна, але **стала** позначка часу: 2026-08-01T00:00:00Z. */
const DEFAULT_DECIDED_AT = 1_785_542_400_000

const MODELS = ['claude-opus-5', 'claude-sonnet-5', 'gpt-oss-120b'] as const

const VENUES = ['orca', 'raydium', 'meteora', 'lifinity'] as const
const PAIRS = ['SOL/USDC', 'JUP/USDC', 'BONK/SOL', 'JTO/USDC'] as const

/**
 * Секрети складаються з префікса й випадкового хвоста, а не лежать літералами:
 * літеральний високоентропійний рядок у репозиторії — це те, що всі сканери
 * секретів (і наш `pre-commit`) справедливо вважають витоком, навіть коли він
 * фікстура. Форма важлива, вміст — ні.
 */
const SECRET_PREFIXES = ['sk-live-', 'Bearer ', 'xoxb-', 'ghp_'] as const

const secretLike = (random: () => number): string =>
  `${pick(random, SECRET_PREFIXES)}${hex(random, between(random, 12, 20))}`

/** Рядок заданої довжини — щоб «великий» був великим за байтами, а не на вигляд. */
const filler = (random: () => number, size: number): string =>
  hex(random, Math.ceil(size / 2)).slice(0, size)

interface ShapeProfile {
  readonly steps: readonly [number, number]
  readonly fillerBytes: number
  readonly privateEvery: number
  readonly secrets: boolean
}

/**
 * `wide` тримається нижче стелі кроків (256 у T027), `bulky` — нижче стелі тіла
 * (64 КБ): генератор демо не має права робити рішення, яке приймання відхилить,
 * інакше «демо не працює» означало б «дані не ті», а не «продукт зламаний».
 * Перевищення — це окремий, свідомий виклик, а не побічний ефект форми.
 */
const PROFILES: Record<Shape, ShapeProfile> = {
  minimal: { steps: [1, 1], fillerBytes: 0, privateEvery: 0, secrets: false },
  typical: { steps: [3, 6], fillerBytes: 0, privateEvery: 3, secrets: false },
  wide: { steps: [24, 48], fillerBytes: 0, privateEvery: 5, secrets: false },
  bulky: { steps: [4, 8], fillerBytes: 2_048, privateEvery: 4, secrets: false },
  secretive: { steps: [3, 6], fillerBytes: 0, privateEvery: 4, secrets: true },
}

function step(
  random: () => number,
  profile: ShapeProfile,
  index: number,
): DecisionDraft['steps'][number] {
  const isPrivate =
    profile.privateEvery > 0 && index % profile.privateEvery === profile.privateEvery - 1
  const venue = pick(random, VENUES)
  const pair = pick(random, PAIRS)

  const input: Record<string, Json> = {
    url: `https://quotes.example/${venue}/${pair.toLowerCase().replace('/', '-')}`,
    pair,
    venue,
  }
  const output: Record<string, Json> = {
    price: Math.round(random() * 20_000) / 100,
    spread: Math.round(random() * 500) / 100_000,
    stale: random() < 0.1,
  }

  if (profile.secrets) {
    // Секрет кладеться і у вхід, і у вихід, і всередину вкладеного об'єкта:
    // редакція адресує **лист**, тож рівень вкладеності — саме те, на чому
    // політика allow-list ламається, якщо її написали неуважно.
    input.apiKey = secretLike(random)
    input.headers = { authorization: secretLike(random) }
    output.receipt = { token: secretLike(random) }
  }

  if (profile.fillerBytes > 0) {
    input.payload = filler(random, profile.fillerBytes)
    output.payload = filler(random, profile.fillerBytes)
  }

  return {
    type: pick(random, ['source.read', 'model.call', 'tool.call', 'policy.check']),
    private: isPrivate,
    input,
    output,
  }
}

export function generateDecision(options: DecisionOptions): DecisionDraft {
  const random = randomFrom(options.seed)
  const shape = options.shape ?? pick(random, SHAPES)
  const profile = PROFILES[shape]
  const stepCount = between(random, profile.steps[0], profile.steps[1])

  const steps = Array.from({ length: stepCount }, (_, index) => step(random, profile, index))
  const pair = pick(random, PAIRS)

  const draft = {
    agentPubkey: options.agentPubkey,
    // Ідентифікатор теж із seed: рішення, яке неможливо адресувати повторно,
    // неможливо й перевірити повторно.
    decisionId: hex(random, 16),
    model: options.model ?? pick(random, MODELS),
    sources: [`https://quotes.example/${pick(random, VENUES)}`, 'https://risk.example/limits'],
    decidedAt: options.decidedAt ?? DEFAULT_DECIDED_AT + options.seed,
    outcome: {
      action: pick(random, ['swap', 'hold', 'unwind']),
      pair,
      size: Math.round(random() * 5_000) / 100,
      // Причина — те, що дивиться людина на публічній сторінці; порожній
      // outcome зробив би демо технічно повним і при цьому нечитабельним.
      reason: pick(random, [
        'spread above threshold',
        'inventory limit reached',
        'stale quote, staying flat',
        'risk budget available',
      ]),
      ...(profile.secrets ? { audit: { apiKey: secretLike(random) } } : {}),
    },
    steps,
  }

  /**
   * Чернетка перевіряється тією самою схемою, що й на вході SDK. Генератор,
   * який уміє зробити те, що SDK відхилить, витрачав би час сценарію на власні
   * помилки — і виглядало б це як поламаний продукт.
   */
  return decisionDraftSchema.parse(draft)
}

export function generateDecisions(count: number, options: DecisionOptions): DecisionDraft[] {
  // Кожне рішення бере свій seed, тож набір відтворюється як ціле, а окреме
  // рішення з нього — окремо: `generateDecision({ seed: base + i })`.
  return Array.from({ length: count }, (_, index) =>
    generateDecision({ ...options, seed: options.seed + index }),
  )
}

/**
 * Політика демо: **список дозволеного**, як того вимагає `redact`. Поля секретів
 * до нього не входять — і саме тому генератор їх і кладе: сценарій, у якому
 * секретів немає, доводить SC-006 рівно нічим.
 */
export const DEMO_REDACTION_POLICY: RedactionPolicy = {
  stepInput: ['url', 'pair', 'venue', 'payload'],
  stepOutput: ['price', 'spread', 'stale', 'payload'],
  outcome: ['action', 'pair', 'size', 'reason'],
}
