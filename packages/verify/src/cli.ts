#!/usr/bin/env tsx
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MANIFEST_VERSION } from '@agenttrace/manifest'
import { Connection } from '@solana/web3.js'
import { type ChainSource, collectEvidence, type FetchLike } from './sources.js'
import { type VerificationResult, type VerificationStatus, verifyDecision } from './verify.js'

/**
 * `agenttrace-verify` (FR-013) — увесь інструмент, який потрібен сторонній людині,
 * щоб перевірити рішення без нас. Команда тонка навмисно: докази збирає T031,
 * вердикт рахує `verifyDecision`, а тут лишається розібрати аргументи, надрукувати
 * те, що дозволяє вердикт оскаржити, і вийти з кодом, який щось означає.
 *
 * Другої правди тут немає: CLI не переоцінює й не пом'якшує стан, який повернула
 * перевірка. Інакше `agenttrace-verify` і публічна сторінка казали б різне про те
 * саме рішення, і в людини не було б способу дізнатися, хто з них має рацію.
 */

/**
 * Кожен стан має власний код: скрипт, який жене тисячу рішень, мусить бачити
 * різницю без розбору тексту. `1` навмисно **не** віддано під `tampered` — це
 * код «перевірка не відбулася» (аргументи, RPC), і плутати «я не зміг спитати»
 * з «запис не сходиться» означало б повторити помилку, від якої формат
 * відмовляється всюди: `unavailable` ніколи не є `content-deleted`.
 *
 * Тип, а не вільний об'єкт: щойно verifier заведе новий стан, цей рядок
 * перестане типчекатися, і код виходу не можна буде забути.
 */
export const EXIT_CODE: Record<VerificationStatus, number> = {
  verified: 0,
  tampered: 2,
  pending: 3,
  unavailable: 4,
  'content-deleted': 5,
}

export const EXIT_TOOL_FAILURE = 1

export const USAGE = `agenttrace-verify — check one decision against the chain and its signed envelope
(manifest format v${MANIFEST_VERSION})

usage:
  agenttrace-verify --agent <hex> --decision <hex> --manifest <url|path> [options]

required:
  --agent <64 hex>       agent public key; the chain address its history is read from
  --decision <32 hex>    decision id, as it appears in the manifest and in the anchor
  --manifest <url|path>  where the { manifest, signature } envelope is served:
                         an https:// url, or a path to a local file

options:
  --rpc <url>            solana rpc endpoint (default: $SOLANA_RPC_URL)
  --limit <n>            how many transactions of the agent to walk (default 100)
  --json                 print the whole result as json on stdout
  --help                 print this

exit codes:
  0  verified          the envelope matches, and the chain carries its anchor
  2  tampered          something does not match; every mismatch is printed
  3  pending           the envelope is sound, no anchor found for it yet
  4  unavailable       the envelope was not readable, so nothing is claimed
  5  content-deleted   the owner deleted the content; the anchor still exists
  1  the check did not run: bad arguments, or the rpc endpoint did not answer

the agent key and the decision id are arguments on purpose. taking them from the
document under test would let that document choose which chain address answers
for it — the one thing a verifier must never delegate.`

export interface CliRequest {
  readonly agentPubkey: string
  readonly decisionId: string
  readonly manifestUrl: string
  readonly rpcUrl: string
  readonly json: boolean
  readonly limit?: number | undefined
}

type Parsed =
  | { readonly kind: 'run'; readonly request: CliRequest }
  | { readonly kind: 'help' }
  | { readonly kind: 'usage'; readonly message: string }

export interface CliDeps {
  readonly chain: (rpcUrl: string) => ChainSource
  readonly fetch: FetchLike
  readonly readFile: (path: string) => Promise<string>
  readonly env: Readonly<Record<string, string | undefined>>
}

export interface CliOutcome {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

const VALUE_OPTIONS = new Set(['agent', 'decision', 'manifest', 'rpc', 'limit'])
const HEX = (bytes: number) => new RegExp(`^[0-9a-f]{${bytes * 2}}$`)
const usage = (message: string): Parsed => ({ kind: 'usage', message })

function parseArgs(argv: readonly string[], env: CliDeps['env']): Parsed {
  const values = new Map<string, string>()
  let json = false

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string
    if (token === '--help' || token === '-h') return { kind: 'help' }
    if (token === '--json') {
      json = true
      continue
    }
    if (!token.startsWith('--')) return usage(`unexpected argument ${JSON.stringify(token)}`)

    const equals = token.indexOf('=')
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals)
    if (name === 'json') return usage('--json takes no value')
    if (!VALUE_OPTIONS.has(name)) return usage(`unknown option --${name}`)

    const value = equals === -1 ? argv[index + 1] : token.slice(equals + 1)
    if (value === undefined || value === '') return usage(`--${name} needs a value`)
    if (equals === -1) index += 1
    values.set(name, value)
  }

  const agentPubkey = values.get('agent')
  const decisionId = values.get('decision')
  const manifestUrl = values.get('manifest')

  if (agentPubkey === undefined) return usage('--agent is required')
  if (!HEX(32).test(agentPubkey)) {
    return usage('--agent must be 64 lowercase hex characters (a 32-byte public key)')
  }
  if (decisionId === undefined) return usage('--decision is required')
  if (!HEX(16).test(decisionId)) {
    return usage('--decision must be 32 lowercase hex characters (a 16-byte decision id)')
  }
  /**
   * Дефолту в цього аргументу не буде ніколи (T031): дефолт зробив би одне
   * конкретне сховище джерелом істини за замовчуванням, а вимикати це мусив би
   * той, хто здогадався, що це треба вимикати.
   */
  if (manifestUrl === undefined) return usage('--manifest is required')

  // Дефолтний RPC вибрав би за перевіряльника **кластер** — тобто мовчки
  // перевіряв би не той ланцюг, у якому лежить якір.
  const rpcUrl = values.get('rpc') ?? env.SOLANA_RPC_URL
  if (rpcUrl === undefined || rpcUrl === '') {
    return usage('--rpc is required (or set SOLANA_RPC_URL)')
  }

  const rawLimit = values.get('limit')
  if (rawLimit !== undefined && !/^[1-9][0-9]{0,3}$/.test(rawLimit)) {
    return usage('--limit must be a whole number between 1 and 9999')
  }

  return {
    kind: 'run',
    request: {
      agentPubkey,
      decisionId,
      manifestUrl,
      rpcUrl,
      json,
      ...(rawLimit === undefined ? {} : { limit: Number(rawLimit) }),
    },
  }
}

const isHttpUrl = (value: string) => /^https?:\/\//i.test(value)

/**
 * Локальний файл — не зручність, а сценарій за замовчуванням доти, доки конверт
 * ніхто не кладе у сховище власника (T055): його передає людина, і «перевір цей
 * файл проти ланцюга» має працювати без жодного сервера. Помилка читання не
 * перетворюється на обвинувачення — `manifestFromUrl` бачить її як «немає
 * доказу», тобто `unavailable`.
 */
function documentReader(deps: CliDeps, source: string): FetchLike {
  if (isHttpUrl(source)) return deps.fetch
  const path = source.startsWith('file:') ? fileURLToPath(source) : source
  return async () => new Response(await deps.readFile(path), { status: 200 })
}

/**
 * Ключ у query RPC-ендпоінта — секрет, а вивід команди потрапляє у скріншоти
 * демо, у логи CI і в тікети. Адреса без query лишається достатньою, щоб
 * повторити перевірку на тому ж кластері.
 */
export function redactEndpoint(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.search === '' ? url : `${parsed.origin}${parsed.pathname}?…`
  } catch {
    return url
  }
}

function renderHuman(result: VerificationResult, request: CliRequest): string {
  const lines: string[] = [result.status, '']

  lines.push(`  decision   ${request.decisionId}`)
  lines.push(`  agent      ${request.agentPubkey}`)
  lines.push(`  manifest   ${request.manifestUrl}`)
  lines.push(`  chain      ${redactEndpoint(request.rpcUrl)}`)
  if (result.anchor !== undefined) {
    const decidedAt = new Date(result.anchor.decidedAt).toISOString()
    lines.push(`  anchor     root ${result.anchor.root}, decided ${decidedAt}`)
  }
  if (result.origin !== undefined) lines.push(`  origin     ${result.origin}`)
  if (result.keyContinuity !== 'self') lines.push(`  key chain  ${result.keyContinuity}`)
  if (result.caveats.length > 0) lines.push(`  caveats    ${result.caveats.join(', ')}`)

  /**
   * Усі розбіжності, а не перша: людині, яка вердикт оскаржує, потрібен перелік.
   * Лічильник спереду — щоб обрізаний вивід було видно як обрізаний.
   */
  if (result.discrepancies.length > 0) {
    const width = Math.max(...result.discrepancies.map((one) => one.code.length))
    lines.push('', `${result.discrepancies.length} ${plural(result.discrepancies.length)}`)
    for (const one of result.discrepancies) {
      lines.push(`  ${one.code.padEnd(width)}  ${one.detail}`)
    }
  }

  // Рядок, який робить вердикт перевірюваним: усе вище отримано з двох названих
  // місць, і жодне з них не наше.
  lines.push(
    '',
    'computed from the chain endpoint and the document named above.',
    'no AgentTrace service was asked anything.',
  )

  return `${lines.join('\n')}\n`
}

const plural = (count: number) => (count === 1 ? 'discrepancy' : 'discrepancies')

function renderJson(result: VerificationResult, request: CliRequest): string {
  return `${JSON.stringify(
    {
      status: result.status,
      exitCode: EXIT_CODE[result.status],
      discrepancies: result.discrepancies,
      caveats: result.caveats,
      keyContinuity: result.keyContinuity,
      ...(result.origin === undefined ? {} : { origin: result.origin }),
      ...(result.anchor === undefined ? {} : { anchor: result.anchor }),
      request: {
        agentPubkey: request.agentPubkey,
        decisionId: request.decisionId,
        manifestUrl: request.manifestUrl,
        rpc: redactEndpoint(request.rpcUrl),
      },
    },
    null,
    2,
  )}\n`
}

/**
 * Підказки йдуть у stderr і ніколи не міняють ані стану, ані коду виходу — інакше
 * вони стали б другою правдою. Їхня робота вужча: назвати найчастішу причину,
 * через яку чесне рішення виглядає не так, як людина очікувала.
 */
function hintsFor(result: VerificationResult, request: CliRequest): string {
  const hints: string[] = []

  if (result.discrepancies.some((one) => one.code === 'manifest-malformed')) {
    hints.push(
      `hint: the document at ${request.manifestUrl} did not parse as a { manifest, signature }`,
      '      envelope. a verifier checks the envelope itself, not an api response that',
      '      carries it inside a field.',
    )
  }
  if (result.status === 'unavailable') {
    hints.push(
      `hint: nothing was read from ${request.manifestUrl}. the storage does not say why an`,
      '      object is missing, so this is reported as unavailable and never as deletion.',
    )
  }
  if (result.status === 'pending') {
    hints.push(
      `hint: no anchor for this decision in the last ${request.limit ?? 100} transactions of`,
      '      the agent. a busy agent may need a larger --limit.',
    )
  }

  return hints.length === 0 ? '' : `${hints.join('\n')}\n`
}

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

export async function run(argv: readonly string[], deps: CliDeps): Promise<CliOutcome> {
  const parsed = parseArgs(argv, deps.env)
  if (parsed.kind === 'help') return { code: 0, stdout: `${USAGE}\n`, stderr: '' }
  if (parsed.kind === 'usage') {
    return { code: EXIT_TOOL_FAILURE, stdout: '', stderr: `${parsed.message}\n\n${USAGE}\n` }
  }

  const { request } = parsed
  let result: VerificationResult
  try {
    const evidence = await collectEvidence(
      { chain: deps.chain(request.rpcUrl), fetch: documentReader(deps, request.manifestUrl) },
      {
        agentPubkey: request.agentPubkey,
        decisionId: request.decisionId,
        manifestUrl: request.manifestUrl,
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      },
    )
    result = await verifyDecision(evidence)
  } catch (cause) {
    /**
     * Ланцюг не відповів — це **не** стан рішення. Віддати тут `unavailable`
     * означало б сказати щось про запис, не подивившись на нього; віддати
     * `tampered` — звинуватити його за нашу мережу.
     */
    return {
      code: EXIT_TOOL_FAILURE,
      stdout: '',
      stderr: `the check did not run: ${errorMessage(cause)}\n`,
    }
  }

  return {
    code: EXIT_CODE[result.status],
    stdout: request.json ? renderJson(result, request) : renderHuman(result, request),
    stderr: hintsFor(result, request),
  }
}

/* c8 ignore start — межа з процесом: усе, що вище, перевіряється без нього */
const defaults: CliDeps = {
  chain: (rpcUrl) => new Connection(rpcUrl, 'confirmed'),
  fetch: (url) => fetch(url),
  readFile: (path) => readFile(path, 'utf8'),
  env: process.env,
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const outcome = await run(process.argv.slice(2), defaults)
  if (outcome.stdout !== '') process.stdout.write(outcome.stdout)
  if (outcome.stderr !== '') process.stderr.write(outcome.stderr)
  process.exit(outcome.code)
}
/* c8 ignore stop */
