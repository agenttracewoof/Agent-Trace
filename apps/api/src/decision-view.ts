import { agentKeys, decisions } from '@agenttrace/db'
import { signedManifestSchema } from '@agenttrace/manifest'
import type { AnchorReference, PublicDecisionResponse } from '@agenttrace/shared'
import { type DecisionEvidence, verifyDecision } from '@agenttrace/verify'

/**
 * How a stored decision is shown, shared by every route that shows one —
 * the public read and the dashboard — so the two cannot drift apart on what
 * counts as "anchored" or give one decision two verdicts.
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

/**
 * What `presentDecision` needs, as a `select` — joined with `agent_keys` on
 * `agent_keys.id = decisions.agent_key_id`, since the manifest names its key.
 */
export const decisionViewColumns = {
  manifestVersion: decisions.manifestVersion,
  agentPubkey: agentKeys.publicKey,
  modelRef: decisions.modelRef,
  sources: decisions.sources,
  root: decisions.root,
  decidedAt: decisions.decidedAt,
  outcome: decisions.outcome,
  steps: decisions.steps,
  signature: decisions.signature,
  anchorSignature: decisions.anchorSignature,
  anchorSlot: decisions.anchorSlot,
  anchoredAt: decisions.anchoredAt,
  archiveUrl: decisions.archiveUrl,
  archivedAt: decisions.archivedAt,
  contentDeletedAt: decisions.contentDeletedAt,
}

export interface DecisionRow {
  readonly manifestVersion: number
  readonly agentPubkey: string
  readonly modelRef: string
  readonly sources: string[]
  readonly root: string
  readonly decidedAt: number
  readonly outcome: unknown
  readonly steps: unknown
  readonly signature: string
  readonly anchorSignature: string | null
  readonly anchorSlot: number | null
  readonly anchoredAt: Date | null
  readonly archiveUrl: string | null
  readonly archivedAt: Date | null
  readonly contentDeletedAt: Date | null
}

/**
 * Рядок бази — це розібраний манифест, а не сам манифест. Складаємо його назад
 * рівно у тій формі, у якій його підписали: будь-яка вільність тут зробила б
 * чесне рішення схожим на підроблене, і побачив би це не власник, а стороння
 * людина за посиланням.
 */
function envelopeOf(row: DecisionRow, decisionId: string): unknown {
  return {
    manifest: {
      version: row.manifestVersion,
      agentPubkey: row.agentPubkey,
      decisionId,
      model: row.modelRef,
      sources: row.sources,
      root: row.root,
      decidedAt: row.decidedAt,
      outcome: row.outcome,
      steps: row.steps,
    },
    signature: row.signature,
  }
}

const archiveOf = (row: DecisionRow): PublicDecisionResponse['archive'] =>
  row.archiveUrl === null || row.archivedAt === null
    ? null
    : { url: row.archiveUrl, archivedAt: row.archivedAt.toISOString() }

/** The stored decision as the public read answers for it (FR-011, FR-013, FR-020). */
export async function presentDecision(
  row: DecisionRow,
  decisionId: string,
): Promise<PublicDecisionResponse> {
  const deleted = row.contentDeletedAt !== null
  const envelope = envelopeOf(row, decisionId)

  /**
   * Стан рахує **та сама функція**, що й незалежний verifier, і на тих самих
   * даних. Своя перевірка тут була б другою правдою: сторінка казала б одне,
   * а `agenttrace-verify` на тому ж рішенні — інше, і жодного способу
   * дізнатися, хто з них має рацію, у людини немає.
   */
  const evidence: DecisionEvidence = deleted
    ? { absence: 'content-deleted' }
    : { manifest: envelope }
  const verdict = await verifyDecision(evidence)

  /**
   * Конверт віддається лише таким, яким його пропустила строга схема формату.
   * У ній приватний крок не має полів вмісту **взагалі** (FR-020), тож
   * опублікувати вміст приватного кроку неможливо навіть тоді, коли він
   * якимось чином опинився у сховищі: такий рядок схему не пройде, конверт
   * стане `null`, а стан — `tampered`. Вирізання полів на виході дало б
   * слабшу обіцянку, бо трималося б на тому, чи не забули ми поле.
   */
  const parsed = deleted ? undefined : signedManifestSchema.safeParse(envelope)

  const body: PublicDecisionResponse = {
    decisionId,
    signedManifest: parsed?.success === true ? parsed.data : null,
    anchor: anchorOf(row),
    archive: archiveOf(row),
    contentDeletedAt: row.contentDeletedAt?.toISOString() ?? null,
    verification: {
      // Присвоєння нижче і є звіркою двох переліків станів: щойно verifier
      // заведе новий стан або застереження, цей рядок перестане типчекатися.
      status: verdict.status,
      discrepancies: verdict.discrepancies.map((one) => ({
        code: one.code,
        detail: one.detail,
      })),
      caveats: [...verdict.caveats],
      keyContinuity: verdict.keyContinuity,
      ...(verdict.origin === undefined ? {} : { origin: verdict.origin }),
      /**
       * Завжди `false`, і поле існує саме заради цього слова: воно каже
       * читачеві, що ланцюг ніхто не читав, тож найсильніше, що тут може
       * стояти, — `pending`. Прочитати ланцюг і сказати `verified` має право
       * лише той, хто зробив це сам.
       */
      includesChain: false,
    },
  }

  return body
}
