import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { hasErrnoCode } from './errno.js'

describe('hasErrnoCode', () => {
  it('reads the code of an error from another realm', () => {
    const foreign: unknown = runInNewContext('Object.assign(new Error("gone"), { code: "ENOENT" })')

    // The control: this is the error `instanceof` used to miss.
    expect(foreign instanceof Error).toBe(false)
    expect(hasErrnoCode(foreign, 'ENOENT')).toBe(true)
  })

  it('matches only the code asked for', () => {
    const error = Object.assign(new Error('taken'), { code: 'EEXIST' })

    expect(hasErrnoCode(error, 'EEXIST')).toBe(true)
    expect(hasErrnoCode(error, 'ENOENT')).toBe(false)
  })

  it('says no for anything without a code', () => {
    for (const cause of [undefined, null, 'ENOENT', 2, new Error('plain'), { code: 2 }]) {
      expect(hasErrnoCode(cause, 'ENOENT')).toBe(false)
    }
  })
})
