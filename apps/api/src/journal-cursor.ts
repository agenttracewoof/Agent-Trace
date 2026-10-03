/**
 * Where the next journal page starts: the last row of this one, by the same
 * key the journal is ordered on, `(decided_at, id)` descending (`PLAN.md` →
 * "Keyset, not offset"). `id` is there because `decided_at` is not unique — an
 * agent that decides twice in one millisecond would otherwise lose a row
 * between pages.
 *
 * Opaque to the client so the key can change without breaking a link, but not
 * signed: a forged cursor can only move the page within a project the caller
 * is already a member of.
 */
export interface JournalCursor {
  readonly decidedAt: number
  /** 32 hex, the decision's public form. */
  readonly decisionId: string
}

const SHAPE = /^(0|[1-9][0-9]{0,15}):([0-9a-f]{32})$/

export const encodeJournalCursor = (cursor: JournalCursor): string =>
  Buffer.from(`${cursor.decidedAt}:${cursor.decisionId}`, 'utf8').toString('base64url')

/** `undefined` for anything `encodeJournalCursor` could not have produced. */
export function decodeJournalCursor(value: string): JournalCursor | undefined {
  const match = SHAPE.exec(Buffer.from(value, 'base64url').toString('utf8'))
  const decidedAt = Number(match?.[1])
  const decisionId = match?.[2]
  if (decisionId === undefined || !Number.isSafeInteger(decidedAt)) return undefined
  return { decidedAt, decisionId }
}
