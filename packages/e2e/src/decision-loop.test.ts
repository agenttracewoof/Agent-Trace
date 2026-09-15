import { describe, expect, it } from 'vitest'
import {
  type DecisionSample,
  formatReport,
  percentile,
  SC001_MAX_MS,
  SC003_MAX_MS,
  type ScenarioReport,
} from './decision-loop.js'

/**
 * Мережі тут немає: живий прогін — це `pnpm --filter @agenttrace/e2e demo`, і він
 * коштує транзакцій у devnet. Тестом покрито те, через що замір бреше тихо —
 * арифметику перцентиля і те, чи звіт узагалі здатен сказати «FAIL».
 */

const sample = (verifiableMs: number, sdkMs = 10): DecisionSample => ({
  decisionId: 'ab'.repeat(16),
  sdkMs,
  anchorSeenMs: verifiableMs - 500,
  verifiableMs,
})

describe('percentile', () => {
  it('takes the nearest rank, so p95 of ten samples is the worst of them', () => {
    // Інтерполяція на десяти зразках малювала б точність, якої немає, і робила б
    // найгірший випадок невидимим — а SC-001 саме про нього.
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100]

    expect(percentile(values, 95)).toBe(100)
    expect(percentile(values, 50)).toBe(5)
  })

  it('does not invent a number out of nothing', () => {
    expect(percentile([], 95)).toBeNaN()
  })

  it('ignores the order it was handed', () => {
    expect(percentile([9, 1, 5], 50)).toBe(percentile([1, 5, 9], 50))
  })
})

describe('the report can fail', () => {
  const report = (over: Partial<ScenarioReport> = {}): ScenarioReport => ({
    samples: [sample(1_000)],
    sdkP95Ms: 12,
    verifiableP95Ms: 1_000,
    sc001: true,
    sc003: true,
    sc009: true,
    survivesOutage: true,
    anchored: 1,
    ...over,
  })

  it('says FAIL out loud when a criterion is not met', () => {
    /**
     * Звіт, у якого немає слова «FAIL», — це не замір, а прикраса. Тест існує
     * рівно для того, щоб порогів не можна було непомітно прибрати.
     */
    const text = formatReport(report({ sc001: false, verifiableP95Ms: 18_260 }))

    expect(text).toContain('FAIL')
    expect(text).toContain(String(SC001_MAX_MS))
  })

  it('splits the wait into publishing and verifying', () => {
    // Без цього поділу невиконаний SC-001 не каже, що саме прискорювати.
    const text = formatReport(report())

    expect(text).toContain('anchor visible')
    expect(text).toContain('then verified')
  })

  it('names the sdk budget it measured against', () => {
    expect(formatReport(report())).toContain(String(SC003_MAX_MS))
  })

  it('keeps saying where the envelope came from', () => {
    // Рядок про сховище власника (T055) — не примітка: без нього число SC-001
    // читається як доказ більшого, ніж воно є.
    expect(formatReport(report())).toContain('owner storage')
  })
})
