#!/usr/bin/env tsx
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDb, decisions } from '@agenttrace/db'
import { createClient } from '@agenttrace/sdk'
import { Connection, PublicKey } from '@solana/web3.js'
import { and, count, isNotNull, lte, sql } from 'drizzle-orm'
import {
  buildSchedule,
  DAY_MS,
  DEFAULT_DECISIONS_PER_DAY,
  DEFAULT_SAMPLE_EVERY,
  type ScheduleEntry,
} from './daily-run.js'
import { publicRead, verifiedNow } from './decision-loop.js'
import { DEMO_REDACTION_POLICY, generateDecision } from './generator.js'

/**
 * The day-long run of T064. It submits decisions to the **deployed** API at the
 * rate the criteria name — 10 000 a day, which is one every 8.6 seconds — and
 * observes what the deployed publisher does with them. It starts no publisher
 * of its own: the instrument must not compete for the rate budget of the thing
 * it measures.
 *
 * Everything it learns goes to an append-only JSONL log, one event per line, so
 * that the run can outlive the session that started it and so that the report
 * is produced by a separate reducer (`daily-report.ts`) reading facts rather
 * than by this process summarising itself. Restarting against the same log
 * resumes the same plan: arrivals whose instant has passed are recorded as
 * missed and are **not** sent in a burst to catch up.
 *
 *   E2E_SEED_BASE=1000000 pnpm --filter @agenttrace/e2e daily
 */

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json }

const required = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value === '') {
    process.stderr.write(`${name} is not set\n`)
    process.exit(1)
  }
  return value
}

const number = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    process.stderr.write(`${name} is not a number\n`)
    process.exit(1)
  }
  return parsed
}

const endpoint = required('E2E_ENDPOINT').replace(/\/+$/, '')
const ingestKey = required('E2E_INGEST_KEY')
const databaseUrl = required('DATABASE_URL')
const rpcUrl = required('SOLANA_RPC_URL')
// The public key only: the run never needs the payer's secret, and an
// instrument that cannot spend cannot spend by accident.
const payer = new PublicKey(required('E2E_PAYER_PUBKEY'))

/**
 * No default, on purpose. A second run against the same database with the same
 * base would send the **same** decision ids with different contents: ingest
 * would rightly answer 400, and the waiter would then find the *previous* run's
 * decision in the public read and time its own latency against it.
 */
const seedBase = number('E2E_SEED_BASE', Number.NaN)
if (!Number.isInteger(seedBase) || seedBase < 0) {
  process.stderr.write('E2E_SEED_BASE must be a non-negative integer, and must not repeat a run\n')
  process.exit(1)
}

const volume = number('E2E_COUNT', DEFAULT_DECISIONS_PER_DAY)
const spanMs = number('E2E_SPAN_MS', DAY_MS)
const sampleEvery = number('E2E_SAMPLE_EVERY', DEFAULT_SAMPLE_EVERY)
const probeEveryMs = number('E2E_PROBE_MS', 60 * 60 * 1000)

const runDir = process.env.E2E_RUN_DIR ?? join(process.cwd(), '.runs')
mkdirSync(runDir, { recursive: true })
const logPath = join(runDir, `run-${seedBase}.jsonl`)
const stateDir = join(runDir, `run-${seedBase}-state`)

const write = (event: Record<string, Json>): void => {
  appendFileSync(logPath, `${JSON.stringify({ ...event, at: Date.now() })}\n`)
}

/**
 * The plan is rebuilt from the run header rather than from "now", so a restart
 * lands on exactly the schedule the first start drew. Without this the second
 * process would draw a fresh day, and every coverage figure would be fiction.
 */
function recoverStart(): number | undefined {
  if (!existsSync(logPath)) return undefined
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (line === '') continue
    const event: unknown = JSON.parse(line)
    if (typeof event === 'object' && event !== null && (event as { t?: unknown }).t === 'run') {
      const startedAt = (event as { startedAt?: unknown }).startedAt
      if (typeof startedAt === 'number') return startedAt
    }
  }
  return undefined
}

const resumedFrom = recoverStart()
const startedAt = resumedFrom ?? Date.now()
const schedule = buildSchedule({ seedBase, count: volume, startedAt, spanMs, sampleEvery })

const connection = new Connection(rpcUrl, 'confirmed')
const chainCalls = { count: 0 }

/** Our own chain traffic, counted so SC-008 can charge the product and not the instrument. */
const countedChain = new Proxy(connection, {
  get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver) as unknown
    if (typeof value !== 'function') return value
    return (...args: unknown[]) => {
      if (property === 'getTransaction' || property === 'getSignaturesForAddress') {
        chainCalls.count += 1
      }
      return (value as (...rest: unknown[]) => unknown).apply(target, args)
    }
  },
})

const client = await createClient({
  endpoint,
  ingestKey,
  agent: { externalId: `t064-daily-${seedBase}`, name: 'T064 daily run' },
  policy: DEMO_REDACTION_POLICY,
  stateDir,
  onError: (error) => write({ t: 'sdk-error', reason: error.message }),
})

/**
 * Two HTTP calls that save a day. If the first or the last decision id of this
 * range is already readable, the range has been used before, and everything the
 * run measured afterwards would be measured against someone else's rows.
 */
async function assertSeedRangeIsFree(): Promise<void> {
  const ends = [schedule[0], schedule[schedule.length - 1]].filter(
    (one): one is ScheduleEntry => one !== undefined,
  )
  for (const entry of ends) {
    const draft = generateDecision({ seed: entry.seed, agentPubkey: client.agentPubkey })
    const read = await publicRead(fetch, endpoint, draft.decisionId)
    if (read.status === 200) {
      process.stderr.write(
        `seed base ${seedBase} was used before: decision ${draft.decisionId} already exists. Shift E2E_SEED_BASE.\n`,
      )
      process.exit(1)
    }
  }
}

if (resumedFrom === undefined) await assertSeedRangeIsFree()

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

/**
 * How often a waiter asks about its own decision, and for how long it keeps
 * asking. A second rather than a quarter of one: every verification attempt
 * goes to the chain and competes for the same provider limit the publisher
 * uses. Three minutes rather than ten seconds: a decision that is not
 * verifiable after eighteen times the budget has failed the criterion, and
 * calling that "the harness stopped looking" would be the kinder of two lies.
 */
const POLL_MS = 1_000
const WAIT_CEILING_MS = 180_000

let waiter: Promise<void> | undefined

/**
 * SC-001 is wall time — "less than ten seconds" is a claim about the clock on
 * the wall, not about a counter that may or may not run while the host sleeps.
 * A suspended host therefore inflates the sample, which is why the size of the
 * jump travels with it instead of the sample being quietly discarded.
 */
async function measure(
  entry: ScheduleEntry,
  decisionId: string,
  startedWall: number,
): Promise<void> {
  let anchorSeenMs = Number.NaN
  let clockJumpMs = 0
  const deadline = startedWall + WAIT_CEILING_MS

  while (Date.now() < deadline) {
    const read = await publicRead(fetch, endpoint, decisionId)
    const anchor = (read.body as { anchor?: unknown } | undefined)?.anchor

    if (anchor !== null && anchor !== undefined) {
      if (!Number.isFinite(anchorSeenMs)) anchorSeenMs = Date.now() - startedWall
      const verdict = await verifiedNow(
        { endpoint, chain: countedChain },
        fetch,
        decisionId,
        client.agentPubkey,
      )
      if (verdict) {
        write({
          t: 'latency',
          ordinal: entry.ordinal,
          decisionId,
          anchorSeenMs,
          verifiableMs: Date.now() - startedWall,
          clockJumpMs,
        })
        return
      }
    }

    const before = Date.now()
    await sleep(POLL_MS)
    clockJumpMs = Math.max(clockJumpMs, Date.now() - before - POLL_MS)
  }

  write({
    t: 'latency',
    ordinal: entry.ordinal,
    decisionId,
    anchorSeenMs: Number.isFinite(anchorSeenMs) ? anchorSeenMs : null,
    verifiableMs: null,
    clockJumpMs,
    reason: 'wait-ceiling',
  })
}

let probing = false

async function probe(): Promise<void> {
  if (probing) return
  probing = true
  // A connection per probe rather than one held for a day: the pooler recycles
  // idle clients, and twenty-four connections a day cost nothing next to a
  // silently dead handle discovered at hour nineteen.
  const db = createDb(databaseUrl)
  try {
    const balance = await connection.getBalanceAndContext(payer, 'confirmed')
    const slot = balance.context.slot

    const [anchored] = await db
      .select({ n: count() })
      .from(decisions)
      .where(and(isNotNull(decisions.anchorSlot), lte(decisions.anchorSlot, slot)))
    const [rows] = await db.select({ n: count() }).from(decisions)
    const size = await db.execute(sql`select pg_database_size(current_database())::text as bytes`)
    const dbBytes = Number((size as unknown as readonly { bytes?: string }[])[0]?.bytes ?? 0)

    const health: unknown = await (await fetch(`${endpoint}/health`, { cache: 'no-store' })).json()
    const passes = (health as { checks?: { publisher?: { passes?: number } } }).checks?.publisher
      ?.passes

    write({
      t: 'probe',
      slot,
      payerLamports: balance.value,
      anchoredUpToSlot: anchored?.n ?? 0,
      decisionRows: rows?.n ?? 0,
      dbBytes,
      uptimeSeconds: Number((health as { uptimeSeconds?: number }).uptimeSeconds ?? 0),
      publisherPasses: Number(passes ?? 0),
      harnessChainCalls: chainCalls.count,
    })
  } catch (error) {
    write({ t: 'probe-failed', reason: error instanceof Error ? error.message : String(error) })
  } finally {
    await db.$client.end()
    probing = false
  }
}

write({
  t: 'run',
  startedAt,
  resumed: resumedFrom !== undefined,
  seedBase,
  count: volume,
  spanMs,
  sampleEvery,
  endpoint,
  payer: payer.toBase58(),
  agentPubkey: client.agentPubkey,
})

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true
    write({ t: 'stop', reason: signal })
  })
}

await probe()
// On its own timer, not inside the arrival loop: a probe that waits for the
// next arrival would drift with the plan, and one that ran inside it would
// push the arrival it preceded off its planned instant.
const probeTimer = setInterval(() => void probe(), probeEveryMs)

for (const entry of schedule) {
  if (stopping) break

  /**
   * A late arrival is recorded as missed and skipped. Firing the backlog would
   * be exactly the burst this whole design exists to avoid — and a restart is
   * precisely when the temptation to catch up appears.
   */
  if (Date.now() > entry.atMs + POLL_MS) {
    write({ t: 'missed', ordinal: entry.ordinal, plannedAt: entry.atMs })
    continue
  }
  while (Date.now() < entry.atMs && !stopping) {
    await sleep(Math.min(250, entry.atMs - Date.now()))
  }
  if (stopping) break

  const draft = generateDecision({
    seed: entry.seed,
    agentPubkey: client.agentPubkey,
    decidedAt: Date.now(),
  })

  // The clock starts here. The decision is complete before `submit` is entered,
  // and SC-001 is measured from the completion of the decision, not from the
  // moment our own SDK hands control back.
  const startedWall = Date.now()
  const startedMono = performance.now()
  try {
    await client.submit(draft)
    write({
      t: 'submit',
      ordinal: entry.ordinal,
      decisionId: draft.decisionId,
      plannedAt: entry.atMs,
      sdkMs: performance.now() - startedMono,
      sampled: entry.sampled,
    })
  } catch (error) {
    write({
      t: 'submit-failed',
      ordinal: entry.ordinal,
      decisionId: draft.decisionId,
      reason: error instanceof Error ? error.message : String(error),
    })
    continue
  }

  if (!entry.sampled) continue
  if (waiter !== undefined) {
    // Queued waiters are how the previous harness built its own burst. A sample
    // that cannot start on time is recorded as skipped, never deferred.
    write({ t: 'skip', ordinal: entry.ordinal, reason: 'waiter-busy' })
    continue
  }
  waiter = measure(entry, draft.decisionId, startedWall).finally(() => {
    waiter = undefined
  })
}

// The last sample is part of the day, so the run waits for it rather than
// cutting it off and calling it a timeout of its own making.
await waiter
clearInterval(probeTimer)
await client.flush()
await probe()
write({
  t: 'end',
  refusedByIngest: await client.rejected(),
  stillPending: await client.pending(),
  harnessChainCalls: chainCalls.count,
})

process.stdout.write(`${logPath}\n`)
process.exit(0)
