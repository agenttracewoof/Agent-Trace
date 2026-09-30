/**
 * Reads a system error's code without `instanceof Error`. An error made in
 * another realm fails that check — Node's own fs errors do, seen from inside a
 * Jest ESM sandbox — and a missing file then looked like a failure: the SDK
 * refused to create its key on the first run of every such test suite.
 */
export function hasErrnoCode(cause: unknown, code: string): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === code
}
