import { sha256, toHex } from '@agenttrace/manifest'

/**
 * Префікс — не косметика. За ним ключ упізнається у `.env`, у тікеті й у
 * сканері секретів, а запит із випадковим сміттям у заголовку відсіюється
 * **до** звернення до бази.
 *
 * Кодування — hex нижнього регістру, як і решта формату: у базі лежить hex,
 * і одне кодування на весь проєкт знімає питання про регістр і про доповнення,
 * які тягне base64url.
 */
export const INGEST_KEY_PREFIX = 'atk_'
export const INGEST_KEY_BYTES = 32

const SHAPE = new RegExp(`^${INGEST_KEY_PREFIX}[0-9a-f]{${INGEST_KEY_BYTES * 2}}$`)
const encoder = new TextEncoder()

export function generateIngestKey(): string {
  const secret = crypto.getRandomValues(new Uint8Array(INGEST_KEY_BYTES))
  return `${INGEST_KEY_PREFIX}${toHex(secret)}`
}

export const isIngestKeyShaped = (value: string): boolean => SHAPE.test(value)

/**
 * SHA-256, а **не** повільна KDF (bcrypt / argon2), і це рішення, а не економія.
 *
 * Дві причини. Перша: ключ — 32 байти з CSPRNG, а не вигаданий людиною пароль.
 * Словника, проти якого KDF і придумана, тут не існує, а перебір 2^256 повільніша
 * функція не робить помітно дорожчим. Друга і вирішальна: KDF має сіль, тобто
 * хеш того самого ключа щоразу інший — знайти проєкт можна було б лише перебравши
 * **усі** проєкти й порахувавши KDF для кожного, на кожному прийнятому рішенні.
 * Хеш без солі дає рівно один запит за унікальним індексом.
 *
 * Порівняння в постійному часі тут не потрібне: ключ ми не звіряємо самі —
 * рівність хешів перевіряє індекс у Postgres, а підібрати прообраз хешу,
 * якого зловмисник не знає, вимірювання часу не допомагає.
 */
export async function hashIngestKey(key: string): Promise<string> {
  return toHex(await sha256(encoder.encode(key)))
}
