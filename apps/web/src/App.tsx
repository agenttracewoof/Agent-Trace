import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { BrowserRouter, Link, Navigate, Route, Routes, useParams } from 'react-router-dom'
import {
  ApiNotConfigured,
  createPublicApi,
  isDecisionId,
  type PublicApi,
  resolveApiBaseUrl,
} from './api'
import {
  createDashboardApi,
  type DashboardApi,
  retryUnreachable,
  sessionQueryKey,
} from './dashboard'
import { DecisionPage } from './pages/Decision'
import { DecisionDetails } from './pages/DecisionDetails'
import { Journal } from './pages/Journal'
import { Projects } from './pages/Projects'
import { SignIn } from './pages/SignIn'
import { VerifyPage } from './pages/Verify'

/**
 * Каркас публічної сторінки (T033). Її незалежний тест зі спеки — «стороння
 * людина відкриває посилання у **своєму** браузері й бачить результат» (SC-009),
 * тож тут немає ані авторизації, ані стану користувача: адреса рішення — це
 * все, що потрібно.
 *
 * Адреса API резолвиться **всередині маршруту рішення**, а не тут (T073).
 * Раніше вона резолвилася в корені, і складання без `VITE_API_URL` давало
 * екран «не налаштовано» **на весь застосунок** — включно зі сторінкою
 * `/verify`, якій наш API не потрібен узагалі. Тобто одна змінна вимикала й те,
 * що від неї не залежить.
 */

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      /**
       * Повторюємо лише те, що кидає `ApiUnreachable` — тимчасову недоступність.
       * «Немає такого рішення» і «відповідь не за контрактом» приїжджають як
       * дані, тож react-query їх не повторює за побудовою.
       */
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
})

/**
 * `base` у Vite задає підшлях, під яким віддається складання (на GitHub Pages
 * це `/Agent-Trace/`). Роутер мусить знати той самий префікс, інакше глибокі
 * посилання вестимуть у порожнечу.
 */
const basename = import.meta.env.BASE_URL.replace(/\/$/, '')

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      {/* `exactOptionalPropertyTypes` не дає передати `undefined` у необовʼязкове
          поле, а корінь — це `'/'`, не «нічого». */}
      <BrowserRouter basename={basename === '' ? '/' : basename}>
        <Routes>
          <Route path="/" element={<HomeRoute />} />
          <Route path="/verify" element={<VerifyRoute />} />
          <Route path="/decisions/:decisionId" element={<DecisionRoute />} />
          <Route path="/sign-in" element={<DashboardRoute screen="sign-in" />} />
          <Route path="/projects" element={<DashboardRoute screen="projects" />} />
          <Route path="/projects/:projectId" element={<DashboardRoute screen="journal" />} />
          <Route
            path="/projects/:projectId/decisions/:decisionId"
            element={<DashboardRoute screen="decision" />}
          />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}

const Shell = ({ children }: { children: React.ReactNode }) => (
  <main className="mx-auto max-w-3xl p-8 font-mono text-sm">{children}</main>
)

const Fatal = ({ message }: { message: string }) => (
  <Shell>
    <h1 className="font-semibold">This page is not configured</h1>
    <p className="mt-2 text-neutral-600">{message}</p>
    <p className="mt-2 text-neutral-600">
      <Link className="underline" to="/verify">
        Checking an envelope against the chain
      </Link>{' '}
      needs no API and works here regardless.
    </p>
  </Shell>
)

/**
 * The home page is not part of this app: it is the static page in
 * `apps/landing`, served at the site's root, and this bundle answers every
 * other address through `404.html`. Nothing in production routes here; a
 * link back home is a full load of that page (`homeHref`). What remains is
 * for `pnpm dev`, which has no landing to show.
 */
const HomeRoute = () => (
  <Shell>
    <h1 className="font-semibold">AgentTrace</h1>
    <p className="mt-2 text-neutral-600">
      The home page is served separately (<code>apps/landing</code>).{' '}
      <Link className="underline" to="/verify">
        Verify a decision
      </Link>{' '}
      ·{' '}
      <Link className="underline" to="/sign-in">
        Sign in
      </Link>
    </p>
  </Shell>
)

/** The static home page: a full load, since it is not a route of this app. */
const homeHref = import.meta.env.BASE_URL

const NotFound = () => (
  <Shell>
    <h1 className="font-semibold">Nothing here</h1>
    <p className="mt-2 text-neutral-600">
      <a className="underline" href={homeHref}>
        Back
      </a>
    </p>
  </Shell>
)

/**
 * Форма адреси перевіряється до запиту: `decisionId` — це 32 hex, і формат
 * публічний. Питати наш сервіс про завідомо неможливу адресу означало б
 * показувати 400 як стан рішення.
 */
function DecisionRoute() {
  const { decisionId } = useParams<{ decisionId: string }>()

  let api: PublicApi
  try {
    api = createPublicApi({ baseUrl: resolveApiBaseUrl(import.meta.env) })
  } catch (cause) {
    if (!(cause instanceof ApiNotConfigured)) throw cause
    return <Fatal message={cause.message} />
  }

  if (decisionId === undefined || !isDecisionId(decisionId)) return <NotFound />

  return (
    <Shell>
      <DecisionPage api={api} decisionId={decisionId} />
    </Shell>
  )
}

const VerifyRoute = () => (
  <Shell>
    <VerifyPage />
  </Shell>
)

type Screen = 'sign-in' | 'projects' | 'journal' | 'decision'

/**
 * The operator's screens (T079, T042). Each asks the API who is signed in and
 * sends the visitor to the right screen when it is the wrong one: signed out
 * on `/projects`, a journal or a decision goes to sign in, signed in on `/sign-in` goes to
 * the projects.
 */
function DashboardRoute({ screen }: { screen: Screen }) {
  let api: DashboardApi
  try {
    api = createDashboardApi({ baseUrl: resolveApiBaseUrl(import.meta.env) })
  } catch (cause) {
    if (!(cause instanceof ApiNotConfigured)) throw cause
    return <Fatal message={cause.message} />
  }

  return (
    <Shell>
      <DashboardScreen api={api} screen={screen} />
    </Shell>
  )
}

function DashboardScreen({ api, screen }: { api: DashboardApi; screen: Screen }) {
  const { projectId, decisionId } = useParams<{ projectId: string; decisionId: string }>()
  const session = useQuery({
    queryKey: sessionQueryKey,
    queryFn: () => api.session(),
    retry: retryUnreachable,
  })

  if (session.isPending) return <p className="text-neutral-600">Loading…</p>
  if (session.isError) {
    return (
      <p className="text-red-800" role="alert">
        {session.error.message}
      </p>
    )
  }

  if (screen === 'decision') {
    if (session.data === null) return <Navigate replace to="/sign-in" />
    if (projectId === undefined) return <Navigate replace to="/projects" />
    // Checked before asking, as on the public page: a malformed id names no decision.
    if (decisionId === undefined || !isDecisionId(decisionId)) {
      return (
        <p className="text-neutral-600">
          No decision under this address.{' '}
          <Link className="underline" to={`/projects/${projectId}`}>
            Back to the journal
          </Link>
        </p>
      )
    }
    return <DecisionDetails api={api} decisionId={decisionId} projectId={projectId} />
  }
  if (screen === 'journal') {
    if (session.data === null) return <Navigate replace to="/sign-in" />
    if (projectId === undefined) return <Navigate replace to="/projects" />
    return <Journal api={api} projectId={projectId} />
  }
  if (screen === 'projects') {
    return session.data === null ? (
      <Navigate replace to="/sign-in" />
    ) : (
      <Projects api={api} email={session.data.user.email} />
    )
  }
  return session.data === null ? <SignIn api={api} /> : <Navigate replace to="/projects" />
}
