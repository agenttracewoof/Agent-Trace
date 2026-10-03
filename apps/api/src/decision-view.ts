import type { AnchorReference } from '@agenttrace/shared'

/**
 * How a stored decision is shown, shared by every route that shows one —
 * the public read and the dashboard — so the two cannot drift apart on what
 * counts as "anchored".
 */

export interface AnchorColumns {
  readonly anchorSignature: string | null
  readonly anchorSlot: number | null
  readonly anchoredAt: Date | null
}

/** Our record of where the anchor went: a pointer to the proof, not the proof. */
export const anchorOf = (row: AnchorColumns): AnchorReference | null =>
  row.anchorSignature === null || row.anchorSlot === null || row.anchoredAt === null
    ? null
    : {
        transactionSignature: row.anchorSignature,
        slot: row.anchorSlot,
        anchoredAt: row.anchoredAt.toISOString(),
      }
