import type { PublicDecisionResponse } from '@agenttrace/shared'
import { type VerificationResult, verifyDecision } from '@agenttrace/verify'
import { describe, expect, it } from 'vitest'
import { resolveRpcUrl } from '../chain'
import { apiDisagreement, evidenceOf } from './VerificationState'

const decision = (over: Partial<PublicDecisionResponse> = {}): PublicDecisionResponse => ({
  decisionId: '0123456789abcdeffedcba9876543210',
  signedManifest: null,
  anchor: null,
  archive: null,
  contentDeletedAt: null,
  verification: {
    status: 'pending',
    discrepancies: [],
    caveats: [],
    keyContinuity: 'self',
    includesChain: false,
  },
  ...over,
})

describe('evidenceOf', () => {
  it('names a missing envelope unavailable, never deleted', () => {
    // Причини нам не сказали, тож вигадати її означало б показати стан не тим,
    // чим він відомий.
    expect(evidenceOf(decision(), undefined)).toEqual({ absence: 'unavailable' })
  })

  it('calls it deleted only when the owner said so', () => {
    expect(
      evidenceOf(decision({ contentDeletedAt: '2026-08-14T00:00:00.000Z' }), undefined),
    ).toEqual({ absence: 'content-deleted' })
  })

  it('carries the anchor bytes through untouched', () => {
    const anchor = new Uint8Array([1, 2, 3])

    expect(evidenceOf(decision(), anchor).anchor).toBe(anchor)
  })
})

describe('without an anchor there is no verified', () => {
  it('is structural, not a rule someone has to remember', async () => {
    /**
     * Головна обіцянка FR-013 тримається формою: байти якоря є лише тоді, коли
     * їх прочитав цей браузер, а `verifyDecision` без них сильнішого за
     * `pending` не повертає. Тому не налаштований RPC, мертвий вузол і порожня
     * історія дають однаково слабкий — і чесний — результат.
     */
    const verdict: VerificationResult = await verifyDecision(evidenceOf(decision(), undefined))

    expect(verdict.status).not.toBe('verified')
    expect(verdict.status).toBe('unavailable')
  })
})

describe('apiDisagreement', () => {
  const local = (status: VerificationResult['status']): VerificationResult => ({
    status,
    discrepancies: [],
    caveats: [],
    keyContinuity: 'self',
  })

  it('surfaces the one thing the browser cannot see for itself', () => {
    /**
     * Рядок у сховищі, який форматом не є, наш API віддає як `null` і називає
     * `tampered`. Локально це читається як `unavailable` — слабше, ніж відомо.
     */
    const body = decision({
      verification: {
        status: 'tampered',
        discrepancies: [{ code: 'manifest-malformed', detail: 'nope' }],
        caveats: [],
        keyContinuity: 'self',
        includesChain: false,
      },
    })

    expect(apiDisagreement(body, local('unavailable'))).toContain('manifest-malformed')
  })

  it('stays quiet when both agree', () => {
    expect(apiDisagreement(decision(), local('pending'))).toBeUndefined()
  })

  it('never lets our api soften a local tampered', () => {
    // Зворотний бік того самого правила: наш стан не може зробити вердикт слабшим.
    expect(apiDisagreement(decision(), local('tampered'))).toBeUndefined()
  })
})

describe('resolveRpcUrl', () => {
  it('refuses an endpoint with a query string', () => {
    // `VITE_`-змінна їде у бандл: ключ у query став би публічним разом зі сторінкою.
    expect(() =>
      resolveRpcUrl({ VITE_SOLANA_RPC_URL: 'https://devnet.helius-rpc.com/?api-key=secret' }),
    ).toThrow(/published inside the bundle/)
  })

  it('takes a keyless public endpoint', () => {
    expect(resolveRpcUrl({ VITE_SOLANA_RPC_URL: 'https://api.devnet.solana.com' })).toBe(
      'https://api.devnet.solana.com',
    )
  })

  it('treats an unset endpoint as "the chain was not read"', () => {
    expect(() => resolveRpcUrl({})).toThrow(/not set/)
  })
})
