import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifySignedManifest } from '@agenttrace/manifest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AgentTraceClient, type ClientOptions, createClient } from './client.js'

const AGENT_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const PUBLIC_URL = 'https://agenttrace.example/d/1'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agenttrace-client-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const accepted = { agentId: AGENT_ID, status: 'pending', publicUrl: PUBLIC_URL }

interface Call {
  readonly url: string
  readonly init: RequestInit
}

/** Відповідач бачить, котрий це за рахунком виклик саме приймання рішень. */
function server(respond: (url: string, decisionCall: number) => Response = () => json(accepted)) {
  const calls: Call[] = []
  let decisions = 0

  return {
    calls,
    to: (path: string) => calls.filter((call) => call.url.endsWith(path)),
    body: (call: Call | undefined): unknown => JSON.parse(String(call?.init.body)),
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/v1/decisions')) decisions += 1
      return respond(url, decisions)
    },
  }
}

function open(overrides: Partial<ClientOptions> = {}): Promise<AgentTraceClient> {
  return createClient({
    endpoint: 'https://api.agenttrace.example/',
    ingestKey: 'ingest-key-1',
    agent: { externalId: 'quote-bot', name: 'Quote bot' },
    policy: { stepInput: ['query'], stepOutput: ['rows'], outcome: ['approved'] },
    stateDir: directory,
    fetch: server().fetch,
    onError: () => {},
    ...overrides,
  })
}

async function decide(client: AgentTraceClient, query = 'q'): Promise<void> {
  const decision = client.startDecision({ model: 'claude-opus-5' })
  decision.source('https://quotes.example/1')
  decision.step('retrieval', { query, apiKey: 'sk-live-1' }, { rows: 2 })
  await client.submit(decision.finish({ approved: true, token: 'sk-live-2' }))
}

describe('createClient', () => {
  it('takes its identity from the local keystore', async () => {
    const client = await open()
    const again = await open()

    expect(client.agentPubkey).toMatch(/^[0-9a-f]{64}$/)
    expect(again.agentPubkey).toBe(client.agentPubkey)
  })

  it('registers the agent under that identity before sending anything', async () => {
    const api = server()
    const client = await open({ fetch: api.fetch })

    await decide(client)
    await client.flush()

    const [registration] = api.to('/v1/agents')
    expect(api.calls[0]).toBe(registration)
    expect(registration?.url).toBe('https://api.agenttrace.example/v1/agents')
    expect(registration?.init.headers).toMatchObject({ authorization: 'Bearer ingest-key-1' })
    expect(api.body(registration)).toEqual({
      externalId: 'quote-bot',
      name: 'Quote bot',
      publicKey: client.agentPubkey,
    })
  })

  it('registers once, however many times it flushes', async () => {
    const api = server()
    const client = await open({ fetch: api.fetch })

    await decide(client)
    await client.flush()
    await decide(client)
    await client.flush()

    expect(api.to('/v1/agents')).toHaveLength(1)
  })

  it('returns from a decision without waiting for the network', async () => {
    const reached: string[] = []
    const client = await open({
      fetch: async (url: string) => {
        reached.push(url)
        return new Promise<Response>(() => {})
      },
    })

    await decide(client)

    expect(await client.pending()).toBe(1)
    expect(reached).not.toHaveLength(0)
  })

  it('sends the signed envelope and nothing besides it', async () => {
    const api = server()
    const client = await open({ fetch: api.fetch })

    await decide(client)
    await client.flush()

    const [sent] = api.to('/v1/decisions')
    expect(sent?.url).toBe('https://api.agenttrace.example/v1/decisions')
    expect(sent?.init.headers).toMatchObject({
      authorization: 'Bearer ingest-key-1',
      'content-type': 'application/json',
    })
    expect(Object.keys(api.body(sent) as object)).toEqual(['manifest', 'signature'])
    expect(await verifySignedManifest(api.body(sent))).toBe(true)
  })

  it('sends a decision the policy has already redacted', async () => {
    const api = server()
    const client = await open({ fetch: api.fetch })

    await decide(client)
    await client.flush()

    const body = String(api.to('/v1/decisions')[0]?.init.body)
    expect(body).not.toContain('sk-live-1')
    expect(body).not.toContain('sk-live-2')
    expect(body).toContain('"query":"q"')
  })

  it('sends each decision once, although a decision also triggers a flush', async () => {
    const api = server()
    const client = await open({ fetch: api.fetch })

    await decide(client)
    await client.flush()

    expect(api.to('/v1/decisions')).toHaveLength(1)
    expect(await client.pending()).toBe(0)
  })

  it('reports what the server could not take, and sends it once the server can', async () => {
    const api = server((url, decisionCall) =>
      url.endsWith('/v1/decisions') && decisionCall <= 2
        ? json({ error: { code: 'INTERNAL', message: 'down' } }, 503)
        : json(accepted),
    )
    const client = await open({ fetch: api.fetch })

    await decide(client)
    const refused = await client.flush()
    const recovered = await client.flush()

    expect(refused).toMatchObject({ sent: 0, pending: 1 })
    expect(refused.stoppedBy?.message).toMatch(/503/)
    expect(recovered).toEqual({ sent: 1, pending: 0 })
    expect(await client.pending()).toBe(0)
  })

  it('sets a refused decision aside instead of blocking the queue behind it', async () => {
    const api = server((url, decisionCall) =>
      url.endsWith('/v1/decisions') && decisionCall === 1
        ? json({ error: { code: 'INVALID_INPUT', message: 'too large' } }, 400)
        : json(accepted),
    )
    const reported: string[] = []
    const client = await open({
      fetch: api.fetch,
      onError: (error) => reported.push(error.message),
    })

    await decide(client, 'first')
    await client.flush()
    await decide(client, 'second')
    await client.flush()

    expect(await client.pending()).toBe(0)
    expect(await client.rejected()).toBe(1)
    expect(api.to('/v1/decisions')).toHaveLength(2)
    expect(reported.join(' ')).toMatch(/400/)
  })

  it('holds decisions while registration itself is refused', async () => {
    const api = server()
    const client = await open({
      fetch: async (url: string, init: RequestInit) => {
        if (url.endsWith('/v1/agents')) {
          return json({ error: { code: 'UNAUTHORIZED', message: 'bad key' } }, 401)
        }
        return api.fetch(url, init)
      },
    })

    await decide(client)
    const summary = await client.flush()

    expect(summary).toMatchObject({ sent: 0, pending: 1 })
    expect(summary.stoppedBy?.message).toMatch(/401/)
    expect(api.to('/v1/decisions')).toHaveLength(0)
    expect(await client.rejected()).toBe(0)
  })
})
