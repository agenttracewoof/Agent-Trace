import {
  type AgentKeyPair,
  ANCHOR_KIND,
  encodeDecisionAnchor,
  encodeKeyRotationAnchor,
  generateAgentKey,
  hashValue,
  MANIFEST_VERSION,
  type Manifest,
  type ManifestStep,
  ROTATION_KIND,
  type SignedManifest,
  signManifest,
  stepsRoot,
  toHex,
} from '@agenttrace/manifest'
import { beforeAll, describe, expect, it } from 'vitest'
import { type DecisionEvidence, verifyDecision } from './verify.js'

type Json = Extract<ManifestStep, { private: false }>['input']

/** Зсуви полів якоря рішення — той самий layout, що в `manifest/src/anchor.ts`. */
const AT = {
  version: 0,
  kind: 1,
  agentPubkey: 2,
  root: 34,
  decisionId: 66,
  decidedAt: 82,
  signature: 90,
} as const

interface Fixture {
  readonly envelope: SignedManifest
  readonly anchor: Uint8Array
}

async function publicStep(type: string, input: Json, output: Json): Promise<ManifestStep> {
  const [inputHash, outputHash] = await Promise.all([hashValue(input), hashValue(output)])
  return {
    type,
    private: false,
    input,
    output,
    inputHash: toHex(inputHash),
    outputHash: toHex(outputHash),
  }
}

async function privateStep(type: string, input: Json, output: Json): Promise<ManifestStep> {
  const [inputHash, outputHash] = await Promise.all([hashValue(input), hashValue(output)])
  return { type, private: true, inputHash: toHex(inputHash), outputHash: toHex(outputHash) }
}

function anchorFor(envelope: SignedManifest): Uint8Array {
  const { manifest } = envelope
  return encodeDecisionAnchor({
    version: MANIFEST_VERSION,
    kind: ANCHOR_KIND.decision,
    agentPubkey: manifest.agentPubkey,
    root: manifest.root,
    decisionId: manifest.decisionId,
    decidedAt: manifest.decidedAt,
    signature: envelope.signature,
  })
}

async function makeManifest(seed: number, key: AgentKeyPair): Promise<Manifest> {
  const steps = await Promise.all([
    publicStep(
      'source.read',
      { url: `https://quotes.example/${seed}` },
      { price: 180 + seed / 64 },
    ),
    privateStep('model.call', { prompt: `should we swap on ${seed}?` }, { text: 'yes, swap' }),
    publicStep(
      'tool.call',
      { pair: 'SOL/USDC', size: seed },
      { filled: true, slot: 300_000 + seed },
    ),
  ])

  return {
    version: MANIFEST_VERSION,
    agentPubkey: key.publicKey,
    decisionId: seed.toString(16).padStart(32, '0'),
    model: 'claude-opus-5',
    sources: [`https://quotes.example/${seed}`, 'https://risk.example/limits'],
    root: toHex(await stepsRoot(steps)),
    decidedAt: 1_760_000_000_000 + seed,
    outcome: { action: 'swap', pair: 'SOL/USDC', size: seed },
    steps,
  }
}

async function makeDecision(seed: number, key: AgentKeyPair): Promise<Fixture> {
  const envelope = await signManifest(await makeManifest(seed, key), key)
  return { envelope, anchor: anchorFor(envelope) }
}

/* ── мутації ─────────────────────────────────────────────────────────────── */

type LooseStep = Record<string, unknown>
interface LooseEnvelope {
  manifest: Record<string, unknown>
  signature: string
}

/** Мутації навмисно ламають формат, тож типізовані вони бути й не можуть. */
function loosen(fixture: Fixture): LooseEnvelope {
  return structuredClone(fixture.envelope) as unknown as LooseEnvelope
}

function stepAt(envelope: LooseEnvelope, index: number): LooseStep {
  const step = (envelope.manifest.steps as LooseStep[])[index]
  if (step === undefined) throw new Error(`fixture has no step ${index}`)
  return step
}

function sourcesOf(envelope: LooseEnvelope): string[] {
  return envelope.manifest.sources as string[]
}

function outcomeOf(envelope: LooseEnvelope): Record<string, unknown> {
  return envelope.manifest.outcome as Record<string, unknown>
}

function flipByte(bytes: Uint8Array, at: number): Uint8Array {
  const copy = Uint8Array.from(bytes)
  const value = copy[at]
  if (value === undefined) throw new Error(`anchor has no byte ${at}`)
  copy[at] = value ^ 0xff
  return copy
}

function flipHex(hex: string): string {
  const head = hex.slice(0, 1) === '0' ? '1' : '0'
  return head + hex.slice(1)
}

interface Mutation {
  readonly name: string
  readonly apply: (fixture: Fixture, other: Fixture) => DecisionEvidence
}

/** Манифест зіпсовано, якір лишається чесним — і навпаки. */
const withAnchor = (envelope: LooseEnvelope, fixture: Fixture): DecisionEvidence => ({
  manifest: envelope,
  anchor: fixture.anchor,
})

const withManifest = (fixture: Fixture, anchor: Uint8Array): DecisionEvidence => ({
  manifest: fixture.envelope,
  anchor,
})

const mutations: readonly Mutation[] = [
  // Вміст публічних кроків: хеші лишаються старими, тобто ловить їх перерахунок.
  {
    name: 'step 0 input value changed',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      stepAt(envelope, 0).input = { url: 'https://quotes.example/attacker' }
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'step 0 output value changed',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      stepAt(envelope, 0).output = { price: 1 }
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'step 2 input value changed',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      stepAt(envelope, 2).input = { pair: 'SOL/USDT', size: 9 }
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'step 2 output value changed',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      stepAt(envelope, 2).output = { filled: false, slot: 0 }
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'step 0 input key renamed',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      const input = stepAt(envelope, 0).input as Record<string, unknown>
      stepAt(envelope, 0).input = { link: input.url }
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'step 2 output gains a field',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      const output = stepAt(envelope, 2).output as Record<string, unknown>
      output.fee = 0
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'step 0 output loses a field',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      stepAt(envelope, 0).output = {}
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'two public steps swap their content',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      const first = stepAt(envelope, 0)
      const third = stepAt(envelope, 2)
      const carried = { input: first.input, output: first.output }
      first.input = third.input
      first.output = third.output
      third.input = carried.input
      third.output = carried.output
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'step 0 input nudged in the last decimal',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      const output = stepAt(envelope, 0).output as Record<string, unknown>
      output.price = (output.price as number) + 0.000_000_1
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'step 0 type renamed',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      stepAt(envelope, 0).type = 'source.write'
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'step 2 type case changed',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      stepAt(envelope, 2).type = 'Tool.Call'
      return withAnchor(envelope, fixture)
    },
  },

  // Хеші й прапорець приватності.
  {
    name: 'step 0 inputHash flipped',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      const step = stepAt(envelope, 0)
      step.inputHash = flipHex(step.inputHash as string)
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'step 0 outputHash flipped',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      const step = stepAt(envelope, 0)
      step.outputHash = flipHex(step.outputHash as string)
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'private step inputHash flipped',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      const step = stepAt(envelope, 1)
      step.inputHash = flipHex(step.inputHash as string)
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'private step outputHash flipped',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      const step = stepAt(envelope, 1)
      step.outputHash = flipHex(step.outputHash as string)
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'private step type renamed',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      stepAt(envelope, 1).type = 'model.other'
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'private step revealed as public with invented content',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      const step = stepAt(envelope, 1)
      step.private = false
      step.input = { prompt: 'something harmless' }
      step.output = { text: 'something harmless' }
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'public step hidden as private after the fact',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      const step = stepAt(envelope, 0)
      step.private = true
      delete step.input
      delete step.output
      return withAnchor(envelope, fixture)
    },
  },

  // Структура рішення.
  {
    name: 'steps reordered',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      const steps = envelope.manifest.steps as LooseStep[]
      envelope.manifest.steps = [steps[2], steps[1], steps[0]]
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'a step removed',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      const steps = envelope.manifest.steps as LooseStep[]
      envelope.manifest.steps = [steps[0], steps[2]]
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'a step appended',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      const steps = envelope.manifest.steps as LooseStep[]
      envelope.manifest.steps = [...steps, structuredClone(stepAt(envelope, 0))]
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'steps emptied',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      envelope.manifest.steps = []
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'root flipped',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      envelope.manifest.root = flipHex(envelope.manifest.root as string)
      return withAnchor(envelope, fixture)
    },
  },

  // Поля рішення.
  {
    name: 'model changed',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      envelope.manifest.model = 'some-other-model'
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'first source changed',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      sourcesOf(envelope)[0] = 'https://quotes.example/other'
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'a source appended',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      envelope.manifest.sources = [...sourcesOf(envelope), 'https://invented.example/']
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'a source removed',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      envelope.manifest.sources = sourcesOf(envelope).slice(0, 1)
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'decidedAt moved by a millisecond',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      envelope.manifest.decidedAt = (envelope.manifest.decidedAt as number) + 1
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'outcome value changed',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      outcomeOf(envelope).action = 'hold'
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'outcome gains a field',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      outcomeOf(envelope).approvedBy = 'nobody'
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'outcome loses a field',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      delete outcomeOf(envelope).pair
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'decisionId changed',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      envelope.manifest.decisionId = 'ff'.repeat(16)
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'agentPubkey replaced with another agent',
    apply: (fixture, other) => {
      const envelope = loosen(fixture)
      envelope.manifest.agentPubkey = other.envelope.manifest.agentPubkey
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'format version bumped',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      envelope.manifest.version = MANIFEST_VERSION + 1
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'unknown field added to the manifest',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      envelope.manifest.reviewedBy = 'compliance'
      return withAnchor(envelope, fixture)
    },
  },

  // Конверт.
  {
    name: 'signature flipped',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      envelope.signature = flipHex(envelope.signature)
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'signature taken from another decision',
    apply: (fixture, other) => {
      const envelope = loosen(fixture)
      envelope.signature = other.envelope.signature
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'signature truncated',
    apply: (fixture) => {
      const envelope = loosen(fixture)
      envelope.signature = envelope.signature.slice(0, 100)
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'manifest swapped for another decision, signature kept',
    apply: (fixture, other) => {
      const envelope = loosen(fixture)
      envelope.manifest = structuredClone(other.envelope.manifest) as Record<string, unknown>
      return withAnchor(envelope, fixture)
    },
  },
  {
    name: 'unknown field added to the envelope',
    apply: (fixture) => {
      const envelope = loosen(fixture) as LooseEnvelope & { note?: string }
      envelope.note = 'verified by us, honest'
      return withAnchor(envelope, fixture)
    },
  },

  // Якір. Манифест тут чесний — розійтися має саме запис у ланцюгу.
  {
    name: 'anchor root flipped',
    apply: (fixture) => withManifest(fixture, flipByte(fixture.anchor, AT.root)),
  },
  {
    name: 'anchor decisionId flipped',
    apply: (fixture) => withManifest(fixture, flipByte(fixture.anchor, AT.decisionId)),
  },
  {
    name: 'anchor agentPubkey flipped',
    apply: (fixture) => withManifest(fixture, flipByte(fixture.anchor, AT.agentPubkey)),
  },
  {
    name: 'anchor decidedAt flipped',
    apply: (fixture) => withManifest(fixture, flipByte(fixture.anchor, AT.decidedAt + 7)),
  },
  {
    name: 'anchor signature flipped',
    apply: (fixture) => withManifest(fixture, flipByte(fixture.anchor, AT.signature)),
  },
  {
    name: 'anchor belongs to another decision',
    apply: (fixture, other) => withManifest(fixture, other.anchor),
  },
  {
    name: 'anchor truncated',
    apply: (fixture) => withManifest(fixture, fixture.anchor.subarray(0, 153)),
  },
  {
    name: 'anchor padded with a trailing byte',
    apply: (fixture) => {
      const padded = new Uint8Array(fixture.anchor.byteLength + 1)
      padded.set(fixture.anchor, 0)
      return withManifest(fixture, padded)
    },
  },
  {
    name: 'a key rotation anchor served as a decision anchor',
    apply: (fixture, other) =>
      withManifest(
        fixture,
        encodeKeyRotationAnchor({
          version: MANIFEST_VERSION,
          kind: ANCHOR_KIND.keyRotation,
          newPubkey: other.envelope.manifest.agentPubkey,
          prevPubkey: fixture.envelope.manifest.agentPubkey,
          rotationKind: ROTATION_KIND.chained,
          effectiveAt: fixture.envelope.manifest.decidedAt,
          signature: fixture.envelope.signature,
        }),
      ),
  },
  {
    name: 'anchor written in an unknown format version',
    apply: (fixture) => {
      const copy = Uint8Array.from(fixture.anchor)
      copy[AT.version] = MANIFEST_VERSION + 1
      return withManifest(fixture, copy)
    },
  },
]

/* ── тести ───────────────────────────────────────────────────────────────── */

describe('verifyDecision — стани за FR-013', () => {
  let key: AgentKeyPair
  let fixture: Fixture

  beforeAll(async () => {
    key = await generateAgentKey()
    fixture = await makeDecision(1, key)
  })

  it('confirms a decision whose manifest, root, signature and anchor all agree', async () => {
    const result = await verifyDecision({ manifest: fixture.envelope, anchor: fixture.anchor })
    expect(result.status).toBe('verified')
    expect(result.discrepancies).toEqual([])
    expect(result.caveats).toEqual([])
    expect(result.anchor?.root).toBe(fixture.envelope.manifest.root)
  })

  it('calls an unanchored decision pending, never verified', async () => {
    const result = await verifyDecision({ manifest: fixture.envelope })
    expect(result.status).toBe('pending')
    expect(result.discrepancies).toEqual([])
    expect(result.anchor).toBeUndefined()
  })

  it('reports a manifest the storage would not give as unavailable', async () => {
    const result = await verifyDecision({ anchor: fixture.anchor })
    expect(result.status).toBe('unavailable')
    expect(result.origin).toBeUndefined()
  })

  it('keeps the anchor as proof of existence when the owner deleted the content', async () => {
    const result = await verifyDecision({ absence: 'content-deleted', anchor: fixture.anchor })
    expect(result.status).toBe('content-deleted')
    // FR-024: вміст пішов, доказ того, що запис існував, лишається.
    expect(result.anchor?.decisionId).toBe(fixture.envelope.manifest.decisionId)
  })

  it('marks an archived manifest without weakening its integrity', async () => {
    const result = await verifyDecision({
      manifest: fixture.envelope,
      anchor: fixture.anchor,
      origin: 'archive',
    })
    expect(result.status).toBe('verified')
    expect(result.caveats).toEqual(['archived'])
    expect(result.origin).toBe('archive')
  })

  it('shows administrative key continuity as the weaker guarantee it is', async () => {
    const result = await verifyDecision({
      manifest: fixture.envelope,
      anchor: fixture.anchor,
      keyContinuity: 'administrative',
    })
    expect(result.status).toBe('verified')
    expect(result.caveats).toEqual(['administrative-key-continuity'])
  })

  it('never hides a broken key history behind a clean status', async () => {
    const result = await verifyDecision({
      manifest: fixture.envelope,
      anchor: fixture.anchor,
      keyContinuity: 'broken',
    })
    expect(result.caveats).toEqual(['broken-key-continuity'])
  })

  it('says nothing about integrity when there is nothing to compare', async () => {
    const result = await verifyDecision({})
    expect(result.status).toBe('unavailable')
    expect(result.discrepancies).toEqual([])
  })
})

describe('verifyDecision — розбіжності, які підпис сам по собі не ловить', () => {
  let key: AgentKeyPair

  beforeAll(async () => {
    key = await generateAgentKey()
  })

  it('catches a step whose content does not hash to its own hashes, signature and all', async () => {
    // Підпис тут **валідний**: так виглядає не підміна у сховищі, а SDK, який
    // порахував лист не з того вмісту, що поклав у манифест.
    const manifest = await makeManifest(7, key)
    const [first, ...rest] = manifest.steps
    if (first === undefined || first.private) throw new Error('fixture lost its public step')
    const envelope = await signManifest(
      { ...manifest, steps: [{ ...first, input: { url: 'https://elsewhere.example/' } }, ...rest] },
      key,
    )

    const result = await verifyDecision({ manifest: envelope, anchor: anchorFor(envelope) })
    expect(result.status).toBe('tampered')
    expect(result.discrepancies.map((item) => item.code)).toContain('step-hash-mismatch')
  })

  it('catches a root that does not fold from the steps, signature and all', async () => {
    const manifest = await makeManifest(8, key)
    const envelope = await signManifest({ ...manifest, root: 'ab'.repeat(32) }, key)

    const result = await verifyDecision({ manifest: envelope, anchor: anchorFor(envelope) })
    expect(result.status).toBe('tampered')
    expect(result.discrepancies.map((item) => item.code)).toContain('steps-root-mismatch')
  })

  it('collects every discrepancy it found, not just the first', async () => {
    const fixture = await makeDecision(9, key)
    const envelope = loosen(fixture)
    envelope.manifest.root = flipHex(envelope.manifest.root as string)

    const result = await verifyDecision({ manifest: envelope, anchor: fixture.anchor })
    const codes = result.discrepancies.map((item) => item.code)
    expect(codes).toContain('steps-root-mismatch')
    expect(codes).toContain('signature-invalid')
    expect(codes).toContain('anchor-root-mismatch')
  })
})

/**
 * SC-005 — головна причина, чому цей модуль чистий: критерій вимірюється на
 * фікстурах, без мережі й без нашого сервісу. Число «50 із 50» тут не мета сама
 * по собі: набір мутацій навмисно накриває всі шари формату — вміст кроку, його
 * хеші, прапорець приватності, структуру, поля рішення, конверт і сам якір, —
 * бо 50 варіацій одного різновиду підміни довели б лише один шар.
 */
describe('verifyDecision — SC-005', () => {
  const HONEST = 200
  let honest: Fixture[]
  let other: Fixture

  beforeAll(async () => {
    const [key, otherKey] = await Promise.all([generateAgentKey(), generateAgentKey()])
    honest = await Promise.all(
      Array.from({ length: HONEST }, (_, index) => makeDecision(index + 1, key)),
    )
    other = await makeDecision(9_999, otherKey)
  }, 60_000)

  it('flags a discrepancy in 50 of 50 deliberately altered decisions', async () => {
    expect(mutations).toHaveLength(50)

    const missed = (
      await Promise.all(
        mutations.map(async (mutation, index) => {
          const base = honest[index % honest.length]
          if (base === undefined) throw new Error('no honest fixture to mutate')
          const result = await verifyDecision(mutation.apply(base, other))
          return { name: mutation.name, status: result.status }
        }),
      )
    ).filter((outcome) => outcome.status !== 'tampered')

    expect(missed).toEqual([])
  }, 60_000)

  it('raises zero false tampered across 200 honest decisions', async () => {
    const wrong = (
      await Promise.all(
        honest.map(async (fixture, index) => {
          const result = await verifyDecision({
            manifest: fixture.envelope,
            anchor: fixture.anchor,
          })
          return { index, status: result.status, discrepancies: result.discrepancies }
        }),
      )
    ).filter((outcome) => outcome.status !== 'verified')

    expect(wrong).toEqual([])
  }, 60_000)

  it('raises zero false tampered on the same 200 before their anchor lands', async () => {
    // Той самий набір без якоря має давати рівно `pending` — стан очікування не
    // повинен ані підтягуватися до verified, ані сповзати в tampered.
    const statuses = await Promise.all(
      honest.map(async (fixture) => (await verifyDecision({ manifest: fixture.envelope })).status),
    )
    expect(statuses.filter((status) => status !== 'pending')).toEqual([])
  }, 60_000)
})
