import {
  generateAgentKey,
  hashValue,
  MANIFEST_VERSION,
  type Manifest,
  redact,
  signManifest,
  stepsRoot,
  toHex,
  verifySignedManifest,
} from '@agenttrace/manifest'
import { describe, expect, it } from 'vitest'
import { buildManifest, type RedactionPolicy } from './pipeline.js'

const POLICY: RedactionPolicy = {
  stepInput: ['query', 'sources.*.url'],
  stepOutput: ['summary', 'score'],
  outcome: ['decision', 'confidence'],
}

const AGENT_PUBKEY = 'a'.repeat(64)
const DECISION_ID = 'b'.repeat(32)

const RAW_INPUT = {
  query: 'is the quote fresh',
  apiKey: 'sk-live-51HQwErTyUiOpAsDfGhJkLz',
  sources: [{ url: 'https://quotes.example/1', credential: 'sk-live-51HZxCvBnM' }],
}

const RAW_OUTPUT = { summary: 'fresh', score: 0.91, prompt: 'bearer eyJhbGciOiJIUzI1NiJ9.token' }

const RAW_OUTCOME = {
  decision: 'approve',
  confidence: 0.9,
  wallet: { seed: 'abandon abandon ability able about above absent absorb' },
}

function draft(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentPubkey: AGENT_PUBKEY,
    decisionId: DECISION_ID,
    model: 'claude-opus-5',
    sources: ['https://quotes.example/1'],
    decidedAt: 1_760_000_000_000,
    outcome: RAW_OUTCOME,
    steps: [{ type: 'retrieval', private: false, input: RAW_INPUT, output: RAW_OUTPUT }],
    ...patch,
  }
}

function publicStep(manifest: Manifest, index: number) {
  const step = manifest.steps[index]
  if (step === undefined || step.private) throw new Error(`no public step at ${index}`)
  return step
}

describe('buildManifest', () => {
  it('publishes only the fields the policy names', async () => {
    const manifest = await buildManifest(draft(), POLICY)
    const step = publicStep(manifest, 0)

    expect(step.input).toEqual({
      query: 'is the quote fresh',
      sources: [{ url: 'https://quotes.example/1' }],
    })
    expect(step.output).toEqual({ summary: 'fresh', score: 0.91 })
    expect(manifest.outcome).toEqual({ decision: 'approve', confidence: 0.9 })
  })

  it('carries the fields the format needs unchanged', async () => {
    const manifest = await buildManifest(draft(), POLICY)

    expect(manifest.version).toBe(MANIFEST_VERSION)
    expect(manifest.agentPubkey).toBe(AGENT_PUBKEY)
    expect(manifest.decisionId).toBe(DECISION_ID)
    expect(manifest.model).toBe('claude-opus-5')
    expect(manifest.sources).toEqual(['https://quotes.example/1'])
    expect(manifest.decidedAt).toBe(1_760_000_000_000)
  })

  it('hashes the redacted value, not the raw one', async () => {
    const step = publicStep(await buildManifest(draft(), POLICY), 0)

    expect(step.inputHash).toBe(toHex(await hashValue(step.input)))
    expect(step.outputHash).toBe(toHex(await hashValue(step.output)))
    expect(step.inputHash).not.toBe(toHex(await hashValue(RAW_INPUT)))
    expect(step.outputHash).not.toBe(toHex(await hashValue(RAW_OUTPUT)))
  })

  it('roots the tree in the redacted steps', async () => {
    const manifest = await buildManifest(draft(), POLICY)

    expect(manifest.root).toBe(toHex(await stepsRoot(manifest.steps)))
  })

  it('publishes a private step as type and hashes only', async () => {
    const manifest = await buildManifest(
      draft({
        steps: [{ type: 'reasoning', private: true, input: RAW_INPUT, output: RAW_OUTPUT }],
      }),
      POLICY,
    )

    expect(manifest.steps[0]).toEqual({
      type: 'reasoning',
      private: true,
      inputHash: expect.any(String),
      outputHash: expect.any(String),
    })
  })

  it('hashes a private step over the redacted value too', async () => {
    const manifest = await buildManifest(
      draft({
        steps: [{ type: 'reasoning', private: true, input: RAW_INPUT, output: RAW_OUTPUT }],
      }),
      POLICY,
    )

    expect(manifest.steps[0]?.inputHash).toBe(
      toHex(await hashValue(redact(RAW_INPUT, POLICY.stepInput))),
    )
    expect(manifest.steps[0]?.inputHash).not.toBe(toHex(await hashValue(RAW_INPUT)))
  })

  it('publishes a fully dropped value as null, not as an absent field', async () => {
    const manifest = await buildManifest(draft(), { stepInput: [], stepOutput: [], outcome: [] })
    const step = publicStep(manifest, 0)

    expect(step.input).toBeNull()
    expect(step.output).toBeNull()
    expect(manifest.outcome).toBeNull()
  })

  it('produces a manifest the signing path accepts', async () => {
    const key = await generateAgentKey()
    const manifest = await buildManifest(draft({ agentPubkey: key.publicKey }), POLICY)

    expect(await verifySignedManifest(await signManifest(manifest, key))).toBe(true)
  })

  it('rejects a draft the format cannot carry', async () => {
    await expect(buildManifest(draft({ agentPubkey: 'not-hex' }), POLICY)).rejects.toThrow()
    await expect(buildManifest(draft({ steps: [] }), POLICY)).rejects.toThrow()
    await expect(buildManifest(draft({ root: 'c'.repeat(64) }), POLICY)).rejects.toThrow()
    await expect(
      buildManifest(draft({ steps: [{ type: 'retrieval', private: false, input: 1 }] }), POLICY),
    ).rejects.toThrow()
  })

  it('rejects a value with no canonical form instead of silently dropping it', async () => {
    const steps = [{ type: 'retrieval', private: false, input: { at: new Date(0) }, output: {} }]

    await expect(buildManifest(draft({ steps }), POLICY)).rejects.toThrow()
  })

  it('rejects a malformed allow rule', async () => {
    await expect(
      buildManifest(draft(), { stepInput: ['a..b'], stepOutput: [], outcome: [] }),
    ).rejects.toThrow(/malformed/)
  })
})

const SECRET_SHAPES: readonly ((n: number) => string)[] = [
  (n) => `sk-live-51H${n}QwErTyUiOpAsDfGhJkLzXcVbN`,
  (n) => `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIke${n}fSJ9.s3cr3t-s1gn4tur3`,
  (n) => `postgres://svc:p4ssw0rd-${n}@db.internal:5432/prod`,
  (n) => `3vQB7B6MrGQZaxCuFg4oh${n}KWi4L1RhLLbEDkkK9ExhAWvXvKxwFDFqbLXBMpLQ`,
  (n) => `abandon abandon ability able about above absent absorb ${n}`,
]

function pick<T>(items: readonly T[], index: number): T {
  const item = items[index % items.length]
  if (item === undefined) throw new Error('pick: empty list')
  return item
}

interface Carrier {
  readonly patch: Record<string, unknown>
  readonly published: readonly string[]
}

interface Fixture {
  readonly draft: Record<string, unknown>
  readonly secret: string
  readonly published: readonly string[]
}

/**
 * Секрет кладеться в кожне місце, куди рішення приносить вільні дані: вхід
 * кроку, вихід кроку, результат — і в публічний крок, і в приватний. Місце, до
 * якого фікстури не дістають, редакція б не покривала, а тест мовчав би.
 */
function carriers(index: number, secret: string): readonly Carrier[] {
  const query = `is quote ${index} fresh`
  const url = `https://quotes.example/${index}`

  return [
    {
      patch: {
        steps: [
          { type: 'retrieval', private: false, input: { query, apiKey: secret }, output: {} },
        ],
      },
      published: [query],
    },
    {
      patch: {
        steps: [
          {
            type: 'retrieval',
            private: false,
            input: { query, sources: [{ url, credential: secret }] },
            output: {},
          },
        ],
      },
      published: [query, url],
    },
    {
      patch: {
        steps: [
          {
            type: 'model-call',
            private: false,
            input: { query },
            output: { summary: 'fresh', headers: { authorization: secret } },
          },
        ],
      },
      published: [query, 'fresh'],
    },
    {
      patch: {
        steps: [{ type: 'reasoning', private: true, input: { query, token: secret }, output: {} }],
        outcome: { decision: 'approve', credentials: { [secret]: 'used' } },
      },
      published: ['approve'],
    },
    {
      patch: {
        steps: [{ type: 'retrieval', private: false, input: { query }, output: {} }],
        outcome: { decision: 'approve', trace: { call: { retry: { attempt: 2, key: secret } } } },
      },
      published: [query, 'approve'],
    },
  ]
}

function makeFixture(index: number): Fixture {
  const secret = pick(SECRET_SHAPES, index)(index)
  const carrier = pick(carriers(index, secret), index)

  return {
    draft: draft({ decisionId: index.toString(16).padStart(32, '0'), ...carrier.patch }),
    secret,
    published: carrier.published,
  }
}

describe('buildManifest — SC-006', () => {
  const fixtures = Array.from({ length: 200 }, (_, index) => makeFixture(index))
  const wire = () =>
    Promise.all(
      fixtures.map(async (fixture) => JSON.stringify(await buildManifest(fixture.draft, POLICY))),
    )

  it('publishes zero secrets across 200 decisions carrying secrets in their input', async () => {
    const published = await wire()
    const leaked = fixtures.filter((fixture, index) =>
      pick(published, index).includes(fixture.secret),
    )

    expect(leaked).toHaveLength(0)
  })

  it('still publishes the allowed fields of all 200 — silence would pass SC-006 too', async () => {
    const published = await wire()
    const lost = fixtures.filter((fixture, index) =>
      fixture.published.some((value) => !pick(published, index).includes(value)),
    )

    expect(lost).toHaveLength(0)
  })
})
