import { type FormEvent, type ReactNode, useState } from 'react'
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
 * SC-002, measured twice on 2026-09-30 by someone who had never seen the SDK,
 * each time on another project's open-source agent template (T062, T077):
 * from `npm install` to a decision the browser showed as verified.
 */
export const INTEGRATION = {
  date: '2026-09-30',
  times: ['59 s', '1 min 14 s'],
  expressions: '5–6',
} as const

/**
 * The "get a key" button is a build switch, not a code change (owner's
 * decision, 2026-10-03). Until the sign-in email can reach any address — the
 * sending domain verified in Resend — a stranger following it would never
 * receive a code, and the page promises nothing that does not work.
 */
export const isSignupOpen = (env: Readonly<Record<string, unknown>>): boolean =>
  env.VITE_SIGNUP_OPEN === 'true'

/** Copied from `packages/sdk/README.md` → "Record a decision"; a test keeps the two equal. */
export const SDK_EXAMPLE = `import { createClient } from '@agenttracewoof/sdk'

const trace = await createClient({
  agent: { externalId: 'my-agent', name: 'My agent' },
  policy: { stepInput: ['query'], stepOutput: ['answer'], outcome: ['action'] },
})

const id = await trace.record({
  model: 'gpt-4o-mini',
  steps: [{ type: 'llm', input: { query: 'Should I rebalance?' }, output: { answer: 'yes' } }],
  outcome: { action: 'rebalance' },
})`

const REPO = 'https://github.com/agenttracewoof/Agent-Trace'

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

const Step = ({ n, title, children }: { n: number; title: string; children: ReactNode }) => (
  <li className="flex gap-3">
    <span className="w-6 shrink-0 text-neutral-500">{n}.</span>
    <div className="min-w-0 flex-1">
      <p className="font-semibold">{title}</p>
      <div className="mt-1 text-neutral-700">{children}</div>
    </div>
  </li>
)

/**
 * The home page for the people who build agents (owner's decision, 2026-10-03):
 * the first screen is the path from an email address to a verified decision
 * (T075). Those who check rather than build come second, with everything that
 * needs no account — the shape T074 gave the page for all three audiences.
 */
export const Landing = ({ hasApi, signupOpen }: { hasApi: boolean; signupOpen: boolean }) => {
  // Sign-in talks to the API; without one the button would lead nowhere.
  const canSignUp = signupOpen && hasApi

  return (
    <>
      <h1 className="text-lg font-semibold">AgentTrace</h1>
      <p className="mt-2">
        Signed, tamper-evident records of what your AI agent decided and what it relied on —
        checkable by anyone, without trusting you or us.
      </p>
      <p className="mt-2 text-neutral-600">
        The agent signs each decision with a key that never leaves its machine. The root of the
        record is anchored on Solana. Whoever holds the link compares the two in their own browser.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        {canSignUp ? (
          <Link className="rounded bg-neutral-900 px-3 py-1 text-white" to="/sign-in">
            Get an ingest key
          </Link>
        ) : (
          <p className="text-neutral-600">
            Self-service keys open once our sign-in email can reach every address.
          </p>
        )}
        <a className="underline" href={`${REPO}/tree/main/packages/sdk#readme`}>
          SDK docs
        </a>
      </div>

      <h2 className="mt-8 font-semibold">Your first verified decision</h2>
      <ol className="mt-3 space-y-4">
        <Step n={1} title="Sign in with your email">
          A six-digit code, no password and no wallet.
        </Step>
        <Step n={2} title="Create a project and copy its ingest key">
          The key is shown once — we keep only its hash. Put it in the agent's environment as{' '}
          <code>AGENTTRACE_INGEST_KEY</code>.
        </Step>
        <Step n={3} title="Record a decision">
          <pre className="mt-1 overflow-x-auto rounded bg-neutral-100 p-3 text-xs">
            npm install @agenttracewoof/sdk
          </pre>
          <pre className="mt-2 overflow-x-auto rounded bg-neutral-100 p-3 text-xs">
            {SDK_EXAMPLE}
          </pre>
          <p className="mt-2">
            <code>record</code> signs the decision and queues it; delivery runs in the background,
            so AgentTrace being slow never slows your agent. It resolves to the decision's id.
          </p>
        </Step>
        <Step n={4} title="Open its link">
          <code className="break-all">
            agenttracewoof.github.io/Agent-Trace/decisions/&lt;id&gt;
          </code>{' '}
          turns <em>verified</em> once the anchor lands — usually within seconds.
        </Step>
      </ol>

      <h2 className="mt-8 font-semibold">Measured</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-neutral-700">
        <li>
          From <code>npm install</code> to a verified decision:{' '}
          <strong>{INTEGRATION.times.join(' and ')}</strong>, by a developer new to the SDK, on two
          open-source agent templates — {INTEGRATION.expressions} expressions of integration (
          {INTEGRATION.date}).
        </li>
        <li>
          At {MEASURED.decisions} decisions a day over one day ({MEASURED.window}), 95% were
          checkable within <strong>{MEASURED.p95Seconds} s</strong> of the agent finishing them.
        </li>
        <li>
          Anchoring cost <strong>{MEASURED.lamports} lamports</strong> a decision — about{' '}
          {MEASURED.usd} at SOL {MEASURED.solPrice}.
        </li>
      </ul>

      <h2 className="mt-8 font-semibold">If you check rather than build</h2>
      <p className="mt-2 text-neutral-600">
        Auditors, and the people an agent acts for, need no account: a link is enough.
      </p>
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

      <div className="mt-8 rounded bg-amber-50 p-4 text-amber-900">
        <p className="font-semibold">A demo on Solana devnet</p>
        <p className="mt-1">
          Devnet is reset from time to time, so no anchor here outlives the demo — treat every link
          as an example, not a lasting proof. A new project records up to 100 decisions a day. The
          API sleeps when idle; the first request after a pause can take up to a minute.
        </p>
      </div>
    </>
  )
}
