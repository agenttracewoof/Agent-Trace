import { anchorFromChain, type ChainSource } from '@agenttrace/verify'
import { Connection } from '@solana/web3.js'

/**
 * Читання ланцюга **з браузера читача** (FR-013, FR-014). Це не оптимізація і не
 * зручність: наш API ланцюг не читає й ніколи не каже `verified`, тож сторінка,
 * яка показала б «підтверджено» з наших слів, доводила б рівно нічого. Байти
 * якоря дістає той, хто дивиться, і звіряє їх той самий `verifyDecision`, що й
 * `agenttrace-verify`.
 */

export class ChainNotConfigured extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChainNotConfigured'
  }
}

/**
 * Ендпоінт приходить складанням і **не має дефолту**. Змінна з префіксом `VITE_`
 * потрапляє у бандл, тобто стає публічною: ключований RPC тут означав би
 * опублікований ключ. Тому для демо сюди йде безключовий публічний вузол
 * (`https://api.devnet.solana.com`), а хто хоче свій — підставляє свій.
 */
export function resolveRpcUrl(env: Readonly<Record<string, unknown>>): string {
  const value = env.VITE_SOLANA_RPC_URL
  if (typeof value !== 'string' || value === '') {
    throw new ChainNotConfigured('VITE_SOLANA_RPC_URL is not set, so the chain was not read')
  }
  const parsed = new URL(value)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ChainNotConfigured(`VITE_SOLANA_RPC_URL must be an http(s) url: ${value}`)
  }
  if (parsed.search !== '') {
    /**
     * Ключ у query потрапив би у бандл і став би публічним разом зі сторінкою.
     * Мовчки його прийняти — це опублікувати чужий платний доступ; краще не
     * прочитати ланцюг узагалі, ніж зробити це ціною секрету.
     */
    throw new ChainNotConfigured(
      'VITE_SOLANA_RPC_URL carries a query string: it would be published inside the bundle',
    )
  }
  return value
}

/** Той самий інтерфейс, що бере CLI: `Connection` задовольняє його структурно. */
export const chainSource = (rpcUrl: string): ChainSource => new Connection(rpcUrl, 'confirmed')

export const anchorQuery = (
  rpcUrl: string,
  request: { readonly agentPubkey: string; readonly decisionId: string },
) => ({
  queryKey: ['chain-anchor', rpcUrl, request.agentPubkey, request.decisionId] as const,
  queryFn: () =>
    anchorFromChain(chainSource(rpcUrl), {
      agentPubkey: request.agentPubkey,
      decisionId: request.decisionId,
      // Шар джерел приймає адресу конверта разом із запитом, але тут конверт уже
      // в руках: його віддав API разом із рішенням, і читати його вдруге нема
      // навіщо. Порожній рядок сюди не потрапляє — `anchorFromChain` його не чіпає.
      manifestUrl: '',
    }),
})
