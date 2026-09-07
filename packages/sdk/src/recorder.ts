import { type DecisionDraft, decisionDraftSchema } from './pipeline.js'

export interface DecisionOptions {
  /** Публічна частина ключа з keystore — вона ж ідентичність агента (FR-005). */
  readonly agentPubkey: string
  readonly model: string
}

export interface DecisionRecorder {
  /**
   * Відомий одразу, ще до завершення: приймання ідемпотентне саме за ним, тож
   * повтор після обриву мережі має слати той самий ідентифікатор (FR-007).
   */
  readonly decisionId: string
  source(uri: string): void
  step(type: string, input: unknown, output: unknown): void
  finish(outcome: unknown): DecisionDraft
}

interface RecordedStep {
  readonly type: string
  readonly private: boolean
  readonly input: unknown
  readonly output: unknown
}

/**
 * Запис одного рішення (FR-001). Рекордер нічого не хешує і нікуди не шле:
 * він віддає чернетку, а редакція, хеші й корінь — це `buildManifest`, єдиний
 * шлях до мережі.
 */
export function startDecision(options: DecisionOptions): DecisionRecorder {
  const decisionId = crypto.randomUUID().replaceAll('-', '')
  const sources: string[] = []
  const steps: RecordedStep[] = []
  let finished = false

  function assertOpen(): void {
    // Тихо дописати крок у вже завершене рішення означало б, що запис і рішення
    // розійшлися: манифест з ним уже підписаний або й опублікований.
    if (finished) throw new Error('recorder: the decision is already finished')
  }

  return {
    decisionId,

    source(uri) {
      assertOpen()
      // Перелік джерел, а не журнал звернень: журнал — це кроки, і сто сторінок
      // одного API не роблять його ста джерелами.
      if (!sources.includes(uri)) sources.push(uri)
    },

    step(type, input, output) {
      assertOpen()
      steps.push({ type, private: false, input, output })
    },

    finish(outcome) {
      assertOpen()
      if (steps.length === 0) {
        throw new Error('recorder: the decision has no steps, so there is nothing to attest')
      }
      finished = true

      return decisionDraftSchema.parse({
        agentPubkey: options.agentPubkey,
        decisionId,
        model: options.model,
        sources,
        decidedAt: Date.now(),
        outcome,
        steps,
      })
    },
  }
}
