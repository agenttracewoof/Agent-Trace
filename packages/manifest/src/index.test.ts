import { describe, expect, it } from 'vitest'
import { ANCHOR_PAYLOAD_BYTES, SOLANA_TX_LIMIT_BYTES } from './index.js'

describe('anchor payload budget', () => {
  it('matches the layout documented in PLAN.md', () => {
    expect(ANCHOR_PAYLOAD_BYTES).toBe(153)
  })

  it('leaves room inside a Solana transaction once base64-encoded', () => {
    const encoded = Math.ceil(ANCHOR_PAYLOAD_BYTES / 3) * 4
    expect(encoded).toBeLessThan(SOLANA_TX_LIMIT_BYTES / 2)
  })
})
