import { describe, expect, it } from 'vitest'
import { clientAddress, createSendCodeGuard, type SendCodeLimits } from './auth-limits.js'

describe('clientAddress', () => {
  it('steps back over the platform proxy to the caller', () => {
    expect(clientAddress('203.0.113.7, 198.51.100.1', '10.0.0.5')).toBe('203.0.113.7')
  })

  it('ignores what the caller wrote in front of the real chain', () => {
    expect(clientAddress('1.2.3.4, 203.0.113.7, 198.51.100.1', undefined)).toBe('203.0.113.7')
  })

  it('steps over private hops of our own before counting', () => {
    expect(clientAddress('203.0.113.7, 198.51.100.1, 10.1.2.3, 192.168.0.9', undefined)).toBe(
      '203.0.113.7',
    )
  })

  it('drops the port a proxy may append', () => {
    expect(clientAddress('203.0.113.7:51234, [2001:db8::1]:443', undefined)).toBe('203.0.113.7')
    expect(clientAddress('[2001:db8::1]:443, 198.51.100.1', undefined)).toBe('2001:db8::1')
  })

  it('falls back to the socket when there is no header, as it is locally', () => {
    expect(clientAddress(undefined, '127.0.0.1')).toBe('127.0.0.1')
    expect(clientAddress('', undefined)).toBe('unknown')
  })

  it('takes the first entry when the chain is shorter than the proxies we trust', () => {
    expect(clientAddress('203.0.113.7', undefined)).toBe('203.0.113.7')
  })
})

const LIMITS: SendCodeLimits = {
  addressBurst: 2,
  addressPerHour: 2,
  emailCooldownMs: 60_000,
  perDay: 4,
}

function clock(start = Date.UTC(2026, 9, 2, 12)) {
  let at = start
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms
    },
  }
}

describe('createSendCodeGuard', () => {
  it('lets a first code through', () => {
    const guard = createSendCodeGuard(LIMITS, clock().now)
    expect(guard('203.0.113.7', 'a@example.com')).toEqual({ allowed: true })
  })

  it('refuses a source address past its burst and lets it back after the refill', () => {
    const time = clock()
    const guard = createSendCodeGuard(LIMITS, time.now)
    guard('203.0.113.7', 'a@example.com')
    guard('203.0.113.7', 'b@example.com')

    const refused = guard('203.0.113.7', 'c@example.com')
    expect(refused).toEqual({ allowed: false, reason: 'address', retryAfterSeconds: 1800 })

    time.advance(30 * 60_000)
    expect(guard('203.0.113.7', 'c@example.com')).toEqual({ allowed: true })
  })

  it('keeps one inbox from being bombarded from many addresses', () => {
    const time = clock()
    const guard = createSendCodeGuard(LIMITS, time.now)
    guard('203.0.113.7', 'a@example.com')

    expect(guard('198.51.100.9', 'a@example.com')).toEqual({
      allowed: false,
      reason: 'email',
      retryAfterSeconds: 60,
    })

    time.advance(60_000)
    expect(guard('198.51.100.9', 'a@example.com')).toEqual({ allowed: true })
  })

  it('stops for everybody at the daily cap and starts again at UTC midnight', () => {
    const time = clock(Date.UTC(2026, 9, 2, 23, 59))
    const guard = createSendCodeGuard({ ...LIMITS, addressBurst: 10 }, time.now)
    for (const n of [1, 2, 3, 4]) {
      expect(guard(`203.0.113.${n}`, `${n}@example.com`)).toEqual({ allowed: true })
    }

    expect(guard('203.0.113.9', '9@example.com')).toEqual({
      allowed: false,
      reason: 'day',
      retryAfterSeconds: 60,
    })

    time.advance(60_000)
    expect(guard('203.0.113.9', '9@example.com')).toEqual({ allowed: true })
  })

  it('charges nothing for a refusal it hands out', () => {
    // An address refused for an inbox's cooldown keeps its own allowance, and
    // an address over its limit leaves the day's cap untouched.
    const time = clock()
    const guard = createSendCodeGuard(LIMITS, time.now)
    guard('203.0.113.1', 'a@example.com')
    guard('203.0.113.2', 'a@example.com')
    guard('203.0.113.2', 'a@example.com')
    expect(guard('203.0.113.2', 'b@example.com')).toEqual({ allowed: true })

    guard('203.0.113.2', 'c@example.com')
    guard('203.0.113.2', 'd@example.com')
    expect(guard('203.0.113.3', 'e@example.com')).toEqual({ allowed: true })
  })
})
