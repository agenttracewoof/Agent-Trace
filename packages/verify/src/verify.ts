import {
  type DecisionAnchor,
  decodeDecisionAnchor,
  hashValue,
  type Manifest,
  parseSignedManifest,
  type SignedManifest,
  stepsRoot,
  toHex,
  verifySignedManifest,
} from '@agenttrace/manifest'

/**
 * Перевірка рішення (FR-013, FR-014). Модуль **чистий**: жодного I/O, жодної
 * адреси, жодного знання про AgentTrace. Усі докази приходять аргументом, а
 * звідки їх узяти — питання шару джерел (T031). Саме ця межа робить FR-014
 * («достатньо публічних даних») перевіряємою, а не декларованою: функцію нижче
 * можна прогнати на фікстурах, не маючи ані мережі, ані нашого сервісу.
 */

/**
 * Стани за FR-013. Головне правило вимоги — «стан ніколи не показується
 * сильнішим, ніж він є» — тут закріплене формою типу: `verified` повертається
 * лише тоді, коли не лишилося **жодної** розбіжності і якір справді прочитаний.
 * Усе інше має власну назву, і жодна з них не є синонімом «усе гаразд».
 */
export type VerificationStatus =
  | 'verified'
  | 'pending'
  | 'tampered'
  | 'unavailable'
  | 'content-deleted'

/** Звідки прочитаний манифест: гаряче сховище чи архів власника (FR-028, FR-029). */
export type ManifestOrigin = 'hot' | 'archive'

/**
 * Тяглість ключа, яким підписаний манифест. `self` — ротацій не було;
 * `chained` — кожна ротація підписана попереднім ключем (FR-022);
 * `administrative` — десь у ланцюгу аварійна заміна, тобто гарантія слабша
 * (FR-027); `broken` — історія не сходиться і замовчувати це не можна.
 * Виводиться з ланцюга у T046 — сюди приходить уже готовою.
 */
export type KeyContinuity = 'self' | 'chained' | 'administrative' | 'broken'

/** Чому манифесту немає. Розрізняє «не віддали» і «власник видалив» (FR-024). */
export type ManifestAbsence = 'unavailable' | 'content-deleted'

export type DiscrepancyCode =
  | 'manifest-malformed'
  | 'step-hash-mismatch'
  | 'steps-root-mismatch'
  | 'signature-invalid'
  | 'anchor-malformed'
  | 'anchor-agent-mismatch'
  | 'anchor-root-mismatch'
  | 'anchor-decision-mismatch'
  | 'anchor-time-mismatch'
  | 'anchor-signature-mismatch'

export interface Discrepancy {
  readonly code: DiscrepancyCode
  readonly detail: string
}

/**
 * Застереження не роблять запис підробленим, але роблять гарантію слабшою, тож
 * показувати їх обов'язково поруч зі станом. Окремий список, а не окремий стан:
 * архівне рішення перевіряється так само повно, як гаряче (FR-029), і зливати
 * ці дві осі в одне поле означало б або приховати застереження, або збрехати
 * про цілісність.
 */
export type Caveat = 'archived' | 'administrative-key-continuity' | 'broken-key-continuity'

export interface DecisionEvidence {
  /** Конверт `{ manifest, signature }`, як його віддало сховище. */
  readonly manifest?: unknown
  /** Чому конверта немає. Значуще лише коли `manifest` відсутній. */
  readonly absence?: ManifestAbsence
  /** Звідки прочитаний конверт. За замовчуванням — гаряче сховище. */
  readonly origin?: ManifestOrigin
  /**
   * Payload memo-якоря **сирими байтами**, а не розібраним об'єктом: розбирає
   * його verifier сам, тому зіпсований запис у ланцюгу стає станом, а не
   * винятком усередині джерела. Відсутній — рішення ще не підтверджене.
   */
  readonly anchor?: Uint8Array
  /** Тяглість ключа з ланцюга (T046). За замовчуванням — ротацій не було. */
  readonly keyContinuity?: KeyContinuity
}

export interface VerificationResult {
  readonly status: VerificationStatus
  readonly discrepancies: readonly Discrepancy[]
  readonly caveats: readonly Caveat[]
  readonly keyContinuity: KeyContinuity
  /** Присутнє лише тоді, коли манифест взагалі був прочитаний. */
  readonly origin?: ManifestOrigin
  /**
   * Розібраний якір, якщо він розібрався. Лишається у відповіді й тоді, коли
   * вміст видалено: FR-024 обіцяє зберегти доказ, що запис існував.
   */
  readonly anchor?: DecisionAnchor
}

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

interface AnchorEvidence {
  readonly present: boolean
  readonly value?: DecisionAnchor
  readonly discrepancy?: Discrepancy
}

function decodeAnchor(bytes: Uint8Array | undefined): AnchorEvidence {
  if (bytes === undefined) return { present: false }
  try {
    return { present: true, value: decodeDecisionAnchor(bytes) }
  } catch (cause) {
    // Нечитабельний запис — це саме розбіжність, а не «ще очікуємо»: місце, де
    // мав лежати якір рішення, зайняте чимось іншим, і назвати це pending
    // означало б показати стан сильнішим, ніж він є.
    return {
      present: true,
      discrepancy: { code: 'anchor-malformed', detail: errorMessage(cause) },
    }
  }
}

/**
 * Хеші кроків перераховуються **з вмісту**, а не звіряються самі з собою.
 * Без цього підміна входу публічного кроку зі збереженням його хешу лишила б
 * і корінь, і підпис недоторканими — тобто найдешевша підробка пройшла б.
 * У приватного кроку вмісту немає за форматом (FR-020), тож звіряти нема з чим:
 * його захищає корінь, у листі якого лежать обидва хеші й прапорець приватності.
 */
async function stepDiscrepancies(manifest: Manifest): Promise<readonly Discrepancy[]> {
  const perStep = await Promise.all(
    manifest.steps.map(async (step, index): Promise<readonly Discrepancy[]> => {
      if (step.private) return []
      const [input, output] = await Promise.all([hashValue(step.input), hashValue(step.output)])
      const found: Discrepancy[] = []
      if (toHex(input) !== step.inputHash) {
        found.push({
          code: 'step-hash-mismatch',
          detail: `step ${index}: input does not hash to inputHash`,
        })
      }
      if (toHex(output) !== step.outputHash) {
        found.push({
          code: 'step-hash-mismatch',
          detail: `step ${index}: output does not hash to outputHash`,
        })
      }
      return found
    }),
  )
  return perStep.flat()
}

async function rootDiscrepancies(manifest: Manifest): Promise<readonly Discrepancy[]> {
  const recomputed = toHex(await stepsRoot(manifest.steps))
  if (recomputed === manifest.root) return []
  return [
    {
      code: 'steps-root-mismatch',
      detail: `steps hash to ${recomputed}, manifest claims ${manifest.root}`,
    },
  ]
}

async function signatureDiscrepancies(envelope: SignedManifest): Promise<readonly Discrepancy[]> {
  try {
    if (await verifySignedManifest(envelope)) return []
    return [{ code: 'signature-invalid', detail: 'signature does not match the manifest digest' }]
  } catch (cause) {
    // Підмінений `agentPubkey` — це не 32 випадкові байти, а точка на кривій,
    // тож WebCrypto валиться ще на імпорті ключа. Виняток тут означає рівно те
    // саме, що й `false`: цим ключем цей манифест не підписували.
    return [{ code: 'signature-invalid', detail: errorMessage(cause) }]
  }
}

/**
 * Якір несе **той самий** підпис, що й конверт манифесту, а не окремий підпис
 * над своїми байтами. Публікує якір `apps/publisher`, приватного ключа агента
 * він не має і мати не може (PLAN → довірча межа 1), тож другий підпис довелося
 * б везти від SDK окремим полем — зайва річ там, де перший підпис уже покриває
 * всі поля якоря: корінь, `decisionId`, `agentPubkey` і `decidedAt` входять у
 * дайджест манифесту. Звірка нижче й перетворює цю збіжність на доказ: якір без
 * манифесту, який до нього сходиться, не стверджує нічого.
 */
function crossCheckAnchor(
  anchor: DecisionAnchor,
  envelope: SignedManifest,
): readonly Discrepancy[] {
  const { manifest } = envelope
  const found: Discrepancy[] = []
  if (anchor.agentPubkey !== manifest.agentPubkey) {
    found.push({
      code: 'anchor-agent-mismatch',
      detail: `anchor names agent ${anchor.agentPubkey}, manifest names ${manifest.agentPubkey}`,
    })
  }
  if (anchor.root !== manifest.root) {
    found.push({
      code: 'anchor-root-mismatch',
      detail: `anchor holds root ${anchor.root}, manifest holds ${manifest.root}`,
    })
  }
  if (anchor.decisionId !== manifest.decisionId) {
    found.push({
      code: 'anchor-decision-mismatch',
      detail: `anchor is for decision ${anchor.decisionId}, manifest is ${manifest.decisionId}`,
    })
  }
  if (anchor.decidedAt !== manifest.decidedAt) {
    found.push({
      code: 'anchor-time-mismatch',
      detail: `anchor says ${anchor.decidedAt}, manifest says ${manifest.decidedAt}`,
    })
  }
  if (anchor.signature !== envelope.signature) {
    found.push({
      code: 'anchor-signature-mismatch',
      detail: 'the signature published on chain is not the one on the manifest',
    })
  }
  return found
}

function caveatsOf(
  origin: ManifestOrigin | undefined,
  continuity: KeyContinuity,
): readonly Caveat[] {
  const caveats: Caveat[] = []
  if (origin === 'archive') caveats.push('archived')
  if (continuity === 'administrative') caveats.push('administrative-key-continuity')
  if (continuity === 'broken') caveats.push('broken-key-continuity')
  return caveats
}

/**
 * Внутрішній тип, і `| undefined` тут не дублікат `?`: `exactOptionalPropertyTypes`
 * розрізняє «поля немає» і «поле є, але порожнє», а збирачеві зручно передавати
 * друге. Назовні (`VerificationResult`) виходить перше — `assemble` і робить це
 * перетворення в одному місці.
 */
interface ResultParts {
  readonly status: VerificationStatus
  readonly discrepancies: readonly Discrepancy[]
  readonly caveats: readonly Caveat[]
  readonly keyContinuity: KeyContinuity
  readonly origin?: ManifestOrigin | undefined
  readonly anchor?: DecisionAnchor | undefined
}

function assemble(parts: ResultParts): VerificationResult {
  return {
    status: parts.status,
    discrepancies: parts.discrepancies,
    caveats: parts.caveats,
    keyContinuity: parts.keyContinuity,
    ...(parts.origin === undefined ? {} : { origin: parts.origin }),
    ...(parts.anchor === undefined ? {} : { anchor: parts.anchor }),
  }
}

/**
 * Єдиний вхід у перевірку. Розбіжності збираються всі, а не до першої: людині,
 * яка дивиться на «tampered», потрібно бачити, що саме розійшлося, інакше стан
 * неможливо ані оскаржити, ані підтвердити самостійно.
 */
export async function verifyDecision(evidence: DecisionEvidence): Promise<VerificationResult> {
  const keyContinuity = evidence.keyContinuity ?? 'self'
  const anchor = decodeAnchor(evidence.anchor)
  const anchorDecode = anchor.discrepancy === undefined ? [] : [anchor.discrepancy]

  if (evidence.manifest === undefined) {
    // Порівнювати нема з чим, тож нічого й не стверджуємо про цілісність.
    // Якір, якщо він є, лишається доказом існування запису — і тільки ним.
    return assemble({
      status: evidence.absence ?? 'unavailable',
      discrepancies: anchorDecode,
      caveats: caveatsOf(undefined, keyContinuity),
      keyContinuity,
      anchor: anchor.value,
    })
  }

  const origin = evidence.origin ?? 'hot'
  const caveats = caveatsOf(origin, keyContinuity)

  let envelope: SignedManifest
  try {
    envelope = parseSignedManifest(evidence.manifest)
  } catch (cause) {
    // Сховище віддало щось, що форматом не є. Це розбіжність, а не «недоступно»:
    // вміст ми отримали, і він не той.
    return assemble({
      status: 'tampered',
      discrepancies: [{ code: 'manifest-malformed', detail: errorMessage(cause) }, ...anchorDecode],
      caveats,
      keyContinuity,
      origin,
      anchor: anchor.value,
    })
  }

  const [steps, root, signature] = await Promise.all([
    stepDiscrepancies(envelope.manifest),
    rootDiscrepancies(envelope.manifest),
    signatureDiscrepancies(envelope),
  ])

  const discrepancies = [
    ...steps,
    ...root,
    ...signature,
    ...anchorDecode,
    ...(anchor.value === undefined ? [] : crossCheckAnchor(anchor.value, envelope)),
  ]

  const status: VerificationStatus =
    discrepancies.length > 0 ? 'tampered' : anchor.present ? 'verified' : 'pending'

  return assemble({
    status,
    discrepancies,
    caveats,
    keyContinuity,
    origin,
    anchor: anchor.value,
  })
}
