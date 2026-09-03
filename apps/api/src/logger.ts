import { type Logger, pino } from 'pino'

export type { Logger }

/**
 * Список редакції — не формальність. Цей процес приймає ingest-ключ проєкту
 * у заголовку `Authorization`, а `CLAUDE.md` забороняє логувати ключі взагалі.
 * Ми ніде не логуємо заголовки навмисно, тож ці шляхи існують саме на випадок
 * ненавмисного: чийогось `logger.info({ req })` через півроку. Секрет,
 * потрапивши в лог, живе там стільки ж, скільки сам лог.
 */
const REDACT = [
  'authorization',
  'req.headers.authorization',
  'headers.authorization',
  'privateKey',
  '*.privateKey',
  'secretKey',
  '*.secretKey',
  'ingestKey',
  '*.ingestKey',
]

export function createLogger(): Logger {
  const level = process.env.LOG_LEVEL ?? 'info'
  const pretty = process.env.NODE_ENV !== 'production'

  return pino({
    level,
    redact: { paths: REDACT, censor: '[redacted]' },
    ...(pretty ? { transport: { target: 'pino-pretty' } } : {}),
  })
}

/** Тихий логер для тестів: перевіряти треба поведінку, а не вміст stdout. */
export const silentLogger = (): Logger => pino({ level: 'silent' })
