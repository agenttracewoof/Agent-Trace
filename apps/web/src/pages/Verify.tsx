import { type VerificationResult, verifyDecision } from '@agenttrace/verify'
import { useState } from 'react'
import { isAgentPubkey, isDecisionId } from '../api'
import { anchorFromChain, ChainNotConfigured, chainSource, resolveRpcUrl } from '../chain'
import { VerdictCard } from '../components/VerificationState'

/**
 * Самостійна перевірка конверта (T073) — сторінка, якій **наш сервіс не потрібен
 * узагалі**. Відвідувач дає конверт, вона читає якір із публічного вузла Solana
 * і проганяє ту саму `verifyDecision`, що й `agenttrace-verify`.
 *
 * Це і є найсильніша обіцянка продукту в найкоротшій формі: у сторінки рішення
 * конверт приходить від нас, тож скептик має право нам не вірити; тут не
 * доводиться вірити нікому, крім ланцюга й власних очей. Саме тому вона
 * статична й може лежати де завгодно, хоч на GitHub Pages.
 */

/**
 * Ключ агента й `decisionId` беруться **з конверта**, і це нормально рівно доти,
 * доки сторінка їх **показує**: питання, на яке вона відповідає, — «чи цей
 * документ цілісний і чи є під нього якір», а не «чи це рішення агента X».
 * Друге вимагає, щоб читач звірив ключ із тим, який він очікує, — для цього є
 * поле нижче. Без цієї різниці підроблений конверт із власним якорем виглядав
 * би підтвердженим, і формально це навіть було б правдою — просто не про того
 * агента, про якого думає читач.
 */
interface Identity {
  readonly agentPubkey: string
  readonly decisionId: string
}

export function identityOf(envelope: unknown): Identity | undefined {
  if (typeof envelope !== 'object' || envelope === null) return undefined
  const manifest = (envelope as { manifest?: unknown }).manifest
  if (typeof manifest !== 'object' || manifest === null) return undefined

  const { agentPubkey, decisionId } = manifest as Record<string, unknown>
  if (typeof agentPubkey !== 'string' || !isAgentPubkey(agentPubkey)) return undefined
  if (typeof decisionId !== 'string' || !isDecisionId(decisionId)) return undefined

  return { agentPubkey, decisionId }
}

type Outcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'input-error'; readonly message: string }
  | {
      readonly kind: 'done'
      readonly verdict: VerificationResult
      readonly identity: Identity
      readonly rpcUrl: string
      readonly expectedMismatch: boolean
    }

const EXAMPLE_URL = `${import.meta.env.BASE_URL}example-decision.json`

export function VerifyPage() {
  const [text, setText] = useState('')
  const [expected, setExpected] = useState('')
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' })

  async function check(): Promise<void> {
    setOutcome({ kind: 'checking' })

    let rpcUrl: string
    try {
      rpcUrl = resolveRpcUrl(import.meta.env)
    } catch (cause) {
      const message = cause instanceof ChainNotConfigured ? cause.message : String(cause)
      setOutcome({ kind: 'input-error', message })
      return
    }

    let envelope: unknown
    try {
      envelope = JSON.parse(text)
    } catch {
      setOutcome({ kind: 'input-error', message: 'That is not JSON.' })
      return
    }

    const identity = identityOf(envelope)
    if (identity === undefined) {
      setOutcome({
        kind: 'input-error',
        message:
          'This is not a { manifest, signature } envelope with an agent key and a decision id in it.',
      })
      return
    }

    try {
      /**
       * Ланцюг читає цей браузер. Підказки про транзакцію тут немає навмисно:
       * її дає наш API, а ця сторінка з ним не розмовляє — тож пошук іде
       * історією агента, повільніше й ні від кого не залежно.
       */
      const anchor = await anchorFromChain(chainSource(rpcUrl), {
        agentPubkey: identity.agentPubkey,
        decisionId: identity.decisionId,
        manifestUrl: '',
      })
      const verdict = await verifyDecision({
        manifest: envelope,
        ...(anchor === undefined ? {} : { anchor }),
      })

      setOutcome({
        kind: 'done',
        verdict,
        identity,
        rpcUrl,
        expectedMismatch: expected !== '' && expected.trim() !== identity.agentPubkey,
      })
    } catch (cause) {
      // Вузол не відповів — це не стан запису, і називати його станом не можна.
      setOutcome({
        kind: 'input-error',
        message: `The chain endpoint did not answer: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      })
    }
  }

  async function loadExample(): Promise<void> {
    setOutcome({ kind: 'checking' })
    try {
      const response = await fetch(EXAMPLE_URL)
      setText(JSON.stringify(await response.json(), null, 2))
      setOutcome({ kind: 'idle' })
    } catch {
      setOutcome({ kind: 'input-error', message: 'The bundled example could not be loaded.' })
    }
  }

  return (
    <div>
      <h1 className="font-semibold">Verify a decision envelope</h1>
      <p className="mt-2 text-neutral-600">
        Paste a <code>{'{ manifest, signature }'}</code> envelope. This page reads its anchor
        straight from Solana in your browser and checks the two against each other. It does not call
        AgentTrace at any point — the only thing you have to trust is the chain.
      </p>

      <textarea
        className="mt-4 h-56 w-full rounded border border-neutral-300 p-2 text-xs"
        placeholder='{ "manifest": { … }, "signature": "…" }'
        value={text}
        onChange={(event) => setText(event.target.value)}
      />

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="rounded bg-neutral-900 px-3 py-1.5 text-white disabled:opacity-40"
          disabled={text.trim() === '' || outcome.kind === 'checking'}
          onClick={() => void check()}
        >
          {outcome.kind === 'checking' ? 'Checking…' : 'Check against the chain'}
        </button>
        <button
          type="button"
          className="rounded border border-neutral-300 px-3 py-1.5"
          onClick={() => void loadExample()}
        >
          Load the example
        </button>
        <label className="rounded border border-neutral-300 px-3 py-1.5">
          Open a file
          <input
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={async (event) => {
              const file = event.target.files?.[0]
              if (file !== undefined) setText(await file.text())
            }}
          />
        </label>
      </div>

      <label className="mt-4 block">
        <span className="text-neutral-500">
          Agent key you expect (optional) — the envelope names its own, and comparing them is the
          part no page can do for you
        </span>
        <input
          className="mt-1 w-full rounded border border-neutral-300 p-2 text-xs"
          placeholder="64 hex characters"
          value={expected}
          onChange={(event) => setExpected(event.target.value)}
        />
      </label>

      {outcome.kind === 'input-error' ? (
        <p className="mt-4 rounded bg-amber-100 p-3 text-amber-900">{outcome.message}</p>
      ) : null}

      {outcome.kind === 'done' ? (
        <div className="mt-4">
          <VerdictCard
            verdict={outcome.verdict}
            sources={`Anchor read from ${outcome.rpcUrl} by this browser, searched by the agent key the envelope names. No AgentTrace service was contacted.`}
          >
            <dl className="mt-3 text-xs text-neutral-600">
              <div className="flex gap-2">
                <dt className="text-neutral-500">checked against agent</dt>
                <dd className="break-all">{outcome.identity.agentPubkey}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-neutral-500">decision</dt>
                <dd className="break-all">{outcome.identity.decisionId}</dd>
              </div>
            </dl>
            {outcome.expectedMismatch ? (
              <p className="mt-3 rounded bg-red-50 p-2 text-red-900">
                This envelope names a different agent than the one you expected. Whatever the state
                above says, it says it about that other agent.
              </p>
            ) : null}
          </VerdictCard>
        </div>
      ) : null}

      {/*
        Публічній сторінці нема кому сказати це вголос, тож застереження мусить
        стояти на ній самій: демо, у якому джерело даних не назване, читається
        як працююча інтеграція.
      */}
      <p className="mt-8 border-t border-neutral-200 pt-4 text-xs text-neutral-500">
        Demo, v0.1.0. Decisions in the bundled example are generated by a test agent from fixtures —
        the signature, the anchor and this check are real, the trading decision is not. Anchors live
        on Solana <strong>devnet</strong>, which gets reset periodically, so nothing here is meant
        to outlive the demo.
      </p>
    </div>
  )
}
