import { describe, expect, it } from 'vitest'
import {
  availability,
  buildSchedule,
  CLOCK_JUMP_MS,
  costWindows,
  coverage,
  DAY_MS,
  DEFAULT_DECISIONS_PER_DAY,
  LAMPORTS_PER_SOL,
  type LatencySample,
  type Probe,
  SC004_MAX_USD_PER_DECISION,
  storageGrowth,
  summarizeCost,
  summarizeLatency,
} from './daily-run.js'

const START = 1_790_000_000_000

const probe = (over: Partial<Probe> & Pick<Probe, 'atMs' | 'slot'>): Probe => ({
  payerLamports: 5 * LAMPORTS_PER_SOL,
  anchoredUpToSlot: 0,
  decisionRows: 0,
  dbBytes: 0,
  uptimeSeconds: 0,
  publisherPasses: 0,
  ...over,
})

const sample = (over: Partial<LatencySample> & Pick<LatencySample, 'ordinal'>): LatencySample => ({
  decisionId: `d-${over.ordinal}`,
  anchorSeenMs: 3_000,
  verifiableMs: 4_000,
  clockJumpMs: 0,
  ...over,
})

describe('buildSchedule', () => {
  const options = { seedBase: 1_000, count: DEFAULT_DECISIONS_PER_DAY, startedAt: START }

  it('is deterministic for a seed base and drifts for another', () => {
    const first = buildSchedule(options)
    const again = buildSchedule(options)
    const shifted = buildSchedule({ ...options, seedBase: 2_000 })

    expect(again.map((one) => one.atMs)).toEqual(first.map((one) => one.atMs))
    expect(again.map((one) => one.seed)).toEqual(first.map((one) => one.seed))
    expect(shifted.map((one) => one.seed)).not.toEqual(first.map((one) => one.seed))
  })

  it('puts the whole volume inside the day, in order', () => {
    const schedule = buildSchedule(options)
    const times = schedule.map((one) => one.atMs)

    expect(schedule).toHaveLength(DEFAULT_DECISIONS_PER_DAY)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
    expect(Math.min(...times)).toBeGreaterThanOrEqual(START)
    expect(Math.max(...times)).toBeLessThanOrEqual(START + DAY_MS)
  })

  /**
   * The point of the plan: a decision every few seconds, never ten thousand at
   * once. A burst would measure the burst — which is how the earlier harness
   * ended up reporting its own 429s as the product's latency.
   */
  it('never lets the stream bunch into a burst', () => {
    const times = buildSchedule(options).map((one) => one.atMs)
    const busiestMinute = times.filter((at) => at < START + 60_000).length

    // At 10 000 a day a minute holds ~7 arrivals; a burst would hold hundreds.
    expect(busiestMinute).toBeLessThan(60)
  })

  it('spreads the SC-001 samples across the whole day, not across its start', () => {
    const sampled = buildSchedule(options).filter((one) => one.sampled)
    const span =
      Math.max(...sampled.map((one) => one.atMs)) - Math.min(...sampled.map((one) => one.atMs))

    expect(sampled.length).toBeGreaterThan(250)
    expect(span).toBeGreaterThan(0.9 * DAY_MS)
  })

  it('chooses the samples in the plan, so the choice cannot follow the result', () => {
    const schedule = buildSchedule({ ...options, sampleEvery: 10 })

    expect(
      schedule
        .filter((one) => one.sampled)
        .map((one) => one.ordinal)
        .slice(0, 3),
    ).toEqual([10, 20, 30])
  })
})

describe('costWindows', () => {
  it('measures a window, so the answer is the same at any window size', () => {
    const perDecision = 5_000
    const hourly = costWindows([
      probe({ atMs: START, slot: 100, payerLamports: 1_000_000, anchoredUpToSlot: 0 }),
      probe({
        atMs: START + 3_600_000,
        slot: 9_100,
        payerLamports: 1_000_000 - 417 * perDecision,
        anchoredUpToSlot: 417,
      }),
    ])
    const daily = costWindows([
      probe({ atMs: START, slot: 100, payerLamports: 1_000_000, anchoredUpToSlot: 0 }),
      probe({
        atMs: START + DAY_MS,
        slot: 216_100,
        payerLamports: 1_000_000 - 10_000 * perDecision,
        anchoredUpToSlot: 10_000,
      }),
    ])

    expect(hourly[0]?.lamportsPerDecision).toBe(perDecision)
    expect(daily[0]?.lamportsPerDecision).toBe(perDecision)
  })

  it('bounds the window by slot, not by the clock it was read at', () => {
    const [window] = costWindows([
      probe({ atMs: START, slot: 500, anchoredUpToSlot: 10 }),
      probe({ atMs: START + 3_600_000, slot: 9_500, anchoredUpToSlot: 30 }),
    ])

    expect(window?.fromSlot).toBe(500)
    expect(window?.toSlot).toBe(9_500)
    expect(window?.anchored).toBe(20)
  })

  it('names a top-up instead of averaging it into the cost', () => {
    const [window] = costWindows([
      probe({ atMs: START, slot: 100, payerLamports: 1_000_000, anchoredUpToSlot: 0 }),
      probe({
        atMs: START + 3_600_000,
        slot: 9_100,
        payerLamports: 3_000_000,
        anchoredUpToSlot: 400,
      }),
    ])

    expect(window?.note).toBe('topped-up')
    expect(window?.lamportsPerDecision).toBeNaN()
  })

  it('names an idle window instead of dividing by nothing', () => {
    const [window] = costWindows([
      probe({ atMs: START, slot: 100, payerLamports: 1_000_000, anchoredUpToSlot: 7 }),
      probe({
        atMs: START + 3_600_000,
        slot: 9_100,
        payerLamports: 1_000_000,
        anchoredUpToSlot: 7,
      }),
    ])

    expect(window?.note).toBe('no-decisions')
    expect(window?.lamportsPerDecision).toBeNaN()
  })
})

describe('summarizeCost', () => {
  const day = (perDecision: number, hours = 24): readonly Probe[] =>
    Array.from({ length: hours + 1 }, (_unused, hour) =>
      probe({
        atMs: START + hour * 3_600_000,
        slot: 100 + hour * 9_000,
        payerLamports: 5 * LAMPORTS_PER_SOL - hour * 417 * perDecision,
        anchoredUpToSlot: hour * 417,
      }),
    )

  it('reports the fee the chain actually charged', () => {
    const summary = summarizeCost(day(5_000), 120.7)

    expect(summary.countedWindows).toBe(24)
    expect(summary.anchored).toBe(24 * 417)
    expect(summary.lamportsPerDecision).toBe(5_000)
  })

  /**
   * The SC-004 verdict is a price call, not an engineering one: one signature
   * is 5 000 lamports whatever we build, so the threshold is crossed by the
   * market, and the report has to say at which price it breaks.
   */
  it('names the SOL price at which the criterion breaks', () => {
    const summary = summarizeCost(day(5_000), 120.7)

    expect(summary.breakEvenSolUsd).toBeCloseTo(200, 6)
    expect(summary.pass).toBe(true)
    expect(summarizeCost(day(5_000), 250).pass).toBe(false)
    expect(summary.usdPerDecision).toBeLessThan(SC004_MAX_USD_PER_DECISION)
  })

  it('keeps a top-up out of the totals instead of letting it pay for the day', () => {
    const probes = [
      probe({ atMs: START, slot: 100, payerLamports: 1_000_000, anchoredUpToSlot: 0 }),
      probe({
        atMs: START + 3_600_000,
        slot: 9_100,
        payerLamports: 1_000_000 - 2_085_000,
        anchoredUpToSlot: 417,
      }),
      probe({
        atMs: START + 7_200_000,
        slot: 18_100,
        payerLamports: 5 * LAMPORTS_PER_SOL,
        anchoredUpToSlot: 834,
      }),
    ]
    const summary = summarizeCost(probes, 120.7)

    expect(summary.notedWindows).toBe(1)
    expect(summary.countedWindows).toBe(1)
    expect(summary.lamportsPerDecision).toBe(5_000)
    expect(summary.spentLamports).toBeGreaterThan(0)
  })
})

describe('coverage', () => {
  const schedule = buildSchedule({ seedBase: 1, count: 100, startedAt: START })
  const all = new Set(schedule.map((one) => one.ordinal))

  it('is whole when every planned arrival was attempted', () => {
    const measured = coverage(schedule, all)

    expect(measured.fraction).toBe(1)
    expect(measured.gaps).toHaveLength(0)
  })

  it('charges a missed arrival the stretch during which nothing was sent', () => {
    const without = new Set(all)
    without.delete(40)
    without.delete(41)
    const measured = coverage(schedule, without)
    const from = schedule[39]?.atMs ?? 0
    const to = schedule[41]?.atMs ?? 0

    expect(measured.missed).toBe(2)
    expect(measured.gaps).toHaveLength(1)
    expect(measured.longestGapMs).toBe(to - from)
    expect(measured.fraction).toBeLessThan(1)
  })

  it('closes a run that stopped early at the end of the plan', () => {
    const cut = new Set([...all].filter((ordinal) => ordinal <= 50))
    const measured = coverage(schedule, cut)

    expect(measured.gaps).toHaveLength(1)
    expect(measured.fraction).toBeLessThan(0.55)
  })
})

describe('summarizeLatency', () => {
  it('passes only when every sampled decision became verifiable', () => {
    const samples = Array.from({ length: 20 }, (_unused, index) =>
      sample({ ordinal: index + 1, verifiableMs: 4_000 + index * 100 }),
    )

    expect(summarizeLatency(samples, 0).pass).toBe(true)
    expect(
      summarizeLatency([...samples, sample({ ordinal: 21, verifiableMs: Number.NaN })], 0).pass,
    ).toBe(false)
  })

  it('fails on a p95 over the budget even when everything verified', () => {
    const samples = Array.from({ length: 20 }, (_unused, index) =>
      sample({ ordinal: index + 1, verifiableMs: index < 18 ? 4_000 : 12_000 }),
    )

    expect(summarizeLatency(samples, 0).verified).toBe(20)
    expect(summarizeLatency(samples, 0).pass).toBe(false)
  })

  /**
   * A host that went to sleep inflates a sample. Dropping it would be choosing
   * which measurements to believe after having seen them, so it stays in the
   * verdict and the clean p95 sits beside it as an annotation.
   */
  it('keeps a sample the host inflated, and names it rather than moving p95', () => {
    const samples = [
      ...Array.from({ length: 19 }, (_unused, index) => sample({ ordinal: index + 1 })),
      sample({ ordinal: 20, verifiableMs: 300_000, clockJumpMs: CLOCK_JUMP_MS * 20 }),
    ]
    const summary = summarizeLatency(samples, 3)

    expect(summary.samples).toBe(20)
    expect(summary.suspect).toBe(1)
    expect(summary.skipped).toBe(3)
    expect(summary.worstMs).toBe(300_000)
    // One sample in twenty sits above the p95 rank, so the outlier is invisible
    // in the headline number. That is exactly why `suspect` is printed: the
    // verdict must not be the only place a stopped host could have shown up.
    expect(summary.p95Ms).toBe(4_000)
    expect(summary.pass).toBe(true)
  })

  it('lets inflated samples fail the verdict, and keeps a clean number beside it', () => {
    const samples = Array.from({ length: 20 }, (_unused, index) =>
      index < 16
        ? sample({ ordinal: index + 1 })
        : sample({ ordinal: index + 1, verifiableMs: 300_000, clockJumpMs: CLOCK_JUMP_MS * 20 }),
    )
    const summary = summarizeLatency(samples, 0)

    expect(summary.suspect).toBe(4)
    expect(summary.p95Ms).toBe(300_000)
    expect(summary.p95CleanMs).toBe(4_000)
    expect(summary.pass).toBe(false)
  })

  it('has no verdict to give without samples', () => {
    expect(summarizeLatency([], 0).pass).toBe(false)
  })
})

describe('free tier lines', () => {
  it('extrapolates storage growth against the working ceiling', () => {
    const growth = storageGrowth([
      probe({ atMs: START, slot: 1, dbBytes: 100 * 1024 * 1024, decisionRows: 1_000 }),
      probe({ atMs: START + DAY_MS, slot: 2, dbBytes: 120 * 1024 * 1024, decisionRows: 11_000 }),
    ])

    expect(growth.rowsPerDay).toBe(10_000)
    expect(growth.bytesPerDay).toBe(20 * 1024 * 1024)
    expect(growth.daysToCeiling).toBe(14)
  })

  it('sees a restart as uptime running backwards', () => {
    const measured = availability([
      probe({ atMs: START, slot: 1, uptimeSeconds: 3_600, publisherPasses: 1_800 }),
      probe({ atMs: START + 3_600_000, slot: 2, uptimeSeconds: 7_200, publisherPasses: 3_600 }),
      probe({ atMs: START + 7_200_000, slot: 3, uptimeSeconds: 120, publisherPasses: 60 }),
    ])

    expect(measured.restarts).toBe(1)
    // 1 800 before the restart, 60 after it — never the negative difference of
    // the two observations of a counter that lives inside the process.
    expect(measured.publisherPasses).toBe(1_860)
    expect(measured.monthlyInstanceHours).toBe(720)
    expect(measured.freeInstanceHours).toBe(750)
  })
})
