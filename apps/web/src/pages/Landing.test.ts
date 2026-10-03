import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { decisionIdFrom, isSignupOpen, SDK_EXAMPLE } from './Landing'

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

describe('isSignupOpen', () => {
  it('opens only on the exact switch, so a typo keeps the door shut', () => {
    expect(isSignupOpen({ VITE_SIGNUP_OPEN: 'true' })).toBe(true)
    for (const value of [undefined, '', 'false', 'TRUE', '1', true]) {
      expect(isSignupOpen({ VITE_SIGNUP_OPEN: value })).toBe(false)
    }
  })
})

describe('SDK_EXAMPLE', () => {
  it('is the example the SDK README gives, word for word', () => {
    const readme = readFileSync(
      fileURLToPath(new URL('../../../../packages/sdk/README.md', import.meta.url)),
      'utf8',
    ).replace(/\r\n/g, '\n')
    expect(readme).toContain(SDK_EXAMPLE)
  })
})
