import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Link, Route, Routes, useParams } from 'react-router-dom'
import {
  ApiNotConfigured,
  createPublicApi,
  isDecisionId,
  type PublicApi,
  resolveApiBaseUrl,
} from './api'
import { DecisionPage } from './pages/Decision'
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
          <Route path="/" element={<Landing />} />
          <Route path="/verify" element={<VerifyRoute />} />
          <Route path="/decisions/:decisionId" element={<DecisionRoute />} />
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

const Landing = () => (
  <Shell>
    <h1 className="font-semibold">AgentTrace</h1>
    <p className="mt-2 text-neutral-600">
      A decision is read at <code>/decisions/&lt;id&gt;</code>. No account is needed, and nothing
      here is taken on our word: the anchor is read from the chain.
    </p>
    <p className="mt-4 text-neutral-600">
      <Link className="underline" to="/verify">
        Verify an envelope yourself
      </Link>{' '}
      — that page talks to the chain only, never to us.
    </p>
  </Shell>
)

const NotFound = () => (
  <Shell>
    <h1 className="font-semibold">Nothing here</h1>
    <p className="mt-2 text-neutral-600">
      <Link className="underline" to="/">
        Back
      </Link>
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
