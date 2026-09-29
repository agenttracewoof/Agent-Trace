import type { ChainClient } from './loop.js'

/**
 * RPC budget (T076, SC-008). The day-long run of T064 measured 4.9 Helius
 * credits per decision against ~1.3 in `PLAN.md`, and the free plan (1 M a
 * month) would run dry on day 21 at 10 000 decisions a day. Two of those
 * credits were the blockhash and the fee reading, which the loop asked for on
 * **every** pass although both describe the network, not a decision. With an
 * arrival every ~8.6 s nearly every decision got a pass of its own, so "once
 * per pass" in practice meant "once per decision".
 */

/**
 * How long a cached blockhash lives. A transaction carrying it stays valid for
 * ~150 slots from the moment the hash appeared, 60–90 s; even taken at the end
 * of the cache window it leaves the transaction half a minute, and confirming
 * takes a few seconds. `BLOCKHASH_EXPIRY_MS` in the loop is unaffected: an older
 * hash means the transaction expires **earlier** than the loop decides to send
 * it again, never later.
 */
export const CHAIN_CACHE_MS = 30_000

export interface CachedChainOptions {
  readonly ttlMs?: number
  readonly now?: () => number
}

interface Cached<T> {
  readonly at: number
  readonly value: T
}

/**
 * A wrapper around the chain client that outlives a single pass — `publishPending`
 * itself keeps no state, and its tests run it one pass at a time. Sends and
 * statuses are never cached: the first is an action, the second is exactly what
 * we are waiting to see change.
 */
export function cachedChain(chain: ChainClient, options: CachedChainOptions = {}): ChainClient {
  const ttlMs = options.ttlMs ?? CHAIN_CACHE_MS
  const now = options.now ?? (() => Date.now())

  let blockhash: Cached<{ readonly blockhash: string }> | null = null
  let fees: Cached<readonly { readonly prioritizationFee: number }[]> | null = null

  const fresh = <T>(entry: Cached<T> | null): entry is Cached<T> =>
    entry !== null && now() - entry.at < ttlMs

  return {
    async getLatestBlockhash() {
      if (fresh(blockhash)) return blockhash.value
      // Stamped when asked, not when answered: the hash's age runs from when the
      // network handed it out, so the cache can only err on the safe side.
      const at = now()
      const value = await chain.getLatestBlockhash()
      blockhash = { at, value }
      return value
    },
    async getRecentPrioritizationFees() {
      if (fresh(fees)) return fees.value
      const at = now()
      const value = await chain.getRecentPrioritizationFees()
      fees = { at, value }
      return value
    },
    sendRawTransaction: (raw) => chain.sendRawTransaction(raw),
    getSignatureStatuses: (signatures) => chain.getSignatureStatuses(signatures),
    forgetBlockhash() {
      blockhash = null
    },
  }
}

export interface CallCounts {
  /** When counting began — with the process, so a restart resets the tally. */
  readonly sinceMs: number
  readonly total: number
  readonly byMethod: Readonly<Record<string, number>>
}

export interface CountedClient<T> {
  readonly client: T
  readonly counts: () => CallCounts
}

/**
 * Calls counted by method. The provider's dashboard shows a single total ("RPC,
 * 100 %"), so without a tally of our own there is no telling **what** eats the
 * quota — which is how a sibling project found out its subscriptions were to
 * blame.
 *
 * The method runs on the client itself, not on the proxy: the library's calls
 * to itself are not counted, and the tally equals what we asked for.
 */
export function countCalls<T extends object>(
  target: T,
  now: () => number = () => Date.now(),
): CountedClient<T> {
  const sinceMs = now()
  const byMethod: Record<string, number> = {}

  const client = new Proxy(target, {
    get(object, property) {
      const value: unknown = Reflect.get(object, property, object)
      if (typeof value !== 'function' || typeof property !== 'string') return value
      return (...args: unknown[]) => {
        byMethod[property] = (byMethod[property] ?? 0) + 1
        return (value as (...rest: unknown[]) => unknown).apply(object, args)
      }
    },
  })

  return {
    client,
    counts: () => ({
      sinceMs,
      total: Object.values(byMethod).reduce((sum, one) => sum + one, 0),
      byMethod: { ...byMethod },
    }),
  }
}
