import type { ProjectSummary } from '@agenttrace/shared'
import { describe, expect, it } from 'vitest'
import { canCreate, createdOn, ownedCount } from './Projects'
import { isCodeShaped, normalizeCode, normalizeEmail } from './SignIn'

const project = (role: 'owner' | 'operator', n: number): ProjectSummary => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  name: `p${n}`,
  role,
  dailyQuota: 100,
  createdAt: '2026-10-03T12:00:00.000Z',
})

describe('the create button', () => {
  it('counts only the projects the operator owns', () => {
    const list = [project('owner', 1), project('operator', 2), project('owner', 3)]
    expect(ownedCount(list)).toBe(2)
    expect(canCreate(list, 3)).toBe(true)
  })

  it('stops at the ceiling the API reports', () => {
    const list = [project('owner', 1), project('owner', 2), project('owner', 3)]
    expect(canCreate(list, 3)).toBe(false)
    expect(canCreate([...list, project('operator', 4)], 4)).toBe(true)
  })
})

describe('createdOn', () => {
  it('drops the year only when it is this year', () => {
    const now = new Date('2026-12-01T00:00:00Z')
    expect(createdOn('2026-10-03T12:00:00.000Z', now)).toBe('Oct 3')
    expect(createdOn('2025-10-03T12:00:00.000Z', now)).toMatch(/2025/)
  })
})

describe('the sign-in form', () => {
  it('uses the address the API will use', () => {
    expect(normalizeEmail('  Operator@Example.COM \n')).toBe('operator@example.com')
  })

  it('takes a code pasted with spaces, and only six digits', () => {
    expect(normalizeCode(' 123 456 ')).toBe('123456')
    expect(isCodeShaped('123456')).toBe(true)
    expect(isCodeShaped('12345')).toBe(false)
    expect(isCodeShaped('12345a')).toBe(false)
  })
})
