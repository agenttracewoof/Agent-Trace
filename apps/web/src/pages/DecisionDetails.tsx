import type { DecisionDetailsResponse } from '@agenttrace/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  type DashboardApi,
  DashboardError,
  decisionDetailsQueryKey,
  isSignedOut,
  projectsQueryKey,
  retryUnreachable,
  sessionQueryKey,
} from '../dashboard'
import { DecisionBody } from './Decision'
import { type FromJournal, isClockAhead, STATUS_LABEL, STATUS_STYLE } from './Journal'

/**
 * One decision as its operator sees it (FR-017, T043). The body is the public
 * page's own (`DecisionBody`): the verdict is worked out in this browser from
 * the chain, exactly as for a stranger with the link, so the operator is never
 * shown a stronger — or a different — state than anyone else would be.
 *
 * What only a member may know sits above it: which of the project's agents
 * decided, where anchoring stands in our pipeline, when the decision reached
 * us. And the public link, because handing that to a third party is what this
 * page is for.
 */

/** The public page of a decision, on this same deployment of the web app. */
export function publicDecisionUrl(origin: string, base: string, decisionId: string): string {
  return `${origin}${base.endsWith('/') ? base : `${base}/`}decisions/${decisionId}`
}

/**
 * Back to the journal as the operator left it: the filters came along in the
 * link's state. Opened any other way — a pasted address, a new tab — there is
 * nothing to restore, and the journal opens unfiltered.
 */
export function journalPath(projectId: string, state: unknown): string {
  const search =
    typeof state === 'object' && state !== null && 'journalSearch' in state
      ? (state as FromJournal).journalSearch
      : ''
  return `/projects/${projectId}${typeof search === 'string' && search.startsWith('?') ? search : ''}`
}

const ANCHORING_NOTE: Readonly<Record<DecisionDetailsResponse['status'], string>> = {
  pending: 'Accepted and queued; the publisher has not put its root on chain yet.',
  anchored: 'Its root is on chain. The verdict below checks that from the chain itself.',
  failed:
    'The publisher gave up after repeated attempts. The signed record is stored, but nothing outside AgentTrace confirms it.',
}

const messageOf = (cause: unknown): string =>
  cause instanceof DashboardError ? cause.message : 'Something failed. Try again.'

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="grid grid-cols-[8rem_1fr] gap-4 border-t border-neutral-200 py-2">
    <div className="text-neutral-500">{label}</div>
    <div className="min-w-0 wrap-anywhere">{children}</div>
  </div>
)

export function DecisionDetails({
  api,
  projectId,
  decisionId,
}: {
  api: DashboardApi
  projectId: string
  decisionId: string
}) {
  const queryClient = useQueryClient()
  const location = useLocation()
  const back = journalPath(projectId, location.state)

  const projects = useQuery({
    queryKey: projectsQueryKey,
    queryFn: () => api.projects(),
    retry: retryUnreachable,
  })
  const project = projects.data?.projects.find((one) => one.id === projectId)
  const details = useQuery({
    queryKey: decisionDetailsQueryKey(projectId, decisionId),
    queryFn: () => api.decision(projectId, decisionId),
    // As in the journal: asked only of a project the account is a member of.
    enabled: project !== undefined,
    retry: retryUnreachable,
  })

  const ended = [projects.error, details.error].some(isSignedOut)
  useEffect(() => {
    if (ended) void queryClient.invalidateQueries({ queryKey: sessionQueryKey })
  }, [ended, queryClient])

  if (projects.isError) {
    return (
      <p className="text-red-800" role="alert">
        {messageOf(projects.error)}
      </p>
    )
  }
  if (projects.isSuccess && project === undefined) {
    return (
      <>
        <h1 className="text-lg font-semibold">Project not found</h1>
        <p className="mt-2 text-neutral-600">
          It does not exist, or this account is not one of its members.{' '}
          <Link className="underline" to="/projects">
            Your projects
          </Link>
        </p>
      </>
    )
  }

  return (
    <>
      <p className="break-all text-neutral-600">
        <Link className="underline" to="/projects">
          Projects
        </Link>{' '}
        /{' '}
        <Link className="underline" to={back}>
          {project?.name ?? 'Journal'}
        </Link>{' '}
        /
      </p>
      <h1 className="mt-1 font-semibold break-all">Decision {decisionId}</h1>

      {details.isPending ? (
        <p className="mt-6 text-neutral-600">Loading…</p>
      ) : details.isError ? (
        details.error instanceof DashboardError && details.error.status === 404 ? (
          <p className="mt-6 text-neutral-600">
            This project has no decision under this address.{' '}
            <Link className="underline" to={back}>
              Back to the journal
            </Link>
          </p>
        ) : (
          <p className="mt-6 text-red-800" role="alert">
            {messageOf(details.error)}
          </p>
        )
      ) : (
        <>
          <OperatorView decision={details.data} />
          <DecisionBody decision={details.data} />
        </>
      )}
    </>
  )
}

function OperatorView({ decision }: { decision: DecisionDetailsResponse }) {
  const link = publicDecisionUrl(
    window.location.origin,
    import.meta.env.BASE_URL,
    decision.decisionId,
  )
  const decidedAt = decision.signedManifest?.manifest.decidedAt

  return (
    <section className="mt-4">
      <Row label="agent name">
        {decision.agent.name}
        {decision.agent.name === decision.agent.externalId ? null : (
          <span className="ml-2 text-neutral-500">({decision.agent.externalId})</span>
        )}
      </Row>
      <Row label="anchoring">
        <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[decision.status]}`}>
          {STATUS_LABEL[decision.status]}
        </span>
        <p className="mt-1 text-neutral-600">{ANCHORING_NOTE[decision.status]}</p>
      </Row>
      <Row label="received">
        {decision.receivedAt.replace('T', ' ')}
        {decidedAt !== undefined && isClockAhead({ decidedAt, receivedAt: decision.receivedAt }) ? (
          <p className="mt-1 text-amber-800">
            Signed for a later time than this — the agent’s clock is ahead.
          </p>
        ) : null}
      </Row>
      <Row label="public link">
        <PublicLink url={link} />
      </Row>
    </section>
  )
}

function PublicLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      // Clipboard refused: the link stays on screen and selectable.
      setCopied(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
      <a className="min-w-0 flex-1 break-all underline select-all" href={url}>
        {url}
      </a>
      <button
        className="self-start rounded bg-neutral-900 px-3 py-1 text-white"
        onClick={() => void copy()}
        type="button"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}
