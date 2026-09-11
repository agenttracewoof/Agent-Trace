import { describe, expect, it } from 'vitest'
import {
  ANCHOR_KIND,
  canonicalize,
  canonicalManifest,
  encodeAnchorMemo,
  encodeDecisionAnchor,
  encodeKeyRotationAnchor,
  fromHex,
  hashStep,
  hashValue,
  MANIFEST_VERSION,
  type Manifest,
  manifestDigest,
  ROTATION_KIND,
  stepsRoot,
  toHex,
} from './index.js'

/**
 * Тестові вектори з `docs/MANIFEST-FORMAT.md` §14. Специфікація обіцяє, що
 * сумісний клієнт можна написати іншою мовою, звіривши реалізацію на цих
 * числах, — а обіцянка вартує рівно стільки, скільки коштує її порушити.
 * Без цього файлу документ і код розійшлися б тихо, і першим це помітив би
 * чужий розробник, а не ми.
 *
 * Числа тут **не перераховуються з коду**: вони переписані з документа. Якщо
 * тест упав, спершу відповідай на питання, що змінилося — формат чи документ.
 */

/** RFC 8032 §7.1 TEST 1. Публічно відомий ключ, у продакшені неприпустимий. */
const PKCS8 =
  '302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
const AGENT_PUBKEY = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'

const INPUT_0 = { url: 'https://quotes.example/sol-usdc' }
const OUTPUT_0 = { price: 187.4 }
const INPUT_1 = { prompt: 'swap?' }
const OUTPUT_1 = { text: 'yes' }

const INPUT_HASH_0 = '5512bf6eae90f624f16597eb4e6db9d3caf7ca57c7eeeddcc116a7410f53bb9c'
const OUTPUT_HASH_0 = 'aab6c11133ba4e7104bfb571cbffb67b164f565c936f60dfaf3c1255c1264673'
const INPUT_HASH_1 = '211871c1f427ac22aa6b6e50db78b7b4b1e98dadebd0141a957f3aaed1deea45'
const OUTPUT_HASH_1 = '29eb413324469b49234b9c8fa468e4c69719ba9bd9a41333c56d802057f71d99'

const LEAF_0 = '016b90c8e5c4ae31821e287634913600bed3e9909be162acd64bd26acdd2aabb'
const LEAF_1 = '31c1a34692024cb0dff1d62df3a24594bfe6bef8f746a73884d96600702b621a'
const ROOT = '1a73285b3d3ef3329b1db25efe4d02ca635e80d03a3a69bb9313c62497e6acbe'

const DIGEST = '5970ea8f8b122a95ce25a45fc99fb2d802de21740a4029c550efcc81da61d2db'
const SIGNATURE =
  'ad964a4e3ccdb86722c68813dd15f6f6fa0edcc1365efb0e5a536feda65f01e9' +
  '50410cf98d3892494675d01132b2b9c2e04219bb0c1c4138095847c4943dd001'

const CANONICAL_MANIFEST =
  '{"agentPubkey":"d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",' +
  '"decidedAt":1760000000000,"decisionId":"0123456789abcdeffedcba9876543210",' +
  '"model":"claude-opus-5","outcome":{"action":"swap","pair":"SOL/USDC"},' +
  `"root":"${ROOT}","sources":["https://quotes.example/sol-usdc"],` +
  `"steps":[{"input":{"url":"https://quotes.example/sol-usdc"},"inputHash":"${INPUT_HASH_0}",` +
  `"output":{"price":187.4},"outputHash":"${OUTPUT_HASH_0}","private":false,"type":"source.read"},` +
  `{"inputHash":"${INPUT_HASH_1}","outputHash":"${OUTPUT_HASH_1}","private":true,` +
  '"type":"model.call"}],"version":1}'

const DECISION_ANCHOR =
  '0100' + AGENT_PUBKEY + ROOT + '0123456789abcdeffedcba9876543210' + '00000199c82cc000' + SIGNATURE

const ROTATION_ANCHOR =
  '0101' + 'aa'.repeat(32) + AGENT_PUBKEY + '00' + '00000199c82cc000' + SIGNATURE

const steps: Manifest['steps'] = [
  {
    type: 'source.read',
    private: false,
    input: INPUT_0,
    output: OUTPUT_0,
    inputHash: INPUT_HASH_0,
    outputHash: OUTPUT_HASH_0,
  },
  { type: 'model.call', private: true, inputHash: INPUT_HASH_1, outputHash: OUTPUT_HASH_1 },
]

const manifest: Manifest = {
  version: MANIFEST_VERSION,
  agentPubkey: AGENT_PUBKEY,
  decisionId: '0123456789abcdeffedcba9876543210',
  model: 'claude-opus-5',
  sources: ['https://quotes.example/sol-usdc'],
  root: ROOT,
  decidedAt: 1_760_000_000_000,
  outcome: { action: 'swap', pair: 'SOL/USDC' },
  steps,
}

const leafOf = async (index: number): Promise<string> => {
  const step = steps[index]
  if (step === undefined) throw new Error(`no step ${index}`)
  return toHex(
    await hashStep({
      type: step.type,
      inputHash: fromHex(step.inputHash),
      outputHash: fromHex(step.outputHash),
      private: step.private,
    }),
  )
}

describe('MANIFEST-FORMAT.md §14.2 — значення і хеші', () => {
  it('canonicalises the documented values exactly as written', () => {
    expect(canonicalize(INPUT_0)).toBe('{"url":"https://quotes.example/sol-usdc"}')
    expect(canonicalize(OUTPUT_0)).toBe('{"price":187.4}')
  })

  it('hashes them to the documented digests', async () => {
    expect(toHex(await hashValue(INPUT_0))).toBe(INPUT_HASH_0)
    expect(toHex(await hashValue(OUTPUT_0))).toBe(OUTPUT_HASH_0)
    expect(toHex(await hashValue(INPUT_1))).toBe(INPUT_HASH_1)
    expect(toHex(await hashValue(OUTPUT_1))).toBe(OUTPUT_HASH_1)
  })
})

describe('MANIFEST-FORMAT.md §14.3 — листи і корінь', () => {
  it('folds the two documented steps into the documented leaves', async () => {
    expect(await leafOf(0)).toBe(LEAF_0)
    expect(await leafOf(1)).toBe(LEAF_1)
  })

  it('folds the leaves into the documented root', async () => {
    expect(toHex(await stepsRoot(steps))).toBe(ROOT)
  })

  it('leaves a single-step tree unhashed, as §5 promises', async () => {
    const single = steps.slice(0, 1)
    expect(toHex(await stepsRoot(single))).toBe(LEAF_0)
  })
})

describe('MANIFEST-FORMAT.md §14.4–14.5 — канонічна форма, дайджест, підпис', () => {
  it('produces the documented canonical string, sorted keys and all', () => {
    expect(canonicalManifest(manifest)).toBe(CANONICAL_MANIFEST)
  })

  it('produces the documented digest', async () => {
    expect(toHex(await manifestDigest(manifest))).toBe(DIGEST)
  })

  it('produces the documented signature — Ed25519 is deterministic', async () => {
    const key = await crypto.subtle.importKey('pkcs8', fromHex(PKCS8), { name: 'Ed25519' }, false, [
      'sign',
    ])
    const signature = await crypto.subtle.sign('Ed25519', key, await manifestDigest(manifest))
    expect(toHex(new Uint8Array(signature))).toBe(SIGNATURE)
  })

  it('derives the documented public key from the documented private key', async () => {
    const pair = await crypto.subtle.importKey('pkcs8', fromHex(PKCS8), { name: 'Ed25519' }, true, [
      'sign',
    ])
    // Публічна частина не виводиться з PKCS#8 напряму, тож звіряємо через підпис:
    // документований підпис перевіряється документованим публічним ключем.
    const publicKey = await crypto.subtle.importKey(
      'raw',
      fromHex(AGENT_PUBKEY),
      { name: 'Ed25519' },
      false,
      ['verify'],
    )
    const signature = await crypto.subtle.sign('Ed25519', pair, await manifestDigest(manifest))
    expect(
      await crypto.subtle.verify('Ed25519', publicKey, signature, await manifestDigest(manifest)),
    ).toBe(true)
  })
})

describe('MANIFEST-FORMAT.md §14.6–14.7 — якорі', () => {
  it('encodes the decision anchor byte for byte', () => {
    const bytes = encodeDecisionAnchor({
      version: MANIFEST_VERSION,
      kind: ANCHOR_KIND.decision,
      agentPubkey: AGENT_PUBKEY,
      root: ROOT,
      decisionId: manifest.decisionId,
      decidedAt: manifest.decidedAt,
      signature: SIGNATURE,
    })
    expect(toHex(bytes)).toBe(DECISION_ANCHOR)
    expect(bytes.byteLength).toBe(154)
  })

  it('is exactly what the memo carries, as §11.1 claims', () => {
    // Документ каже: «тестові вектори §14.6 і §14.7 — це і є вміст memo».
    // Твердження, яке ніхто не перевіряє, реалізатор іншою мовою перевірить
    // за нас — і дізнається, що воно неправда, вже на своєму клієнті.
    expect(encodeAnchorMemo(fromHex(DECISION_ANCHOR))).toBe(DECISION_ANCHOR)
    expect(encodeAnchorMemo(fromHex(ROTATION_ANCHOR))).toBe(ROTATION_ANCHOR)
  })

  it('encodes the key rotation anchor byte for byte', () => {
    const bytes = encodeKeyRotationAnchor({
      version: MANIFEST_VERSION,
      kind: ANCHOR_KIND.keyRotation,
      newPubkey: 'aa'.repeat(32),
      prevPubkey: AGENT_PUBKEY,
      rotationKind: ROTATION_KIND.chained,
      effectiveAt: manifest.decidedAt,
      signature: SIGNATURE,
    })
    expect(toHex(bytes)).toBe(ROTATION_ANCHOR)
    expect(bytes.byteLength).toBe(139)
  })
})

describe('MANIFEST-FORMAT.md §14.8–14.9 — числа, рядки, порядок ключів', () => {
  it('writes numbers the way §2.1 says', () => {
    expect(canonicalize(1e21)).toBe('1e+21')
    expect(canonicalize(1e20)).toBe('100000000000000000000')
    expect(canonicalize(1e-7)).toBe('1e-7')
    expect(canonicalize(1e-6)).toBe('0.000001')
    expect(canonicalize(0.1)).toBe('0.1')
    expect(canonicalize(-0)).toBe('0')
    expect(canonicalize(2 ** 53)).toBe('9007199254740992')
  })

  it('escapes strings the way §2.2 says', () => {
    expect(canonicalize('a\u0007b')).toBe('"a\\u0007b"')
    expect(canonicalize('\ud800')).toBe('"\\ud800"')
    expect(canonicalize('é')).toBe('"é"')
  })

  it('sorts keys by UTF-16 code unit — the trap §2.3 names', () => {
    // 😀 (U+1F600) перед ﬀ (U+FB00): сурогатна пара починається з 0xD83D.
    // Реалізація, яка сортує за UTF-8 або кодовими точками, дасть інший рядок.
    expect(canonicalize({ b: 1, A: 2, é: 3, a: 4, '😀': 5, ﬀ: 6 })).toBe(
      '{"A":2,"a":4,"b":1,"é":3,"😀":5,"ﬀ":6}',
    )
  })
})
