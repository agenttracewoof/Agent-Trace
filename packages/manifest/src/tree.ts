import { type Bytes, HASH_BYTES, sha256 } from './hash.js'

/**
 * Внутрішній вузол хешується під іншим доменом, ніж лист (`agenttrace/step/v1`
 * у `hash.ts`). Без цієї різниці підроблений крок, чий хеш дорівнює хешу цілого
 * піддерева, підставився б замість нього, а корінь лишився б тим самим.
 */
const NODE_DOMAIN = new TextEncoder().encode('agenttrace/node/v1')

function assertLeafSizes(leaves: readonly Uint8Array[]): void {
  for (const [index, leaf] of leaves.entries()) {
    if (leaf.byteLength !== HASH_BYTES) {
      throw new TypeError(
        `merkleRoot: step ${index} must be ${HASH_BYTES} bytes, got ${leaf.byteLength}`,
      )
    }
  }
}

function hashNode(left: Bytes, right: Bytes): Promise<Bytes> {
  const input = new Uint8Array(NODE_DOMAIN.byteLength + HASH_BYTES * 2)
  input.set(NODE_DOMAIN, 0)
  input.set(left, NODE_DOMAIN.byteLength)
  input.set(right, NODE_DOMAIN.byteLength + HASH_BYTES)
  return sha256(input)
}

/**
 * Дерево ділиться по найбільшому степені двійки, меншому за кількість кроків
 * (RFC 6962), а не добудовується копією останнього листа: копія дала б однаковий
 * корінь для різних наборів кроків, тобто рівно ту підміну, яку дерево має ловити.
 */
function splitPoint(count: number): number {
  let point = 1
  while (point * 2 < count) point *= 2
  return point
}

async function rootOf(leaves: readonly Bytes[]): Promise<Bytes> {
  const [first] = leaves
  if (first === undefined) throw new RangeError('merkleRoot: a decision needs at least one step')
  if (leaves.length === 1) return first

  const point = splitPoint(leaves.length)
  const [left, right] = await Promise.all([
    rootOf(leaves.slice(0, point)),
    rootOf(leaves.slice(point)),
  ])
  return hashNode(left, right)
}

export async function merkleRoot(leaves: readonly Bytes[]): Promise<Bytes> {
  assertLeafSizes(leaves)
  return rootOf(leaves)
}
