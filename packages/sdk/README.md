# @agenttracewoof/sdk

Record what an AI agent decided and what it relied on, sign the record with a key that
never leaves the agent's machine, and have its root anchored on Solana. Anyone with the
link can then check that the record has not changed — without trusting AgentTrace.

Node 22 or newer. ESM only.

## Install

```bash
npm install @agenttracewoof/sdk
```

You also need an **ingest key** for your project. Self-service sign-up is not there
yet: ask the AgentTrace operator for one. Keep it out of your code — an environment
variable is fine.

## Record a decision

```ts
import { createClient } from '@agenttracewoof/sdk'

const trace = await createClient({
  endpoint: 'https://agenttrace-api-cr1b.onrender.com',
  ingestKey: process.env.AGENTTRACE_INGEST_KEY ?? '',
  agent: { externalId: 'my-agent', name: 'My agent' },
  policy: { stepInput: ['query'], stepOutput: ['answer'], outcome: ['action'] },
})

const decision = trace.startDecision({ model: 'gpt-4o-mini' })
decision.source('https://api.example.com/prices')
decision.step('llm', { query: 'Should I rebalance?' }, { answer: 'yes' })
await trace.submit(decision.finish({ action: 'rebalance' }))

console.log(decision.decisionId)
```

- `startDecision` → `step` (one or more) → `finish(outcome)` → `submit`. A decision
  with no steps is refused: there would be nothing to attest.
- `source(uri)` is optional: the data sources the decision relied on, each listed once.
- `submit` signs the decision and writes it to a local queue, then returns. Delivery
  happens in the background, so AgentTrace being slow or down never slows your agent.
- **Short-lived scripts must `await trace.flush()` before exiting**, otherwise the
  process can end before the queue is sent. What is left in the queue is sent on the
  next start — nothing is lost, it just arrives later.

## What gets published: the policy

`policy` is an **allow-list**. Only the fields it names are published, in step inputs,
step outputs and the outcome. Everything else is replaced by `null` before hashing, so
a secret you forgot about is never published by default.

- A rule addresses a **leaf** by its path: `'request.user'`, not `'request'`.
- `*` matches any key; array items are addressed only by it: `'items.*.price'`.
- Leaves must be strings, numbers, booleans or `null`. Record inputs and outputs as
  **objects**: a bare string passed as a step's input has no path, so no rule can
  allow it and it is always published as `null`.
- `model` and `sources` are published as they are. Do not put tokens in source URLs.

Hashes are taken after redaction, so the record proves what was published — not the
fields the policy left out.

## Where things live

The client keeps its state in `.agenttrace/` in the working directory (override with
`stateDir`): the agent's key pair and the delivery queue. **Add `.agenttrace/` to
`.gitignore`.** The private key in it is the agent's identity — it signs every decision
and is never sent anywhere.

Errors in background delivery go to `onError` if you pass one; nothing is thrown into
your agent.

## Check a decision

Open `https://agenttracewoof.github.io/Agent-Trace/decisions/<decisionId>`. The page
reads the anchor from Solana and verifies the record in your browser. The anchor is
usually confirmed within ten seconds of delivery; until then the page says the decision
is pending — reload it, and it shows **verified**.

The API runs on a free instance that sleeps when idle: the first request after a quiet
spell can take up to a minute. Everything is on Solana **devnet**, which is reset from
time to time — an anchor there is a demo, not a permanent proof.

## API

| | |
|---|---|
| `createClient(options)` | `endpoint`, `ingestKey`, `agent`, `policy`; optional `stateDir`, `fetch`, `onError` |
| `client.startDecision({ model })` | returns a recorder with `decisionId`, `source`, `step`, `finish` |
| `client.submit(draft)` | sign, queue, send in the background |
| `client.flush()` | send what is queued; resolves to `{ sent, pending, stoppedBy? }` |
| `client.pending()` / `client.rejected()` | decisions waiting / refused by the API and set aside |
| `client.agentPubkey` | the agent's public key — its identity |

## License

MIT
