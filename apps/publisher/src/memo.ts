import { encodeAnchorMemo, fromHex, hexDigest } from '@agenttrace/manifest'
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js'

/**
 * Побудова anchor-транзакції (FR-009, FR-010). Модуль **нічого не шле**: він
 * складає транзакцію з payload'а і повертає її непідписаною. Мережа, підпис
 * платником, backoff і повтор — це T030. Межа проведена тут, щоб найдорожчу
 * частину — вміст і форму того, що назавжди ляже в ланцюг, — можна було
 * перевірити тестом без жодного вузла.
 *
 * Транзакція складається з двох інструкцій:
 *
 * 1. **memo** з payload'ом якоря у hex (§15) — власне запис;
 * 2. **переказ 0 лампортів на адресу агента** — рівно для того, щоб адреса
 *    агента потрапила в перелік акаунтів транзакції.
 *
 * Друга інструкція виглядає дивно і потребує пояснення. `getSignaturesForAddress`
 * індексує будь-яку адресу з переліку акаунтів транзакції, і саме на цьому
 * тримається FR-014: маючи лише `agentPubkey` з манифесту, стороння людина
 * дістає з ланцюга **всю** історію агента — і рішення, і ротації — не питаючи
 * нас ні про що. Без індексації довелося б питати номер транзакції в нашого API,
 * тобто «незалежна перевірка» стала б перевіркою через AgentTrace.
 *
 * Чому не покласти адресу агента прямо в memo-інструкцію, як казав `PLAN.md`:
 * **`spl-memo` вимагає, щоб кожен переданий йому акаунт був підписантом**, і
 * відповідає `MissingRequiredSignature` на будь-який інший. Приватного ключа
 * агента у сервісу немає й не може бути (він у клієнта, PLAN → довірча межа 1),
 * тож підписати за агента ми не можемо ніколи. Переказ нуля лампортів —
 * найдешевший спосіб назвати адресу в транзакції, не претендуючи на її ключ:
 * коштів не рухає, акаунта не створює, комісії не додає.
 */

/** SPL Memo. Той самий ідентифікатор у devnet і mainnet. */
export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

const agentPubkeySchema = hexDigest(32)

/**
 * Межа між формою формату і формою Solana. У манифесті, у якорі й у публічному
 * посиланні ключ — hex; base58 з'являється рівно тут і в тому, що бачить око.
 */
export function agentAddress(agentPubkey: string): PublicKey {
  return new PublicKey(fromHex(agentPubkeySchema.parse(agentPubkey)))
}

export interface AnchorTransactionInput {
  /** Гаманець-платник. Єдиний підписант транзакції. */
  readonly payer: PublicKey
  /** Байти якоря — `encodeDecisionAnchor` або `encodeKeyRotationAnchor`. */
  readonly payload: Uint8Array
  /**
   * Адреси у hex, за якими цей якір має знаходитися в ланцюгу. Для рішення це
   * ключ, яким його підписали. Для ротації (T068) — **обидва** ключі: інакше
   * той, хто йде по історії від старого ключа, не побачив би, чим його змінили.
   */
  readonly indexedBy: readonly string[]
}

export function memoInstruction(payload: Uint8Array): TransactionInstruction {
  return new TransactionInstruction({
    // Порожній перелік акаунтів — вимушений і єдиний можливий: memo вимагає
    // підпису від кожного, кого йому передали.
    keys: [],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(encodeAnchorMemo(payload), 'utf8'),
  })
}

export function anchorInstructions(input: AnchorTransactionInput): TransactionInstruction[] {
  const payer = input.payer.toBase58()

  // Дублікати згортаються, платник відкидається: він і так у переліку акаунтів
  // як підписант, а переказ самому собі — просто зайві байти в транзакції.
  const addresses = [...new Set(input.indexedBy.map((one) => agentAddress(one).toBase58()))].filter(
    (one) => one !== payer,
  )

  return [
    ...addresses.map((address) =>
      SystemProgram.transfer({
        fromPubkey: input.payer,
        toPubkey: new PublicKey(address),
        lamports: 0,
      }),
    ),
    memoInstruction(input.payload),
  ]
}

/**
 * Непідписана транзакція. `recentBlockhash` приходить аргументом, а не з мережі:
 * він живе ~60 секунд, тож брати його має той, хто зараз шле (T030), і брати
 * незадовго до відправки.
 */
export function buildAnchorTransaction(
  input: AnchorTransactionInput & { readonly recentBlockhash: string },
): Transaction {
  const transaction = new Transaction({
    feePayer: input.payer,
    recentBlockhash: input.recentBlockhash,
  })
  transaction.add(...anchorInstructions(input))
  return transaction
}

/**
 * Скільки байтів займе транзакція на дроті, з місцем під підпис платника.
 * Перевищення ліміту неможливе за побудовою — усі поля якоря фіксованої
 * довжини, — але «неможливо за побудовою» варте рівно стільки, скільки
 * коштує тест, який це показує.
 */
export function anchorTransactionSize(transaction: Transaction): number {
  return transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).byteLength
}
