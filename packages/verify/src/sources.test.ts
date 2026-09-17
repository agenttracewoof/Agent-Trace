import {
  ANCHOR_KIND,
  encodeAnchorMemo,
  encodeDecisionAnchor,
  encodeKeyRotationAnchor,
  ROTATION_KIND,
} from '@agenttrace/manifest'
import { Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  anchorFromChain,
  anchorPayloadsOf,
  type ChainSource,
  collectEvidence,
  decisionAnchorIn,
  MEMO_PROGRAM_ID,
  manifestFromUrl,
  type TransactionLike,
} from './sources.js'

const agent = Keypair.generate()
const AGENT_PUBKEY = Buffer.from(agent.publicKey.toBytes()).toString('hex')
const DECISION_ID = '0123456789abcdeffedcba9876543210'
const OTHER_DECISION = 'ffffffffffffffffffffffffffffffff'

const anchorBytes = (decisionId: string): Uint8Array =>
  encodeDecisionAnchor({
    version: 1,
    kind: ANCHOR_KIND.decision,
    agentPubkey: AGENT_PUBKEY,
    root: 'ab'.repeat(32),
    decisionId,
    decidedAt: 1_760_000_000_000,
    signature: 'cd'.repeat(64),
  })

const rotationBytes = (): Uint8Array =>
  encodeKeyRotationAnchor({
    version: 1,
    kind: ANCHOR_KIND.keyRotation,
    newPubkey: 'aa'.repeat(32),
    prevPubkey: AGENT_PUBKEY,
    rotationKind: ROTATION_KIND.chained,
    effectiveAt: 1_760_000_000_000,
    signature: 'ef'.repeat(64),
  })

/** Транзакція у тій формі, у якій її віддає `getTransaction`. */
function transactionWith(...memos: string[]): TransactionLike {
  return {
    slot: 500,
    meta: { err: null },
    transaction: {
      message: {
        staticAccountKeys: [agent.publicKey, MEMO_PROGRAM_ID],
        compiledInstructions: memos.map((memo) => ({
          programIdIndex: 1,
          data: new TextEncoder().encode(memo),
        })),
      },
    },
  }
}

function chainWith(
  entries: readonly { signature: string; err?: unknown; transaction: TransactionLike | null }[],
): ChainSource {
  return {
    getSignaturesForAddress: async () =>
      entries.map((one) => ({ signature: one.signature, err: one.err ?? null })),
    getTransaction: async (signature) =>
      entries.find((one) => one.signature === signature)?.transaction ?? null,
  }
}

describe('anchorPayloadsOf', () => {
  it('reads the anchor payload out of a memo instruction', () => {
    const payload = anchorBytes(DECISION_ID)
    const found = anchorPayloadsOf(transactionWith(encodeAnchorMemo(payload)))

    expect(found).toHaveLength(1)
    expect(Buffer.from(found[0] ?? [])).toEqual(Buffer.from(payload))
  })

  it('skips a memo somebody else tagged the address with', () => {
    // За адресою агента лежать і чужі memo: тегувати транзакцію будь-якою
    // адресою може будь-хто. Виняток обірвав би читання історії на першому
    // сторонньому рядку.
    expect(anchorPayloadsOf(transactionWith('gm', 'not hex at all'))).toEqual([])
  })

  it('ignores instructions of every other program', () => {
    const memo = encodeAnchorMemo(anchorBytes(DECISION_ID))
    const transaction = transactionWith(memo)
    const foreign: TransactionLike = {
      ...transaction,
      transaction: {
        message: {
          ...transaction.transaction.message,
          compiledInstructions: [
            { programIdIndex: 0, data: new TextEncoder().encode(memo) },
            ...transaction.transaction.message.compiledInstructions,
          ],
        },
      },
    }

    expect(anchorPayloadsOf(foreign)).toHaveLength(1)
  })

  it('reads a transaction built the way the publisher builds it', () => {
    // Форма `compiledInstructions` — припущення про бібліотеку, і воно варте
    // рівно стільки, скільки коштує тест, який будує справжню транзакцію.
    const payload = anchorBytes(DECISION_ID)
    const built = new Transaction({
      feePayer: agent.publicKey,
      recentBlockhash: PublicKey.default.toBase58(),
    }).add(
      new TransactionInstruction({
        keys: [],
        programId: MEMO_PROGRAM_ID,
        data: Buffer.from(encodeAnchorMemo(payload), 'utf8'),
      }),
    )

    const found = anchorPayloadsOf({
      slot: 1,
      meta: { err: null },
      transaction: { message: built.compileMessage() },
    })

    expect(Buffer.from(found[0] ?? [])).toEqual(Buffer.from(payload))
  })
})

describe('decisionAnchorIn', () => {
  it('picks the anchor of the decision it was asked about', () => {
    const wanted = anchorBytes(DECISION_ID)
    const found = decisionAnchorIn([anchorBytes(OTHER_DECISION), wanted], DECISION_ID)

    expect(Buffer.from(found ?? [])).toEqual(Buffer.from(wanted))
  })

  it('does not mistake a rotation anchor for a decision', () => {
    expect(decisionAnchorIn([rotationBytes()], DECISION_ID)).toBeUndefined()
  })

  it('finds nothing when no payload is about this decision', () => {
    expect(decisionAnchorIn([anchorBytes(OTHER_DECISION)], DECISION_ID)).toBeUndefined()
  })
})

describe('manifestFromUrl', () => {
  it('reads the envelope the owner storage serves', async () => {
    const envelope = { manifest: { decisionId: DECISION_ID }, signature: 'cd'.repeat(64) }
    const found = await manifestFromUrl(
      async () => new Response(JSON.stringify(envelope), { status: 200 }),
      'https://storage.example/decisions/1.json',
    )

    expect(found).toEqual(envelope)
  })

  it('returns nothing when the storage has no such object', async () => {
    expect(
      await manifestFromUrl(async () => new Response('', { status: 404 }), 'https://x.example/1'),
    ).toBeUndefined()
  })

  it('returns nothing when the storage is unreachable', async () => {
    // Мережа лежить — це «недоступно», а не «підроблено». Виняток тут зробив би
    // з тимчасової недоступності обвинувачення.
    expect(
      await manifestFromUrl(async () => {
        throw new Error('ENOTFOUND')
      }, 'https://x.example/1'),
    ).toBeUndefined()
  })

  it('returns nothing when the storage serves something that is not json', async () => {
    expect(
      await manifestFromUrl(async () => new Response('<html>nope', { status: 200 }), 'https://x/1'),
    ).toBeUndefined()
  })
})

describe('collectEvidence', () => {
  const request = {
    agentPubkey: AGENT_PUBKEY,
    decisionId: DECISION_ID,
    manifestUrl: 'https://storage.example/decisions/1.json',
  }
  const envelope = { manifest: { decisionId: DECISION_ID }, signature: 'cd'.repeat(64) }
  const serveEnvelope = async () => new Response(JSON.stringify(envelope), { status: 200 })

  it('brings the anchor from the chain and the envelope from storage', async () => {
    const chain = chainWith([
      {
        signature: 'sig',
        transaction: transactionWith(encodeAnchorMemo(anchorBytes(DECISION_ID))),
      },
    ])

    const evidence = await collectEvidence({ chain, fetch: serveEnvelope }, request)

    expect(evidence.manifest).toEqual(envelope)
    expect(evidence.anchor).toBeInstanceOf(Uint8Array)
  })

  it('walks past transactions that anchor other decisions', async () => {
    const chain = chainWith([
      {
        signature: 'other',
        transaction: transactionWith(encodeAnchorMemo(anchorBytes(OTHER_DECISION))),
      },
      {
        signature: 'ours',
        transaction: transactionWith(encodeAnchorMemo(anchorBytes(DECISION_ID))),
      },
    ])

    expect((await collectEvidence({ chain, fetch: serveEnvelope }, request)).anchor).toBeDefined()
  })

  it('ignores a transaction the chain rejected', async () => {
    // Невдала транзакція нічого в ланцюг не записала, тож її memo не є якорем.
    const chain = chainWith([
      {
        signature: 'failed',
        err: { InstructionError: [0, {}] },
        transaction: transactionWith(encodeAnchorMemo(anchorBytes(DECISION_ID))),
      },
    ])

    expect((await collectEvidence({ chain, fetch: serveEnvelope }, request)).anchor).toBeUndefined()
  })

  it('leaves the anchor out when the decision is not on chain yet', async () => {
    const evidence = await collectEvidence({ chain: chainWith([]), fetch: serveEnvelope }, request)

    expect(evidence.anchor).toBeUndefined()
    expect(evidence.manifest).toEqual(envelope)
  })

  it('reports the envelope as unavailable without inventing a reason', async () => {
    const chain = chainWith([
      {
        signature: 'sig',
        transaction: transactionWith(encodeAnchorMemo(anchorBytes(DECISION_ID))),
      },
    ])

    const evidence = await collectEvidence(
      { chain, fetch: async () => new Response('', { status: 404 }) },
      request,
    )

    expect(evidence.manifest).toBeUndefined()
    // Саме `unavailable`, а не `content-deleted`: сховище власника не каже,
    // чому обʼєкта немає, і вигадати цю різницю тут означало б збрехати.
    expect(evidence.absence).toBe('unavailable')
  })

  it('asks the chain about the agent address, not about our identifiers', async () => {
    let asked = ''
    const chain: ChainSource = {
      getSignaturesForAddress: async (address) => {
        asked = address.toBase58()
        return []
      },
      getTransaction: async () => null,
    }

    await collectEvidence({ chain, fetch: serveEnvelope }, request)

    expect(asked).toBe(agent.publicKey.toBase58())
  })
})

/**
 * T072 — підказка про транзакцію якоря. Вона про **швидкість**, і головне тут
 * не те, що вона працює, а те, що вона нічого не додає до довіри: два шляхи
 * мусять давати той самий результат, інакше «швидкий» став би «поблажливим».
 */
describe('anchorTransaction as a hint', () => {
  const request = {
    agentPubkey: AGENT_PUBKEY,
    decisionId: DECISION_ID,
    manifestUrl: 'https://storage.example/1.json',
  }

  /**
   * Ланцюг, у якому транзакція **не належить історії агента**: саме так виглядає
   * чужий запис, на який може вказувати підказка. Історія порожня навмисно —
   * інакше запасний шлях знайшов би те, що перевіряється тут як недосяжне.
   */
  function hintOnly(signature: string, transaction: TransactionLike): ChainSource {
    return {
      getSignaturesForAddress: async () => [],
      getTransaction: async (asked) => (asked === signature ? transaction : null),
    }
  }

  function countingChain(entries: Parameters<typeof chainWith>[0]) {
    const asked = { history: 0, transactions: [] as string[] }
    const inner = chainWith(entries)
    const chain: ChainSource = {
      getSignaturesForAddress: async (address, options) => {
        asked.history += 1
        return inner.getSignaturesForAddress(address, options)
      },
      getTransaction: async (signature, config) => {
        asked.transactions.push(signature)
        return inner.getTransaction(signature, config)
      },
    }
    return { chain, asked }
  }

  it('finds the anchor without walking the history at all', async () => {
    const { chain, asked } = countingChain([
      {
        signature: 'older',
        transaction: transactionWith(encodeAnchorMemo(anchorBytes(OTHER_DECISION))),
      },
      {
        signature: 'ours',
        transaction: transactionWith(encodeAnchorMemo(anchorBytes(DECISION_ID))),
      },
    ])

    const found = await anchorFromChain(chain, { ...request, anchorTransaction: 'ours' })

    expect(found).toBeInstanceOf(Uint8Array)
    expect(asked.history).toBe(0)
    expect(asked.transactions).toEqual(['ours'])
  })

  it('falls back to the walk when the hint points at nothing', async () => {
    const { chain, asked } = countingChain([
      {
        signature: 'ours',
        transaction: transactionWith(encodeAnchorMemo(anchorBytes(DECISION_ID))),
      },
    ])

    const found = await anchorFromChain(chain, { ...request, anchorTransaction: 'no-such-tx' })

    // Підказка, яка не підтвердилася, коштує рівно однієї зайвої круговерті.
    expect(found).toBeInstanceOf(Uint8Array)
    expect(asked.history).toBe(1)
  })

  it('refuses a transaction that does not name the agent', async () => {
    /**
     * Найважливіший тест задачі. Memo з чужим вмістом може написати будь-хто,
     * тож без цієї перевірки підказка приймала б запис, якого обхід історії
     * агента ніколи не побачив би, — тобто розширювала б поняття якоря.
     */
    const stranger = Keypair.generate()
    const foreign: TransactionLike = {
      slot: 700,
      meta: { err: null },
      transaction: {
        message: {
          staticAccountKeys: [stranger.publicKey, MEMO_PROGRAM_ID],
          compiledInstructions: [
            {
              programIdIndex: 1,
              data: new TextEncoder().encode(encodeAnchorMemo(anchorBytes(DECISION_ID))),
            },
          ],
        },
      },
    }
    expect(
      await anchorFromChain(hintOnly('foreign', foreign), {
        ...request,
        anchorTransaction: 'foreign',
      }),
    ).toBeUndefined()
  })

  it('refuses a transaction the chain rejected', async () => {
    const failed: TransactionLike = {
      ...transactionWith(encodeAnchorMemo(anchorBytes(DECISION_ID))),
      meta: { err: { InstructionError: [0, {}] } },
    }
    expect(
      await anchorFromChain(hintOnly('failed', failed), {
        ...request,
        anchorTransaction: 'failed',
      }),
    ).toBeUndefined()
  })

  it('refuses a hinted transaction that anchors a different decision', async () => {
    const found = await anchorFromChain(
      hintOnly('other', transactionWith(encodeAnchorMemo(anchorBytes(OTHER_DECISION)))),
      { ...request, anchorTransaction: 'other' },
    )

    expect(found).toBeUndefined()
  })

  it('survives a hint the rpc endpoint throws on', async () => {
    const chain: ChainSource = {
      getSignaturesForAddress: async () => [],
      getTransaction: async () => {
        throw new Error('rpc said no')
      },
    }

    expect(await anchorFromChain(chain, { ...request, anchorTransaction: 'boom' })).toBeUndefined()
  })
})
