import { describe, expect, it } from 'vitest'
import { formatDecidedAt, isPrivate } from './Decision'

describe('formatDecidedAt', () => {
  it('shows the signed timestamp as utc, never as local time', () => {
    /**
     * Локальний час зробив би те саме рішення різним для двох людей, які
     * дивляться на один запис, — а звіряють вони саме його: `decidedAt`
     * входить у підпис і лежить у якорі байт-у-байт.
     */
    expect(formatDecidedAt(1_760_000_000_000)).toBe('2025-10-09 08:53:20Z')
  })

  it('keeps sub-second precision when the decision carries it', () => {
    expect(formatDecidedAt(1_786_713_961_168)).toBe('2026-08-14 13:26:01.168Z')
  })

  it('names a time past any calendar date instead of throwing', () => {
    // The format bounds `decidedAt` only by 2^53 and a `Date` stops at 8.64e15:
    // `toISOString` would throw and take the decision page down with it.
    expect(formatDecidedAt(Number.MAX_SAFE_INTEGER)).toBe('past any calendar date')
    expect(formatDecidedAt(8_640_000_000_000_001)).toBe('past any calendar date')
    expect(formatDecidedAt(8_640_000_000_000_000)).toBe('+275760-09-13 00:00:00Z')
  })
})

describe('isPrivate', () => {
  it('reads the flag from the step, not from the absence of content', () => {
    // Крок без вмісту і крок, позначений приватним, — різні речі; друге
    // стверджує власник, перше може бути дірою в даних.
    expect(isPrivate({ type: 'model.call', private: true, inputHash: 'a', outputHash: 'b' })).toBe(
      true,
    )
    expect(
      isPrivate({
        type: 'tool.call',
        private: false,
        input: null,
        output: null,
        inputHash: 'a',
        outputHash: 'b',
      }),
    ).toBe(false)
  })
})
