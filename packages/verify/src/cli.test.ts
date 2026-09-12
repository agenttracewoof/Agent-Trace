import {
  type AgentKeyPair,
  ANCHOR_KIND,
  encodeAnchorMemo,
  encodeDecisionAnchor,
  generateAgentKey,
  hashValue,
  MANIFEST_VERSION,
  type Manifest,
  type ManifestStep,
  type SignedManifest,
  signManifest,
  stepsRoot,
  toHex,
} from '@agenttrace/manifest'
import { PublicKey } from '@solana/web3.js'
import { beforeAll, describe, expect, it } from 'vitest'
import { type CliDeps, EXIT_CODE, EXIT_TOOL_FAILURE, redactEndpoint, run } from './cli.js'
import { type ChainSource, MEMO_PROGRAM_ID, type TransactionLike } from './sources.js'
import type { VerificationStatus } from './verify.js'

const RPC = 'https://devnet.helius-rpc.com/?api-key=secret-key'
const MANIFEST_URL = 'https://storage.example/decisions/1.json'

let key: AgentKeyPair
let envelope: SignedManifest
let anchorMemo: string

async function publicStep(type: string, input: unknown, output: unknown): Promise<ManifestStep> {
  const [inputHash, outputHash] = await Promise.all([hashValue(input), hashValue(output)])
  return {
    type,
    private: false,
    input: input as Extract<ManifestStep, { private: false }>['input'],
    output: output as Extract<ManifestStep, { private: false }>['output'],
    inputHash: toHex(inputHash),
    outputHash: toHex(outputHash),
  }
}

async function manifestOf(pair: AgentKeyPair): Promise<Manifest> {
  const steps = await Promise.all([
    publicStep('source.read', { url: 'https://quotes.example/1' }, { price: 180 }),
    publicStep('tool.call', { pair: 'SOL/USDC' }, { filled: true }),
  ])
  return {
    version: MANIFEST_VERSION,
    agentPubkey: pair.publicKey,
    decisionId: '0123456789abcdeffedcba9876543210',
    model: 'claude-opus-5',
    sources: ['https://quotes.example/1'],
    root: toHex(await stepsRoot(steps)),
    decidedAt: 1_760_000_000_000,
    outcome: { action: 'swap' },
    steps,
  }
}

const memoOf = (signed: SignedManifest): string =>
  encodeAnchorMemo(
    encodeDecisionAnchor({
      version: MANIFEST_VERSION,
      kind: ANCHOR_KIND.decision,
      agentPubkey: signed.manifest.agentPubkey,
      root: signed.manifest.root,
      decisionId: signed.manifest.decisionId,
      decidedAt: signed.manifest.decidedAt,
      signature: signed.signature,
    }),
  )

beforeAll(async () => {
  key = await generateAgentKey()
  envelope = await signManifest(await manifestOf(key), key)
  anchorMemo = memoOf(envelope)
})

function transactionWith(memo: string): TransactionLike {
  return {
    slot: 483_807_397,
    meta: { err: null },
    transaction: {
      message: {
        staticAccountKeys: [new PublicKey(Buffer.from(key.publicKey, 'hex')), MEMO_PROGRAM_ID],
        compiledInstructions: [{ programIdIndex: 1, data: new TextEncoder().encode(memo) }],
      },
    },
  }
}

const chainWithAnchor = (): ChainSource => ({
  getSignaturesForAddress: async () => [{ signature: 'sig', err: null }],
  getTransaction: async () => transactionWith(anchorMemo),
})

const emptyChain = (): ChainSource => ({
  getSignaturesForAddress: async () => [],
  getTransaction: async () => null,
})

function depsWith(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    chain: () => chainWithAnchor(),
    fetch: async () => new Response(JSON.stringify(envelope), { status: 200 }),
    readFile: async () => {
      throw new Error('ENOENT')
    },
    env: {},
    ...overrides,
  }
}

const args = (...extra: string[]): string[] => [
  '--agent',
  key.publicKey,
  '--decision',
  envelope.manifest.decisionId,
  '--manifest',
  MANIFEST_URL,
  '--rpc',
  RPC,
  ...extra,
]

describe('arguments', () => {
  it('prints usage and succeeds on --help', async () => {
    const outcome = await run(['--help'], depsWith())

    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toContain('agenttrace-verify')
    expect(outcome.stderr).toBe('')
  })

  it.each([
    ['--agent', ['--decision', 'ab'.repeat(16), '--manifest', MANIFEST_URL, '--rpc', RPC]],
    ['--decision', ['--agent', 'ab'.repeat(32), '--manifest', MANIFEST_URL, '--rpc', RPC]],
    ['--manifest', ['--agent', 'ab'.repeat(32), '--decision', 'ab'.repeat(16), '--rpc', RPC]],
  ])('refuses to run without %s', async (missing, given) => {
    const outcome = await run(given, depsWith())

    expect(outcome.code).toBe(EXIT_TOOL_FAILURE)
    expect(outcome.stderr).toContain(`${missing} is required`)
    expect(outcome.stdout).toBe('')
  })

  it.each([
    ['ABCD', '--agent must be 64'],
    ['ab'.repeat(31), '--agent must be 64'],
  ])('refuses an agent key that is not 32 bytes of hex (%s)', async (value, expected) => {
    const outcome = await run(
      ['--agent', value, '--decision', 'ab'.repeat(16), '--manifest', MANIFEST_URL, '--rpc', RPC],
      depsWith(),
    )

    expect(outcome.code).toBe(EXIT_TOOL_FAILURE)
    expect(outcome.stderr).toContain(expected)
  })

  it('refuses a decision id that is not 16 bytes of hex', async () => {
    const outcome = await run(
      ['--agent', 'ab'.repeat(32), '--decision', 'nope', '--manifest', MANIFEST_URL, '--rpc', RPC],
      depsWith(),
    )

    expect(outcome.code).toBe(EXIT_TOOL_FAILURE)
    expect(outcome.stderr).toContain('--decision must be 32')
  })

  it('refuses an option it does not know instead of ignoring it', async () => {
    // Мовчазне ігнорування означало б, що `--api https://…` виглядає прийнятим.
    const outcome = await run([...args(), '--api', 'https://example'], depsWith())

    expect(outcome.code).toBe(EXIT_TOOL_FAILURE)
    expect(outcome.stderr).toContain('unknown option --api')
  })

  it('takes the rpc endpoint from the environment when the flag is absent', async () => {
    const outcome = await run(
      [
        '--agent',
        key.publicKey,
        '--decision',
        envelope.manifest.decisionId,
        '--manifest',
        MANIFEST_URL,
      ],
      depsWith({ env: { SOLANA_RPC_URL: RPC } }),
    )

    expect(outcome.code).toBe(EXIT_CODE.verified)
  })

  it('has no built-in rpc endpoint: without one it refuses to guess a cluster', async () => {
    const outcome = await run(
      [
        '--agent',
        key.publicKey,
        '--decision',
        envelope.manifest.decisionId,
        '--manifest',
        MANIFEST_URL,
      ],
      depsWith(),
    )

    expect(outcome.code).toBe(EXIT_TOOL_FAILURE)
    expect(outcome.stderr).toContain('--rpc is required')
  })

  it('accepts --flag=value as well as --flag value', async () => {
    const outcome = await run(
      [
        `--agent=${key.publicKey}`,
        `--decision=${envelope.manifest.decisionId}`,
        `--manifest=${MANIFEST_URL}`,
        `--rpc=${RPC}`,
      ],
      depsWith(),
    )

    expect(outcome.code).toBe(EXIT_CODE.verified)
  })

  it('rejects a --limit that is not a plain positive number', async () => {
    const outcome = await run([...args(), '--limit', '0'], depsWith())

    expect(outcome.code).toBe(EXIT_TOOL_FAILURE)
    expect(outcome.stderr).toContain('--limit must be')
  })

  it('asks the chain about the agent named in the arguments', async () => {
    /**
     * Ключ агента приходить аргументом, а не з конверта, який перевіряють:
     * інакше документ під перевіркою сам обирав би адресу, яка за нього
     * відповідає, і підроблений конверт вказав би на ланцюг, де його якір є.
     */
    const other = await generateAgentKey()
    let asked = ''
    const outcome = await run(
      [
        '--agent',
        other.publicKey,
        '--decision',
        envelope.manifest.decisionId,
        '--manifest',
        MANIFEST_URL,
        '--rpc',
        RPC,
      ],
      depsWith({
        chain: () => ({
          getSignaturesForAddress: async (address) => {
            asked = address.toBase58()
            return []
          },
          getTransaction: async () => null,
        }),
      }),
    )

    expect(asked).toBe(new PublicKey(Buffer.from(other.publicKey, 'hex')).toBase58())
    expect(outcome.code).toBe(EXIT_CODE.pending)
  })
})

describe('exit codes', () => {
  it('gives every verification state a code of its own', () => {
    // Скрипт на тисячу рішень розрізняє стани кодом, а не розбором тексту.
    const codes: Record<VerificationStatus, number> = EXIT_CODE
    expect(codes).toEqual({
      verified: 0,
      tampered: 2,
      pending: 3,
      unavailable: 4,
      'content-deleted': 5,
    })
    expect(new Set(Object.values(codes)).size).toBe(5)
    expect(Object.values(codes)).not.toContain(EXIT_TOOL_FAILURE)
  })

  it('exits 0 on a decision that matches its anchor', async () => {
    const outcome = await run(args(), depsWith())

    expect(outcome.code).toBe(0)
    expect(outcome.stdout.startsWith('verified\n')).toBe(true)
    expect(outcome.stdout).toContain(`root ${envelope.manifest.root}`)
  })

  it('exits 3 while the decision is sound but not anchored yet', async () => {
    const outcome = await run(args(), depsWith({ chain: () => emptyChain() }))

    expect(outcome.code).toBe(3)
    expect(outcome.stdout.startsWith('pending\n')).toBe(true)
    expect(outcome.stderr).toContain('no anchor for this decision in the last 100')
  })

  it('exits 4 when the envelope could not be read, and claims nothing else', async () => {
    const outcome = await run(
      args(),
      depsWith({ fetch: async () => new Response('', { status: 404 }) }),
    )

    expect(outcome.code).toBe(4)
    expect(outcome.stdout.startsWith('unavailable\n')).toBe(true)
    expect(outcome.stderr).toContain('never as deletion')
  })

  it('exits 1 — not 4 — when the rpc endpoint does not answer', async () => {
    /**
     * «Я не зміг спитати» і «запис не сходиться» — різні речі. Ланцюг, який
     * не відповів, нічого не каже про рішення, тож станом це бути не може.
     */
    const outcome = await run(
      args(),
      depsWith({
        chain: () => ({
          getSignaturesForAddress: async () => {
            throw new Error('fetch failed')
          },
          getTransaction: async () => null,
        }),
      }),
    )

    expect(outcome.code).toBe(EXIT_TOOL_FAILURE)
    expect(outcome.stderr).toContain('the check did not run: fetch failed')
    expect(outcome.stdout).toBe('')
  })
})

describe('tampered output', () => {
  it('prints every discrepancy, not the first', async () => {
    const forged = {
      ...envelope,
      manifest: { ...envelope.manifest, root: 'ff'.repeat(32), decidedAt: 1 },
    }
    const outcome = await run(
      args(),
      depsWith({ fetch: async () => new Response(JSON.stringify(forged), { status: 200 }) }),
    )

    expect(outcome.code).toBe(2)
    expect(outcome.stdout.startsWith('tampered\n')).toBe(true)
    expect(outcome.stdout).toContain('steps-root-mismatch')
    expect(outcome.stdout).toContain('signature-invalid')
    expect(outcome.stdout).toContain('anchor-root-mismatch')
    expect(outcome.stdout).toContain('anchor-time-mismatch')
    expect(outcome.stdout).toMatch(/\n4 discrepancies\n/)
  })

  it('prints the inputs the verdict was computed from', async () => {
    // Вердикт, який неможливо повторити, неможливо й оскаржити.
    const outcome = await run(args(), depsWith())

    expect(outcome.stdout).toContain(key.publicKey)
    expect(outcome.stdout).toContain(envelope.manifest.decisionId)
    expect(outcome.stdout).toContain(MANIFEST_URL)
    expect(outcome.stdout).toContain('no AgentTrace service was asked anything.')
  })

  it('keeps the rpc api key out of everything it prints', async () => {
    const outcome = await run(args(), depsWith())

    expect(outcome.stdout).not.toContain('secret-key')
    expect(outcome.stdout).toContain('https://devnet.helius-rpc.com/?…')
  })

  it('says tampered on a document that is not an envelope, and hints why', async () => {
    /**
     * Найчастіша причина — адресу дали не ту: у відповіді публічного API конверт
     * лежить **усередині** поля. Стан від цього не пом'якшується (це була б друга
     * правда), але підказка називає причину, і вона не згадує жодного сервісу.
     */
    const wrapper = { decisionId: envelope.manifest.decisionId, signedManifest: envelope }
    const outcome = await run(
      args(),
      depsWith({ fetch: async () => new Response(JSON.stringify(wrapper), { status: 200 }) }),
    )

    expect(outcome.code).toBe(2)
    expect(outcome.stdout).toContain('manifest-malformed')
    expect(outcome.stderr).toContain('did not parse as a { manifest, signature }')
  })
})

describe('--json', () => {
  it('writes json and nothing else to stdout', async () => {
    const outcome = await run([...args(), '--json'], depsWith({ chain: () => emptyChain() }))
    const body: unknown = JSON.parse(outcome.stdout)

    expect(body).toMatchObject({
      status: 'pending',
      exitCode: 3,
      discrepancies: [],
      keyContinuity: 'self',
      request: { agentPubkey: key.publicKey, rpc: 'https://devnet.helius-rpc.com/?…' },
    })
    // Підказки живуть у stderr саме для цього: stdout лишається машинним.
    expect(outcome.stderr).not.toBe('')
  })

  it('carries the discrepancies a script would branch on', async () => {
    const forged = { ...envelope, signature: 'ab'.repeat(64) }
    const outcome = await run(
      [...args(), '--json'],
      depsWith({ fetch: async () => new Response(JSON.stringify(forged), { status: 200 }) }),
    )
    const body = JSON.parse(outcome.stdout) as {
      status: string
      discrepancies: { code: string }[]
    }

    expect(outcome.code).toBe(2)
    expect(body.status).toBe('tampered')
    expect(body.discrepancies.map((one) => one.code)).toContain('signature-invalid')
  })

  it('refuses --json with a value instead of silently taking it as an argument', async () => {
    const outcome = await run([...args(), '--json=yes'], depsWith())

    expect(outcome.code).toBe(EXIT_TOOL_FAILURE)
    expect(outcome.stderr).toContain('--json takes no value')
  })
})

describe('a local envelope', () => {
  it('verifies a file handed over by a person, with no storage involved', async () => {
    /**
     * Поки конверт ніхто не кладе у сховище власника (T055), це і є сценарій
     * демо: файл від людини плюс ланцюг. Незалежним тут лишається ланцюг —
     * і саме тому вивід друкує, звідки взято конверт.
     */
    const outcome = await run(
      [
        '--agent',
        key.publicKey,
        '--decision',
        envelope.manifest.decisionId,
        '--manifest',
        './envelope.json',
        '--rpc',
        RPC,
      ],
      depsWith({ readFile: async () => JSON.stringify(envelope) }),
    )

    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toContain('./envelope.json')
  })

  it('reports a missing file as unavailable, not as tampering', async () => {
    const outcome = await run(
      [
        '--agent',
        key.publicKey,
        '--decision',
        envelope.manifest.decisionId,
        '--manifest',
        './missing.json',
        '--rpc',
        RPC,
      ],
      depsWith(),
    )

    expect(outcome.code).toBe(4)
  })
})

describe('redactEndpoint', () => {
  it('keeps the host and path, drops the query', () => {
    expect(redactEndpoint('https://rpc.example/v1?api-key=abc')).toBe('https://rpc.example/v1?…')
  })

  it('leaves an endpoint without a query alone', () => {
    expect(redactEndpoint('https://api.devnet.solana.com')).toBe('https://api.devnet.solana.com')
  })

  it('does not throw on something that is not a url', () => {
    expect(redactEndpoint('not a url')).toBe('not a url')
  })
})
