import { describe, expect, it } from 'vitest'
import { canonicalize } from './hash.js'
import { redact } from './redact.js'

describe('redact', () => {
  it('publishes a value the policy names', () => {
    expect(redact({ model: 'claude-opus-5' }, ['model'])).toEqual({ model: 'claude-opus-5' })
  })

  it('publishes an allowed leaf at any depth', () => {
    const input = { call: { model: 'claude-opus-5', apiKey: 'sk-live-1' } }
    expect(redact(input, ['call.model'])).toEqual({ call: { model: 'claude-opus-5' } })
  })

  it('drops a field the policy does not name, together with its name', () => {
    const output = redact({ apiKey: 'sk-live-1' }, ['model'])
    expect(canonicalize(output)).not.toContain('apiKey')
  })

  it('drops a key that is itself a secret', () => {
    const output = redact({ credentials: { 'sk-live-1': 'used' } }, ['model'])
    expect(canonicalize(output)).not.toContain('sk-live-1')
  })

  it('matches array elements through the wildcard', () => {
    const input = {
      sources: [
        { url: 'https://a.example', credential: 'sk-live-1' },
        { url: 'https://b.example', credential: 'sk-live-2' },
      ],
    }
    expect(redact(input, ['sources.*.url'])).toEqual({
      sources: [{ url: 'https://a.example' }, { url: 'https://b.example' }],
    })
  })

  it('matches dynamic object keys through the wildcard', () => {
    const input = { meta: { runId: 'run-1', region: 'eu' } }
    expect(redact(input, ['meta.*'])).toEqual({ meta: { runId: 'run-1', region: 'eu' } })
  })

  it('publishes nothing when the rule stops at a container', () => {
    expect(redact({ call: { model: 'claude-opus-5' } }, ['call'])).toBeNull()
  })

  it('keeps element positions when an element publishes nothing', () => {
    const input = { sources: [{ url: 'https://a.example' }, { credential: 'sk-live-1' }] }
    expect(redact(input, ['sources.*.url'])).toEqual({
      sources: [{ url: 'https://a.example' }, null],
    })
  })

  it('drops a container whose children publish nothing', () => {
    expect(redact({ sources: [{ credential: 'sk-live-1' }] }, ['sources.*.url'])).toBeNull()
  })

  it('drops values it cannot publish unambiguously, rather than guessing', () => {
    const input = {
      at: new Date(0),
      size: 10n,
      ratio: Number.NaN,
      load: () => 1,
      seen: new Map(),
      missing: undefined,
    }
    const allow = ['at', 'size', 'ratio', 'load', 'seen', 'missing']
    expect(redact(input, allow)).toBeNull()
  })

  it('returns null when nothing at all is publishable', () => {
    expect(redact({ apiKey: 'sk-live-1' }, [])).toBeNull()
    expect(redact('sk-live-1', ['model'])).toBeNull()
  })

  it('does not mutate its input', () => {
    const input = { model: 'claude-opus-5', apiKey: 'sk-live-1' }
    redact(input, ['model'])
    expect(input).toEqual({ model: 'claude-opus-5', apiKey: 'sk-live-1' })
  })

  it('rejects a malformed rule instead of silently matching nothing', () => {
    expect(() => redact({}, [''])).toThrow(/malformed/)
    expect(() => redact({}, ['a..b'])).toThrow(/malformed/)
    expect(() => redact({}, ['.a'])).toThrow(/malformed/)
    expect(() => redact({}, ['a.'])).toThrow(/malformed/)
  })

  it('does not protect a secret embedded inside an allowed value', () => {
    const output = redact({ prompt: 'use key sk-live-1' }, ['prompt'])
    expect(canonicalize(output)).toContain('sk-live-1')
  })
})

const SECRET_SHAPES: readonly ((n: number) => string)[] = [
  (n) => `sk-live-51H${n}QwErTyUiOpAsDfGhJkLzXcVbN`,
  (n) => `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIke${n}fSJ9.s3cr3t-s1gn4tur3`,
  (n) => `postgres://svc:p4ssw0rd-${n}@db.internal:5432/prod`,
  (n) => `3vQB7B6MrGQZaxCuFg4oh${n}KWi4L1RhLLbEDkkK9ExhAWvXvKxwFDFqbLXBMpLQ`,
  (n) => `abandon abandon ability able about above absent absorb ${n}`,
]

const FIXTURE_ALLOW = ['model', 'decidedAt', 'sources.*.url', 'meta.*']

interface Fixture {
  readonly input: Record<string, unknown>
  readonly secrets: readonly string[]
  readonly published: readonly string[]
}

function pick<T>(items: readonly T[], index: number): T {
  const item = items[index % items.length]
  if (item === undefined) throw new Error('pick: empty list')
  return item
}

function placeSecret(index: number, secret: string): Record<string, unknown> {
  switch (index % 6) {
    case 0:
      return { apiKey: secret }
    case 1:
      return { auth: { scheme: 'bearer', token: secret } }
    case 2:
      return { sources: [{ url: `https://quotes.example/${index}`, credential: secret }] }
    case 3:
      return { credentials: { [secret]: 'used' } }
    case 4:
      return { trace: { call: { retry: { attempt: 2, key: secret } } } }
    default:
      return { headers: { authorization: secret, accept: 'application/json' } }
  }
}

function makeFixture(index: number): Fixture {
  const secret = pick(SECRET_SHAPES, index)(index)
  const url = `https://quotes.example/${index}`
  const runId = `run-${index}`

  return {
    input: {
      model: 'claude-opus-5',
      decidedAt: 1_760_000_000_000 + index,
      sources: [{ url, weight: 1 }],
      meta: { runId },
      ...placeSecret(index, secret),
    },
    secrets: [secret],
    published: [url, runId, 'claude-opus-5'],
  }
}

describe('redact — SC-006', () => {
  const fixtures = Array.from({ length: 200 }, (_, index) => makeFixture(index))
  const outputs = fixtures.map((fixture) => canonicalize(redact(fixture.input, FIXTURE_ALLOW)))

  it('publishes zero secrets across 200 decisions carrying secrets in their input', () => {
    const leaked = fixtures.filter((fixture, i) =>
      fixture.secrets.some((secret) => pick(outputs, i).includes(secret)),
    )
    expect(leaked).toHaveLength(0)
  })

  it('still publishes the allowed fields of all 200 — silence would pass SC-006 too', () => {
    const lost = fixtures.filter((fixture, i) =>
      fixture.published.some((value) => !pick(outputs, i).includes(value)),
    )
    expect(lost).toHaveLength(0)
  })
})
