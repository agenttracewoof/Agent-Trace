import { hexDigest, signedManifestSchema } from '@agenttrace/manifest'
import { z } from 'zod'

/**
 * Межа публічного читання (FR-011, FR-012, FR-013, FR-020) — єдина, яку читає
 * той, хто нам не довіряє й не має жодного ключа. Тому кожне поле тут відповідає
 * на питання «що саме ти стверджуєш», а не «що зручно показати».
 *
 * Схеми лежать у `shared`, а не у `verify`: verifier не має права знати про наш
 * API (FR-014, тест T007), і ця межа — саме про API. Ціна — назви станів існують
 * у двох місцях; розходження між ними ловить присвоєння результату `verifyDecision`
 * у `apps/api/src/routes/public.ts` — єдине місце, де обидва пакети видно одночасно,
 * і воно перестане типчекатися того дня, коли verifier заведе новий стан.
 */

/** Стани за FR-013. Ті самі назви, що повертає `verifyDecision`. */
export const verificationStatusSchema = z.enum([
  'verified',
  'pending',
  'tampered',
  'unavailable',
  'content-deleted',
])

export const caveatSchema = z.enum([
  'archived',
  'administrative-key-continuity',
  'broken-key-continuity',
])

export const keyContinuitySchema = z.enum(['self', 'chained', 'administrative', 'broken'])

export const manifestOriginSchema = z.enum(['hot', 'archive'])

/**
 * `code` тут рядок, а не перелік: список розбіжностей належить verifier'у й
 * росте разом із ним, а сторінка показує `detail`. Третій список назв, який
 * доводилося б синхронізувати вручну, коштував би дорожче за те, що дає.
 */
export const discrepancySchema = z.object({ code: z.string(), detail: z.string() })

/**
 * Результат перевірки **нашими силами**. `includesChain` існує, щоб цей результат
 * неможливо було прочитати сильнішим, ніж він є: API ланцюг не читає, тому
 * `status: 'verified'` звідси не приходить ніколи — сказати «підтверджено» може
 * лише той, хто сам подивився в ланцюг (CLI з M0 або сторінка, яка сходила в RPC).
 * Наш внесок — манифест, який сходиться з власним підписом, і адреса транзакції,
 * за якою це можна перевірити без нас.
 */
export const publicVerificationSchema = z.object({
  status: verificationStatusSchema,
  discrepancies: z.array(discrepancySchema),
  caveats: z.array(caveatSchema),
  keyContinuity: keyContinuitySchema,
  origin: manifestOriginSchema.optional(),
  includesChain: z.boolean(),
})

/** Наш запис про публікацію якоря — не доказ, а вказівка, де шукати доказ. */
export const anchorReferenceSchema = z.object({
  /** Підпис memo-транзакції у base58 — те, що вводять у оглядач ланцюга. */
  transactionSignature: z.string().min(1).max(88),
  slot: z.int().min(0),
  anchoredAt: z.iso.datetime(),
})

export const archiveReferenceSchema = z.object({
  url: z.url(),
  archivedAt: z.iso.datetime(),
})

/**
 * Поля, яких немає, віддаються як `null`, а не пропускаються: формат, у якому
 * поле то є, то немає, змушує кожного клієнта писати перевірку на існування —
 * і саме на публічній сторінці ця перевірка найдорожча, бо там її пише чужа людина.
 */
export const publicDecisionResponseSchema = z.object({
  decisionId: hexDigest(16),
  /**
   * Конверт рівно у тій формі, у якій його підписали, — інакше він не
   * перевірився б (FR-011). `null` означає, що віддати його не можна:
   * вміст видалено на вимогу власника (FR-024) або те, що лежить у сховищі,
   * форматом не є. Приватні кроки FR-020 тут не «вирізаються»: конверт
   * проходить строгу схему формату, у якій приватний крок не має полів вмісту
   * взагалі, тож віддати їх неможливо навіть помилково.
   */
  signedManifest: signedManifestSchema.nullable(),
  anchor: anchorReferenceSchema.nullable(),
  archive: archiveReferenceSchema.nullable(),
  contentDeletedAt: z.iso.datetime().nullable(),
  verification: publicVerificationSchema,
})

export const rotationKindSchema = z.enum(['initial', 'chained', 'administrative'])

/**
 * Історія ключів — щоб verifier сам оцінив тяглість (FR-022, FR-027), а не
 * повірив нашій оцінці. Тут немає ані назви агента, ані його ідентифікатора в
 * системі клієнта: публічна перевірка їх не потребує, а віддати їх означало б
 * розповісти світу, як клієнт називає свої системи.
 *
 * **Ця відповідь — кеш ланцюга, а не джерело істини.** Справжню історію
 * verifier бере з якорів `kind=1` через `getSignaturesForAddress` (T046).
 */
export const publicAgentKeysResponseSchema = z.object({
  /** Стабільний публічний ідентифікатор агента, незалежний від зміни ключів. */
  agentId: z.uuid(),
  keys: z.array(
    z.object({
      publicKey: hexDigest(32),
      validFrom: z.int().min(0),
      validTo: z.int().min(0).nullable(),
      rotationKind: rotationKindSchema,
      /** Попередник у тій самій формі, що й адреса, — щоб ланцюг читався без зайвих запитів. */
      prevPublicKey: hexDigest(32).nullable(),
      /** Підпис із якоря ротації: попереднім ключем (chained) або платником (administrative). */
      rotationProof: hexDigest(64).nullable(),
    }),
  ),
})

export type VerificationStatus = z.infer<typeof verificationStatusSchema>
export type Caveat = z.infer<typeof caveatSchema>
export type KeyContinuity = z.infer<typeof keyContinuitySchema>
export type ManifestOrigin = z.infer<typeof manifestOriginSchema>
export type PublicVerification = z.infer<typeof publicVerificationSchema>
export type AnchorReference = z.infer<typeof anchorReferenceSchema>
export type PublicDecisionResponse = z.infer<typeof publicDecisionResponseSchema>
export type PublicAgentKeysResponse = z.infer<typeof publicAgentKeysResponseSchema>
