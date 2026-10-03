import { hexDigest } from '@agenttrace/manifest'
import { z } from 'zod'
import { decisionStatusSchema } from './ingest.js'
import { anchorReferenceSchema } from './public.js'

/**
 * The dashboard's view of a project's decisions (FR-016, T039). Same rule as
 * `ingest.ts` — requests are strict, responses may grow.
 *
 * Time is milliseconds here, as the manifest signs it, not ISO: the format
 * bounds `decidedAt` only by 2^53, a `Date` stops at 8.64e15, and one decision
 * from an agent with a broken clock would otherwise turn a whole project's
 * journal into a 500.
 */

export const JOURNAL_PAGE_DEFAULT = 50
export const JOURNAL_PAGE_MAX = 100

const millis = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

/**
 * Every field is a query-string value, hence the coercion. `.optional()` sits
 * outermost so an absent key never reaches `coerce` (`Number(undefined)` is
 * NaN, and the whole query would fail on a filter nobody set).
 */
export const journalQuerySchema = z.strictObject({
  agentId: z.uuid().optional(),
  /** Inclusive, on the signed `decidedAt`. */
  from: millis.optional(),
  /** Exclusive: consecutive periods `[a, b)`, `[b, c)` neither overlap nor leave a gap. */
  to: millis.optional(),
  /**
   * Where anchoring stands, not whether the decision checks out: our API
   * reads no chain and so never says `verified` (`public.ts`).
   */
  status: decisionStatusSchema.optional(),
  /** Opaque: whatever `nextCursor` said, passed back unchanged. */
  cursor: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(JOURNAL_PAGE_MAX).optional(),
})

export const journalAgentSchema = z.object({
  id: z.uuid(),
  /** The client's own name for the agent, as it registered. */
  externalId: z.string(),
  name: z.string(),
})

export const journalEntrySchema = z.object({
  /** The 32-hex form, the same one the public link and the chain carry. */
  decisionId: hexDigest(16),
  agent: journalAgentSchema,
  model: z.string(),
  /** Signed by the agent, milliseconds. The journal is ordered by it. */
  decidedAt: z.int().min(0),
  /** Our clock, when ingest accepted it — beside `decidedAt` so a skewed agent shows. */
  receivedAt: z.iso.datetime(),
  status: decisionStatusSchema,
  anchor: anchorReferenceSchema.nullable(),
  contentDeletedAt: z.iso.datetime().nullable(),
})

export const journalResponseSchema = z.object({
  decisions: z.array(journalEntrySchema),
  /** `null` on the last page. */
  nextCursor: z.string().nullable(),
})

export type JournalQuery = z.infer<typeof journalQuerySchema>
export type JournalAgent = z.infer<typeof journalAgentSchema>
export type JournalEntry = z.infer<typeof journalEntrySchema>
export type JournalResponse = z.infer<typeof journalResponseSchema>
