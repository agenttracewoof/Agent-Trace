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

/**
 * Каркас публічної сторінки (T033). Її незалежний тест зі спеки — «стороння
 * людина відкриває посилання у **своєму** браузері й бачить результат» (SC-009),
 * тож тут немає ані авторизації, ані стану користувача: адреса рішення — це
 * все, що потрібно.
 *
 * Сама сторінка рішення — T034, показ станів — T035. Тут заглушка, і вона
 * навмисно нічого не стверджує про цілісність: наш API ланцюг не читає, а
 * екран, який показує його `pending` як вердикт, привчав би читача вірити
 * нашому слову — рівно тому, від чого продукт відмовляється.
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

export function App() {
  let api: PublicApi
  try {
    api = createPublicApi({ baseUrl: resolveApiBaseUrl(import.meta.env) })
  } catch (cause) {
    // Складання без адреси API дає биту сторінку, і сказати це треба прямо:
    // порожній екран читається як «рішення не існує».
    if (!(cause instanceof ApiNotConfigured)) throw cause
    return <Fatal message={cause.message} />
  }

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/decisions/:decisionId" element={<DecisionRoute api={api} />} />
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
  </Shell>
)

const Landing = () => (
  <Shell>
    <h1 className="font-semibold">AgentTrace</h1>
    <p className="mt-2 text-neutral-600">
      A decision is read at <code>/decisions/&lt;id&gt;</code>. No account is needed, and nothing
      here is taken on our word: the anchor is read from the chain.
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
function DecisionRoute({ api }: { api: PublicApi }) {
  const { decisionId } = useParams<{ decisionId: string }>()
  if (decisionId === undefined || !isDecisionId(decisionId)) return <NotFound />

  return (
    <Shell>
      <DecisionPage api={api} decisionId={decisionId} />
    </Shell>
  )
}
