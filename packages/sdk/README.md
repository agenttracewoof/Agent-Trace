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
yet: ask the AgentTrace operator for one, and put it in the environment as
`AGENTTRACE_INGEST_KEY` (a `.env` file loaded by `dotenv` is fine). The client reads it
from there; without it, `createClient` throws at start instead of failing later.

## Record a decision

```ts
import { createClient } from '@agenttracewoof/sdk'

const trace = await createClient({
  agent: { externalId: 'my-agent', name: 'My agent' },
  policy: { stepInput: ['query'], stepOutput: ['answer'], outcome: ['action'] },
})

const id = await trace.record({
  model: 'gpt-4o-mini',
  steps: [{ type: 'llm', input: { query: 'Should I rebalance?' }, output: { answer: 'yes' } }],
  outcome: { action: 'rebalance' },
})

await trace.flush() // only needed in a script that exits right after
```

- `record` signs the decision, writes it to a local queue and resolves to its
  `decisionId`. Delivery happens in the background, so AgentTrace being slow or down
  never slows your agent.
- **Short-lived scripts must `await trace.flush()` before exiting**, otherwise the
  process can end before the queue is sent. A long-running agent does not need it.
  Nothing is lost either way: what is left in the queue is sent on the next start.
- `createClient` is async: it loads or creates the agent's key. Use top-level `await`, or
  keep the promise and await it where you record (`const trace = createClient(...)`, then
  `await (await trace).record(...)`).
- **Do not await `flush()` in the path of a decision** — that makes your agent wait on the
  network, which the background delivery exists to avoid. Call it where the process ends:
  at the end of a script, in a test runner's `afterAll`, in a shutdown hook.
- A decision with no steps is refused: there would be nothing to attest.
- `sources` (optional) lists the data the decision relied on, as URIs; duplicates are
  dropped.

### What to put in a decision

- **One decision per thing your agent decided** — an answer, a trade, an approval.
- **`model`** is the model identifier as your agent uses it (`'claude-haiku-4-5'`,
  `'gpt-4o-mini'`) — any non-empty string up to 128 characters, so a rule-based agent
  can name itself. It is published as it is.
- **`steps`** are what led there, in order: each model call and each tool call can be its
  own step (`type: 'llm'`, `type: 'tool:calculator'`, …). One step with the question
  and the final answer is enough to start; record more when you want them checkable.
- **`outcome`** is any JSON value: `{ answer }`, `{ action, size }`, a string inside an
  object. What is published of it is decided by the policy, below.

### Recording step by step

When a decision takes a while and you want each step written as it happens, use the
recorder instead — it is what `record` does underneath:

```ts
const decision = trace.startDecision({ model: 'gpt-4o-mini' })
decision.source('https://api.example.com/prices')
decision.step('llm', { query: 'Should I rebalance?' }, { answer: 'yes' })
await trace.submit(decision.finish({ action: 'rebalance' }))
console.log(decision.decisionId)
```

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
| `createClient(options)` | `agent`, `policy`; optional `endpoint` (default `DEFAULT_ENDPOINT`, the hosted API), `ingestKey` (default: `AGENTTRACE_INGEST_KEY`), `stateDir`, `fetch`, `onError` |
| `client.record(decision)` | `{ model, steps, outcome, sources? }` → sign, queue, send in the background; resolves to the `decisionId` |
| `client.startDecision({ model })` | a recorder with `decisionId`, `source`, `step`, `finish` |
| `client.submit(draft)` | sign, queue, send in the background what `finish` returned |
| `client.flush()` | send what is still queued; resolves to `{ sent, pending, stoppedBy? }`. `sent` counts only what this call sent — decisions the background delivery already sent are not in it, so `{ sent: 0, pending: 0 }` means everything is out |
| `client.pending()` / `client.rejected()` | decisions waiting / refused by the API and set aside |
| `client.agentPubkey` | the agent's public key — its identity |

## License

MIT
