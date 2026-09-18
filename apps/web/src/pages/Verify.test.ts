import { describe, expect, it } from 'vitest'
import { identityOf } from './Verify'

const AGENT = 'ab'.repeat(32)
const DECISION = '0123456789abcdeffedcba9876543210'

const envelope = (over: Record<string, unknown> = {}) => ({
  manifest: { agentPubkey: AGENT, decisionId: DECISION, ...over },
  signature: 'cd'.repeat(64),
})

describe('identityOf', () => {
  it('reads the address the chain will be searched by', () => {
    expect(identityOf(envelope())).toEqual({ agentPubkey: AGENT, decisionId: DECISION })
  })

  it.each([
    ['not an object', 42],
    ['no manifest', { signature: 'cd'.repeat(64) }],
    ['manifest is not an object', { manifest: 'nope' }],
    ['agent key of the wrong length', envelope({ agentPubkey: 'ab' })],
    ['agent key that is not hex', envelope({ agentPubkey: 'zz'.repeat(32) })],
    ['decision id of the wrong length', envelope({ decisionId: 'abcd' })],
    ['upper case hex', envelope({ decisionId: DECISION.toUpperCase() })],
  ])('refuses %s', (_name, value) => {
    /**
     * Форма перевіряється **до** мережі: інакше сторінка ходила б у ланцюг за
     * адресою, зібраною з чогось, що конвертом не є, і показувала б помилку
     * вузла там, де насправді користувач вставив не той документ.
     */
    expect(identityOf(value)).toBeUndefined()
  })

  it('takes the identity from the document under test, which is why the page shows it', () => {
    /**
     * Сторінка відповідає на питання «чи цей документ цілісний і чи є під нього
     * якір», а не «чи це рішення агента X». Друге вимагає звірки ключа очима —
     * тому ключ і друкується у вердикті, а поле «очікуваний агент» існує окремо.
     */
    const other = 'cd'.repeat(32)

    expect(identityOf(envelope({ agentPubkey: other }))?.agentPubkey).toBe(other)
  })
})
