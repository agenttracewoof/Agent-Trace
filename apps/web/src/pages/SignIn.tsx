import { useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { type DashboardApi, DashboardError, sessionQueryKey } from '../dashboard'

/**
 * Sign-in by email code (FR-018, T079): no password and no wallet. Two steps
 * on one screen — the address, then the six digits — because the code is only
 * good for five minutes and a page change in between is one more thing to lose.
 *
 * Not linked from the home page until the sending domain is verified in Resend
 * (owner's decision, 2026-10-03): before that, only the Resend account owner
 * receives a code, and a link would promise strangers a door that stays shut.
 */

/** The API lowercases too; doing it here keeps the address shown equal to the one used. */
export const normalizeEmail = (value: string): string => value.trim().toLowerCase()

/** Spaces are what a code pasted from an email most often brings along. */
export const normalizeCode = (value: string): string => value.replace(/\s+/g, '')

export const isCodeShaped = (value: string): boolean => /^\d{6}$/.test(value)

const messageOf = (cause: unknown): string =>
  cause instanceof DashboardError ? cause.message : 'Something failed. Try again.'

export function SignIn({ api }: { api: DashboardApi }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [sentTo, setSentTo] = useState<string | undefined>(undefined)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

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

  const sendCode = (address: string) =>
    run(async () => {
      await api.sendCode(address)
      setSentTo(address)
      setCode('')
    })

  function submitEmail(event: FormEvent) {
    event.preventDefault()
    const address = normalizeEmail(email)
    if (address === '') return setError('Enter your email address.')
    void sendCode(address)
  }

  function submitCode(event: FormEvent) {
    event.preventDefault()
    const digits = normalizeCode(code)
    if (sentTo === undefined) return
    if (!isCodeShaped(digits)) return setError('The code is six digits.')
    void run(async () => {
      await api.signIn(sentTo, digits)
      await queryClient.invalidateQueries({ queryKey: sessionQueryKey })
      navigate('/projects')
    })
  }

  return (
    <>
      <h1 className="text-lg font-semibold">Sign in to AgentTrace</h1>

      {sentTo === undefined ? (
        <form className="mt-4" noValidate onSubmit={submitEmail}>
          <label className="block" htmlFor="email">
            Email
          </label>
          <div className="mt-1 flex flex-col gap-2 sm:flex-row">
            <input
              aria-describedby={error === undefined ? undefined : 'sign-in-error'}
              autoComplete="email"
              className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-1"
              id="email"
              inputMode="email"
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              value={email}
            />
            <button
              className="rounded bg-neutral-900 px-3 py-1 text-white disabled:opacity-50"
              disabled={busy}
              type="submit"
            >
              {busy ? 'Sending…' : 'Send code'}
            </button>
          </div>
          <p className="mt-2 text-neutral-600">
            We email you a six-digit code. No password, no wallet.
          </p>
        </form>
      ) : (
        <form className="mt-4" noValidate onSubmit={submitCode}>
          <p>
            We sent a code to <span className="font-semibold">{sentTo}</span>. It works once and
            expires in 5 minutes.
          </p>
          <label className="mt-4 block" htmlFor="code">
            Code
          </label>
          <div className="mt-1 flex flex-col gap-2 sm:flex-row">
            <input
              aria-describedby={error === undefined ? undefined : 'sign-in-error'}
              autoComplete="one-time-code"
              className="w-40 rounded border border-neutral-300 px-2 py-1 tracking-widest"
              id="code"
              inputMode="numeric"
              maxLength={12}
              onChange={(event) => setCode(event.target.value)}
              value={code}
            />
            <button
              className="rounded bg-neutral-900 px-3 py-1 text-white disabled:opacity-50"
              disabled={busy}
              type="submit"
            >
              {busy ? 'Checking…' : 'Sign in'}
            </button>
          </div>
          <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-neutral-600">
            <button
              className="underline disabled:opacity-50"
              disabled={busy}
              onClick={() => void sendCode(sentTo)}
              type="button"
            >
              Send a new code
            </button>
            <button
              className="underline"
              onClick={() => {
                setSentTo(undefined)
                setError(undefined)
              }}
              type="button"
            >
              Use another address
            </button>
          </p>
        </form>
      )}

      {error === undefined ? null : (
        <p className="mt-3 text-red-800" id="sign-in-error" role="alert">
          {error}
        </p>
      )}
    </>
  )
}
