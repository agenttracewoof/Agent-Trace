import type { AgentKey } from '@agenttrace/shared'
import { describe, expect, it } from 'vitest'
import { checkPublicKey, keyWindow, kindLabel } from './AgentKeys'

const PUBLIC_KEY = 'ab'.repeat(32)

const key = (overrides: Partial<AgentKey>): AgentKey => ({
  publicKey: PUBLIC_KEY,
  rotationKind: 'initial',
  validFrom: 0,
  validTo: null,
  confirmedBy: null,
  ...overrides,
})

describe('checkPublicKey', () => {
  it('takes the 64 hex characters of a public key, pasted with spaces or in capitals', () => {
    expect(checkPublicKey(`  ${PUBLIC_KEY.toUpperCase()}\n`)).toEqual({ publicKey: PUBLIC_KEY })
    expect(checkPublicKey(`"${PUBLIC_KEY}",`)).toEqual({ publicKey: PUBLIC_KEY })
  })

  it('refuses the whole keystore, so the private key is never sent', () => {
    const keystore = JSON.stringify({
      version: 1,
      publicKey: PUBLIC_KEY,
      privateKey: 'cd'.repeat(48),
    })
    const checked = checkPublicKey(keystore)
    expect(checked).toEqual({ problem: expect.stringMatching(/private key/) })
    expect(JSON.stringify(checked)).not.toContain('cd'.repeat(48))
  })

  it('refuses anything that is not one key', () => {
    expect(checkPublicKey('')).toEqual({ problem: expect.stringMatching(/Paste/) })
    expect(checkPublicKey(PUBLIC_KEY.slice(2))).toEqual({ problem: expect.stringMatching(/64/) })
    expect(checkPublicKey(`${PUBLIC_KEY.slice(2)}zz`)).toEqual({
      problem: expect.stringMatching(/64/),
    })
  })
})

describe('kindLabel', () => {
  it('names who vouches for each key, the emergency one by the owner who confirmed it', () => {
    expect(kindLabel(key({}))).toMatch(/registered/)
    expect(kindLabel(key({ rotationKind: 'chained' }))).toMatch(/signed by the previous key/)
    expect(
      kindLabel(key({ rotationKind: 'administrative', confirmedBy: 'owner@example.com' })),
    ).toMatch(/Emergency replacement confirmed by owner@example\.com/)
  })
})

describe('keyWindow', () => {
  it('reads the first key from registration and the current one as in force', () => {
    expect(keyWindow(key({}))).toBe('from registration · in force')
  })

  it('gives both ends of a closed window in UTC', () => {
    const from = Date.UTC(2026, 9, 18, 12, 0, 0)
    expect(keyWindow(key({ validFrom: from, validTo: from + 60_000 }))).toBe(
      'from 2026-10-18 12:00:00Z · until 2026-10-18 12:01:00Z',
    )
  })
})
