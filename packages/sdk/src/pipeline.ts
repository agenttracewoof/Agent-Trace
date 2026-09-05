import {
  hashValue,
  MANIFEST_VERSION,
  type Manifest,
  type ManifestStep,
  manifestSchema,
  manifestStepSchema,
  parseManifest,
  redact,
  stepsRoot,
  toHex,
} from '@agenttrace/manifest'
import { z } from 'zod'

const draftStepSchema = z.strictObject({
  type: z.string().min(1).max(64),
  private: z.boolean(),
  input: z.json(),
  output: z.json(),
})

/**
 * Чернетка успадковує обмеження полів від самого формату, а не повторює їх:
 * розбіжність між тим, що приймає SDK, і тим, що приймає манифест, вилізла б
 * аж на відправці — тобто після того, як рішення вже прийняте.
 */
export const decisionDraftSchema = manifestSchema
  .omit({ version: true, root: true, steps: true })
  .extend({ steps: z.array(draftStepSchema).min(1) })

export type DecisionDraft = z.infer<typeof decisionDraftSchema>

/** Список полів, які **дозволено** публікувати; форма правил — за `redact`. */
export interface RedactionPolicy {
  readonly stepInput: readonly string[]
  readonly stepOutput: readonly string[]
  readonly outcome: readonly string[]
}

async function publish(step: DecisionDraft['steps'][number], policy: RedactionPolicy) {
  const input = redact(step.input, policy.stepInput)
  const output = redact(step.output, policy.stepOutput)
  const [inputHash, outputHash] = await Promise.all([hashValue(input), hashValue(output)])
  const digests = { type: step.type, inputHash: toHex(inputHash), outputHash: toHex(outputHash) }

  // Приватний крок теж хешується вже відредагованим: його вміст колись покаже
  // адресне розкриття (FR-021), і показувати там секрет — те саме, що
  // опублікувати його, лише з відстрочкою.
  return manifestStepSchema.parse(
    step.private ? { ...digests, private: true } : { ...digests, private: false, input, output },
  )
}

/**
 * Єдиний шлях від записаного рішення до того, що піде в мережу (FR-006).
 * Редакція стоїть **перед** хешуванням, тож і хеші кроків, і корінь рахуються з
 * уже відредагованих значень — саме їх потім перераховує verifier. Опублікувати
 * сире значення можна тільки в обхід цієї функції, а не через переплутаний
 * порядок викликів усередині неї.
 *
 * `model` і `sources` редакцію не проходять: за форматом це рядки-ідентифікатори,
 * а правило allow-list адресує поле, не підрядок усередині значення. Токен,
 * вписаний у URL джерела, лишається на відповідальності того, хто його туди вписав.
 */
export async function buildManifest(draft: unknown, policy: RedactionPolicy): Promise<Manifest> {
  const { steps, outcome, ...rest } = decisionDraftSchema.parse(draft)
  const published: ManifestStep[] = await Promise.all(steps.map((step) => publish(step, policy)))

  return parseManifest({
    ...rest,
    version: MANIFEST_VERSION,
    outcome: redact(outcome, policy.outcome),
    root: toHex(await stepsRoot(published)),
    steps: published,
  })
}
