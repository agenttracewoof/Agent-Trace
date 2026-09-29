import { describe, expect, it } from 'vitest'
import { CHAIN_CACHE_MS, cachedChain, countCalls } from './budget.js'
import type { ChainClient } from './loop.js'

interface Asked {
  blockhash: number
  fees: number
  sends: number
  statuses: number
}

function countingChain(): { readonly chain: ChainClient; readonly asked: Asked } {
  const asked: Asked = { blockhash: 0, fees: 0, sends: 0, statuses: 0 }
  return {
    asked,
    chain: {
      getLatestBlockhash: async () => {
        asked.blockhash += 1
        return { blockhash: `hash-${asked.blockhash}` }
      },
      getRecentPrioritizationFees: async () => {
        asked.fees += 1
        return [{ prioritizationFee: asked.fees }]
      },
      sendRawTransaction: async () => {
        asked.sends += 1
        return 'sent'
      },
      getSignatureStatuses: async (signatures) => {
        asked.statuses += 1
        return { value: signatures.map(() => null) }
      },
    },
  }
}

describe('blockhash and fee cache', () => {
  it('asks the network once per window, however many passes run inside it', async () => {
    let clock = 0
    const { chain, asked } = countingChain()
    const cached = cachedChain(chain, { now: () => clock })

    // Fifteen passes two seconds apart — exactly what the loop does in a window.
    for (let pass = 0; pass < 15; pass += 1) {
      await cached.getLatestBlockhash()
      await cached.getRecentPrioritizationFees()
      clock += 1_999
    }

    expect(asked.blockhash).toBe(1)
    expect(asked.fees).toBe(1)
  })

  it('asks again once the window is over, and hands back the fresh value', async () => {
    let clock = 0
    const { chain, asked } = countingChain()
    const cached = cachedChain(chain, { now: () => clock })

    await cached.getLatestBlockhash()
    clock += CHAIN_CACHE_MS

    expect(await cached.getLatestBlockhash()).toEqual({ blockhash: 'hash-2' })
    expect(asked.blockhash).toBe(2)
  })

  it('forgets the blockhash on request but keeps the fee reading', async () => {
    const { chain, asked } = countingChain()
    const cached = cachedChain(chain, { now: () => 0 })

    await cached.getLatestBlockhash()
    await cached.getRecentPrioritizationFees()
    cached.forgetBlockhash?.()
    await cached.getLatestBlockhash()
    await cached.getRecentPrioritizationFees()

    expect(asked.blockhash).toBe(2)
    expect(asked.fees).toBe(1)
  })

  it('never caches a send or a status — one is an action, the other is what we wait for', async () => {
    const { chain, asked } = countingChain()
    const cached = cachedChain(chain, { now: () => 0 })

    await cached.sendRawTransaction(new Uint8Array())
    await cached.sendRawTransaction(new Uint8Array())
    await cached.getSignatureStatuses(['a'])
    await cached.getSignatureStatuses(['a'])

    expect(asked.sends).toBe(2)
    expect(asked.statuses).toBe(2)
  })

  it('does not cache a failure: the next call asks the network again', async () => {
    let calls = 0
    const cached = cachedChain(
      {
        ...countingChain().chain,
        getLatestBlockhash: async () => {
          calls += 1
          if (calls === 1) throw new Error('429')
          return { blockhash: 'recovered' }
        },
      },
      { now: () => 0 },
    )

    await expect(cached.getLatestBlockhash()).rejects.toThrow('429')
    expect(await cached.getLatestBlockhash()).toEqual({ blockhash: 'recovered' })
  })
})

describe('rpc call tally', () => {
  class FakeConnection {
    readonly rpcEndpoint = 'https://rpc.example'

    async getSlot(): Promise<number> {
      return 7
    }

    // A library calling itself: it must stay out of the tally, because the
    // provider's dashboard sees one request here, not two.
    async getSlotTwice(): Promise<number> {
      return (await this.getSlot()) + (await this.getSlot())
    }
  }

  it('counts each call by method name and totals them', async () => {
    const { client, counts } = countCalls(new FakeConnection(), () => 1_000)

    await client.getSlot()
    await client.getSlot()
    await client.getSlotTwice()

    expect(counts()).toEqual({
      sinceMs: 1_000,
      total: 3,
      byMethod: { getSlot: 2, getSlotTwice: 1 },
    })
  })

  it('passes values through and leaves plain properties alone', async () => {
    const { client, counts } = countCalls(new FakeConnection())

    expect(await client.getSlot()).toBe(7)
    expect(client.rpcEndpoint).toBe('https://rpc.example')
    expect(counts().total).toBe(1)
  })

  it('hands out a copy, so a caller cannot rewrite the tally', async () => {
    const { client, counts } = countCalls(new FakeConnection())
    await client.getSlot()

    const first = counts()
    ;(first.byMethod as Record<string, number>).getSlot = 1_000

    expect(counts().byMethod.getSlot).toBe(1)
  })
})
