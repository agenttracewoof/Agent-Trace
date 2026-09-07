import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSignedManifest, type SignedManifest } from '@agenttrace/manifest'

const OWNER_ONLY = 0o600
const SUFFIX = '.json'

/** Ширина, за якої мілісекунди сортуються як текст аж до 5138 року. */
const ORDER_WIDTH = 14

export type SendDecision = (envelope: SignedManifest) => Promise<void>

export interface FlushSummary {
  readonly sent: number
  readonly pending: number
  /** Чому зупинилися. Відсутнє — черга спорожніла. */
  readonly stoppedBy?: Error
}

export interface DecisionBuffer {
  append(envelope: SignedManifest): Promise<void>
  pending(): Promise<number>
  flush(send: SendDecision): Promise<FlushSummary>
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

function isMissing(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT'
}

/**
 * Ім'я несе час рішення попереду, тож сортування назв — це вже черга від
 * найстарішого. Інакше довгий обрив зв'язку виглядав би так: свіжі рішення
 * проходять, а найперше лежить, поки хтось не гляне в каталог.
 */
function entryName(envelope: SignedManifest): string {
  const { decisionId, decidedAt } = envelope.manifest
  return `${String(decidedAt).padStart(ORDER_WIDTH, '0')}-${decisionId}${SUFFIX}`
}

export function openDecisionBuffer(directory: string): DecisionBuffer {
  let created: Promise<unknown> | undefined

  function ready(): Promise<unknown> {
    created ??= mkdir(directory, { recursive: true, mode: 0o700 })
    return created
  }

  async function entries(): Promise<string[]> {
    try {
      const names = await readdir(directory)
      return names.filter((name) => name.endsWith(SUFFIX)).sort()
    } catch (cause) {
      if (isMissing(cause)) return []
      throw cause
    }
  }

  async function read(name: string): Promise<SignedManifest> {
    const path = join(directory, name)
    try {
      return parseSignedManifest(JSON.parse(await readFile(path, 'utf8')))
    } catch {
      // Тут лежить те, що вже підписано, тобто відновити його нізвідки: мовчки
      // пропустити означало б втратити рішення, а FR-007 обіцяє протилежне.
      throw new Error(`buffer: ${path} is not a signed manifest`)
    }
  }

  return {
    async append(envelope) {
      await ready()
      await writeFile(join(directory, entryName(envelope)), JSON.stringify(envelope), {
        encoding: 'utf8',
        mode: OWNER_ONLY,
      })
    },

    async pending() {
      return (await entries()).length
    },

    async flush(send) {
      const names = await entries()
      let sent = 0

      for (const name of names) {
        const envelope = await read(name)
        try {
          await send(envelope)
        } catch (cause) {
          // Далі по черзі не йдемо: якщо мережі немає, наступні впадуть так само,
          // а порядок доставки перестав би бути порядком рішень.
          return { sent, pending: names.length - sent, stoppedBy: asError(cause) }
        }
        await unlink(join(directory, name))
        sent += 1
      }

      return { sent, pending: 0 }
    },
  }
}
