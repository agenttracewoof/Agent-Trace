import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AgentKeyPair,
  generateAgentKey,
  type SignedManifest,
  signManifest,
} from '@agenttrace/manifest'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openDecisionBuffer } from './buffer.js'
import { buildManifest, type RedactionPolicy } from './pipeline.js'

const POLICY: RedactionPolicy = { stepInput: ['query'], stepOutput: [], outcome: ['approved'] }

let key: AgentKeyPair
let directory: string

beforeAll(async () => {
  key = await generateAgentKey()
})

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agenttrace-buffer-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function envelope(index: number, decidedAt: number): Promise<SignedManifest> {
  const manifest = await buildManifest(
    {
      agentPubkey: key.publicKey,
      decisionId: index.toString(16).padStart(32, '0'),
      model: 'claude-opus-5',
      sources: ['https://quotes.example/1'],
      decidedAt,
      outcome: { approved: true },
      steps: [{ type: 'retrieval', private: false, input: { query: 'q' }, output: {} }],
    },
    POLICY,
  )
  return signManifest(manifest, key)
}

function collector() {
  const seen: SignedManifest[] = []
  return {
    seen,
    send: async (item: SignedManifest) => {
      seen.push(item)
    },
  }
}

describe('openDecisionBuffer', () => {
  it('holds a decision the network could not take yet', async () => {
    const buffer = openDecisionBuffer(directory)

    await buffer.append(await envelope(1, 1_760_000_000_000))

    expect(await buffer.pending()).toBe(1)
  })

  it('delivers what it holds and keeps nothing behind', async () => {
    const buffer = openDecisionBuffer(directory)
    const sink = collector()
    const item = await envelope(1, 1_760_000_000_000)

    await buffer.append(item)
    const summary = await buffer.flush(sink.send)

    expect(summary).toEqual({ sent: 1, pending: 0 })
    expect(sink.seen).toEqual([item])
    expect(await buffer.pending()).toBe(0)
  })

  it('delivers the decision exactly as it was signed', async () => {
    const buffer = openDecisionBuffer(directory)
    const sink = collector()
    const item = await envelope(1, 1_759_000_000_001)

    await buffer.append(item)
    await buffer.flush(sink.send)

    expect(sink.seen[0]).toEqual(item)
    expect(sink.seen[0]?.manifest.decidedAt).toBe(1_759_000_000_001)
    expect(sink.seen[0]?.signature).toBe(item.signature)
  })

  it('delivers the oldest decision first, whatever order it was buffered in', async () => {
    const buffer = openDecisionBuffer(directory)
    const sink = collector()

    await buffer.append(await envelope(2, 1_760_000_000_200))
    await buffer.append(await envelope(1, 1_760_000_000_100))
    await buffer.append(await envelope(3, 1_760_000_000_300))
    await buffer.flush(sink.send)

    expect(sink.seen.map((item) => item.manifest.decidedAt)).toEqual([
      1_760_000_000_100, 1_760_000_000_200, 1_760_000_000_300,
    ])
  })

  it('stops at the first refusal and keeps the rest', async () => {
    const buffer = openDecisionBuffer(directory)
    let calls = 0

    await buffer.append(await envelope(1, 1_760_000_000_100))
    await buffer.append(await envelope(2, 1_760_000_000_200))
    await buffer.append(await envelope(3, 1_760_000_000_300))

    const summary = await buffer.flush(async () => {
      calls += 1
      if (calls === 2) throw new Error('ECONNREFUSED')
    })

    expect(summary.sent).toBe(1)
    expect(summary.pending).toBe(2)
    expect(summary.stoppedBy?.message).toBe('ECONNREFUSED')
    expect(await buffer.pending()).toBe(2)
  })

  it('delivers the rest once the network is back', async () => {
    const buffer = openDecisionBuffer(directory)
    const sink = collector()

    await buffer.append(await envelope(1, 1_760_000_000_100))
    await buffer.append(await envelope(2, 1_760_000_000_200))
    await buffer.flush(async () => {
      throw new Error('ECONNREFUSED')
    })
    const summary = await buffer.flush(sink.send)

    expect(summary).toEqual({ sent: 2, pending: 0 })
    expect(sink.seen.map((item) => item.manifest.decidedAt)).toEqual([
      1_760_000_000_100, 1_760_000_000_200,
    ])
  })

  it('survives a restart of the agent', async () => {
    await openDecisionBuffer(directory).append(await envelope(1, 1_760_000_000_100))

    const afterRestart = openDecisionBuffer(directory)
    const sink = collector()

    expect(await afterRestart.pending()).toBe(1)
    expect((await afterRestart.flush(sink.send)).sent).toBe(1)
  })

  it('holds nothing before the first decision is buffered', async () => {
    const buffer = openDecisionBuffer(join(directory, 'not-yet'))
    const sink = collector()

    expect(await buffer.pending()).toBe(0)
    expect(await buffer.flush(sink.send)).toEqual({ sent: 0, pending: 0 })
  })

  it('keeps one entry per decision, however often it is buffered', async () => {
    const buffer = openDecisionBuffer(directory)
    const item = await envelope(1, 1_760_000_000_100)

    await buffer.append(item)
    await buffer.append(item)

    expect(await buffer.pending()).toBe(1)
    expect(await readdir(directory)).toHaveLength(1)
  })

  it('refuses to guess what an unreadable entry was', async () => {
    const buffer = openDecisionBuffer(directory)
    await buffer.append(await envelope(1, 1_760_000_000_100))
    const [name] = await readdir(directory)
    await writeFile(join(directory, name ?? ''), 'not json', 'utf8')

    await expect(buffer.flush(collector().send)).rejects.toThrow(/buffer/)
  })
})
