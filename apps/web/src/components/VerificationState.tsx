import type { PublicDecisionResponse } from '@agenttrace/shared'
import { type DecisionEvidence, type VerificationResult, verifyDecision } from '@agenttrace/verify'
import { useQuery } from '@tanstack/react-query'
import { anchorQuery, ChainNotConfigured, resolveRpcUrl } from '../chain'

/**
 * Показ станів (FR-013). Уся вимога зводиться до одного речення — «стан ніколи
 * не показується сильнішим, ніж він є», — і тримається тут **конструкцією**, а
 * не старанністю:
 *
 * `verified` неможливий без байтів якоря, а байти якоря беруться лише з ланцюга,
 * прочитаного цим браузером. Не налаштований RPC, мертвий вузол, порожня історія —
 * усе це дає рівно `pending`, бо `verifyDecision` без якоря сильнішого стану не
 * повертає. Забути перевірку тут неможливо: її нема кому забути.
 */

/** Скільки триматися за прочитане: заякорене рішення незмінне. */
const ANCHORED_STALE_MS = 60_000

export function evidenceOf(
  decision: PublicDecisionResponse,
  anchor: Uint8Array | undefined,
): DecisionEvidence {
  const base = anchor === undefined ? {} : { anchor }

  if (decision.signedManifest !== null) return { ...base, manifest: decision.signedManifest }
  if (decision.contentDeletedAt !== null) return { ...base, absence: 'content-deleted' as const }
  /**
   * Конверта немає, і причини нам не сказали. `unavailable` — єдине, що можна
   * стверджувати з цього місця; вигадати «видалено» означало б показати стан
   * не тим, чим він відомий.
   */
  return { ...base, absence: 'unavailable' as const }
}

/**
 * Наш API бачить те, чого браузер не бачить: рядок у сховищі, який форматом не є.
 * Він віддає такий конверт як `null`, а сам називає це `tampered`. Локальний
 * вердикт у цьому випадку скаже `unavailable` — слабше, ніж відомо, — тож
 * розбіжність показуємо окремим рядком, а не ховаємо і не підміняємо нею вердикт.
 */
export function apiDisagreement(
  decision: PublicDecisionResponse,
  local: VerificationResult,
): string | undefined {
  const theirs = decision.verification.status
  if (theirs === local.status || theirs !== 'tampered') return undefined
  const detail = decision.verification.discrepancies.map((one) => one.code).join(', ')
  return `AgentTrace reports this record as tampered${detail === '' ? '' : ` (${detail})`}.`
}

const TONE: Record<VerificationResult['status'], string> = {
  verified: 'bg-emerald-100 text-emerald-900',
  pending: 'bg-amber-100 text-amber-900',
  tampered: 'bg-red-100 text-red-900',
  unavailable: 'bg-neutral-200 text-neutral-800',
  'content-deleted': 'bg-neutral-200 text-neutral-800',
}

const EXPLANATION: Record<VerificationResult['status'], string> = {
  verified:
    'The envelope matches its own signature, the steps hash to the root, and the anchor read from the chain in this browser carries the same root and signature.',
  pending:
    'The envelope is internally sound, but no anchor for it was read from the chain — so nothing outside AgentTrace confirms it yet.',
  tampered:
    'Something does not match. Every mismatch found is listed below; each one is reproducible with agenttrace-verify.',
  unavailable: 'The envelope could not be read, so nothing is claimed about its integrity.',
  'content-deleted':
    'The owner deleted the content. The anchor still proves a record existed and when.',
}

function useVerification(decision: PublicDecisionResponse) {
  let rpcUrl: string | undefined
  let chainProblem: string | undefined
  try {
    rpcUrl = resolveRpcUrl(import.meta.env)
  } catch (cause) {
    if (!(cause instanceof ChainNotConfigured)) throw cause
    chainProblem = cause.message
  }

  const agentPubkey = decision.signedManifest?.manifest.agentPubkey
  const anchor = useQuery({
    ...anchorQuery(rpcUrl ?? '', {
      agentPubkey: agentPubkey ?? '',
      decisionId: decision.decisionId,
      ...(decision.anchor === null
        ? {}
        : { anchorTransaction: decision.anchor.transactionSignature }),
    }),
    enabled: rpcUrl !== undefined && agentPubkey !== undefined,
    staleTime: ANCHORED_STALE_MS,
    retry: 1,
  })

  const verdict = useQuery({
    queryKey: ['verdict', decision.decisionId, anchor.data === undefined ? 'no-anchor' : 'anchor'],
    queryFn: () => verifyDecision(evidenceOf(decision, anchor.data)),
    // Чекаємо на ланцюг, щоб не показати `pending` за мить до `verified`:
    // блимання слабшим станом читається як відповідь, а не як «ще вантажиться».
    enabled: !anchor.isPending || !anchor.isFetching,
  })

  return {
    verdict: verdict.data,
    chainProblem:
      chainProblem ??
      (anchor.isError
        ? `the chain endpoint did not answer: ${(anchor.error as Error).message}`
        : agentPubkey === undefined
          ? 'no envelope, so there is no agent address to read the chain by'
          : undefined),
    rpcUrl,
    reading: anchor.isPending || verdict.isPending,
  }
}

/**
 * Показ самого вердикту, спільний для сторінки рішення і для сторінки
 * самостійної перевірки (T073). Спільний навмисно: дві копії цього екрана
 * колись розійшлися б у словах про той самий стан, і читач не мав би способу
 * дізнатися, яка з них каже правду.
 *
 * `sources` — не примітка, а частина вердикту: рядок каже, звідки взято кожну
 * половину доказів.
 */
export function VerdictCard({
  verdict,
  sources,
  children,
}: {
  verdict: VerificationResult
  sources: string
  children?: React.ReactNode
}) {
  return (
    <div className="rounded border border-neutral-200">
      <div className={`flex items-baseline gap-3 rounded-t p-4 ${TONE[verdict.status]}`}>
        <span className="text-lg font-semibold">{verdict.status}</span>
        {verdict.caveats.length > 0 ? (
          <span className="text-xs">{verdict.caveats.join(' · ')}</span>
        ) : null}
      </div>

      <div className="p-4">
        <p>{EXPLANATION[verdict.status]}</p>

        {verdict.keyContinuity !== 'self' ? (
          <p className="mt-2">Key continuity: {verdict.keyContinuity}.</p>
        ) : null}

        {verdict.discrepancies.length > 0 ? (
          <ul className="mt-3">
            {verdict.discrepancies.map((one) => (
              <li key={`${one.code}-${one.detail}`} className="border-t border-neutral-200 py-2">
                <div className="font-semibold">{one.code}</div>
                <div className="text-neutral-600">{one.detail}</div>
              </li>
            ))}
          </ul>
        ) : null}

        {children}

        <p className="mt-3 text-xs text-neutral-500">{sources}</p>
      </div>
    </div>
  )
}

export function VerificationState({ decision }: { decision: PublicDecisionResponse }) {
  const { verdict, chainProblem, rpcUrl, reading } = useVerification(decision)

  if (verdict === undefined) {
    return <div className="rounded bg-neutral-100 p-4">{reading ? 'Checking…' : 'Not checked'}</div>
  }

  const disagreement = apiDisagreement(decision, verdict)

  return (
    <VerdictCard
      verdict={verdict}
      sources={
        chainProblem === undefined
          ? `Anchor read from ${rpcUrl} by this browser. Envelope served by AgentTrace and checked here against its own signature.`
          : `The chain was not read from this browser — ${chainProblem}. Without it no state stronger than "pending" is possible here; agenttrace-verify checks the chain from your own machine.`
      }
    >
      {disagreement === undefined ? null : (
        <p className="mt-3 rounded bg-red-50 p-2 text-red-900">{disagreement}</p>
      )}
    </VerdictCard>
  )
}
