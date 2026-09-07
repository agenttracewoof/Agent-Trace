import { join } from 'node:path'
import { type SignedManifest, signManifest } from '@agenttrace/manifest'
import {
  registerAgentRequestSchema,
  registerAgentResponseSchema,
  submitDecisionResponseSchema,
} from '@agenttrace/shared'
import { type DecisionBuffer, type FlushSummary, openDecisionBuffer } from './buffer.js'
import { loadOrCreateAgentKey } from './keystore.js'
import { buildManifest, type DecisionDraft, type RedactionPolicy } from './pipeline.js'
import { type DecisionRecorder, startDecision } from './recorder.js'

const DEFAULT_STATE_DIR = '.agenttrace'

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface ClientOptions {
  readonly endpoint: string
  readonly ingestKey: string
  readonly agent: { readonly externalId: string; readonly name: string }
  readonly policy: RedactionPolicy
  /** Де лежать ключ і черга. За замовчуванням `.agenttrace` поруч із агентом. */
  readonly stateDir?: string
  readonly fetch?: FetchLike
  /**
   * Відправка йде поза шляхом рішення, тож її помилки нікому кинути. Мовчати про
   * них не можна: без цього обірваний зв'язок виглядає як норма.
   */
  readonly onError?: (error: Error) => void
}

export interface AgentTraceClient {
  readonly agentPubkey: string
  startDecision(options: { readonly model: string }): DecisionRecorder
  submit(draft: DecisionDraft): Promise<void>
  flush(): Promise<FlushSummary>
  pending(): Promise<number>
  rejected(): Promise<number>
}

/**
 * Тимчасове чи остаточне. `401` тут тимчасове навмисно: невірний ingest-ключ —
 * це конфігурація, яку виправляють і перезапускають, і відкидати через неї вже
 * підписані рішення означало б втратити їх через друкарську помилку.
 */
function isRetryable(status: number): boolean {
  return status >= 500 || status === 401 || status === 408 || status === 429
}

class RequestFailed extends Error {
  readonly status: number

  constructor(path: string, status: number, body: string) {
    super(`agenttrace: ${path} answered ${status}: ${body.slice(0, 200)}`)
    this.name = 'RequestFailed'
    this.status = status
  }
}

export async function createClient(options: ClientOptions): Promise<AgentTraceClient> {
  const endpoint = options.endpoint.replace(/\/+$/, '')
  const stateDir = options.stateDir ?? DEFAULT_STATE_DIR
  const send = options.fetch ?? ((url, init) => globalThis.fetch(url, init))
  const onError = options.onError ?? (() => {})

  const key = await loadOrCreateAgentKey(join(stateDir, 'agent.key'))
  const buffer = openDecisionBuffer(join(stateDir, 'pending'))
  // Відкинуте кладеться поруч тим самим сховищем: черга звільняється, а рішення
  // лишається на диску. Викинути його було б втратою манифесту, а тримати в
  // черзі — зупинкою всіх наступних за ним.
  const refused: DecisionBuffer = openDecisionBuffer(join(stateDir, 'rejected'))

  let registered: Promise<void> | undefined
  let queue: Promise<FlushSummary> = Promise.resolve({ sent: 0, pending: 0 })

  async function post(path: string, body: unknown): Promise<unknown> {
    const response = await send(`${endpoint}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.ingestKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new RequestFailed(path, response.status, await response.text())
    return response.json()
  }

  async function register(): Promise<void> {
    const body = registerAgentRequestSchema.parse({
      externalId: options.agent.externalId,
      name: options.agent.name,
      publicKey: key.publicKey,
    })
    registerAgentResponseSchema.parse(await post('/v1/agents', body))
  }

  function ensureRegistered(): Promise<void> {
    registered ??= register().catch((cause: unknown) => {
      // Наступний прохід спробує знову: реєстрація ідемпотентна за публічним
      // ключем, тож повтор нічого не псує, а запам'ятана невдача заморозила б
      // відправку до перезапуску агента.
      registered = undefined
      throw cause
    })
    return registered
  }

  async function deliver(envelope: SignedManifest): Promise<void> {
    try {
      submitDecisionResponseSchema.parse(await post('/v1/decisions', envelope))
    } catch (cause) {
      if (cause instanceof RequestFailed && !isRetryable(cause.status)) {
        await refused.append(envelope)
        onError(
          new Error(
            `agenttrace: decision ${envelope.manifest.decisionId} was refused and set aside — ${cause.message}`,
          ),
        )
        return
      }
      throw cause
    }
  }

  async function run(): Promise<FlushSummary> {
    try {
      await ensureRegistered()
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      onError(error)
      return { sent: 0, pending: await buffer.pending(), stoppedBy: error }
    }

    const summary = await buffer.flush(deliver)
    if (summary.stoppedBy !== undefined) onError(summary.stoppedBy)
    return summary
  }

  function flush(): Promise<FlushSummary> {
    // Прохід стає в чергу за попереднім, а не приєднується до нього: рішення,
    // дописане під час проходу, той прохід уже не побачить, і без власного
    // чекало б наступного.
    queue = queue.then(run, run)
    return queue
  }

  return {
    agentPubkey: key.publicKey,

    startDecision: ({ model }) => startDecision({ agentPubkey: key.publicKey, model }),

    async submit(draft) {
      const envelope = await signManifest(await buildManifest(draft, options.policy), key)
      await buffer.append(envelope)
      // Свідомо без await: SC-003 обіцяє, що недоступність AgentTrace не додає
      // до рішення агента жодної затримки. На диску воно вже є.
      void flush().catch((cause: unknown) => {
        onError(cause instanceof Error ? cause : new Error(String(cause)))
      })
    },

    flush,
    pending: () => buffer.pending(),
    rejected: () => refused.pending(),
  }
}
