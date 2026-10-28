import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  ADMINISTRATIVE_ROTATION_SIGNATURE,
  ANCHOR_KIND,
  anchorKindOf,
  decodeAnchorMemo,
  decodeKeyRotationAnchor,
  ROTATION_KIND,
} from '@agenttrace/manifest'
import { PGlite } from '@electric-sql/pglite'
import { Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ATTEMPT_CEILING,
  type ChainClient,
  type PublisherConfig,
  publishPending,
  toBase58,
} from './loop.js'

const migrationDir = fileURLToPath(new URL('../drizzle/', import.meta.resolve('@agenttrace/db')))
const migration = readdirSync(migrationDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(migrationDir + name, 'utf8'))
  .join('\n')

const PROJECT = '11111111-1111-4111-8111-111111111111'
const AGENT = '22222222-2222-4222-8222-222222222222'
const OWNER = '55555555-5555-4555-8555-555555555555'
const INITIAL = '33333333-3333-4333-8333-333333333333'
const ROTATED = '33333333-3333-4333-8333-333333333334'
const DECISION = '44444444-4444-4444-8444-444444444444'
const EFFECTIVE_AT = 1_760_000_000_000

const pubkeyOf = (keypair: Keypair) => Buffer.from(keypair.publicKey.toBytes()).toString('hex')
const previousKey = pubkeyOf(Keypair.generate())
const nextKey = pubkeyOf(Keypair.generate())
const PROOF = 'ef'.repeat(64)

let client: PGlite
let db: ReturnType<typeof drizzle>

const config: PublisherConfig = {
  payer: Keypair.generate(),
  maxPriorityLamports: 10_000,
  batchSize: 10,
  sleep: async () => {},
}

function fakeChain(overrides: Partial<ChainClient> = {}): ChainClient {
  return {
    getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111' }),
    sendRawTransaction: async () => 'sent',
    getSignatureStatuses: async (signatures) => ({
      value: signatures.map(() => ({ slot: 500, confirmationStatus: 'confirmed', err: null })),
    }),
    getRecentPrioritizationFees: async () => [{ prioritizationFee: 0 }],
    ...overrides,
  }
}

/** Every transaction the pass sent, in the order it sent them. */
function recordingChain(overrides: Partial<ChainClient> = {}) {
  const sent: Uint8Array[] = []
  const chain = fakeChain({
    sendRawTransaction: async (raw) => {
      sent.push(raw)
      return 'sent'
    },
    ...overrides,
  })
  return { chain, sent }
}

const memoOf = (raw: Uint8Array): Uint8Array =>
  decodeAnchorMemo(
    Buffer.from(Transaction.from(raw).instructions.at(-1)?.data ?? []).toString('utf8'),
  ) ?? new Uint8Array()

async function seedRotation(
  kind: 'chained' | 'administrative',
  extra: { attempts?: number; nextAttemptAt?: string; anchorSignature?: string } = {},
): Promise<void> {
  await client.query(
    `INSERT INTO agent_keys (id, agent_id, public_key, valid_from, rotation_kind, prev_key_id,
                             rotation_proof, confirmed_by, anchor_status, attempts,
                             next_attempt_at, anchor_signature)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10, $11)`,
    [
      ROTATED,
      AGENT,
      nextKey,
      EFFECTIVE_AT,
      kind,
      INITIAL,
      kind === 'chained' ? PROOF : null,
      kind === 'administrative' ? OWNER : null,
      extra.attempts ?? 0,
      extra.nextAttemptAt ?? new Date(Date.now() - 1000).toISOString(),
      extra.anchorSignature ?? null,
    ],
  )
}

async function seedDecision(keyId: string): Promise<void> {
  await client.query(
    `INSERT INTO decisions (id, project_id, agent_id, agent_key_id, root, signature, decided_at,
                            model_ref, sources, steps, outcome, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'claude-opus-5', '[]'::jsonb, '[]'::jsonb,
             '{}'::jsonb, $8)`,
    [
      DECISION,
      PROJECT,
      AGENT,
      keyId,
      'ab'.repeat(32),
      'cd'.repeat(64),
      EFFECTIVE_AT + 1,
      new Date(Date.now() - 1000).toISOString(),
    ],
  )
}

type KeyRow = {
  anchor_status: string | null
  attempts: number
  anchor_signature: string | null
  anchor_slot: number | null
  rotation_proof: string | null
}

const readKey = async (id = ROTATED): Promise<KeyRow> => {
  const rows = await client.query<KeyRow>(
    `SELECT anchor_status, attempts, anchor_signature, anchor_slot::int, rotation_proof
     FROM agent_keys WHERE id = $1`,
    [id],
  )
  const row = rows.rows[0]
  if (row === undefined) throw new Error('key row disappeared')
  return row
}

beforeAll(async () => {
  client = await PGlite.create()
  await client.exec(migration)
  db = drizzle(client)

  await client.query(`INSERT INTO projects (id, name, ingest_key_hash) VALUES ($1, 'demo', $2)`, [
    PROJECT,
    '0f'.repeat(32),
  ])
  await client.query(`INSERT INTO users (id, name, email) VALUES ($1, '', 'owner@example.com')`, [
    OWNER,
  ])
  await client.query(
    `INSERT INTO agents (id, project_id, external_id, name) VALUES ($1, $2, 'bot', 'Bot')`,
    [AGENT, PROJECT],
  )
  await client.query(
    `INSERT INTO agent_keys (id, agent_id, public_key, valid_from, valid_to, rotation_kind)
     VALUES ($1, $2, $3, $4, $5, 'initial')`,
    [INITIAL, AGENT, previousKey, EFFECTIVE_AT - 1_000, EFFECTIVE_AT],
  )
}, 60_000)

afterAll(async () => {
  await client?.close()
})

beforeEach(async () => {
  await client.query('DELETE FROM decisions')
  await client.query(`DELETE FROM agent_keys WHERE rotation_kind <> 'initial'`)
})

describe('publishPending: key rotation anchors (T068)', () => {
  it('anchors a chained rotation with the proof the previous key made', async () => {
    await seedRotation('chained')
    const { chain, sent } = recordingChain()

    const published = await publishPending(db, chain, config)
    const row = await readKey()
    const anchor = decodeKeyRotationAnchor(memoOf(sent[0] ?? new Uint8Array()))

    expect(published).toBe(1)
    expect(row.anchor_status).toBe('anchored')
    expect(row.anchor_slot).toBe(500)
    expect(row.anchor_signature).toBe(
      toBase58(Transaction.from(sent[0] ?? new Uint8Array()).signature ?? new Uint8Array()),
    )
    expect(anchor).toEqual({
      version: 1,
      kind: ANCHOR_KIND.keyRotation,
      newPubkey: nextKey,
      prevPubkey: previousKey,
      rotationKind: ROTATION_KIND.chained,
      effectiveAt: EFFECTIVE_AT,
      signature: PROOF,
    })
  })

  it('anchors an administrative replacement with a zero signature and no stored proof', async () => {
    await seedRotation('administrative')
    const { chain, sent } = recordingChain()

    await publishPending(db, chain, config)
    const anchor = decodeKeyRotationAnchor(memoOf(sent[0] ?? new Uint8Array()))
    const row = await readKey()

    expect(anchor.rotationKind).toBe(ROTATION_KIND.administrative)
    expect(anchor.signature).toBe(ADMINISTRATIVE_ROTATION_SIGNATURE)
    // The guarantee is the transaction's own signature, and the payer is its
    // fee payer: that is what the verifier will read (format §10.2).
    expect(
      Transaction.from(sent[0] ?? new Uint8Array()).feePayer?.equals(config.payer.publicKey),
    ).toBe(true)
    expect(row.anchor_status).toBe('anchored')
    expect(row.rotation_proof).toBeNull()
  })

  it('names both keys among the transaction accounts', async () => {
    await seedRotation('chained')
    const { chain, sent } = recordingChain()

    await publishPending(db, chain, config)
    const keys = Transaction.from(sent[0] ?? new Uint8Array())
      .compileMessage()
      .accountKeys.map((one) => one.toBase58())

    expect(keys).toContain(new PublicKey(Buffer.from(previousKey, 'hex')).toBase58())
    expect(keys).toContain(new PublicKey(Buffer.from(nextKey, 'hex')).toBase58())
  })

  it('stores the signature before the transaction is sent', async () => {
    await seedRotation('chained')
    let seenDuringSend: string | null = null

    await publishPending(
      db,
      fakeChain({
        sendRawTransaction: async () => {
          seenDuringSend = (await readKey()).anchor_signature
          return 'sent'
        },
      }),
      config,
    )

    expect(seenDuringSend).not.toBeNull()
  })

  it('confirms an already sent rotation instead of sending a second anchor', async () => {
    await seedRotation('chained', { anchorSignature: 'sent-before-the-crash' })
    const { chain, sent } = recordingChain()

    const published = await publishPending(db, chain, config)

    expect(sent).toHaveLength(0)
    expect(published).toBe(1)
    expect((await readKey()).anchor_signature).toBe('sent-before-the-crash')
  })

  it('never publishes an initial key: nobody rotated it', async () => {
    const { chain, sent } = recordingChain()

    expect(await publishPending(db, chain, config)).toBe(0)
    expect(sent).toHaveLength(0)
    expect((await readKey(INITIAL)).anchor_status).toBeNull()
  })

  it('backs off after a rejected rotation and gives up at the attempt ceiling', async () => {
    await seedRotation('chained', { attempts: ATTEMPT_CEILING - 2 })
    const rejecting = fakeChain({
      getSignatureStatuses: async (signatures) => ({
        value: signatures.map(() => ({ slot: 500, confirmationStatus: 'processed', err: 'boom' })),
      }),
    })

    await publishPending(db, rejecting, config)
    const retried = await readKey()
    expect(retried.anchor_status).toBe('pending')
    expect(retried.attempts).toBe(ATTEMPT_CEILING - 1)
    expect(retried.anchor_signature).toBeNull()

    await client.query("UPDATE agent_keys SET next_attempt_at = now() - interval '1 second'")
    await publishPending(db, rejecting, config)
    const failed = await readKey()
    expect(failed.anchor_status).toBe('failed')
    expect(failed.attempts).toBe(ATTEMPT_CEILING)
  })

  it('defers a rotation without counting an attempt when the network is too expensive', async () => {
    await seedRotation('chained')
    const { chain, sent } = recordingChain({
      getRecentPrioritizationFees: async () => [{ prioritizationFee: 1_000_000 }],
    })

    await publishPending(db, chain, config)
    const row = await readKey()

    expect(sent).toHaveLength(0)
    expect(row.anchor_status).toBe('pending')
    expect(row.attempts).toBe(0)
  })

  it('leaves a rotation whose backoff has not elapsed alone', async () => {
    await seedRotation('chained', { nextAttemptAt: new Date(Date.now() + 60_000).toISOString() })
    const { chain, sent } = recordingChain()

    await publishPending(db, chain, config)

    expect(sent).toHaveLength(0)
  })
})

describe('rotations and decisions share the pass', () => {
  it('sends the rotation first, on one blockhash, one fee sample and one status poll', async () => {
    await seedRotation('chained')
    await seedDecision(ROTATED)
    let blockhashCalls = 0
    let feeCalls = 0
    const polled: number[] = []
    const { chain, sent } = recordingChain({
      getLatestBlockhash: async () => {
        blockhashCalls += 1
        return { blockhash: '11111111111111111111111111111111' }
      },
      getRecentPrioritizationFees: async () => {
        feeCalls += 1
        return [{ prioritizationFee: 0 }]
      },
      getSignatureStatuses: async (signatures) => {
        polled.push(signatures.length)
        return {
          value: signatures.map(() => ({ slot: 500, confirmationStatus: 'confirmed', err: null })),
        }
      },
    })

    const published = await publishPending(db, chain, config)

    expect(published).toBe(2)
    expect(sent.map((raw) => anchorKindOf(memoOf(raw)))).toEqual([
      ANCHOR_KIND.keyRotation,
      ANCHOR_KIND.decision,
    ])
    expect(blockhashCalls).toBe(1)
    expect(feeCalls).toBe(1)
    expect(polled).toEqual([2])
  })

  it('does not hold back a decision of the new key while its rotation is still pending', async () => {
    await seedRotation('chained', { nextAttemptAt: new Date(Date.now() + 60_000).toISOString() })
    await seedDecision(ROTATED)
    const { chain, sent } = recordingChain()

    expect(await publishPending(db, chain, config)).toBe(1)
    expect(sent.map((raw) => anchorKindOf(memoOf(raw)))).toEqual([ANCHOR_KIND.decision])
    expect((await readKey()).anchor_status).toBe('pending')
  })
})
