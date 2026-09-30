import { describe, expect, it } from 'vitest'
import { decisionIdFrom } from './Landing'

const ID = '0123456789abcdef0123456789abcdef'

describe('decisionIdFrom', () => {
  it('takes a bare id, trimmed and in any case', () => {
    expect(decisionIdFrom(ID)).toBe(ID)
    expect(decisionIdFrom(`  ${ID.toUpperCase()}\n`)).toBe(ID)
  })

  it('takes the link someone was sent, with or without a trailing part', () => {
    const page = 'https://agenttracewoof.github.io/Agent-Trace/decisions'
    expect(decisionIdFrom(`${page}/${ID}`)).toBe(ID)
    expect(decisionIdFrom(`${page}/${ID}/`)).toBe(ID)
    expect(decisionIdFrom(`${page}/${ID}?from=mail`)).toBe(ID)
    expect(decisionIdFrom(`/decisions/${ID}#steps`)).toBe(ID)
  })

  it('refuses what cannot be a decision, before any request is made', () => {
    expect(decisionIdFrom('')).toBeUndefined()
    expect(decisionIdFrom(ID.slice(1))).toBeUndefined()
    expect(decisionIdFrom(`${ID}0`)).toBeUndefined()
    expect(decisionIdFrom(`https://example.com/decisions/${ID}0`)).toBeUndefined()
    expect(decisionIdFrom(`https://example.com/agents/${ID}`)).toBeUndefined()
  })
})
