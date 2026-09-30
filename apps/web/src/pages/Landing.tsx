import { type FormEvent, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { isDecisionId } from '../api'
import { TONE } from '../components/VerificationState'

/**
 * Figures shown on the page, each one measured on the deployed service (T064,
 * T076) and dated. The page may carry no number that was not measured there:
 * a figure without a date and a source reads as a promise.
 */
export const MEASURED = {
  window: '2026-09-28 → 09-29 UTC',
  decisions: '10 000',
  p95Seconds: '6.2',
  lamports: '5 000',
  usd: '$0.0006',
  solPrice: '$119',
} as const

/**
 * What a visitor pastes is either the id or the link someone sent them. Both
 * lead to the same page; anything else is refused before a request is made,
 * because the id format is public and an impossible one is not worth asking.
 */
export function decisionIdFrom(input: string): string | undefined {
  const trimmed = input.trim().toLowerCase()
  if (isDecisionId(trimmed)) return trimmed
  const fromLink = /\/decisions\/([0-9a-f]{32})(?:[/?#]|$)/.exec(trimmed)?.[1]
  return fromLink
}

const STATES = [
  {
    status: 'verified',
    text: 'The record matches its signature, and the root anchored on Solana — read by your own browser — is the same.',
  },
  {
    status: 'pending',
    text: 'The record is sound on its own, but no anchor has been read from the chain yet. Nothing outside AgentTrace vouches for it.',
  },
  {
    status: 'tampered',
    text: 'Something no longer matches. Each mismatch is listed and can be reproduced with the open-source verifier.',
  },
] as const

const AUDIENCES = [
  {
    who: 'If you build agents',
    what: 'A few lines around a decision record its sources, model and steps. The signing key stays on your machine; secrets are left out by an allow-list before anything is sent.',
  },
  {
    who: 'If you audit them',
    what: 'Each record is fixed at the moment of the decision. Changing it later breaks the match with the chain — and that is visible to anyone, not only to us.',
  },
  {
    who: 'If an agent acts for you',
    what: 'A link to a decision is enough to check it yourself, in your browser, without an account and without taking the operator’s word for it.',
  },
] as const

const OpenDecision = () => {
  const navigate = useNavigate()
  const [value, setValue] = useState('')
  const [refused, setRefused] = useState(false)

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const id = decisionIdFrom(value)
    if (id === undefined) {
      setRefused(true)
      return
    }
    navigate(`/decisions/${id}`)
  }

  return (
    <form className="mt-2" onSubmit={submit}>
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="sr-only" htmlFor="decision-id">
          Decision id or link
        </label>
        <input
          aria-describedby={refused ? 'decision-id-error' : undefined}
          aria-invalid={refused}
          className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-1"
          id="decision-id"
          onChange={(event) => {
            setValue(event.target.value)
            setRefused(false)
          }}
          placeholder="32-character id, or the link you were sent"
          spellCheck={false}
          value={value}
        />
        <button className="rounded bg-neutral-900 px-3 py-1 text-white" type="submit">
          Open
        </button>
      </div>
      {refused ? (
        <p className="mt-2 text-red-800" id="decision-id-error">
          That is not a decision id or a decision link.
        </p>
      ) : null}
    </form>
  )
}

export const Landing = ({ hasApi }: { hasApi: boolean }) => (
  <>
    <h1 className="text-lg font-semibold">AgentTrace</h1>
    <p className="mt-2">
      A tamper-evident record of what an AI agent decided and what it relied on — checkable by
      anyone, without trusting the agent’s operator or us.
    </p>
    <p className="mt-2 text-neutral-600">
      The agent signs each decision with its own key. The root of that record is anchored on Solana.
      Whoever holds the link compares the two, in their own browser.
    </p>

    <h2 className="mt-8 font-semibold">Try it</h2>
    <div className="mt-2 rounded border border-neutral-300 p-4">
      <Link className="underline" to="/verify">
        Verify a decision yourself
      </Link>
      <p className="mt-1 text-neutral-600">
        Paste a signed record, or load the bundled example. The check reads the chain from your
        browser and never calls AgentTrace.
      </p>
    </div>
    <div className="mt-2 rounded border border-neutral-300 p-4">
      <p>Open a decision you were sent</p>
      {hasApi ? (
        <OpenDecision />
      ) : (
        <p className="mt-1 text-neutral-600">
          The decision page needs the AgentTrace API, which this build was made without. The check
          above does not depend on it.
        </p>
      )}
    </div>

    <h2 className="mt-8 font-semibold">What a check can say</h2>
    <ul className="mt-2 space-y-2">
      {STATES.map((state) => (
        <li className="flex flex-col gap-1 sm:flex-row sm:gap-3" key={state.status}>
          <span
            className={`w-24 shrink-0 self-start rounded px-2 py-0.5 text-center ${TONE[state.status]}`}
          >
            {state.status}
          </span>
          <span className="text-neutral-700">{state.text}</span>
        </li>
      ))}
    </ul>

    <h2 className="mt-8 font-semibold">Who it is for</h2>
    <dl className="mt-2 space-y-3">
      {AUDIENCES.map((audience) => (
        <div key={audience.who}>
          <dt>{audience.who}</dt>
          <dd className="text-neutral-600">{audience.what}</dd>
        </div>
      ))}
    </dl>

    <h2 className="mt-8 font-semibold">Measured</h2>
    <p className="mt-2 text-neutral-600">
      On the deployed service, over one day at {MEASURED.decisions} decisions a day
      {` (${MEASURED.window}):`}
    </p>
    <ul className="mt-2 list-disc space-y-1 pl-5 text-neutral-700">
      <li>
        95% of decisions were checkable within <strong>{MEASURED.p95Seconds} s</strong> of the agent
        finishing them.
      </li>
      <li>
        Anchoring cost <strong>{MEASURED.lamports} lamports</strong> a decision — about{' '}
        {MEASURED.usd} at SOL {MEASURED.solPrice}.
      </li>
    </ul>

    <div className="mt-8 rounded bg-amber-50 p-4 text-amber-900">
      <p className="font-semibold">A demo on Solana devnet</p>
      <p className="mt-1">
        Devnet is reset from time to time, so no anchor here outlives the demo — treat every link as
        an example, not a lasting proof. Accounts and self-service keys are not available yet. The
        API sleeps when idle; the first request after a pause can take up to a minute.
      </p>
    </div>
  </>
)
