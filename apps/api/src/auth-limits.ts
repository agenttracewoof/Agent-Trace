/**
 * Every sign-in code is an email, and every email spends the Resend quota —
 * 100 a day on the free plan, shared by everyone who wants to sign in. A
 * caller left alone could spend it on strangers' addresses in a minute and
 * lock every operator out until midnight, so sending is limited three ways,
 * each against a different abuse:
 *
 * - per source address — one caller asking for many codes;
 * - per email address — many callers bombarding one inbox;
 * - per UTC day, for everybody — the quota itself, refused with a 429 that
 *   says so instead of a 500 from Resend after it is already gone.
 *
 * All of it lives in process memory. The free Render plan runs one instance,
 * so the counts are exact there; a restart forgets them, which hands back at
 * most one day's cap — Resend still refuses beyond its own.
 */

/**
 * Entries of `x-forwarded-for` that our own infrastructure appends after the
 * caller's address. Measured on Render on 2026-09-25: the chain ends with a
 * public proxy address of the platform, one hop after the caller.
 */
export const TRUSTED_PROXY_HOPS = 1

const INTERNAL = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^::1$/,
  /^f[cd][0-9a-f]{2}:/i,
  /^fe[89ab][0-9a-f]:/i,
]

const isInternal = (hop: string) => INTERNAL.some((range) => range.test(hop))

/** A proxy that writes `ip:port` would otherwise hand one caller a new bucket per connection. */
function withoutPort(hop: string): string {
  const bracketed = /^\[(.+)](?::\d+)?$/.exec(hop)
  if (bracketed?.[1] !== undefined) return bracketed[1]
  const parts = hop.split(':')
  return parts.length === 2 && /^\d+$/.test(parts[1] ?? '') ? (parts[0] ?? hop) : hop
}

/**
 * Counted from the end, never from the start: whatever a caller writes into
 * the header stays to the left of what the edge appends, so no invented value
 * becomes the one we count by. Reading the first entry would give a fresh
 * allowance for every value a caller cares to invent.
 *
 * The socket address is the answer only when there is no header at all — the
 * local case. Exposed without a proxy in front, this would trust a forged
 * header; the deployment never is.
 */
export function clientAddress(forwardedFor: string | undefined, socketAddress: string | undefined) {
  const hops = (forwardedFor ?? '')
    .split(',')
    .map((hop) => withoutPort(hop.trim()))
    .filter((hop) => hop.length > 0)

  if (hops.length === 0) return socketAddress ?? 'unknown'

  let end = hops.length
  while (end > 1 && isInternal(hops[end - 1] ?? '')) end -= 1

  return hops[Math.max(0, end - 1 - TRUSTED_PROXY_HOPS)] ?? 'unknown'
}

export interface SendCodeLimits {
  /** Codes one source address may ask for in a row. */
  readonly addressBurst: number
  /** How fast that allowance comes back. */
  readonly addressPerHour: number
  /** Pause between two codes to one inbox. */
  readonly emailCooldownMs: number
  /** Codes sent per UTC day in total; kept below the provider's quota. */
  readonly perDay: number
}

/**
 * Twenty short of Resend's 100: the same quota carries any mail the owner
 * sends by hand from that account, and a cap that equals the quota would let
 * us find out which of the two ran out first only from a failed send.
 */
export const DEFAULT_SEND_CODE_LIMITS: SendCodeLimits = {
  addressBurst: 5,
  addressPerHour: 10,
  emailCooldownMs: 60_000,
  perDay: 80,
}

export type SendCodeVerdict =
  | { readonly allowed: true }
  | {
      readonly allowed: false
      readonly reason: 'address' | 'email' | 'day'
      readonly retryAfterSeconds: number
    }

/** Past this many tracked keys, stale ones are dropped; keys come from callers. */
const MAX_TRACKED = 10_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

interface Bucket {
  tokens: number
  updatedAt: number
}

export function createSendCodeGuard(
  limits: SendCodeLimits = DEFAULT_SEND_CODE_LIMITS,
  now: () => number = Date.now,
): (address: string, email: string) => SendCodeVerdict {
  const buckets = new Map<string, Bucket>()
  const lastSent = new Map<string, number>()
  let day = -1
  let sentToday = 0

  const refillMs = HOUR_MS / limits.addressPerHour

  const refilled = (bucket: Bucket | undefined, at: number): Bucket =>
    bucket === undefined
      ? { tokens: limits.addressBurst, updatedAt: at }
      : {
          tokens: Math.min(limits.addressBurst, bucket.tokens + (at - bucket.updatedAt) / refillMs),
          updatedAt: at,
        }

  /**
   * A bucket that has refilled and a cooldown that has passed are both
   * indistinguishable from a caller never seen, so dropping them forgets
   * nothing. Only when that is not enough does the oldest go early.
   */
  const sweep = (at: number) => {
    for (const [key, bucket] of buckets) {
      if (refilled(bucket, at).tokens >= limits.addressBurst) buckets.delete(key)
    }
    for (const [key, sentAt] of lastSent) {
      if (at - sentAt >= limits.emailCooldownMs) lastSent.delete(key)
    }
    for (const map of [buckets, lastSent]) {
      for (const key of [...map.keys()].slice(0, Math.max(0, map.size - MAX_TRACKED))) {
        map.delete(key)
      }
    }
  }

  const refuse = (reason: 'address' | 'email' | 'day', waitMs: number): SendCodeVerdict => ({
    allowed: false,
    reason,
    retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
  })

  return (address, email) => {
    const at = now()
    const today = Math.floor(at / DAY_MS)
    if (today !== day) {
      day = today
      sentToday = 0
    }

    // Checked in order of who pays: a caller over their own limit must not
    // spend an inbox's cooldown or a slot of the day's cap.
    const bucket = refilled(buckets.get(address), at)
    if (bucket.tokens < 1) {
      buckets.set(address, bucket)
      return refuse('address', (1 - bucket.tokens) * refillMs)
    }

    const previous = lastSent.get(email)
    if (previous !== undefined && at - previous < limits.emailCooldownMs) {
      return refuse('email', limits.emailCooldownMs - (at - previous))
    }

    if (sentToday >= limits.perDay) return refuse('day', (today + 1) * DAY_MS - at)

    buckets.set(address, { tokens: bucket.tokens - 1, updatedAt: at })
    lastSent.set(email, at)
    sentToday += 1

    if (buckets.size > MAX_TRACKED || lastSent.size > MAX_TRACKED) sweep(at)

    return { allowed: true }
  }
}
