import {
  type DecisionStatus,
  decisionStatusSchema,
  type JournalEntry,
  type JournalQuery,
  type ProjectAgent,
} from '@agenttrace/shared'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import {
  agentsQueryKey,
  type DashboardApi,
  DashboardError,
  isSignedOut,
  journalQueryKey,
  projectsQueryKey,
  retryUnreachable,
  sessionQueryKey,
} from '../dashboard'
import { formatDecidedAt, PAST_CALENDAR } from './Decision'

/**
 * A project's decisions, newest first, filtered by agent, period and anchoring
 * state (FR-016, T042) — the operator's view of `GET /projects/:id/decisions`.
 *
 * The filters live in the address, so a filtered view survives a reload and can
 * be sent to another member. The page cursor does not: keyset pages are counted
 * from the newest decision, and an address holding one would go stale as soon
 * as the next decision arrived.
 *
 * Days are UTC days, and every time on the page is UTC — the form the public
 * decision page shows, so one decision reads the same wherever it is opened.
 */

const DAY_MS = 86_400_000
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** What the form holds, in the address's terms: days, not milliseconds. */
export interface JournalFilters {
  readonly agentId?: string
  /** First day shown, `YYYY-MM-DD`, UTC. */
  readonly from?: string
  /** Last day shown — inclusive here, made exclusive for the API. */
  readonly to?: string
  readonly status?: DecisionStatus
}

/** Midnight UTC that starts the day, or `undefined` for anything not a calendar day. */
export function dayStart(day: string): number | undefined {
  const match = DAY.exec(day)
  if (match === null) return undefined
  const [, year, month, date] = match.map(Number)
  if (year === undefined || month === undefined || date === undefined) return undefined
  const start = Date.UTC(year, month - 1, date)
  // `Date.UTC` rolls 2026-02-31 over into March; a day that rolled is not the one asked for.
  return new Date(start).toISOString().startsWith(day) ? start : undefined
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The filters an address carries. A value that cannot be a filter — edited by
 * hand, cut short in a message — is dropped, and the form then shows what is
 * actually applied rather than what the address claimed.
 */
export function filtersFromSearch(search: URLSearchParams): JournalFilters {
  const agentId = search.get('agent')
  const from = search.get('from')
  const to = search.get('to')
  const status = decisionStatusSchema.safeParse(search.get('status'))
  return {
    ...(agentId !== null && UUID.test(agentId) ? { agentId: agentId.toLowerCase() } : {}),
    ...(from !== null && dayStart(from) !== undefined ? { from } : {}),
    ...(to !== null && dayStart(to) !== undefined ? { to } : {}),
    ...(status.success ? { status: status.data } : {}),
  }
}

export function searchFromFilters(filters: JournalFilters): URLSearchParams {
  const search = new URLSearchParams()
  if (filters.agentId !== undefined) search.set('agent', filters.agentId)
  if (filters.from !== undefined) search.set('from', filters.from)
  if (filters.to !== undefined) search.set('to', filters.to)
  if (filters.status !== undefined) search.set('status', filters.status)
  return search
}

/**
 * The API's query for the filters, or the reason there is none to send. The
 * period is `[from, to)` in signed milliseconds; the last day the operator
 * picked is whole, so `to` is the midnight after it.
 */
export function queryFromFilters(
  filters: JournalFilters,
): { readonly query: JournalQuery } | { readonly problem: string } {
  const from = filters.from === undefined ? undefined : dayStart(filters.from)
  const lastDay = filters.to === undefined ? undefined : dayStart(filters.to)
  const to = lastDay === undefined ? undefined : lastDay + DAY_MS
  if (from !== undefined && to !== undefined && from >= to) {
    return { problem: 'The period ends before it starts.' }
  }
  return {
    query: {
      ...(filters.agentId === undefined ? {} : { agentId: filters.agentId }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      ...(filters.status === undefined ? {} : { status: filters.status }),
    },
  }
}

/** The signed time, in UTC; past any calendar date, its raw milliseconds too. */
export function signedTime(decidedAt: number): string {
  const formatted = formatDecidedAt(decidedAt)
  return formatted === PAST_CALENDAR ? `${decidedAt} ms — ${PAST_CALENDAR}` : formatted
}

/**
 * A decision signed later than it reached us. Buffered decisions arrive late,
 * which is normal; one from the future means the agent's clock is wrong. A
 * minute of slack covers ordinary drift between two honest clocks.
 */
export const CLOCK_SLACK_MS = 60_000

export const isClockAhead = (entry: Pick<JournalEntry, 'decidedAt' | 'receivedAt'>): boolean =>
  entry.decidedAt - Date.parse(entry.receivedAt) > CLOCK_SLACK_MS

export const STATUS_LABEL: Readonly<Record<DecisionStatus, string>> = {
  pending: 'Waiting for anchor',
  anchored: 'Anchored',
  failed: 'Anchoring failed',
}

export const STATUS_STYLE: Readonly<Record<DecisionStatus, string>> = {
  pending: 'bg-neutral-200 text-neutral-800',
  anchored: 'bg-emerald-100 text-emerald-900',
  failed: 'bg-red-100 text-red-900',
}

const messageOf = (cause: unknown): string =>
  cause instanceof DashboardError ? cause.message : 'Something failed. Try again.'

export function Journal({ api, projectId }: { api: DashboardApi; projectId: string }) {
  const queryClient = useQueryClient()
  const [search, setSearch] = useSearchParams()
  const location = useLocation()
  const filters = filtersFromSearch(search)
  const request = queryFromFilters(filters)

  const projects = useQuery({
    queryKey: projectsQueryKey,
    queryFn: () => api.projects(),
    retry: retryUnreachable,
  })
  const project = projects.data?.projects.find((one) => one.id === projectId)
  // Asked only of a project the account is a member of: the list answers that
  // already, and a foreign one would only bring back two 404s.
  const member = project !== undefined
  const agents = useQuery({
    queryKey: agentsQueryKey(projectId),
    queryFn: () => api.agents(projectId),
    enabled: member,
    retry: retryUnreachable,
  })
  const query = 'query' in request ? request.query : {}
  const journal = useInfiniteQuery({
    queryKey: journalQueryKey(projectId, query),
    queryFn: ({ pageParam }) =>
      api.journal(projectId, pageParam === null ? query : { ...query, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: member && 'query' in request,
    retry: retryUnreachable,
  })

  // A session that ended while the page was open: asking again for the session
  // sends the route to the sign-in, as on the projects screen.
  const ended = [projects.error, agents.error, journal.error].some(isSignedOut)
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
    // The API answers a foreign project as an absent one (T041); so does the page.
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

  const change = (next: JournalFilters) => setSearch(searchFromFilters(next))
  const entries = journal.data?.pages.flatMap((page) => page.decisions) ?? []

  return (
    <>
      <p className="text-neutral-600">
        <Link className="underline" to="/projects">
          Projects
        </Link>{' '}
        /
      </p>
      <h1 className="mt-1 text-lg font-semibold break-all">{project?.name ?? 'Journal'}</h1>

      <Filters
        agents={agents.data?.agents}
        agentsTruncated={agents.data?.truncated ?? false}
        filters={filters}
        onChange={change}
      />

      {'problem' in request ? (
        <p className="mt-4 text-red-800" role="alert">
          {request.problem}
        </p>
      ) : journal.isPending ? (
        <p className="mt-6 text-neutral-600">Loading…</p>
      ) : journal.isError ? (
        <p className="mt-6 text-red-800" role="alert">
          {messageOf(journal.error)}
        </p>
      ) : entries.length === 0 ? (
        <p className="mt-6 text-neutral-600">
          {Object.keys(query).length === 0
            ? 'No decisions yet. They appear here once an agent with this project’s key records one.'
            : 'No decisions match these filters.'}
        </p>
      ) : (
        <>
          <ul className="mt-6 divide-y divide-neutral-200 border-y border-neutral-200">
            {entries.map((entry) => (
              <Entry
                entry={entry}
                journalSearch={location.search}
                key={entry.decisionId}
                projectId={projectId}
              />
            ))}
          </ul>
          {journal.hasNextPage ? (
            <button
              className="mt-4 rounded bg-neutral-900 px-3 py-1 text-white disabled:opacity-50"
              disabled={journal.isFetchingNextPage}
              onClick={() => void journal.fetchNextPage()}
              type="button"
            >
              {journal.isFetchingNextPage ? 'Loading…' : 'Show older'}
            </button>
          ) : (
            <p className="mt-4 text-neutral-500">That is the oldest one.</p>
          )}
        </>
      )}
    </>
  )
}

function Filters({
  agents,
  agentsTruncated,
  filters,
  onChange,
}: {
  agents: readonly ProjectAgent[] | undefined
  agentsTruncated: boolean
  filters: JournalFilters
  onChange: (next: JournalFilters) => void
}) {
  const set = <K extends keyof JournalFilters>(key: K, value: string) => {
    const { [key]: _, ...rest } = filters
    onChange(value === '' ? rest : { ...rest, [key]: value })
  }
  // An agent from the address that the list does not hold (another project's,
  // or one past the cut) stays selectable, so the form shows what is applied.
  const unlisted =
    filters.agentId !== undefined &&
    agents !== undefined &&
    !agents.some((agent) => agent.id === filters.agentId)
  const field = 'mt-1 w-full rounded border border-neutral-300 bg-white px-2 py-1'

  return (
    <form
      className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-4"
      onSubmit={(event) => event.preventDefault()}
    >
      <label className="block">
        <span className="text-neutral-600">Agent</span>
        <select
          className={field}
          disabled={agents === undefined}
          onChange={(event) => set('agentId', event.target.value)}
          value={filters.agentId ?? ''}
        >
          <option value="">All agents</option>
          {unlisted ? <option value={filters.agentId}>Not in the list</option> : null}
          {agents?.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name === agent.externalId ? agent.name : `${agent.name} (${agent.externalId})`}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-neutral-600">From (UTC)</span>
        <input
          className={field}
          onChange={(event) => set('from', event.target.value)}
          type="date"
          value={filters.from ?? ''}
        />
      </label>
      <label className="block">
        <span className="text-neutral-600">To (UTC)</span>
        <input
          className={field}
          onChange={(event) => set('to', event.target.value)}
          type="date"
          value={filters.to ?? ''}
        />
      </label>
      <label className="block">
        <span className="text-neutral-600">Anchoring</span>
        <select
          className={field}
          onChange={(event) => set('status', event.target.value)}
          value={filters.status ?? ''}
        >
          <option value="">Any</option>
          {decisionStatusSchema.options.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABEL[status]}
            </option>
          ))}
        </select>
      </label>
      {agentsTruncated ? (
        <p className="text-neutral-600 sm:col-span-4">
          The list holds the first agents by name only; this project has more.
        </p>
      ) : null}
    </form>
  )
}

/** What a details page needs to lead back to the journal as it was left. */
export interface FromJournal {
  readonly journalSearch: string
}

function Entry({
  entry,
  projectId,
  journalSearch,
}: {
  entry: JournalEntry
  projectId: string
  journalSearch: string
}) {
  const from: FromJournal = { journalSearch }
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link
          className="underline"
          state={from}
          to={`/projects/${projectId}/decisions/${entry.decisionId}`}
        >
          {signedTime(entry.decidedAt)}
        </Link>
        <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[entry.status]}`}>
          {STATUS_LABEL[entry.status]}
        </span>
      </div>
      <p className="mt-1 break-all text-neutral-600">
        {entry.agent.name} · {entry.model}
        {entry.anchor === null ? null : <> · slot {entry.anchor.slot.toLocaleString('en-US')}</>}
      </p>
      {isClockAhead(entry) ? (
        <p className="mt-1 text-amber-800">
          Signed for a time after it reached us ({entry.receivedAt.replace('T', ' ')}) — the agent’s
          clock is ahead.
        </p>
      ) : null}
      {entry.contentDeletedAt === null ? null : (
        <p className="mt-1 text-neutral-500">The content was deleted by its owner.</p>
      )}
    </li>
  )
}
