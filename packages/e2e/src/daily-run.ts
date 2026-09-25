import { percentile, SC001_MAX_MS } from './decision-loop.js'
import { randomFrom } from './generator.js'

/**
 * The day-long run behind T064: SC-004, SC-008 and an honest SC-001, measured
 * against the deployed system instead of against a harness-owned copy of it.
 *
 * Three criteria, three different units of measurement, and confusing them
 * would mean counting a constant instead of a quantity:
 *
 * - **SC-001 — one decision.** The clock starts when the agent's decision is
 *   complete, which is *before* `submit` is entered, and stops at the first
 *   `verified` verdict from the independent verifier. Polling granularity is
 *   counted against us, never for us.
 * - **SC-004 — one window, not one decision.** The fee of a single anchor is a
 *   constant (one signature, 5 000 lamports); it does not need measuring, it
 *   needs reading. What has to be measured is the *amortised* cost — resends,
 *   dropped transactions, any priority fee — and those only exist over a
 *   distance. So the value is lamports spent by the payer over a window,
 *   divided by decisions anchored in that same window, both bounded by a
 *   **slot** rather than by the process clock. A transaction confirmed on the
 *   hour boundary would otherwise land in one window's numerator and another
 *   window's denominator.
 * - **SC-008 — one provider quota line per day.** Not "what it cost" but how
 *   much was consumed in each provider's own unit, extrapolated over a month
 *   against that provider's own ceiling.
 *
 * Nothing here starts a publisher. The publisher under measurement is the one
 * running inside the deployed API process; this module only ever acts as a
 * client and an observer. That is what keeps the instrument out of the rate
 * budget of the thing it measures — the earlier harness polled the chain from
 * ten parallel waiters, collected 429s from the provider, and then reported the
 * delay it had caused as a property of the product.
 */

/** SC-004: cost of publishing one decision, at a volume of 10 000 a day. */
export const SC004_MAX_USD_PER_DECISION = 0.001

export const LAMPORTS_PER_SOL = 1_000_000_000
export const DAY_MS = 24 * 60 * 60 * 1000

/** The volume both SC-004 and SC-008 name. Arrivals are spread across a day. */
export const DEFAULT_DECISIONS_PER_DAY = 10_000

/**
 * One arrival in this many is measured for SC-001. Verifying all of them would
 * send ten thousand verification passes at the chain from the measuring side
 * alone — the instrument would once again be the loudest client on the line.
 * Every 35th of 10 000 leaves 285 samples spread across the whole day, so p95
 * sees the worst hours and not merely the first ten minutes.
 */
export const DEFAULT_SAMPLE_EVERY = 35

/**
 * The arrival stream is seeded from the run's `seedBase` with a fixed offset,
 * so it is reproducible without ever sharing a stream with the generator that
 * builds a decision's own contents.
 */
const SCHEDULE_SEED_OFFSET = 0x5eed

export interface ScheduleEntry {
  readonly ordinal: number
  /** Seed handed to the decision generator; `decisionId` is derived from it. */
  readonly seed: number
  /** Absolute wall-clock instant, not an offset: a restart must not catch up. */
  readonly atMs: number
  /** Whether this arrival carries an SC-001 waiter. Chosen in the plan, never after the fact. */
  readonly sampled: boolean
}

export interface ScheduleOptions {
  readonly seedBase: number
  readonly count: number
  readonly startedAt: number
  readonly spanMs?: number
  readonly sampleEvery?: number
}

/**
 * Arrival times as **sorted uniforms over the window**, which is exactly a
 * Poisson process conditioned on it producing `count` events in that window —
 * and, unlike drawing exponential gaps one after another, it fixes both the
 * count and the span, so the run really does end after a day and really does
 * submit the number the criterion names.
 *
 * Poisson rather than a metronome on purpose: an evenly spaced stream phases in
 * with the publisher's two-second tick and lands at the same offset inside every
 * pass, which quietly biases SC-001 in one direction or the other. Uniform
 * arrivals see a uniform offset inside the pass — which is what a real decision
 * sees.
 */
export function buildSchedule(options: ScheduleOptions): readonly ScheduleEntry[] {
  const span = options.spanMs ?? DAY_MS
  const sampleEvery = options.sampleEvery ?? DEFAULT_SAMPLE_EVERY
  const random = randomFrom(options.seedBase + SCHEDULE_SEED_OFFSET)

  const offsets = Array.from({ length: options.count }, () => random() * span).sort((a, b) => a - b)

  return offsets.map((offset, index) => ({
    ordinal: index + 1,
    seed: options.seedBase + index + 1,
    atMs: options.startedAt + Math.round(offset),
    sampled: (index + 1) % sampleEvery === 0,
  }))
}

/**
 * One hourly observation. Everything in it is read at the same moment so that
 * the cost window's numerator and denominator agree on where they stop.
 */
export interface Probe {
  readonly atMs: number
  /** Slot the balance was answered at — the boundary of the window, not `atMs`. */
  readonly slot: number
  readonly payerLamports: number
  /** Decisions anchored at or before `slot`, across all projects: the payer pays for all of them. */
  readonly anchoredUpToSlot: number
  readonly decisionRows: number
  readonly dbBytes: number
  /** Deployed process uptime, which resets on every restart of the free instance. */
  readonly uptimeSeconds: number
  readonly publisherPasses: number
}

export type CostWindowNote = 'topped-up' | 'no-decisions'

export interface CostWindow {
  readonly fromMs: number
  readonly toMs: number
  readonly fromSlot: number
  readonly toSlot: number
  readonly spentLamports: number
  readonly anchored: number
  /** `NaN` whenever the window carries a note: a noted window has no honest ratio. */
  readonly lamportsPerDecision: number
  readonly note?: CostWindowNote
}

/**
 * A negative spend is a top-up of the payer, not a refund, and averaging it in
 * would hand us a cost per decision that the chain never charged. It is named
 * and excluded rather than silently dropped.
 */
export function costWindows(probes: readonly Probe[]): readonly CostWindow[] {
  const windows: CostWindow[] = []

  for (let index = 1; index < probes.length; index += 1) {
    const before = probes[index - 1]
    const after = probes[index]
    if (before === undefined || after === undefined) continue

    const spentLamports = before.payerLamports - after.payerLamports
    const anchored = after.anchoredUpToSlot - before.anchoredUpToSlot
    const note: CostWindowNote | undefined =
      spentLamports < 0 ? 'topped-up' : anchored <= 0 ? 'no-decisions' : undefined

    windows.push({
      fromMs: before.atMs,
      toMs: after.atMs,
      fromSlot: before.slot,
      toSlot: after.slot,
      spentLamports,
      anchored,
      lamportsPerDecision: note === undefined ? spentLamports / anchored : Number.NaN,
      ...(note === undefined ? {} : { note }),
    })
  }

  return windows
}

export interface CostSummary {
  readonly windows: readonly CostWindow[]
  readonly countedWindows: number
  readonly notedWindows: number
  readonly spentLamports: number
  readonly anchored: number
  readonly lamportsPerDecision: number
  readonly usdPerDecision: number
  /** SOL price at which the measured cost sits exactly on the SC-004 threshold. */
  readonly breakEvenSolUsd: number
  readonly pass: boolean
}

/**
 * The totals come from the counted windows only. Summing the whole run's
 * balance delta instead would let one top-up turn the day's cost negative and
 * report a pass that nothing measured.
 */
export function summarizeCost(probes: readonly Probe[], solUsd: number): CostSummary {
  const windows = costWindows(probes)
  const counted = windows.filter((one) => one.note === undefined)

  const spentLamports = counted.reduce((sum, one) => sum + one.spentLamports, 0)
  const anchored = counted.reduce((sum, one) => sum + one.anchored, 0)
  const lamportsPerDecision = anchored > 0 ? spentLamports / anchored : Number.NaN
  const solPerDecision = lamportsPerDecision / LAMPORTS_PER_SOL

  return {
    windows,
    countedWindows: counted.length,
    notedWindows: windows.length - counted.length,
    spentLamports,
    anchored,
    lamportsPerDecision,
    usdPerDecision: solPerDecision * solUsd,
    breakEvenSolUsd: SC004_MAX_USD_PER_DECISION / solPerDecision,
    pass: solPerDecision * solUsd <= SC004_MAX_USD_PER_DECISION,
  }
}

export interface Gap {
  readonly fromMs: number
  readonly toMs: number
  readonly missed: number
}

export interface Coverage {
  readonly planned: number
  readonly attempted: number
  readonly missed: number
  readonly spanMs: number
  readonly uncoveredMs: number
  readonly fraction: number
  readonly gaps: readonly Gap[]
  readonly longestGapMs: number
}

/**
 * How much of the day the run actually covered, measured against the plan
 * rather than against itself. A gap runs from the planned instant of the first
 * arrival that was never attempted to the planned instant of the next arrival
 * that was — that is precisely the stretch during which the deployed system saw
 * no load from us, and a single missed arrival honestly costs one inter-arrival
 * of coverage instead of costing nothing.
 */
export function coverage(
  schedule: readonly ScheduleEntry[],
  attempted: ReadonlySet<number>,
): Coverage {
  const first = schedule[0]
  const last = schedule[schedule.length - 1]
  const spanMs = first === undefined || last === undefined ? 0 : last.atMs - first.atMs

  const gaps: Gap[] = []
  let openedAt: number | undefined
  let missedInGap = 0

  for (const entry of schedule) {
    if (attempted.has(entry.ordinal)) {
      if (openedAt !== undefined) {
        gaps.push({ fromMs: openedAt, toMs: entry.atMs, missed: missedInGap })
        openedAt = undefined
        missedInGap = 0
      }
      continue
    }
    if (openedAt === undefined) openedAt = entry.atMs
    missedInGap += 1
  }
  // A gap still open at the end of the plan closes at the end of the plan: the
  // run stopped early, and the day is short by exactly that much.
  if (openedAt !== undefined && last !== undefined) {
    gaps.push({ fromMs: openedAt, toMs: last.atMs, missed: missedInGap })
  }

  const uncoveredMs = gaps.reduce((sum, one) => sum + (one.toMs - one.fromMs), 0)

  return {
    planned: schedule.length,
    attempted: attempted.size,
    missed: schedule.length - attempted.size,
    spanMs,
    uncoveredMs,
    fraction: spanMs > 0 ? Math.max(0, 1 - uncoveredMs / spanMs) : 0,
    gaps,
    longestGapMs: gaps.reduce((worst, one) => Math.max(worst, one.toMs - one.fromMs), 0),
  }
}

export interface LatencySample {
  readonly ordinal: number
  readonly decisionId: string
  /** From decision complete to the anchor being visible in the public read. */
  readonly anchorSeenMs: number
  /** From decision complete to the first `verified` verdict. `NaN` if it never came. */
  readonly verifiableMs: number
  /**
   * Largest single-iteration overshoot of wall clock over the poll interval.
   * A suspended host inflates a sample, and a sample inflated by the host is
   * still a sample: it stays in the population and is named, because dropping
   * it would be choosing which measurements to believe after seeing them.
   */
  readonly clockJumpMs: number
}

/** A poll iteration that overshoots its interval by more than this has seen the host stop. */
export const CLOCK_JUMP_MS = 5_000

export interface LatencySummary {
  readonly samples: number
  readonly verified: number
  readonly timedOut: number
  readonly skipped: number
  readonly suspect: number
  readonly p50Ms: number
  readonly p95Ms: number
  readonly worstMs: number
  /** p95 over the samples no clock jump touched — annotation, never the verdict. */
  readonly p95CleanMs: number
  readonly anchorP95Ms: number
  readonly pass: boolean
}

export function summarizeLatency(
  samples: readonly LatencySample[],
  skipped: number,
): LatencySummary {
  const verifiable = samples.map((one) => one.verifiableMs)
  const verified = verifiable.filter((one) => Number.isFinite(one))
  const clean = samples
    .filter((one) => one.clockJumpMs < CLOCK_JUMP_MS && Number.isFinite(one.verifiableMs))
    .map((one) => one.verifiableMs)

  const p95Ms = percentile(verifiable, 95)

  return {
    samples: samples.length,
    verified: verified.length,
    timedOut: samples.length - verified.length,
    skipped,
    suspect: samples.filter((one) => one.clockJumpMs >= CLOCK_JUMP_MS).length,
    p50Ms: percentile(verifiable, 50),
    p95Ms,
    worstMs: verified.length === 0 ? Number.NaN : Math.max(...verified),
    p95CleanMs: percentile(clean, 95),
    anchorP95Ms: percentile(
      samples.map((one) => one.anchorSeenMs),
      95,
    ),
    // Every sampled decision has to become verifiable: a timed-out sample is a
    // decision that never reached the criterion, not a sample that went missing.
    pass: verified.length === samples.length && samples.length > 0 && p95Ms <= SC001_MAX_MS,
  }
}

export interface StorageGrowth {
  readonly bytesPerDay: number
  readonly rowsPerDay: number
  readonly bytesNow: number
  readonly rowsNow: number
  /** Working ceiling from PLAN.md — 400 MB of the 500 MB Supabase gives. */
  readonly ceilingBytes: number
  readonly monthlyBytes: number
  readonly daysToCeiling: number
}

export const SUPABASE_WORKING_CEILING_BYTES = 400 * 1024 * 1024

export function storageGrowth(probes: readonly Probe[]): StorageGrowth {
  const first = probes[0]
  const last = probes[probes.length - 1]
  if (first === undefined || last === undefined || last.atMs <= first.atMs) {
    return {
      bytesPerDay: Number.NaN,
      rowsPerDay: Number.NaN,
      bytesNow: last?.dbBytes ?? Number.NaN,
      rowsNow: last?.decisionRows ?? Number.NaN,
      ceilingBytes: SUPABASE_WORKING_CEILING_BYTES,
      monthlyBytes: Number.NaN,
      daysToCeiling: Number.NaN,
    }
  }

  const days = (last.atMs - first.atMs) / DAY_MS
  const bytesPerDay = (last.dbBytes - first.dbBytes) / days

  return {
    bytesPerDay,
    rowsPerDay: (last.decisionRows - first.decisionRows) / days,
    bytesNow: last.dbBytes,
    rowsNow: last.decisionRows,
    ceilingBytes: SUPABASE_WORKING_CEILING_BYTES,
    monthlyBytes: bytesPerDay * 30,
    daysToCeiling:
      bytesPerDay > 0 ? (SUPABASE_WORKING_CEILING_BYTES - last.dbBytes) / bytesPerDay : Number.NaN,
  }
}

export interface Availability {
  readonly restarts: number
  readonly observedMs: number
  /** Monthly instance-hours the run implies, against Render's 750 free hours. */
  readonly monthlyInstanceHours: number
  readonly freeInstanceHours: number
  readonly publisherPasses: number
}

export const RENDER_FREE_INSTANCE_HOURS = 750

/**
 * A restart shows up as uptime running backwards; nothing else does. The free
 * instance stays awake for as long as traffic keeps arriving, and this run is
 * that traffic — which is why the implied monthly figure is simply the whole
 * month, and why it is worth printing next to the 750 free hours.
 */
export function availability(probes: readonly Probe[]): Availability {
  const first = probes[0]
  const last = probes[probes.length - 1]
  let restarts = 0
  // Passes are counted per segment between restarts: the counter lives in the
  // process, so subtracting the first observation from the last would hand back
  // a negative number the moment the free instance is recycled.
  let publisherPasses = 0

  for (let index = 1; index < probes.length; index += 1) {
    const before = probes[index - 1]
    const after = probes[index]
    if (before === undefined || after === undefined) continue

    if (after.uptimeSeconds < before.uptimeSeconds) {
      restarts += 1
      publisherPasses += after.publisherPasses
      continue
    }
    publisherPasses += after.publisherPasses - before.publisherPasses
  }

  return {
    restarts,
    observedMs: first === undefined || last === undefined ? 0 : last.atMs - first.atMs,
    monthlyInstanceHours: 24 * 30,
    freeInstanceHours: RENDER_FREE_INSTANCE_HOURS,
    publisherPasses,
  }
}
