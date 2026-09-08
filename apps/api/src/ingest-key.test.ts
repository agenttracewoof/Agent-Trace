import { describe, expect, it } from 'vitest'
import {
  generateIngestKey,
  hashIngestKey,
  INGEST_KEY_PREFIX,
  isIngestKeyShaped,
} from './ingest-key.js'

/**
 * Вектор рахований незалежно (`node:crypto`, не нашим кодом): якщо хешування
 * колись поїде — на алгоритм, на кодування чи на те, що в хеш поїде ключ без
 * префікса — усі вже видані ключі перестануть авторизувати мовчки, і причина
 * буде не видна ніде.
 */
const FIXED_KEY = `${INGEST_KEY_PREFIX}${'00'.repeat(32)}`
const FIXED_HASH = '083cfb3256cbcc361fc5bd3fb776b01fa5d0dda54e6d4a5d803b1dbc48a75c87'

describe('формат ingest-ключа', () => {
  it('mints a prefixed key of the length the format fixes', () => {
    expect(generateIngestKey()).toMatch(/^atk_[0-9a-f]{64}$/)
  })

  it('accepts what it mints', () => {
    for (let i = 0; i < 100; i += 1) expect(isIngestKeyShaped(generateIngestKey())).toBe(true)
  })

  it('never mints the same key twice', () => {
    const minted = new Set(Array.from({ length: 1000 }, generateIngestKey))
    expect(minted.size).toBe(1000)
  })

  it.each([
    ['an empty string', ''],
    ['the prefix alone', INGEST_KEY_PREFIX],
    ['the secret without its prefix', '00'.repeat(32)],
    ['a foreign prefix', `sk_${'00'.repeat(32)}`],
    ['uppercase hex', `${INGEST_KEY_PREFIX}${'AB'.repeat(32)}`],
    ['a key one byte short', `${INGEST_KEY_PREFIX}${'ab'.repeat(31)}`],
    ['a key one byte long', `${INGEST_KEY_PREFIX}${'ab'.repeat(33)}`],
    ['non-hex of the right length', `${INGEST_KEY_PREFIX}${'zz'.repeat(32)}`],
    ['a key with a space inside', `${INGEST_KEY_PREFIX}${'ab'.repeat(31)}a b`],
    ['a trailing newline', `${INGEST_KEY_PREFIX}${'ab'.repeat(32)}\n`],
    ['a bearer token of another system', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.x'],
  ])('refuses %s', (_name, value) => {
    expect(isIngestKeyShaped(value)).toBe(false)
  })
})

describe('хешування ingest-ключа', () => {
  it('matches a digest computed outside this code', async () => {
    expect(await hashIngestKey(FIXED_KEY)).toBe(FIXED_HASH)
  })

  it('produces exactly what the column accepts — 32 bytes of lowercase hex', async () => {
    // Той самий CHECK, що стоїть у міграції на `projects.ingest_key_hash`.
    expect(await hashIngestKey(generateIngestKey())).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic, otherwise a key would authorize only once', async () => {
    const key = generateIngestKey()
    expect(await hashIngestKey(key)).toBe(await hashIngestKey(key))
  })

  it('separates keys that differ in a single character', async () => {
    const a = `${INGEST_KEY_PREFIX}${'ab'.repeat(32)}`
    const b = `${INGEST_KEY_PREFIX}${'ab'.repeat(31)}ac`
    expect(await hashIngestKey(a)).not.toBe(await hashIngestKey(b))
  })

  it('does not carry the key inside its own output', async () => {
    const key = generateIngestKey()
    expect(await hashIngestKey(key)).not.toContain(key.slice(INGEST_KEY_PREFIX.length))
  })
})
