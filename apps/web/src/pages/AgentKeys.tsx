import type { AgentKey } from '@agenttrace/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  agentKeysQueryKey,
  type DashboardApi,
  DashboardError,
  isSignedOut,
  isStaleSignIn,
  projectsQueryKey,
  retryUnreachable,
  sessionQueryKey,
} from '../dashboard'
import { formatDecidedAt } from './Decision'
import { isCodeShaped, normalizeCode } from './SignIn'

/**
 * One agent's keys, and the owner's emergency replacement of a lost one
 * (FR-027, T081) — the screen over `GET …/keys` and `POST …/rotate-admin`.
 *
 * The new key is made where the agent runs, by its SDK, and only its public
 * half is pasted here: a key pair generated in this page would put the agent's
 * identity in a browser tab, within reach of every script and extension on it.
 *
 * The API alone decides whether the sign-in is recent enough. When it is not,
 * the code is asked for on this screen and the same key is sent again, so the
 * owner does not lose what they pasted to a trip through the sign-in page.
 */

const HEX_KEY = /^[0-9a-f]{64}$/

export type CheckedKey = { readonly publicKey: string } | { readonly problem: string }

export function checkPublicKey(input: string): CheckedKey {
  if (/private\s*key/i.test(input)) {
    return {
      problem:
        'That is the whole keystore, and it holds the private key. Paste only the value of publicKey — the private key never leaves the agent’s machine.',
    }
  }
  const value = input
    .trim()
    .replace(/,$/, '')
    .replace(/^["']|["']$/g, '')
    .toLowerCase()
  if (value === '') return { problem: 'Paste the agent’s new public key.' }
  if (!HEX_KEY.test(value)) return { problem: 'A public key is 64 hexadecimal characters.' }
  return { publicKey: value }
}

export function kindLabel(key: AgentKey): string {
  switch (key.rotationKind) {
    case 'initial':
      return 'First key, registered by the agent'
    case 'chained':
      return 'Rotation signed by the previous key'
    case 'administrative':
      return `Emergency replacement confirmed by ${key.confirmedBy ?? 'the owner'} — continuity rests on the owner’s word`
  }
}

/** The first key is valid from zero, which reads better as what it means. */
export function keyWindow(key: AgentKey): string {
  const from = key.validFrom === 0 ? 'from registration' : `from ${formatDecidedAt(key.validFrom)}`
  const to = key.validTo === null ? 'in force' : `until ${formatDecidedAt(key.validTo)}`
  return `${from} · ${to}`
}

const messageOf = (cause: unknown): string =>
  cause instanceof DashboardError ? cause.message : 'Something failed. Try again.'

export function AgentKeys({
  api,
  projectId,
  agentId,
  email,
}: {
  api: DashboardApi
  projectId: string
  agentId: string
  email: string
}) {
  const queryClient = useQueryClient()
  const projects = useQuery({
    queryKey: projectsQueryKey,
    queryFn: () => api.projects(),
    retry: retryUnreachable,
  })
  const project = projects.data?.projects.find((one) => one.id === projectId)
  const history = useQuery({
    queryKey: agentKeysQueryKey(projectId, agentId),
    queryFn: () => api.agentKeys(projectId, agentId),
    enabled: project !== undefined,
    retry: retryUnreachable,
  })

  const ended = [projects.error, history.error].some(isSignedOut)
  useEffect(() => {
    if (ended) void queryClient.invalidateQueries({ queryKey: sessionQueryKey })
  }, [ended, queryClient])

  const failure = projects.error ?? history.error
  if (failure !== null) {
    return history.error instanceof DashboardError && history.error.status === 404 ? (
      <NotFound projectId={projectId} />
    ) : (
      <p className="text-red-800" role="alert">
        {messageOf(failure)}
      </p>
    )
  }
  if (projects.isSuccess && project === undefined) return <NotFound projectId={projectId} />
  if (project === undefined || history.data === undefined) {
    return <p className="text-neutral-600">Loading…</p>
  }

  const { agent, keys, truncated } = history.data

  return (
    <>
      <p className="text-neutral-600">
        <Link className="underline" to="/projects">
          Projects
        </Link>{' '}
        /{' '}
        <Link className="underline break-all" to={`/projects/${projectId}`}>
          {project.name}
        </Link>{' '}
        /
      </p>
      <h1 className="mt-1 text-lg font-semibold break-all">Keys of {agent.name}</h1>
      <p className="mt-1 text-neutral-600 break-all">{agent.externalId}</p>

      {project.role === 'owner' ? (
        <Replacement
          agentId={agentId}
          api={api}
          email={email}
          onReplaced={() =>
            queryClient.invalidateQueries({ queryKey: agentKeysQueryKey(projectId, agentId) })
          }
          projectId={projectId}
        />
      ) : null}

      <h2 className="mt-6 font-semibold">History, newest first</h2>
      <ol className="mt-2 divide-y divide-neutral-200 border-y border-neutral-200">
        {keys.map((key) => (
          <li className="py-3" key={key.publicKey}>
            <p className={key.rotationKind === 'administrative' ? 'text-amber-900' : undefined}>
              {kindLabel(key)}
            </p>
            <code className="mt-1 block break-all">{key.publicKey}</code>
            <p className="mt-1 text-neutral-600">{keyWindow(key)}</p>
          </li>
        ))}
      </ol>
      {truncated ? (
        <p className="mt-2 text-neutral-600">Only the {keys.length} newest keys are shown.</p>
      ) : null}
    </>
  )
}

const NotFound = ({ projectId }: { projectId: string }) => (
  <>
    <h1 className="text-lg font-semibold">Agent not found</h1>
    <p className="mt-2 text-neutral-600">
      It is not an agent of this project, or this account is not one of its members.{' '}
      <Link className="underline" to={`/projects/${projectId}`}>
        Back to the journal
      </Link>
    </p>
  </>
)

type Step = 'closed' | 'key' | 'code'

function Replacement({
  api,
  projectId,
  agentId,
  email,
  onReplaced,
}: {
  api: DashboardApi
  projectId: string
  agentId: string
  email: string
  onReplaced: () => Promise<void>
}) {
  const queryClient = useQueryClient()
  const [step, setStep] = useState<Step>('closed')
  const [input, setInput] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<number | undefined>(undefined)

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  async function replace(publicKey: string) {
    try {
      const { effectiveAt } = await api.replaceAgentKey(projectId, agentId, publicKey)
      setDone(effectiveAt)
      setStep('closed')
      setInput('')
      setCode('')
      await onReplaced()
    } catch (cause) {
      if (!isStaleSignIn(cause)) throw cause
      await api.sendCode(email)
      setCode('')
      setStep('code')
    }
  }

  function submitKey(event: FormEvent) {
    event.preventDefault()
    const checked = checkPublicKey(input)
    if ('problem' in checked) {
      // A pasted keystore must not sit in the field once refused.
      if (/private\s*key/i.test(input)) setInput('')
      return setError(checked.problem)
    }
    void run(() => replace(checked.publicKey))
  }

  function submitCode(event: FormEvent) {
    event.preventDefault()
    const digits = normalizeCode(code)
    const checked = checkPublicKey(input)
    if (!isCodeShaped(digits)) return setError('The code is six digits.')
    if ('problem' in checked) return setStep('key')
    void run(async () => {
      await api.signIn(email, digits)
      await queryClient.invalidateQueries({ queryKey: sessionQueryKey })
      await replace(checked.publicKey)
    })
  }

  if (step === 'closed') {
    return (
      <>
        {done === undefined ? null : (
          <p className="mt-4 rounded bg-neutral-100 p-3" role="status">
            Replaced. The new key is in force from {formatDecidedAt(done)}; restart the agent so it
            registers with it.
          </p>
        )}
        <button
          className="mt-4 text-neutral-600 underline"
          onClick={() => {
            setDone(undefined)
            setStep('key')
          }}
          type="button"
        >
          Lost the agent’s key, or it leaked? Replace it
        </button>
      </>
    )
  }

  return (
    <section
      aria-labelledby="replace-heading"
      className="mt-4 rounded border border-amber-300 bg-amber-50 p-4 text-amber-950"
    >
      <h2 className="font-semibold" id="replace-heading">
        Emergency key replacement
      </h2>
      <p className="mt-1">
        Nothing signed by the old key can vouch for the new one, so the replacement rests on your
        confirmation. Anyone verifying this agent’s later decisions sees that, with today’s date as
        the break. It takes effect now and cannot be undone.
      </p>

      {step === 'key' ? (
        <form className="mt-3" noValidate onSubmit={submitKey}>
          <ol className="list-decimal pl-5">
            <li>
              Stop the agent and move <code>.agenttrace/agent.key</code> out of its state directory.
            </li>
            <li>
              Start it once: the SDK writes a new key there and is refused until you finish here.
            </li>
            <li>
              Paste the <code>publicKey</code> from the new file — never the private key.
            </li>
          </ol>
          <label className="mt-3 block" htmlFor="new-public-key">
            New public key
          </label>
          <input
            aria-describedby={error === undefined ? undefined : 'replace-error'}
            autoComplete="off"
            className="mt-1 w-full rounded border border-neutral-300 bg-white px-2 py-1"
            id="new-public-key"
            onChange={(event) => setInput(event.target.value)}
            spellCheck={false}
            value={input}
          />
          <div className="mt-3 flex gap-4">
            <button
              className="rounded bg-red-800 px-3 py-1 text-white disabled:opacity-50"
              disabled={busy}
              type="submit"
            >
              {busy ? 'Replacing…' : 'Replace key'}
            </button>
            <button
              className="underline"
              onClick={() => {
                setStep('closed')
                setError(undefined)
              }}
              type="button"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <form className="mt-3" noValidate onSubmit={submitCode}>
          <p>
            Confirming needs a sign-in from the last 10 minutes. We sent a code to{' '}
            <span className="font-semibold">{email}</span>; the replacement goes through once it is
            entered.
          </p>
          <label className="mt-3 block" htmlFor="confirm-code">
            Code
          </label>
          <div className="mt-1 flex flex-col gap-2 sm:flex-row">
            <input
              aria-describedby={error === undefined ? undefined : 'replace-error'}
              autoComplete="one-time-code"
              className="w-40 rounded border border-neutral-300 bg-white px-2 py-1 tracking-widest"
              id="confirm-code"
              inputMode="numeric"
              maxLength={12}
              onChange={(event) => setCode(event.target.value)}
              value={code}
            />
            <button
              className="rounded bg-red-800 px-3 py-1 text-white disabled:opacity-50"
              disabled={busy}
              type="submit"
            >
              {busy ? 'Confirming…' : 'Confirm and replace'}
            </button>
          </div>
          <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
            <button
              className="underline disabled:opacity-50"
              disabled={busy}
              onClick={() => void run(() => api.sendCode(email))}
              type="button"
            >
              Send a new code
            </button>
            <button
              className="underline"
              onClick={() => {
                setStep('closed')
                setError(undefined)
              }}
              type="button"
            >
              Cancel
            </button>
          </p>
        </form>
      )}

      {error === undefined ? null : (
        <p className="mt-3 text-red-800" id="replace-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
