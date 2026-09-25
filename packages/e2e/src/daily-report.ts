#!/usr/bin/env tsx
import { readFileSync } from 'node:fs'
import {
  availability,
  buildSchedule,
  coverage,
  DAY_MS,
  LAMPORTS_PER_SOL,
  type LatencySample,
  type Probe,
  SC004_MAX_USD_PER_DECISION,
  type ScheduleEntry,
  storageGrowth,
  summarizeCost,
  summarizeLatency,
} from './daily-run.js'
import { SC001_MAX_MS } from './decision-loop.js'

/**
 * The reducer for a day-long run. It is a separate program from the one that
 * produced the log on purpose: a harness that both measures and summarises
 * itself has no witness, and the run has to be re-readable after the session
 * that started it is gone.
 *
 *   pnpm --filter @agenttrace/e2e daily:report -- .runs/run-1000000.jsonl [SOL_USD]
 */

const field = (row: Record<string, unknown>, name: string): unknown => row[name]

const asNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN

// pnpm forwards the `--` separator itself, so it arrives as a literal argument.
const argv = process.argv.slice(2).filter((one) => one !== '--')
const [logPath, priceArgument] = argv
if (logPath === undefined) {
  process.stderr.write('usage: daily:report -- <run.jsonl> [SOL_USD]\n')
  process.exit(1)
}
const solUsd = Number(priceArgument ?? process.env.SOL_USD ?? Number.NaN)

const events: Record<string, unknown>[] = []
for (const line of readFileSync(logPath, 'utf8').split('\n')) {
  if (line.trim() === '') continue
  const parsed: unknown = JSON.parse(line)
  if (typeof parsed === 'object' && parsed !== null) events.push(parsed as Record<string, unknown>)
}

const of = (kind: string): Record<string, unknown>[] =>
  events.filter((one) => field(one, 't') === kind)

const header = of('run')[0]
if (header === undefined) {
  process.stderr.write(`${logPath} carries no run header\n`)
  process.exit(1)
}

const seedBase = asNumber(field(header, 'seedBase'))
const startedAt = asNumber(field(header, 'startedAt'))
const spanMs = asNumber(field(header, 'spanMs'))
const volume = asNumber(field(header, 'count'))
const sampleEvery = asNumber(field(header, 'sampleEvery'))

const schedule: readonly ScheduleEntry[] = buildSchedule({
  seedBase,
  count: volume,
  startedAt,
  spanMs,
  sampleEvery,
})

const submitted = of('submit')
const attempted = new Set(submitted.map((one) => asNumber(field(one, 'ordinal'))))
const covered = coverage(schedule, attempted)

const samples: LatencySample[] = of('latency').map((one) => ({
  ordinal: asNumber(field(one, 'ordinal')),
  decisionId: String(field(one, 'decisionId')),
  anchorSeenMs: asNumber(field(one, 'anchorSeenMs')),
  verifiableMs: asNumber(field(one, 'verifiableMs')),
  clockJumpMs: asNumber(field(one, 'clockJumpMs')) || 0,
}))
const latency = summarizeLatency(samples, of('skip').length)

const probes: Probe[] = of('probe').map((one) => ({
  atMs: asNumber(field(one, 'at')),
  slot: asNumber(field(one, 'slot')),
  payerLamports: asNumber(field(one, 'payerLamports')),
  anchoredUpToSlot: asNumber(field(one, 'anchoredUpToSlot')),
  decisionRows: asNumber(field(one, 'decisionRows')),
  dbBytes: asNumber(field(one, 'dbBytes')),
  uptimeSeconds: asNumber(field(one, 'uptimeSeconds')),
  publisherPasses: asNumber(field(one, 'publisherPasses')),
}))

const cost = summarizeCost(probes, solUsd)
const storage = storageGrowth(probes)
const uptime = availability(probes)

const lastProbe = probes[probes.length - 1]
const harnessChainCalls = asNumber(field(of('end')[0] ?? header, 'harnessChainCalls')) || 0

const sdkMs = submitted.map((one) => asNumber(field(one, 'sdkMs'))).filter(Number.isFinite)
const sdkWorst = sdkMs.length === 0 ? Number.NaN : Math.max(...sdkMs)

const verdict = (ok: boolean) => (ok ? 'pass' : 'FAIL')
const ms = (value: number) => (Number.isFinite(value) ? `${Math.round(value)} ms` : '—')
const hours = (value: number) => (value / 3_600_000).toFixed(1)
const mb = (value: number) => (value / (1024 * 1024)).toFixed(1)
const usd = (value: number) => (Number.isFinite(value) ? `$${value.toFixed(6)}` : '—')

/**
 * The definitions are printed with the numbers, not kept in a document beside
 * them. A figure whose unit has to be looked up elsewhere gets quoted without
 * its unit, and this run exists precisely because the three criteria are
 * measured in three different ones.
 */
const lines = [
  `run                  seed base ${seedBase}, ${volume} decisions planned over ${hours(spanMs)} h`,
  `                     against ${String(field(header, 'endpoint'))}`,
  '',
  'one measurement',
  '  SC-001             one decision: from the decision being complete (before submit)',
  `                     to the first verified verdict. +0…1 s of poll granularity,`,
  '                     counted against us. Sampled every ' +
    `${sampleEvery}th arrival, chosen in the plan.`,
  '  SC-004             one window: lamports the payer spent, over decisions anchored',
  '                     in the same window, both bounded by slot rather than by clock.',
  '  SC-008             one provider quota line per day, in that provider’s own unit,',
  '                     extrapolated over 30 days against that provider’s ceiling.',
  '',
  'coverage',
  `  planned / sent     ${covered.planned} / ${covered.attempted}` +
    `  (${(100 * covered.fraction).toFixed(1)}% of the planned span covered)`,
  `  gaps               ${covered.gaps.length}, longest ${ms(covered.longestGapMs)}`,
  `  refused by ingest  ${String(field(of('end')[0] ?? {}, 'refusedByIngest') ?? '—')}`,
  '',
  `SC-001 p95           ${ms(latency.p95Ms)} of ${SC001_MAX_MS} ms · ${verdict(latency.pass)}`,
  `  samples            ${latency.samples} verified ${latency.verified}, timed out ${latency.timedOut}, skipped ${latency.skipped}`,
  `  p50 / worst        ${ms(latency.p50Ms)} / ${ms(latency.worstMs)}`,
  `  anchor visible p95 ${ms(latency.anchorP95Ms)}`,
  `  host-inflated      ${latency.suspect} sample(s); p95 without them ${ms(latency.p95CleanMs)}`,
  `SC-003 sdk worst     ${Number.isFinite(sdkWorst) ? sdkWorst.toFixed(1) : '—'} ms (inside the SC-001 clock, not beside it)`,
  '',
  `SC-004 per decision  ${cost.lamportsPerDecision.toFixed(0)} lamports · ${usd(cost.usdPerDecision)} at SOL $${solUsd} · ${verdict(cost.pass)}`,
  `  windows counted    ${cost.countedWindows} (${cost.notedWindows} noted and excluded)`,
  `  spent / anchored   ${(cost.spentLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL over ${cost.anchored} decisions`,
  `  breaks at          SOL $${cost.breakEvenSolUsd.toFixed(2)} — the threshold is crossed by the market, not by us`,
  `  budget             ${usd(SC004_MAX_USD_PER_DECISION)} per decision`,
  '',
  'SC-008 free tier, per provider unit, extrapolated × 30',
  `  Solana fees        ${((cost.lamportsPerDecision * 10_000 * 30) / LAMPORTS_PER_SOL).toFixed(2)} SOL/month at 10 000/day — the one non-zero line`,
  `  Supabase database  ${mb(storage.bytesNow)} MB now, +${mb(storage.bytesPerDay)} MB/day, ceiling ${mb(storage.ceilingBytes)} MB`,
  `                     ${Number.isFinite(storage.daysToCeiling) ? `${storage.daysToCeiling.toFixed(0)} days of headroom — this is why FR-028 exists` : 'no growth observed'}`,
  `  Render instance    ${uptime.restarts} restart(s) observed; awake under our traffic implies ${uptime.monthlyInstanceHours} h/month of ${uptime.freeInstanceHours} free`,
  `  Helius, our side   product calls ${uptime.publisherPasses} publisher passes + ${cost.anchored} sends;`,
  `                     harness calls ${harnessChainCalls}, excluded — the instrument is not the product`,
  '  GitHub Pages       not exercised by this run',
  '',
  'what this does not say',
  '  · credits and instance hours above are OUR count of calls, not the provider’s bill.',
  '    the owner has to read the two dashboards; a call is not a credit.',
  '  · the free instance never slept: our own traffic kept it awake every few seconds,',
  '    so the cold-start path is not in this sample and a low-volume customer would eat it.',
  '  · the anchor half is independent; the envelope still came from our own public read,',
  '    because nobody writes it to owner storage yet (T055).',
  `  · decisions are synthetic (T070). the chain, the fees and the verdict are not.`,
]

if (lastProbe !== undefined) {
  lines.push(
    '',
    `last probe           slot ${lastProbe.slot}, payer ${(lastProbe.payerLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL, ${lastProbe.decisionRows} rows`,
  )
}

process.stdout.write(`${lines.join('\n')}\n`)

// A day that covered less than most of itself has not measured a day, whatever
// its percentiles say. The exit code carries that, so a caller cannot read the
// numbers without reading the coverage.
const enough = covered.fraction >= 0.9 && spanMs >= DAY_MS * 0.9
process.exit(latency.pass && cost.pass && enough ? 0 : 1)
