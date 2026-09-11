import {
  ANCHOR_KIND,
  decodeAnchorMemo,
  decodeDecisionAnchor,
  encodeDecisionAnchor,
  encodeKeyRotationAnchor,
  MANIFEST_VERSION,
  ROTATION_KIND,
  SOLANA_TX_LIMIT_BYTES,
  toHex,
} from '@agenttrace/manifest'
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  agentAddress,
  anchorInstructions,
  anchorTransactionSize,
  buildAnchorTransaction,
  MEMO_PROGRAM_ID,
} from './memo.js'

/**
 * Тут перевіряється **вміст і форма того, що назавжди ляже в ланцюг**. Мережі в
 * цих тестах немає навмисно: помилка в payload'і чи в переліку акаунтів коштує
 * незворотного запису, і ловити її треба до першого вузла, а не на devnet.
 */
const hex = (fill: number, bytes: number) => fill.toString(16).padStart(2, '0').repeat(bytes)

const payer = Keypair.generate().publicKey
const agentPubkey = toHex(Keypair.generate().publicKey.toBytes())
const previousPubkey = toHex(Keypair.generate().publicKey.toBytes())

const decisionPayload = encodeDecisionAnchor({
  version: MANIFEST_VERSION,
  kind: ANCHOR_KIND.decision,
  agentPubkey,
  root: hex(0xcd, 32),
  decisionId: hex(0x0c, 16),
  decidedAt: 1_760_000_000_000,
  signature: hex(0xef, 64),
})

const rotationPayload = encodeKeyRotationAnchor({
  version: MANIFEST_VERSION,
  kind: ANCHOR_KIND.keyRotation,
  newPubkey: agentPubkey,
  prevPubkey: previousPubkey,
  rotationKind: ROTATION_KIND.chained,
  effectiveAt: 1_760_000_000_000,
  signature: hex(0xef, 64),
})

const BLOCKHASH = '11111111111111111111111111111111'

const decisionTx = () =>
  buildAnchorTransaction({
    payer,
    payload: decisionPayload,
    indexedBy: [agentPubkey],
    recentBlockhash: BLOCKHASH,
  })

describe('memo несе рівно якір (FR-009)', () => {
  it('addresses the memo program and carries the payload as hex', () => {
    const memo = decisionTx().instructions.at(-1)

    expect(memo?.programId.equals(MEMO_PROGRAM_ID)).toBe(true)
    expect(memo?.data.toString('utf8')).toBe(toHex(decisionPayload))
  })

  it('comes back out of the memo as the very anchor that went in', () => {
    // Найдорожча властивість цього модуля: те, що прочитає стороння людина з
    // ланцюга, мусить розібратися нашим же декодером у той самий якір.
    const memo = decisionTx().instructions.at(-1)
    const readBack = decodeAnchorMemo(memo?.data.toString('utf8') ?? '')

    expect(readBack).toEqual(decisionPayload)
    expect(decodeDecisionAnchor(readBack ?? new Uint8Array())).toMatchObject({
      agentPubkey,
      decisionId: hex(0x0c, 16),
    })
  })

  it('passes the memo program no accounts, because it demands a signature from each', () => {
    // `spl-memo` відповідає MissingRequiredSignature на будь-який непідписаний
    // акаунт, а приватного ключа агента у сервісу немає й бути не може. Акаунт
    // на цій інструкції зробив би кожну публікацію невдалою.
    expect(decisionTx().instructions.at(-1)?.keys).toEqual([])
  })
})

describe('адреса агента потрапляє в транзакцію (FR-010, FR-014)', () => {
  it('names the agent among the account keys, so the chain indexes it', () => {
    // На цьому тримається незалежна перевірка: маючи лише agentPubkey з
    // манифесту, стороння людина дістає історію агента через
    // getSignaturesForAddress, не питаючи наш API.
    const keys = decisionTx()
      .compileMessage()
      .accountKeys.map((one) => one.toBase58())

    expect(keys).toContain(agentAddress(agentPubkey).toBase58())
  })

  it('does it without claiming the agent key, and without moving any lamports', () => {
    const [transfer] = decisionTx().instructions
    const agent = agentAddress(agentPubkey)

    expect(transfer?.programId.equals(SystemProgram.programId)).toBe(true)
    expect(transfer?.keys.find((one) => one.pubkey.equals(agent))?.isSigner).toBe(false)
    // 4 байти інструкції + 8 байтів суми, з яких сума — нуль.
    expect(transfer?.data.readBigUInt64LE(4)).toBe(0n)
  })

  it('names both keys of a rotation, so the chain can be followed from the old one', () => {
    const keys = buildAnchorTransaction({
      payer,
      payload: rotationPayload,
      indexedBy: [agentPubkey, previousPubkey],
      recentBlockhash: BLOCKHASH,
    })
      .compileMessage()
      .accountKeys.map((one) => one.toBase58())

    expect(keys).toContain(agentAddress(agentPubkey).toBase58())
    expect(keys).toContain(agentAddress(previousPubkey).toBase58())
  })

  it('does not pay to name the same address twice, nor to name the payer', () => {
    const instructions = anchorInstructions({
      payer,
      payload: decisionPayload,
      indexedBy: [agentPubkey, agentPubkey, toHex(payer.toBytes())],
    })

    expect(instructions).toHaveLength(2)
  })

  it('refuses an address that is not a key in the form the format uses', () => {
    expect(() => agentAddress('nope')).toThrow()
    expect(() => agentAddress(toHex(payer.toBytes()).toUpperCase())).toThrow()
  })
})

describe('бюджет транзакції', () => {
  it('fits well inside the transaction limit for both anchor kinds', () => {
    const decision = anchorTransactionSize(decisionTx())
    const rotation = anchorTransactionSize(
      buildAnchorTransaction({
        payer,
        payload: rotationPayload,
        indexedBy: [agentPubkey, previousPubkey],
        recentBlockhash: BLOCKHASH,
      }),
    )

    expect(decision).toBeLessThan(SOLANA_TX_LIMIT_BYTES)
    expect(rotation).toBeLessThan(SOLANA_TX_LIMIT_BYTES)
    // Запас не «десь є», а кратний: якщо він колись з'їсться, це має бути видно
    // як падіння тесту, а не як відмова вузла на живій публікації.
    expect(decision * 2).toBeLessThan(SOLANA_TX_LIMIT_BYTES)
  })

  it('does not grow with the decision, because every anchor field is fixed width', () => {
    const short = anchorTransactionSize(decisionTx())
    const long = anchorTransactionSize(
      buildAnchorTransaction({
        payer,
        payload: encodeDecisionAnchor({
          version: MANIFEST_VERSION,
          kind: ANCHOR_KIND.decision,
          agentPubkey,
          root: hex(0x01, 32),
          decisionId: hex(0x02, 16),
          decidedAt: Number.MAX_SAFE_INTEGER,
          signature: hex(0x03, 64),
        }),
        indexedBy: [agentPubkey],
        recentBlockhash: BLOCKHASH,
      }),
    )

    expect(long).toBe(short)
  })

  it('keeps the payer as the only signer', () => {
    const message = decisionTx().compileMessage()

    expect(message.header.numRequiredSignatures).toBe(1)
    expect(message.accountKeys[0]?.equals(new PublicKey(payer))).toBe(true)
  })
})
