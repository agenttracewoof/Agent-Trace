#!/usr/bin/env tsx
import { readdirSync, readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  agentRoutes,
  createApp,
  createProject,
  decisionRoutes,
  publicRoutes,
  silentLogger,
} from '@agenttrace/api/harness'
import { type ChainClient, publishPending } from '@agenttrace/publisher/loop'
import { PGlite } from '@electric-sql/pglite'
import { serve } from '@hono/node-server'
import { Connection, Keypair } from '@solana/web3.js'
import { drizzle } from 'drizzle-orm/pglite'
import { formatReport, runScenario } from './decision-loop.js'

/**
 * Обв'язка живого прогону (T036). Вимірюваний код лежить у `decision-loop.ts` і
 * нічого не знає ні про PGlite, ні про env — тут тільки те, що неможливо
 * перевірити без справжнього кластера.
 *
 * **Сховище — PGlite, а не Supabase.** Справжня база з'явиться на T060, і борг
 * «PGlite ≠ Supabase» тягнеться з сесії 3. Усе інше в цьому прогоні справжнє:
 * підпис, транзакція, комісія, ланцюг.
 */

const required = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value === '') {
    process.stderr.write(`${name} is not set: the live scenario needs devnet access\n`)
    process.exit(1)
  }
  return value
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function fromBase58(value: string): Uint8Array {
  const bytes = [0]
  for (const character of value) {
    let carry = BASE58.indexOf(character)
    if (carry < 0) throw new TypeError('PUBLISHER_SECRET_KEY is not base58')
    for (let index = 0; index < bytes.length; index += 1) {
      carry += (bytes[index] as number) * 58
      bytes[index] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  for (const character of value) {
    if (character !== BASE58[0]) break
    bytes.push(0)
  }
  return Uint8Array.from(bytes.reverse())
}

const migrationDir = fileURLToPath(new URL('../drizzle/', import.meta.resolve('@agenttrace/db')))
const migration = readdirSync(migrationDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(migrationDir + name, 'utf8'))
  .join('\n')

const rpcUrl = required('SOLANA_RPC_URL')
const payer = Keypair.fromSecretKey(fromBase58(required('PUBLISHER_SECRET_KEY')))
const count = Number(process.env.E2E_DECISIONS ?? 10)

const client = await PGlite.create()
await client.exec(migration)
const db = drizzle(client)

const app = createApp({ logger: silentLogger() })
app.route('/v1', agentRoutes(db))
app.route('/v1', publicRoutes(db))

const server = serve({ fetch: app.fetch, port: 0 })
const address = server.address()
const port = typeof address === 'object' && address !== null ? address.port : 0
const endpoint = `http://127.0.0.1:${port}`

// Публічне посилання має вести туди ж, куди дивиться перевіряльник.
app.route('/v1', decisionRoutes(db, { publicAppUrl: `${endpoint}/decisions` }))

const { ingestKey } = await createProject(db, 'M1 demo')
const connection = new Connection(rpcUrl, 'confirmed')
const stateDir = await mkdtemp(join(tmpdir(), 'agenttrace-e2e-'))

process.stdout.write(
  `payer ${payer.publicKey.toBase58()}\nrpc ${new URL(rpcUrl).origin}\nstate ${stateDir}\n\n`,
)

const report = await runScenario({
  endpoint,
  ingestKey,
  stateDir,
  count,
  publishOnce: () =>
    publishPending(db, connection as unknown as ChainClient, {
      payer,
      maxPriorityLamports: Number(process.env.PUBLISHER_MAX_PRIORITY_LAMPORTS ?? 10_000),
      batchSize: 25,
    }),
  chain: connection,
  log: (line) => process.stdout.write(`${line}\n`),
})

process.stdout.write(`\n${formatReport(report)}\n`)

server.close()
await client.close()
process.exit(report.sc001 && report.sc003 && report.sc009 ? 0 : 1)
