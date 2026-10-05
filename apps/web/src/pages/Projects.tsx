import type { ProjectSummary } from '@agenttrace/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  type DashboardApi,
  DashboardError,
  envLine,
  isSignedOut,
  projectsQueryKey,
  retryUnreachable,
  sessionQueryKey,
} from '../dashboard'

/**
 * "My projects → create → the key, shown once" (FR-015, T079).
 *
 * The key lives in this component's state and nowhere else: not in the query
 * cache, not in storage, not in the URL. Leaving the panel drops it, and the
 * page has no way to bring it back — the API keeps only its hash. That is the
 * point; the screen says so before the operator needs to know it.
 */

export const ownedCount = (projects: readonly ProjectSummary[]): number =>
  projects.filter((project) => project.role === 'owner').length

/**
 * Counts every owned project, while the API counts only self-served ones: an
 * owner of a project we seeded may be told "at the limit" one project early,
 * never promised a slot the API then refuses.
 */
export const canCreate = (projects: readonly ProjectSummary[], maxOwned: number): boolean =>
  ownedCount(projects) < maxOwned

/**
 * Day and month, the year only when it is not this one. In English like the
 * rest of the page: the reader's locale put "3 жовт." between English words.
 */
export function createdOn(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  return date.toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  })
}

const messageOf = (cause: unknown): string =>
  cause instanceof DashboardError ? cause.message : 'Something failed. Try again.'

interface Revealed {
  readonly projectName: string
  readonly ingestKey: string
  readonly replaced: boolean
}

export function Projects({ api, email }: { api: DashboardApi; email: string }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const projects = useQuery({
    queryKey: projectsQueryKey,
    queryFn: () => api.projects(),
    retry: retryUnreachable,
  })
  const [revealed, setRevealed] = useState<Revealed | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  async function signOut() {
    try {
      await api.signOut()
    } finally {
      queryClient.removeQueries({ queryKey: projectsQueryKey })
      await queryClient.invalidateQueries({ queryKey: sessionQueryKey })
      navigate('/sign-in')
    }
  }

  // A session that ended while the page was open (signed out in another tab,
  // expired): asking again for the session sends the route to the sign-in.
  const ended = projects.isError && isSignedOut(projects.error)
  useEffect(() => {
    if (ended) void queryClient.invalidateQueries({ queryKey: sessionQueryKey })
  }, [ended, queryClient])

  const shown = (next: Revealed) => {
    setError(undefined)
    setRevealed(next)
    void queryClient.invalidateQueries({ queryKey: projectsQueryKey })
  }

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold">Projects</h1>
        <p className="text-neutral-600">
          {email} ·{' '}
          <button className="underline" onClick={() => void signOut()} type="button">
            Sign out
          </button>
        </p>
      </div>

      {revealed === undefined ? null : (
        <KeyPanel onDone={() => setRevealed(undefined)} revealed={revealed} />
      )}

      {error === undefined ? null : (
        <p className="mt-4 text-red-800" role="alert">
          {error}
        </p>
      )}

      {projects.isPending ? (
        <p className="mt-6 text-neutral-600">Loading…</p>
      ) : projects.isError ? (
        <p className="mt-6 text-red-800" role="alert">
          {messageOf(projects.error)}
        </p>
      ) : (
        <>
          <ProjectList
            api={api}
            onError={setError}
            onReplaced={(project, ingestKey) =>
              shown({ projectName: project.name, ingestKey, replaced: true })
            }
            projects={projects.data.projects}
          />
          <CreateProject
            allowed={canCreate(projects.data.projects, projects.data.maxOwnedProjects)}
            api={api}
            maxOwned={projects.data.maxOwnedProjects}
            onCreated={(name, ingestKey) =>
              shown({ projectName: name, ingestKey, replaced: false })
            }
          />
        </>
      )}
    </>
  )
}

function KeyPanel({ revealed, onDone }: { revealed: Revealed; onDone: () => void }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(revealed.ingestKey)
      setCopied(true)
    } catch {
      // Clipboard refused (permissions, insecure context): the key stays on
      // screen and selectable, which is all copying is for.
      setCopied(false)
    }
  }

  return (
    <section
      aria-labelledby="key-heading"
      className="mt-6 rounded border border-amber-300 bg-amber-50 p-4 text-amber-950"
    >
      <h2 className="font-semibold" id="key-heading">
        {revealed.replaced ? 'New ingest key' : 'Ingest key'} for {revealed.projectName}
      </h2>
      <p className="mt-1">
        Shown this once. We keep only its hash, so it cannot be shown again — only replaced.
        {revealed.replaced ? ' The previous key has stopped working.' : ''}
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start">
        <code className="min-w-0 flex-1 break-all rounded bg-white px-2 py-1 select-all">
          {revealed.ingestKey}
        </code>
        <button
          className="rounded bg-neutral-900 px-3 py-1 text-white"
          onClick={() => void copy()}
          type="button"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="mt-3">In the agent's environment:</p>
      <pre className="mt-1 rounded bg-white px-2 py-1 break-all whitespace-pre-wrap">
        {envLine(revealed.ingestKey)}
      </pre>
      <button className="mt-3 underline" onClick={onDone} type="button">
        I have stored it
      </button>
    </section>
  )
}

function ProjectList({
  api,
  projects,
  onReplaced,
  onError,
}: {
  api: DashboardApi
  projects: readonly ProjectSummary[]
  onReplaced: (project: ProjectSummary, ingestKey: string) => void
  onError: (message: string) => void
}) {
  const [confirming, setConfirming] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  if (projects.length === 0) {
    return <p className="mt-6 text-neutral-600">No projects yet. Create the first one below.</p>
  }

  async function replace(project: ProjectSummary) {
    setBusy(true)
    try {
      const { ingestKey } = await api.reissueKey(project.id)
      setConfirming(undefined)
      onReplaced(project, ingestKey)
    } catch (cause) {
      onError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ul className="mt-6 divide-y divide-neutral-200 border-y border-neutral-200">
      {projects.map((project) => (
        <li className="py-3" key={project.id}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <Link className="font-semibold break-all underline" to={`/projects/${project.id}`}>
              {project.name}
            </Link>
            <span className="text-neutral-600">
              {project.role} · {project.dailyQuota.toLocaleString('en-US')} decisions/day · since{' '}
              {createdOn(project.createdAt)}
            </span>
          </div>
          {project.role !== 'owner' ? null : confirming === project.id ? (
            <div className="mt-2 rounded bg-neutral-100 p-3">
              <p>
                The current key stops working at once. Agents that use it are refused until they get
                the new one; decisions already recorded stay as they are.
              </p>
              <div className="mt-2 flex gap-4">
                <button
                  className="rounded bg-red-800 px-3 py-1 text-white disabled:opacity-50"
                  disabled={busy}
                  onClick={() => void replace(project)}
                  type="button"
                >
                  {busy ? 'Replacing…' : 'Replace key'}
                </button>
                <button
                  className="underline"
                  onClick={() => setConfirming(undefined)}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              className="mt-1 text-neutral-600 underline"
              onClick={() => setConfirming(project.id)}
              type="button"
            >
              Lost the key? Replace it
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

function CreateProject({
  api,
  allowed,
  maxOwned,
  onCreated,
}: {
  api: DashboardApi
  allowed: boolean
  maxOwned: number
  onCreated: (name: string, ingestKey: string) => void
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  if (!allowed) {
    return (
      <p className="mt-6 text-neutral-600">
        An account owns up to {maxOwned} projects, and this one has reached it.
      </p>
    )
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const trimmed = name.trim()
    if (trimmed === '') return setError('Give the project a name.')
    setBusy(true)
    setError(undefined)
    try {
      const created = await api.createProject(trimmed)
      setName('')
      onCreated(created.project.name, created.ingestKey)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="mt-6" noValidate onSubmit={submit}>
      <h2 className="font-semibold">New project</h2>
      <label className="mt-2 block" htmlFor="project-name">
        Name
      </label>
      <div className="mt-1 flex flex-col gap-2 sm:flex-row">
        <input
          aria-describedby={error === undefined ? undefined : 'create-error'}
          className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-1"
          id="project-name"
          maxLength={128}
          onChange={(event) => setName(event.target.value)}
          value={name}
        />
        <button
          className="rounded bg-neutral-900 px-3 py-1 text-white disabled:opacity-50"
          disabled={busy}
          type="submit"
        >
          {busy ? 'Creating…' : 'Create'}
        </button>
      </div>
      <p className="mt-2 text-neutral-600">
        Each project gets its own ingest key and a daily quota of decisions, anchored on Solana
        devnet.
      </p>
      {error === undefined ? null : (
        <p className="mt-2 text-red-800" id="create-error" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}
