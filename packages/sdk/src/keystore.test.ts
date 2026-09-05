import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateAgentKey, signManifest, toHex, verifySignedManifest } from '@agenttrace/manifest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KEYSTORE_VERSION, loadOrCreateAgentKey } from './keystore.js'
import { buildManifest, type RedactionPolicy } from './pipeline.js'

const POLICY: RedactionPolicy = { stepInput: ['query'], stepOutput: [], outcome: ['decision'] }

let directory: string
let keyPath: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agenttrace-keystore-'))
  keyPath = join(directory, 'agent.key')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function stored(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

async function rejection(path: string): Promise<string> {
  try {
    await loadOrCreateAgentKey(path)
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }
  throw new Error('expected loadOrCreateAgentKey to reject')
}

describe('loadOrCreateAgentKey', () => {
  it('creates a pair on the first run', async () => {
    const key = await loadOrCreateAgentKey(keyPath)

    expect(key.publicKey).toMatch(/^[0-9a-f]{64}$/)
    expect(key.privateKey.byteLength).toBeGreaterThan(0)
    expect(await stored(keyPath)).toEqual({
      version: KEYSTORE_VERSION,
      publicKey: key.publicKey,
      privateKey: toHex(key.privateKey),
    })
  })

  it('returns the same identity on every later run', async () => {
    const first = await loadOrCreateAgentKey(keyPath)
    const second = await loadOrCreateAgentKey(keyPath)

    expect(second.publicKey).toBe(first.publicKey)
    expect(second.privateKey).toEqual(first.privateKey)
  })

  it('settles on one identity when several runs start at once', async () => {
    const keys = await Promise.all([
      loadOrCreateAgentKey(keyPath),
      loadOrCreateAgentKey(keyPath),
      loadOrCreateAgentKey(keyPath),
    ])

    expect(new Set(keys.map((key) => key.publicKey)).size).toBe(1)
    expect(await stored(keyPath)).toMatchObject({ publicKey: keys[0]?.publicKey })
  })

  it('creates the directory the key lives in', async () => {
    const nested = join(directory, 'state', 'agenttrace', 'agent.key')

    await expect(loadOrCreateAgentKey(nested)).resolves.toBeDefined()
  })

  it.skipIf(process.platform === 'win32')('creates a file its owner alone can read', async () => {
    await loadOrCreateAgentKey(keyPath)

    expect((await stat(keyPath)).mode & 0o777).toBe(0o600)
  })

  it('signs a manifest that verifies under the stored public key', async () => {
    const key = await loadOrCreateAgentKey(keyPath)
    const manifest = await buildManifest(
      {
        agentPubkey: key.publicKey,
        decisionId: 'b'.repeat(32),
        model: 'claude-opus-5',
        sources: ['https://quotes.example/1'],
        decidedAt: 1_760_000_000_000,
        outcome: { decision: 'approve' },
        steps: [{ type: 'retrieval', private: false, input: { query: 'q' }, output: {} }],
      },
      POLICY,
    )

    expect(await verifySignedManifest(await signManifest(manifest, key))).toBe(true)
  })

  it('rejects a keystore that is not this format', async () => {
    await writeFile(keyPath, '{"version":99}', 'utf8')

    expect(await rejection(keyPath)).toMatch(/keystore/)
  })

  it('rejects a public key that does not belong to the stored private key', async () => {
    const [mine, other] = await Promise.all([generateAgentKey(), generateAgentKey()])
    const file = {
      version: KEYSTORE_VERSION,
      publicKey: other.publicKey,
      privateKey: toHex(mine.privateKey),
    }
    await writeFile(keyPath, JSON.stringify(file), 'utf8')

    expect(await rejection(keyPath)).toMatch(/does not belong/)
  })

  it('never puts key material into the error it throws', async () => {
    const material = toHex((await generateAgentKey()).privateKey)

    await writeFile(keyPath, JSON.stringify({ version: 99, privateKey: material }), 'utf8')
    expect(await rejection(keyPath)).not.toContain(material)

    await writeFile(keyPath, `${material}}}`, 'utf8')
    expect(await rejection(keyPath)).not.toContain(material)
  })
})
