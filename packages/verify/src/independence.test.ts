import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * FR-014 тримається не на добрій волі, а на цьому тесті. Щойно verifier почне
 * ходити в наш API або ділити з ним схеми, «незалежна перевірка» тихо
 * перетвориться на «перевірка через AgentTrace» — тобто на протилежність задуму.
 */
const FORBIDDEN = ['@agenttrace/shared', '@agenttrace/db', '@agenttrace/api']

const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))
const pkg: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))

function dependencyNames(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return []
  const record = value as Record<string, unknown>
  return ['dependencies', 'devDependencies', 'peerDependencies'].flatMap((field) => {
    const group = record[field]
    return typeof group === 'object' && group !== null ? Object.keys(group) : []
  })
}

describe('verifier independence', () => {
  it('does not depend on anything that ties it to the AgentTrace service', () => {
    const deps = dependencyNames(pkg)
    expect(deps.filter((name) => FORBIDDEN.includes(name))).toEqual([])
  })

  it('carries no hardcoded AgentTrace endpoint', () => {
    const source = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8')
    expect(source).not.toMatch(/agenttrace\.[a-z]+/i)
  })
})
