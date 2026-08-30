export const MANIFEST_VERSION = 1

/**
 * Байтовий бюджет якоря. Усі поля фіксованої довжини — саме тому memo не може
 * перерости ліміт транзакції на довгому рішенні: розмір не залежить від кроків.
 */
export const ANCHOR_LAYOUT = {
  version: 1,
  agentPubkey: 32,
  root: 32,
  decisionId: 16,
  decidedAt: 8,
  signature: 64,
} as const

export const ANCHOR_PAYLOAD_BYTES = Object.values(ANCHOR_LAYOUT).reduce((a, b) => a + b, 0)

/** Ліміт розміру Solana-транзакції. Запас перевіряється тестом, не на око. */
export const SOLANA_TX_LIMIT_BYTES = 1232
