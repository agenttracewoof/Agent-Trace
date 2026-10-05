import { describe, expect, it } from 'vitest'
import { journalPath, publicDecisionUrl } from './DecisionDetails'

const PROJECT = '6f1c1d9e-3b0a-4c39-9a51-0d3c2b7e8f10'
const DECISION = 'ab'.repeat(16)

describe('publicDecisionUrl', () => {
  it('is the public page on this deployment, at the root', () => {
    expect(publicDecisionUrl('https://trace.example', '/', DECISION)).toBe(
      `https://trace.example/decisions/${DECISION}`,
    )
  })

  it('keeps the base path a Pages build is served under', () => {
    expect(publicDecisionUrl('https://owner.github.io', '/Agent-Trace/', DECISION)).toBe(
      `https://owner.github.io/Agent-Trace/decisions/${DECISION}`,
    )
    expect(publicDecisionUrl('https://owner.github.io', '/Agent-Trace', DECISION)).toBe(
      `https://owner.github.io/Agent-Trace/decisions/${DECISION}`,
    )
  })
})

describe('journalPath', () => {
  it('leads back to the journal with the filters it was left with', () => {
    expect(journalPath(PROJECT, { journalSearch: '?status=failed&from=2026-10-01' })).toBe(
      `/projects/${PROJECT}?status=failed&from=2026-10-01`,
    )
  })

  it('opens the journal unfiltered when the page was not reached from it', () => {
    expect(journalPath(PROJECT, null)).toBe(`/projects/${PROJECT}`)
    expect(journalPath(PROJECT, undefined)).toBe(`/projects/${PROJECT}`)
    expect(journalPath(PROJECT, { journalSearch: '' })).toBe(`/projects/${PROJECT}`)
  })

  it('takes nothing but a query string from the state', () => {
    expect(journalPath(PROJECT, { journalSearch: '//evil.example' })).toBe(`/projects/${PROJECT}`)
    expect(journalPath(PROJECT, { journalSearch: 42 })).toBe(`/projects/${PROJECT}`)
  })
})
