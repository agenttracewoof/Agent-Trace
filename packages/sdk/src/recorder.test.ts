import { describe, expect, it } from 'vitest'
import { buildManifest, type RedactionPolicy } from './pipeline.js'
import { startDecision } from './recorder.js'

const AGENT_PUBKEY = 'a'.repeat(64)
const POLICY: RedactionPolicy = {
  stepInput: ['query'],
  stepOutput: ['rows'],
  outcome: ['approved'],
}

function open() {
  return startDecision({ agentPubkey: AGENT_PUBKEY, model: 'claude-opus-5' })
}

describe('startDecision', () => {
  it('keeps the steps in the order the agent took them', () => {
    const decision = open()

    decision.step('retrieval', { query: 'q' }, { rows: 2 })
    decision.step('model-call', { query: 'q' }, { rows: 0 })
    const draft = decision.finish({ approved: true })

    expect(draft.steps.map((step) => step.type)).toEqual(['retrieval', 'model-call'])
    expect(draft.steps[0]).toEqual({
      type: 'retrieval',
      private: false,
      input: { query: 'q' },
      output: { rows: 2 },
    })
  })

  it('carries the identity, the model and the outcome the agent gave it', () => {
    const decision = open()

    decision.step('retrieval', {}, {})
    const draft = decision.finish({ approved: true })

    expect(draft.agentPubkey).toBe(AGENT_PUBKEY)
    expect(draft.model).toBe('claude-opus-5')
    expect(draft.outcome).toEqual({ approved: true })
  })

  it('gives every decision its own identifier, in the form the anchor carries', () => {
    const first = open()
    const second = open()

    expect(first.decisionId).toMatch(/^[0-9a-f]{32}$/)
    expect(second.decisionId).not.toBe(first.decisionId)
  })

  it('reports the identifier before the decision is finished', () => {
    const decision = open()

    decision.step('retrieval', {}, {})

    expect(decision.finish({}).decisionId).toBe(decision.decisionId)
  })

  it('lists each source once, in the order it was first read', () => {
    const decision = open()

    decision.source('https://quotes.example/1')
    decision.source('https://rates.example/2')
    decision.source('https://quotes.example/1')
    decision.step('retrieval', {}, {})

    expect(decision.finish({}).sources).toEqual([
      'https://quotes.example/1',
      'https://rates.example/2',
    ])
  })

  it('times the decision at the moment it was finished', () => {
    const decision = open()
    decision.step('retrieval', {}, {})

    const before = Date.now()
    const { decidedAt } = decision.finish({})

    expect(decidedAt).toBeGreaterThanOrEqual(before)
    expect(decidedAt).toBeLessThanOrEqual(Date.now())
  })

  it('hands the pipeline a draft it accepts', async () => {
    const decision = open()

    decision.source('https://quotes.example/1')
    decision.step('retrieval', { query: 'q', apiKey: 'sk-live-1' }, { rows: 2 })
    const manifest = await buildManifest(decision.finish({ approved: true }), POLICY)

    expect(manifest.decisionId).toBe(decision.decisionId)
    expect(manifest.steps).toHaveLength(1)
    expect(JSON.stringify(manifest)).not.toContain('sk-live-1')
  })

  it('refuses to record into a decision that is already finished', () => {
    const decision = open()

    decision.step('retrieval', {}, {})
    decision.finish({})

    expect(() => decision.step('model-call', {}, {})).toThrow(/finished/)
    expect(() => decision.source('https://quotes.example/1')).toThrow(/finished/)
    expect(() => decision.finish({})).toThrow(/finished/)
  })

  it('refuses to finish a decision that recorded nothing', () => {
    expect(() => open().finish({})).toThrow(/no steps/)
  })

  it('rejects a value with no canonical form where the agent wrote it', () => {
    const decision = open()

    decision.step('retrieval', { at: new Date(0) }, {})

    expect(() => decision.finish({})).toThrow()
  })
})
