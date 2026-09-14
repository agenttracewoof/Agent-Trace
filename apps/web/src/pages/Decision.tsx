import type { PublicDecisionResponse } from '@agenttrace/shared'
import { useQuery } from '@tanstack/react-query'
import { decisionQuery, type PublicApi } from '../api'
import { VerificationState } from '../components/VerificationState'

/**
 * Типи виводяться з контракту, а не імпортуються з `@agenttrace/manifest`:
 * сторінка бачить рівно те, що пройшло межу публічного читання, і залежності
 * на формат для цього не потрібно. За побудовою це ті самі типи — схема
 * конверта у `shared` і є схемою формату.
 */
type Manifest = NonNullable<PublicDecisionResponse['signedManifest']>['manifest']
type ManifestStep = Manifest['steps'][number]

/**
 * Сторінка рішення (FR-012): що саме агент вирішив, на чому і коли. Стан
 * перевірки тут не показується жодного разу — це T035, і причина не в порядку
 * задач: наш API ланцюг не читає, тож єдиний чесний спосіб показати «підтверджено»
 * — прочитати ланцюг у цьому ж браузері. До того моменту сторінка показує
 * **запис**, а не вердикт про нього.
 *
 * Приватні кроки (FR-020) не «ховаються» тут: у конверті, який віддає API, у них
 * немає полів вмісту взагалі. Сторінці лишається назвати це вголос, щоб порожній
 * крок не читався як крок без вмісту.
 */

export const formatDecidedAt = (decidedAt: number): string =>
  new Date(decidedAt).toISOString().replace('T', ' ').replace('.000Z', 'Z')

export const isPrivate = (step: ManifestStep): boolean => step.private

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="grid grid-cols-[8rem_1fr] gap-4 border-t border-neutral-200 py-2">
    <div className="text-neutral-500">{label}</div>
    <div className="break-all">{children}</div>
  </div>
)

const Json = ({ value }: { value: unknown }) => (
  <pre className="overflow-x-auto rounded bg-neutral-50 p-2 text-xs">
    {JSON.stringify(value, null, 2)}
  </pre>
)

function Step({ step, index }: { step: ManifestStep; index: number }) {
  return (
    <li className="border-t border-neutral-200 py-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-neutral-500">#{index}</span>
        <span className="font-semibold">{step.type}</span>
        {isPrivate(step) ? (
          <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-xs">private</span>
        ) : null}
      </div>

      {step.private ? (
        <p className="mt-2 text-neutral-600">
          Marked private by its owner, so only the hashes below are public. They are what the root —
          and the anchor over it — are computed from.
        </p>
      ) : (
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          <div>
            <div className="text-neutral-500">input</div>
            <Json value={step.input} />
          </div>
          <div>
            <div className="text-neutral-500">output</div>
            <Json value={step.output} />
          </div>
        </div>
      )}

      <div className="mt-2 grid gap-1 text-xs text-neutral-500">
        <div>input hash · {step.inputHash}</div>
        <div>output hash · {step.outputHash}</div>
      </div>
    </li>
  )
}

function Record({ manifest }: { manifest: Manifest }) {
  return (
    <>
      <section className="mt-6">
        <Row label="agent">{manifest.agentPubkey}</Row>
        <Row label="model">{manifest.model}</Row>
        <Row label="decided">
          {formatDecidedAt(manifest.decidedAt)}
          {/* Мілісекунди показані сирими: підписали саме це число, і саме воно
              лежить у якорі. Форматована дата — зручність, не доказ. */}
          <span className="ml-2 text-neutral-500">({manifest.decidedAt})</span>
        </Row>
        <Row label="sources">
          {manifest.sources.length === 0 ? (
            <span className="text-neutral-500">none declared</span>
          ) : (
            <ul>
              {manifest.sources.map((source) => (
                <li key={source}>{source}</li>
              ))}
            </ul>
          )}
        </Row>
        <Row label="steps root">{manifest.root}</Row>
      </section>

      <section className="mt-6">
        <h2 className="font-semibold">Outcome</h2>
        <div className="mt-2">
          <Json value={manifest.outcome} />
        </div>
      </section>

      <section className="mt-6">
        <h2 className="font-semibold">Steps ({manifest.steps.length})</h2>
        <ol className="mt-2">
          {manifest.steps.map((step, index) => (
            <Step key={`${step.type}-${step.inputHash}`} step={step} index={index} />
          ))}
        </ol>
      </section>
    </>
  )
}

/**
 * Посилання на якір — не доказ, а вказівка, де доказ лежить. Тому підпис
 * транзакції показується як є: його копіюють у оглядач ланцюга або в
 * `agenttrace-verify`, і обидва підтвердять або спростують це без нас.
 */
function AnchorReference({ anchor }: { anchor: PublicDecisionResponse['anchor'] }) {
  if (anchor === null) {
    return (
      <p className="mt-2 text-neutral-600">
        No anchor recorded yet. Until one is published, nothing about this record has been committed
        anywhere outside AgentTrace.
      </p>
    )
  }
  return (
    <section className="mt-2">
      <Row label="transaction">{anchor.transactionSignature}</Row>
      <Row label="slot">{anchor.slot}</Row>
      <Row label="anchored">{anchor.anchoredAt}</Row>
    </section>
  )
}

const Notice = ({ title, children }: { title: string; children?: React.ReactNode }) => (
  <div className="mt-6">
    <h1 className="font-semibold">{title}</h1>
    {children === undefined ? null : <p className="mt-2 text-neutral-600">{children}</p>}
  </div>
)

export function DecisionPage({ api, decisionId }: { api: PublicApi; decisionId: string }) {
  const query = useQuery(decisionQuery(api, decisionId))

  if (query.isPending) return <Notice title="Reading…" />
  /**
   * Сюди приходить лише те, що кинуло `ApiUnreachable`, — тимчасова
   * недоступність після повторів. Це стан **нашого сервісу**, і сказати це треба
   * прямо: «сервіс не відповів» не є твердженням про рішення.
   */
  if (query.isError) {
    return (
      <Notice title="AgentTrace did not answer">
        This says nothing about the decision itself. The record is verifiable without this page: the
        anchor lives on chain, and agenttrace-verify reads it directly.
      </Notice>
    )
  }

  const outcome = query.data
  if (outcome.kind === 'not-found') {
    return <Notice title="No decision under this address">Check the link.</Notice>
  }
  if (outcome.kind === 'malformed') {
    return (
      <Notice title="AgentTrace answered off-contract">
        The response did not match the published format, so nothing from it is shown:{' '}
        {outcome.detail}
      </Notice>
    )
  }

  const decision = outcome.value

  return (
    <div>
      <h1 className="font-semibold">Decision {decision.decisionId}</h1>

      <section className="mt-4">
        <VerificationState decision={decision} />
      </section>

      {decision.signedManifest === null ? (
        <Notice
          title={
            decision.contentDeletedAt === null
              ? 'The stored record is not readable'
              : 'The content was deleted by its owner'
          }
        >
          {decision.contentDeletedAt === null
            ? 'What is stored under this address does not parse as a signed manifest.'
            : `Deleted ${decision.contentDeletedAt}. The anchor below still proves the record existed.`}
        </Notice>
      ) : (
        <Record manifest={decision.signedManifest.manifest} />
      )}

      <section className="mt-6">
        <h2 className="font-semibold">Anchor</h2>
        <AnchorReference anchor={decision.anchor} />
      </section>
    </div>
  )
}
