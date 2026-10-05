import { describe, expect, it } from 'vitest'
import {
  CLOCK_SLACK_MS,
  dayStart,
  filtersFromSearch,
  isClockAhead,
  queryFromFilters,
  searchFromFilters,
  signedTime,
} from './Journal'

const AGENT = '6f1c1d9e-3b0a-4c39-9a51-0d3c2b7e8f10'
const DAY_MS = 86_400_000

describe('dayStart', () => {
  it('is midnight UTC of the day, whatever zone the browser is in', () => {
    expect(dayStart('2026-10-05')).toBe(Date.UTC(2026, 9, 5))
  })

  it('refuses what is not a calendar day rather than rolling it over', () => {
    expect(dayStart('2026-02-31')).toBeUndefined()
    expect(dayStart('2026-13-01')).toBeUndefined()
    expect(dayStart('2026-10-5')).toBeUndefined()
    expect(dayStart('yesterday')).toBeUndefined()
  })
})

describe('the filters in the address', () => {
  it('round-trips every filter', () => {
    const filters = {
      agentId: AGENT,
      from: '2026-10-01',
      to: '2026-10-05',
      status: 'failed',
    } as const
    expect(filtersFromSearch(searchFromFilters(filters))).toEqual(filters)
  })

  it('drops a value that cannot be a filter, so the form shows what is applied', () => {
    const search = new URLSearchParams({
      agent: 'not-a-uuid',
      from: '2026-02-31',
      to: '2026-10-05',
      status: 'verified',
    })
    expect(filtersFromSearch(search)).toEqual({ to: '2026-10-05' })
  })

  it('leaves an unset filter out of the address', () => {
    expect(searchFromFilters({ status: 'pending' }).toString()).toBe('status=pending')
    expect(searchFromFilters({}).toString()).toBe('')
  })
})

describe('queryFromFilters', () => {
  it('makes the last day whole: [first midnight, midnight after the last)', () => {
    const result = queryFromFilters({ from: '2026-10-01', to: '2026-10-05' })
    expect(result).toEqual({
      query: { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 5) + DAY_MS },
    })
  })

  it('takes one day as from and to the same day', () => {
    const result = queryFromFilters({ from: '2026-10-05', to: '2026-10-05' })
    expect(result).toEqual({ query: { from: Date.UTC(2026, 9, 5), to: Date.UTC(2026, 9, 6) } })
  })

  it('sends nothing for a period that ends before it starts', () => {
    expect(queryFromFilters({ from: '2026-10-06', to: '2026-10-05' })).toEqual({
      problem: 'The period ends before it starts.',
    })
  })

  it('passes agent and status through and sends no filter it was not given', () => {
    expect(queryFromFilters({ agentId: AGENT, status: 'anchored' })).toEqual({
      query: { agentId: AGENT, status: 'anchored' },
    })
    expect(queryFromFilters({})).toEqual({ query: {} })
  })
})

describe('signedTime', () => {
  it('is UTC, in the public page’s form', () => {
    expect(signedTime(Date.UTC(2026, 9, 5, 12, 30))).toBe('2026-10-05 12:30:00Z')
  })

  it('gives the raw milliseconds past what a Date can hold, instead of throwing', () => {
    const max = Number.MAX_SAFE_INTEGER
    expect(signedTime(max)).toBe(`${max} ms — past any calendar date`)
  })
})

describe('isClockAhead', () => {
  const at = (decidedAt: number, received: number) => ({
    decidedAt,
    receivedAt: new Date(received).toISOString(),
  })
  const now = Date.UTC(2026, 9, 5)

  it('flags a decision signed for after it reached us', () => {
    expect(isClockAhead(at(now + CLOCK_SLACK_MS + 1, now))).toBe(true)
  })

  it('lets ordinary drift and late, buffered decisions pass', () => {
    expect(isClockAhead(at(now + CLOCK_SLACK_MS, now))).toBe(false)
    expect(isClockAhead(at(now - 3 * DAY_MS, now))).toBe(false)
  })

  it('flags a clock past any calendar date', () => {
    expect(isClockAhead(at(Number.MAX_SAFE_INTEGER, now))).toBe(true)
  })
})
