import { buildManifest } from '@agenttrace/sdk'
import { describe, expect, it } from 'vitest'
import {
  DEMO_REDACTION_POLICY,
  generateDecision,
  generateDecisions,
  randomFrom,
  SHAPES,
  type Shape,
} from './generator.js'

const AGENT = 'ab'.repeat(32)
const decision = (seed: number, shape?: Shape) =>
  generateDecision({ seed, agentPubkey: AGENT, ...(shape === undefined ? {} : { shape }) })

/** Стелі приймання (T027) — повторені тут числом, щоб тест ловив і їх зміну. */
const MAX_STEPS = 256
const MAX_BODY_BYTES = 64 * 1024

describe('determinism', () => {
  it('gives the same draft for the same seed, byte for byte', () => {
    // Без цього прогін, який упав на тисячному рішенні, неможливо відтворити.
    expect(JSON.stringify(decision(7))).toBe(JSON.stringify(decision(7)))
  })

  it('gives different decisions for different seeds', () => {
    expect(decision(7).decisionId).not.toBe(decision(8).decisionId)
  })

  it('keeps its own generator, not the platform one', () => {
    // Послідовність закріплена значенням: якщо вона поїде, зміняться всі дані
    // демо разом із нею, і мовчки цього статися не має.
    const random = randomFrom(1)

    expect([random(), random()].map((one) => one.toFixed(6))).toEqual(['0.627074', '0.002736'])
  })

  it('addresses each decision reproducibly', () => {
    expect(decision(42).decisionId).toMatch(/^[0-9a-f]{32}$/)
    expect(decision(42).decisionId).toBe(decision(42).decisionId)
  })
})

describe('shapes', () => {
  it('produces every shape it advertises', () => {
    for (const shape of SHAPES) {
      expect(decision(3, shape).steps.length).toBeGreaterThan(0)
    }
  })

  it('varies the shape across a set instead of repeating one decision', () => {
    const sizes = new Set(
      generateDecisions(24, { seed: 100, agentPubkey: AGENT }).map((one) => one.steps.length),
    )

    expect(sizes.size).toBeGreaterThan(3)
  })

  it('marks some steps private and leaves others public', () => {
    const steps = decision(5, 'typical').steps

    expect(steps.some((one) => one.private)).toBe(true)
    expect(steps.some((one) => !one.private)).toBe(true)
  })

  it('stays inside the limits the api enforces', () => {
    /**
     * Генератор демо не має права зробити рішення, яке приймання відхилить:
     * інакше «демо не працює» читалося б як зламаний продукт, а не як
     * неправильні дані. Перевищення стелі — окремий свідомий виклик, не форма.
     */
    for (const shape of SHAPES) {
      for (let seed = 0; seed < 12; seed += 1) {
        const draft = decision(seed, shape)
        expect(draft.steps.length).toBeLessThanOrEqual(MAX_STEPS)
        expect(new TextEncoder().encode(JSON.stringify(draft)).byteLength).toBeLessThan(
          MAX_BODY_BYTES,
        )
      }
    }
  })
})

describe('secrets, so SC-006 has something to prove', () => {
  it('puts secret-shaped values into inputs, outputs and the outcome', () => {
    const draft = decision(11, 'secretive')
    const serialized = JSON.stringify(draft)

    expect(serialized).toContain('apiKey')
    expect(serialized).toContain('authorization')
    expect(serialized).toContain('token')
  })

  it('leaves none of them in the manifest the sdk builds', async () => {
    /**
     * Найважливіший тест файлу: він перевіряє **пару** «генератор + політика».
     * Секрет, який генератор кладе у поле, дозволене політикою, пройшов би
     * редакцію й опинився в ланцюгу — і винен був би не `redact`.
     */
    for (let seed = 0; seed < 25; seed += 1) {
      const draft = decision(seed, 'secretive')
      const manifest = await buildManifest(draft, DEMO_REDACTION_POLICY)
      const published = JSON.stringify(manifest)

      for (const prefix of ['sk-live-', 'Bearer ', 'xoxb-', 'ghp_']) {
        expect(published).not.toContain(prefix)
      }
      expect(published).not.toContain('apiKey')
      expect(published).not.toContain('authorization')
    }
  })

  it('keeps the fields the demo actually shows', async () => {
    // Політика, яка вирізає все, теж дала б нуль секретів — і порожню сторінку.
    const manifest = await buildManifest(decision(4, 'secretive'), DEMO_REDACTION_POLICY)

    expect(JSON.stringify(manifest.outcome)).toContain('reason')
    expect(manifest.steps.some((one) => !one.private)).toBe(true)
  })
})

describe('the sdk accepts what the generator makes', () => {
  it('builds a manifest out of every shape', async () => {
    for (const shape of SHAPES) {
      const manifest = await buildManifest(decision(9, shape), DEMO_REDACTION_POLICY)

      expect(manifest.root).toMatch(/^[0-9a-f]{64}$/)
      expect(manifest.steps.length).toBe(decision(9, shape).steps.length)
    }
  })
})
